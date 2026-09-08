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
  renameVaultProject,
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

  it('AC14-AC17: renameVaultProject renames dir, project.json, aliases, FTS', async () => {
    scaffoldProject('rename-src');
    scaffoldProject('canonical-x');
    fs.writeFileSync(
      path.join(tempVault, 'projects', 'rename-src', 'project.json'),
      JSON.stringify({ projectId: 'rename-src', displayName: 'Src', updated: '2020-01-01T00:00:00.000Z' }, null, 2),
      'utf8'
    );
    await setProjectAlias('alias-in', 'rename-src', tempVault).catch(async () => {
      scaffoldProject('alias-in');
      await setProjectAlias('alias-in', 'rename-src', tempVault);
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'rename-src',
      kind: 'trap',
      slug: 'rename-trap',
      frontmatter: { title: 'Rename trap', severity: 'low' },
      body: 'rename body content here'
    });
    const result = await renameVaultProject('rename-src', 'rename-dst', tempVault);
    assert.equal(result.ok, true);
    assert.equal(result.from, 'rename-src');
    assert.equal(result.to, 'rename-dst');
    assert.ok(!fs.existsSync(path.join(tempVault, 'projects', 'rename-src')));
    assert.ok(fs.existsSync(path.join(tempVault, 'projects', 'rename-dst')));
    const meta = JSON.parse(fs.readFileSync(path.join(tempVault, 'projects', 'rename-dst', 'project.json'), 'utf8'));
    assert.equal(meta.projectId, 'rename-dst');
    assert.equal(readProjectAliases(tempVault)['alias-in'], 'rename-dst');
  });

  it('AC14: rename validates 400/404/409', async () => {
    scaffoldProject('r-a');
    scaffoldProject('r-b');
    await assert.rejects(() => renameVaultProject('r-a', 'r-a', tempVault), VaultManagerError);
    await assert.rejects(() => renameVaultProject('r-a', 'BAD ID!', tempVault), VaultManagerError);
    await assert.rejects(() => renameVaultProject('missing-src', 'r-c', tempVault), (e: unknown) => e instanceof VaultManagerError && e.httpStatus === 404);
    await assert.rejects(() => renameVaultProject('r-a', 'r-b', tempVault), (e: unknown) => e instanceof VaultManagerError && e.httpStatus === 409);
  });

  it('AC16: rename migrates incoming and outgoing aliases', async () => {
    scaffoldProject('from-proj');
    scaffoldProject('canonical-proj');
    scaffoldProject('incoming-proj');
    await setProjectAlias('incoming-proj', 'from-proj', tempVault);
    await setProjectAlias('from-proj', 'canonical-proj', tempVault);
    await renameVaultProject('from-proj', 'to-proj', tempVault);
    const aliases = readProjectAliases(tempVault);
    assert.equal(aliases['incoming-proj'], 'to-proj');
    assert.equal(aliases['to-proj'], 'canonical-proj');
    assert.equal(aliases['to-proj-to-proj'], undefined);
  });

  it('AC22-AC23 NS4: merge dedup consolidates duplicate traps (occurrences summed, single file)', async () => {
    scaffoldProject('dedup-src');
    scaffoldProject('dedup-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'dedup-tgt',
      kind: 'trap',
      slug: 'same-slug',
      frontmatter: { id: 'tgt-trap-1', title: 'Same Trap', severity: 'high', pathPatterns: ['src/a.ts'], occurrences: 2, hits: 3 },
      body: 'Close SQLite before unlink on Windows to avoid WAL lock errors alpha beta gamma delta'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'dedup-src',
      kind: 'trap',
      slug: 'same-slug',
      frontmatter: { id: 'src-trap-1', title: 'Same Trap', severity: 'high', pathPatterns: ['src/a.ts'], occurrences: 5, hits: 7 },
      body: 'Close SQLite before unlink on Windows to avoid WAL lock errors alpha beta gamma delta'
    });
    const result = await mergeVaultProjects({ sources: ['dedup-src'], target: 'dedup-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(result.copied, 0);
    assert.equal(result.deduplicated, 1);
    const { listProjectRecords } = await import('./store.js');
    const tgtRecords = listProjectRecords(tempVault, 'dedup-tgt').filter((r) => r.frontmatter.kind === 'trap');
    assert.equal(tgtRecords.length, 1);
    assert.equal(tgtRecords[0].frontmatter.occurrences, 7);
    assert.equal(tgtRecords[0].frontmatter.hits, 10);
  });

  it('AC22: merge detects title and semantic duplicates', async () => {
    scaffoldProject('sem-src');
    scaffoldProject('sem-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'sem-tgt',
      kind: 'trap',
      slug: 'tgt-slug',
      frontmatter: { title: 'SQLite WAL Lock', severity: 'high', pathPatterns: ['src/db.ts'] },
      body: 'Close SQLite before unlink on Windows alpha beta gamma delta epsilon zeta'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'sem-src',
      kind: 'trap',
      slug: 'src-slug',
      frontmatter: { title: '  sqlite   wal  lock ', severity: 'high', pathPatterns: ['src/db.ts'] },
      body: 'Close SQLite before unlink on Windows alpha beta gamma delta epsilon zeta'
    });
    const result = await mergeVaultProjects({ sources: ['sem-src'], target: 'sem-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(result.deduplicated, 1);
    assert.equal(result.copied, 0);
  });

  it('AC24: merge dedups decisions/specs/plans by slug or title', async () => {
    scaffoldProject('nt-src');
    scaffoldProject('nt-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'nt-tgt',
      kind: 'decision',
      slug: 'dec-slug',
      frontmatter: { title: 'Choose Postgres' },
      body: 'We chose Postgres for durability'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'nt-src',
      kind: 'decision',
      slug: 'dec-other',
      frontmatter: { title: '  CHOOSE   postgres ' },
      body: 'We chose Postgres for durability v2'
    });
    const result = await mergeVaultProjects({ sources: ['nt-src'], target: 'nt-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(result.deduplicated, 1);
    assert.equal(result.copied, 0);
  });

  it('AC25: merge returns copied/deduplicated/skipped counts', async () => {
    scaffoldProject('cnt-src');
    scaffoldProject('cnt-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'cnt-tgt',
      kind: 'trap',
      slug: 'dup',
      frontmatter: { id: 'same-id', title: 'Dup', severity: 'low' },
      body: 'dup body'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'cnt-src',
      kind: 'trap',
      slug: 'other',
      frontmatter: { id: 'same-id', title: 'Dup', severity: 'low' },
      body: 'dup body'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'cnt-src',
      kind: 'trap',
      slug: 'fresh',
      frontmatter: { title: 'Fresh', severity: 'low' },
      body: 'entirely fresh trap body unique tokens qzxw'
    });
    const result = await mergeVaultProjects({ sources: ['cnt-src'], target: 'cnt-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(typeof result.copied, 'number');
    assert.equal(typeof result.deduplicated, 'number');
    assert.equal(typeof result.skipped, 'number');
    assert.equal(result.skipped, 1);
    assert.equal(result.copied, 1);
  });

  it('AC26: merge deleteSources removes dirs but retains aliases', async () => {
    scaffoldProject('del-src');
    scaffoldProject('del-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'del-src',
      kind: 'trap',
      slug: 'del-trap',
      frontmatter: { title: 'Del', severity: 'low' },
      body: 'delete me body'
    });
    const result = await mergeVaultProjects({ sources: ['del-src'], target: 'del-tgt', copyRecords: true, deleteSources: true, vaultRoot: tempVault });
    assert.ok(result.copied >= 1 || result.deduplicated >= 1);
    assert.ok(!fs.existsSync(path.join(tempVault, 'projects', 'del-src')));
    assert.equal(readProjectAliases(tempVault)['del-src'], 'del-tgt');
    const again = await mergeVaultProjects({ sources: ['del-src'], target: 'del-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(again.copied, 0);
  });

  it('merge --no-dedup legacy path copies with deduplicated 0', async () => {
    scaffoldProject('nd-src');
    scaffoldProject('nd-tgt');
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'nd-tgt',
      kind: 'trap',
      slug: 'a',
      frontmatter: { title: 'A trap', severity: 'low', pathPatterns: ['src/x.ts'] },
      body: 'alpha beta gamma delta epsilon zeta eta theta'
    });
    await upsertRecord({
      vaultRoot: tempVault,
      projectId: 'nd-src',
      kind: 'trap',
      slug: 'b',
      frontmatter: { title: 'A trap', severity: 'low', pathPatterns: ['src/x.ts'] },
      body: 'alpha beta gamma delta epsilon zeta eta theta'
    });
    const result = await mergeVaultProjects({ sources: ['nd-src'], target: 'nd-tgt', copyRecords: true, dedup: false, vaultRoot: tempVault });
    assert.equal(result.deduplicated, 0);
    assert.equal(result.copied, 1);
  });

  it('merge deleteSources without copyRecords fails closed (review thread)', async () => {
    scaffoldProject('guard-src');
    scaffoldProject('guard-tgt');
    await assert.rejects(() => mergeVaultProjects({ sources: ['guard-src'], target: 'guard-tgt', deleteSources: true, vaultRoot: tempVault }), /deleteSources.*copyRecords/);
    assert.ok(fs.existsSync(path.join(tempVault, 'projects', 'guard-src')));
  });

  it('merge clears prior alias on target if target was previously aliased to source', async () => {
    scaffoldProject('prev-src');
    scaffoldProject('prev-tgt');
    await setProjectAlias('prev-tgt', 'prev-src', tempVault);
    const aliasesBefore = readProjectAliases(tempVault);
    assert.equal(aliasesBefore['prev-tgt'], 'prev-src');

    // Merging prev-src into prev-tgt should succeed and clear the alias on prev-tgt
    const result = await mergeVaultProjects({ sources: ['prev-src'], target: 'prev-tgt', copyRecords: true, vaultRoot: tempVault });
    assert.equal(result.ok, true);
    const aliasesAfter = readProjectAliases(tempVault);
    assert.equal(aliasesAfter['prev-tgt'], undefined);
    assert.equal(aliasesAfter['prev-src'], 'prev-tgt');
  });
});
