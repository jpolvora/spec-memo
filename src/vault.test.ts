import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  getVaultRoot,
  ensureVaultStructure,
  ensureProjectVault,
  getProjectMetadata,
  resolveHubPath,
  initVaultGit,
  commitVaultChange,
  syncVault,
  RECORD_SUBDIRS
} from './vault.js';
import { resolveProjectIdentity } from './identity.js';

describe('Vault Management & Project Binding', () => {
  let tempVaultRoot: string;

  beforeEach(() => {
    tempVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-vault-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempVaultRoot, { recursive: true, force: true });
  });

  it('should initialize vault structure and default config.json without touching home dir', () => {
    const config = ensureVaultStructure(tempVaultRoot);
    assert.equal(config.version, '0.3.1');
    assert.equal(config.defaultRemote, 'origin');
    assert.equal(config.bootstrap.maxBytes, 8192);

    assert.ok(fs.existsSync(path.join(tempVaultRoot, 'config.json')));
    assert.ok(fs.existsSync(path.join(tempVaultRoot, 'projects')));
  });

  it('should respect SPEC_MEMO_ROOT environment variable', () => {
    const originalEnv = process.env.SPEC_MEMO_ROOT;
    try {
      process.env.SPEC_MEMO_ROOT = tempVaultRoot;
      const resolved = getVaultRoot();
      assert.equal(resolved, path.resolve(tempVaultRoot));
    } finally {
      process.env.SPEC_MEMO_ROOT = originalEnv;
    }
  });

  it('should scaffold all record subdirectories and project.json in project vault', () => {
    const identity = resolveProjectIdentity(process.cwd(), { vaultRoot: tempVaultRoot });
    const metadata = ensureProjectVault(identity, tempVaultRoot);

    assert.equal(metadata.projectId, 'github.com-jpolvora-spec-memo');
    assert.equal(metadata.gitRemote, 'github.com/jpolvora/spec-memo');
    assert.equal(metadata.lastSeenRoot, path.resolve(process.cwd()));
    assert.ok(metadata.createdAt);
    assert.ok(metadata.updatedAt);

    const projectDir = identity.vaultProjectPath;
    for (const subdir of RECORD_SUBDIRS) {
      assert.ok(fs.existsSync(path.join(projectDir, subdir)), `Missing subdir: ${subdir}`);
    }

    const fetched = getProjectMetadata(identity.projectId, tempVaultRoot);
    assert.ok(fetched);
    assert.equal(fetched.projectId, metadata.projectId);
  });

  it('should map two separate clone directories with the same git origin to the SAME projectId', () => {
    const clone1 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-clone1-'));
    const clone2 = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-clone2-'));

    try {
      // Mock .git/config in clone 1
      const gitDir1 = path.join(clone1, '.git');
      fs.mkdirSync(gitDir1, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir1, 'config'),
        '[remote "origin"]\n  url = git@github.com:myorg/shared-project.git\n'
      );

      // Mock .git/config in clone 2 (HTTPS with different auth/casing)
      const gitDir2 = path.join(clone2, '.git');
      fs.mkdirSync(gitDir2, { recursive: true });
      fs.writeFileSync(
        path.join(gitDir2, 'config'),
        '[remote "origin"]\n  url = https://token:secret@github.com/MyOrg/shared-project.git\n'
      );

      const identity1 = resolveProjectIdentity(clone1, { vaultRoot: tempVaultRoot });
      const identity2 = resolveProjectIdentity(clone2, { vaultRoot: tempVaultRoot });

      assert.equal(identity1.projectId, 'github.com-myorg-shared-project');
      assert.equal(identity2.projectId, 'github.com-myorg-shared-project');
      assert.equal(identity1.vaultProjectPath, identity2.vaultProjectPath);

      // Ensure vault created by clone 1 is updated by clone 2
      const meta1 = ensureProjectVault(identity1, tempVaultRoot);
      assert.equal(meta1.lastSeenRoot, path.resolve(clone1));

      const meta2 = ensureProjectVault(identity2, tempVaultRoot);
      assert.equal(meta2.lastSeenRoot, path.resolve(clone2));
      assert.equal(meta2.createdAt, meta1.createdAt); // createdAt preserved
    } finally {
      fs.rmSync(clone1, { recursive: true, force: true });
      fs.rmSync(clone2, { recursive: true, force: true });
    }
  });

  it('should assign fallback path ID to repo with no remotes', () => {
    const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-noremote-'));
    try {
      const gitDir = path.join(localRepo, '.git');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n  repositoryformatversion = 0\n');

      const identity = resolveProjectIdentity(localRepo, { vaultRoot: tempVaultRoot });
      assert.equal(identity.isGit, true);
      assert.equal(identity.isFallback, true);
      assert.equal(identity.normalizedRemote, null);
      assert.ok(identity.projectId.startsWith('local-'));

      const meta = ensureProjectVault(identity, tempVaultRoot);
      assert.equal(meta.gitRemote, null);
      assert.equal(meta.lastSeenRoot, path.resolve(localRepo));
    } finally {
      fs.rmSync(localRepo, { recursive: true, force: true });
    }
  });

  it('should resolve relocatable hub path dynamically to vault project path or custom memoRoot', () => {
    const defaultHub = resolveHubPath(process.cwd(), undefined, tempVaultRoot);
    const identity = resolveProjectIdentity(process.cwd(), { vaultRoot: tempVaultRoot });
    assert.equal(defaultHub, identity.vaultProjectPath);

    const customRoot = path.join(tempVaultRoot, 'custom-hub');
    const customHub = resolveHubPath(process.cwd(), customRoot, tempVaultRoot);
    assert.equal(customHub, path.resolve(customRoot));
  });

  it('should support opt-in vault git initialization and sync when enabled in config.json', () => {
    ensureVaultStructure(tempVaultRoot);
    const configPath = path.join(tempVaultRoot, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.vaultGit = {
      enabled: true,
      remoteUrl: 'git@github.com:myorg/vault-backup.git'
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

    const initialized = initVaultGit(tempVaultRoot);
    assert.equal(initialized, true);
    assert.ok(fs.existsSync(path.join(tempVaultRoot, '.git')));
    assert.ok(fs.existsSync(path.join(tempVaultRoot, '.gitignore')));

    fs.writeFileSync(path.join(tempVaultRoot, 'scratch-unrelated.md'), 'do not commit', 'utf8');

    const committed = commitVaultChange('Initial test commit', tempVaultRoot);
    assert.equal(committed, true);

    const tracked = execFileSync('git', ['ls-files'], {
      cwd: tempVaultRoot,
      encoding: 'utf8'
    });
    assert.equal(tracked.includes('scratch-unrelated.md'), false);
    assert.ok(tracked.includes('config.json'));

    const syncRes = syncVault(tempVaultRoot);
    assert.ok(syncRes.message.includes('Sync complete'));
  });
});


