import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProjectIdentity, ProjectMetadata, VaultConfig } from './types.js';

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
