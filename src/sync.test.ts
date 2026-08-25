import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initVault } from "./vault.js";
import { upsertRecord, getRecord, forgetRecord } from "./store.js";
import { searchIndex, closeIndex } from "./indexer.js";
import { exportChangeset, applyChangeset, syncVaults } from "./sync.js";

test("Multi-Machine Vault Sync & Delta Engine", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-sync-test-"));
  const vaultA = path.join(tempDir, "vault-a");
  const vaultB = path.join(tempDir, "vault-b");
  const projA = "proj-alpha";

  t.after(() => {
    closeIndex(vaultA);
    closeIndex(vaultB);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  initVault({ vaultRoot: vaultA, projectId: projA, displayName: "Alpha on Machine A" });
  initVault({ vaultRoot: vaultB, projectId: projA, displayName: "Alpha on Machine B" });

  const record1 = await upsertRecord({
    vaultRoot: vaultA,
    projectId: projA,
    kind: "trap",
    frontmatter: {
      severity: "critical",
      pathPatterns: ["src/sync.ts"]
    },
    body: "# Sync Conflict Trap\nDO NOT drop offline changes."
  });

  const spec1 = await upsertRecord({
    vaultRoot: vaultA,
    projectId: projA,
    kind: "spec",
    slug: "sync-spec",
    body: "# Sync Spec\nDelta sync architecture."
  });

  await t.test("should export changeset from source vault", () => {
    const changeset = exportChangeset(vaultA);
    assert.strictEqual(changeset.schemaVersion, 1);
    assert.ok(changeset.records.length >= 2);
    assert.ok(changeset.records.some(r => r.frontmatter.id === record1.id));
    assert.ok(changeset.records.some(r => r.frontmatter.id === spec1.id));
  });

  await t.test("should apply changeset into target vault and rebuild index", async () => {
    const changeset = exportChangeset(vaultA);
    const result = await applyChangeset(vaultB, changeset);

    assert.strictEqual(result.applied, 2);
    assert.strictEqual(result.conflicts, 0);

    const syncedTrap = await getRecord({ vaultRoot: vaultB, projectId: projA, kind: "trap", id: record1.id });
    assert.ok(syncedTrap);
    assert.strictEqual(syncedTrap?.frontmatter.severity, "critical");

    const searchHits = searchIndex({ query: "offline", projectId: projA, vaultRoot: vaultB });
    assert.strictEqual(searchHits.length, 1);
    assert.strictEqual(searchHits[0].id, record1.id);
  });

  await t.test("should perform two-way synchronization between two vaults", async () => {
    // Add new record in Vault B
    const decisionB = await upsertRecord({
      vaultRoot: vaultB,
      projectId: projA,
      kind: "decision",
      slug: "crdt-decision",
      body: "# Decision on CRDT\nAdopt state-based delta merge."
    });

    const syncReport = await syncVaults(vaultA, vaultB, { twoWay: true });
    assert.ok(syncReport.forward);
    assert.ok(syncReport.backward);
    assert.strictEqual(syncReport.backward?.applied, 1);

    const syncedDecisionInA = await getRecord({ vaultRoot: vaultA, projectId: projA, kind: "decision", id: decisionB.id });
    assert.ok(syncedDecisionInA);
    assert.strictEqual(syncedDecisionInA?.frontmatter.id, "crdt-decision");
  });

  await t.test("should properly name files based on slug when id and slug differ", async () => {
    // Add record with divergent slug and id in Vault A
    const customRecord = await upsertRecord({
      vaultRoot: vaultA,
      projectId: projA,
      kind: "trap",
      slug: "auth-divergent-slug",
      frontmatter: {
        id: "trap-auth-divergent-id",
        slug: "auth-divergent-slug",
        title: "Divergent Slug Trap",
        severity: "medium"
      },
      body: "# Divergent Slug Body\nEnsure slug file naming is preserved."
    });

    const changeset = exportChangeset(vaultA);
    await applyChangeset(vaultB, changeset);

    // Check target vault file path uses slug
    const targetFilePath = path.join(vaultB, "projects", projA, "traps", "auth-divergent-slug.md");
    assert.ok(fs.existsSync(targetFilePath), "Target file must be named auth-divergent-slug.md");

    // Check get by slug and by id works
    const fetchedBySlug = await getRecord({ vaultRoot: vaultB, projectId: projA, kind: "trap", slug: "auth-divergent-slug" });
    assert.ok(fetchedBySlug);
    assert.strictEqual(fetchedBySlug?.frontmatter.id, "trap-auth-divergent-id");
  });

  await t.test("should reject changeset with path traversal segment", async () => {
    const maliciousChangeset = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      records: [
        {
          frontmatter: {
            id: "evil-trap",
            slug: "../../evil-trap",
            kind: "trap" as const,
            status: "active" as const,
            source: "agent" as const,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            project: projA
          },
          body: "evil",
          project: projA
        }
      ]
    };

    await assert.rejects(
      async () => {
        await applyChangeset(vaultB, maliciousChangeset);
      },
      {
        message: /Changeset record path escapes project directory/
      }
    );
  });

  await t.test("should reject changeset containing secrets", async () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const secretChangeset = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      records: [
        {
          frontmatter: {
            id: "secret-trap",
            slug: "secret-trap",
            kind: "trap" as const,
            status: "active" as const,
            source: "agent" as const,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            project: projA
          },
          body: `Leaked key ${awsKey}`,
          project: projA
        }
      ]
    };

    await assert.rejects(
      async () => {
        await applyChangeset(vaultB, secretChangeset);
      },
      {
        message: /Safety violation: Secret detected/
      }
    );
  });

  await t.test("should regenerate compiled Markdown views on applyChangeset", async () => {
    const newTrapChangeset = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      records: [
        {
          frontmatter: {
            id: "compiled-view-test-trap",
            slug: "compiled-view-test-trap",
            kind: "trap" as const,
            status: "active" as const,
            source: "agent" as const,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            project: projA,
            title: "Compiled View Test Trap"
          },
          body: "Ensure compiled views are rebuilt.",
          project: projA
        }
      ]
    };

    await applyChangeset(vaultB, newTrapChangeset);
    const trapsViewPath = path.join(vaultB, "projects", projA, "TRAPS.md");
    assert.ok(fs.existsSync(trapsViewPath), "TRAPS.md must exist in vault");
    const trapsViewContent = fs.readFileSync(trapsViewPath, "utf8");
    assert.ok(trapsViewContent.includes("Compiled View Test Trap"), "TRAPS.md must contain newly synced trap");
  });

  await t.test("should propagate deletions when changeset contains deletions", async () => {
    // 1. Create record in vaultB
    await upsertRecord({
      vaultRoot: vaultB,
      projectId: projA,
      kind: "scratch",
      slug: "to-delete-scratch",
      body: "Scratch to be deleted"
    });

    const scratchPath = path.join(vaultB, "projects", projA, "scratch", "to-delete-scratch.md");
    assert.ok(fs.existsSync(scratchPath));

    // 2. Apply changeset with deletion
    const delChangeset = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      records: [],
      deletions: [
        {
          project: projA,
          kind: "scratch" as const,
          id: "to-delete-scratch",
          slug: "to-delete-scratch"
        }
      ]
    };

    await applyChangeset(vaultB, delChangeset);
    assert.ok(!fs.existsSync(scratchPath), "Deleted record must be removed from disk");
  });

  await t.test("should perform append-only merge for conflicting logs without dropping events", async () => {
    // 1. Create log in vaultB
    const log1 = await upsertRecord({
      vaultRoot: vaultB,
      projectId: projA,
      kind: "log",
      slug: "daily-log",
      frontmatter: { created: "2026-08-01T00:00:00.000Z", updated: "2026-08-01T00:00:00.000Z" },
      body: "Initial daily log entry"
    });

    // 2. Apply updated log from remote
    const logChangeset = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      records: [
        {
          frontmatter: {
            id: log1.id,
            slug: "daily-log",
            kind: "log" as const,
            status: "active" as const,
            source: "agent" as const,
            created: "2026-08-01T00:00:00.000Z",
            updated: "2026-08-02T00:00:00.000Z",
            project: projA
          },
          body: "Updated daily log entry from remote",
          project: projA
        }
      ]
    };

    await applyChangeset(vaultB, logChangeset);
    const logsDir = path.join(vaultB, "projects", projA, "logs");
    const logFiles = fs.readdirSync(logsDir);
    assert.ok(logFiles.length >= 2, "Both original and merged remote log entries must be preserved");
  });

  await t.test("should propagate purged records end-to-end via syncVaults", async () => {
    // 1. Create scratch record on vaultA
    const scratchRec = await upsertRecord({
      vaultRoot: vaultA,
      projectId: projA,
      kind: "scratch",
      slug: "e2e-scratch-test",
      body: "Temporary scratch record for e2e sync test"
    });

    // 2. Sync to vaultB
    await syncVaults(vaultA, vaultB, { twoWay: true });
    const fetchedBefore = await getRecord({
      vaultRoot: vaultB,
      projectId: projA,
      id: scratchRec.id
    });
    assert.ok(fetchedBefore, "Record should exist in vaultB after initial sync");

    // 3. Purge record on vaultA
    await forgetRecord({
      vaultRoot: vaultA,
      projectId: projA,
      id: scratchRec.id,
      purge: true
    });

    // 4. Sync again
    await syncVaults(vaultA, vaultB, { twoWay: true });
    const fetchedAfter = await getRecord({
      vaultRoot: vaultB,
      projectId: projA,
      id: scratchRec.id
    });
    assert.strictEqual(fetchedAfter, null, "Purged record must be removed from vaultB after sync");
  });
});
