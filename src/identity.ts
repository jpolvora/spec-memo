import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ProjectIdentity } from './types.js';
import { getVaultRoot } from './vault.js';

/**
 * Normalize any Git remote URL into a canonical hostname/path identifier.
 * Examples:
 *   - git@github.com:jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - https://user:token@github.com/jpolvora/spec-memo.git -> github.com/jpolvora/spec-memo
 *   - ssh://git@gitlab.com/org/repo.git -> gitlab.com/org/repo
 */
export function normalizeGitRemote(rawUrl: string): string {
  let url = rawUrl.trim();

  // Strip leading git+ prefix (e.g. git+ssh://, git+https://)
  if (url.startsWith('git+')) {
    url = url.slice(4);
  }

  // Handle SSH scp-style: git@github.com:user/repo.git
  const scpMatch = url.match(/^([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+):(.+)$/);
  if (scpMatch) {
    const host = scpMatch[2].toLowerCase();
    let repoPath = scpMatch[3].replace(/^\/+/, '');
    if (repoPath.endsWith('.git')) {
      repoPath = repoPath.slice(0, -4);
    }
    return `${host}/${repoPath}`;
  }

  // Handle standard URL protocol: https://, http://, ssh://, git://
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    let pathname = parsed.pathname.replace(/^\/+/, '');
    if (pathname.endsWith('.git')) {
      pathname = pathname.slice(0, -4);
    }
    // For GitHub, GitLab, Bitbucket, lower-case path for consistency
    if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(host)) {
      pathname = pathname.toLowerCase();
    }
    return `${host}/${pathname}`;
  } catch {
    // If not a standard URL, clean up trailing .git and slashes
    let cleaned = url.replace(/\.git$/, '').replace(/^[a-zA-Z]+:\/\//, '');
    cleaned = cleaned.replace(/^[^@]+@/, ''); // remove user info
    return cleaned.replace(/\\/g, '/');
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
 */
export function findGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  if (!fs.existsSync(current)) {
    return null;
  }
  while (true) {
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
 * Read the URL of a named remote from git config or git CLI.
 */
export function getGitRemoteUrl(gitRoot: string, remoteName = 'origin'): string | null {
  // Fast path: inspect .git/config directly
  const gitDir = path.join(gitRoot, '.git');
  try {
    let configPath = path.join(gitDir, 'config');
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
      // Handle git worktrees or submodules (gitdir pointer file)
      const gitContent = fs.readFileSync(gitDir, 'utf8');
      const match = gitContent.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const resolvedGitDir = path.resolve(gitRoot, match[1].trim());
        configPath = path.join(resolvedGitDir, 'config');
      }
    }

    if (fs.existsSync(configPath)) {
      const configText = fs.readFileSync(configPath, 'utf8');
      const remoteRegex = new RegExp(`\\[remote\\s+"${remoteName}"\\][^\\[]*url\\s*=\\s*([^\\r\\n]+)`, 'i');
      const match = configText.match(remoteRegex);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // Ignore file read error and try CLI fallback
  }

  // CLI fallback
  try {
    const out = execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve project identity for a directory.
 */
export function resolveProjectIdentity(
  cwd: string = process.cwd(),
  options: { remoteName?: string; vaultRoot?: string } = {}
): ProjectIdentity {
  const resolvedVaultRoot = options.vaultRoot || getVaultRoot();
  const usableCwd = resolveUsableCwd(cwd);
  const gitRoot = findGitRoot(usableCwd);
  const remoteName = options.remoteName || 'origin';

  let normalizedRemote: string | null = null;
  let rootPath: string;
  let isGit = false;
  let isFallback = true;
  let projectId: string;

  if (gitRoot) {
    isGit = true;
    rootPath = path.resolve(gitRoot);
    const remoteUrl = getGitRemoteUrl(rootPath, remoteName);
    if (remoteUrl) {
      normalizedRemote = normalizeGitRemote(remoteUrl);
      projectId = generateProjectIdFromRemote(normalizedRemote);
      isFallback = false;
    } else {
      projectId = generateProjectIdFromPath(rootPath);
    }
  } else {
    rootPath = usableCwd;
    projectId = generateProjectIdFromPath(rootPath);
  }

  const vaultProjectPath = path.join(resolvedVaultRoot, 'projects', projectId);

  return {
    projectId,
    normalizedRemote,
    rootPath,
    isGit,
    isFallback,
    vaultProjectPath
  };
}
