import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateFrontmatter } from './schema.js';
import { upsertRecord, getRecord } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';
import { executeTool } from './tools.js';
import { runCli } from './cli.js';
import { TOOL_NAMES } from './types.js';
import {
  recordMemoryHits,
  resetMemoryHitSessionsForTests,
  hitCountOf,
  listMemoryRecords,
  setMemoryHitWriteFileForTests
} from './hits.js';
import { generateTrapsView, scanProjectRecords } from './compiler.js';
import { generateProjectGraph, generateCanvasHtml } from './canvas.js';
import { readErrorLogs } from './error-logger.js';
import { getProjectMetadata, ensureVaultStructure } from './vault.js';
import { resolveProjectIdentity } from './identity.js';

const TRAP_BODY = `### Hit trap
- **Layer**: Application
- **Module**: Hits
- **DO NOT**: Ignore retrieval usefulness.
- **INSTEAD DO**: Pass hitIds when a search row was used.
`;

function baseFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trap-hit-schema',
    kind: 'trap' as const,
    project: 'proj-1',
    status: 'active' as const,
    created: '2026-09-02T12:00:00.000Z',
    updated: '2026-09-02T12:00:00.000Z',
    source: 'agent' as const,
    ...overrides
  };
}

describe('Memory retrieval hit count', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-hits-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-hits-proj-'));
    fs.mkdirSync(path.join(tempProject, '.git'), { recursive: true });
    ensureVaultStructure(tempVault);
    resetMemoryHitSessionsForTests();
  });

  afterEach(() => {
    closeIndex(tempVault);
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('AC1-AC3: schema accepts hits >= 0 and lastHit ISO; AC2 rejects negative hits', () => {
    const ok = validateFrontmatter(
      baseFrontmatter({ hits: 0, lastHit: '2026-09-02T12:00:00.000Z' })
    );
    assert.equal(ok.success, true);

    const ok2 = validateFrontmatter(baseFrontmatter({ hits: 3 }));
    assert.equal(ok2.success, true);

    const bad = validateFrontmatter(baseFrontmatter({ hits: -1 }));
    assert.equal(bad.success, false);
  });

  it('AC4: new records omit hits and lastHit until first hit', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-hits-yet',
      frontmatter: { id: 'trap-no-hits-yet', title: 'No hits yet', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: res.id });
    assert.ok(record);
    assert.equal(record.frontmatter.hits, undefined);
    assert.equal(record.frontmatter.lastHit, undefined);
    const raw = fs.readFileSync(record.path!, 'utf8');
    assert.ok(!/^hits:/m.test(raw));
    assert.ok(!/^lastHit:/m.test(raw));
  });

  it('AC5: search treats missing hits as 0 without rewriting file', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'missing-hits',
      frontmatter: { id: 'trap-missing-hits', title: 'Missing hits', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      query: 'Missing',
      kinds: ['trap']
    });
    const row = hits.find((h) => h.id === res.id);
    assert.ok(row);
    assert.equal(row.hits, 0);
    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: res.id });
    assert.equal(record!.frontmatter.hits, undefined);
  });

  it('AC6: recording a hit increments hits and lastHit without touching occurrences/lastSeen', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'bump-hit',
      frontmatter: {
        id: 'trap-bump-hit',
        title: 'Bump hit',
        pathPatterns: ['src/**'],
        occurrences: 2,
        lastSeen: '2026-08-01T00:00:00.000Z'
      },
      body: TRAP_BODY
    });
    const before = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: res.id });
    assert.equal(before!.frontmatter.occurrences, 2);

    await recordMemoryHits({
      ids: [res.id],
      source: 'get',
      cwd: tempProject,
      vaultRoot: tempVault
    });

    const after = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: res.id });
    assert.equal(after!.frontmatter.hits, 1);
    assert.ok(after!.frontmatter.lastHit);
    assert.equal(after!.frontmatter.occurrences, 2);
    assert.equal(after!.frontmatter.lastSeen, '2026-08-01T00:00:00.000Z');
  });

  it('AC7: recurrence bump does not change hits/lastHit', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'recur-hit',
      frontmatter: {
        id: 'trap-recur-hit',
        title: 'Recur hit',
        pathPatterns: ['src/foo.ts'],
        hits: 5,
        lastHit: '2026-09-01T00:00:00.000Z'
      },
      body: TRAP_BODY
    });

    const again = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      frontmatter: {
        title: 'Recur hit twin',
        pathPatterns: ['src/foo.ts']
      },
      body: TRAP_BODY
    });
    assert.equal(again.recurrence, true);

    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-recur-hit' });
    assert.ok(record);
    assert.equal(record.frontmatter.hits, 5);
    assert.equal(record.frontmatter.lastHit, '2026-09-01T00:00:00.000Z');
    assert.ok((record.frontmatter.occurrences as number) >= 2);
  });

  it('AC8: same-id upsert edit does not increment hits', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'edit-hit',
      frontmatter: { id: 'trap-edit-hit', title: 'Edit', pathPatterns: ['src/**'], hits: 2 },
      body: TRAP_BODY
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'edit-hit',
      frontmatter: { id: 'trap-edit-hit', title: 'Edit updated', pathPatterns: ['src/**'], hits: 2 },
      body: TRAP_BODY + '\nextra'
    });
    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-edit-hit' });
    assert.equal(record!.frontmatter.hits, 2);
  });

  it('AC9: get of scratch does not increment; eligible kinds do', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'scratch-1',
      frontmatter: { id: 'scratch-1', title: 'Scratch' },
      body: 'temp notes'
    });
    const scratchGet = await executeTool('get', {
      id: 'scratch-1',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    assert.equal(scratchGet.isError, undefined);
    const scratch = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'scratch-1' });
    assert.equal(scratch!.frontmatter.hits, undefined);

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'eligible',
      frontmatter: { id: 'trap-eligible', title: 'Eligible', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    const trapGet = await executeTool('get', {
      id: 'trap-eligible',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    assert.equal(trapGet.isError, undefined);
    const trap = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-eligible' });
    assert.equal(trap!.frontmatter.hits, 1);
  });

  it('AC10-AC11: bootstrap increments included traps; budget-dropped records do not', async () => {
    for (let i = 1; i <= 20; i++) {
      const severity = i <= 3 ? 'critical' : i <= 8 ? 'high' : i <= 14 ? 'medium' : 'low';
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug: `hit-batch-${i}`,
        allowDuplicate: true,
        frontmatter: {
          id: `trap-hit-batch-${String(i).padStart(2, '0')}`,
          title: `Hit batch trap #${i} with detailed description`,
          severity,
          pathPatterns: [`src/batch-${i}/**`]
        },
        body: `${TRAP_BODY}\n## Details for trap #${i}\nExtensive context to consume bootstrap budget bytes for item ${i}.`
      });
    }

    const brief = await executeTool('bootstrap', {
      cwd: tempProject,
      vaultRoot: tempVault,
      maxBytes: 3000
    });
    assert.equal(brief.isError, undefined);
    const data = brief.data as {
      traps: Array<{ frontmatter: { id: string } }>;
      truncated: boolean;
      totalTrapsCount: number;
    };
    assert.equal(data.truncated, true);
    assert.ok(data.traps.length < data.totalTrapsCount);
    const included = new Set(data.traps.map((t) => t.frontmatter.id));
    assert.ok(included.size >= 1);

    for (let i = 1; i <= 20; i++) {
      const id = `trap-hit-batch-${String(i).padStart(2, '0')}`;
      const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id });
      assert.ok(record);
      if (included.has(id)) {
        assert.equal(record.frontmatter.hits, 1, `${id} was in brief and should have hits=1`);
      } else {
        assert.equal(
          record.frontmatter.hits,
          undefined,
          `${id} was dropped by budget and must not receive a hit`
        );
      }
    }
  });

  it('AC12-AC13: successful get increments; failed get does not', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'dec-1',
      frontmatter: { id: 'decision-dec-1', title: 'Decide' },
      body: 'We decided hits matter.'
    });
    const ok = await executeTool('get', {
      id: 'decision-dec-1',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    assert.equal(ok.isError, undefined);
    const after = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'decision-dec-1' });
    assert.equal(after!.frontmatter.hits, 1);

    const missing = await executeTool('get', {
      id: 'missing-id-xyz',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    assert.equal(missing.isError, true);
  });

  it('AC14-AC17: bare search does not bump; hitIds bumps only listed eligible ids', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'a',
      allowDuplicate: true,
      frontmatter: { id: 'trap-a', title: 'Alpha search', pathPatterns: ['src/a/**'] },
      body: TRAP_BODY + '\nAlpha unique body'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'b',
      allowDuplicate: true,
      frontmatter: { id: 'trap-b', title: 'Beta search', pathPatterns: ['src/b/**'] },
      body: TRAP_BODY + '\nBeta unique body'
    });

    const bare = await executeTool('search', {
      query: 'search',
      cwd: tempProject,
      vaultRoot: tempVault,
      kinds: ['trap'],
      sort: 'hits'
    });
    assert.equal(bare.isError, undefined);
    const a0 = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-a' });
    assert.ok(a0);
    assert.equal(a0.frontmatter.hits, undefined);

    const withHits = await executeTool('search', {
      query: 'search',
      cwd: tempProject,
      vaultRoot: tempVault,
      kinds: ['trap'],
      hitIds: ['trap-a', 'unknown-id']
    });
    assert.equal(withHits.isError, undefined);
    const a1 = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-a' });
    const b1 = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-b' });
    assert.ok(a1);
    assert.ok(b1);
    assert.equal(a1.frontmatter.hits, 1);
    assert.equal(b1.frontmatter.hits, undefined);
  });

  it('AC18: CLI memo search --hit-ids maps to hitIds', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'cli-hit',
      allowDuplicate: true,
      frontmatter: { id: 'trap-cli-hit', title: 'CLI hit', pathPatterns: ['src/cli/**'] },
      body: TRAP_BODY + '\nCLI unique'
    });
    const code = await runCli([
      'search',
      'CLI',
      '--hit-ids',
      'trap-cli-hit',
      '--json',
      '--cwd',
      tempProject,
      '--vaultRoot',
      tempVault
    ]);
    assert.equal(code, 0);
    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-cli-hit' });
    assert.equal(record!.frontmatter.hits, 1);
  });

  it('AC19-AC21: sessionId de-dupes bootstrap then get', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'sess',
      frontmatter: {
        id: 'trap-sess',
        title: 'Session trap',
        severity: 'critical',
        pathPatterns: ['src/**']
      },
      body: TRAP_BODY
    });

    const sessionId = 'sess-hit-1';
    await executeTool('bootstrap', {
      cwd: tempProject,
      vaultRoot: tempVault,
      sessionId
    });
    const afterBoot = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-sess' });
    assert.equal(afterBoot!.frontmatter.hits, 1);

    await executeTool('get', {
      id: 'trap-sess',
      cwd: tempProject,
      vaultRoot: tempVault,
      sessionId
    });
    const afterGet = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-sess' });
    assert.equal(afterGet!.frontmatter.hits, 1);

    await executeTool('get', {
      id: 'trap-sess',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    const noSession = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-sess' });
    assert.equal(noSession!.frontmatter.hits, 2);
  });

  it('AC19: session de-dupe persists across in-memory cache clear (process restart)', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'persist-sess',
      frontmatter: {
        id: 'trap-persist-sess',
        title: 'Persist session',
        severity: 'critical',
        pathPatterns: ['src/**']
      },
      body: TRAP_BODY
    });

    const sessionId = 'sess-persist-1';
    await recordMemoryHits({
      ids: ['trap-persist-sess'],
      sessionId,
      source: 'get',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    const afterFirst = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-persist-sess'
    });
    assert.equal(afterFirst!.frontmatter.hits, 1);

    const sessionFile = path.join(tempVault, '.sync', 'memory-hit-sessions.json');
    assert.ok(fs.existsSync(sessionFile), 'expected persisted session hit file');
    const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as {
      sessions: Record<string, { ids: string[] }>;
    };
    assert.ok(persisted.sessions[sessionId]?.ids.includes('trap-persist-sess'));

    // Simulate MCP/CLI process restart: drop in-memory Map, keep vault file.
    resetMemoryHitSessionsForTests();

    await recordMemoryHits({
      ids: ['trap-persist-sess'],
      sessionId,
      source: 'get',
      cwd: tempProject,
      vaultRoot: tempVault
    });
    const afterRestart = await getRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-persist-sess'
    });
    assert.equal(afterRestart!.frontmatter.hits, 1, 'disk-backed session must de-dupe across restarts');
  });

  it('crossProject search hitIds resolve records in other vault projects', async () => {
    const tempProj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-hits-proj2-'));
    fs.mkdirSync(path.join(tempProj2, '.git'), { recursive: true });
    try {
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug: 'local-trap',
        allowDuplicate: true,
        frontmatter: {
          id: 'trap-cross-local',
          title: 'Cross local',
          pathPatterns: ['src/local/**']
        },
        body: TRAP_BODY + '\nCrossProject unique local'
      });
      await upsertRecord({
        cwd: tempProj2,
        vaultRoot: tempVault,
        kind: 'trap',
        slug: 'remote-trap',
        allowDuplicate: true,
        frontmatter: {
          id: 'trap-cross-remote',
          title: 'Cross remote',
          pathPatterns: ['src/remote/**']
        },
        body: TRAP_BODY + '\nCrossProject unique remote'
      });

      const identity1 = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
      const identity2 = resolveProjectIdentity(tempProj2, { vaultRoot: tempVault });
      assert.notEqual(identity1.projectId, identity2.projectId);

      const res = await executeTool('search', {
        query: 'CrossProject',
        cwd: tempProject,
        vaultRoot: tempVault,
        crossProject: true,
        kinds: ['trap'],
        hitIds: ['trap-cross-remote']
      });
      assert.equal(res.isError, undefined);
      const hits = res.data as Array<{ id: string; projectId: string }>;
      assert.ok(hits.some((h) => h.id === 'trap-cross-remote'));

      const remote = await getRecord({
        cwd: tempProj2,
        vaultRoot: tempVault,
        id: 'trap-cross-remote'
      });
      assert.ok(remote);
      assert.equal(remote.frontmatter.hits, 1, 'cross-project hitId must bump foreign project record');

      const local = await getRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        id: 'trap-cross-local'
      });
      assert.equal(local!.frontmatter.hits, undefined);
    } finally {
      fs.rmSync(tempProj2, { recursive: true, force: true });
    }
  });

  it('AC22: hit persistence failures are fail-open with subsystem memory-hits', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'fail-open',
      allowDuplicate: true,
      frontmatter: { id: 'trap-fail-open', title: 'Fail open', pathPatterns: ['src/fail/**'] },
      body: TRAP_BODY + '\nFail-open unique'
    });

    setMemoryHitWriteFileForTests((() => {
      throw new Error('injected memory-hits write failure');
    }) as typeof fs.writeFileSync);

    try {
      const searchRes = await executeTool('search', {
        query: 'Fail',
        cwd: tempProject,
        vaultRoot: tempVault,
        hitIds: ['trap-fail-open']
      });
      assert.equal(searchRes.isError, undefined);

      const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-fail-open' });
      assert.ok(record);
      assert.equal(record.frontmatter.hits, undefined);

      const logs = readErrorLogs(tempVault);
      assert.ok(
        logs.includes('memory-hits') || logs.includes('injected memory-hits write failure'),
        'expected memory-hits error log entry'
      );
    } finally {
      setMemoryHitWriteFileForTests(null);
    }
  });

  it('AC24-AC27: sort=hits orders correctly; invalid sort fails; payloads include hits/lastHit', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'low-hits',
      allowDuplicate: true,
      frontmatter: {
        id: 'trap-low-hits',
        title: 'LowHits',
        pathPatterns: ['src/low-hits/**'],
        hits: 1,
        lastHit: '2026-09-01T00:00:00.000Z'
      },
      body: TRAP_BODY + '\nLowHits unique'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'high-hits',
      allowDuplicate: true,
      frontmatter: {
        id: 'trap-high-hits',
        title: 'HighHits',
        pathPatterns: ['src/high-hits/**'],
        hits: 9,
        lastHit: '2026-09-02T00:00:00.000Z'
      },
      body: TRAP_BODY + '\nHighHits unique'
    });

    const ranked = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      sort: 'hits',
      kinds: ['trap'],
      status: 'active'
    });
    assert.ok(ranked.length >= 2);
    assert.equal(ranked[0].id, 'trap-high-hits');
    assert.equal(ranked[0].hits, 9);
    assert.ok(ranked[0].lastHit);

    const bad = await executeTool('search', {
      cwd: tempProject,
      vaultRoot: tempVault,
      sort: 'not-a-sort'
    });
    assert.equal(bad.isError, true);
  });

  it('AC34: compiled TRAPS.md includes Hits', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'compile-hits',
      frontmatter: {
        id: 'trap-compile-hits',
        title: 'Compile hits',
        pathPatterns: ['src/**'],
        hits: 4
      },
      body: TRAP_BODY
    });
    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const records = scanProjectRecords(path.join(tempVault, 'projects', identity.projectId));
    const traps = records.filter((r) => r.frontmatter.kind === 'trap');
    const meta = getProjectMetadata(identity.projectId, tempVault);
    const md = generateTrapsView(meta, traps);
    assert.ok(md.includes('**Hits:**'));
    assert.ok(md.includes('`4`'));
  });

  it('AC35-AC37: canvas graph nodes include hits; HTML detail shows Hits; TOOL_NAMES stays 11', () => {
    assert.equal(TOOL_NAMES.length, 11);
    assert.ok(!TOOL_NAMES.includes('hit' as never));

    const html = generateCanvasHtml();
    assert.ok(html.includes('Hits:'));
  });

  it('AC35: graph nodes include hits field', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'graph-hit',
      frontmatter: {
        id: 'trap-graph-hit',
        title: 'Graph',
        pathPatterns: ['src/**'],
        hits: 7
      },
      body: TRAP_BODY
    });
    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const graph = generateProjectGraph(tempVault, identity.projectId);
    const node = graph.nodes.find((n) => n.id === 'trap-graph-hit');
    assert.ok(node);
    assert.equal(node.hits, 7);
  });

  it('listMemoryRecords is read-only and returns hits', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'list-hit',
      frontmatter: {
        id: 'trap-list-hit',
        title: 'List',
        pathPatterns: ['src/**'],
        hits: 3
      },
      body: TRAP_BODY
    });
    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const before = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-list-hit' });
    const list = listMemoryRecords({
      vaultRoot: tempVault,
      projectId: identity.projectId,
      sort: 'hits'
    });
    assert.ok(list.some((r) => r.id === 'trap-list-hit' && r.hits === 3));
    for (let i = 0; i < 10; i++) {
      listMemoryRecords({ vaultRoot: tempVault, projectId: identity.projectId });
    }
    const after = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-list-hit' });
    assert.equal(after!.frontmatter.hits, before!.frontmatter.hits);
    assert.equal(hitCountOf({}), 0);
  });
});
