import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectIdentity } from './identity.js';
import { submitMemoryFeedback } from './feedback.js';
import { upsertRecord } from './store.js';
import { searchIndex, openIndex, findActiveSemanticContradictions, closeIndex } from './indexer.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { runDoctor } from './doctor.js';
import { executeTool } from './tools.js';
import {
  helpfulCountOf,
  staleCountOf,
  isFlaggedStale,
  salienceMultiplier,
  STALE_BADGE
} from './salience.js';
import { parseRecord } from './schema.js';

describe('memory feedback & salience', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productRoot: string;
  let projectId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-feedback-'));
    vaultRoot = path.join(tempDir, 'vault');
    productRoot = path.join(tempDir, 'product');
    fs.mkdirSync(productRoot, { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, 'config.json'),
      JSON.stringify({ version: '1.0', mode: 'local' }),
      'utf8'
    );
    process.env.SPEC_MEMO_ROOT = vaultRoot;

    const init = await upsertRecord({
      kind: 'trap',
      slug: 'trap-feedback-test',
      frontmatter: {
        title: 'Feedback test trap',
        severity: 'medium',
        pathPatterns: ['src/**/*.ts']
      },
      body: 'Test trap body for feedback.',
      cwd: productRoot,
      vaultRoot
    });
    assert.equal(init.id, 'trap-feedback-test');
    projectId = resolveProjectIdentity(productRoot, { vaultRoot }).projectId;
  });

  afterEach(() => {
    closeIndex(vaultRoot);
    delete process.env.SPEC_MEMO_ROOT;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows file locks
    }
  });

  test('AC2/AC6/AC7: feedback updates frontmatter atomically without body change', async () => {
    const staleRes = await submitMemoryFeedback({
      id: 'trap-feedback-test',
      feedback: 'stale',
      cwd: productRoot,
      vaultRoot
    });
    assert.equal(staleRes.staleCount, 1);
    assert.equal(staleRes.helpfulCount, 0);
    assert.ok(staleRes.lastFeedback);

    const helpfulRes = await submitMemoryFeedback({
      id: 'trap-feedback-test',
      feedback: 'helpful',
      cwd: productRoot,
      vaultRoot
    });
    assert.equal(helpfulRes.helpfulCount, 1);
    assert.equal(helpfulRes.staleCount, 1);

    const trapPath = path.join(
      vaultRoot,
      'projects',
      projectId,
      'traps',
      'trap-feedback-test.md'
    );
    const parsed = parseRecord(fs.readFileSync(trapPath, 'utf8'), trapPath);
    assert.equal(parsed.body, 'Test trap body for feedback.');
    assert.equal(helpfulCountOf(parsed.frontmatter), 1);
    assert.equal(staleCountOf(parsed.frontmatter), 1);
    assert.ok(parsed.frontmatter.lastFeedback);
    assert.ok(parsed.frontmatter.lastHit);
  });

  test('AC4: prompt feedback action via executeTool', async () => {
    const res = await executeTool('prompt', {
      action: 'feedback',
      id: 'trap-feedback-test',
      feedback: 'wrong',
      cwd: productRoot,
      vaultRoot
    });
    assert.ok(!res.isError);
    assert.equal((res as { data: { staleCount: number } }).data.staleCount, 1);
  });

  test('AC5/AC9/AC8: salience dampening and flaggedStale in search', async () => {
    for (let i = 0; i < 3; i++) {
      await submitMemoryFeedback({
        id: 'trap-feedback-test',
        feedback: 'stale',
        cwd: productRoot,
        vaultRoot
      });
    }

    const hits = searchIndex({
      query: 'feedback',
      vaultRoot,
      cwd: productRoot,
      projectId
    });
    const hit = hits.find((h) => h.id === 'trap-feedback-test');
    assert.ok(hit);
    assert.equal(hit.flaggedStale, true);
    assert.equal(hit.staleCount, 3);
    assert.ok(salienceMultiplier({ staleCount: 3, helpfulCount: 0 }) < 1);
  });

  test('AC10: bootstrap prepends stale badge to title', async () => {
    for (let i = 0; i < 3; i++) {
      await submitMemoryFeedback({
        id: 'trap-feedback-test',
        feedback: 'stale',
        cwd: productRoot,
        vaultRoot
      });
    }

    const brief = await compileBootstrapBrief({ cwd: productRoot, vaultRoot, projectId });
    const trap = brief.traps.find((t) => t.frontmatter.id === 'trap-feedback-test');
    assert.ok(trap);
    assert.ok(String(trap.frontmatter.title).startsWith(STALE_BADGE));
    assert.ok(isFlaggedStale(trap.frontmatter));
  });

  test('AC11/AC12/AC13: typed links indexed and doctor detects contradictions', async () => {
    await upsertRecord({
      kind: 'decision',
      slug: 'decision-old-auth',
      frontmatter: { title: 'Old auth', status: 'active' },
      body: 'Use sessions.',
      cwd: productRoot,
      vaultRoot,
      projectId
    });
    await upsertRecord({
      kind: 'decision',
      slug: 'decision-new-auth',
      frontmatter: {
        title: 'New auth',
        status: 'active',
        links: [{ target: 'decision-old-auth', type: 'contradicts' }]
      },
      body: 'Use JWT.',
      cwd: productRoot,
      vaultRoot,
      projectId
    });

    openIndex(vaultRoot);
    const contradictions = findActiveSemanticContradictions(vaultRoot);
    assert.ok(
      contradictions.some(
        (c) => c.sourceId === 'decision-new-auth' && c.targetId === 'decision-old-auth'
      )
    );

    const doctor = await runDoctor({ cwd: productRoot, vaultRoot, productRoot });
    assert.ok(doctor.semanticContradictions && doctor.semanticContradictions.length >= 1);
    assert.ok(
      doctor.warnings.some((w) => w.includes('Active semantic contradiction'))
    );
  });

  test('AC14: doctor lists potentially obsolete records', async () => {
    for (let i = 0; i < 3; i++) {
      await submitMemoryFeedback({
        id: 'trap-feedback-test',
        feedback: 'stale',
        cwd: productRoot,
        vaultRoot
      });
    }

    const doctor = await runDoctor({ cwd: productRoot, vaultRoot, productRoot });
    assert.ok(doctor.potentiallyObsolete && doctor.potentiallyObsolete.length >= 1);
    assert.ok(
      doctor.potentiallyObsolete!.some((o) => o.id === 'trap-feedback-test')
    );
  });

  test('negative: invalid feedback type and missing record fail cleanly', async () => {
    await assert.rejects(
      () =>
        submitMemoryFeedback({
          id: 'trap-feedback-test',
          feedback: 'neutral' as never,
          cwd: productRoot,
          vaultRoot
        }),
      /Invalid feedback type/
    );

    await assert.rejects(
      () =>
        submitMemoryFeedback({
          id: 'missing-record-id',
          feedback: 'stale',
          cwd: productRoot,
          vaultRoot
        }),
      /Record not found/
    );
  });
});
