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
  RECORD_SUBDIRS,
  resolveConfiguredPorts,
  DEFAULT_VAULT_CONFIG,
  readBootstrapVaultRootPointer,
  writeBootstrapVaultRoot,
  probeVaultRootFromCwd,
  getDefaultVaultRoot,
  isUsableVaultRoot,
  tryAcquireVaultLockSync,
  releaseVaultLockSync,
  withVaultLockSync
} from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { getPackageVersion } from './version.js';

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
    assert.equal(config.version, getPackageVersion());
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

  it('should resolve vaultRoot from bootstrap config.json pointer', () => {
    const bootstrapDir = path.join(tempVaultRoot, 'bootstrap-home', '.spec-memo');
    const actualVault = path.join(tempVaultRoot, 'actual-vault');
    fs.mkdirSync(bootstrapDir, { recursive: true });
    fs.mkdirSync(actualVault, { recursive: true });

    const bootstrapConfig = writeBootstrapVaultRoot(actualVault, path.join(bootstrapDir, 'config.json'));
    const resolved = readBootstrapVaultRootPointer(bootstrapConfig);
    assert.equal(resolved, path.resolve(actualVault));
  });

  it('should prefer SPEC_MEMO_ROOT over bootstrap config vaultRoot pointer', () => {
    const bootstrapDir = path.join(tempVaultRoot, 'bootstrap-home-2', '.spec-memo');
    const actualVault = path.join(tempVaultRoot, 'actual-vault-2');
    const envVault = path.join(tempVaultRoot, 'env-vault');
    fs.mkdirSync(actualVault, { recursive: true });
    fs.mkdirSync(envVault, { recursive: true });
    writeBootstrapVaultRoot(actualVault, path.join(bootstrapDir, 'config.json'));

    const originalEnv = process.env.SPEC_MEMO_ROOT;
    try {
      process.env.SPEC_MEMO_ROOT = envVault;
      assert.equal(getVaultRoot(), path.resolve(envVault));
    } finally {
      process.env.SPEC_MEMO_ROOT = originalEnv;
    }
  });

  it('should probe vault root from cwd when directory contains config.json and projects/', () => {
    const vaultLikeDir = path.join(tempVaultRoot, 'vault-like');
    fs.mkdirSync(path.join(vaultLikeDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(vaultLikeDir, 'config.json'), '{}', 'utf8');

    const resolved = probeVaultRootFromCwd(vaultLikeDir);
    assert.equal(resolved, path.resolve(vaultLikeDir));
  });

  it('should prefer explicit override over bootstrap and env resolution', () => {
    const overrideVault = path.join(tempVaultRoot, 'override-vault');
    fs.mkdirSync(overrideVault, { recursive: true });
    assert.equal(getVaultRoot(overrideVault), path.resolve(overrideVault));
  });

  it('should skip an inaccessible configured path and fall back to the next usable candidate', () => {
    const notADir = path.join(tempVaultRoot, 'not-a-directory');
    fs.writeFileSync(notADir, 'blocked', 'utf8');
    assert.equal(isUsableVaultRoot(notADir), false);

    const originalEnv = process.env.SPEC_MEMO_ROOT;
    try {
      process.env.SPEC_MEMO_ROOT = notADir;
      const resolved = getVaultRoot();
      assert.notEqual(resolved, path.resolve(notADir));
      assert.equal(isUsableVaultRoot(resolved) || resolved === getDefaultVaultRoot(), true);
      assert.notEqual(getVaultRoot(notADir), path.resolve(notADir));
    } finally {
      process.env.SPEC_MEMO_ROOT = originalEnv;
    }
  });

  it('should treat a missing but creatable path as a usable vault root', () => {
    const missing = path.join(tempVaultRoot, 'new-vault-dir');
    assert.equal(fs.existsSync(missing), false);
    assert.equal(isUsableVaultRoot(missing), true);
    assert.equal(getVaultRoot(missing), path.resolve(missing));
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

  it('should support opt-in vault git initialization and sync when enabled in config.json', async () => {
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

    const committed = commitVaultChange('Initial test commit', tempVaultRoot, [], { force: true });
    assert.equal(committed, true);

    const tracked = execFileSync('git', ['ls-files'], {
      cwd: tempVaultRoot,
      encoding: 'utf8'
    });
    assert.equal(tracked.includes('scratch-unrelated.md'), false);
    assert.ok(tracked.includes('config.json'));

    const syncRes = await syncVault(tempVaultRoot);
    assert.ok(syncRes.message.includes('Sync complete'));
  });

  it('should initialize config.json with default ports (sse: 3123, status: 3124, canvas: 3125)', () => {
    const config = ensureVaultStructure(tempVaultRoot);
    assert.deepEqual(config.ports, {
      sse: 3123,
      status: 3124,
      canvas: 3125
    });

    const resolved = resolveConfiguredPorts(tempVaultRoot);
    assert.equal(resolved.sse, 3123);
    assert.equal(resolved.status, 3124);
    assert.equal(resolved.canvas, 3125);
  });

  it('should honor custom daemon ports configured in config.json', () => {
    ensureVaultStructure(tempVaultRoot);
    const configPath = path.join(tempVaultRoot, 'config.json');
    const customConfig = {
      ports: {
        sse: 4000,
        status: 4001,
        canvas: 4002
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(customConfig, null, 2), 'utf8');

    const loaded = ensureVaultStructure(tempVaultRoot);
    assert.equal(loaded.ports?.sse, 4000);
    assert.equal(loaded.ports?.status, 4001);
    assert.equal(loaded.ports?.canvas, 4002);

    const resolved = resolveConfiguredPorts(tempVaultRoot);
    assert.equal(resolved.sse, 4000);
    assert.equal(resolved.status, 4001);
    assert.equal(resolved.canvas, 4002);
  });

  it('should support daemon port aliases in config.json (mcp for sse, ui for status)', () => {
    ensureVaultStructure(tempVaultRoot);
    const configPath = path.join(tempVaultRoot, 'config.json');
    const customConfig = {
      ports: {
        mcp: 8888,
        ui: 8889
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(customConfig, null, 2), 'utf8');

    const resolved = resolveConfiguredPorts(tempVaultRoot);
    assert.equal(resolved.sse, 8888);
    assert.equal(resolved.status, 8889);
    assert.equal(resolved.canvas, 3125);
  });

  it('tryAcquireVaultLockSync acquires free lock and releases cleanly', () => {
    assert.equal(tryAcquireVaultLockSync(tempVaultRoot), true);
    assert.ok(fs.existsSync(path.join(tempVaultRoot, '.memo.lock')));
    releaseVaultLockSync(tempVaultRoot);
    assert.equal(fs.existsSync(path.join(tempVaultRoot, '.memo.lock')), false);
  });

  it('tryAcquireVaultLockSync is re-entrant within the holding process', () => {
    withVaultLockSync(tempVaultRoot, () => {
      assert.equal(tryAcquireVaultLockSync(tempVaultRoot), true);
      releaseVaultLockSync(tempVaultRoot);
    });
    assert.equal(fs.existsSync(path.join(tempVaultRoot, '.memo.lock')), false);
  });

  it('tryAcquireVaultLockSync returns false on a fresh foreign lock without waiting', () => {
    fs.mkdirSync(tempVaultRoot, { recursive: true });
    fs.writeFileSync(path.join(tempVaultRoot, '.memo.lock'), 'foreign-pid', 'utf8');
    const started = Date.now();
    assert.equal(tryAcquireVaultLockSync(tempVaultRoot), false);
    assert.ok(Date.now() - started < 2000, 'try-lock must not spin the 8s deadline');
    fs.unlinkSync(path.join(tempVaultRoot, '.memo.lock'));
  });

  it('tryAcquireVaultLockSync steals a stale foreign lock', () => {
    fs.mkdirSync(tempVaultRoot, { recursive: true });
    const lockPath = path.join(tempVaultRoot, '.memo.lock');
    fs.writeFileSync(lockPath, 'stale-pid', 'utf8');
    const stale = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, stale, stale);
    assert.equal(tryAcquireVaultLockSync(tempVaultRoot), true);
    releaseVaultLockSync(tempVaultRoot);
    assert.equal(fs.existsSync(lockPath), false);
  });
});


