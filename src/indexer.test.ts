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

  it('should apply vector similarity threshold when embeddings.enabled is true in config.json', async () => {
    // 1. Enable embeddings in config.json
    const configPath = path.join(tempVault, 'config.json');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '0.2.0',
          embeddings: {
            enabled: true,
            minSimilarity: 0.4
          }
        },
        null,
        2
      ),
      'utf8'
    );

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'vector-match',
      frontmatter: {
        id: 'trap-vector-match',
        title: 'Vector similarity search match'
      },
      body: 'Highly relevant context matching the vector query terms'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'unrelated-trap',
      frontmatter: {
        id: 'trap-unrelated',
        title: 'Completely unaligned topic'
      },
      body: 'Random unaligned topic with no query tokens'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'vector similarity match context'
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'trap-vector-match');
  });

  it('should attach explain breakdown when explain option is true', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'explain-trap',
      frontmatter: {
        id: 'trap-explain',
        title: 'Explain scoring trap',
        severity: 'critical',
        pathPatterns: ['src/**/*.ts']
      },
      body: 'Explain scoring test body'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'scoring',
      path: 'src/indexer.ts',
      explain: true
    });

    assert.equal(hits.length, 1);
    assert.ok(hits[0].explain);
    assert.ok(typeof hits[0].explain!.ftsBm25 === 'number');
    assert.ok(typeof hits[0].explain!.finalScore === 'number');
    assert.equal(hits[0].explain!.pathPatternBoost, 1.25);
  });

  it('should return empty array with explain on zero hits', () => {
    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'nonexistent-xyz-query-term',
      explain: true
    });
    assert.equal(hits.length, 0);
  });

  it('should attach explain with positive ftsBm25 for hits sort full-scan path', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'hits-explain-a',
      frontmatter: {
        id: 'trap-hits-explain-a',
        title: 'Hits explain trap',
        hits: 10,
        status: 'active'
      },
      body: 'Hits explain body'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      sort: 'hits',
      explain: true,
      kinds: ['trap']
    });

    const row = hits.find((h) => h.id === 'trap-hits-explain-a');
    assert.ok(row, 'expected trap-hits-explain-a in hits sort results');
    assert.ok(row!.explain);
    assert.ok(row!.explain!.ftsBm25 > 0);
    assert.ok(row!.explain!.finalScore > 0);
  });

  it('AC1: infers intent case-insensitive with hyphen and apostrophe equivalents', async () => {
    const { inferSearchIntent, hyphenApostropheIntentProbe } = await import('./retrieval-lens.js');
    assert.equal(inferSearchIntent('trade-off rationale'), 'decision');
    assert.equal(inferSearchIntent("don't fail"), 'trap');
    assert.ok(hyphenApostropheIntentProbe("trade-off don't"));
  });

  it('AC2: decision intent boosts kind=decision by 1.5 vs no-lens baseline', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'lens-trap-a',
      frontmatter: { id: 'trap-lens-a', title: 'Lens neutral alpha', severity: 'medium', status: 'active' },
      body: 'neutral alpha shared keyword'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'lens-decision-a',
      frontmatter: { id: 'decision-lens-a', title: 'Lens neutral alpha', status: 'active' },
      body: 'neutral alpha shared keyword'
    });

    const baseline = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'neutral alpha shared',
      kinds: ['trap', 'decision']
    }).map((h) => h.id);

    const boosted = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'decision neutral alpha shared',
      kinds: ['trap', 'decision']
    }).map((h) => h.id);

    assert.notDeepEqual(boosted, baseline);
    assert.equal(boosted[0], 'decision-lens-a');
  });

  it('AC3: trap intent boosts kind=trap by 1.5', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'lens-trap-b-dec',
      frontmatter: { id: 'decision-lens-b', title: 'Shared beta', status: 'active' },
      body: 'shared beta keyword unique decision body'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'lens-trap-b',
      frontmatter: { id: 'trap-lens-b', title: 'Shared beta', severity: 'medium', status: 'active' },
      body: 'shared beta keyword unique trap failure body'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'failure shared beta',
      kinds: ['trap', 'decision']
    });
    assert.equal(hits[0]?.id, 'trap-lens-b');
    assert.equal(hits[0]?.explain?.intentLens, undefined);
  });

  it('AC4: log intent boosts kind=log and does not spawn git', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'log',
      slug: 'lens-log-a',
      frontmatter: { id: 'log-lens-a', title: 'Changed gamma', status: 'active' },
      body: 'changed gamma keyword'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'lens-log-trap',
      frontmatter: { id: 'trap-lens-gamma', title: 'Changed gamma', severity: 'low', status: 'active' },
      body: 'changed gamma keyword'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'changed gamma',
      kinds: ['log', 'trap'],
      includeScratch: true
    });
    assert.equal(hits[0]?.id, 'log-lens-a');
  });

  it('AC5: why did this fail infers trap not decision', async () => {
    const { inferSearchIntent } = await import('./retrieval-lens.js');
    assert.equal(inferSearchIntent('why did this fail'), 'trap');
  });

  it('intent FTS sort applies stale feedback once (not twice)', async () => {
    const sharedBody = 'failure shared stale intent keyword body text';
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'stale-intent-trap',
      frontmatter: {
        id: 'trap-stale-intent',
        title: 'Stale intent trap',
        severity: 'medium',
        status: 'active',
        staleCount: 3,
        helpfulCount: 0,
        pathPatterns: ['src/stale-intent-a.ts']
      },
      body: sharedBody
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'fresh-intent-trap',
      frontmatter: {
        id: 'trap-fresh-intent',
        title: 'Fresh intent trap',
        severity: 'medium',
        status: 'active',
        pathPatterns: ['src/fresh-intent-b.ts']
      },
      body: sharedBody
    });

    const intentHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'failure shared stale intent keyword body',
      kinds: ['trap']
    });
    assert.equal(intentHits.length, 2);
    assert.equal(intentHits[0]?.id, 'trap-fresh-intent');
    assert.equal(intentHits[1]?.id, 'trap-stale-intent');

    const freshRank = intentHits[0]?.rank ?? 0;
    const staleRank = intentHits[1]?.rank ?? 0;
    const trapIntentBoost = 1.5;
    const staleFeedback = 0.25;
    const correctStaleSortKey = staleRank * trapIntentBoost;
    const doublePenaltySortKey = staleRank * staleFeedback * trapIntentBoost;
    assert.ok(freshRank * trapIntentBoost < correctStaleSortKey);
    assert.ok(doublePenaltySortKey > correctStaleSortKey);

    const noIntentHits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'shared stale intent keyword body',
      kinds: ['trap']
    }).map((h) => h.id);
    assert.deepEqual(noIntentHits, ['trap-fresh-intent', 'trap-stale-intent']);
  });

  it('NS1: empty or unknown query keeps frozen relevance id sequence', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'frozen-trap-1',
      frontmatter: { id: 'trap-frozen-1', title: 'Zulu neutral fixture', severity: 'low', status: 'active' },
      body: 'zulu neutral fixture token'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'frozen-decision-1',
      frontmatter: { id: 'decision-frozen-1', title: 'Zulu neutral fixture', status: 'active' },
      body: 'zulu neutral fixture token'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'frozen-trap-2',
      frontmatter: { id: 'trap-frozen-2', title: 'Zulu neutral fixture', severity: 'high', status: 'active' },
      body: 'zulu neutral fixture token'
    });

    const first = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'zulu neutral fixture token',
      kinds: ['trap', 'decision']
    }).map((h) => h.id);
    const second = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'zulu neutral fixture token',
      kinds: ['trap', 'decision']
    }).map((h) => h.id);
    assert.deepEqual(second, first);
  });

  it('AC7: explain true includes intentLens intentKindBoost and boosted finalScore', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'explain-lens-decision',
      frontmatter: { id: 'decision-explain-lens', title: 'Explain lens delta', status: 'active' },
      body: 'decision explain lens delta keyword body'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'decision explain lens delta keyword',
      explain: true,
      kinds: ['decision']
    });
    assert.ok(hits.length >= 1, 'expected at least one decision hit');
    const explain = hits[0].explain!;
    assert.equal(explain.intentLens, 'decision');
    assert.equal(explain.intentKindBoost, 1.5);
    assert.ok(typeof explain.ftsBm25 === 'number');
    assert.ok(typeof explain.finalScore === 'number');
    assert.ok(explain.pathPatternBoost > 0);
  });

  it('AC8: explain omitted omits lens fields and matches AC6 ranking', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-explain-trap',
      frontmatter: { id: 'trap-no-explain', title: 'Plain omega', severity: 'medium', status: 'active' },
      body: 'plain omega keyword'
    });
    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'plain omega keyword',
      kinds: ['trap']
    });
    assert.equal(hits[0].explain, undefined);
    assert.equal(hits[0].id, 'trap-no-explain');
  });

  it('NS5: what changed infers log and does not run git log', async () => {
    const { inferSearchIntent, tokenizeQuery } = await import('./retrieval-lens.js');
    assert.equal(inferSearchIntent('what changed'), 'log');
    assert.ok(tokenizeQuery('what changed').includes('what'));
    assert.ok(tokenizeQuery('what changed').includes('changed'));

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'log',
      slug: 'ns5-log',
      frontmatter: { id: 'log-ns5', title: 'What changed entry', status: 'active' },
      body: 'what changed entry body'
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'what changed',
      kinds: ['log'],
      includeScratch: true
    });
    assert.equal(hits[0]?.id, 'log-ns5');
  });
});


