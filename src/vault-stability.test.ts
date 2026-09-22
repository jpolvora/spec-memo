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
      '- [ ] Virtual File System (`spec: 0027-virtual-file-system-over-mcp.spec.md`)\n- [x] prompt-history (`0029-prompt-history-and-query.spec.md`)\n',
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
