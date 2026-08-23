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
});
