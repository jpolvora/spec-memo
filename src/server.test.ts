import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ensureProjectVault, tryAcquireVaultLockSync, releaseVaultLockSync } from "./vault.js";
import { closeIndex } from "./indexer.js";
import { startSseServer } from "./server.js";
import { TOOL_NAMES } from "./types.js";
import { readErrorLogs } from "./error-logger.js";

test("HTTP / SSE MCP Server Transport", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-server-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "server-test-proj";

  const savedEnv = {
    auth: process.env.SPEC_MEMO_AUTH_TOKEN,
    sse: process.env.SPEC_MEMO_SSE_TOKEN,
    status: process.env.SPEC_MEMO_STATUS_TOKEN,
    root: process.env.SPEC_MEMO_ROOT,
    errorLog: process.env.SPEC_MEMO_ERROR_LOG
  };

  delete process.env.SPEC_MEMO_AUTH_TOKEN;
  delete process.env.SPEC_MEMO_SSE_TOKEN;
  delete process.env.SPEC_MEMO_STATUS_TOKEN;
  delete process.env.SPEC_MEMO_ROOT;
  delete process.env.SPEC_MEMO_ERROR_LOG;

  t.after(() => {
    if (savedEnv.auth !== undefined) process.env.SPEC_MEMO_AUTH_TOKEN = savedEnv.auth;
    else delete process.env.SPEC_MEMO_AUTH_TOKEN;
    if (savedEnv.sse !== undefined) process.env.SPEC_MEMO_SSE_TOKEN = savedEnv.sse;
    else delete process.env.SPEC_MEMO_SSE_TOKEN;
    if (savedEnv.status !== undefined) process.env.SPEC_MEMO_STATUS_TOKEN = savedEnv.status;
    else delete process.env.SPEC_MEMO_STATUS_TOKEN;
    if (savedEnv.root !== undefined) process.env.SPEC_MEMO_ROOT = savedEnv.root;
    else delete process.env.SPEC_MEMO_ROOT;
    if (savedEnv.errorLog !== undefined) process.env.SPEC_MEMO_ERROR_LOG = savedEnv.errorLog;
    else delete process.env.SPEC_MEMO_ERROR_LOG;

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
      assert.strictEqual(toolsResult.tools.length, 11);

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

      // Client hosts (Cursor) inject laptop cwd; a remote SSE daemon must still load sqlite.
      const foreignCwd =
        process.platform === "win32" ? "/home/lab/no-such-consumer" : "L:\\source\\no-such-consumer";
      const searchForeign = await client.callTool({
        name: "search",
        arguments: {
          query: "connections",
          cwd: foreignCwd
        }
      });
      assert.strictEqual(searchForeign.isError, undefined);
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

  await t.test("should enforce authToken and support query parameters and headers", async () => {
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

      // 2. Authenticated request accepted via Authorization header
      const authHeaderRes = await fetch(`${authServer.url}/health`, {
        headers: { Authorization: "Bearer secret-token-123" }
      });
      assert.strictEqual(authHeaderRes.status, 200);

      // 3. Authenticated request accepted via ?token= query param
      const authTokenRes = await fetch(`${authServer.url}/health?token=secret-token-123`);
      assert.strictEqual(authTokenRes.status, 200);

      // 4. Authenticated request accepted via ?authToken= query param
      const authParamRes = await fetch(`${authServer.url}/health?authToken=secret-token-123`);
      assert.strictEqual(authParamRes.status, 200);

      // 5. CORS headers & OPTIONS preflight
      const optionsRes = await fetch(`${authServer.url}/sse`, { method: "OPTIONS" });
      assert.strictEqual(optionsRes.status, 204);
      assert.strictEqual(optionsRes.headers.get("access-control-allow-origin"), "*");

      // 6. Connect via SSEClientTransport with query token
      const sseUrlWithToken = new URL(`${authServer.url}/sse?token=secret-token-123`);
      const transport = new SSEClientTransport(sseUrlWithToken);
      const client = new Client({ name: "test-query-token-client", version: "1.0.0" });
      await client.connect(transport);
      const toolsResult = await client.listTools();
      assert.strictEqual(toolsResult.tools.length, 11);
      await client.close();
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

  await t.test("should log detailed error reports to error.logs on failure cases", async () => {
    const errorLogServer = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "test-auth-secret",
      enableStatus: false
    });

    try {
      const serverUrl = errorLogServer.url;

      // 1. Trigger unauthorized 401
      const unauthRes = await fetch(`${serverUrl}/health`);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Trigger invalid sessionId on /message
      const msgRes = await fetch(`${serverUrl}/message?sessionId=non-existent-id`, {
        method: "POST",
        headers: {
          "Authorization": "Bearer test-auth-secret",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0" })
      });
      assert.strictEqual(msgRes.status, 400);

      // 3. Trigger 404
      const notFoundRes = await fetch(`${serverUrl}/non-existent-route`, {
        headers: { "Authorization": "Bearer test-auth-secret" }
      });
      assert.strictEqual(notFoundRes.status, 404);

      // Verify error.logs contains detailed reports
      const logContent = readErrorLogs(vaultRoot);
      assert.ok(logContent.includes("[sse-server]"));
      assert.ok(logContent.includes("Unauthorized request"));
      assert.ok(logContent.includes("Valid sessionId required"));
      assert.ok(logContent.includes("Route not found"));
      // Redaction check: secret token should not be leaked in cleartext in the logs
      assert.ok(!logContent.includes("Bearer test-auth-secret"));
    } finally {
      await errorLogServer.close();
    }
  });

  await t.test("should identify and track proxy and direct clients with operations", async () => {
    const trackingServer = await startSseServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      statusPort: 0,
      enableStatus: true
    });

    try {
      // 1. Proxy client sending custom header
      await fetch(`${trackingServer.url}/health`, {
        headers: {
          "x-spec-memo-client": "test-remote-proxy",
          "x-spec-memo-mode": "remote"
        }
      });

      const clients = trackingServer.activityBus.listClients();
      assert.ok(clients.length >= 1);
      const proxyClient = clients.find((c) => c.clientName === "test-remote-proxy");
      assert.ok(proxyClient);
      assert.strictEqual(proxyClient.clientType, "proxy");
      assert.strictEqual(proxyClient.lastOperation, "health_check");

      // 2. Direct remote client connecting via SSE
      const sseUrl = new URL(`${trackingServer.url}/sse`);
      const transport = new SSEClientTransport(sseUrl);
      const client = new Client({ name: "Cursor IDE", version: "1.0.0" });
      await client.connect(transport);

      await client.callTool({
        name: "search",
        arguments: { query: "test" }
      });

      const sseEvents = trackingServer.activityBus.list().filter((e) => e.type === "tool");
      assert.ok(sseEvents.length >= 1);
      const lastToolEv = sseEvents[sseEvents.length - 1];
      assert.strictEqual(lastToolEv.operation, "mcp:search");
      assert.strictEqual(lastToolEv.clientIp, "127.0.0.1");

      await client.close();
    } finally {
      await trackingServer.close();
    }
  });

  await t.test("should honor custom ports defined in config.json when port is not explicitly passed", async () => {
    const customVault = path.join(tempDir, "custom-ports-vault");
    fs.mkdirSync(customVault, { recursive: true });
    const configPath = path.join(customVault, "config.json");

    const getFreePort = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
          const port = (srv.address() as net.AddressInfo).port;
          srv.close((err) => (err ? reject(err) : resolve(port)));
        });
      });

    const customSsePort = await getFreePort();
    const customStatusPort = await getFreePort();

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          ports: {
            sse: customSsePort,
            status: customStatusPort
          }
        },
        null,
        2
      )
    );

    const sseInst = await startSseServer({
      vaultRoot: customVault,
      host: "127.0.0.1",
      enableStatus: true
    });

    try {
      assert.strictEqual(sseInst.port, customSsePort);
      assert.strictEqual(sseInst.statusPort, customStatusPort);
    } finally {
      await sseInst.close();
    }
  });

  await t.test("should start background auto-sync timer in hybrid mode, skip when vault lock is busy, and clean up on close", async () => {
    const autoSyncVault = path.join(tempDir, "autosync-vault");
    fs.mkdirSync(autoSyncVault, { recursive: true });
    const configPath = path.join(autoSyncVault, "config.json");

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          mode: "hybrid",
          sync: {
            autoSyncIntervalMinutes: 0.0005
          }
        },
        null,
        2
      )
    );

    // Hold vault lock externally to verify skip-when-busy
    const acquired = tryAcquireVaultLockSync(autoSyncVault);
    assert.strictEqual(acquired, true);

    const sseInst = await startSseServer({
      vaultRoot: autoSyncVault,
      host: "127.0.0.1",
      enableStatus: false
    });

    try {
      // Wait long enough for timer tick to fire and observe lock busy skip
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      releaseVaultLockSync(autoSyncVault);
      await sseInst.close();
    }
  });
});
