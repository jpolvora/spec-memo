import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ProjectIdentity, ProjectMetadata, VaultConfig } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { getPackageVersion } from './version.js';
import { logErrorReport } from './error-logger.js';
import { writeVaultGitState } from './vault-git-state.js';
import { safeVaultGitError } from './vault-git-redact.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_VAULT_CONFIG: VaultConfig = {
  get version() {
    return getPackageVersion();
  },
  defaultRemote: 'origin',
  enableTelemetry: true,
  telemetry: {
    maxFileSizeMb: 10,
    flushIntervalMs: 500,
    maxQueueSize: 50
  },
  ttl: {
    scratchDays: 7,
    reviewDays: 14
  },
  bootstrap: {
    maxBytes: 8192,
    maxTraps: 10
  },
  ports: {
    sse: 3123,
    status: 3124,
    canvas: 3125
  }
};

export function resolveConfiguredPorts(vaultRoot?: string, config?: VaultConfig): { sse: number; status: number; canvas: number } {
  const cfg = config || ensureVaultStructure(vaultRoot);
  const sse = cfg.ports?.sse ?? cfg.ports?.mcp ?? DEFAULT_VAULT_CONFIG.ports?.sse ?? 3123;
  const status = cfg.ports?.status ?? cfg.ports?.ui ?? DEFAULT_VAULT_CONFIG.ports?.status ?? 3124;
  const canvas = cfg.ports?.canvas ?? DEFAULT_VAULT_CONFIG.ports?.canvas ?? 3125;
  return { sse, status, canvas };
}

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
  'scratch',
  'prompts',
  'sessions'
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
 * Default vault location when no override, env, or bootstrap pointer is usable.
 */
export function getDefaultVaultRoot(): string {
  return path.join(os.homedir(), '.spec-memo');
}

/**
 * True when `target` exists as a writable directory, or can be created (writable ancestor).
 */
export function isUsableVaultRoot(target: string): boolean {
  if (!target || target.trim().length === 0) {
    return false;
  }
  const resolved = path.resolve(target.trim());
  try {
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (!st.isDirectory()) {
        return false;
      }
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    }

    let current = resolved;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        try {
          fs.accessSync(current, fs.constants.W_OK);
          return true;
        } catch {
          return false;
        }
      }
      if (fs.existsSync(parent)) {
        const st = fs.statSync(parent);
        if (!st.isDirectory()) {
          return false;
        }
        fs.accessSync(parent, fs.constants.W_OK);
        return true;
      }
      current = parent;
    }
  } catch {
    return false;
  }
}

function firstUsableVaultRoot(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) {
      continue;
    }
    const resolved = path.resolve(candidate.trim());
    if (isUsableVaultRoot(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

/**
 * Path to bootstrap config.json in the user home (may point at a non-home vault via vaultRoot).
 */
export function getBootstrapConfigPath(): string {
  return path.join(os.homedir(), '.spec-memo', 'config.json');
}

/**
 * Read vaultRoot pointer from bootstrap config without resolving getVaultRoot (avoids recursion).
 */
export function readBootstrapVaultRootPointer(
  bootstrapConfigPath: string = getBootstrapConfigPath()
): string | undefined {
  if (!fs.existsSync(bootstrapConfigPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(bootstrapConfigPath, 'utf8')) as Record<string, unknown>;
    const root = parsed.vaultRoot;
    if (typeof root === 'string' && root.trim().length > 0) {
      return path.resolve(root.trim());
    }
  } catch {
    // Ignore malformed bootstrap config; fall through to defaults.
  }
  return undefined;
}

/**
 * When cwd looks like a vault root (config.json + projects/), use it as an implicit vault root.
 */
export function probeVaultRootFromCwd(cwd: string = process.cwd()): string | undefined {
  const configPath = path.join(cwd, 'config.json');
  const projectsDir = path.join(cwd, 'projects');
  if (fs.existsSync(configPath) && fs.existsSync(projectsDir)) {
    return path.resolve(cwd);
  }
  return undefined;
}

/**
 * Persist default vault root in bootstrap ~/.spec-memo/config.json.
 */
export function writeBootstrapVaultRoot(
  vaultRoot: string,
  bootstrapConfigPath: string = getBootstrapConfigPath()
): string {
  const resolved = path.resolve(vaultRoot);
  const bootstrapDir = path.dirname(bootstrapConfigPath);
  if (!fs.existsSync(bootstrapDir)) {
    fs.mkdirSync(bootstrapDir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(bootstrapConfigPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(bootstrapConfigPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  existing.vaultRoot = resolved;
  fs.writeFileSync(bootstrapConfigPath, JSON.stringify(existing, null, 2), 'utf8');
  return bootstrapConfigPath;
}

/**
 * Resolves the root directory of the spec-memo vault.
 * Priority: override argument > SPEC_MEMO_ROOT env > bootstrap config vaultRoot >
 *           cwd vault probe > ~/.spec-memo
 * Unusable candidates (missing permissions, not a directory, not creatable) are skipped.
 * Always returns a path; last resort is getDefaultVaultRoot() even if currently inaccessible.
 */
export function getVaultRoot(overridePath?: string): string {
  const resolved = firstUsableVaultRoot([
    overridePath,
    process.env.SPEC_MEMO_ROOT,
    readBootstrapVaultRootPointer(),
    probeVaultRootFromCwd()
  ]);
  return resolved ?? getDefaultVaultRoot();
}

function mergeParsedVaultConfig(parsed: Record<string, any>): VaultConfig {
  const rawPorts = parsed.ports && typeof parsed.ports === 'object' ? parsed.ports : {};
  const parsedSse = rawPorts.sse ?? rawPorts.mcp;
  const parsedStatus = rawPorts.status ?? rawPorts.ui;
  const parsedCanvas = rawPorts.canvas;

  return {
    ...DEFAULT_VAULT_CONFIG,
    ...parsed,
    enableTelemetry:
      parsed.enableTelemetry !== undefined ? Boolean(parsed.enableTelemetry) : DEFAULT_VAULT_CONFIG.enableTelemetry,
    telemetry: { ...DEFAULT_VAULT_CONFIG.telemetry, ...(parsed.telemetry || {}) },
    ttl: { ...DEFAULT_VAULT_CONFIG.ttl, ...(parsed.ttl || {}) },
    bootstrap: { ...DEFAULT_VAULT_CONFIG.bootstrap, ...(parsed.bootstrap || {}) },
    ports: {
      sse: parsedSse ?? DEFAULT_VAULT_CONFIG.ports?.sse ?? 3123,
      status: parsedStatus ?? DEFAULT_VAULT_CONFIG.ports?.status ?? 3124,
      canvas: parsedCanvas ?? DEFAULT_VAULT_CONFIG.ports?.canvas ?? 3125,
      ...(rawPorts.mcp !== undefined ? { mcp: rawPorts.mcp } : {}),
      ...(rawPorts.ui !== undefined ? { ui: rawPorts.ui } : {})
    }
  };
}

function validateParsedVaultConfig(parsed: Record<string, any>): string | null {
  if (parsed.mode !== undefined) {
    const modes = ['local', 'hybrid', 'remote'];
    if (typeof parsed.mode !== 'string' || !modes.includes(parsed.mode)) {
      return `Invalid config.json: mode must be local|hybrid|remote (got ${JSON.stringify(parsed.mode)})`;
    }
  }
  if (parsed.ports !== undefined) {
    if (typeof parsed.ports !== 'object' || parsed.ports === null || Array.isArray(parsed.ports)) {
      return 'Invalid config.json: ports must be an object';
    }
    for (const [key, value] of Object.entries(parsed.ports)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return `Invalid config.json: ports.${key} must be a positive integer`;
      }
    }
  }
  if (parsed.vaultRoot !== undefined) {
    if (typeof parsed.vaultRoot !== 'string' || parsed.vaultRoot.trim().length === 0) {
      return 'Invalid config.json: vaultRoot must be a non-empty string path';
    }
  }
  return null;
}

/**
 * Read-only vault config loader. Never creates directories or writes files.
 */
export function readVaultConfig(vaultRoot: string = getVaultRoot()): {
  config: VaultConfig;
  configValid: boolean;
  issues: string[];
} {
  const root = path.resolve(vaultRoot);
  const configPath = path.join(root, 'config.json');
  const issues: string[] = [];
  let configValid = true;
  let config: VaultConfig = { ...DEFAULT_VAULT_CONFIG };

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, any>;
      const typeError = validateParsedVaultConfig(parsed);
      if (typeError) {
        configValid = false;
        issues.push(typeError);
      } else {
        config = mergeParsedVaultConfig(parsed);
      }
    } catch (err: unknown) {
      configValid = false;
      issues.push(`Malformed config.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { config, configValid, issues };
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
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, any>;
      config = mergeParsedVaultConfig(parsed);
    } catch {
      // If config corrupted, keep defaults
    }
  } else {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_VAULT_CONFIG, null, 2), 'utf8');
  }

  const telemetryDir = path.join(root, 'telemetry');
  if (!fs.existsSync(telemetryDir)) {
    fs.mkdirSync(telemetryDir, { recursive: true });
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

export const REQUIRED_VAULT_GITIGNORE = [
  'memo.sqlite',
  'memo.sqlite-wal',
  'memo.sqlite-shm',
  '.sync/',
  'error.logs',
  'telemetry/'
];

export interface CommitVaultChangeOptions {
  force?: boolean;
  skipRemote?: boolean;
}

export interface VaultGitChannelResult {
  ok: boolean;
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  message: string;
  error?: string;
  skipped?: boolean;
  wouldCommit?: string[];
}

export interface FlushVaultGitOptions {
  dryRun?: boolean;
  trigger?: string;
  sessionId?: string;
}

export function getGitTimeoutMs(): number {
  const envVal = Number(process.env.SPEC_MEMO_SYNC_TIMEOUT_MS);
  return envVal > 0 ? envVal : 30000;
}

/** AC24: graceful shutdown flush cap (default 8000 ms, override SPEC_MEMO_SYNC_TIMEOUT_MS). */
export function getShutdownFlushMs(): number {
  const envVal = Number(process.env.SPEC_MEMO_SYNC_TIMEOUT_MS);
  return envVal > 0 ? envVal : 8000;
}

export function resolveVaultGitAtomic(config: VaultConfig): boolean {
  const vg = config.vaultGit;
  if (!vg || vg.enabled !== true) return false;
  if (typeof vg.atomic === 'boolean') return vg.atomic;
  if (typeof vg.autoCommit === 'boolean') return vg.autoCommit;
  return false;
}

export function redactVaultGitRemoteUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/\/([^/@:\s]+):([^@/]+)@/g, '//***:***@');
}

function readVaultConfigLoose(vaultRoot: string): VaultConfig | null {
  const configPath = path.join(vaultRoot, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as VaultConfig;
  } catch {
    return null;
  }
}

function gitExec(
  vaultRoot: string,
  args: string[],
  phase: 'init' | 'commit' | 'pull' | 'push' | 'flush' | 'orchestrate'
): { ok: boolean; stdout: string; error?: string } {
  const timeout = getGitTimeoutMs();
  try {
    const stdout = execFileSync('git', args, {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout
    });
    return { ok: true, stdout: stdout || '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const config = readVaultConfigLoose(vaultRoot);
    logErrorReport(
      {
        subsystem: 'vault-git',
        mode: config?.mode,
        error: err,
        context: { phase, gitArgs: args.slice(0, 4) }
      },
      { vaultRoot }
    );
    return { ok: false, stdout: '', error: msg };
  }
}

async function gitExecAsync(
  vaultRoot: string,
  args: string[],
  phase: 'init' | 'commit' | 'pull' | 'push' | 'flush' | 'orchestrate'
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const timeout = getGitTimeoutMs();
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: vaultRoot,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      killSignal: 'SIGKILL'
    });
    return { ok: true, stdout: stdout || '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const config = readVaultConfigLoose(vaultRoot);
    logErrorReport(
      {
        subsystem: 'vault-git',
        mode: config?.mode,
        error: err,
        context: { phase, gitArgs: args.slice(0, 4) }
      },
      { vaultRoot }
    );
    return { ok: false, stdout: '', error: msg };
  }
}

function ensureVaultGitignore(vaultRoot: string): void {
  const gitignorePath = path.join(vaultRoot, '.gitignore');
  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
  }
  const lines = existing.split(/\r?\n/);
  const have = new Set(lines.map((l) => l.trim()).filter(Boolean));
  const missing = REQUIRED_VAULT_GITIGNORE.filter((entry) => !have.has(entry));
  if (missing.length === 0 && existing.length > 0) return;
  const prefix = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
  fs.writeFileSync(gitignorePath, `${prefix}${missing.join('\n')}\n`, 'utf8');
}

/**
 * AC1: Initializes git repository in vault if vaultGit.enabled is true.
 */
export function initVaultGit(vaultRoot: string = getVaultRoot()): boolean {
  const config = readVaultConfigLoose(vaultRoot);
  if (!config) return false;

  try {
    if (!config.vaultGit?.enabled) return false;
    if (config.mode === 'remote') return false;

    const gitDir = path.join(vaultRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      const init = gitExec(vaultRoot, ['init'], 'init');
      if (!init.ok) return false;
    }

    ensureVaultGitignore(vaultRoot);

    if (config.vaultGit.remoteUrl) {
      const add = gitExec(vaultRoot, ['remote', 'add', 'origin', config.vaultGit.remoteUrl], 'init');
      if (!add.ok) {
        gitExec(vaultRoot, ['remote', 'set-url', 'origin', config.vaultGit.remoteUrl], 'init');
      }
    }
    return true;
  } catch (err: unknown) {
    logErrorReport(
      {
        subsystem: 'vault-git',
        mode: config.mode,
        error: err,
        context: { phase: 'init' }
      },
      { vaultRoot }
    );
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
 * AC2: Auto-commits record mutations when vaultGit is enabled and atomic (or force).
 * Stages only `paths` (or projects + config.json), never the entire vault tree.
 */
export function commitVaultChange(
  message: string,
  vaultRoot: string = getVaultRoot(),
  paths: string[] = [],
  options: CommitVaultChangeOptions = {}
): boolean {
  const config = readVaultConfigLoose(vaultRoot);
  if (!config) return false;

  try {
    acquireVaultLockSync(vaultRoot);
    try {
      if (!config.vaultGit?.enabled) return false;
      if (config.mode === 'remote') return false;
      if (!options.force && !resolveVaultGitAtomic(config)) return false;

      initVaultGit(vaultRoot);

      const toAdd = resolveVaultCommitAddPaths(vaultRoot, paths);
      if (toAdd.length === 0) return false;

      const addRes = gitExec(vaultRoot, ['add', '--', ...toAdd], 'commit');
      if (!addRes.ok) {
        writeVaultGitState(vaultRoot, { dirty: true, lastError: addRes.error || 'git add failed' });
        return false;
      }
      const commitRes = gitExec(vaultRoot, ['commit', '-m', message], 'commit');
      if (!commitRes.ok) {
        writeVaultGitState(vaultRoot, { dirty: true, lastError: commitRes.error || 'git commit failed' });
        return false;
      }
      return true;
    } finally {
      releaseVaultLockSync(vaultRoot);
    }
  } catch (err: unknown) {
    logErrorReport(
      {
        subsystem: 'vault-git',
        mode: config.mode,
        error: err,
        context: { phase: 'commit' }
      },
      { vaultRoot }
    );
    try {
      writeVaultGitState(vaultRoot, {
        dirty: true,
        lastError: err instanceof Error ? err.message : String(err)
      });
    } catch {
      // state write must never throw into callers
    }
    return false;
  } finally {
    if (!options.skipRemote && resolveVaultGitAtomic(config) && config.vaultGit?.remoteUrl) {
      scheduleVaultGitRemoteSync(vaultRoot);
    }
  }
}

const gitRemoteInFlight = new Map<string, Promise<void>>();
const gitRemotePending = new Set<string>();

export function scheduleVaultGitRemoteSync(vaultRoot: string): void {
  const key = path.resolve(vaultRoot);
  if (gitRemoteInFlight.has(key)) {
    gitRemotePending.add(key);
    return;
  }
  const job = syncVaultRemote(vaultRoot)
    .catch(() => undefined)
    .finally(() => {
      gitRemoteInFlight.delete(key);
      if (gitRemotePending.delete(key)) {
        scheduleVaultGitRemoteSync(vaultRoot);
      }
    });
  gitRemoteInFlight.set(key, job);
}

export async function flushScheduledVaultGit(): Promise<void> {
  while (gitRemoteInFlight.size > 0) {
    await Promise.all([...gitRemoteInFlight.values()]);
  }
}

function vaultGitPorcelain(
  vaultRoot: string
): { ok: true; porcelain: string } | { ok: false; error: string } {
  const res = gitExec(
    vaultRoot,
    ['status', '--porcelain', '--untracked-files=normal', '--', 'projects', 'config.json', '.gitignore'],
    'flush'
  );
  if (!res.ok) {
    return { ok: false, error: res.error || 'git status failed' };
  }
  return { ok: true, porcelain: (res.stdout || '').trim() };
}

async function syncVaultRemote(vaultRoot: string): Promise<void> {
  await flushVaultGit(vaultRoot, { dryRun: false, trigger: 'remote-follow' });
}

async function withVaultGitRemoteExclusive<T>(
  vaultRoot: string,
  trigger: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (trigger === 'remote-follow') {
    return fn();
  }
  const key = path.resolve(vaultRoot);
  await flushScheduledVaultGit();
  while (gitRemoteInFlight.has(key)) {
    await gitRemoteInFlight.get(key);
  }
  const job = fn();
  const tracked = job.then(
    () => undefined,
    () => undefined
  );
  gitRemoteInFlight.set(key, tracked);
  try {
    return await job;
  } finally {
    gitRemoteInFlight.delete(key);
    if (gitRemotePending.delete(key)) {
      scheduleVaultGitRemoteSync(vaultRoot);
    }
  }
}

/**
 * Commit dirty vault-git paths (force) then pull/push without holding the vault lock during network.
 */
export async function flushVaultGit(
  vaultRoot: string = getVaultRoot(),
  options: FlushVaultGitOptions = {}
): Promise<VaultGitChannelResult> {
  const config = readVaultConfigLoose(vaultRoot);
  if (!config) {
    return {
      ok: false,
      committed: false,
      pulled: false,
      pushed: false,
      message: 'Vault config.json not found.',
      error: 'Vault config.json not found.'
    };
  }
  if (!config.vaultGit?.enabled || config.mode === 'remote') {
    return {
      ok: true,
      committed: false,
      pulled: false,
      pushed: false,
      skipped: true,
      message: 'Vault git sync is disabled in config.json.'
    };
  }

  try {
    initVaultGit(vaultRoot);
    const statusRes = vaultGitPorcelain(vaultRoot);
    if (!statusRes.ok) {
      const err = safeVaultGitError(statusRes.error)!;
      writeVaultGitState(vaultRoot, { dirty: true, lastError: statusRes.error });
      return {
        ok: false,
        committed: false,
        pulled: false,
        pushed: false,
        message: `Sync failed: ${err}`,
        error: err
      };
    }
    const porcelain = statusRes.porcelain;
    const wouldCommit = porcelain
      ? porcelain
          .split('\n')
          .map((l) => l.slice(3).trim())
          .filter(Boolean)
      : [];

    if (options.dryRun) {
      return {
        ok: true,
        committed: false,
        pulled: false,
        pushed: false,
        wouldCommit,
        message: `Dry-run: ${wouldCommit.length} path(s) would commit`
      };
    }

    let committed = false;
    if (porcelain.length > 0) {
      const trigger = options.trigger || 'sync';
      const iso = new Date().toISOString();
      const sessionBit = options.sessionId ? ` session ${options.sessionId}` : '';
      const message =
        trigger === 'session_end' || trigger === 'shutdown' || trigger === 'sync' || trigger === 'remote-follow'
          ? `vault-git flush ${iso}${sessionBit}`
          : `vault-git flush ${iso}${sessionBit}`;
      committed = commitVaultChange(message, vaultRoot, [], { force: true, skipRemote: true });
      if (!committed) {
        const localErr = 'Local vault-git commit failed';
        writeVaultGitState(vaultRoot, { dirty: true, lastError: localErr });
        return {
          ok: false,
          committed: false,
          pulled: false,
          pushed: false,
          message: `Sync failed: ${localErr}`,
          error: localErr
        };
      }
    }

    let pulled = false;
    let pushed = false;
    let remoteError: string | undefined;
    if (config.vaultGit.remoteUrl) {
      await withVaultGitRemoteExclusive(vaultRoot, options.trigger, async () => {
        const branch = resolveVaultGitBranch(config, vaultRoot);
        const pullRes = await gitExecAsync(vaultRoot, ['pull', '--rebase', 'origin', branch], 'pull');
        pulled = pullRes.ok;
        if (!pullRes.ok) {
          remoteError = pullRes.error;
        } else {
          const pushRes = await gitExecAsync(vaultRoot, ['push', '-u', 'origin', branch], 'push');
          pushed = pushRes.ok;
          if (!pushRes.ok) remoteError = pushRes.error;
        }
      });
    }

    const hasRemote = Boolean(config.vaultGit.remoteUrl);
    const localOk = !hasRemote ? porcelain.length === 0 || committed : true;
    const channelOk = hasRemote ? pulled && pushed && !remoteError : localOk;
    writeVaultGitState(vaultRoot, {
      dirty: Boolean(remoteError) || (hasRemote && committed && !pushed),
      lastError: remoteError || null,
      lastSyncAt: new Date().toISOString()
    });

    return {
      ok: channelOk,
      committed,
      pulled,
      pushed,
      message: `Sync complete (pulled: ${pulled}, pushed: ${pushed})`,
      error: safeVaultGitError(remoteError)
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErrorReport(
      {
        subsystem: 'vault-git',
        mode: config.mode,
        error: err,
        context: { phase: 'flush' }
      },
      { vaultRoot }
    );
    try {
      writeVaultGitState(vaultRoot, { dirty: true, lastError: msg });
    } catch {
      // ignore
    }
    const safeMsg = safeVaultGitError(msg)!;
    return { ok: false, committed: false, pulled: false, pushed: false, message: `Sync failed: ${safeMsg}`, error: safeMsg };
  }
}

/**
 * AC3: Sync local vault with private git remote (pull/push).
 */
export async function syncVault(
  vaultRoot: string = getVaultRoot()
): Promise<VaultGitChannelResult> {
  return flushVaultGit(vaultRoot, { trigger: 'sync' });
}


