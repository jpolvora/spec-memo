import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promoteRecord } from './promote.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';

describe('Promote Engine (promoteRecord)', () => {
  let tempDir: string;
  let tempVaultRoot: string;
  let tempProductRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-promote-test-'));
    tempVaultRoot = path.join(tempDir, 'vault');
    tempProductRepo = path.join(tempDir, 'product-repo');

    fs.mkdirSync(tempVaultRoot, { recursive: true });
    fs.mkdirSync(path.join(tempProductRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tempProductRepo, 'README.md'), '# Test Product Repo\n', 'utf8');
  });

  afterEach(() => {
    closeIndex(tempVaultRoot);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should successfully promote a decision record into the product repository', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'adr-001-storage',
      frontmatter: {
        id: 'adr-001-storage',
        title: 'Use SQLite FTS5 for local search index',
        status: 'active',
        decisionStatus: 'accepted'
      },
      body: '## Rationale\nSQLite FTS5 provides zero-dependency full text search.'
    });

    const result = await promoteRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      id: 'adr-001-storage',
      destination: 'docs/adr/001-storage.md'
    });

    assert.equal(result.id, 'adr-001-storage');
    assert.equal(result.kind, 'decision');
    assert.equal(result.destination, 'docs/adr/001-storage.md');
    assert.ok(fs.existsSync(result.targetPath));

    const writtenContent = fs.readFileSync(result.targetPath, 'utf8');
    assert.ok(writtenContent.includes('Use SQLite FTS5 for local search index'));
    assert.ok(writtenContent.includes('SQLite FTS5 provides zero-dependency full text search.'));
  });

  it('should reject promote when destination already exists without force flag', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'spec',
      slug: 'feature-spec',
      frontmatter: {
        id: 'feature-spec',
        title: 'Feature Spec Title'
      },
      body: 'Spec body'
    });

    const destFile = path.join(tempProductRepo, 'docs', 'spec.md');
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.writeFileSync(destFile, 'Existing file content', 'utf8');

    await assert.rejects(
      async () => {
        await promoteRecord({
          cwd: tempProductRepo,
          vaultRoot: tempVaultRoot,
          id: 'feature-spec',
          destination: 'docs/spec.md'
        });
      },
      {
        message: /already exists/
      }
    );

    // With force: true, overwrite succeeds
    const result = await promoteRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      id: 'feature-spec',
      destination: 'docs/spec.md',
      force: true
    });

    assert.equal(result.destination, 'docs/spec.md');
    const updatedContent = fs.readFileSync(destFile, 'utf8');
    assert.ok(updatedContent.includes('Feature Spec Title'));
  });

  it('should enforce default-deny when target destination is outside the product repository', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'adr-002',
      frontmatter: {
        id: 'adr-002',
        title: 'ADR 2'
      },
      body: 'Body'
    });

    const outsidePath = path.join(tempDir, 'outside-product', 'leak.md');

    await assert.rejects(
      async () => {
        await promoteRecord({
          cwd: tempProductRepo,
          vaultRoot: tempVaultRoot,
          id: 'adr-002',
          destination: outsidePath
        });
      },
      {
        message: /Safety violation \(Default Deny\)/
      }
    );

    await assert.rejects(
      async () => {
        await promoteRecord({
          cwd: tempProductRepo,
          vaultRoot: tempVaultRoot,
          id: 'adr-002',
          destination: '../outside.md'
        });
      },
      {
        message: /Safety violation \(Default Deny\)/
      }
    );
  });

  it('should reject promote when record ID does not exist', async () => {
    await assert.rejects(
      async () => {
        await promoteRecord({
          cwd: tempProductRepo,
          vaultRoot: tempVaultRoot,
          id: 'non-existent-record',
          destination: 'docs/adr/test.md'
        });
      },
      {
        message: /Record not found/
      }
    );
  });
});
