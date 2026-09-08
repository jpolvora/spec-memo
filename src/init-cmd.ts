import * as fs from 'node:fs';
import * as path from 'node:path';
import { findGitRoot, generateProjectIdFromPath, generateProjectIdFromRemote, getGitRemoteUrl, normalizeGitRemote, resolveUsableCwd } from './identity.js';
import { isFilesystemSafeProjectId } from './vault-manager.js';
import { getVaultRoot } from './vault.js';
import { isPathInside } from './safety.js';

export interface InitCommandOptions {
  cwd?: string;
  projectId?: string;
  force?: boolean;
  json?: boolean;
  vaultRoot?: string;
}

export interface InitCommandResult {
  ok: true;
  path: string;
  projectId: string;
}

function sanitizeBasename(name: string): string {
  let slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '');
  return slug;
}

export function inferDefaultProjectId(root: string): string {
  let gitRoot: string | null = null;
  try {
    gitRoot = findGitRoot(root);
  } catch {
    gitRoot = null;
  }
  if (gitRoot) {
    try {
      const remoteUrl = getGitRemoteUrl(gitRoot, 'origin');
      if (remoteUrl) {
        const isLocalPath =
          fs.existsSync(remoteUrl) &&
          (path.isAbsolute(remoteUrl) || /^[a-zA-Z]:[\\/]/.test(remoteUrl));
        if (!isLocalPath) {
          const normalized = normalizeGitRemote(remoteUrl);
          const id = generateProjectIdFromRemote(normalized).toLowerCase();
          if (isFilesystemSafeProjectId(id)) return id;
        }
      }
    } catch {
      // Fall through to basename.
    }
  }
  const base = sanitizeBasename(path.basename(path.resolve(root)));
  if (base && isFilesystemSafeProjectId(base)) return base;
  const fallback = generateProjectIdFromPath(path.resolve(root)).toLowerCase();
  if (isFilesystemSafeProjectId(fallback)) return fallback;
  return 'local-project';
}

export async function runInitCommand(options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const cwd = options.cwd || process.cwd();
  const usable = resolveUsableCwd(cwd);
  let gitRoot: string | null = null;
  try {
    gitRoot = findGitRoot(usable);
  } catch {
    gitRoot = null;
  }
  const projectRoot = gitRoot ? path.resolve(gitRoot) : path.resolve(usable);
  const target = path.join(projectRoot, '.spec-memo.json');

  // Vault guard: refuse to write consumer config inside the vault.
  const vaultRoot = path.resolve(options.vaultRoot || getVaultRoot());
  if (target === vaultRoot || isPathInside(target, vaultRoot)) {
    throw new Error('Cannot create .spec-memo.json inside the vault directory.');
  }

  let projectId: string;
  if (options.projectId !== undefined) {
    const trimmed = String(options.projectId).trim().toLowerCase();
    if (!trimmed || !isFilesystemSafeProjectId(trimmed)) {
      throw new Error(`Invalid project id "${options.projectId}". Use a filesystem-safe id (lowercase letters, digits, dot, underscore, hyphen).`);
    }
    projectId = trimmed;
  } else {
    projectId = inferDefaultProjectId(projectRoot);
  }

  if (fs.existsSync(target) && !options.force) {
    throw new Error(`.spec-memo.json already exists at ${target}. Re-run with --force to overwrite.`);
  }

  const payload = `${JSON.stringify({ projectId }, null, 2)}\n`;
  fs.writeFileSync(target, payload, 'utf8');
  return { ok: true, path: target, projectId };
}
