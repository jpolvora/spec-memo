import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ProjectIdentity, ProjectMetadata, VaultConfig } from './types.js';
import { resolveProjectIdentity } from './identity.js';

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  version: '0.4.0',
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

export function resolveVaultRoot(overridePath?: string): string {
  return getVaultRoot(overridePath);
}

export function getVaultProjects(vaultRoot: string = getVaultRoot()): Array<{ id: string; name: string }> {
  const projectsDir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, name: e.name }));
}

export function initVault(options: { vaultRoot?: string; projectId?: string; displayName?: string } = {}): { root: string } {
  const root = getVaultRoot(options.vaultRoot);
  ensureVaultStructure(root);
  if (options.projectId) {
    const projDir = path.join(root, 'projects', options.projectId);
    if (!fs.existsSync(projDir)) {
      fs.mkdirSync(projDir, { recursive: true });
    }
  }
  return { root };
}

export const RECORD_SUBDIRS = [
  'traps',
  'decisions',
  'specs',
  'plans',
  'logs',
  'reviews',
  'scratch'
] as const;

const vaultLockDepth = new Map<string, number>();
const vaultLockFds = new Map<string, number>();

function waitMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireVaultLockSync(vaultRoot: string): void {
  const key = path.resolve(vaultRoot);
  const depth = vaultLockDepth.get(key) || 0;
  if (depth > 0) {
    vaultLockDepth.set(key, depth + 1);
    return;
  }

  if (!fs.existsSync(key)) {
    fs.mkdirSync(key, { recursive: true });
  }
  const lockPath = path.join(key, '.memo.lock');
  const deadline = Date.now() + 8000;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 10000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // lock disappeared or unreadable
        }
      }
      if (code !== 'EEXIST' || Date.now() >= deadline) {
        throw err;
      }
      waitMs(50);
    }
  }
  fs.writeSync(fd, String(process.pid));
  vaultLockFds.set(key, fd);
  vaultLockDepth.set(key, 1);
}

function releaseVaultLockSync(vaultRoot: string): void {
  const key = path.resolve(vaultRoot);
  const depth = (vaultLockDepth.get(key) || 1) - 1;
  if (depth > 0) {
    vaultLockDepth.set(key, depth);
    return;
  }
  vaultLockDepth.delete(key);
  const fd = vaultLockFds.get(key);
  vaultLockFds.delete(key);
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
  try {
    fs.unlinkSync(path.join(key, '.memo.lock'));
  } catch {
    // ignore
  }
}

/**
 * Exclusive vault lock (re-entrant in-process; file lock across processes).
 */
export async function withVaultLock<T>(vaultRoot: string, fn: () => T | Promise<T>): Promise<T> {
  acquireVaultLockSync(vaultRoot);
  try {
    return await fn();
  } finally {
    releaseVaultLockSync(vaultRoot);
  }
}

export function withVaultLockSync<T>(vaultRoot: string, fn: () => T): T {
  acquireVaultLockSync(vaultRoot);
  try {
    return fn();
  } finally {
    releaseVaultLockSync(vaultRoot);
  }
}

function resolveVaultGitBranch(config: VaultConfig, vaultRoot: string): string {
  if (config.vaultGit?.branch && config.vaultGit.branch.trim().length > 0) {
    return config.vaultGit.branch.trim();
  }
  try {
    const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (current && current !== 'HEAD') {
      return current;
    }
  } catch {
    // uninitialized or detached
  }
  return 'master';
}

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
 * Paths to `git add` for a vault auto-commit. Never `.` — that sweeps unrelated dirty files.
 */
function resolveVaultCommitAddPaths(vaultRoot: string, paths: string[]): string[] {
  const raw = paths.length > 0 ? paths : ['projects', 'config.json'];
  const normalized: string[] = [];
  for (const p of raw) {
    const rel = path.isAbsolute(p) ? path.relative(vaultRoot, p) : p;
    const posix = rel.replace(/\\/g, '/');
    if (!posix || posix === '.' || posix.startsWith('../') || posix === '..') continue;
    if (!normalized.includes(posix)) normalized.push(posix);
  }
  if (fs.existsSync(path.join(vaultRoot, '.gitignore')) && !normalized.includes('.gitignore')) {
    normalized.push('.gitignore');
  }
  return normalized;
}

/**
 * AC2: Auto-commits record mutations in vault if vaultGit is enabled.
 * Stages only `paths` (or projects + config.json), never the entire vault tree.
 */
export function commitVaultChange(
  message: string,
  vaultRoot: string = getVaultRoot(),
  paths: string[] = []
): boolean {
  const configPath = path.join(vaultRoot, 'config.json');
  if (!fs.existsSync(configPath)) return false;

  try {
    acquireVaultLockSync(vaultRoot);
    try {
      const config: VaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.vaultGit?.enabled) return false;

      initVaultGit(vaultRoot);

      const toAdd = resolveVaultCommitAddPaths(vaultRoot, paths);
      if (toAdd.length === 0) return false;

      execFileSync('git', ['add', '--', ...toAdd], { cwd: vaultRoot, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', message], { cwd: vaultRoot, stdio: 'ignore' });
      return true;
    } finally {
      releaseVaultLockSync(vaultRoot);
    }
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
    return withVaultLockSync(vaultRoot, () => {
      const config: VaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!config.vaultGit?.enabled) {
        return { pulled: false, pushed: false, message: 'Vault git sync is disabled in config.json.' };
      }

      initVaultGit(vaultRoot);

      let pulled = false;
      let pushed = false;

      try {
        const branch = resolveVaultGitBranch(config, vaultRoot);
        execFileSync('git', ['pull', '--rebase', 'origin', branch], { cwd: vaultRoot, stdio: 'ignore' });
        pulled = true;
      } catch {
        // Pull optional fallback
      }

      try {
        const branch = resolveVaultGitBranch(config, vaultRoot);
        execFileSync('git', ['push', '-u', 'origin', branch], { cwd: vaultRoot, stdio: 'ignore' });
        pushed = true;
      } catch {
        // Push optional fallback
      }

      return {
        pulled,
        pushed,
        message: `Sync complete (pulled: ${pulled}, pushed: ${pushed})`
      };
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pulled: false, pushed: false, message: `Sync failed: ${msg}` };
  }
}


