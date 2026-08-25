import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { exportVault, importVault } from './backup.js';
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
});
