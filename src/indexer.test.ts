import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { upsertRecord } from './store.js';
import { searchIndex, rebuildIndex, closeIndex } from './indexer.js';

describe('SQLite FTS5 Indexer and Search Engine', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-fts-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-fts-proj-'));
  });

  afterEach(() => {
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('should index records on upsert and retrieve hits by keyword and phrase', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'sqlite-wal-locking',
      frontmatter: {
        id: 'trap-sqlite-wal',
        title: 'SQLite WAL mode prevents database locking issues',
        tags: ['sqlite', 'database', 'performance'],
        severity: 'high',
        pathPatterns: ['src/db/**/*.ts']
      },
      body: 'Always enable WAL mode in SQLite to support concurrent readers and avoid busy timeout errors.'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'adr-002-fts5',
      frontmatter: {
        id: 'adr-002',
        title: 'Adopt SQLite FTS5 for fast full text search',
        tags: ['architecture', 'search'],
        status: 'active'
      },
      body: 'FTS5 provides Porter stemmer tokenization and sub-millisecond query latency.'
    });

    // 1. Search by title keyword
    const hits1 = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'locking'
    });
    assert.equal(hits1.length, 1);
    assert.equal(hits1[0].id, 'trap-sqlite-wal');
    assert.equal(hits1[0].kind, 'trap');

    // 2. Search by body term
    const hits2 = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'latency'
    });
    assert.equal(hits2.length, 1);
    assert.equal(hits2[0].id, 'adr-002');
    assert.equal(hits2[0].kind, 'decision');

    // 3. Search by tag
    const hits3 = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'performance'
    });
    assert.equal(hits3.length, 1);
    assert.equal(hits3[0].id, 'trap-sqlite-wal');

    // 4. Search by phrase
    const hits4 = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: '"full text search"'
    });
    assert.equal(hits4.length, 1);
    assert.equal(hits4[0].id, 'adr-002');
  });

  it('should find traps matching file paths via pathPatterns', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'orm-leak',
      frontmatter: {
        id: 'trap-orm-leak',
        title: 'ORM connection leak trap',
        pathPatterns: ['src/db/**/*.ts', 'src/models/*.ts'],
        severity: 'critical'
      },
      body: 'Always release connections in finally block.'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ui-rerender',
      frontmatter: {
        id: 'trap-ui-rerender',
        title: 'Excessive UI re-render trap',
        pathPatterns: ['src/components/**/*.tsx'],
        severity: 'medium'
      },
      body: 'Use React.memo on heavy leaf components.'
    });

    // Search with path filter matching db pattern
    const dbHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      path: 'src/db/connection/pool.ts'
    });
    assert.equal(dbHits.length, 1);
    assert.equal(dbHits[0].id, 'trap-orm-leak');

    // Search with path filter matching component pattern
    const uiHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      path: 'src/components/Header.tsx'
    });
    assert.equal(uiHits.length, 1);
    assert.equal(uiHits[0].id, 'trap-ui-rerender');

    // Search with unmatched path
    const noneHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      path: 'docs/readme.md'
    });
    assert.equal(noneHits.length, 0);
  });

  it('should omit scratch records by default unless includeScratch is true', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'important-trap',
      frontmatter: {
        id: 'trap-important',
        title: 'Important production trap'
      },
      body: 'Production guideline details'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'debug-notes',
      frontmatter: {
        id: 'scratch-debug-notes',
        title: 'Temporary debugging notes'
      },
      body: 'Temporary scratchpad for experiment'
    });

    // Default search should NOT return scratch record
    const defaultHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'debugging'
    });
    assert.equal(defaultHits.length, 0);

    // Explicit includeScratch should return scratch record
    const scratchHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'debugging',
      includeScratch: true
    });
    assert.equal(scratchHits.length, 1);
    assert.equal(scratchHits[0].id, 'scratch-debug-notes');
    assert.equal(scratchHits[0].kind, 'scratch');
  });

  it('should support disposable index: deleting memo.sqlite and rebuilding restores identical hits', async () => {
    // 1. Populate multiple records
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-rebuild-1',
      frontmatter: {
        id: 'trap-rebuild-1',
        title: 'Disposable index test 1',
        pathPatterns: ['src/core/*.ts']
      },
      body: 'Content for index rebuild 1'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'decision-rebuild-2',
      frontmatter: {
        id: 'decision-rebuild-2',
        title: 'Disposable index test 2'
      },
      body: 'Content for index rebuild 2'
    });

    const initialHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'rebuild'
    });
    assert.equal(initialHits.length, 2);

    // 2. Delete memo.sqlite completely
    closeIndex();
    const sqlitePath = path.join(tempVault, 'memo.sqlite');
    const sqliteWal = path.join(tempVault, 'memo.sqlite-wal');
    const sqliteShm = path.join(tempVault, 'memo.sqlite-shm');
    if (fs.existsSync(sqlitePath)) fs.unlinkSync(sqlitePath);
    if (fs.existsSync(sqliteWal)) fs.unlinkSync(sqliteWal);
    if (fs.existsSync(sqliteShm)) fs.unlinkSync(sqliteShm);

    assert.ok(!fs.existsSync(sqlitePath), 'memo.sqlite should be deleted');

    // 3. Rebuild index from vault markdown sources
    const rebuildRes = await rebuildIndex(tempVault);
    assert.equal(rebuildRes.indexed, 2);
    assert.ok(fs.existsSync(sqlitePath), 'memo.sqlite should be recreated');

    // 4. Verify search results are identical
    const restoredHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'rebuild'
    });
    assert.equal(restoredHits.length, 2);
    assert.deepEqual(
      restoredHits.map((h) => h.id).sort(),
      initialHits.map((h) => h.id).sort()
    );
  });

  it('should return hits across multiple projects when crossProject option is true', async () => {
    const tempProj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-fts-proj2-'));
    try {
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug: 'proj1-trap',
        frontmatter: {
          id: 'trap-proj1',
          title: 'Project 1 trap'
        },
        body: 'Cross project test content in project 1'
      });

      await upsertRecord({
        cwd: tempProj2,
        vaultRoot: tempVault,
        kind: 'decision',
        slug: 'proj2-decision',
        frontmatter: {
          id: 'decision-proj2',
          title: 'Project 2 decision'
        },
        body: 'Cross project test content in project 2'
      });

      // Single project search returns only 1 hit
      const singleHits = searchIndex({
        cwd: tempProject,
        vaultRoot: tempVault,
        query: 'Cross'
      });
      assert.equal(singleHits.length, 1);
      assert.equal(singleHits[0].id, 'trap-proj1');

      // Cross project search returns hits from both projects
      const crossHits = searchIndex({
        cwd: tempProject,
        vaultRoot: tempVault,
        query: 'Cross',
        crossProject: true
      });
      assert.equal(crossHits.length, 2);
      const hitIds = crossHits.map((h) => h.id).sort();
      assert.deepEqual(hitIds, ['decision-proj2', 'trap-proj1']);
    } finally {
      fs.rmSync(tempProj2, { recursive: true, force: true });
    }
  });
});

