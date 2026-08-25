import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { upsertRecord, getRecord } from './store.js';
import { closeIndex } from './indexer.js';

describe('Store Engine (upsert and get)', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-store-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-store-proj-'));
  });

  afterEach(() => {
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('should upsert and get a trap record with auto-compiled views', async () => {
    const upsertRes = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-direct-eval',
      frontmatter: {
        id: 'trap-no-direct-eval',
        title: 'Avoid direct eval usage',
        severity: 'critical',
        pathPatterns: ['src/**/*.ts']
      },
      body: '## DO NOT\nNever use eval().\n\n## INSTEAD DO\nUse strict JSON parser.'
    });

    assert.equal(upsertRes.id, 'trap-no-direct-eval');
    assert.equal(upsertRes.kind, 'trap');
    assert.ok(fs.existsSync(upsertRes.path));

    // Check that getRecord retrieves it by id
    const retrieved = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-direct-eval'
    });

    assert.ok(retrieved);
    assert.equal(retrieved.frontmatter.id, 'trap-no-direct-eval');
    assert.equal(retrieved.frontmatter.severity, 'critical');
    assert.ok(retrieved.body.includes('Never use eval()'));

    // Check that getRecord retrieves it by kind + slug
    const retrievedBySlug = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-direct-eval'
    });
    assert.ok(retrievedBySlug);
    assert.equal(retrievedBySlug.frontmatter.id, 'trap-no-direct-eval');

    // Check that TRAPS.md and INDEX.md were generated
    const projectDir = path.dirname(path.dirname(upsertRes.path));
    assert.ok(fs.existsSync(path.join(projectDir, 'TRAPS.md')));
    assert.ok(fs.existsSync(path.join(projectDir, 'INDEX.md')));

    const trapsMd = fs.readFileSync(path.join(projectDir, 'TRAPS.md'), 'utf8');
    assert.ok(trapsMd.includes('[CRITICAL] Avoid direct eval usage'));
    assert.ok(trapsMd.includes('Never use eval()'));
  });

  it('should upsert an ADR decision record and compile DECISIONS.md', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'adr-001-sqlite-fts',
      frontmatter: {
        id: 'adr-001',
        title: 'Use SQLite FTS5 for local search index',
        status: 'active',
        rationale: 'FTS5 provides fast local full-text search with zero network dependency.'
      },
      body: '## Context\nWe need fast indexing.\n\n## Decision\nUse better-sqlite3 with FTS5.'
    });

    assert.equal(res.id, 'adr-001');
    assert.equal(res.kind, 'decision');

    const projectDir = path.dirname(path.dirname(res.path));
    assert.ok(fs.existsSync(path.join(projectDir, 'DECISIONS.md')));

    const decMd = fs.readFileSync(path.join(projectDir, 'DECISIONS.md'), 'utf8');
    assert.ok(decMd.includes('Use SQLite FTS5 for local search index'));
    assert.ok(decMd.includes('Use better-sqlite3 with FTS5'));
  });

  it('should mark older record as superseded when upserting with supersedes field', async () => {
    // 1. Create older trap
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-v1',
      frontmatter: {
        id: 'trap-v1',
        title: 'Initial Trap Rule',
        severity: 'medium'
      },
      body: 'Old rule body'
    });

    // 2. Create newer trap superseding trap-v1
    const res2 = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-v2',
      frontmatter: {
        id: 'trap-v2',
        title: 'Updated Trap Rule',
        severity: 'high',
        supersedes: 'trap-v1'
      },
      body: 'New rule body'
    });

    assert.equal(res2.superseded, true);

    // Verify older record status updated to superseded
    const older = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-v1'
    });
    assert.ok(older);
    assert.equal(older.frontmatter.status, 'superseded');

    // Verify newer record is active
    const newer = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-v2'
    });
    assert.ok(newer);
    assert.equal(newer.frontmatter.status, 'active');
  });

  it('should upsert and retrieve all record kinds (spec, plan, state, log, scratch, review)', async () => {
    const kinds: Array<{ kind: 'spec' | 'plan' | 'state' | 'log' | 'scratch' | 'review'; id: string; title: string }> = [
      { kind: 'spec', id: 'spec-auth', title: 'OAuth2 Authentication Specification' },
      { kind: 'plan', id: 'plan-auth-phase1', title: 'Phase 1 Delivery Plan' },
      { kind: 'state', id: 'state-session', title: 'Live Agent Session State' },
      { kind: 'log', id: 'log-bootstrap-01', title: 'Session Bootstrap Audit' },
      { kind: 'scratch', id: 'scratch-experiments', title: 'Temporary Scratch Notes' },
      { kind: 'review', id: 'review-pr-42', title: 'Pre-Merge Adversarial Review' }
    ];

    for (const item of kinds) {
      const res = await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: item.kind,
        slug: item.id,
        frontmatter: {
          id: item.id,
          title: item.title,
          status: 'active'
        },
        body: `Content for ${item.kind}: ${item.title}`
      });

      assert.equal(res.id, item.id);
      assert.equal(res.kind, item.kind);
      assert.ok(fs.existsSync(res.path));

      const retrieved = await getRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        id: item.id
      });
      assert.ok(retrieved, `Failed to retrieve record for kind ${item.kind}`);
      assert.equal(retrieved.frontmatter.id, item.id);
      assert.equal(retrieved.frontmatter.kind, item.kind);
    }
  });

  it('should append sequential event records without rewriting previous events', async () => {
    const { appendEvent } = await import('./store.js');

    const ev1 = await appendEvent({
      cwd: tempProject,
      vaultRoot: tempVault,
      event: 'Initial session start event',
      details: { step: 1 }
    });

    const ev2 = await appendEvent({
      cwd: tempProject,
      vaultRoot: tempVault,
      event: 'Secondary checkpoint completed',
      details: { step: 2 }
    });

    assert.notEqual(ev1.id, ev2.id);
    assert.ok(fs.existsSync(ev1.path));
    assert.ok(fs.existsSync(ev2.path));

    const content1 = fs.readFileSync(ev1.path, 'utf8');
    const content2 = fs.readFileSync(ev2.path, 'utf8');

    assert.ok(content1.includes('Initial session start event'));
    assert.ok(content2.includes('Secondary checkpoint completed'));
  });

  it('should archive record on forget by default and permanently delete with purge flag', async () => {
    const { forgetRecord } = await import('./store.js');

    // 1. Create a trap
    const trap = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'forget-target-trap',
      frontmatter: {
        id: 'trap-forget-target',
        title: 'Trap to be forgotten'
      },
      body: 'Body of target trap'
    });

    // 2. Default forget (soft archive)
    const archiveRes = await forgetRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-forget-target'
    });

    assert.equal(archiveRes.id, 'trap-forget-target');
    assert.equal(archiveRes.status, 'archived');
    assert.equal(archiveRes.purged, false);
    assert.ok(fs.existsSync(trap.path), 'File should still exist on disk after archive');

    const archivedRecord = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-forget-target'
    });
    assert.ok(archivedRecord);
    assert.equal(archivedRecord.frontmatter.status, 'archived');

    // 3. Purge forget (hard delete)
    const purgeRes = await forgetRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-forget-target',
      purge: true
    });

    assert.equal(purgeRes.id, 'trap-forget-target');
    assert.equal(purgeRes.status, 'purged');
    assert.equal(purgeRes.purged, true);
    assert.ok(!fs.existsSync(trap.path), 'File should be deleted on purge');

    const purgedRecord = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-forget-target'
    });
    assert.equal(purgedRecord, null);
  });

  it('should automatically detect duplicate trap and set supersedes status when >70% token overlap', async () => {
    // 1. Create first trap
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-raw-sql',
      frontmatter: {
        id: 'trap-no-raw-sql',
        title: 'Prevent Raw SQL Queries',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL strings in database handlers.\n\n## INSTEAD DO\nUse parameterized queries.'
    });

    // 2. Upsert similar evolutionary trap with same pathPatterns and overlapping body
    const res2 = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-raw-sql-v2',
      frontmatter: {
        id: 'trap-no-raw-sql-v2',
        title: 'Prevent Raw SQL Queries Updated',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL query strings directly.\n\n## INSTEAD DO\nUse parameterized query builders.'
    });

    assert.equal(res2.superseded, true);

    const oldTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-raw-sql'
    });
    assert.ok(oldTrap);
    assert.equal(oldTrap.frontmatter.status, 'superseded');

    const newTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-raw-sql-v2'
    });
    assert.ok(newTrap);
    assert.equal(newTrap.frontmatter.supersedes, 'trap-no-raw-sql');
    assert.equal(newTrap.frontmatter.status, 'active');
  });

  it('should not treat empty pathPatterns as a wildcard match against patterned traps', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'patterned-trap',
      frontmatter: {
        id: 'trap-patterned',
        title: 'Patterned Trap',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL strings in database handlers.\n\n## INSTEAD DO\nUse parameterized queries.'
    });

    const res2 = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'unpatterned-trap',
      frontmatter: {
        id: 'trap-unpatterned',
        title: 'Unpatterned Trap',
        pathPatterns: []
      },
      body: '## DO NOT\nNever execute raw unescaped SQL strings in database handlers.\n\n## INSTEAD DO\nUse parameterized queries.'
    });

    assert.equal(res2.superseded, false);
    const oldTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-patterned'
    });
    assert.ok(oldTrap);
    assert.equal(oldTrap.frontmatter.status, 'active');
  });
});

