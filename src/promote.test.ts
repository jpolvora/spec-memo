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

  it('should reject promote when target destination is inside .git directory', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'adr-git-target',
      frontmatter: {
        id: 'adr-git-target',
        title: 'ADR Git Target'
      },
      body: 'Body'
    });

    await assert.rejects(
      async () => {
        await promoteRecord({
          cwd: tempProductRepo,
          vaultRoot: tempVaultRoot,
          id: 'adr-git-target',
          destination: '.git/hooks/pre-commit'
        });
      },
      {
        message: /Promote destination must not target \.git directory/
      }
    );
  });

  it('should format decision records as standard ADR when requested or when format=adr', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'adr-002-crypto',
      frontmatter: {
        id: 'adr-002-crypto',
        title: 'Use AES-256-GCM for encrypted vault backups',
        status: 'active',
        tags: ['security', 'encryption']
      },
      body: 'AES-256-GCM provides authenticated encryption with associated data.'
    });

    const result = await promoteRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      id: 'adr-002-crypto',
      destination: 'docs/adr/002-crypto.md',
      format: 'adr'
    });

    assert.equal(result.format, 'adr');
    const content = fs.readFileSync(result.targetPath, 'utf8');
    assert.ok(content.includes('# ADR: Use AES-256-GCM for encrypted vault backups'));
    assert.ok(content.includes('## Context and Problem Statement'));
    assert.ok(content.includes('## Decision Outcome'));
    assert.ok(content.includes('## Consequences'));
    assert.ok(content.includes('AES-256-GCM provides authenticated encryption'));
  });

  it('should format decision records as MADR when format=madr', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'adr-003-logging',
      frontmatter: {
        id: 'adr-003-logging',
        title: 'Use monthly log roll-ups for curator compaction',
        status: 'active'
      },
      body: 'Roll-ups prevent filesystem inode exhaustion while preserving FTS searchability.'
    });

    const result = await promoteRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      id: 'adr-003-logging',
      destination: 'docs/adr/003-logging.md',
      format: 'madr'
    });

    assert.equal(result.format, 'madr');
    const content = fs.readFileSync(result.targetPath, 'utf8');
    assert.ok(content.includes('# Use monthly log roll-ups for curator compaction'));
    assert.ok(content.includes('Technical Story: `adr-003-logging`'));
    assert.ok(content.includes('## Decision Drivers'));
    assert.ok(content.includes('## Considered Options'));
    assert.ok(content.includes('## Decision Outcome'));
  });

  it('should automatically resolve destination file path when directory is specified', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'decision',
      slug: 'storage-architecture',
      frontmatter: {
        id: 'storage-architecture',
        title: 'Storage Architecture'
      },
      body: 'External vault filesystem isolation.'
    });

    const result = await promoteRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      id: 'storage-architecture',
      destination: 'docs/architecture/'
    });

    assert.equal(result.destination, 'docs/architecture/0001-storage-architecture.md');
    assert.ok(fs.existsSync(result.targetPath));
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
