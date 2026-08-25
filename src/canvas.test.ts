import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureProjectVault } from "./vault.js";
import { upsertRecord } from "./store.js";
import { rebuildIndex, closeIndex } from "./indexer.js";
import { generateProjectGraph, startCanvasServer } from "./canvas.js";

test("Canvas Engine & Graph Visualization", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-canvas-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "test-canvas-proj";

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

      // 4. Check API record detail
      const recordRes = await fetch(`${baseUrl}/api/record/${projectId}/spec/${spec1.id}`);
      assert.strictEqual(recordRes.status, 200);
      const recordData = await recordRes.json() as any;
      assert.ok(recordData.record);
      assert.strictEqual(recordData.record.frontmatter.id, spec1.id);

      // 5. Check API search
      const searchRes = await fetch(`${baseUrl}/api/search?q=Leak&project=${projectId}`);
      assert.strictEqual(searchRes.status, 200);
      const searchHits = await searchRes.json() as any[];
      assert.ok(searchHits.length >= 1);
    } finally {
      await serverInstance.close();
    }
  });
});
