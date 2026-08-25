import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ProjectIdentity, ProjectMetadata, VaultConfig } from './types.js';
import { resolveProjectIdentity } from './identity.js';

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  version: '0.1.0',
  defaultRemote: 'origin',
  ttl: {
    scratchDays: 7,
    reviewDays: 14
  },
  bootstrap: {
    maxBytes: 8192,
    maxTraps: 10
  }
};

export const RECORD_SUBDIRS = [
  'traps',
  'decisions',
  'specs',
  'plans',
  'logs',
  'reviews',
  'scratch'
] as const;

/**
 * Resolves the root directory of the spec-memo vault.
 * Priority: override argument > SPEC_MEMO_ROOT env var > ~/.spec-memo
 */
export function getVaultRoot(overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    return path.resolve(overridePath);
  }
  if (process.env.SPEC_MEMO_ROOT && process.env.SPEC_MEMO_ROOT.trim().length > 0) {
    return path.resolve(process.env.SPEC_MEMO_ROOT);
  }
  return path.join(os.homedir(), '.spec-memo');
}

/**
 * Initializes the global vault structure (~/.spec-memo/) and returns active config.
 */
export function ensureVaultStructure(vaultRoot: string = getVaultRoot()): VaultConfig {
  const root = path.resolve(vaultRoot);
  const projectsDir = path.join(root, 'projects');
  const configPath = path.join(root, 'config.json');

  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  let config: VaultConfig = { ...DEFAULT_VAULT_CONFIG };

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = {
        ...DEFAULT_VAULT_CONFIG,
        ...parsed,
        ttl: { ...DEFAULT_VAULT_CONFIG.ttl, ...(parsed.ttl || {}) },
        bootstrap: { ...DEFAULT_VAULT_CONFIG.bootstrap, ...(parsed.bootstrap || {}) }
      };
    } catch {
      // If config corrupted, keep defaults
    }
  } else {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_VAULT_CONFIG, null, 2), 'utf8');
  }

  return config;
}

/**
 * Scaffolds project-specific directories inside the vault and updates project.json.
 */
export function ensureProjectVault(
  identity: ProjectIdentity,
  vaultRoot: string = getVaultRoot()
): ProjectMetadata {
  ensureVaultStructure(vaultRoot);

  const projectDir = identity.vaultProjectPath;
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Create record subdirectories
  for (const subdir of RECORD_SUBDIRS) {
    const dirPath = path.join(projectDir, subdir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  const projectJsonPath = path.join(projectDir, 'project.json');
  const now = new Date().toISOString();

  let metadata: ProjectMetadata;

  if (fs.existsSync(projectJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
      metadata = {
        projectId: identity.projectId,
        gitRemote: identity.normalizedRemote || existing.gitRemote || null,
        displayName: existing.displayName || path.basename(identity.rootPath),
        lastSeenRoot: identity.rootPath,
        createdAt: existing.createdAt || now,
        updatedAt: now
      };
    } catch {
      metadata = {
        projectId: identity.projectId,
        gitRemote: identity.normalizedRemote,
        displayName: path.basename(identity.rootPath),
        lastSeenRoot: identity.rootPath,
        createdAt: now,
        updatedAt: now
      };
    }
  } else {
    metadata = {
      projectId: identity.projectId,
      gitRemote: identity.normalizedRemote,
      displayName: path.basename(identity.rootPath),
      lastSeenRoot: identity.rootPath,
      createdAt: now,
      updatedAt: now
    };
  }

  fs.writeFileSync(projectJsonPath, JSON.stringify(metadata, null, 2), 'utf8');

  return metadata;
}

/**
 * Get project metadata if already initialized in vault, or null.
 */
export function getProjectMetadata(
  projectId: string,
  vaultRoot: string = getVaultRoot()
): ProjectMetadata | null {
  const projectJsonPath = path.join(vaultRoot, 'projects', projectId, 'project.json');
  if (!fs.existsSync(projectJsonPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves the relocatable consumer hub storage directory.
 * Priority: memoRootOverride > $SPEC_MEMO_ROOT/projects/<projectId>
 */
export function resolveHubPath(
  cwd: string,
  memoRootOverride?: string,
  vaultRoot: string = getVaultRoot()
): string {
  if (memoRootOverride && memoRootOverride.trim().length > 0) {
    return path.resolve(memoRootOverride);
  }
  const identity = resolveProjectIdentity(cwd, { vaultRoot });
  ensureProjectVault(identity, vaultRoot);
  return identity.vaultProjectPath;
}

/**
 * AC1: Initializes git repository in vault if vaultGit.enabled is true.
 */
export function initVaultGit(vaultRoot: string = getVaultRoot()): boolean {
  const configPath = path.join(vaultRoot, 'config.json');
  if (!fs.existsSync(configPath)) return false;

  try {
    const config: VaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.vaultGit?.enabled) return false;

    const gitDir = path.join(vaultRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      execFileSync('git', ['init'], { cwd: vaultRoot, stdio: 'ignore' });
    }

    const gitignorePath = path.join(vaultRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, 'memo.sqlite\nmemo.sqlite-wal\nmemo.sqlite-shm\n', 'utf8');
    }

    if (config.vaultGit.remoteUrl) {
      try {
        execFileSync('git', ['remote', 'add', 'origin', config.vaultGit.remoteUrl], { cwd: vaultRoot, stdio: 'ignore' });
      } catch {
        execFileSync('git', ['remote', 'set-url', 'origin', config.vaultGit.remoteUrl], { cwd: vaultRoot, stdio: 'ignore' });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * AC2: Auto-commits record mutations in vault if vaultGit is enabled.
 */
export function commitVaultChange(message: string, vaultRoot: string = getVaultRoot()): boolean {
  const configPath = path.join(vaultRoot, 'config.json');
  if (!fs.existsSync(configPath)) return false;

  try {
    const config: VaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.vaultGit?.enabled) return false;

    initVaultGit(vaultRoot);

    execFileSync('git', ['add', '.'], { cwd: vaultRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], { cwd: vaultRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * AC3: Sync local vault with private git remote (pull/push).
 */
export function syncVault(vaultRoot: string = getVaultRoot()): { pulled: boolean; pushed: boolean; message: string } {
  const configPath = path.join(vaultRoot, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { pulled: false, pushed: false, message: 'Vault config.json not found.' };
  }

  try {
    const config: VaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.vaultGit?.enabled) {
      return { pulled: false, pushed: false, message: 'Vault git sync is disabled in config.json.' };
    }

    initVaultGit(vaultRoot);

    let pulled = false;
    let pushed = false;

    try {
      execFileSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: vaultRoot, stdio: 'ignore' });
      pulled = true;
    } catch {
      // Pull optional fallback
    }

    try {
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: vaultRoot, stdio: 'ignore' });
      pushed = true;
    } catch {
      // Push optional fallback
    }

    return {
      pulled,
      pushed,
      message: `Sync complete (pulled: ${pulled}, pushed: ${pushed})`
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pulled: false, pushed: false, message: `Sync failed: ${msg}` };
  }
}


