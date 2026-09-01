import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runGc, isRecordExpired, compactPlanRecord } from './curator.js';
import { upsertRecord, getRecord } from './store.js';
import { searchIndex, openIndex, closeIndex } from './indexer.js';
import { executeTool } from './tools.js';

describe('Curator Engine: GC, TTL & Shipped Plan Compaction', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-curator-test-'));
    vaultRoot = path.join(tempDir, 'vault');
    productRepo = path.join(tempDir, 'product-repo');
    fs.mkdirSync(productRepo, { recursive: true });
    fs.mkdirSync(path.join(productRepo, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeIndex();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Tolerant
      }
    }
  });

  describe('isRecordExpired helper', () => {
    it('should correctly evaluate standard TTL days', () => {
      const now = Date.now();
      const eightDaysAgo = new Date(now - 8 * 86400 * 1000).toISOString();
      const sixDaysAgo = new Date(now - 6 * 86400 * 1000).toISOString();

      assert.strictEqual(isRecordExpired(eightDaysAgo, 7, undefined, now), true);
      assert.strictEqual(isRecordExpired(sixDaysAgo, 7, undefined, now), false);
    });

    it('should evaluate custom TTL strings', () => {
      const now = Date.now();
      const fourDaysAgo = new Date(now - 4 * 86400 * 1000).toISOString();
      const twoDaysAgo = new Date(now - 2 * 86400 * 1000).toISOString();

      assert.strictEqual(isRecordExpired(fourDaysAgo, 7, '3d', now), true);
      assert.strictEqual(isRecordExpired(twoDaysAgo, 7, '3d', now), false);
    });

    it('should evaluate explicit ISO date TTL', () => {
      const now = Date.now();
      const pastTtl = new Date(now - 1000).toISOString();
      const futureTtl = new Date(now + 100000).toISOString();
      const created = new Date(now - 2000).toISOString();

      assert.strictEqual(isRecordExpired(created, 7, pastTtl, now), true);
      assert.strictEqual(isRecordExpired(created, 7, futureTtl, now), false);
    });
  });

  describe('compactPlanRecord', () => {
    it('should produce a concise summary body and mark compacted: true', () => {
      const samplePlan = {
        frontmatter: {
          id: 'slice-7-curator',
          kind: 'plan' as const,
          project: 'test-project',
          status: 'shipped' as const,
          created: '2026-08-23T00:00:00.000Z',
          updated: '2026-08-23T12:00:00.000Z',
          source: 'agent' as const,
          title: 'Curator GC & Safety',
          verifiedAtSha: 'abc1234',
          relatedSlug: 'curator-gc'
        },
        body: `
# Detailed Step 1
Did something verbose with 100 lines of logs...
## Step 2
Ran 50 unit tests...
## Step 3
Created artifacts...
`
      };

      const compacted = compactPlanRecord(samplePlan);
      assert.strictEqual(compacted.frontmatter.compacted, true);
      assert.ok(compacted.body.includes('# Plan Summary: Curator GC & Safety'));
      assert.ok(compacted.body.includes('**Outcome:** Delivery completed successfully'));
      assert.ok(compacted.body.includes('`abc1234`'));
      assert.ok(!compacted.body.includes('Detailed Step 1'));
    });
  });

  describe('runGc execution', () => {
    it('should prune expired scratch/review and compact shipped plans while honoring dryRun', async () => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 86400 * 1000).toISOString();
      const oneDayAgo = new Date(now - 1 * 86400 * 1000).toISOString();
      const sixteenDaysAgo = new Date(now - 16 * 86400 * 1000).toISOString();
      const threeDaysAgo = new Date(now - 3 * 86400 * 1000).toISOString();

      // 1. Expired scratch (10 days old)
      const expScratch = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'scratch',
        slug: 'temp-telemetry-old',
        frontmatter: { created: tenDaysAgo, updated: tenDaysAgo },
        body: 'Temporary telemetry run data'
      });

      // 2. Fresh scratch (1 day old)
      const freshScratch = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'scratch',
        slug: 'temp-telemetry-fresh',
        frontmatter: { created: oneDayAgo, updated: oneDayAgo },
        body: 'Fresh telemetry run data'
      });

      // 3. Expired review (16 days old)
      const expReview = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'review',
        slug: 'stale-review',
        frontmatter: { created: sixteenDaysAgo, updated: sixteenDaysAgo },
        body: 'Old review notes'
      });

      // 4. Fresh review (3 days old)
      const freshReview = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'review',
        slug: 'recent-review',
        frontmatter: { created: threeDaysAgo, updated: threeDaysAgo },
        body: 'Recent review notes'
      });

      // 5. Shipped plan (needs compaction)
      const shippedPlan = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'plan',
        slug: 'shipped-feature-plan',
        frontmatter: {
          status: 'shipped',
          title: 'Shipped Feature Plan',
          created: threeDaysAgo,
          updated: threeDaysAgo,
          verifiedAtSha: 'deadbeef'
        },
        body: 'Very long step-by-step notes\nLine 2\nLine 3\nLine 4\n'
      });

      // 6. Active plan (must NOT be compacted)
      const activePlan = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'plan',
        slug: 'active-feature-plan',
        frontmatter: {
          status: 'active',
          title: 'Active Feature Plan'
        },
        body: 'Active step-by-step working plan'
      });

      // First run in DRY RUN mode
      const dryResult = await runGc({
        vaultRoot,
        cwd: productRepo,
        dryRun: true
      });

      assert.strictEqual(dryResult.dryRun, true);
      assert.strictEqual(dryResult.purgedScratchCount, 1);
      assert.strictEqual(dryResult.purgedReviewCount, 1);
      assert.strictEqual(dryResult.compactedPlansCount, 1);

      // Verify files still exist on disk after dry run
      assert.strictEqual(fs.existsSync(expScratch.path), true);
      assert.strictEqual(fs.existsSync(expReview.path), true);

      // Now run for REAL
      const liveResult = await runGc({
        vaultRoot,
        cwd: productRepo,
        dryRun: false
      });

      assert.strictEqual(liveResult.dryRun, false);
      assert.strictEqual(liveResult.purgedScratchCount, 1);
      assert.strictEqual(liveResult.purgedReviewCount, 1);
      assert.strictEqual(liveResult.compactedPlansCount, 1);
      assert.strictEqual(liveResult.rebuiltFts, true);
      assert.strictEqual(liveResult.rebuiltViews, true);

      // Verify expired records deleted
      assert.strictEqual(fs.existsSync(expScratch.path), false);
      assert.strictEqual(fs.existsSync(expReview.path), false);

      // Verify fresh records preserved
      assert.strictEqual(fs.existsSync(freshScratch.path), true);
      assert.strictEqual(fs.existsSync(freshReview.path), true);

      // Verify shipped plan compacted
      const readShipped = await getRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'plan',
        slug: 'shipped-feature-plan'
      });
      assert.ok(readShipped);
      assert.strictEqual(readShipped.frontmatter.compacted, true);
      assert.ok(readShipped.body.includes('# Plan Summary: Shipped Feature Plan'));

      // Verify active plan remains uncompacted
      const readActive = await getRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'plan',
        slug: 'active-feature-plan'
      });
      assert.ok(readActive);
      assert.strictEqual(readActive.frontmatter.compacted, undefined);
      assert.ok(readActive.body.includes('Active step-by-step working plan'));

      // Verify FTS search no longer returns expired records
      const searchRes = searchIndex({
        vaultRoot,
        cwd: productRepo,
        includeScratch: true,
        kinds: ['scratch', 'review']
      });

      const foundIds = searchRes.map((h) => h.id);
      assert.ok(!foundIds.includes('temp-telemetry-old'));
      assert.ok(!foundIds.includes('stale-review'));
      assert.ok(foundIds.includes('temp-telemetry-fresh'));
      assert.ok(foundIds.includes('recent-review'));
    });

    it('should compact historical log event records into monthly roll-up files and update FTS index', async () => {
      const now = new Date('2026-08-25T12:00:00.000Z').getTime();
      const july1Date = new Date('2026-07-01T10:00:00.000Z').toISOString();
      const july15Date = new Date('2026-07-15T15:30:00.000Z').toISOString();
      const aug24Date = new Date('2026-08-24T09:00:00.000Z').toISOString();

      // Create two log events in July (prior month)
      const log1 = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'log',
        slug: 'event-july-01',
        frontmatter: {
          id: 'log-2026-07-01-event1',
          created: july1Date,
          updated: july1Date,
          source: 'agent',
          details: { phase: 'setup', step: 1 }
        },
        body: 'July 1 setup event: Initialized project workspace successfully'
      });

      const log2 = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'log',
        slug: 'event-july-15',
        frontmatter: {
          id: 'log-2026-07-15-event2',
          created: july15Date,
          updated: july15Date,
          source: 'agent',
          details: { phase: 'delivery', step: 5 }
        },
        body: 'July 15 delivery event: Deployed critical security patch to production'
      });

      // Create a fresh log event in August (current month)
      const log3 = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'log',
        slug: 'event-aug-24',
        frontmatter: {
          id: 'log-2026-08-24-event3',
          created: aug24Date,
          updated: aug24Date,
          source: 'agent'
        },
        body: 'August 24 event: Current active sprint audit trace'
      });

      assert.strictEqual(fs.existsSync(log1.path), true);
      assert.strictEqual(fs.existsSync(log2.path), true);
      assert.strictEqual(fs.existsSync(log3.path), true);

      // Run GC with fixed clock so month boundaries stay deterministic across timezones
      const gcRes = await runGc({
        vaultRoot,
        cwd: productRepo,
        dryRun: false,
        now
      });

      assert.strictEqual(gcRes.compactedLogsCount, 2);

      // Verify individual July log files were removed
      assert.strictEqual(fs.existsSync(log1.path), false);
      assert.strictEqual(fs.existsSync(log2.path), false);

      // Verify August log file remains untouched
      assert.strictEqual(fs.existsSync(log3.path), true);

      // Verify monthly roll-up file was created
      const identity = (await import('./identity.js')).resolveProjectIdentity(productRepo, { vaultRoot });
      const rollupPath = path.join(vaultRoot, 'projects', identity.projectId, 'logs', 'log-rollup-2026-07.md');
      assert.strictEqual(fs.existsSync(rollupPath), true);

      const rollupContent = fs.readFileSync(rollupPath, 'utf8');
      assert.ok(rollupContent.includes('### Event: `log-2026-07-01-event1`'));
      assert.ok(rollupContent.includes('Initialized project workspace successfully'));
      assert.ok(rollupContent.includes('### Event: `log-2026-07-15-event2`'));
      assert.ok(rollupContent.includes('Deployed critical security patch to production'));

      // Verify SQLite FTS can find the compacted log content
      const searchRes = searchIndex({
        vaultRoot,
        cwd: productRepo,
        query: 'security patch',
        kinds: ['log']
      });

      assert.strictEqual(searchRes.length, 1);
      assert.strictEqual(searchRes[0].id, 'log-rollup-2026-07');
    });

    it('should execute gc via executeTool successfully', async () => {
      const res = await executeTool('gc', {
        vaultRoot,
        cwd: productRepo,
        dryRun: false
      });

      assert.strictEqual(res.isError, undefined);
      assert.ok(res.data);
      const data = res.data as import('./types.js').GcResult;
      assert.strictEqual(typeof data.purgedScratchCount, 'number');
      assert.strictEqual(typeof data.compactedPlansCount, 'number');
      const details = (data as { details?: { purgedFiles?: string[]; compactedPlans?: string[] } }).details;
      assert.equal(details?.purgedFiles, undefined);
      assert.equal(details?.compactedPlans, undefined);
    });
  });
});
