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
});
