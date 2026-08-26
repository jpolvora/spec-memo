import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ensureProjectVault } from "./vault.js";
import { closeIndex } from "./indexer.js";
import { startSseServer } from "./server.js";
import { TOOL_NAMES } from "./types.js";

test("HTTP / SSE MCP Server Transport", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-server-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "server-test-proj";

  t.after(() => {
    closeIndex(vaultRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  ensureProjectVault({
    projectId,
    normalizedRemote: null,
    rootPath: tempDir,
    isGit: false,
    isFallback: true,
    vaultProjectPath: path.join(vaultRoot, "projects", projectId)
  }, vaultRoot);

  const serverInstance = await startSseServer({ vaultRoot, port: 0, host: "127.0.0.1", enableStatus: false });
  const baseUrl = serverInstance.url;

  t.after(async () => {
    await serverInstance.close();
  });

  await t.test("should serve /health diagnostic endpoint", async () => {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json() as any;
    assert.strictEqual(healthData.status, "ok");
    assert.strictEqual(healthData.service, "spec-memo-mcp-sse");
    assert.ok(healthData.projectsCount >= 1);
  });

  await t.test("should connect via SSEClientTransport and execute MCP tools", async () => {
    const sseUrl = new URL(`${baseUrl}/sse`);
    const transport = new SSEClientTransport(sseUrl);
    const client = new Client({ name: "test-sse-client", version: "1.0.0" });

    await client.connect(transport);

    try {
      // 1. List tools
      const toolsResult = await client.listTools();
      assert.ok(toolsResult.tools);
      assert.strictEqual(toolsResult.tools.length, 10);

      const exposedNames = toolsResult.tools.map(t => t.name);
      for (const expected of TOOL_NAMES) {
        assert.ok(exposedNames.includes(expected), `Missing tool: ${expected}`);
      }

      // 2. Call upsert tool over SSE
      const upsertResult = await client.callTool({
        name: "upsert",
        arguments: {
          kind: "trap",
          slug: "sse-trap",
          body: "# SSE Transport Trap\nDO NOT drop SSE connections."
        }
      });
      assert.strictEqual(upsertResult.isError, undefined);

      // 3. Call search tool over SSE
      const searchResult = await client.callTool({
        name: "search",
        arguments: {
          query: "connections"
        }
      });
      assert.strictEqual(searchResult.isError, undefined);
      const searchContent = searchResult.content as Array<{ type: string; text?: string }>;
      assert.ok(searchContent && searchContent.length > 0);
      const hits = JSON.parse(searchContent[0].text as string);
      assert.ok(Array.isArray(hits));
      assert.ok(hits.length >= 1);
    } finally {
      await client.close();
    }
  });

  await t.test("should reject POST /message without valid sessionId", async () => {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json() as any;
    assert.strictEqual(body.error, "Valid sessionId required");
  });

  await t.test("should refuse non-loopback host without auth token", () => {
    assert.throws(
      () => {
        startSseServer({ vaultRoot, port: 0, host: "192.168.1.100" });
      },
      {
        message: /Refusing to bind SSE MCP server to a non-loopback host without authentication token/
      }
    );
  });

  await t.test("should enforce authToken when configured", async () => {
    const authServer = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "secret-token-123",
      enableStatus: false
    });

    try {
      // 1. Unauthenticated request rejected
      const unauthRes = await fetch(`${authServer.url}/health`);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Authenticated request accepted
      const authRes = await fetch(`${authServer.url}/health`, {
        headers: { Authorization: "Bearer secret-token-123" }
      });
      assert.strictEqual(authRes.status, 200);
    } finally {
      await authServer.close();
    }
  });

  await t.test("should co-start status monitor on default companion port", async () => {
    const combined = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      statusPort: 0,
      enableStatus: true
    });

    try {
      assert.ok(combined.statusUrl);
      assert.ok(combined.activityBus);

      const statusRes = await fetch(`${combined.statusUrl}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const statusJson = await statusRes.json() as { service: string; mcp: { available: boolean } };
      assert.strictEqual(statusJson.service, "spec-memo-status-monitor");
      assert.strictEqual(statusJson.mcp.available, true);

      const htmlRes = await fetch(`${combined.statusUrl}/`);
      assert.strictEqual(htmlRes.status, 200);

      const healthBefore = combined.activityBus.list().filter((e) => e.path === "/health").length;
      await fetch(`${combined.url}/health`);
      await new Promise((r) => setTimeout(r, 50));
      const healthAfter = combined.activityBus.list().filter((e) => e.path === "/health").length;
      assert.ok(healthAfter > healthBefore);
    } finally {
      await combined.close();
    }
  });

  await t.test("should capture tool events over SSE MCP transport", async () => {
    const combined = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      statusPort: 0
    });

    try {
      const sseUrl = new URL(`${combined.url}/sse`);
      const transport = new SSEClientTransport(sseUrl);
      const client = new Client({ name: "test-status-client", version: "1.0.0" });
      await client.connect(transport);

      const before = combined.activityBus.list().filter((e) => e.type === "tool").length;
      await client.callTool({
        name: "search",
        arguments: { query: "connections" }
      });
      await new Promise((r) => setTimeout(r, 50));
      const after = combined.activityBus.list().filter((e) => e.type === "tool").length;
      assert.ok(after > before);

      await client.close();
    } finally {
      await combined.close();
    }
  });

  await t.test("should capture failed tool invocations with ok:false", async () => {
    const combined = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      statusPort: 0
    });

    try {
      const sseUrl = new URL(`${combined.url}/sse`);
      const transport = new SSEClientTransport(sseUrl);
      const client = new Client({ name: "test-fail-client", version: "1.0.0" });
      await client.connect(transport);

      await client.callTool({
        name: "search",
        arguments: { sort: "popularity" }
      });
      await new Promise((r) => setTimeout(r, 50));
      const failed = combined.activityBus.list().filter((e) => e.type === "tool" && e.ok === false);
      assert.ok(failed.length >= 1);
      assert.match(failed[failed.length - 1].summary, /search failed/i);

      await client.close();
    } finally {
      await combined.close();
    }
  });

  await t.test("should skip status monitor when enableStatus is false", async () => {
    const noStatus = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      enableStatus: false
    });
    try {
      assert.strictEqual(noStatus.statusUrl, undefined);
    } finally {
      await noStatus.close();
    }
  });

  await t.test("should close MCP listener when status companion fails to bind", async () => {
    const reserve = (server: http.Server) =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      });
    const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

    const mcpHolder = http.createServer();
    const mcpPort = await reserve(mcpHolder);
    await close(mcpHolder);

    const blocker = http.createServer();
    const busyPort = await reserve(blocker);

    await assert.rejects(
      () =>
        startSseServer({
          vaultRoot,
          port: mcpPort,
          host: "127.0.0.1",
          statusPort: busyPort,
          enableStatus: true
        })
    );

    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(mcpPort, "127.0.0.1", () => resolve());
    });
    await close(probe);
    await close(blocker);
  });
});
