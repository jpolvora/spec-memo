import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureVaultStructure } from './vault.js';
import { auditVaultProjects } from './vault-manager.js';
import { scanSpecLifecycleDrift } from './spec-lifecycle.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';

describe('vault stability audit helpers', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-audit-'));
    ensureVaultStructure(tempVault);
  });

  afterEach(() => {
    closeIndex(tempVault);
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('audits alias leftover records and quarantines MarchanteERP', async () => {
    const cfgPath = path.join(tempVault, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.projectAliases = { 'workflowos-alias': 'workflowos' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    for (const id of ['workflowos', 'workflowos-alias', 'MarchanteERP']) {
      fs.mkdirSync(path.join(tempVault, 'projects', id, 'traps'), { recursive: true });
    }
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'workflowos-alias',
      kind: 'trap',
      slug: 'alias-leftover',
      body: 'leftover'
    });
    const audit = auditVaultProjects(tempVault);
    const alias = audit.find((p) => p.id === 'workflowos-alias');
    const erp = audit.find((p) => p.id === 'MarchanteERP');
    assert.ok(alias?.leftoverRecordsOnAlias);
    assert.equal(erp?.quarantine, true);
  });

  it('does not treat virtual-file-system-over-mcp as lifecycle drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-specs-'));
    const specs = path.join(root, '.agents', 'specs');
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(
      path.join(specs, 'index.PRD'),
      '- [ ] Virtual File System (`spec: 0027-virtual-file-system-over-mcp.spec.md`)\n- [x] prompt-history (`0029-prompt-history-and-query.spec.md`)\n## Archive\n| Slug | Outcome |\n| virtual-file-system-over-mcp | wont-implement |\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(specs, '0027-virtual-file-system-over-mcp.spec.md'),
      '---\nstatus: draft\n---\n# VFS\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(specs, '0029-prompt-history-and-query.spec.md'),
      '---\nstatus: draft\n---\n# Prompt\n',
      'utf8'
    );
    const drift = scanSpecLifecycleDrift(root);
    assert.equal(
      drift.some((d) => d.slug.includes('virtual-file-system')),
      false
    );
    assert.ok(drift.some((d) => d.slug.includes('0029')));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('vault stability baseline module (AC1-AC4)', () => {
  it('classifies residue with evidence and never deletes plan artifacts', async () => {
    const { classifyWorkflowResidue } = await import('./vault-stability.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stability-residue-'));
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, '# plan');
    const before = fs.readdirSync(dir);
    const now = Date.now();
    const out = classifyWorkflowResidue([
      { rel: '.agents/plans/a/step.md', mtimeMs: now - 1000, workflowStatus: 'active', nowMs: now },
      { rel: '.agents/plans/b/step.md', mtimeMs: now - 1000, workflowStatus: 'completed', nowMs: now },
      { rel: '.agents/plans/c/step.md', mtimeMs: now - 30 * 86400000, nowMs: now }
    ]);
    assert.equal(out[0].verdict, 'active');
    assert.match(out[0].evidence, /state status/);
    assert.equal(out[1].verdict, 'completed');
    assert.equal(out[2].verdict, 'stale');
    assert.deepEqual(fs.readdirSync(dir), before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks destructive work until backup plus review plus confirm', async () => {
    const { requireDestructiveGate } = await import('./vault-stability.js');
    assert.throws(() => requireDestructiveGate({ backupFresh: false, manifestsReviewed: true, explicitConfirm: true }), /fresh backup/);
    assert.throws(() => requireDestructiveGate({ backupFresh: true, manifestsReviewed: false, explicitConfirm: true }), /reviewed manifests/);
    assert.throws(() => requireDestructiveGate({ backupFresh: true, manifestsReviewed: true, explicitConfirm: false }), /explicit confirmation/);
    assert.equal(requireDestructiveGate({ backupFresh: true, manifestsReviewed: true, explicitConfirm: true }), true);
  });

  it('takes a read-only baseline snapshot', async () => {
    const { snapshotBaseline } = await import('./vault-stability.js');
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'stability-vault-'));
    const before = fs.readdirSync(vault);
    const snap = snapshotBaseline(vault);
    assert.equal(snap.files, 0);
    assert.equal(typeof snap.idsHash, 'string');
    assert.deepEqual(fs.readdirSync(vault), before);
    fs.rmSync(vault, { recursive: true, force: true });
  });
  it('AC26: tracking metadata reconciled for shipped slices', () => {
    const root = process.cwd();
    const index = fs.readFileSync(path.join(root, '.agents/specs/index.PRD'), 'utf8');
    for (const slug of ['0057-status-ai-ops-logs', '0029-prompt-history-and-query', '0051-us-55', '0052-us-54', '0060-open-github-issues-batch', '0063-ai-ops-test-ai-button', '0064-ai-timeout-config']) {
      assert.ok(fs.existsSync(path.join(root, '.agents/specs', slug + '.spec.md')), slug);
      assert.ok(index.includes(slug), slug);
    }
  });

});
