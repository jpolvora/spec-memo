import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface VaultGitAuthorStatus {
  configured: boolean;
  name?: string;
  email?: string;
  source?: 'local' | 'global' | 'none';
}

export interface VaultGitLiveStatus {
  enabled: boolean;
  gitRepo: boolean;
  author: VaultGitAuthorStatus;
  liveDirty: boolean;
  porcelainPaths: string[];
  persistedDirty: boolean;
  persistedStale: boolean;
  lastError?: string | null;
  lastSyncAt?: string | null;
}

function gitConfigGet(cwd: string, key: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function gitConfigGlobalGet(key: string): string {
  try {
    return execFileSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

export function inspectVaultGitAuthor(vaultRoot: string): VaultGitAuthorStatus {
  if (!fs.existsSync(path.join(vaultRoot, '.git'))) {
    const name = gitConfigGlobalGet('user.name');
    const email = gitConfigGlobalGet('user.email');
    return {
      configured: Boolean(email),
      name: name || undefined,
      email: email || undefined,
      source: email ? 'global' : 'none'
    };
  }
  try {
    const ident = execFileSync('git', ['var', 'GIT_AUTHOR_IDENT'], {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const emailMatch = ident.match(/<([^>]+)>/);
    const name = ident.replace(/<[^>]+>.*/, '').trim();
    const localEmail = gitConfigGet(vaultRoot, 'user.email');
    return {
      configured: Boolean(emailMatch?.[1]),
      name: name || undefined,
      email: emailMatch?.[1],
      source: localEmail ? 'local' : 'global'
    };
  } catch {
    const localEmail = gitConfigGet(vaultRoot, 'user.email');
    const localName = gitConfigGet(vaultRoot, 'user.name');
    return {
      configured: false,
      name: localName || undefined,
      email: localEmail || undefined,
      source: 'none'
    };
  }
}

export function inspectVaultGitPorcelain(vaultRoot: string): string[] {
  if (!fs.existsSync(path.join(vaultRoot, '.git'))) return [];
  try {
    const out = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=normal', '--', 'projects', 'config.json', '.gitignore'],
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out
      .split(/\r?\n/)
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function inspectVaultGitLive(
  vaultRoot: string,
  persisted: { dirty?: boolean; lastError?: string | null; lastSyncAt?: string | null },
  enabled: boolean
): VaultGitLiveStatus {
  const gitRepo = fs.existsSync(path.join(vaultRoot, '.git'));
  const porcelainPaths = enabled && gitRepo ? inspectVaultGitPorcelain(vaultRoot) : [];
  const liveDirty = porcelainPaths.length > 0;
  const persistedDirty = Boolean(persisted.dirty);
  return {
    enabled,
    gitRepo,
    author: inspectVaultGitAuthor(vaultRoot),
    liveDirty,
    porcelainPaths,
    persistedDirty,
    persistedStale: liveDirty !== persistedDirty,
    lastError: persisted.lastError ?? null,
    lastSyncAt: persisted.lastSyncAt ?? null
  };
}
