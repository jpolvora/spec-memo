import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LocalSpecMemoConfig, ProjectIdentity, VaultConfig } from './types.js';
import { getVaultRoot, readVaultConfig } from './vault.js';
import { isPathInside, scanPayloadForSecrets } from './safety.js';
import { isFilesystemSafeProjectId, resolveCanonicalProjectId } from './vault-manager.js';

export const LOCAL_SPEC_MEMO_FILENAME = '.spec-memo.json';

const KNOWN_LOCAL_OVERRIDE_KEYS = ['bootstrap', 'ports', 'vaultGit', 'telemetry', 'ttl', 'sync'] as const;

const SECRET_KEY_PATTERN = /token|secret|password|api_?key|auth|private_?key|bearer|credentials/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function stripSecretKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) continue;
      out[k] = stripSecretKeysDeep(v);
    }
    return out;
  }
  return value;
}

function filterLocalOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KNOWN_LOCAL_OVERRIDE_KEYS) {
    if (!(key in raw)) continue;
    const cleaned = stripSecretKeysDeep(raw[key]);
    // Fail-open: strip offending key when secret signatures remain in values.
    try {
      const scan = scanPayloadForSecrets(cleaned);
      if (scan.hasSecret) continue;
    } catch {
      continue;
    }
    out[key] = cleaned;
  }
  return out;
}

export interface LocalSpecMemoDiscovery {
  configFilePath: string;
  projectId?: string;
  overrides: Record<string, unknown>;
}

/**
 * Walk usableCwd upward to git root (inclusive) or filesystem root, checking
 * `.spec-memo.json` at each level. Tolerates missing/malformed files and never throws.
 * Returns the closest config found, or null when none exists.
 */
export function findLocalSpecMemoConfig(
  startCwd: string = process.cwd(),
  opts: { vaultRoot?: string } = {}
): LocalSpecMemoDiscovery | null {
  let usable: string;
  try {
    usable = resolveUsableCwd(startCwd);
  } catch {
    return null;
  }
  let resolvedVaultRoot: string;
  try {
    resolvedVaultRoot = path.resolve(opts.vaultRoot || getVaultRoot());
  } catch {
    resolvedVaultRoot = path.resolve(getVaultRoot());
  }
  // Never read consumer config from inside the vault itself.
  try {
    if (usable === resolvedVaultRoot || isPathInside(usable, resolvedVaultRoot)) {
      return null;
    }
  } catch {
    return null;
  }
  let gitRoot: string | null = null;
  try {
    gitRoot = findGitRoot(usable, resolvedVaultRoot);
  } catch {
    gitRoot = null;
  }
  let dir = usable;
  for (;;) {
    const candidate = path.join(dir, LOCAL_SPEC_MEMO_FILENAME);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        try {
          const rawText = fs.readFileSync(candidate, 'utf8');
          const parsed = JSON.parse(rawText) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const overrides = filterLocalOverrides(parsed);
            let projectId: string | undefined;
            const rawId = parsed.projectId;
            if (typeof rawId === 'string' && rawId.trim().length > 0) {
              const normalized = rawId.trim().toLowerCase();
              if (isFilesystemSafeProjectId(normalized)) {
                projectId = normalized;
              }
            }
            return { configFilePath: candidate, projectId, overrides };
          }
        } catch {
          // Malformed JSON: ignore and fall through to parent.
        }
      }
    } catch {
      // Ignore fs errors and continue walking.
    }
    if (gitRoot && path.resolve(dir) === path.resolve(gitRoot)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load local `.spec-memo.json` for a cwd (pure fs, no vault writes).
 */
export function loadLocalSpecMemoConfig(
  cwd: string = process.cwd(),
  opts: { vaultRoot?: string } = {}
): LocalSpecMemoDiscovery | null {
  return findLocalSpecMemoConfig(cwd, opts);
}

/**
 * List active local override top-level keys for a cwd (sorted).
 */
export function getLocalConfigOverrides(
  cwd: string = process.cwd(),
  opts: { vaultRoot?: string } = {}
): Record<string, unknown> {
  const found = findLocalSpecMemoConfig(cwd, opts);
  if (!found) return {};
  return found.overrides || {};
}

export function getLocalConfigOverrideKeys(
  cwd: string = process.cwd(),
  opts: { vaultRoot?: string } = {}
): string[] {
  return Object.keys(getLocalConfigOverrides(cwd, opts)).sort();
}

/**
 * Effective vault config for a cwd: global config.json with local
 * `.spec-memo.json` overrides merged one level deep (objects) or replaced (scalars).
 * Scope for this slice: identity binding + status reporting honor overrides.
 */
export function getEffectiveVaultConfig(
  cwd: string = process.cwd(),
  vaultRoot?: string
): VaultConfig {
  const root = path.resolve(vaultRoot || getVaultRoot());
  let base: VaultConfig;
  try {
    base = readVaultConfig(root).config;
  } catch {
    base = readVaultConfig(root).config;
  }
  const overrides = getLocalConfigOverrides(cwd, { vaultRoot: root });
  if (Object.keys(overrides).length === 0) return base;
  const merged: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) {
    const baseVal = (base as unknown as Record<string, unknown>)[k];
    if (
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      merged[k] = { ...(baseVal as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      merged[k] = v;
    }
  }
  return merged as unknown as VaultConfig;
}

/**
 * Thin wrapper returning the bound project id for a cwd.
 */
export function resolveVaultId(
  cwd: string = process.cwd(),
  options: { remoteName?: string; vaultRoot?: string } = {}
): string {
  return resolveProjectIdentity(cwd, options).projectId;
}

/**
 * Normalize any Git remote URL into a canonical hostname/path identifier.
 * Examples:
 *   - git@github.com:jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - https://user:token@github.com/jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - ssh://git@gitlab.com/org/repo.git -> gitlab.com/org/repo
 */
function cleanRepoPath(rawPath: string): string {
  let cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (cleaned.endsWith('.git')) {
    cleaned = cleaned.slice(0, -4);
  }
  return cleaned.replace(/\/+$/, '').toLowerCase();
}

function canonicalizeHost(host: string): string {
  let lower = host.toLowerCase().replace(/:\d+$/, '');
  if (lower === 'ssh.github.com') return 'github.com';
  if (lower === 'altssh.bitbucket.org') return 'bitbucket.org';
  return lower;
}

function normalizeAzureDevOps(host: string, rawPath: string): string | null {
  const lowerHost = host.toLowerCase().replace(/:\d+$/, '');
  const isAzure =
    lowerHost === 'dev.azure.com' ||
    lowerHost === 'ssh.dev.azure.com' ||
    lowerHost.endsWith('.visualstudio.com');
  if (!isAzure) return null;

  let cleaned = cleanRepoPath(rawPath);
  cleaned = cleaned.replace(/^v3\//, '');
  cleaned = cleaned.replace(/^defaultcollection\//, '');

  const segments = cleaned.split('/').filter((s) => s && s !== '_git');
  if (lowerHost.endsWith('.visualstudio.com') && lowerHost !== 'vs-ssh.visualstudio.com') {
    const org = lowerHost.replace(/\.visualstudio\.com$/, '');
    if (segments.length > 0 && segments[0] !== org) {
      segments.unshift(org);
    }
  }
  if (segments.length >= 2) {
    return `dev.azure.com/${segments.join('/')}`;
  }
  return `dev.azure.com/${cleaned}`;
}

function normalizeAwsCodeCommit(host: string, rawPath: string): string | null {
  const lowerHost = host.toLowerCase().replace(/:\d+$/, '');
  if (!lowerHost.includes('git-codecommit') || !lowerHost.endsWith('.amazonaws.com')) {
    return null;
  }
  let cleaned = cleanRepoPath(rawPath);
  cleaned = cleaned.replace(/^v1\//, '');
  return `${lowerHost}/${cleaned}`;
}

/**
 * Normalize any Git remote URL into a canonical hostname/path identifier.
 * Examples:
 *   - git@github.com:jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - https://user:token@github.com/jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - ssh://git@gitlab.com/org/repo.git -> gitlab.com/org/repo
 *   - https://dev.azure.com/org/proj/_git/repo -> dev.azure.com/org/proj/repo
 */
export function normalizeGitRemote(rawUrl: string): string {
  let url = rawUrl.trim();

  // Strip leading git+ prefix (e.g. git+ssh://, git+https://)
  if (url.startsWith('git+')) {
    url = url.slice(4);
  }

  // 1. Try standard URL protocol: https://, http://, ssh://, git://
  try {
    const parsed = new URL(url);
    const rawHost = parsed.hostname;
    const rawPath = parsed.pathname;

    const azure = normalizeAzureDevOps(rawHost, rawPath);
    if (azure) return azure;

    const aws = normalizeAwsCodeCommit(rawHost, rawPath);
    if (aws) return aws;

    const host = canonicalizeHost(rawHost);
    const repoPath = cleanRepoPath(rawPath);
    return `${host}/${repoPath}`;
  } catch {
    // 2. Handle SSH scp-style: git@github.com:user/repo.git or user@host:path
    // Avoid matching Windows drive letters (e.g. C:\ or C:/)
    if (!/^[a-zA-Z]:[\\/]/.test(url)) {
      const scpMatch = url.match(/^(?:ssh:\/\/)?(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9._-]+):(?!\/\/)(.+)$/);
      if (scpMatch) {
        const rawHost = scpMatch[2];
        const rawPath = scpMatch[3];

        const azure = normalizeAzureDevOps(rawHost, rawPath);
        if (azure) return azure;

        const aws = normalizeAwsCodeCommit(rawHost, rawPath);
        if (aws) return aws;

        const host = canonicalizeHost(rawHost);
        const repoPath = cleanRepoPath(rawPath);
        return `${host}/${repoPath}`;
      }
    }

    // If not a standard URL or SCP, clean up trailing .git, slashes, and protocol
    let cleaned = url.replace(/\\/g, '/');
    cleaned = cleaned.replace(/\.git\/?$/, '');
    cleaned = cleaned.replace(/^[a-zA-Z]+:\/\//, '');
    cleaned = cleaned.replace(/^[^@]+@/, ''); // remove user info
    cleaned = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
    return cleaned.toLowerCase();
  }
}

/**
 * Generate a filesystem-safe project ID from a normalized git remote.
 */
export function generateProjectIdFromRemote(normalizedRemote: string): string {
  // Convert / and special characters to -
  const safeSlug = normalizedRemote
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safeSlug;
}

/**
 * Generate a deterministic fallback project ID from a canonical local directory path.
 */
export function generateProjectIdFromPath(canonicalPath: string): string {
  const normalized = path.normalize(canonicalPath).toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  const baseName = path.basename(canonicalPath).replace(/[^a-zA-Z0-9_-]/g, '-');
  return `local-${baseName}-${hash}`;
}

/**
 * True when `input` is an absolute path for a different OS than this process
 * (Windows drive/UNC on POSIX).
 */
export function isForeignHostPath(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  if (process.platform === 'win32') {
    return false;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
}

/**
 * Map a client-supplied cwd onto a directory that exists on this host.
 * MCP SSE clients inject laptop paths; a remote daemon must not treat those as
 * relative children of process.cwd() or walk them into the daemon git repo.
 */
export function resolveUsableCwd(cwd: string = process.cwd()): string {
  const trimmed = cwd.trim();
  if (!trimmed || isForeignHostPath(trimmed)) {
    return path.resolve(process.cwd());
  }
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    return path.resolve(process.cwd());
  }
  return resolved;
}

/**
 * Find the closest enclosing Git repository root from a start path.
 * Ignores the spec-memo vault root to avoid confusing vaultGit with a consumer product repo.
 */
export function findGitRoot(startPath: string, vaultRoot?: string): string | null {
  let current = path.resolve(startPath);
  if (!fs.existsSync(current)) {
    return null;
  }
  const resolvedVault = path.resolve(vaultRoot || getVaultRoot());

  while (true) {
    // Never treat vaultRoot or any directory inside vaultRoot as a product git repository
    if (current === resolvedVault || isPathInside(current, resolvedVault)) {
      return null;
    }

    const gitDir = path.join(current, '.git');
    if (fs.existsSync(gitDir)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    if (!fs.existsSync(current)) {
      return null;
    }
  }
  return null;
}

/**
 * If candidateUrl points to a local directory or file:// URI that is a git repository,
 * resolve its upstream remote URL recursively (up to 3 hops) so clones of local clones
 * share the upstream remote identity.
 */
export function resolveLocalRepoRemote(candidateUrl: string, currentGitRoot?: string, depth = 0): string | null {
  if (depth > 3) return null;
  let candidate = candidateUrl.trim();
  if (candidate.startsWith('file://')) {
    try {
      candidate = new URL(candidate).pathname;
      if (process.platform === 'win32' && candidate.startsWith('/') && candidate[2] === ':') {
        candidate = candidate.slice(1);
      }
    } catch {
      candidate = candidate.replace(/^file:\/\//, '');
    }
  }

  // Check if candidate is a local path format
  const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(candidate);
  const isRelative = candidate.startsWith('.') || candidate.startsWith('..');
  const isPosixAbsolute = candidate.startsWith('/');
  if (!isWindowsDrive && !isRelative && !isPosixAbsolute) {
    return null;
  }

  const resolvedPath = currentGitRoot && isRelative
    ? path.resolve(currentGitRoot, candidate)
    : path.resolve(candidate);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const targetGitRoot = findGitRoot(resolvedPath);
  if (!targetGitRoot) {
    return null;
  }

  // Avoid cycle if pointing to self
  if (currentGitRoot && path.resolve(currentGitRoot) === path.resolve(targetGitRoot)) {
    return null;
  }

  // Inspect the target git repository's remotes
  const upstreamUrl = getGitRemoteUrl(targetGitRoot, 'origin', depth + 1);
  if (upstreamUrl) {
    return upstreamUrl;
  }

  // If the target repository has no remotes (pure local repo), return its canonical root path
  return targetGitRoot;
}

/**
 * Read the URL of a named remote from git config or git CLI.
 * If remoteName is 'origin' and not found, falls back to 'upstream' or first available remote.
 * If the resulting URL is a local repository clone, resolves upstream remote identity recursively.
 */
export function getGitRemoteUrl(gitRoot: string, remoteName = 'origin', depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  let foundUrl: string | null = null;
  const gitDir = path.join(gitRoot, '.git');

  // Fast path: inspect .git/config directly
  try {
    let configPath = path.join(gitDir, 'config');
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
      // Handle git worktrees or submodules (gitdir pointer file)
      const gitContent = fs.readFileSync(gitDir, 'utf8');
      const match = gitContent.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const resolvedGitDir = path.resolve(gitRoot, match[1].trim());
        configPath = path.join(resolvedGitDir, 'config');
        if (!fs.existsSync(configPath)) {
          // Check commondir for git worktrees
          const commondirFile = path.join(resolvedGitDir, 'commondir');
          if (fs.existsSync(commondirFile)) {
            const commonDir = fs.readFileSync(commondirFile, 'utf8').trim();
            const resolvedCommonDir = path.resolve(resolvedGitDir, commonDir);
            configPath = path.join(resolvedCommonDir, 'config');
          }
        }
      }
    }

    if (fs.existsSync(configPath)) {
      const configText = fs.readFileSync(configPath, 'utf8');
      // 1. Try requested remoteName
      const targetRegex = new RegExp(`\\[remote\\s+"${remoteName}"\\][^\\[]*url\\s*=\\s*([^\\r\\n]+)`, 'i');
      const targetMatch = configText.match(targetRegex);
      if (targetMatch && targetMatch[1]) {
        foundUrl = targetMatch[1].trim();
      } else if (remoteName === 'origin') {
        // 2. Fallback to 'upstream'
        const upstreamMatch = configText.match(/\[remote\s+"upstream"\][^\[]*url\s*=\s*([^\r\n]+)/i);
        if (upstreamMatch && upstreamMatch[1]) {
          foundUrl = upstreamMatch[1].trim();
        } else {
          // 3. Fallback to any configured remote
          const anyRemoteMatch = configText.match(/\[remote\s+"[^"]+"\][^\[]*url\s*=\s*([^\r\n]+)/i);
          if (anyRemoteMatch && anyRemoteMatch[1]) {
            foundUrl = anyRemoteMatch[1].trim();
          }
        }
      }
    }
  } catch {
    // Ignore file read error and try CLI fallback
  }

  // CLI fallback if fast-path did not find a URL
  if (!foundUrl) {
    try {
      const out = execFileSync('git', ['remote', 'get-url', remoteName], {
        cwd: gitRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      foundUrl = out.trim() || null;
    } catch {
      if (remoteName === 'origin') {
        try {
          const remotesOut = execFileSync('git', ['remote'], {
            cwd: gitRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
          });
          const remotes = remotesOut.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
          const fallbackName = remotes.includes('upstream') ? 'upstream' : remotes[0];
          if (fallbackName) {
            const out = execFileSync('git', ['remote', 'get-url', fallbackName], {
              cwd: gitRoot,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'ignore']
            });
            foundUrl = out.trim() || null;
          }
        } catch {
          // Ignore CLI fallback errors
        }
      }
    }
  }

  if (!foundUrl) {
    return null;
  }

  // Check if foundUrl points to a local repository (clone of a clone)
  const localUpstream = resolveLocalRepoRemote(foundUrl, gitRoot, depth);
  if (localUpstream) {
    return localUpstream;
  }

  return foundUrl;
}

/**
 * When cwd is under `<vaultRoot>/projects/<projectId>/...`, reuse that partition id.
 */
export function projectIdFromVaultPath(usableCwd: string, vaultRoot: string): string | null {
  const rel = path.relative(path.resolve(vaultRoot), path.resolve(usableCwd)).replace(/\\/g, '/');
  const m = rel.match(/^projects\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * Resolve project identity for a directory.
 * File-first: `.spec-memo.json` discovery takes precedence over git remote
 * normalization and path fallback. Discovery is pure fs and never throws.
 * Alias resolution (resolveCanonicalProjectId) applies after the base id.
 */
export function resolveProjectIdentity(
  cwd: string = process.cwd(),
  options: { remoteName?: string; vaultRoot?: string } = {}
): ProjectIdentity {
  const resolvedVaultRoot = options.vaultRoot || getVaultRoot();
  const usableCwd = resolveUsableCwd(cwd);
  const gitRoot = findGitRoot(usableCwd, resolvedVaultRoot);
  const remoteName = options.remoteName || 'origin';

  // File-first discovery (skipped automatically inside vaultRoot).
  // Local alias helpers stay in vault-manager; file discovery itself is pure fs
  // to avoid new circular edges (existing resolveCanonicalProjectId edge reused).
  let fileDiscovery: LocalSpecMemoDiscovery | null = null;
  try {
    fileDiscovery = findLocalSpecMemoConfig(usableCwd, { vaultRoot: resolvedVaultRoot });
  } catch {
    fileDiscovery = null;
  }
  const fileConfigPath = fileDiscovery?.configFilePath ?? null;

  if (fileDiscovery?.projectId) {
    const baseId = fileDiscovery.projectId;
    const canonicalId = resolveCanonicalProjectId(baseId, resolvedVaultRoot);
    const vaultProjectPath = path.join(resolvedVaultRoot, 'projects', canonicalId);
    // Root for file-bound identity prefers the git root when present,
    // otherwise the directory containing the config file.
    let fileRoot: string;
    if (gitRoot) {
      fileRoot = path.resolve(gitRoot);
    } else {
      try {
        fileRoot = path.resolve(path.dirname(fileDiscovery.configFilePath));
      } catch {
        fileRoot = usableCwd;
      }
    }
    let fileRemote: string | null = null;
    if (gitRoot) {
      try {
        const remoteUrl = getGitRemoteUrl(path.resolve(gitRoot), remoteName);
        if (remoteUrl) {
          const isLocalPath =
            fs.existsSync(remoteUrl) &&
            (path.isAbsolute(remoteUrl) || /^[a-zA-Z]:[\\/]/.test(remoteUrl));
          if (!isLocalPath) {
            fileRemote = normalizeGitRemote(remoteUrl);
          }
        }
      } catch {
        fileRemote = null;
      }
    }
    return {
      projectId: canonicalId,
      normalizedRemote: fileRemote,
      rootPath: fileRoot,
      isGit: Boolean(gitRoot),
      isFallback: false,
      vaultProjectPath,
      identitySource: 'file',
      configFilePath: fileDiscovery.configFilePath
    };
  }

  let normalizedRemote: string | null = null;
  let rootPath: string;
  let isGit = false;
  let isFallback = true;
  let projectId: string;
  let identitySource: 'git' | 'path' = 'path';

  if (gitRoot) {
    isGit = true;
    rootPath = path.resolve(gitRoot);
    const remoteUrl = getGitRemoteUrl(rootPath, remoteName);
    if (remoteUrl) {
      const isLocalPath =
        fs.existsSync(remoteUrl) &&
        (path.isAbsolute(remoteUrl) || /^[a-zA-Z]:[\\/]/.test(remoteUrl));
      if (isLocalPath) {
        projectId = generateProjectIdFromPath(path.resolve(remoteUrl));
        normalizedRemote = null;
        isFallback = true;
        identitySource = 'path';
      } else {
        normalizedRemote = normalizeGitRemote(remoteUrl);
        projectId = generateProjectIdFromRemote(normalizedRemote);
        isFallback = false;
        identitySource = 'git';
      }
    } else {
      projectId = generateProjectIdFromPath(rootPath);
      identitySource = 'path';
    }
  } else {
    const vaultProjectId = projectIdFromVaultPath(usableCwd, resolvedVaultRoot);
    if (vaultProjectId) {
      projectId = vaultProjectId;
      rootPath = usableCwd;
      identitySource = 'path';
    } else {
      rootPath = usableCwd;
      projectId = generateProjectIdFromPath(rootPath);
      identitySource = 'path';
    }
  }

  const canonicalId = resolveCanonicalProjectId(projectId, resolvedVaultRoot);
  const vaultProjectPath = path.join(resolvedVaultRoot, 'projects', canonicalId);

  return {
    projectId: canonicalId,
    normalizedRemote,
    rootPath,
    isGit,
    isFallback,
    vaultProjectPath,
    identitySource,
    configFilePath: fileConfigPath
  };
}
