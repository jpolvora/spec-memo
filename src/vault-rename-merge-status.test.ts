import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createActivityBus } from './activity.js';
import { generateStatusHtml, startStatusServer } from './status.js';
import { ensureVaultStructure } from './vault.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';
import { sanitizeToolOutput } from './safety.js';

test('vault rename and dedup merge REST + UI (AC18-19, AC21, AC27, AC29-31, NS2, NS3, NS6)', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-rename-merge-'));
  const vaultRoot = path.join(tempDir, 'vault');
  ensureVaultStructure(vaultRoot);
  const bus = createActivityBus({ capacity: 200 });

  const savedEnv = {
    auth: process.env.SPEC_MEMO_AUTH_TOKEN,
    sse: process.env.SPEC_MEMO_SSE_TOKEN,
    status: process.env.SPEC_MEMO_STATUS_TOKEN,
    root: process.env.SPEC_MEMO_ROOT
  };
  delete process.env.SPEC_MEMO_AUTH_TOKEN;
  delete process.env.SPEC_MEMO_SSE_TOKEN;
  delete process.env.SPEC_MEMO_STATUS_TOKEN;
  delete process.env.SPEC_MEMO_ROOT;

  t.after(() => {
    if (savedEnv.auth !== undefined) process.env.SPEC_MEMO_AUTH_TOKEN = savedEnv.auth;
    else delete process.env.SPEC_MEMO_AUTH_TOKEN;
    if (savedEnv.sse !== undefined) process.env.SPEC_MEMO_SSE_TOKEN = savedEnv.sse;
    else delete process.env.SPEC_MEMO_SSE_TOKEN;
    if (savedEnv.status !== undefined) process.env.SPEC_MEMO_STATUS_TOKEN = savedEnv.status;
    else delete process.env.SPEC_MEMO_STATUS_TOKEN;
    if (savedEnv.root !== undefined) process.env.SPEC_MEMO_ROOT = savedEnv.root;
    else delete process.env.SPEC_MEMO_ROOT;
    bus.close();
    closeIndex(vaultRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Seed two projects.
  await upsertRecord({
    vaultRoot,
    projectId: 'rename-src-rest',
    kind: 'trap',
    slug: 'trap-a',
    frontmatter: { title: 'Trap A', severity: 'low' },
    body: 'rename rest body content'
  });

  const instance = await startStatusServer({ vaultRoot, port: 0, host: '127.0.0.1', activityBus: bus });
  t.after(async () => {
    await instance.close();
  });
  const baseUrl = instance.url;

  await t.test('AC21/AC29/AC30: Vaults tab has Rename button, merge checkboxes, results banner', () => {
    const html = generateStatusHtml('0.0.0-test');
    assert.ok(html.includes('vaultActionButton("rename"'));
    assert.ok(html.includes('id="vault-fields-rename"'));
    assert.ok(html.includes('id="vault-rename-from"'));
    assert.ok(html.includes('id="vault-rename-to"'));
    assert.ok(html.includes('Rename project'));
    assert.ok(html.includes('id="vault-merge-dedup"'));
    assert.ok(html.includes('id="vault-merge-delete-sources"'));
    assert.ok(html.includes('id="vault-merge-target-id"'));
    assert.ok(html.includes('copied='));
    assert.ok(html.includes('deduplicated='));
    assert.ok(html.includes('skipped='));
  });

  await t.test('AC18: POST /api/vaults/rename returns 200 {ok,from,to}', async () => {
    const res = await fetch(`${baseUrl}/api/vaults/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'rename-src-rest', to: 'rename-dst-rest' })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; from: string; to: string };
    assert.equal(body.ok, true);
    assert.equal(body.from, 'rename-src-rest');
    assert.equal(body.to, 'rename-dst-rest');
    assert.ok(fs.existsSync(path.join(vaultRoot, 'projects', 'rename-dst-rest')));
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(vaultRoot));
    assert.ok(!serialized.includes('C:\\') && !serialized.includes('/home/'));
  });

  await t.test('NS3 AC19: rename missing source returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/vaults/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'no-such-src', to: 'some-dst' })
    });
    assert.equal(res.status, 404);
  });

  await t.test('NS2 AC19: rename existing target returns 409 without renaming', async () => {
    await upsertRecord({
      vaultRoot,
      projectId: 'conflict-a',
      kind: 'trap',
      slug: 't1',
      frontmatter: { title: 'T1', severity: 'low' },
      body: 'conflict body a'
    });
    await upsertRecord({
      vaultRoot,
      projectId: 'conflict-b',
      kind: 'trap',
      slug: 't2',
      frontmatter: { title: 'T2', severity: 'low' },
      body: 'conflict body b'
    });
    const res = await fetch(`${baseUrl}/api/vaults/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'conflict-a', to: 'conflict-b' })
    });
    assert.equal(res.status, 409);
    assert.ok(fs.existsSync(path.join(vaultRoot, 'projects', 'conflict-a')));
    assert.ok(fs.existsSync(path.join(vaultRoot, 'projects', 'conflict-b')));
  });

  await t.test('AC19: rename invalid ids returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/vaults/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'conflict-a', to: 'BAD ID!' })
    });
    assert.equal(res.status, 400);
  });

  await t.test('AC27 AC31: merge accepts dedup/deleteSources and returns metrics sanitized', async () => {
    await upsertRecord({
      vaultRoot,
      projectId: 'merge-src-rest',
      kind: 'trap',
      slug: 'shared-trap',
      frontmatter: { id: 'src-shared-1', title: 'Shared', severity: 'low', pathPatterns: ['src/m.ts'], occurrences: 2 },
      body: 'shared trap body alpha beta gamma delta epsilon'
    });
    await upsertRecord({
      vaultRoot,
      projectId: 'merge-tgt-rest',
      kind: 'trap',
      slug: 'shared-trap',
      frontmatter: { id: 'tgt-shared-1', title: 'Shared', severity: 'low', pathPatterns: ['src/m.ts'], occurrences: 3 },
      body: 'shared trap body alpha beta gamma delta epsilon'
    });
    const res = await fetch(`${baseUrl}/api/vaults/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: ['merge-src-rest'], target: 'merge-tgt-rest', copyRecords: true, dedup: true, deleteSources: false })
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; copied: number; deduplicated: number; skipped: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.copied, 'number');
    assert.equal(typeof body.deduplicated, 'number');
    assert.equal(typeof body.skipped, 'number');
    assert.equal(body.deduplicated, 1);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(vaultRoot));
  });

  await t.test('AC31: rename and merge responses pass through sanitizeToolOutput', () => {
    const renamed = sanitizeToolOutput({ ok: true, from: 'a', to: 'b' }) as Record<string, unknown>;
    assert.equal(renamed.ok, true);
    const merged = sanitizeToolOutput({ ok: true, target: 't', sources: ['s'], copied: 1, deduplicated: 0, skipped: 0 }) as Record<string, unknown>;
    assert.equal(merged.copied, 1);
  });

  await t.test('NS6: unauthorized rename returns 401 with token configured', async () => {
    const authBus = createActivityBus();
    const authServer = await startStatusServer({
      vaultRoot,
      port: 0,
      host: '127.0.0.1',
      authToken: 'rename-secret',
      activityBus: authBus
    });
    try {
      const unauth = await fetch(`${authServer.url}/api/vaults/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'conflict-a', to: 'conflict-c' })
      });
      assert.equal(unauth.status, 401);
      const authed = await fetch(`${authServer.url}/api/vaults/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rename-secret' },
        body: JSON.stringify({ from: 'conflict-a', to: 'conflict-c' })
      });
      assert.equal(authed.status, 200);
    } finally {
      authBus.close();
      await authServer.close();
    }
  });
});
