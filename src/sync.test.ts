import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initVault } from "./vault.js";
import { upsertRecord, getRecord } from "./store.js";
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
});
