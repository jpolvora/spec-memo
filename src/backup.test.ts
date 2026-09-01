import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { exportVault, importVault, persistVaultBackup, listBackups, deleteBackup, resolveBackupPath, inspectBackup } from './backup.js';
import { upsertRecord } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';

describe('Vault Backup & Encryption Engine (exportVault & importVault)', () => {
  let tempDir: string;
  let sourceVault: string;
  let targetVault: string;
  let productRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-backup-test-'));
    sourceVault = path.join(tempDir, 'source-vault');
    targetVault = path.join(tempDir, 'target-vault');
    productRepo = path.join(tempDir, 'product-repo');

    fs.mkdirSync(sourceVault, { recursive: true });
    fs.mkdirSync(targetVault, { recursive: true });
    fs.mkdirSync(productRepo, { recursive: true });
    fs.mkdirSync(path.join(productRepo, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeIndex(sourceVault);
    closeIndex(targetVault);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should export and import plaintext vault archive and rebuild FTS index', async () => {
    // Populate source vault
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'trap',
      slug: 'trap-01',
      frontmatter: {
        id: 'trap-01',
        title: 'Avoid shared directory mutation',
        severity: 'high'
      },
      body: 'Do not mutate {sharedDir} in consumer repository.'
    });

    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'decision',
      slug: 'adr-01',
      frontmatter: {
        id: 'adr-01',
        title: 'Use SQLite FTS'
      },
      body: 'Use SQLite FTS for fast keyword queries.'
    });

    const exportPath = path.join(tempDir, 'backup-plain.json');
    const exportRes = await exportVault({
      vaultRoot: sourceVault,
      outputPath: exportPath
    });

    assert.equal(exportRes.encrypted, false);
    assert.equal(exportRes.projectsCount, 1);
    assert.equal(exportRes.recordsCount, 2);
    assert.ok(fs.existsSync(exportPath));

    // Import into fresh target vault
    const importRes = await importVault({
      vaultRoot: targetVault,
      archivePath: exportPath
    });

    assert.equal(importRes.restoredProjectsCount, 1);
    assert.equal(importRes.restoredRecordsCount, 2);
    assert.equal(importRes.rebuiltFts, true);

    // Verify search works in target vault
    const searchRes = searchIndex({
      vaultRoot: targetVault,
      cwd: productRepo,
      query: 'shared directory'
    });

    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].id, 'trap-01');
  });

  it('should export and import encrypted vault archive with AES-256-GCM', async () => {
    // Populate source vault
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'spec',
      slug: 'secret-auth-spec',
      frontmatter: {
        id: 'secret-auth-spec',
        title: 'Secure Authentication Spec'
      },
      body: 'Architecture for air-gapped secure credential rotation.'
    });

    const exportPath = path.join(tempDir, 'backup-encrypted.json');
    const password = 'SuperSecretVaultPassword123!';

    const exportRes = await exportVault({
      vaultRoot: sourceVault,
      outputPath: exportPath,
      password
    });

    assert.equal(exportRes.encrypted, true);
    assert.ok(fs.existsSync(exportPath));

    const rawFileContent = fs.readFileSync(exportPath, 'utf8');
    assert.ok(!rawFileContent.includes('Secure Authentication Spec'), 'Ciphertext must not leak plaintext record content');
    assert.ok(rawFileContent.includes('spec-memo-encrypted-vault-v1'));

    // Reject import without password
    await assert.rejects(
      async () => {
        await importVault({
          vaultRoot: targetVault,
          archivePath: exportPath
        });
      },
      {
        message: /Password required to decrypt/
      }
    );

    // Reject import with wrong password
    await assert.rejects(
      async () => {
        await importVault({
          vaultRoot: targetVault,
          archivePath: exportPath,
          password: 'WrongPassword'
        });
      },
      {
        message: /Decryption failed/
      }
    );

    // Import with correct password
    const importRes = await importVault({
      vaultRoot: targetVault,
      archivePath: exportPath,
      password
    });

    assert.equal(importRes.restoredProjectsCount, 1);
    assert.equal(importRes.restoredRecordsCount, 1);

    // Verify search works in target vault
    const searchRes = searchIndex({
      vaultRoot: targetVault,
      cwd: productRepo,
      query: 'credential rotation'
    });

    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].id, 'secret-auth-spec');
  });

  it('should reject archive with path traversal relativePath segments', async () => {
    const maliciousArchive = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        projects: ['proj-1'],
        recordCount: 1
      },
      projects: [
        {
          projectId: 'proj-1',
          records: [
            {
              relativePath: '../../config.json',
              content: 'malicious payload'
            }
          ]
        }
      ]
    };

    const maliciousPath = path.join(tempDir, 'malicious.json');
    fs.writeFileSync(maliciousPath, JSON.stringify(maliciousArchive), 'utf8');

    await assert.rejects(
      async () => {
        await importVault({
          vaultRoot: targetVault,
          archivePath: maliciousPath
        });
      },
      {
        message: /Archive record path escapes project directory/
      }
    );
  });

  it('should reject archive with path traversal projectId segments', async () => {
    const maliciousProjArchive = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        projects: ['../../outside-vault'],
        recordCount: 1
      },
      projects: [
        {
          projectId: '../../outside-vault',
          records: [
            {
              relativePath: 'traps/escape.md',
              content: 'malicious payload'
            }
          ]
        }
      ]
    };

    const maliciousPath = path.join(tempDir, 'malicious-proj.json');
    fs.writeFileSync(maliciousPath, JSON.stringify(maliciousProjArchive), 'utf8');

    await assert.rejects(
      async () => {
        await importVault({
          vaultRoot: targetVault,
          archivePath: maliciousPath
        });
      },
      {
        message: /Archive project path escapes vault projects directory/
      }
    );
  });

  it('should reject archive containing hardcoded secrets', async () => {
    const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const secretArchive = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        projects: ['proj-1'],
        recordCount: 1
      },
      projects: [
        {
          projectId: 'proj-1',
          records: [
            {
              relativePath: 'traps/secret-trap.md',
              content: `---\nid: secret-trap\nkind: trap\nproject: proj-1\nstatus: active\nsource: agent\ncreated: 2026-08-25T00:00:00.000Z\nupdated: 2026-08-25T00:00:00.000Z\n---\nSecret key ${awsKey}`
            }
          ]
        }
      ]
    };

    const secretPath = path.join(tempDir, 'secret-archive.json');
    fs.writeFileSync(secretPath, JSON.stringify(secretArchive), 'utf8');

    await assert.rejects(
      async () => {
        await importVault({
          vaultRoot: targetVault,
          archivePath: secretPath
        });
      },
      {
        message: /Safety violation: Secret detected/
      }
    );
  });

  it('should restore vaultConfig to config.json on import', async () => {
    const archiveWithConfig = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        projects: ['proj-1'],
        recordCount: 1
      },
      vaultConfig: {
        version: 1,
        bootstrap: { maxBytes: 12345 },
        retention: { scratchDays: 5, reviewDays: 10 }
      },
      projects: [
        {
          projectId: 'proj-1',
          records: [
            {
              relativePath: 'traps/valid-trap.md',
              content: `---\nid: valid-trap\nkind: trap\nproject: proj-1\nstatus: active\nsource: agent\ncreated: 2026-08-25T00:00:00.000Z\nupdated: 2026-08-25T00:00:00.000Z\n---\nValid trap`
            }
          ]
        }
      ]
    };

    const archivePath = path.join(tempDir, 'archive-with-config.json');
    fs.writeFileSync(archivePath, JSON.stringify(archiveWithConfig), 'utf8');

    await importVault({
      vaultRoot: targetVault,
      archivePath
    });

    const targetConfigPath = path.join(targetVault, 'config.json');
    assert.ok(fs.existsSync(targetConfigPath));
    const restoredConfig = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8'));
    assert.equal(restoredConfig.bootstrap?.maxBytes, 12345);
  });

  it('should round-trip prompt and session records through export/import with FTS search', async () => {
    const projectId = 'proj-prompt-session-backup';
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      projectId,
      kind: 'prompt',
      slug: 'intent-one',
      frontmatter: {
        id: 'prompt-proj-prompt-session-backup-intent-one',
        kind: 'prompt',
        title: 'Intent story prompt'
      },
      body: 'Unique FTS marker prompt-session-roundtrip-alpha'
    });

    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      projectId,
      kind: 'session',
      slug: 'session-one',
      frontmatter: {
        id: 'session-proj-prompt-session-backup-session-one',
        kind: 'session',
        title: 'Work session',
        client: 'acme',
        billable: true,
        durationMinutes: 42
      },
      body: 'Session body for backup roundtrip validation'
    });

    const exportPath = path.join(tempDir, 'prompt-session-backup.json');
    const exportRes = await exportVault({ vaultRoot: sourceVault, projectId, outputPath: exportPath });
    assert.equal(exportRes.recordsCount, 2);

    await importVault({ vaultRoot: targetVault, archivePath: exportPath });

    const promptHits = searchIndex({
      vaultRoot: targetVault,
      cwd: productRepo,
      query: 'prompt-session-roundtrip-alpha',
      crossProject: true
    });
    assert.equal(promptHits.length, 1);
    assert.equal(promptHits[0].kind, 'prompt');

    const sessionHits = searchIndex({
      vaultRoot: targetVault,
      cwd: productRepo,
      query: 'backup roundtrip validation',
      crossProject: true
    });
    assert.equal(sessionHits.length, 1);
    assert.equal(sessionHits[0].kind, 'session');
  });

  it('should persist backup and list with recordCount metadata', async () => {
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'trap',
      slug: 'persist-list-trap',
      frontmatter: { id: 'trap-persist-list', title: 'Persist list trap', severity: 'low' },
      body: 'Trap for persistVaultBackup listBackups test'
    });

    const result = await persistVaultBackup({ vaultRoot: sourceVault });
    assert.ok(result.filename.endsWith('.zip'));
    assert.ok(result.recordCount >= 1);

    const listed = listBackups(sourceVault);
    const item = listed.find((b) => b.filename === result.filename);
    assert.ok(item);
    assert.ok(item!.recordCount != null && item!.recordCount >= 1);
    const inspected = inspectBackup(result.filename, { vaultRoot: sourceVault });
    assert.equal(inspected.recordCount, item!.recordCount);
    assert.equal(inspected.scope, item!.scope);
    // Full-vault persist with a single project must still report scope "full" (manifest intent).
    assert.equal(item!.scope, 'full');
    assert.ok(item!.recordsByKind && (item!.recordsByKind.trap || 0) >= 1);
  });

  it('should label project-scoped persist as scope project', async () => {
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'trap',
      slug: 'scoped-persist-trap',
      frontmatter: { id: 'trap-scoped-persist', title: 'Scoped', severity: 'low' },
      body: 'Project-scoped persist scope test'
    });
    const projects = fs.readdirSync(path.join(sourceVault, 'projects')).filter((n) =>
      fs.statSync(path.join(sourceVault, 'projects', n)).isDirectory()
    );
    assert.ok(projects.length >= 1);
    const result = await persistVaultBackup({ vaultRoot: sourceVault, projectId: projects[0] });
    const item = listBackups(sourceVault).find((b) => b.filename === result.filename);
    assert.ok(item);
    assert.equal(item!.scope, 'project');
    assert.ok(item!.recordsByKind && (item!.recordsByKind.trap || 0) >= 1);
  });

  it('should not infer scope project for legacy single-project archives missing manifest.scope', async () => {
    const backupsDir = path.join(sourceVault, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const legacy = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        projects: ['only-one'],
        recordCount: 1
      },
      projects: [
        {
          projectId: 'only-one',
          records: [
            {
              relativePath: 'traps/legacy.md',
              content:
                '---\nid: trap-legacy-scope\nkind: trap\nproject: only-one\nstatus: active\nsource: agent\ncreated: 2026-08-01T00:00:00.000Z\nupdated: 2026-08-01T00:00:00.000Z\n---\nLegacy trap'
            }
          ]
        }
      ]
    };
    fs.writeFileSync(path.join(backupsDir, 'legacy-one-project.json'), JSON.stringify(legacy), 'utf8');
    const listed = listBackups(sourceVault);
    const item = listed.find((b) => b.filename === 'legacy-one-project.json');
    assert.ok(item);
    assert.equal(item!.scope, undefined);
    const fullOnly = listBackups(sourceVault, { scope: 'full' });
    assert.equal(fullOnly.some((b) => b.filename === 'legacy-one-project.json'), false);
  });

  it('should infer scope full for legacy multi-project archives missing manifest.scope', async () => {
    const backupsDir = path.join(sourceVault, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const legacy = {
      format: 'spec-memo-vault-v1',
      manifest: {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        projects: ['a', 'b'],
        recordCount: 0
      },
      projects: [
        { projectId: 'a', records: [] },
        { projectId: 'b', records: [] }
      ]
    };
    fs.writeFileSync(path.join(backupsDir, 'legacy-two-project.json'), JSON.stringify(legacy), 'utf8');
    const item = listBackups(sourceVault).find((b) => b.filename === 'legacy-two-project.json');
    assert.ok(item);
    assert.equal(item!.scope, 'full');
  });

  it('should require existing file for deleteBackup and reject traversal in resolveBackupPath', async () => {
    assert.throws(
      () => resolveBackupPath(sourceVault, '../x.zip'),
      /Invalid backup filename/
    );

    await assert.rejects(
      async () => deleteBackup('nonexistent-backup.zip', sourceVault),
      /Backup not found/
    );
  });

  it('should write sidecar metadata on persist, list without unpacking, and remove sidecar on delete', async () => {
    await upsertRecord({
      cwd: productRepo,
      vaultRoot: sourceVault,
      kind: 'trap',
      slug: 'sidecar-trap',
      frontmatter: { id: 'trap-sidecar', title: 'Sidecar', severity: 'low' },
      body: 'Sidecar metadata test'
    });

    const result = await persistVaultBackup({ vaultRoot: sourceVault });
    const backupPath = path.join(sourceVault, 'backups', result.filename);
    const metaPath = `${backupPath}.meta.json`;
    assert.ok(fs.existsSync(metaPath));
    const sidecar = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      recordCount?: number;
      scope?: string;
      recordsByKind?: Record<string, number>;
    };
    assert.equal(sidecar.recordCount, result.recordCount);
    assert.equal(sidecar.scope, 'full');
    assert.ok(sidecar.recordsByKind && (sidecar.recordsByKind.trap || 0) >= 1);

    const listed = listBackups(sourceVault);
    assert.ok(!listed.some((b) => b.filename.endsWith('.meta.json')));
    const item = listed.find((b) => b.filename === result.filename);
    assert.ok(item);
    assert.equal(item!.recordCount, result.recordCount);
    assert.equal(item!.scope, 'full');

    await deleteBackup(result.filename, sourceVault);
    assert.ok(!fs.existsSync(backupPath));
    assert.ok(!fs.existsSync(metaPath));
  });
});
