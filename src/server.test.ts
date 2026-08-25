import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

  const serverInstance = await startSseServer({ vaultRoot, port: 0, host: "127.0.0.1" });
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
      assert.strictEqual(toolsResult.tools.length, 8);

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
});
