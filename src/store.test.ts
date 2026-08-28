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

  it('should automatically detect duplicate trap and bump occurrences when >70% token overlap', async () => {
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

    assert.equal(res2.recurrence, true);
    assert.equal(res2.id, 'trap-no-raw-sql');

    const oldTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-raw-sql'
    });
    assert.ok(oldTrap);
    assert.equal(oldTrap.frontmatter.status, 'active');
    assert.equal(oldTrap.frontmatter.occurrences, 2);

    const newTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-raw-sql-v2'
    });
    assert.equal(newTrap, null);
  });

  it('should reject secret-bearing duplicate traps before recurrence short-circuit', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-raw-sql-secret',
      frontmatter: {
        id: 'trap-no-raw-sql-secret',
        title: 'Prevent Raw SQL Queries',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL strings in database handlers.\n\n## INSTEAD DO\nUse parameterized queries.'
    });

    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    await assert.rejects(
      () =>
        upsertRecord({
          cwd: tempProject,
          vaultRoot: tempVault,
          kind: 'trap',
          slug: 'no-raw-sql-secret-v2',
          frontmatter: {
            id: 'trap-no-raw-sql-secret-v2',
            title: 'Prevent Raw SQL Queries Updated',
            pathPatterns: ['src/db/*.ts']
          },
          body: `## DO NOT\nNever execute raw unescaped SQL query strings directly.\n\n## INSTEAD DO\nUse parameterized query builders.\nkey=${awsKey}`
        }),
      /Safety violation: Secret detected/
    );

    const oldTrap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-no-raw-sql-secret'
    });
    assert.equal(oldTrap?.frontmatter.occurrences, 1);
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

  it('should not supersede itself when updating existing trap with frontmatter.id and omitting slug', async () => {
    // 1. Create initial trap
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-update-self',
      frontmatter: {
        id: 'trap-update-self',
        title: 'Initial Trap Title',
        pathPatterns: ['src/**/*.ts']
      },
      body: '## DO NOT\nOriginal instructions.'
    });

    // 2. Update same trap specifying frontmatter.id without options.slug
    const res2 = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      frontmatter: {
        id: 'trap-update-self',
        title: 'Updated Trap Title',
        pathPatterns: ['src/**/*.ts']
      },
      body: '## DO NOT\nOriginal instructions with minor edit.'
    });

    assert.equal(res2.superseded, false);
    const trap = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-update-self'
    });
    assert.ok(trap);
    assert.equal(trap.frontmatter.status, 'active');
    assert.equal(trap.frontmatter.supersedes, undefined);
  });

  it('should succeed when cwd is inside vaultRoot or vault has .git folder', async () => {
    // Initialize .git inside tempVault (simulating vaultGit)
    fs.mkdirSync(path.join(tempVault, '.git'), { recursive: true });

    // Upsert with cwd set to vaultRoot
    const res = await upsertRecord({
      cwd: tempVault,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'vault-cwd-trap',
      frontmatter: {
        id: 'vault-cwd-trap',
        title: 'Vault CWD Trap'
      },
      body: 'Body from inside vault'
    });

    assert.ok(res);
    assert.equal(res.id, 'vault-cwd-trap');
    assert.ok(fs.existsSync(res.path));

    // Get record with cwd in vault
    const rec = await getRecord({
      cwd: tempVault,
      vaultRoot: tempVault,
      id: 'vault-cwd-trap'
    });
    assert.ok(rec);
    assert.equal(rec.frontmatter.title, 'Vault CWD Trap');

    // Upsert with cwd inside a specific vault project directory
    const p1Dir = path.join(tempVault, 'projects', 'p1');
    fs.mkdirSync(p1Dir, { recursive: true });
    const p1Res = await upsertRecord({
      cwd: p1Dir,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'p1-trap',
      frontmatter: {
        id: 'p1-trap',
        title: 'P1 Trap'
      },
      body: 'Body inside p1 partition'
    });
    assert.ok(p1Res);
    assert.ok(p1Res.path.includes(path.join('projects', 'p1', 'traps')));
  });

  it('should normalize frontmatter.path into pathPatterns and linkedPaths', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'fm-path-trap',
      frontmatter: {
        id: 'fm-path-trap',
        title: 'Frontmatter Path Trap',
        path: 'src/modules/auth.ts'
      } as Record<string, unknown>,
      body: 'Trap body'
    });

    assert.ok(res);
    const rec = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'fm-path-trap'
    });

    assert.ok(rec);
    assert.deepEqual(rec.frontmatter.pathPatterns, ['src/modules/auth.ts']);
    assert.deepEqual(rec.frontmatter.linkedPaths, ['src/modules/auth.ts']);
    assert.equal(rec.frontmatter.path, undefined);
  });

  it('should accept uppercase and mixed case severity and normalize it to lowercase', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'case-trap',
      frontmatter: {
        id: 'trap-casing-test',
        title: 'Casing Test Trap',
        severity: 'High' as any
      },
      body: 'Trap body with High severity'
    });

    assert.ok(res);
    const rec = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-casing-test'
    });

    assert.ok(rec);
    assert.equal(rec.frontmatter.severity, 'high');
  });

  it('should retrieve record from sibling project when projectId is omitted in getRecord', async () => {
    // 1. Create a record in project A
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      projectId: 'project-alpha',
      kind: 'decision',
      slug: 'cross-project-decision',
      frontmatter: {
        id: 'dec-alpha-001',
        title: 'Project Alpha Architectural Decision'
      },
      body: 'Alpha architecture details'
    });

    // 2. Query from project B directory without explicit projectId
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-store-proj-b-'));
    try {
      const rec = await getRecord({
        cwd: otherProject,
        vaultRoot: tempVault,
        id: 'dec-alpha-001'
      });

      assert.ok(rec, 'Should find record in sibling project fallback');
      assert.equal(rec.frontmatter.id, 'dec-alpha-001');
      assert.equal(rec.frontmatter.project, 'project-alpha');
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it('should not retrieve ephemeral records (scratch, state, review) from sibling projects in getRecord fallback', async () => {
    // 1. Create ephemeral records in project A
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      projectId: 'project-alpha',
      kind: 'scratch',
      slug: 'temp-notes',
      frontmatter: {
        id: 'scratch-alpha-notes',
        title: 'Alpha Scratch Notes'
      },
      body: 'Temporary notes in Alpha'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      projectId: 'project-alpha',
      kind: 'state',
      slug: 'session-state',
      frontmatter: {
        id: 'state-alpha-session',
        title: 'Alpha Session State'
      },
      body: 'State in Alpha'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      projectId: 'project-alpha',
      kind: 'review',
      slug: 'pr-review',
      frontmatter: {
        id: 'review-alpha-pr',
        title: 'Alpha PR Review'
      },
      body: 'Review findings in Alpha'
    });

    // 2. Query from project B directory without explicit projectId
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-store-proj-b-'));
    try {
      const scratchRec = await getRecord({
        cwd: otherProject,
        vaultRoot: tempVault,
        id: 'scratch-alpha-notes'
      });
      assert.equal(scratchRec, null, 'Ephemeral scratch must not leak cross-project in getRecord');

      const stateRec = await getRecord({
        cwd: otherProject,
        vaultRoot: tempVault,
        id: 'state-alpha-session'
      });
      assert.equal(stateRec, null, 'Ephemeral state must not leak cross-project in getRecord');

      const reviewRec = await getRecord({
        cwd: otherProject,
        vaultRoot: tempVault,
        id: 'review-alpha-pr'
      });
      assert.equal(reviewRec, null, 'Ephemeral review must not leak cross-project in getRecord');
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });
});

