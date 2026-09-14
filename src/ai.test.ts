import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TOOL_NAMES, type MemoRecord } from './types.js';
import { upsertRecord, getRecord } from './store.js';
import { closeIndex, searchIndex } from './indexer.js';
import { runDoctor } from './doctor.js';
import { ensureVaultStructure } from './vault.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { NoopVaultAiAgent } from './ai/noop.js';
import { CursorSdkVaultAiAgent, buildCursorSdkPromptOptions } from './ai/cursor-sdk.js';
import { defaultAiConfig, parseAiConfig, resolveAiConfig } from './ai/config.js';
import { resolveVaultAiAgent } from './ai/index.js';
import { AiOpsJournaledAgent } from './ai/ops-log.js';
import { assertAiConfigValid } from './ai/index.js';
import {
  clearAiStateForTests,
  dropPendingRefineForRecord,
  enqueueRefineJob,
  getAiLastError,
  getAiQueueDepth
} from './ai/refine-queue.js';
import { searchIndexRanked } from './ai/search.js';
import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult
} from './ai/types.js';

class FakeVaultAiAgent implements VaultAiAgent {
  refineCalls: VaultAiRefineInput[] = [];
  rankCalls: VaultAiRankInput[] = [];
  refineDelayMs = 0;
  refineResult: VaultAiRefineResult = {
    ok: true,
    searchTerms: ['retrieval-aid-term'],
    summary: 'Fake retrieval summary.'
  };
  rankBehavior: 'identity' | 'reverse' | 'throw' | 'empty' = 'identity';
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  async refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult> {
    this.refineCalls.push(input);
    if (this.refineDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refineDelayMs));
    }
    return this.refineResult;
  }

  async rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult> {
    this.rankCalls.push(input);
    if (this.rankBehavior === 'throw') {
      throw new Error('fake rank failure');
    }
    if (this.rankBehavior === 'empty') {
      return { orderedIds: [] };
    }
    const ids = input.candidates.map((c) => c.id);
    if (this.rankBehavior === 'reverse') {
      return { orderedIds: [...ids].reverse() };
    }
    return { orderedIds: ids };
  }
}

async function waitForAids(
  vaultRoot: string,
  cwd: string,
  id: string,
  timeoutMs = 8000
): Promise<MemoRecord | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rec = await getRecord({ cwd, vaultRoot, id });
    if (rec && Array.isArray(rec.frontmatter.aiSearchTerms)) {
      return rec;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getRecord({ cwd, vaultRoot, id });
}

describe('Vault AI assistance (spec 0056)', () => {
  let tempVault: string;
  let tempProject: string;
  let savedCursorKey: string | undefined;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-ai-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-ai-proj-'));
    savedCursorKey = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    clearAiStateForTests();
  });

  afterEach(() => {
    if (savedCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedCursorKey;
    clearAiStateForTests();
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('AC6: MCP tool surface stays at 11 tools with no ai/refine/embed tool', () => {
    assert.equal(TOOL_NAMES.length, 11);
    assert.ok(!TOOL_NAMES.includes('ai' as never));
    assert.ok(!TOOL_NAMES.includes('refine' as never));
    assert.ok(!TOOL_NAMES.includes('embed' as never));
  });

  it('AC1/AC4: Noop agent is unavailable; startup resolves Noop when ai is omitted', () => {
    const noop = new NoopVaultAiAgent();
    assert.equal(noop.isAvailable(), false);
    const { agent, config } = resolveVaultAiAgent(tempVault);
    assert.ok(agent instanceof NoopVaultAiAgent);
    assert.equal(config.enabled, false);
  });

  it('AC4: enabled cursor-sdk resolves the Cursor adapter; unknown provider throws', () => {
    const { agent } = resolveVaultAiAgent(tempVault, {
      ...defaultAiConfig(),
      enabled: true,
      provider: 'cursor-sdk'
    });
    // Issue #66: runtime agent must be journal-wrapped at the choke point.
    assert.ok(agent instanceof AiOpsJournaledAgent);
    assert.ok(!(agent instanceof NoopVaultAiAgent));
    assert.throws(() =>
      resolveVaultAiAgent(tempVault, {
        ...defaultAiConfig(),
        enabled: true,
        provider: 'openai' as never
      })
    );
  });

  it('AC4: startup validation fails closed on unknown ai.provider in raw config.json', () => {
    ensureVaultStructure(tempVault);
    const configPath = path.join(tempVault, 'config.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    raw.ai = { enabled: true, provider: 'openai' };
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
    assert.throws(() => assertAiConfigValid(tempVault), /ai/);
    raw.ai = { enabled: true, provider: 'cursor-sdk' };
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
    const valid = assertAiConfigValid(tempVault);
    assert.equal(valid.enabled, true);
    assert.equal(valid.provider, 'cursor-sdk');
  });

  it('AC27: Zod ai defaults and unknown-provider rejection', () => {
    assert.equal(parseAiConfig(undefined), null);
    assert.equal(parseAiConfig(null), null);
    const defaults = resolveAiConfig({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.model, 'composer-2.5');
    assert.equal(defaults.apiKeyEnv, 'CURSOR_API_KEY');
    assert.equal(defaults.timeoutMs, 15000);
    assert.equal(defaults.rankTopK, 20);
    assert.throws(() => parseAiConfig({ enabled: true, provider: 'openai' }), /ai/);
    assert.throws(() => parseAiConfig('yes'), /ai/);
  });

  it('AC7/AC8: adapter option shape uses cloud no-repo runtime and never a vault cwd', () => {
    const config = { ...defaultAiConfig(), enabled: true };
    const opts = buildCursorSdkPromptOptions(config, 'test-key');
    assert.equal(opts.model.id, 'composer-2.5');
    assert.deepEqual(opts.cloud, { repos: [] });
    assert.ok(!('local' in opts));
    assert.ok(!('cwd' in opts));
    assert.ok(!JSON.stringify(opts).includes(tempVault));
    const custom = buildCursorSdkPromptOptions({ ...config, model: 'custom-model' }, 'k');
    assert.equal(custom.model.id, 'custom-model');
    const blank = buildCursorSdkPromptOptions({ ...config, model: '   ' }, 'k');
    assert.equal(blank.model.id, 'composer-2.5');
  });

  it('AC9/AC12: missing CURSOR_API_KEY means unavailable; upsert behaves as Noop', async () => {
    const agent = new CursorSdkVaultAiAgent({ ...defaultAiConfig(), enabled: true });
    assert.equal(agent.isAvailable(), false);
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-no-key',
      frontmatter: { id: 'ai-no-key', title: 'No key trap' },
      body: '## DO NOT\nSkip.\n\n## INSTEAD DO\nWait.',
      aiAgent: agent
    });
    assert.equal(res.id, 'ai-no-key');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(getAiQueueDepth(), 0);
    const rec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-no-key' });
    assert.ok(rec);
    assert.equal(rec.frontmatter.aiSearchTerms, undefined);
  });

  it('AC10/AC11: adapter timeout and non-JSON output fail open without network', async () => {
    const hanging = new CursorSdkVaultAiAgent(
      { ...defaultAiConfig(), enabled: true, timeoutMs: 40 },
      {
        promptFn: () => new Promise<{ result?: string }>(() => undefined)
      }
    );
    process.env.CURSOR_API_KEY = 'test-key';
    const timed = await hanging.refineForSearch({
      id: 'x',
      kind: 'trap',
      title: 't',
      body: 'b',
      tags: [],
      pathPatterns: []
    });
    assert.equal(timed.ok, false);

    const garbage = new CursorSdkVaultAiAgent(
      { ...defaultAiConfig(), enabled: true },
      { promptFn: () => Promise.resolve({ result: 'not json at all {{{' }) }
    );
    const bad = await garbage.refineForSearch({
      id: 'x',
      kind: 'trap',
      title: 't',
      body: 'b',
      tags: [],
      pathPatterns: []
    });
    assert.equal(bad.ok, false);

    const rankBad = await garbage.rankCandidates({
      query: 'q',
      candidates: [{ id: 'a', kind: 'trap', title: 't', snippet: 's' }]
    });
    assert.deepEqual(rankBad.orderedIds, ['a']);
  });

  it('AC13/AC15/AC17: fake agent DI writes retrieval aids only, body untouched', async () => {
    const fake = new FakeVaultAiAgent();
    const body = '## DO NOT\nDelete prod.\n\n## INSTEAD DO\nSnapshot first.';
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-refine-trap',
      frontmatter: { id: 'ai-refine-trap', title: 'Refine me' },
      body,
      aiAgent: fake
    });
    const refined = await waitForAids(tempVault, tempProject, 'ai-refine-trap');
    assert.ok(refined, 'expected background refine to persist aids');
    assert.deepEqual(refined.frontmatter.aiSearchTerms, ['retrieval-aid-term']);
    assert.equal(refined.frontmatter.summary, undefined);
    assert.equal(refined.frontmatter.aiSummary, 'Fake retrieval summary.');
    assert.equal(refined.body, body);
    assert.ok(typeof refined.frontmatter.aiRefineHash === 'string');

    // FTS document text includes the aids (Notes sidecar contract).
    const ftsHits = searchIndex({ vaultRoot: tempVault, cwd: tempProject, query: 'retrieval-aid-term' });
    assert.ok(ftsHits.some((h) => h.id === 'ai-refine-trap'));
  });

  it('AC13/AC14: upsert never awaits a slow agent and never floats a rejection', async () => {
    const fake = new FakeVaultAiAgent();
    fake.refineDelayMs = 400;
    let refineDone = false;
    const original = fake.refineForSearch.bind(fake);
    fake.refineForSearch = async (input) => {
      const out = await original(input);
      refineDone = true;
      return out;
    };
    const started = Date.now();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'ai-slow-decision',
      frontmatter: { id: 'ai-slow-decision', title: 'Slow refine' },
      body: 'Decision body with enough text to index.',
      aiAgent: fake
    });
    const elapsed = Date.now() - started;
    assert.equal(refineDone, false, 'upsert must resolve before the slow agent finishes');
    assert.ok(elapsed < 400, `upsert blocked on agent (${elapsed}ms)`);
    const refined = await waitForAids(tempVault, tempProject, 'ai-slow-decision');
    assert.ok(refined);
    assert.ok(refineDone);
  });

  it('AC18: ineligible kinds never enqueue refine', async () => {
    const fake = new FakeVaultAiAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'ai-scratch',
      frontmatter: { id: 'ai-scratch', title: 'Scratch note' },
      body: 'Temporary scratch content.',
      aiAgent: fake
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fake.refineCalls.length, 0);
    assert.equal(getAiQueueDepth(), 0);
  });

  it('AC19: forget drops the pending job for the record', async () => {
    const fake = new FakeVaultAiAgent();
    fake.refineDelayMs = 500;
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-drop-trap',
      frontmatter: { id: 'ai-drop-trap', title: 'Drop me' },
      body: '## DO NOT\nX.\n\n## INSTEAD DO\nY.',
      aiAgent: fake
    });
    dropPendingRefineForRecord('ai-drop-trap');
    assert.equal(getAiQueueDepth(), 0);
    assert.equal(getAiLastError(), null);
  });

  it('AC20/AC22: rank throw keeps lexical order and marks explain skipped', async () => {
    for (const [slug, title, body, pattern] of [
      ['ai-rank-alpha', 'Alpha adapter', 'alpha wibble quark', 'src/alpha.ts'],
      ['ai-rank-beta', 'Beta adapter', 'beta wibble quark', 'src/beta.ts'],
      ['ai-rank-gamma', 'Gamma adapter', 'gamma wibble quark', 'src/gamma.ts']
    ] as const) {
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug,
        frontmatter: { id: slug, title, pathPatterns: [pattern] },
        body: `Record about ${body}.`
      });
    }
    const lexical = searchIndex({
      vaultRoot: tempVault,
      cwd: tempProject,
      query: 'wibble quark',
      explain: true
    });
    assert.ok(lexical.length >= 3);
    const lexicalIds = lexical.map((h) => h.id);

    const throwing = new FakeVaultAiAgent();
    throwing.rankBehavior = 'throw';
    const failed = await searchIndexRanked(
      { vaultRoot: tempVault, cwd: tempProject, query: 'wibble quark', explain: true },
      { agent: throwing, rankTopK: 20 }
    );
    assert.deepEqual(failed.hits.map((h) => h.id), lexicalIds);
    assert.equal(failed.aiRank, 'skipped');
    for (const hit of failed.hits) {
      assert.equal(hit.explain?.aiRank, 'skipped');
    }

    const reverser = new FakeVaultAiAgent();
    reverser.rankBehavior = 'reverse';
    const ranked = await searchIndexRanked(
      { vaultRoot: tempVault, cwd: tempProject, query: 'wibble quark', explain: true },
      { agent: reverser, rankTopK: 3 }
    );
    assert.equal(ranked.aiRank, 'applied');
    assert.deepEqual(
      ranked.hits.slice(0, 3).map((h) => h.id),
      [...lexicalIds.slice(0, 3)].reverse()
    );
    assert.equal(ranked.hits[0].explain?.aiRank, 'applied');
  });

  it('AC23: bootstrap skips rank on empty query, ranks on query', async () => {
    const fake = new FakeVaultAiAgent();
    fake.rankBehavior = 'reverse';
    for (const [slug, title] of [
      ['ai-boot-one', 'Bootstrapping adapters'],
      ['ai-boot-two', 'Adapter bootstrap guide']
    ] as const) {
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug,
        frontmatter: { id: slug, title, severity: 'high' },
        body: `Bootstrap record about ${title.toLowerCase()} patterns.`
      });
    }
    await compileBootstrapBrief({ cwd: tempProject, vaultRoot: tempVault }, { agent: fake });
    assert.equal(fake.rankCalls.length, 0);
    await compileBootstrapBrief(
      { cwd: tempProject, vaultRoot: tempVault, query: 'adapter bootstrap' },
      { agent: fake, rankTopK: 20 }
    );
    assert.ok(fake.rankCalls.length >= 1);
  });

  it('AC25: get by id never calls the agent', async () => {
    const fake = new FakeVaultAiAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-get-trap',
      frontmatter: { id: 'ai-get-trap', title: 'Get trap' },
      body: '## DO NOT\nZ.\n\n## INSTEAD DO\nW.'
    });
    const rec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-get-trap' });
    assert.ok(rec);
    assert.equal(fake.refineCalls.length, 0);
    assert.equal(fake.rankCalls.length, 0);
  });

  it('AC28/AC32: doctor ai field present; setup merge preserves ai', async () => {
    const doctor = await runDoctor({ vaultRoot: tempVault, cwd: tempProject });
    assert.ok(doctor.ai);
    assert.equal(doctor.ai.enabled, false);
    assert.equal(doctor.ai.provider, 'cursor-sdk');
    assert.equal(doctor.ai.available, false);
    assert.equal(doctor.ai.queueDepth, 0);
    assert.equal(doctor.ai.lastError, null);

    const configPath = path.join(tempVault, 'config.json');
    ensureVaultStructure(tempVault);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    raw.ai = { enabled: true, provider: 'cursor-sdk', model: 'composer-2.5' };
    (raw.ttl as Record<string, number>).scratchDays = 9;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
    const merged = ensureVaultStructure(tempVault);
    assert.equal(merged.ai?.enabled, true);
    assert.equal(merged.ai?.provider, 'cursor-sdk');
    assert.equal(merged.ttl?.scratchDays, 9);
    const seeded = ensureVaultStructure(
      fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-ai-seed-'))
    );
    assert.equal(seeded.ai?.enabled, false);
  });

  it('AC31: secret-looking text is redacted before the SDK call', async () => {
    let seenPrompt = '';
    const agent = new CursorSdkVaultAiAgent(
      { ...defaultAiConfig(), enabled: true },
      {
        promptFn: (message) => {
          seenPrompt = message;
          return Promise.resolve({ result: '{"searchTerms": ["ok"], "summary": "s"}' });
        }
      }
    );
    process.env.CURSOR_API_KEY = 'test-key';
    const out = await agent.refineForSearch({
      id: 'sec',
      kind: 'trap',
      title: 'Bearer abcdefghijklmnopqrstuvwxyz123456 in title',
      body: 'note with Bearer abcdefghijklmnopqrstuvwxyz123456 trailing',
      tags: ['Bearer abcdefghijklmnopqrstuvwxyz123456'],
      pathPatterns: ['src/sec.ts']
    });
    assert.equal(out.ok, true);
    assert.ok(!seenPrompt.includes('Bearer abcdefghijklmnopqrstuvwxyz123456'));
    assert.ok(seenPrompt.includes('src/sec.ts'));
  });

  it('Review: forged caller aids are stripped; aids carry over only on unchanged body', async () => {
    // Forged aids with no agent running must not persist.
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-forged',
      frontmatter: {
        id: 'ai-forged',
        title: 'Forged aids',
        aiSearchTerms: ['forged-term'],
        aiSummary: 'Forged summary.',
        aiRefineHash: 'deadbeef'
      } as Record<string, unknown> as never,
      body: '## DO NOT\nForge.\n\n## INSTEAD DO\nEarn.',
      aiAgent: null
    });
    const forged = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-forged' });
    assert.ok(forged);
    assert.equal(forged.frontmatter.aiSearchTerms, undefined);
    assert.equal(forged.frontmatter.aiSummary, undefined);
    assert.equal(forged.frontmatter.aiRefineHash, undefined);

    // Genuine aids from the job carry over on a metadata-only upsert…
    const fake = new FakeVaultAiAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-carry',
      frontmatter: { id: 'ai-carry', title: 'Carry aids' },
      body: '## DO NOT\nLose.\n\n## INSTEAD DO\nKeep.',
      aiAgent: fake
    });
    const refined = await waitForAids(tempVault, tempProject, 'ai-carry');
    assert.ok(refined);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-carry',
      frontmatter: { id: 'ai-carry', title: 'Carry aids (retitled)' },
      body: '## DO NOT\nLose.\n\n## INSTEAD DO\nKeep.',
      aiAgent: null
    });
    const carried = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-carry' });
    assert.ok(carried);
    assert.deepEqual(carried.frontmatter.aiSearchTerms, ['retrieval-aid-term']);

    // …but a body edit clears them for regeneration.
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-carry',
      frontmatter: { id: 'ai-carry', title: 'Carry aids (retitled)' },
      body: '## DO NOT\nLose ever.\n\n## INSTEAD DO\nKeep always.',
      aiAgent: null
    });
    const cleared = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-carry' });
    assert.ok(cleared);
    assert.equal(cleared.frontmatter.aiSearchTerms, undefined);
    assert.equal(cleared.frontmatter.aiRefineHash, undefined);
  });

  it('Review: model-echoed secrets are never persisted as retrieval aids', async () => {
    const leaky = new FakeVaultAiAgent();
    leaky.refineResult = {
      ok: true,
      searchTerms: ['ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD'],
      summary: 'leaked sk_test_abcdefghijklmnopqrstuvwxyz1234 key'
    };
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-leaky',
      frontmatter: { id: 'ai-leaky', title: 'Leaky model' },
      body: '## DO NOT\nLeak.\n\n## INSTEAD DO\nRedact.',
      aiAgent: leaky
    });
    const start = Date.now();
    let rec: MemoRecord | null = null;
    while (Date.now() - start < 5000) {
      rec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-leaky' });
      if (getAiLastError() !== null || rec?.frontmatter.aiSearchTerms) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(rec);
    assert.equal(rec.frontmatter.aiSearchTerms, undefined);
    assert.ok(getAiLastError() !== null);
  });

  it('Review: maxConcurrent serializes bursts and the queue still drains', async () => {    const fake = new FakeVaultAiAgent();
    fake.refineDelayMs = 120;
    const slugs = ['ai-burst-one', 'ai-burst-two', 'ai-burst-three'];
    for (const slug of slugs) {
      const res = await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug,
        frontmatter: { id: slug, title: `Burst ${slug}`, pathPatterns: [`src/${slug}.ts`] },
        body: `## DO NOT\nBurst ${slug}.\n\n## INSTEAD DO\nSerialize ${slug}.`,
        aiAgent: fake
      });
      // Guard against trap-dedup collapsing the burst into a recurrence bump.
      assert.equal(res.recurrence, undefined);
    }
    for (const slug of slugs) {
      const refined = await waitForAids(tempVault, tempProject, slug);
      assert.ok(refined, `expected ${slug} to drain through the refine queue`);
    }
    assert.equal(getAiQueueDepth(), 0);
  });

  it('Review: a dropped generation never writes, even when a fresh job follows', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-drop-re',
      frontmatter: { id: 'ai-drop-re', title: 'Drop then re-enqueue' },
      body: '## DO NOT\nDrop.\n\n## INSTEAD DO\nRequeue.',
      aiAgent: null
    });
    const seed = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-drop-re' });
    assert.ok(seed?.path);
    const projectId = String(seed.frontmatter.project);

    let releaseG1!: () => void;
    const g1gate = new Promise<void>((resolve) => {
      releaseG1 = resolve;
    });
    const g1 = new FakeVaultAiAgent();
    g1.refineForSearch = async (input) => {
      g1.refineCalls.push(input);
      await g1gate;
      return { ok: true, searchTerms: ['g1-stale-terms'], summary: 'g1' };
    };
    const base = {
      vaultRoot: tempVault,
      projectId,
      filePath: seed.path,
      id: 'ai-drop-re',
      kind: 'trap' as const,
      title: 'Drop then re-enqueue',
      body: '## DO NOT\nDrop.\n\n## INSTEAD DO\nRequeue.',
      tags: [] as string[],
      pathPatterns: [] as string[],
      timeoutMs: 5000,
      maxConcurrent: 1
    };
    assert.equal(enqueueRefineJob({ ...base, agent: g1 }), true);
    // Forget while G1 awaits the slow agent, then re-enqueue a fresh job
    // that fails fast. G1 must observe the cancellation and write nothing.
    dropPendingRefineForRecord('ai-drop-re');
    const g2 = new FakeVaultAiAgent();
    g2.refineResult = { ok: false, error: 'g2 boom' };
    assert.equal(enqueueRefineJob({ ...base, agent: g2 }), true);
    releaseG1();

    const start = Date.now();
    while (getAiQueueDepth() > 0 && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getAiQueueDepth(), 0);
    assert.equal(g1.refineCalls.length, 1);
    assert.equal(g2.refineCalls.length, 1);
    const rec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-drop-re' });
    assert.ok(rec);
    assert.equal(rec.frontmatter.aiSearchTerms, undefined);
  });

  it('Review: dropping a waiting job evicts it before it ever runs', async () => {
    for (const slug of ['ai-slot-a', 'ai-slot-b']) {
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug,
        frontmatter: { id: slug, title: `Slot ${slug}`, pathPatterns: [`src/${slug}.ts`] },
        body: `## DO NOT\nSlot ${slug}.\n\n## INSTEAD DO\nWait ${slug}.`,
        aiAgent: null
      });
    }
    const recA = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-slot-a' });
    const recB = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-slot-b' });
    assert.ok(recA?.path && recB?.path);
    const projectId = String(recA.frontmatter.project);

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const slowA = new FakeVaultAiAgent();
    slowA.refineForSearch = async (input) => {
      slowA.refineCalls.push(input);
      await gateA;
      return { ok: true, searchTerms: ['slot-a-term'] };
    };
    const waiterB = new FakeVaultAiAgent();
    const mkArgs = (id: string, filePath: string) => ({
      vaultRoot: tempVault,
      projectId,
      filePath,
      id,
      kind: 'trap' as const,
      title: id,
      body: 'b',
      tags: [] as string[],
      pathPatterns: [] as string[],
      timeoutMs: 5000,
      maxConcurrent: 1
    });
    assert.equal(enqueueRefineJob({ ...mkArgs('ai-slot-a', recA.path), agent: slowA }), true);
    assert.equal(enqueueRefineJob({ ...mkArgs('ai-slot-b', recB.path), agent: waiterB }), true);
    dropPendingRefineForRecord('ai-slot-b');
    releaseA();

    const start = Date.now();
    while (getAiQueueDepth() > 0 && Date.now() - start < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(getAiQueueDepth(), 0);
    assert.equal(waiterB.refineCalls.length, 0);
    const doneA = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'ai-slot-a' });
    assert.deepEqual(doneA?.frontmatter.aiSearchTerms, ['slot-a-term']);
  });

  it('Review: oversized and duplicated terms are capped before persisting', async () => {
    const big = new FakeVaultAiAgent();
    big.refineResult = {
      ok: true,
      searchTerms: ['x'.repeat(3000), 'dup', 'dup', '  ok-term  '],
      summary: 's'
    };
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'ai-big-terms',
      frontmatter: { id: 'ai-big-terms', title: 'Big terms' },
      body: '## DO NOT\nBloat.\n\n## INSTEAD DO\nCap.',
      aiAgent: big
    });
    const refined = await waitForAids(tempVault, tempProject, 'ai-big-terms');
    assert.ok(refined);
    const terms = refined.frontmatter.aiSearchTerms;
    assert.ok(Array.isArray(terms));
    assert.ok(terms.length <= 20);
    for (const term of terms) {
      assert.ok(term.length <= 80, `term exceeds 80 chars (${term.length})`);
    }
    assert.equal(terms.filter((t) => t === 'dup').length, 1);
    assert.ok(terms.includes('ok-term'));
  });

  it('Review: timeoutMs is bounded (1000..120000)', () => {
    assert.throws(() => parseAiConfig({ timeoutMs: 500 }), /ai/);
    assert.throws(() => parseAiConfig({ timeoutMs: 200000 }), /ai/);
    assert.equal(parseAiConfig({ timeoutMs: 1000 })?.timeoutMs, 1000);
    assert.equal(parseAiConfig({ timeoutMs: 120000 })?.timeoutMs, 120000);
    assert.equal(parseAiConfig({}) === null, false);
  });
});
