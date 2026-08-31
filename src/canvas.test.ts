import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureProjectVault } from "./vault.js";
import { upsertRecord } from "./store.js";
import { rebuildIndex, closeIndex } from "./indexer.js";
import { generateProjectGraph, startCanvasServer, isMonitorActivityLogRecord } from "./canvas.js";
import { appendEvent } from "./store.js";

test("Canvas Engine & Graph Visualization", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-canvas-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "test-canvas-proj";

  const savedEnv = {
    auth: process.env.SPEC_MEMO_AUTH_TOKEN,
    canvas: process.env.SPEC_MEMO_CANVAS_TOKEN,
    sse: process.env.SPEC_MEMO_SSE_TOKEN,
    status: process.env.SPEC_MEMO_STATUS_TOKEN,
    root: process.env.SPEC_MEMO_ROOT,
    errorLog: process.env.SPEC_MEMO_ERROR_LOG
  };

  delete process.env.SPEC_MEMO_AUTH_TOKEN;
  delete process.env.SPEC_MEMO_CANVAS_TOKEN;
  delete process.env.SPEC_MEMO_SSE_TOKEN;
  delete process.env.SPEC_MEMO_STATUS_TOKEN;
  delete process.env.SPEC_MEMO_ROOT;
  delete process.env.SPEC_MEMO_ERROR_LOG;

  t.after(() => {
    if (savedEnv.auth !== undefined) process.env.SPEC_MEMO_AUTH_TOKEN = savedEnv.auth;
    else delete process.env.SPEC_MEMO_AUTH_TOKEN;
    if (savedEnv.canvas !== undefined) process.env.SPEC_MEMO_CANVAS_TOKEN = savedEnv.canvas;
    else delete process.env.SPEC_MEMO_CANVAS_TOKEN;
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

  const trap1 = await upsertRecord({
    vaultRoot,
    projectId,
    kind: "trap",
    frontmatter: {
      severity: "high",
      pathPatterns: ["src/**/*.ts"]
    },
    body: "# Memory Leak in Canvas\nDO NOT create unbounded listeners.\nINSTEAD DO remove listeners."
  });

  const trap2 = await upsertRecord({
    vaultRoot,
    projectId,
    kind: "trap",
    frontmatter: {
      severity: "critical",
      supersedes: trap1.id,
      pathPatterns: ["src/**/*.ts"]
    },
    body: "# Revised Memory Leak in Canvas\nDO NOT ignore AbortController."
  });

  const spec1 = await upsertRecord({
    vaultRoot,
    projectId,
    kind: "spec",
    slug: "canvas-spec",
    body: "# Canvas Feature Spec\nInteractive UI."
  });

  const plan1 = await upsertRecord({
    vaultRoot,
    projectId,
    kind: "plan",
    slug: "canvas-plan",
    frontmatter: {
      relatedSlug: "canvas-spec"
    },
    body: "# Canvas Plan\nDelivery plan."
  });

  await rebuildIndex(vaultRoot);

  await appendEvent({
    vaultRoot,
    projectId,
    event: "MCP tool upsert completed",
    details: { title: "Audit append for status monitor" }
  });

  await t.test("should exclude activity log records from graph by default", () => {
    const graphDefault = generateProjectGraph(vaultRoot, projectId);
    assert.ok(graphDefault.nodes.every((n) => n.kind !== "log"), "Log records must be hidden by default");
    assert.ok(graphDefault.nodes.length >= 4);

    const graphWithLogs = generateProjectGraph(vaultRoot, projectId, { includeLogs: true });
    assert.ok(graphWithLogs.nodes.some((n) => n.kind === "log"), "includeLogs should surface log records");
    assert.ok(graphWithLogs.nodes.length > graphDefault.nodes.length);
  });

  await t.test("isMonitorActivityLogRecord identifies log kind and monitor tags", async () => {
    const trapRec = { frontmatter: { kind: "trap" as const, tags: ["sqlite"] }, body: "" };
    assert.strictEqual(isMonitorActivityLogRecord(trapRec as any), false);

    const logRec = { frontmatter: { kind: "log" as const }, body: "" };
    assert.strictEqual(isMonitorActivityLogRecord(logRec as any), true);

    const taggedRec = { frontmatter: { kind: "spec" as const, tags: ["monitor"] }, body: "" };
    assert.strictEqual(isMonitorActivityLogRecord(taggedRec as any), true);
  });

  await t.test("should generate graph with nodes and relational edges", () => {
    const graph = generateProjectGraph(vaultRoot, projectId);
    assert.strictEqual(graph.projectId, projectId);
    assert.ok(graph.nodes.length >= 4);

    const trap2Node = graph.nodes.find(n => n.id === trap2.id);
    assert.ok(trap2Node);
    assert.strictEqual(trap2Node?.kind, "trap");
    assert.strictEqual(trap2Node?.severity, "critical");

    const supersedesEdge = graph.edges.find(e => e.source === trap2.id && e.target === trap1.id);
    assert.ok(supersedesEdge);
    assert.strictEqual(supersedesEdge?.relation, "supersedes");

    const planNode = graph.nodes.find(n => n.id === plan1.id);
    assert.ok(planNode);
    const relatedEdge = graph.edges.find(e => e.source === plan1.id && e.target === spec1.id);
    assert.ok(relatedEdge);
    assert.strictEqual(relatedEdge?.relation, "related");
  });

  await t.test("should serve canvas HTML and REST endpoints over HTTP", async () => {
    const serverInstance = await startCanvasServer({ vaultRoot, port: 0, host: "127.0.0.1" });
    const baseUrl = serverInstance.url;

    try {
      // 1. Check HTML index
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.strictEqual(htmlRes.status, 200);
      assert.ok(htmlRes.headers.get("content-type")?.includes("text/html"));
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes("spec-memo"));
      assert.ok(htmlText.includes("<svg id=\"graph-canvas\""));

      // 2. Check API projects
      const projectsRes = await fetch(`${baseUrl}/api/projects`);
      assert.strictEqual(projectsRes.status, 200);
      const projects = await projectsRes.json() as any[];
      assert.ok(projects.some(p => p.id === projectId));

      // 3. Check API project graph
      const graphRes = await fetch(`${baseUrl}/api/project/${projectId}/graph`);
      assert.strictEqual(graphRes.status, 200);
      const graph = await graphRes.json() as any;
      assert.ok(graph.nodes.length >= 4);
      assert.ok(graph.nodes.every((n: { kind: string }) => n.kind !== "log"));

      const graphWithLogsRes = await fetch(`${baseUrl}/api/project/${projectId}/graph?includeLogs=1`);
      assert.strictEqual(graphWithLogsRes.status, 200);
      const graphWithLogs = await graphWithLogsRes.json() as any;
      assert.ok(graphWithLogs.nodes.some((n: { kind: string }) => n.kind === "log"));

      // 4. Check API record detail (with path stripping/sanitization)
      const recordRes = await fetch(`${baseUrl}/api/record/${projectId}/spec/${spec1.id}`);
      assert.strictEqual(recordRes.status, 200);
      const recordData = await recordRes.json() as any;
      assert.ok(recordData.record);
      assert.strictEqual(recordData.record.frontmatter.id, spec1.id);
      assert.strictEqual(recordData.record.path, undefined, "Record path must be stripped from HTTP API responses");

      // 5. Check API search (with path stripping/sanitization)
      const searchRes = await fetch(`${baseUrl}/api/search?q=Leak&project=${projectId}`);
      assert.strictEqual(searchRes.status, 200);
      const searchHits = await searchRes.json() as any[];
      assert.ok(searchHits.length >= 1);
      assert.strictEqual(searchHits[0].filepath, undefined, "Search hit filepath must be stripped from HTTP API responses");

      // 6. Check malicious project traversal fails safely
      const evilGraphRes = await fetch(`${baseUrl}/api/project/..%2F..%2Fevil/graph`);
      assert.strictEqual(evilGraphRes.status, 200);
      const evilGraph = await evilGraphRes.json() as any;
      assert.strictEqual(evilGraph.nodes.length, 0, "Traversed graph must return empty nodes");
    } finally {
      await serverInstance.close();
    }
  });

  await t.test("should refuse non-loopback host without auth token", () => {
    assert.throws(
      () => {
        startCanvasServer({ vaultRoot, port: 0, host: "192.168.1.100" });
      },
      {
        message: /Refusing to bind Canvas server to a non-loopback host without authentication token/
      }
    );
  });

  await t.test("should enforce authToken when configured on Canvas server", async () => {
    const authCanvas = await startCanvasServer({
      vaultRoot,
      port: 0,
      host: "127.0.0.1",
      authToken: "canvas-token-abc"
    });

    try {
      // 1. Unauthenticated request rejected with 401
      const unauthRes = await fetch(`${authCanvas.url}/api/projects`);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Authenticated request accepted via Authorization header
      const authHeaderRes = await fetch(`${authCanvas.url}/api/projects`, {
        headers: { Authorization: "Bearer canvas-token-abc" }
      });
      assert.strictEqual(authHeaderRes.status, 200);

      // 3. Query parameter auth is rejected (header-only auth required)
      const authQueryRes = await fetch(`${authCanvas.url}/api/projects?token=canvas-token-abc`);
      assert.strictEqual(authQueryRes.status, 401);
    } finally {
      await authCanvas.close();
    }
  });

  await t.test("should honor custom canvas port configured in config.json", async () => {
    const customVault = path.join(tempDir, "canvas-custom-ports-vault");
    fs.mkdirSync(customVault, { recursive: true });
    const configPath = path.join(customVault, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          ports: {
            canvas: 0
          }
        },
        null,
        2
      )
    );

    const inst = await startCanvasServer({
      vaultRoot: customVault,
      host: "127.0.0.1"
    });

    try {
      assert.ok(inst.port > 0);
      assert.ok(inst.url.includes(`:${inst.port}`));
    } finally {
      await inst.close();
    }
  });
});
