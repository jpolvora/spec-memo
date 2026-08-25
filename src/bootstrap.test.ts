import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compileBootstrapBrief, calculatePayloadSize } from './bootstrap.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';

describe('Bootstrap Brief Engine', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-boot-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-boot-proj-'));
  });

  afterEach(() => {
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('should resolve project identity and compile basic brief without writing to product tree', async () => {
    // 1. Create a decision in the vault
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'adr-001',
      frontmatter: {
        id: 'adr-001',
        title: 'Use standard ESM',
        status: 'active'
      },
      body: 'Decided to use ESM.'
    });

    const filesBefore = fs.readdirSync(tempProject);

    // 2. Run bootstrap
    const brief = await compileBootstrapBrief({
      cwd: tempProject,
      vaultRoot: tempVault
    });

    // Verify brief properties
    assert.ok(brief.projectId);
    assert.equal(brief.decisions.length, 1);
    assert.equal(brief.decisions[0].frontmatter.id, 'adr-001');
    assert.equal(brief.truncated, false);
    assert.ok(brief.byteLength > 0);
    assert.ok(brief.byteLength <= 8192);

    // AC6: Ensure ZERO files created in product tree
    const filesAfter = fs.readdirSync(tempProject);
    assert.deepEqual(filesAfter, filesBefore);
  });

  it('should rank traps by path relevance and severity', async () => {
    // 1. Low severity trap without path filter
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-low-general',
      frontmatter: {
        id: 'trap-low-general',
        title: 'Low severity general trap',
        severity: 'low'
      },
      body: 'Low severity body'
    });

    // 2. High severity trap without path filter
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-high-general',
      frontmatter: {
        id: 'trap-high-general',
        title: 'High severity general trap',
        severity: 'high'
      },
      body: 'High severity body'
    });

    // 3. Medium severity trap matching specific path
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-db-specific',
      frontmatter: {
        id: 'trap-db-specific',
        title: 'DB specific trap',
        severity: 'medium',
        pathPatterns: ['src/db/**/*.ts']
      },
      body: 'DB trap body'
    });

    // Bootstrap with path filter pointing to src/db/indexer.ts
    const brief = await compileBootstrapBrief({
      cwd: tempProject,
      vaultRoot: tempVault,
      path: 'src/db/indexer.ts'
    });

    assert.equal(brief.traps.length, 3);
    // Matching path pattern should rank first
    assert.equal(brief.traps[0].frontmatter.id, 'trap-db-specific');
    // High severity should rank second
    assert.equal(brief.traps[1].frontmatter.id, 'trap-high-general');
    // Low severity should rank last
    assert.equal(brief.traps[2].frontmatter.id, 'trap-low-general');
  });

  it('should strictly cap payload at byte budget and drop low-severity items with truncated: true', async () => {
    // Generate 30 traps of varying severity
    for (let i = 1; i <= 30; i++) {
      const severity = i <= 5 ? 'critical' : i <= 15 ? 'high' : i <= 25 ? 'medium' : 'low';
      await upsertRecord({
        cwd: tempProject,
        vaultRoot: tempVault,
        kind: 'trap',
        slug: `trap-batch-${i}`,
        allowDuplicate: true,
        frontmatter: {
          id: `trap-batch-${String(i).padStart(2, '0')}`,
          title: `Trap #${i} with detailed description and extensive explanation`,
          severity
        },
        body: `## Details for trap #${i}\nExtensive context description for anti-regression rule #${i} to take up payload bytes.`
      });
    }

    // Set tight budget of 3000 bytes
    const budgetBytes = 3000;
    const brief = await compileBootstrapBrief({
      cwd: tempProject,
      vaultRoot: tempVault,
      maxBytes: budgetBytes
    });

    assert.equal(brief.truncated, true);
    assert.ok(brief.byteLength <= budgetBytes);
    assert.ok(calculatePayloadSize(brief) <= budgetBytes);
    assert.ok(brief.traps.length < 30);
    assert.ok(brief.notices.length > 0);
    assert.ok(brief.notices[0].includes('truncated'));

    // Critical/High severity traps should be retained before low severity
    const severities = brief.traps.map((t) => t.frontmatter.severity);
    assert.ok(severities.includes('critical'));
  });

  it('should include active slice spec and plan when slug is specified', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'spec',
      slug: 'auth-flow',
      frontmatter: {
        id: 'spec-auth-flow',
        title: 'Authentication Flow Specification'
      },
      body: 'Specification body for auth flow'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'plan',
      slug: 'auth-flow',
      frontmatter: {
        id: 'plan-auth-flow',
        title: 'Authentication Implementation Plan'
      },
      body: 'Delivery plan for auth flow'
    });

    const brief = await compileBootstrapBrief({
      cwd: tempProject,
      vaultRoot: tempVault,
      slug: 'auth-flow'
    });

    assert.ok(brief.activeSlice);
    assert.equal(brief.activeSlice.slug, 'auth-flow');
    assert.ok(brief.activeSlice.spec);
    assert.equal(brief.activeSlice.spec.frontmatter.title, 'Authentication Flow Specification');
    assert.ok(brief.activeSlice.plan);
    assert.equal(brief.activeSlice.plan.frontmatter.title, 'Authentication Implementation Plan');
  });

  it('should detect spec drift when linked file differs from verifiedAtSha', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'spec',
      slug: 'drifted-spec',
      frontmatter: {
        id: 'spec-drifted-spec',
        title: 'Drifted Spec',
        status: 'active',
        linkedPaths: ['src/dummy.ts'],
        verifiedAtSha: 'old-commit-sha-000000000000000000000000'
      },
      body: 'Spec body'
    });

    const brief = await compileBootstrapBrief({
      cwd: tempProject,
      vaultRoot: tempVault
    });

    assert.ok(brief.drift);
    assert.equal(brief.drift.length, 1);
    assert.equal(brief.drift[0].specSlug, 'spec-drifted-spec');
    assert.deepEqual(brief.drift[0].modifiedPaths, ['src/dummy.ts']);
    assert.ok(brief.notices.some((n) => n.includes('Spec drift detected')));
  });
});

