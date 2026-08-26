import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createActivityBus } from "./activity.js";
import { generateStatusHtml, startStatusServer } from "./status.js";
import { ensureProjectVault } from "./vault.js";
import { closeIndex } from "./indexer.js";
import { executeTool } from "./tools.js";

function countTrapFiles(vaultRoot: string, projectId: string): number {
  const dir = path.join(vaultRoot, "projects", projectId, "traps");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

async function readSseEvents(
  response: Response,
  maxEvents = 3,
  timeoutMs = 3000
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (out.length < maxEvents && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true }), remaining)
        )
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const block of parts) {
        const lines = block.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) out.push({ event, data });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out;
}

test("MCP status monitor", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-status-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "status-test-proj";

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

  const bus = createActivityBus({ capacity: 200 });

  await t.test("generateStatusHtml is self-contained with spec-memo title", () => {
    const html = generateStatusHtml();
    assert.ok(html.includes("spec-memo"));
    assert.ok(html.includes("<title>spec-memo"));
    assert.ok(!html.includes("cdn.jsdelivr"));
  });

  await t.test("refuses non-loopback host without auth token", () => {
    assert.throws(
      () => startStatusServer({ activityBus: bus, host: "192.168.1.50", port: 0 }),
      /Refusing to bind status monitor/
    );
  });

  const statusInstance = await startStatusServer({
    vaultRoot,
    port: 0,
    host: "127.0.0.1",
    activityBus: bus,
    getMcp: () => ({ host: "127.0.0.1", port: 3000, activeTransports: 0, available: true })
  });

  t.after(async () => {
    bus.close();
    await statusInstance.close();
  });

  const baseUrl = statusInstance.url;

  await t.test("serves HTML and JSON status and vaults", async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
    const html = await htmlRes.text();
    assert.ok(html.includes("Status Monitor"));

    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const status = await statusRes.json() as Record<string, unknown>;
    assert.strictEqual(status.status, "ok");
    assert.strictEqual(status.service, "spec-memo-status-monitor");
    assert.ok(typeof status.uptimeMs === "number");
    assert.ok(typeof status.eventsBuffered === "number");
    assert.ok(status.mcp && (status.mcp as { available: boolean }).available);

    const vaultsRes = await fetch(`${baseUrl}/api/vaults`);
    assert.strictEqual(vaultsRes.status, 200);
    const vaults = await vaultsRes.json() as Array<{ id: string; displayName?: string }>;
    assert.ok(vaults.some((v) => v.id === projectId));
  });

  await t.test("status routes do not mutate vault records", async () => {
    const before = countTrapFiles(vaultRoot, projectId);
    await fetch(`${baseUrl}/api/status`);
    await fetch(`${baseUrl}/api/vaults`);
    await fetch(`${baseUrl}/api/events`);
    const after = countTrapFiles(vaultRoot, projectId);
    assert.strictEqual(before, after);
  });

  await t.test("filters /api/events by project", async () => {
    bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "proj-a search",
      tool: "search",
      projectId: "proj-a"
    });
    bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "proj-b search",
      tool: "search",
      projectId: "proj-b"
    });
    bus.capture({
      type: "http",
      kind: "meta",
      ok: true,
      durationMs: 1,
      summary: "GET /health 200",
      method: "GET",
      path: "/health",
      statusCode: 200
    });

    const res = await fetch(`${baseUrl}/api/events?project=proj-a`);
    const body = await res.json() as { events: Array<{ projectId?: string; type: string }> };
    assert.ok(body.events.every((e) => !e.projectId || e.projectId === "proj-a" || e.type === "http"));
    assert.ok(body.events.some((e) => e.type === "http"));
  });

  await t.test("streams snapshot and live activity over SSE", async () => {
    const ac = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/events/stream`, { signal: ac.signal });
    assert.strictEqual(streamRes.status, 200);
    assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/);

    const events = await readSseEvents(streamRes, 1, 2000);
    ac.abort();
    assert.ok(events.some((e) => e.event === "snapshot"));

    bus.capture({
      type: "tool",
      kind: "write",
      ok: true,
      durationMs: 3,
      summary: "live upsert",
      tool: "upsert",
      projectId
    });

    const ac2 = new AbortController();
    const stream2 = await fetch(`${baseUrl}/api/events/stream?afterSeq=0`, { signal: ac2.signal });
    const live = await readSseEvents(stream2, 5, 3000);
    ac2.abort();
    assert.ok(
      live.some(
        (e) =>
          (e.event === "snapshot" || e.event === "activity") &&
          e.data.includes("live upsert")
      )
    );
  });

  await t.test("afterSeq skips snapshot replay for older events", async () => {
    const currentMax = bus.list().reduce((m, e) => Math.max(m, e.seq), 0);
    const ac = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/events/stream?afterSeq=${currentMax}`, { signal: ac.signal });
    const events = await readSseEvents(streamRes, 1, 1500);
    ac.abort();
    const snapshot = events.find((e) => e.event === "snapshot");
    if (snapshot) {
      const parsed = JSON.parse(snapshot.data) as unknown[];
      assert.strictEqual(parsed.length, 0);
    }
  });

  await t.test("returns 404 JSON for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    assert.strictEqual(res.status, 404);
    const body = await res.json() as { error: string };
    assert.strictEqual(body.error, "Not found");
  });

  await t.test("enforces auth token on API routes when configured", async () => {
    const authBus = createActivityBus();
    const authServer = await startStatusServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "status-secret",
      activityBus: authBus
    });
    try {
      const unauth = await fetch(`${authServer.url}/api/status`);
      assert.strictEqual(unauth.status, 401);
      const auth = await fetch(`${authServer.url}/api/status`, {
        headers: { Authorization: "Bearer status-secret" }
      });
      assert.strictEqual(auth.status, 200);
      const stream = await fetch(`${authServer.url}/api/events/stream?token=status-secret`);
      assert.strictEqual(stream.status, 200);
      stream.body?.cancel().catch(() => {});
    } finally {
      authBus.close();
      await authServer.close();
    }
  });
});

test("MCP tool activity capture helpers", async (t) => {
  await t.test("executeTool search produces capturable summary via MCP layer", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-tool-cap-"));
    const vaultRoot = path.join(tempDir, "vault");
    t.after(() => {
      closeIndex(vaultRoot);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const projectId = "cap-proj";
    ensureProjectVault({
      projectId,
      normalizedRemote: null,
      rootPath: tempDir,
      isGit: false,
      isFallback: true,
      vaultProjectPath: path.join(vaultRoot, "projects", projectId)
    }, vaultRoot);

    await executeTool("upsert", {
      kind: "trap",
      slug: "cap-trap",
      body: "# Cap\nDO NOT fail.",
      vaultRoot,
      cwd: tempDir
    });

    const res = await executeTool("search", {
      query: "fail",
      vaultRoot,
      cwd: tempDir
    });
    assert.strictEqual(res.isError, undefined);
    assert.ok(Array.isArray(res.data));
  });
});
