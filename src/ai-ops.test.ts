import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TOOL_NAMES } from './types.js';
import { upsertRecord, getRecord } from './store.js';
import { closeIndex } from './indexer.js';
import { ensureVaultStructure } from './vault.js';
import { createActivityBus } from './activity.js';
import { REQUIRED_VAULT_GITIGNORE } from './vault.js';
import { generateStatusHtml, startStatusServer } from './status.js';
import { getPackageVersion } from './version.js';
import { NoopVaultAiAgent } from './ai/noop.js';
import { clearAiStateForTests, getAiQueueDepth } from './ai/refine-queue.js';
import { searchIndexRanked } from './ai/search.js';
import {
  recordAiOpsEvent,
  listAiOpsEntries,
  getAiOpsEntry,
  getAiOpsDir,
  resetAiOpsConfigCacheForTests,
  withAiOpsJournal,
  AiOpsJournaledAgent,
  resolveVaultAiAgent,
  truncateOpsPayloadToBudget,
  defaultAiConfig,
  isAiOpsLogEnabled
} from './ai/index.js';
import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult
} from './ai/types.js';

class FakeOpsAgent implements VaultAiAgent {
  refineCalls: VaultAiRefineInput[] = [];
  rankCalls: VaultAiRankInput[] = [];
  refineResult: VaultAiRefineResult = {
    ok: true,
    searchTerms: ['ops-aid-term'],
    summary: 'Ops fake summary.'
  };
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  async refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult> {
    this.refineCalls.push(input);
    return this.refineResult;
  }

  async rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult> {
    this.rankCalls.push(input);
    return { orderedIds: input.candidates.map((c) => c.id) };
  }
}

function writeVaultAiConfig(vaultRoot: string, ai: Record<string, unknown>): void {
  ensureVaultStructure(vaultRoot);
  const configPath = path.join(vaultRoot, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  raw.ai = ai;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
  resetAiOpsConfigCacheForTests(vaultRoot);
}

function readJournalLines(vaultRoot: string): Array<Record<string, unknown>> {
  const dir = getAiOpsDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return out;
}

async function waitForJournal(
  vaultRoot: string,
  count: number,
  timeoutMs = 8000
): Promise<Array<Record<string, unknown>>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lines = readJournalLines(vaultRoot);
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readJournalLines(vaultRoot);
}

describe('Status monitor AI ops log (spec 0057)', () => {
  let tempVault: string;
  let tempProject: string;
  let savedCursorKey: string | undefined;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-aiops-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-aiops-proj-'));
    savedCursorKey = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    clearAiStateForTests();
  });

  afterEach(() => {
    if (savedCursorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedCursorKey;
    clearAiStateForTests();
    resetAiOpsConfigCacheForTests(tempVault);
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('AC17: MCP tool surface stays at 11 tools (no AI ops tool)', () => {
    assert.equal(TOOL_NAMES.length, 11);
    assert.ok(!TOOL_NAMES.includes('ai-ops' as never));
  });

  it('Issue #66: resolveVaultAiAgent wires withAiOpsJournal at the choke point', async () => {
    // Enabled SDK must return the journaled decorator, not the raw adapter.
    const enabled = resolveVaultAiAgent(tempVault, {
      ...defaultAiConfig(),
      enabled: true,
      provider: 'cursor-sdk'
    });
    assert.ok(enabled.agent instanceof AiOpsJournaledAgent);
    assert.equal(isAiOpsLogEnabled(enabled.config), true);
    // Disabled AI still resolves Noop (pass-through writes zero rows).
    const disabled = resolveVaultAiAgent(tempVault, {
      ...defaultAiConfig(),
      enabled: false,
      provider: 'cursor-sdk'
    });
    assert.ok(disabled.agent instanceof NoopVaultAiAgent);
    // Explicit opt-out keeps the wrapper but disables journal capture.
    const optedOut = resolveVaultAiAgent(tempVault, {
      ...defaultAiConfig(),
      enabled: true,
      provider: 'cursor-sdk',
      opsLogEnabled: false
    });
    assert.ok(optedOut.agent instanceof AiOpsJournaledAgent);
    assert.equal(isAiOpsLogEnabled(optedOut.config), false);
  });

  it('AC7: fake-agent refine appends one redacted journal row (no full body)', async () => {
    writeVaultAiConfig(tempVault, { enabled: true, provider: 'cursor-sdk' });
    const fake = new FakeOpsAgent();
    const body = '## DO NOT\nDelete prod.\n\n## INSTEAD DO\nSnapshot first. Unique canary body text alpha.';
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'aiops-refine-trap',
      frontmatter: { id: 'aiops-refine-trap', title: 'Ops refine me' },
      body,
      aiAgent: fake
    });
    const lines = await waitForJournal(tempVault, 1);
    assert.equal(lines.length, 1);
    const row = lines[0]!;
    assert.equal(row['operation'], 'refine');
    assert.equal(row['ok'], true);
    assert.equal(row['recordId'], 'aiops-refine-trap');
    assert.equal(typeof row['id'], 'string');
    assert.equal(typeof row['timestamp'], 'string');
    assert.equal(typeof row['durationMs'], 'number');
    const input = row['input'] as Record<string, unknown>;
    assert.equal(input['title'], 'Ops refine me');
    assert.ok(!(input as Record<string, unknown>)['body'], 'full body must not be stored');
    const output = row['output'] as Record<string, unknown>;
    assert.deepEqual(output['searchTerms'], ['ops-aid-term']);
    // Rolling part file naming: ai-ops-YYYY-MM-DD.part-1.jsonl
    const files = fs.readdirSync(getAiOpsDir(tempVault));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^ai-ops-\d{4}-\d{2}-\d{2}\.part-1\.jsonl$/);
    // Product git is untouched: journal lives under the vault root only.
    assert.ok(!fs.existsSync(path.join(tempProject, 'ai-ops')));
  });

  it('AC8: rank settlement journals query + candidate ids only (no snippets)', async () => {
    writeVaultAiConfig(tempVault, { enabled: true, provider: 'cursor-sdk' });
    const fake = new FakeOpsAgent();
    // Distinct bodies: near-identical traps collapse via dedup recurrence.
    const fixtures = [
      ['aiops-rank-one', 'Rankable one', 'Wobble quark calibration for rankable one with alpha circuitry notes.'],
      ['aiops-rank-two', 'Rankable two', 'Rankable two covers wobble quark garden journals and beta ledger remarks.']
    ] as const;
    for (const [slug, title, body] of fixtures) {
      const res = await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug,
        frontmatter: { id: slug, title },
        body: `Record about ${body}`
      });
      assert.equal(res.recurrence, undefined);
    }
    // Drain any refine rows first (upserts ran without an agent: no rows expected).
    assert.equal(readJournalLines(tempVault).length, 0);
    const res = await searchIndexRanked(
      { vaultRoot: tempVault, cwd: tempProject, query: 'wobble quark' },
      { agent: fake, rankTopK: 20 }
    );
    assert.ok(res.hits.length >= 2);
    const lines = await waitForJournal(tempVault, 1);
    const rankRows = lines.filter((l) => l['operation'] === 'rank');
    assert.equal(rankRows.length, 1);
    const input = rankRows[0]!['input'] as Record<string, unknown>;
    assert.equal(input['query'], 'wobble quark');
    assert.ok(Array.isArray(input['candidateIds']));
    assert.ok(!(input as Record<string, unknown>)['candidates'], 'snippets must not be stored');
    const output = rankRows[0]!['output'] as Record<string, unknown>;
    assert.ok(Array.isArray(output['orderedIds']));
  });

  it('AC3+AC11: secrets are redacted and payloads truncate with metadata.truncated', () => {
    const config = {
      ...defaultAiConfig(),
      enabled: true,
      opsLogMaxBytes: 1024
    };
    const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
    const id = recordAiOpsEvent({
      vaultRoot: tempVault,
      config,
      operation: 'refine',
      ok: true,
      durationMs: 12,
      recordId: 'sec-row',
      input: { title: `note ${bearer} here`, blob: `x`.repeat(4000) },
      output: { searchTerms: ['ok'], summary: `y`.repeat(4000) },
      metadata: {}
    });
    assert.ok(id);
    const raw = fs.readFileSync(
      path.join(getAiOpsDir(tempVault), fs.readdirSync(getAiOpsDir(tempVault))[0]!),
      'utf8'
    );
    assert.ok(!raw.includes(bearer), 'bearer token must not appear in the journal file');
    const row = getAiOpsEntry(tempVault, id!)!;
    assert.ok(row);
    assert.equal((row.metadata as Record<string, unknown>)?.['truncated'], true);
    const capped = Buffer.byteLength(JSON.stringify(row.input ?? null), 'utf8') +
      Buffer.byteLength(JSON.stringify(row.output ?? null), 'utf8');
    assert.ok(capped <= 1024, `capped payload ${capped} exceeds 1024`);
  });

  it('AC11: live CURSOR_API_KEY values never land in the journal', () => {
    process.env.CURSOR_API_KEY = 'live-key-value-987654321';
    const config = { ...defaultAiConfig(), enabled: true };
    const id = recordAiOpsEvent({
      vaultRoot: tempVault,
      config,
      operation: 'rank',
      ok: false,
      durationMs: 3,
      input: { query: 'uses live-key-value-987654321 inside' },
      error: 'boom live-key-value-987654321'
    });
    assert.ok(id);
    const raw = readJournalLines(tempVault)
      .map((l) => JSON.stringify(l))
      .join('\n');
    assert.ok(!raw.includes('live-key-value-987654321'));
  });

  it('AC4+AC9: Noop writes zero rows; explicit opsLogEnabled:false writes zero rows even when AI runs', async () => {
    // Noop agent with AI enabled: zero LLM work, zero disk.
    writeVaultAiConfig(tempVault, { enabled: true, provider: 'cursor-sdk' });
    const noop = new NoopVaultAiAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'aiops-noop-trap',
      frontmatter: { id: 'aiops-noop-trap', title: 'Noop trap' },
      body: '## DO NOT\nX.\n\n## INSTEAD DO\nY.',
      aiAgent: noop
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(getAiQueueDepth(), 0);
    assert.ok(!fs.existsSync(getAiOpsDir(tempVault)));

    // withAiOpsJournal passes Noop through untouched: direct calls write nothing.
    const wrappedNoop = withAiOpsJournal(noop, { vaultRoot: tempVault });
    await wrappedNoop.refineForSearch({
      id: 'n',
      kind: 'trap',
      title: 't',
      body: 'b',
      tags: [],
      pathPatterns: []
    });
    assert.ok(!fs.existsSync(getAiOpsDir(tempVault)));

    // Explicit opt-out beats a running agent.
    writeVaultAiConfig(tempVault, { enabled: true, provider: 'cursor-sdk', opsLogEnabled: false });
    const fake = new FakeOpsAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'aiops-optout-trap',
      frontmatter: { id: 'aiops-optout-trap', title: 'Opt-out trap' },
      body: '## DO NOT\nA.\n\n## INSTEAD DO\nB.',
      aiAgent: fake
    });
    const start = Date.now();
    let rec: Awaited<ReturnType<typeof getRecord>> = null;
    while (Date.now() - start < 8000) {
      rec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'aiops-optout-trap' });
      if (rec && Array.isArray(rec.frontmatter.aiSearchTerms)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(rec?.frontmatter.aiSearchTerms, 'agent still refines while journal stays off');
    assert.ok(!fs.existsSync(getAiOpsDir(tempVault)));
  });

  it('AC4: omitted opsLogEnabled with disabled AI writes zero rows', async () => {
    writeVaultAiConfig(tempVault, { enabled: false, provider: 'cursor-sdk' });
    const fake = new FakeOpsAgent();
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'aiops-disabled-trap',
      frontmatter: { id: 'aiops-disabled-trap', title: 'Disabled trap' },
      body: '## DO NOT\nC.\n\n## INSTEAD DO\nD.',
      aiAgent: fake
    });
    await waitForJournal(tempVault, 1, 600).catch(() => readJournalLines(tempVault));
    // The DI agent still refines (existing 0056 behavior) but the journal gate
    // follows ai.enabled=false, so no rows may exist.
    const lines = readJournalLines(tempVault);
    assert.equal(lines.length, 0);
  });

  it('AC12–AC16: REST list/detail with 401/400/404, pagination, and path sanitize', async () => {
    const config = { ...defaultAiConfig(), enabled: true };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = recordAiOpsEvent({
        vaultRoot: tempVault,
        config,
        operation: i % 2 === 0 ? 'refine' : 'rank',
        ok: i % 3 !== 0,
        durationMs: i + 1,
        recordId: `rec-${i}`,
        projectId: 'proj-a',
        input: { query: `q${i}` },
        output: { orderedIds: [] },
        error: i % 3 === 0 ? `failure number ${i}` : undefined,
        metadata: { path: '/abs/vault/secret/x', note: 'ok' }
      });
      assert.ok(id);
      ids.push(id!);
    }

    const bus = createActivityBus();
    const server = await startStatusServer({
      vaultRoot: tempVault,
      port: 0,
      host: '127.0.0.1',
      authToken: 'aiops-secret',
      activityBus: bus
    });
    try {
      // AC15: unauthenticated requests yield 401 and leak no journal ids.
      const unauth = await fetch(`${server.url}/api/ai-ops`);
      assert.equal(unauth.status, 401);
      const unauthBody = await unauth.text();
      for (const id of ids) assert.ok(!unauthBody.includes(id));
      const unauthDetail = await fetch(`${server.url}/api/ai-ops/${ids[0]}`);
      assert.equal(unauthDetail.status, 401);

      const auth = { Authorization: 'Bearer aiops-secret' };
      // AC12: invalid query yields 400.
      const bad = await fetch(`${server.url}/api/ai-ops?limit=9999`, { headers: auth });
      assert.equal(bad.status, 400);
      const badOp = await fetch(`${server.url}/api/ai-ops?operation=bogus`, { headers: auth });
      assert.equal(badOp.status, 400);

      // AC12–AC13: list shape, pagination, filters; no full input/output.
      const page1 = await fetch(`${server.url}/api/ai-ops?limit=2&offset=0`, { headers: auth });
      assert.equal(page1.status, 200);
      const p1 = (await page1.json()) as {
        items: Array<Record<string, unknown>>;
        total: number;
      };
      assert.equal(p1.total, 5);
      assert.equal(p1.items.length, 2);
      for (const item of p1.items) {
        assert.ok(typeof item['id'] === 'string');
        assert.ok(typeof item['timestamp'] === 'string');
        assert.ok(item['operation'] === 'refine' || item['operation'] === 'rank');
        assert.equal(typeof item['ok'], 'boolean');
        assert.equal(typeof item['durationMs'], 'number');
        assert.ok(!('input' in item), 'list items must not include full input');
        assert.ok(!('output' in item), 'list items must not include full output');
      }
      const page2 = await fetch(`${server.url}/api/ai-ops?limit=2&offset=2`, { headers: auth });
      const p2 = (await page2.json()) as { items: Array<{ id: string }>; total: number };
      assert.equal(p2.items.length, 2);
      assert.ok(!p1.items.some((i) => p2.items.some((j) => j.id === i['id'])));

      const refines = await fetch(`${server.url}/api/ai-ops?operation=refine`, { headers: auth });
      const rj = (await refines.json()) as { items: Array<{ operation: string }>; total: number };
      assert.equal(rj.total, 3);
      assert.ok(rj.items.every((i) => i.operation === 'refine'));

      // AC14: detail roundtrip + 404.
      const detail = await fetch(`${server.url}/api/ai-ops/${ids[0]}`, { headers: auth });
      assert.equal(detail.status, 200);
      const dj = (await detail.json()) as { ok: boolean; entry: Record<string, unknown> };
      assert.equal(dj.ok, true);
      assert.equal(dj.entry['id'], ids[0]);
      assert.ok('input' in dj.entry);

      // AC16: raw filesystem paths never leave the handler.
      const detailRaw = JSON.stringify(dj);
      assert.ok(!detailRaw.includes('/abs/vault/secret/x'));

      const missing = await fetch(`${server.url}/api/ai-ops/does-not-exist`, { headers: auth });
      assert.equal(missing.status, 404);
    } finally {
      bus.close();
      await server.close();
    }
  });

  it('AC18–AC22: status HTML has the AI Ops tab, filters, escaped detail pane', () => {
    const html = generateStatusHtml(getPackageVersion());
    assert.ok(html.includes('data-tab="tab-ai-ops"'));
    assert.ok(html.includes('id="tab-ai-ops"'));
    // Spec 0058 relocated the AI Ops leaf into the left sidebar: the label
    // now renders inside a span, not directly before </button>.
    assert.ok(html.includes('id="status-sidebar"'));
    assert.ok(html.includes('>AI Ops</span></button>'));
    assert.ok(html.includes('id="aiops-operation-select"'));
    assert.ok(html.includes('id="aiops-ok-select"'));
    assert.ok(html.includes('id="aiops-tbody"'));
    assert.ok(html.includes('id="aiops-detail"'));
    assert.ok(html.includes('No AI operations recorded yet.'));
    assert.ok(html.includes('/api/ai-ops'));
    // AC20: the detail pane fills <pre> via textContent, never innerHTML of JSON.
    // Scope the check to the AI Ops script block (other tabs use escaped innerHTML).
    const opsStart = html.indexOf('AI OPS TAB LOGIC');
    const memStart = html.indexOf('MEMORY TAB LOGIC');
    assert.ok(opsStart >= 0 && memStart > opsStart);
    const aiopsBlock = html.slice(opsStart, memStart);
    assert.ok(aiopsBlock.includes('aiops-detail-input'));
    assert.ok(!aiopsBlock.includes('innerHTML'), 'AI Ops detail must not use innerHTML');
    // AC18: default landing tab is Home since spec 0058 (sidebar nav).
    assert.ok(html.includes('<button class="tab-btn active" data-tab="tab-home">'));
  });

  it('Review: many-field payloads still fit the byte cap (hard guarantee)', () => {
    // 50 medium fields x ~400 bytes each with a 1024 cap: single-field
    // rounds cannot converge, so the multi-field pass + hard fallback apply.
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) input[`field-${i}`] = `v${i}-`.padEnd(400, 'x');
    const capped = truncateOpsPayloadToBudget(input, { note: 'tiny' }, {}, 1024);
    assert.equal(capped.metadata?.['truncated'], true);
    const bytes = Buffer.byteLength(JSON.stringify(capped.input ?? null), 'utf8') +
      Buffer.byteLength(JSON.stringify(capped.output ?? null), 'utf8');
    assert.ok(bytes <= 1024, `capped payload ${bytes} exceeds 1024`);
  });

  it('Review: journal scans newest-first and ai-ops is vault-git ignored', async () => {
    assert.ok(REQUIRED_VAULT_GITIGNORE.includes('ai-ops/'));
    const config = { ...defaultAiConfig(), enabled: true };
    const first = recordAiOpsEvent({
      vaultRoot: tempVault,
      config,
      operation: 'refine',
      ok: true,
      durationMs: 1,
      recordId: 'oldest-row',
      input: { n: 1 }
    });
    assert.ok(first);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const newest = recordAiOpsEvent({
      vaultRoot: tempVault,
      config,
      operation: 'rank',
      ok: true,
      durationMs: 2,
      recordId: 'newest-row',
      input: { n: 2 }
    });
    assert.ok(newest);
    // Newest-first list: latest row leads with exact total intact.
    const listed = listAiOpsEntries(tempVault, { limit: 50, offset: 0 });
    assert.equal(listed.total, 2);
    assert.equal(listed.items[0]?.id, newest);
    assert.equal(listed.items[1]?.id, first);
    // Early-exit detail lookup resolves both rows.
    assert.equal(getAiOpsEntry(tempVault, newest!)?.recordId, 'newest-row');
    assert.equal(getAiOpsEntry(tempVault, first!)?.recordId, 'oldest-row');
    assert.equal(getAiOpsEntry(tempVault, 'missing'), null);
  });
});
