import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initVault } from "./vault.js";
import { upsertRecord, getRecord } from "./store.js";
import { closeIndex, searchIndex } from "./indexer.js";
import {
  areBodiesSemanticallyEqual,
  mergeRecordMetadata,
  cleanConflictSidecars,
  applyChangeset,
  exportChangeset,
  Changeset
} from "./sync.js";
import { syncDual } from "./dual-sync.js";
import { runDoctor } from "./doctor.js";
import { serializeRecord } from "./schema.js";
import { RecordFrontmatter } from "./types.js";

test("Conflict Reconciliation & Auto-Merge Engine", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-reconcile-test-"));
  const vaultRoot = path.join(tempDir, "vault");
  const projectId = "proj-reconcile";

  t.after(() => {
    closeIndex(vaultRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  initVault({ vaultRoot, projectId, displayName: "Reconcile Project" });

  await t.test("areBodiesSemanticallyEqual normalizes CRLF and whitespace", () => {
    const body1 = "Line 1\r\nLine 2\r\n";
    const body2 = "Line 1\nLine 2\n";
    assert.strictEqual(areBodiesSemanticallyEqual(body1, body2), true);

    const body3 = "  Line 1\nLine 2  ";
    assert.strictEqual(areBodiesSemanticallyEqual(body1, body3), true);

    const bodyDiff = "Line 1\nLine 2 altered\n";
    assert.strictEqual(areBodiesSemanticallyEqual(body1, bodyDiff), false);
  });

  await t.test("mergeRecordMetadata merges retrieval hits, tags, and timestamps", () => {
    const localFm: RecordFrontmatter = {
      id: "trap-test",
      kind: "trap",
      project: projectId,
      created: "2026-09-01T00:00:00.000Z",
      updated: "2026-09-01T10:00:00.000Z",
      status: "active",
      source: "agent",
      hits: 5,
      lastHit: "2026-09-02T12:00:00.000Z",
      occurrences: 2,
      lastSeen: "2026-09-02T10:00:00.000Z",
      tags: ["tag-a", "tag-b"]
    };

    const incomingFm: RecordFrontmatter = {
      id: "trap-test",
      kind: "trap",
      project: projectId,
      created: "2026-09-01T00:00:00.000Z",
      updated: "2026-09-01T10:00:00.000Z",
      status: "active",
      source: "agent",
      hits: 12,
      lastHit: "2026-09-03T15:00:00.000Z",
      occurrences: 4,
      lastSeen: "2026-09-03T14:00:00.000Z",
      tags: ["tag-b", "tag-c"]
    };

    const merged = mergeRecordMetadata(localFm, incomingFm);
    assert.strictEqual(merged.hits, 12);
    assert.strictEqual(merged.occurrences, 4);
    assert.strictEqual(merged.lastHit, "2026-09-03T15:00:00.000Z");
    assert.strictEqual(merged.lastSeen, "2026-09-03T14:00:00.000Z");
    assert.deepStrictEqual(merged.tags?.sort(), ["tag-a", "tag-b", "tag-c"].sort());
  });

  await t.test("applyChangeset auto-merges identical bodies with diverged metadata without sidecars", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-automerge",
      frontmatter: {
        hits: 2,
        tags: ["local-only"]
      },
      body: "# Auto Merge Test\nSame body content."
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;

    const incomingChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projectId,
          frontmatter: {
            ...item.frontmatter,
            hits: 15,
            tags: ["remote-tag"]
          },
          body: "# Auto Merge Test\r\nSame body content.\r\n"
        }
      ]
    };

    const res = await applyChangeset(vaultRoot, incomingChangeset, { strategy: "smart-merge" });
    assert.strictEqual(res.applied, 1);
    assert.strictEqual(res.autoMerged, 1);
    assert.strictEqual(res.conflicts, 0);

    const updated = await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id });
    assert.ok(updated);
    assert.strictEqual(updated?.frontmatter.hits, 15);
    assert.ok(updated?.frontmatter.tags?.includes("local-only"));
    assert.ok(updated?.frontmatter.tags?.includes("remote-tag"));

    // Check no conflict sidecars were created
    const recordDir = path.dirname(record.path);
    const sidecars = fs.readdirSync(recordDir).filter((f) => f.includes(".conflict"));
    assert.strictEqual(sidecars.length, 0);
  });

  await t.test("applyChangeset with local-wins honors local record and creates no sidecar", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-local-wins",
      body: "# Local Wins\nLocal version."
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;

    const incomingChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projectId,
          frontmatter: {
            ...item.frontmatter,
            updated: "2026-09-04T12:00:00.000Z"
          },
          body: "# Remote Divergence\nRemote version."
        }
      ]
    };

    const res = await applyChangeset(vaultRoot, incomingChangeset, {
      strategy: "local-wins",
      prefer: "local"
    });
    assert.strictEqual(res.conflicts, 0);

    const check = await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id });
    assert.ok(check?.body.includes("Local version."));

    const recordDir = path.dirname(record.path);
    const sidecars = fs.readdirSync(recordDir).filter((f) => f.includes(".conflict"));
    assert.strictEqual(sidecars.length, 0);
  });

  await t.test("applyChangeset with remote-wins overwrites local record", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-remote-wins",
      body: "# Local Before Overwrite\nLocal version."
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;

    const incomingChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projectId,
          frontmatter: {
            ...item.frontmatter,
            updated: "2026-09-04T12:00:00.000Z"
          },
          body: "# Overwritten by Remote\nRemote version."
        }
      ]
    };

    const res = await applyChangeset(vaultRoot, incomingChangeset, {
      strategy: "remote-wins",
      prefer: "remote"
    });
    assert.strictEqual(res.applied, 1);
    assert.strictEqual(res.conflicts, 0);

    const check = await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id });
    assert.ok(check?.body.includes("Overwritten by Remote"));
  });

  await t.test("applyChangeset writes a single capped sidecar without timestamp proliferation", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-single-sidecar",
      body: "# Local Original\nLocal text."
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;

    const incomingChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projectId,
          frontmatter: {
            ...item.frontmatter,
            updated: "2026-09-04T12:00:00.000Z"
          },
          body: "# Remote Divergence\nDifferent remote text."
        }
      ]
    };

    // Apply first time
    const res1 = await applyChangeset(vaultRoot, incomingChangeset, { strategy: "sidecar" });
    assert.strictEqual(res1.conflicts, 1);

    // Apply second time
    const res2 = await applyChangeset(vaultRoot, incomingChangeset, { strategy: "sidecar" });
    assert.strictEqual(res2.conflicts, 1);

    const recordDir = path.dirname(record.path);
    const sidecars = fs.readdirSync(recordDir).filter((f) => f.includes("trap-single-sidecar.conflict"));
    // Exactly 1 sidecar file, no timestamps accumulated!
    assert.strictEqual(sidecars.length, 1);
    assert.strictEqual(sidecars[0], "trap-single-sidecar.conflict.md");
  });

  await t.test("cleanConflictSidecars safely cleans identical sidecars and honors prefer local", async () => {
    const cleanProj = "proj-clean-sidecars";
    initVault({ vaultRoot, projectId: cleanProj });

    const record = await upsertRecord({
      vaultRoot,
      projectId: cleanProj,
      kind: "trap",
      slug: "trap-clean-me",
      body: "# Base Content\nIdentical body here."
    });

    const item = (await getRecord({ vaultRoot, projectId: cleanProj, kind: "trap", id: record.id }))!;
    const fullRecordPath = record.path;
    const recordDir = path.dirname(fullRecordPath);

    // Create a matching sidecar (same body)
    const matchingSidecar = path.join(recordDir, "trap-clean-me.conflict.20260904.md");
    fs.writeFileSync(
      matchingSidecar,
      serializeRecord({
        frontmatter: {
          ...item.frontmatter,
          id: "trap-clean-me-conflict",
          hits: 99
        },
        body: "# Base Content\nIdentical body here."
      }),
      "utf8"
    );

    // Create a divergent sidecar
    const divergentSidecar = path.join(recordDir, "trap-clean-me.conflict.divergent.md");
    fs.writeFileSync(
      divergentSidecar,
      serializeRecord({
        frontmatter: {
          ...item.frontmatter,
          id: "trap-clean-me-diff"
        },
        body: "# Divergent Content\nCompletely different text."
      }),
      "utf8"
    );

    // Default clean: only cleans matching sidecars
    const clean1 = cleanConflictSidecars(vaultRoot, { projectId: cleanProj });
    assert.strictEqual(clean1.cleaned, 1);
    assert.strictEqual(clean1.retained, 1);
    assert.strictEqual(fs.existsSync(matchingSidecar), false);
    assert.strictEqual(fs.existsSync(divergentSidecar), true);

    // Prefer local clean: also cleans divergent sidecar
    const clean2 = cleanConflictSidecars(vaultRoot, { projectId: cleanProj, prefer: "local" });
    assert.strictEqual(clean2.cleaned, 1);
    assert.strictEqual(fs.existsSync(divergentSidecar), false);
    // Primary record remains untouched
    assert.strictEqual(fs.existsSync(fullRecordPath), true);
  });

  await t.test("applyChangeset transaction aborts and leaves zero changes on pre-validation error", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-rollback-test",
      body: "# Unchanged Body"
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;

    const invalidChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projectId,
          frontmatter: { ...item.frontmatter, updated: "2026-09-04T15:00:00.000Z" },
          body: "# Attempted change"
        },
        {
          project: "../../outside", // Traversal violation!
          frontmatter: { id: "evil", kind: "trap", project: "../../outside", created: "", updated: "", status: "active", source: "agent" },
          body: "# Exploit"
        }
      ]
    };

    await assert.rejects(async () => {
      await applyChangeset(vaultRoot, invalidChangeset);
    });

    // Record should be completely untouched
    const check = await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id });
    assert.strictEqual(check?.body, "# Unchanged Body");
  });

  await t.test("memo doctor --fix cleans conflict sidecars and reports fixedCount", async () => {
    const record = await upsertRecord({
      vaultRoot,
      projectId,
      kind: "trap",
      slug: "trap-doctor-sidecar",
      body: "# Doctor Test Body"
    });

    const item = (await getRecord({ vaultRoot, projectId, kind: "trap", id: record.id }))!;
    const fullRecordPath = record.path;
    const sidecarPath = path.join(path.dirname(fullRecordPath), "trap-doctor-sidecar.conflict.md");
    fs.writeFileSync(
      sidecarPath,
      serializeRecord({
        frontmatter: { ...item.frontmatter, id: "trap-doctor-sidecar-c" },
        body: "# Doctor Test Body"
      }),
      "utf8"
    );

    // Initial doctor scan warns about sidecar
    const docBefore = await runDoctor({ vaultRoot });
    assert.ok(docBefore.warnings.some((w) => w.includes("conflict sidecar")));

    // Doctor with --fix removes it
    const docAfter = await runDoctor({ vaultRoot, fix: true });
    assert.ok((docAfter.pollution.fixedCount ?? 0) >= 1);
    assert.strictEqual(fs.existsSync(sidecarPath), false);
  });

  await t.test("memo doctor --fix retains divergent sidecars for explicit reconcile", async () => {
    const divProj = "proj-doctor-divergent";
    initVault({ vaultRoot, projectId: divProj });
    const record = await upsertRecord({
      vaultRoot,
      projectId: divProj,
      kind: "trap",
      slug: "trap-doctor-divergent",
      body: "# Local Base Body"
    });
    const item = (await getRecord({ vaultRoot, projectId: divProj, kind: "trap", id: record.id }))!;
    const sidecarPath = path.join(path.dirname(record.path), "trap-doctor-divergent.conflict.md");
    fs.writeFileSync(
      sidecarPath,
      serializeRecord({
        frontmatter: { ...item.frontmatter, id: "trap-doctor-divergent-c" },
        body: "# Remote Divergent Body"
      }),
      "utf8"
    );
    const docAfter = await runDoctor({ vaultRoot, fix: true });
    assert.strictEqual(fs.existsSync(sidecarPath), true);
    assert.strictEqual(fs.existsSync(record.path), true);
    void docAfter;
  });

  await t.test("cleanConflictSidecars journals base and sidecar mutations for rollback", async () => {
    const jProj = "proj-journal-sidecars";
    initVault({ vaultRoot, projectId: jProj });
    const record = await upsertRecord({
      vaultRoot,
      projectId: jProj,
      kind: "trap",
      slug: "trap-journal-me",
      body: "# Journal Base"
    });
    const item = (await getRecord({ vaultRoot, projectId: jProj, kind: "trap", id: record.id }))!;
    const sidecarPath = path.join(path.dirname(record.path), "trap-journal-me.conflict.md");
    fs.writeFileSync(
      sidecarPath,
      serializeRecord({
        frontmatter: { ...item.frontmatter, id: "trap-journal-me-c" },
        body: "# Journal Base"
      }),
      "utf8"
    );
    const journal: Array<{ filePath: string; originalContent: string | null }> = [];
    const res = cleanConflictSidecars(vaultRoot, { projectId: jProj, journal });
    assert.strictEqual(res.cleaned, 1);
    assert.ok(journal.length >= 2);
    assert.ok(journal.some((j) => j.filePath === record.path));
    assert.ok(journal.some((j) => j.filePath === sidecarPath));
  });

  await t.test("applyChangeset with cleanSidecars covers cross-project sidecar projects", async () => {
    const projA = "proj-xs-a";
    const projB = "proj-xs-b";
    initVault({ vaultRoot, projectId: projA });
    initVault({ vaultRoot, projectId: projB });
    const recA = await upsertRecord({
      vaultRoot,
      projectId: projA,
      kind: "trap",
      slug: "trap-xs-a",
      body: "# Proj A Base"
    });
    const recB = await upsertRecord({
      vaultRoot,
      projectId: projB,
      kind: "trap",
      slug: "trap-xs-b",
      body: "# Proj B Base"
    });
    const itemB = (await getRecord({ vaultRoot, projectId: projB, kind: "trap", id: recB.id }))!;
    const sidecarB = path.join(path.dirname(recB.path), "trap-xs-b.conflict.md");
    fs.writeFileSync(
      sidecarB,
      serializeRecord({
        frontmatter: { ...itemB.frontmatter, id: "trap-xs-b-c" },
        body: "# Proj B Base"
      }),
      "utf8"
    );
    const itemA = (await getRecord({ vaultRoot, projectId: projA, kind: "trap", id: recA.id }))!;
    const changeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: projA,
          frontmatter: { ...itemA.frontmatter, updated: new Date(Date.now() + 1000).toISOString() },
          body: "# Proj A Base"
        }
      ]
    };
    const res = await applyChangeset(vaultRoot, changeset, { cleanSidecars: true });
    assert.strictEqual(res.sidecarsCleaned, 1);
    assert.strictEqual(fs.existsSync(sidecarB), false);
  });

  await t.test("applyChangeset logs body-divergence conflicts under sync-reconcile (AC20)", async () => {
    const logProj = "proj-ac20-logging";
    initVault({ vaultRoot, projectId: logProj });
    const record = await upsertRecord({
      vaultRoot,
      projectId: logProj,
      kind: "trap",
      slug: "trap-ac20",
      body: "# AC20 Local Base"
    });
    const item = (await getRecord({ vaultRoot, projectId: logProj, kind: "trap", id: record.id }))!;
    const { clearErrorLogs, readErrorLogs } = await import("./error-logger.js");
    clearErrorLogs(vaultRoot);
    const conflictChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      records: [
        {
          project: logProj,
          frontmatter: { ...item.frontmatter, updated: item.frontmatter.updated },
          body: "# AC20 Remote Divergent Body"
        }
      ]
    };
    const res = await applyChangeset(vaultRoot, conflictChangeset, { strategy: "sidecar" });
    assert.strictEqual(res.conflicts, 1);
    assert.ok(res.conflictDetails && res.conflictDetails.length > 0);
    const logs = readErrorLogs(vaultRoot);
    assert.ok(logs.includes("sync-reconcile"));
  });

  await t.test("memo reconcile emits sync_reconcile telemetry (AC21)", async () => {
    const { spawnSync } = await import("node:child_process");
    const cliPath = path.resolve("dist/cli.js");
    // Exit code may be 1 when divergent sidecars are retained; telemetry still emits.
    spawnSync(
      process.execPath,
      [cliPath, "reconcile", "--vaultRoot", vaultRoot, "--all", "--json"],
      { encoding: "utf8" }
    );
    const telemetryDir = path.join(vaultRoot, "telemetry");
    const files = fs.existsSync(telemetryDir) ? fs.readdirSync(telemetryDir) : [];
    let found = false;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const content = fs.readFileSync(path.join(telemetryDir, f), "utf8");
      if (content.includes("sync_reconcile")) {
        found = true;
        break;
      }
    }
    assert.strictEqual(found, true);
  });

  await t.test("memo reconcile flushes vault-git in local mode when enabled", async () => {
    const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-reconcile-git-test-"));
    const gitVault = path.join(gitDir, "vault");
    t.after(() => {
      closeIndex(gitVault);
      fs.rmSync(gitDir, { recursive: true, force: true });
    });
    initVault({ vaultRoot: gitVault, projectId: "proj-git-local" });
    const configPath = path.join(gitVault, "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.vaultGit = { enabled: true, atomic: false };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");

    const { spawnSync } = await import("node:child_process");
    const cliPath = path.resolve("dist/cli.js");
    const res = spawnSync(
      process.execPath,
      [cliPath, "reconcile", "--vaultRoot", gitVault, "--all", "--json"],
      { encoding: "utf8" }
    );
    assert.strictEqual(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.command, "reconcile");
    assert.ok(parsed.sync && parsed.sync.vaultGit, "expected vaultGit channel in local mode");
  });

  await t.test("hybrid push forwards cleanSidecars to the remote daemon", async () => {
    const http = await import("node:http");
    let receivedBody: any = null;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && (req.url || "").startsWith("/api/sync/push")) {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          try {
            receivedBody = JSON.parse(raw);
          } catch {
            receivedBody = null;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ applied: 0, skipped: 0, conflicts: 0, dryRun: false, recordsApplied: [] })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const { pushHybridProject } = await import("./hybrid-sync.js");
      await pushHybridProject(
        vaultRoot,
        projectId,
        `http://127.0.0.1:${port}`,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        true
      );
      assert.ok(receivedBody, "expected push request body");
      assert.strictEqual(receivedBody.cleanSidecars, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test("parseReconcilePreference maps interactive choices (AC9)", async () => {
    const { parseReconcilePreference } = await import("./cli.js");
    assert.strictEqual(parseReconcilePreference("l"), "local");
    assert.strictEqual(parseReconcilePreference("LOCAL"), "local");
    assert.strictEqual(parseReconcilePreference("r"), "remote");
    assert.strictEqual(parseReconcilePreference("remote"), "remote");
    assert.strictEqual(parseReconcilePreference("m"), undefined);
    assert.strictEqual(parseReconcilePreference(""), undefined);
    assert.strictEqual(parseReconcilePreference(undefined), undefined);
  });

  await t.test("dual-sync report.ok is false when hybrid channel fails even if vault-git succeeds", async () => {
    const dualVault = path.join(tempDir, "dual-vault");
    initVault({ vaultRoot: dualVault, projectId: "proj-dual" });
    const configPath = path.join(dualVault, "config.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.mode = "hybrid";
    cfg.remote = { url: "http://127.0.0.1:59999" };
    cfg.vaultGit = { enabled: true, atomic: false };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");

    const { syncDual } = await import("./dual-sync.js");
    const dualRes = await syncDual({
      vaultRoot: dualVault,
      projectId: "proj-dual",
      trigger: "sync"
    });

    assert.strictEqual(dualRes.hybrid?.ok, false);
    // Even if vault-git succeeds (or both fail), report.ok must be false when hybrid fails
    assert.strictEqual(dualRes.ok, false);
    closeIndex(dualVault);
  });

  await t.test("CLI memo reconcile runs clean-sidecars and prints report", async () => {
    const { execSync } = await import("node:child_process");
    const cliPath = path.resolve("dist/cli.js");
    const output = execSync(
      `node "${cliPath}" reconcile --vaultRoot "${vaultRoot}" --prefer local --clean-sidecars --json`,
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.command, "reconcile");
    assert.strictEqual(parsed.prefer, "local");
    assert.strictEqual(parsed.strategy, "smart-merge");
    assert.strictEqual(typeof parsed.sidecarsCleaned, "number");
  });

  await t.test("CLI memo reconcile returns exit code 1 when sidecars are retained", async () => {
    const retainedProj = "proj-reconcile-retained";
    initVault({ vaultRoot, projectId: retainedProj });
    const record = await upsertRecord({
      vaultRoot,
      projectId: retainedProj,
      kind: "trap",
      slug: "trap-retained-test",
      body: "# Base Version"
    });
    const item = (await getRecord({ vaultRoot, projectId: retainedProj, kind: "trap", id: record.id }))!;
    const sidecarPath = path.join(path.dirname(record.path), "trap-retained-test.conflict.md");
    fs.writeFileSync(
      sidecarPath,
      serializeRecord({
        frontmatter: { ...item.frontmatter, id: "trap-retained-test-c" },
        body: "# Divergent Body That Will Not Auto Merge"
      }),
      "utf8"
    );

    const { spawnSync } = await import("node:child_process");
    const cliPath = path.resolve("dist/cli.js");
    // With smart-merge and no prefer, divergent sidecar is retained -> must exit 1
    const res = spawnSync(
      process.execPath,
      [cliPath, "reconcile", "--vaultRoot", vaultRoot, "--clean-sidecars", "--all", "--json"],
      { encoding: "utf8" }
    );
    assert.strictEqual(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.sidecarsRetained > 0);
  });

  await t.test("applyChangeset rolls back post-mutation writes and rebuilds FTS on abort", async () => {
    const rbProj = "proj-sidecar-rollback";
    initVault({ vaultRoot, projectId: rbProj });
    const record = await upsertRecord({
      vaultRoot,
      projectId: rbProj,
      kind: "trap",
      slug: "trap-rb-sidecar",
      body: "# Original Base"
    });
    const item = (await getRecord({ vaultRoot, projectId: rbProj, kind: "trap", id: record.id }))!;
    const sidecarPath = path.join(path.dirname(record.path), "trap-rb-sidecar.conflict.md");

    // Records loop applies (sidecar write + new record upsert with FTS
    // indexing) before the deletions loop throws on traversal — genuine
    // post-mutation rollback, not a pre-validation abort.
    const now = new Date().toISOString();
    const sidecarChangeset: Changeset = {
      schemaVersion: 1,
      generatedAt: now,
      records: [
        {
          project: rbProj,
          frontmatter: { ...item.frontmatter },
          body: "# Divergent Remote Body"
        },
        {
          project: rbProj,
          frontmatter: { ...item.frontmatter, id: "trap-rb-rollback-new", slug: "trap-rb-rollback-new", updated: now },
          body: "# Rollback Probe Unique Content ABCXYZ"
        }
      ],
      deletions: [
        {
          project: "../../traversal-fail", // Throws mid-loop after records applied
          kind: "trap",
          id: "fail",
          slug: "fail"
        }
      ]
    };

    await assert.rejects(async () => {
      await applyChangeset(vaultRoot, sidecarChangeset, { strategy: "sidecar" });
    });

    // Sidecar must not remain on disk after rollback
    assert.strictEqual(fs.existsSync(sidecarPath), false);
    // New record file must be removed by rollback
    const newPath = path.join(path.dirname(record.path), "trap-rb-rollback-new.md");
    assert.strictEqual(fs.existsSync(newPath), false);
    // Original base record must be untouched
    const check = await getRecord({ vaultRoot, projectId: rbProj, kind: "trap", id: record.id });
    assert.strictEqual(check?.body, "# Original Base");
    // FTS must not index aborted writes (no ghost hits)
    const ghosts = searchIndex({ query: "Rollback Probe Unique Content ABCXYZ", projectId: rbProj, vaultRoot });
    assert.strictEqual(ghosts.length, 0);
  });

  await t.test("mergeRecordMetadata preserves active status unless both sides agree", async () => {
    const baseFm = {
      id: "trap-status",
      kind: "trap" as const,
      project: projectId,
      created: "2026-09-01T00:00:00.000Z",
      updated: "2026-09-01T10:00:00.000Z",
      status: "active" as const,
      source: "agent" as const
    };
    // Active + archived (either order) stays active so bootstrap keeps the trap
    assert.strictEqual(
      mergeRecordMetadata(baseFm, { ...baseFm, status: "archived" }).status,
      "active"
    );
    assert.strictEqual(
      mergeRecordMetadata({ ...baseFm, status: "archived" }, baseFm).status,
      "active"
    );
    // Both archived stays archived; superseded stays sticky from either side
    assert.strictEqual(
      mergeRecordMetadata({ ...baseFm, status: "archived" }, { ...baseFm, status: "archived" }).status,
      "archived"
    );
    assert.strictEqual(
      mergeRecordMetadata(baseFm, { ...baseFm, status: "superseded" }).status,
      "superseded"
    );
  });
});
