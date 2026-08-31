import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resetVault,
  listBackups,
  formatBackupFilename,
  restoreVault,
  exportVault
} from './backup.js';
import { ensureVaultStructure } from './vault.js';
import { upsertRecord } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spec-memo-test-${prefix}-`));
}

test('formatBackupFilename produces YYYY-MM-DD-HH-mm-ss-backup.zip format', () => {
  const d = new Date(2026, 7, 31, 14, 30, 45); // Month index 7 = August (08)
  const fn = formatBackupFilename(d);
  assert.equal(fn, '2026-08-31-14-30-45-backup.zip');
  assert.match(fn, /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-backup\.zip$/);
});

test('resetVault performs full wipe after creating pre-wipe zip backup and preserves config.json and backups/', async () => {
  const tmpRoot = createTempDir('reset-full');
  try {
    ensureVaultStructure(tmpRoot);

    // Create custom config.json
    const configPath = path.join(tmpRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ mode: 'local', testKey: 'preserved' }, null, 2));

    // Upsert some records across 2 projects
    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'proj-alpha',
      kind: 'trap',
      slug: 'trap-one',
      frontmatter: { id: 'trap-proj-alpha-trap-one', kind: 'trap', severity: 'high', title: 'Alpha Trap' },
      body: 'Alpha trap details'
    });

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'proj-beta',
      kind: 'decision',
      slug: 'dec-one',
      frontmatter: { id: 'decision-proj-beta-dec-one', kind: 'decision', title: 'Beta Decision' },
      body: 'Beta decision details'
    });

    // Verify records exist in search before reset
    const preSearch = searchIndex({ query: 'details', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(preSearch.length, 2);

    // Execute resetVault (full reset)
    const result = await resetVault({ vaultRoot: tmpRoot, all: true });

    assert.equal(result.ok, true);
    assert.ok(result.wipedProjectsCount >= 2);
    assert.equal(result.wipedRecordsCount, 2);
    assert.equal(result.rebuiltFts, true);
    assert.ok(result.backupFilename.endsWith('-backup.zip'));
    assert.ok(fs.existsSync(result.backupPath));
    assert.ok(fs.statSync(result.backupPath).size > 0);

    // Verify config.json preserved
    assert.ok(fs.existsSync(configPath));
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(savedConfig.testKey, 'preserved');

    // Verify projects directory is empty / clean
    const projectsDir = path.join(tmpRoot, 'projects');
    assert.deepEqual(fs.readdirSync(projectsDir), []);

    // Verify search is clean (0 records)
    const postSearch = searchIndex({ query: 'details', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(postSearch.length, 0);

    // Verify listBackups returns the pre-wipe backup
    const backups = listBackups(tmpRoot);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].filename, result.backupFilename);
    assert.equal(backups[0].isZip, true);

    // Test restoring from the pre-wipe ZIP backup
    const restoreRes = await restoreVault({
      vaultRoot: tmpRoot,
      archivePath: result.backupPath
    });

    assert.ok(restoreRes.restoredProjectsCount >= 2);
    assert.equal(restoreRes.restoredRecordsCount, 2);

    // Verify records are back and searchable
    const restoredSearch = searchIndex({ query: 'details', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(restoredSearch.length, 2);
  } finally {
    closeIndex(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resetVault single project resets only the targeted project', async () => {
  const tmpRoot = createTempDir('reset-single');
  try {
    ensureVaultStructure(tmpRoot);

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'keep-project',
      kind: 'trap',
      slug: 'trap-keep',
      frontmatter: { id: 'trap-keep-project-trap-keep', kind: 'trap', severity: 'low', title: 'Keep Trap' },
      body: 'Keep this record'
    });

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'wipe-project',
      kind: 'trap',
      slug: 'trap-wipe',
      frontmatter: { id: 'trap-wipe-project-trap-wipe', kind: 'trap', severity: 'critical', title: 'Wipe Trap' },
      body: 'Wipe this record'
    });

    const res = await resetVault({ vaultRoot: tmpRoot, projectId: 'wipe-project', all: false });

    assert.equal(res.ok, true);
    assert.equal(res.wipedProjectsCount, 1);
    assert.equal(res.wipedRecordsCount, 1);
    assert.equal(res.projectId, 'wipe-project');

    // keep-project should remain intact
    assert.ok(fs.existsSync(path.join(tmpRoot, 'projects', 'keep-project')));
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'projects', 'wipe-project')));

    // Search should find only keep-project
    const searchRes = searchIndex({ query: 'record', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].id, 'trap-keep-project-trap-keep');
  } finally {
    closeIndex(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resetVault with password creates encrypted backup archive', async () => {
  const tmpRoot = createTempDir('reset-enc');
  try {
    ensureVaultStructure(tmpRoot);

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'secret-proj',
      kind: 'trap',
      slug: 'secret-trap',
      frontmatter: { id: 'trap-secret-proj-secret-trap', kind: 'trap', severity: 'high', title: 'Secret Trap' },
      body: 'Top secret memory'
    });

    const resetRes = await resetVault({
      vaultRoot: tmpRoot,
      all: true,
      password: 'vault-secret-pass'
    });

    assert.equal(resetRes.ok, true);
    assert.ok(fs.existsSync(resetRes.backupPath));

    // Attempt restoring with wrong password should fail
    await assert.rejects(async () => {
      await restoreVault({
        vaultRoot: tmpRoot,
        archivePath: resetRes.backupPath,
        password: 'wrong-pass'
      });
    }, /Decryption failed/);

    // Restoring with correct password should succeed
    const restoreRes = await restoreVault({
      vaultRoot: tmpRoot,
      archivePath: resetRes.backupPath,
      password: 'vault-secret-pass'
    });

    assert.equal(restoreRes.restoredRecordsCount, 1);
    const searchRes = searchIndex({ query: 'secret', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(searchRes.length, 1);
  } finally {
    closeIndex(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resetVault and restoreVault preserve prompts and sessions records', async () => {
  const tmpRoot = createTempDir('reset-prompts');
  try {
    ensureVaultStructure(tmpRoot);

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'proj-prompt-history',
      kind: 'prompt',
      slug: 'prompt-one',
      frontmatter: { id: 'prompt-proj-prompt-history-prompt-one', kind: 'prompt', title: 'Test Prompt Record' },
      body: 'Always check RECORD_SUBDIRS during vault backup'
    });

    await upsertRecord({
      vaultRoot: tmpRoot,
      projectId: 'proj-prompt-history',
      kind: 'session',
      slug: 'session-one',
      frontmatter: { id: 'session-proj-prompt-history-session-one', kind: 'session', title: 'Test Session Record' },
      body: 'Session for vault reset and restore validation'
    });

    const resetRes = await resetVault({ vaultRoot: tmpRoot, all: true });
    assert.equal(resetRes.ok, true);
    assert.equal(resetRes.wipedRecordsCount, 2);

    const restoreRes = await restoreVault({
      vaultRoot: tmpRoot,
      archivePath: resetRes.backupPath
    });
    assert.equal(restoreRes.restoredRecordsCount, 2);

    const restoredSearch = searchIndex({ query: 'RECORD_SUBDIRS', vaultRoot: tmpRoot, crossProject: true });
    assert.equal(restoredSearch.length, 1);
    assert.equal(restoredSearch[0].id, 'prompt-proj-prompt-history-prompt-one');
  } finally {
    closeIndex(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
