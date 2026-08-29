import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createActivityBus } from "./activity.js";
import { generateStatusHtml, generateLoginHtml, startStatusServer, safeStatusNextPath } from "./status.js";
import { getPackageVersion } from "./version.js";
import { ensureProjectVault } from "./vault.js";
import { closeIndex } from "./indexer.js";
import { executeTool } from "./tools.js";
import { packVaultZip, unpackVaultZip, parseMultipartFormData } from "./status-backup.js";
import { exportVault } from "./backup.js";
import { upsertRecord } from "./store.js";
import { readErrorLogs } from "./error-logger.js";

function countTrapFiles(vaultRoot: string, projectId: string): number {
  const dir = path.join(vaultRoot, "projects", projectId, "traps");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

/** Inline <script> bodies from generateStatusHtml (excludes src= external). */
function extractInlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    out.push(m[2] ?? "");
  }
  return out;
}

/**
 * Guard against template-literal escape bugs (issue #20): host `\n` inside
 * generateStatusHtml`...` becomes a real newline in browser JS, breaking `/.../` regexes.
 */
function assertStatusInlineScriptsParse(html: string): void {
  const scripts = extractInlineScripts(html);
  assert.ok(scripts.length > 0, "status HTML must embed at least one inline <script>");
  for (const [i, source] of scripts.entries()) {
    // Classic failure mode: `/\n+/g` in a host template becomes `/` + real newline + `+/g`.
    const brokenRegex = source.match(/\/\r?\n[^\/\n]{0,40}\//);
    assert.equal(
      brokenRegex,
      null,
      `inline script[${i}] has a regex that starts with a newline (template \\n escape bug):\n${brokenRegex?.[0]?.slice(0, 120) ?? ""}`
    );
    try {
      // Parse-only: do not execute status UI side effects.
      // eslint-disable-next-line no-new-func -- intentional syntax check for served HTML
      new Function(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert.fail(`inline script[${i}] must be valid JavaScript (issue #20 class): ${msg}`);
    }
  }
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

  const bus = createActivityBus({ capacity: 200 });

  await t.test("generateStatusHtml is self-contained with spec-memo title and backup UI", () => {
    const version = getPackageVersion();
    const html = generateStatusHtml(version);
    assert.ok(html.includes("spec-memo"));
    assert.ok(html.includes("<title>spec-memo"));
    assert.ok(html.includes("(status monitor v" + version + ")"));
    assert.ok(html.includes('id="stat-version"'));
    assert.ok(html.includes('id="stat-clients"'));
    assert.ok(html.includes('id="client-list"'));
    assert.ok(html.includes('Vault Clients'));
    assert.ok(html.includes('id="btn-export"'));
    assert.ok(html.includes('id="btn-choose-file"'));
    assert.ok(html.includes('id="btn-run-import"'));
    assert.ok(html.includes('id="modal-export"'));
    assert.ok(html.includes('id="modal-import"'));
    assert.ok(!html.includes("cdn.jsdelivr"));
    assert.ok(!html.includes('params.set("token"'));
    assert.ok(!html.includes("?token="));
    assert.ok(html.includes("withCredentials: true"));
    assert.ok(html.includes('credentials: "same-origin"'));
  });

  await t.test("generateStatusHtml inline scripts parse (no template-escape SyntaxError)", () => {
    const html = generateStatusHtml(getPackageVersion());
    assertStatusInlineScriptsParse(html);
    // Canary for the known prompts-snippet line (issue #20)
    assert.ok(
      html.includes("p.body.replace(/\\n+/g, ' ')"),
      "prompt snippet regex must emit /\\n+/g to the browser"
    );
    assert.ok(
      !/p\.body\.replace\(\/\n\+\/g/.test(html),
      "prompt snippet regex must not contain a literal newline"
    );
  });

  await t.test("assertStatusInlineScriptsParse rejects broken template-escape regex", () => {
    const broken =
      "<html><script>const snippet = p.body.replace(/\n+/g, ' ');</script></html>";
    assert.throws(
      () => assertStatusInlineScriptsParse(broken),
      /embedded newline|valid JavaScript|template/i
    );
  });

  await t.test("refuses non-loopback host without auth token", () => {
    assert.throws(
      () => startStatusServer({ activityBus: bus, host: "192.168.1.50", port: 0, vaultRoot }),
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

  await t.test("serves HTML and JSON status, clients, and vaults", async () => {
    bus.registerClient({
      id: "test-client-1",
      ip: "127.0.0.1",
      clientName: "spec-memo-remote-proxy",
      clientType: "proxy",
      projectId,
      lastOperation: "mcp:bootstrap"
    });

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
    const html = await htmlRes.text();
    assert.ok(html.includes("Status Monitor"));
    assert.ok(html.includes("(status monitor v"));

    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const status = await statusRes.json() as Record<string, unknown>;
    assert.strictEqual(status.status, "ok");
    assert.strictEqual(status.service, "spec-memo-status-monitor");
    assert.strictEqual(status.version, getPackageVersion());
    assert.ok(typeof status.uptimeMs === "number");
    assert.ok(typeof status.eventsBuffered === "number");
    assert.strictEqual(status.activeClientsCount, 1);
    assert.ok(Array.isArray(status.clients));
    assert.ok(status.mcp && (status.mcp as { available: boolean }).available);

    const clientsRes = await fetch(`${baseUrl}/api/clients`);
    assert.strictEqual(clientsRes.status, 200);
    const clientsData = await clientsRes.json() as { clients: Array<{ clientName: string; clientType: string }> };
    assert.ok(Array.isArray(clientsData.clients));
    assert.strictEqual(clientsData.clients[0].clientName, "spec-memo-remote-proxy");
    assert.strictEqual(clientsData.clients[0].clientType, "proxy");

    const vaultsRes = await fetch(`${baseUrl}/api/vaults`);
    assert.strictEqual(vaultsRes.status, 200);
    const vaults = await vaultsRes.json() as Array<{ id: string; displayName?: string }>;
    assert.ok(vaults.some((v) => v.id === projectId));
  });

  await t.test("status read-only routes do not mutate vault records", async () => {
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

  await t.test("login page redirects unauthenticated / and accepts token cookie", async () => {
    const loginHtml = generateLoginHtml("0.0.0-test");
    assert.ok(loginHtml.includes('type="password"'));
    assert.ok(loginHtml.includes('autocomplete="current-password"'));
    assert.ok(loginHtml.includes('autocomplete="username"'));
    assert.ok(loginHtml.includes('name="password"'));
    assert.ok(generateStatusHtml("0.0.0-test").includes("apiFetch"));
    assert.ok(loginHtml.includes('!next.startsWith("//")'), "login HTML must reject protocol-relative next");

    assert.equal(safeStatusNextPath("/"), "/");
    assert.equal(safeStatusNextPath("/index.html"), "/index.html");
    assert.equal(safeStatusNextPath("//evil.example"), "/");
    assert.equal(safeStatusNextPath("https://evil.example"), "/");
    assert.equal(safeStatusNextPath("\\evil"), "/");
    assert.equal(safeStatusNextPath(null), "/");

    const authBus = createActivityBus();
    const authServer = await startStatusServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "login-secret",
      activityBus: authBus
    });
    try {
      const root = await fetch(`${authServer.url}/`, { redirect: "manual" });
      assert.strictEqual(root.status, 302);
      assert.match(String(root.headers.get("location") || ""), /\/login/);

      const loginPage = await fetch(`${authServer.url}/login`);
      assert.strictEqual(loginPage.status, 200);
      const loginBody = await loginPage.text();
      assert.ok(loginBody.includes('type="password"'));
      assert.ok(loginBody.includes("Access token"));

      const bad = await fetch(`${authServer.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: "wrong" })
      });
      assert.strictEqual(bad.status, 401);

      const good = await fetch(`${authServer.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token: "login-secret" })
      });
      assert.strictEqual(good.status, 200);
      const setCookie = String(good.headers.get("set-cookie") || "");
      assert.match(setCookie, /spec_memo_status_token=/);
      assert.match(setCookie, /HttpOnly/i);
      const cookie = setCookie.split(";")[0];

      const authedRoot = await fetch(`${authServer.url}/`, {
        headers: { Cookie: cookie },
        redirect: "manual"
      });
      assert.strictEqual(authedRoot.status, 200);
      const page = await authedRoot.text();
      assert.ok(page.includes("MCP Status Monitor") || page.includes("spec-memo"));

      const api = await fetch(`${authServer.url}/api/status`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(api.status, 200);

      const streamCookie = await fetch(`${authServer.url}/api/events/stream`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(streamCookie.status, 200);
      streamCookie.body?.cancel().catch(() => {});

      const conflict = await fetch(`${authServer.url}/api/status?token=stale-wrong`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(conflict.status, 200);

      const promote = await fetch(`${authServer.url}/?project=my-repo&token=login-secret`, {
        redirect: "manual"
      });
      assert.strictEqual(promote.status, 302);
      const loc = String(promote.headers.get("location") || "");
      assert.match(loc, /project=my-repo/);
      assert.ok(!loc.includes("token="));
    } finally {
      authBus.close();
      await authServer.close();
    }
  });

  // --- Export and Import HTTP API Tests ---

  await t.test("POST /api/vaults/export validates projectId", async () => {
    const resUnknown = await fetch(`${baseUrl}/api/vaults/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "non-existent-proj" })
    });
    assert.strictEqual(resUnknown.status, 400);
    const bodyUnknown = await resUnknown.json() as { error: string };
    assert.strictEqual(bodyUnknown.error, "Unknown projectId");

    const resEmpty = await fetch(`${baseUrl}/api/vaults/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.strictEqual(resEmpty.status, 400);
  });

  await t.test("POST /api/vaults/export returns valid zip archive with vault-backup.json", async () => {
    // Add a record to export
    await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "export-test-trap",
      frontmatter: {
        id: "trap-export-test-trap",
        title: "Export Test Trap",
        severity: "medium"
      },
      body: "# Export Test\nMust be exported cleanly."
    });

    const res = await fetch(`${baseUrl}/api/vaults/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId })
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    const contentDisp = res.headers.get("content-disposition") || "";
    assert.ok(contentDisp.includes(`spec-memo-vault-${projectId}-`));
    assert.ok(contentDisp.endsWith(".zip\""));

    const zipBuffer = Buffer.from(await res.arrayBuffer());
    assert.ok(zipBuffer.length > 0);

    const jsonStr = unpackVaultZip(zipBuffer);
    const parsed = JSON.parse(jsonStr) as { format: string; projects: Array<{ projectId: string; records: Array<{ relativePath: string }> }> };
    assert.strictEqual(parsed.format, "spec-memo-vault-v1");
    assert.strictEqual(parsed.projects[0].projectId, projectId);
    assert.ok(parsed.projects[0].records.some((r) => r.relativePath.includes("export-test-trap.md")));

    // Verify activity event captured
    const events = bus.list({ projectId });
    assert.ok(events.some((e) => e.type === "system" && e.kind === "write" && e.summary.includes("export vault")));
  });

  await t.test("POST /api/vaults/export with password creates encrypted archive", async () => {
    const res = await fetch(`${baseUrl}/api/vaults/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, password: "test-export-pass" })
    });

    assert.strictEqual(res.status, 200);
    const zipBuffer = Buffer.from(await res.arrayBuffer());
    const jsonStr = unpackVaultZip(zipBuffer);
    const parsed = JSON.parse(jsonStr) as { format: string; cipher: string };
    assert.strictEqual(parsed.format, "spec-memo-encrypted-vault-v1");
    assert.strictEqual(parsed.cipher, "aes-256-gcm");
  });

  await t.test("POST /api/vaults/import handles errors and restores records", async () => {
    // 1. Non-multipart
    const resNoMultipart = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" })
    });
    assert.strictEqual(resNoMultipart.status, 400);

    // Helper to build multipart buffer
    function makeMultipart(boundary: string, parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>): Buffer {
      const chunks: Buffer[] = [];
      for (const p of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (p.filename !== undefined) {
          chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
          chunks.push(Buffer.from(`Content-Type: ${p.contentType || "application/octet-stream"}\r\n\r\n`));
        } else {
          chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
        }
        chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, "utf8"));
        chunks.push(Buffer.from("\r\n"));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return Buffer.concat(chunks);
    }

    const boundary = "---------------------------testboundary123";

    // 2. Missing archive file
    const bodyMissingFile = makeMultipart(boundary, [{ name: "password", data: "somepass" }]);
    const resMissing = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyMissingFile
    });
    assert.strictEqual(resMissing.status, 400);

    // 3. Non-zip file
    const bodyNonZip = makeMultipart(boundary, [{ name: "archive", filename: "test.txt", data: "not a zip file" }]);
    const resNonZip = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyNonZip
    });
    assert.strictEqual(resNonZip.status, 400);

    // 4. Valid ZIP export and re-import into a new project
    const importedProjId = "restored-proj-1";
    const exportData = await exportVault({ vaultRoot, projectId });
    // Modify project id in payload to test restore under restored-proj-1
    const rawArchive = JSON.parse(exportData.payload!) as { projects: Array<{ projectId: string }> };
    rawArchive.projects[0].projectId = importedProjId;
    const testZip = packVaultZip(JSON.stringify(rawArchive));

    const bodyValid = makeMultipart(boundary, [{ name: "archive", filename: "backup.zip", data: testZip }]);
    const resValid = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyValid
    });

    assert.strictEqual(resValid.status, 200);
    const validJson = await resValid.json() as { ok: boolean; restoredProjectsCount: number; restoredProjects: string[] };
    assert.strictEqual(validJson.ok, true);
    assert.strictEqual(validJson.restoredProjectsCount, 1);
    assert.ok(validJson.restoredProjects.includes(importedProjId));

    // Verify restored project exists in vault project list
    const vaultsAfter = await (await fetch(`${baseUrl}/api/vaults`)).json() as Array<{ id: string }>;
    assert.ok(vaultsAfter.some((v) => v.id === importedProjId));

    // 5. Encrypted archive import with password
    const encExport = await exportVault({ vaultRoot, projectId, password: "secret-import-pass" });
    const encZip = packVaultZip(encExport.payload!);

    // Import without password fails
    const bodyEncNoPass = makeMultipart(boundary, [{ name: "archive", filename: "enc.zip", data: encZip }]);
    const resEncNoPass = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyEncNoPass
    });
    assert.strictEqual(resEncNoPass.status, 400);

    // Import with password succeeds
    const bodyEncPass = makeMultipart(boundary, [
      { name: "archive", filename: "enc.zip", data: encZip },
      { name: "password", data: "secret-import-pass" }
    ]);
    const resEncPass = await fetch(`${baseUrl}/api/vaults/import`, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyEncPass
    });
    assert.strictEqual(resEncPass.status, 200);
  });

  await t.test("POST /api/vaults/export and import enforce auth token", async () => {
    const authBus = createActivityBus();
    const authServer = await startStatusServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "backup-secret",
      activityBus: authBus
    });
    try {
      // Export unauthorized
      const resExpUnauth = await fetch(`${authServer.url}/api/vaults/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId })
      });
      assert.strictEqual(resExpUnauth.status, 401);

      // Export authorized
      const resExpAuth = await fetch(`${authServer.url}/api/vaults/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer backup-secret"
        },
        body: JSON.stringify({ projectId })
      });
      assert.strictEqual(resExpAuth.status, 200);

      // Import unauthorized
      const boundary = "---bound123";
      const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="foo"\r\n\r\nbar\r\n--${boundary}--\r\n`);
      const resImpUnauth = await fetch(`${authServer.url}/api/vaults/import`, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body
      });
      assert.strictEqual(resImpUnauth.status, 401);
    } finally {
      authBus.close();
      await authServer.close();
    }
  });

  await t.test("writes detailed error report to error.logs on status server failures", async () => {
    const errorServer = await startStatusServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "status-test-secret",
      activityBus: bus
    });

    try {
      const url = errorServer.url;

      // 1. Unauthorized access to /api/vaults
      const unauthRes = await fetch(`${url}/api/vaults`);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Export unknown project
      const exportRes = await fetch(`${url}/api/vaults/export`, {
        method: "POST",
        headers: {
          "Authorization": "Bearer status-test-secret",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ projectId: "non-existent-proj" })
      });
      assert.strictEqual(exportRes.status, 400);

      // 3. Import with missing boundary
      const importRes = await fetch(`${url}/api/vaults/import`, {
        method: "POST",
        headers: {
          "Authorization": "Bearer status-test-secret",
          "Content-Type": "multipart/form-data"
        },
        body: "invalid"
      });
      assert.strictEqual(importRes.status, 400);

      // Verify error.logs contents
      const logs = readErrorLogs(vaultRoot);
      assert.ok(logs.includes("[status-server]"));
      assert.ok(logs.includes("Unauthorized request"));
      assert.ok(logs.includes("Unknown projectId: non-existent-proj"));
      assert.ok(logs.includes("Content-Type must be multipart/form-data with boundary"));
      // Redaction check: secret token should not be leaked in cleartext in the logs
      assert.ok(!logs.includes("Bearer status-test-secret"));
    } finally {
      await errorServer.close();
    }
  });
});

test("ZIP Pack and Unpack Helpers", async (t) => {
  await t.test("round-trips JSON string payload", () => {
    const original = JSON.stringify({ test: "spec-memo", count: 42, nested: { ok: true } }, null, 2);
    const zip = packVaultZip(original);
    assert.ok(zip.length > 30);
    const unpacked = unpackVaultZip(zip);
    assert.strictEqual(unpacked, original);
  });

  await t.test("unpacks single .json entry fallback", () => {
    const original = JSON.stringify({ fallback: true });
    const zip = packVaultZip(original, "custom-backup-name.json");
    const unpacked = unpackVaultZip(zip);
    assert.strictEqual(unpacked, original);
  });

  await t.test("throws on invalid buffer, non-zip, or corrupted zip", () => {
    assert.throws(() => unpackVaultZip(Buffer.alloc(10)), /Buffer too short/);
    assert.throws(() => unpackVaultZip(Buffer.from("not a zip at all 1234567890")), /expected ZIP file/);

    const emptyZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00
    ]);
    assert.throws(() => unpackVaultZip(emptyZip), /expected ZIP file|Archive is empty/);
  });

  await t.test("parseMultipartFormData correctly parses fields and binary files", () => {
    const boundary = "test_boundary_xyz";
    const binaryData = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\nmy-pass\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      binaryData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const parsed = parseMultipartFormData(multipart, boundary);
    assert.strictEqual(parsed.fields.password, "my-pass");
    assert.ok(parsed.files.archive);
    assert.strictEqual(parsed.files.archive.filename, "archive.zip");
    assert.strictEqual(parsed.files.archive.contentType, "application/zip");
    assert.deepStrictEqual(parsed.files.archive.data, binaryData);
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
