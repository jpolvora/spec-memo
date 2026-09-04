import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCanonicalProjectId,
  setProjectAlias,
  mergeVaultProjects,
  createVaultProject,
  readProjectAliases,
  removeProjectAlias,
  deleteVaultProject,
  VaultManagerError,
  getVaultProjectListEnriched
} from './vault-manager.js';
import { resolveProjectIdentity } from './identity.js';
import { ensureVaultStructure } from './vault.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';

describe('vault-manager', () => {
  let tempVault: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mgr-'));
    ensureVaultStructure(tempVault);
  });

  afterEach(() => {
    closeIndex(tempVault);
    try {
      fs.rmSync(tempVault, { recursive: true, force: true });
    } catch {
      // Windows EBUSY on sqlite — best effort
    }
  });

  function scaffoldProject(id: string): void {
    const dir = path.join(tempVault, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const sub of ['traps', 'decisions', 'specs', 'plans', 'logs', 'reviews', 'scratch', 'prompts', 'sessions']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(
      path.join(dir, 'project.json'),
      JSON.stringify({ displayName: id, updated: new Date().toISOString() }, null, 2),
      'utf8'
    );
  }

  it('resolveCanonicalProjectId follows alias chain', async () => {
    scaffoldProject('marchanterp');
    scaffoldProject('marchanterp-vault-name-1');
    scaffoldProject('marchanterp-vault-name-2');
    await setProjectAlias('marchanterp-vault-name-1', 'marchanterp', tempVault);
    await setProjectAlias('marchanterp-vault-name-2', 'marchanterp', tempVault);
    assert.equal(resolveCanonicalProjectId('marchanterp-vault-name-1', tempVault), 'marchanterp');
    assert.equal(resolveCanonicalProjectId('marchanterp-vault-name-2', tempVault), 'marchanterp');
  });

  it('A→B then B→A alias attempt leaves config unchanged (AC32)', async () => {
    scaffoldProject('proj-a');
    scaffoldProject('proj-b');
    await setProjectAlias('proj-a', 'proj-b', tempVault);
    const before = readProjectAliases(tempVault);
    await assert.rejects(
      () => setProjectAlias('proj-b', 'proj-a', tempVault),
      (err: unknown) => err instanceof VaultManagerError
    );
    const after = readProjectAliases(tempVault);
    assert.deepEqual(after, before);
  });

  it('resolveProjectIdentity follows projectAliases to canonical vault path (AC2/AC4)', async () => {
    scaffoldProject('canonical');
    scaffoldProject('alias-src');
    await setProjectAlias('alias-src', 'canonical', tempVault);
    const aliasCwd = path.join(tempVault, 'projects', 'alias-src');
    const identity = resolveProjectIdentity(aliasCwd, { vaultRoot: tempVault });
    assert.equal(identity.projectId, 'canonical');
    assert.equal(identity.vaultProjectPath, path.join(tempVault, 'projects', 'canonical'));
  });

  it('removeProjectAlias clears alias row (AC17)', async () => {
    scaffoldProject('canonical');
    scaffoldProject('alias-src');
    await setProjectAlias('alias-src', 'canonical', tempVault);
    await removeProjectAlias('alias-src', tempVault);
    assert.equal(readProjectAliases(tempVault)['alias-src'], undefined);
  });

  it('deleteVaultProject requires confirm (AC18)', async () => {
    scaffoldProject('doomed');
    await assert.rejects(
      () => deleteVaultProject({ id: 'doomed', confirm: false, vaultRoot: tempVault }),
      (err: unknown) => err instanceof VaultManagerError
    );
  });

  it('deleteVaultProject blocks canonical target with incoming aliases unless force (AC19)', async () => {
    scaffoldProject('canonical');
    scaffoldProject('alias-src');
    await setProjectAlias('alias-src', 'canonical', tempVault);
    await assert.rejects(
      () => deleteVaultProject({ id: 'canonical', confirm: true, vaultRoot: tempVault }),
      (err: unknown) => err instanceof VaultManagerError && (err as VaultManagerError).httpStatus === 409
    );
  });

  it('merge with copyRecords copies active records into target', async () => {
    scaffoldProject('src-a');
    scaffoldProject('target');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'src-a',
      kind: 'trap',
      slug: 'trap-one',
      frontmatter: { title: 'Trap one', severity: 'high' },
      body: 'Do not do X'
    });
    const result = await mergeVaultProjects({
      sources: ['src-a'],
      target: 'target',
      copyRecords: true,
      vaultRoot: tempVault
    });
    assert.equal(result.copied, 1);
    const list = getVaultProjectListEnriched(tempVault);
    const target = list.find((p) => p.id === 'target');
    assert.ok(target && target.recordCount >= 1);
    assert.equal(readProjectAliases(tempVault)['src-a'], 'target');
  });

  it('merge alias-only does not copy records', async () => {
    scaffoldProject('src-only');
    scaffoldProject('tgt-only');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'src-only',
      kind: 'decision',
      slug: 'dec-1',
      frontmatter: { title: 'Decision' },
      body: 'We chose A'
    });
    const result = await mergeVaultProjects({
      sources: ['src-only'],
      target: 'tgt-only',
      copyRecords: false,
      vaultRoot: tempVault
    });
    assert.equal(result.copied, 0);
    const list = getVaultProjectListEnriched(tempVault);
    const tgt = list.find((p) => p.id === 'tgt-only');
    assert.ok(tgt && tgt.recordCount === 0);
  });

  it('create rejects invalid ids', async () => {
    await assert.rejects(
      () => createVaultProject('BAD ID!', 'Bad', tempVault),
      (err: unknown) => err instanceof VaultManagerError
    );
  });

  it('getVaultProjectListEnriched includes aliasOf and recordCount', async () => {
    scaffoldProject('p1');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'p1',
      kind: 'trap',
      slug: 't1',
      frontmatter: { title: 'T', severity: 'low' },
      body: 'body'
    });
    const list = getVaultProjectListEnriched(tempVault);
    const row = list.find((p) => p.id === 'p1');
    assert.ok(row);
    assert.equal(row.aliasOf, null);
    assert.ok(row.recordCount >= 1);
  });
});
