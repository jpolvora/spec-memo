import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  commitVaultChange,
  ensureProjectVault,
  ensureVaultStructure,
  getProjectMetadata,
  getVaultRoot,
  initVault,
  readVaultConfig,
  withVaultLock
} from './vault.js';
import { listProjectRecords, upsertRecord } from './store.js';
import { rebuildIndex } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';
import { ProjectIdentity } from './types.js';

export class VaultManagerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number = 400
  ) {
    super(message);
    this.name = 'VaultManagerError';
  }
}

export interface VaultProjectListEntry {
  id: string;
  displayName?: string;
  aliasOf: string | null;
  recordCount: number;
}

const PROJECT_ID_RE = /^[a-z0-9._-]+$/;

export function isFilesystemSafeProjectId(id: string): boolean {
  const trimmed = id.trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return false;
  return PROJECT_ID_RE.test(trimmed);
}

export function normalizeProjectId(id: string): string {
  return id.trim();
}

export function readProjectAliases(vaultRoot: string = getVaultRoot()): Record<string, string> {
  const { config } = readVaultConfig(vaultRoot);
  const raw = (config as { projectAliases?: Record<string, string> }).projectAliases;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && typeof v === 'string' && k.length > 0 && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Follow projectAliases to the terminal canonical id. Rejects cycles.
 */
export function resolveCanonicalProjectId(
  projectId: string,
  vaultRoot: string = getVaultRoot()
): string {
  const aliases = readProjectAliases(vaultRoot);
  const visited = new Set<string>();
  let current = normalizeProjectId(projectId);
  while (aliases[current]) {
    if (visited.has(current)) {
      throw new VaultManagerError(`Alias cycle detected at project id "${current}"`);
    }
    visited.add(current);
    current = aliases[current];
  }
  return current;
}

function projectDirExists(vaultRoot: string, projectId: string): boolean {
  const dir = path.join(vaultRoot, 'projects', projectId);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

function isAliasKey(vaultRoot: string, projectId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readProjectAliases(vaultRoot), projectId);
}

function wouldCreateCycle(
  aliases: Record<string, string>,
  from: string,
  to: string
): boolean {
  const visited = new Set<string>();
  let current = to;
  while (aliases[current]) {
    if (current === from) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = aliases[current];
  }
  return current === from;
}

function writeProjectAliases(
  vaultRoot: string,
  aliases: Record<string, string>,
  message: string
): void {
  const configPath = path.join(vaultRoot, 'config.json');
  ensureVaultStructure(vaultRoot);
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }
  if (Object.keys(aliases).length === 0) {
    delete parsed.projectAliases;
  } else {
    parsed.projectAliases = aliases;
  }
  fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
  commitVaultChange(message, vaultRoot, []);
}

function targetIdentity(projectId: string, vaultRoot: string): ProjectIdentity {
  return {
    projectId,
    normalizedRemote: null,
    rootPath: path.join(vaultRoot, 'projects', projectId),
    isGit: false,
    isFallback: true,
    vaultProjectPath: path.join(vaultRoot, 'projects', projectId)
  };
}

export function countProjectRecords(vaultRoot: string, projectId: string): number {
  return listProjectRecords(vaultRoot, projectId).filter(
    (r) => r.frontmatter.status !== 'archived'
  ).length;
}

export function getVaultProjectListEnriched(vaultRoot: string): VaultProjectListEntry[] {
  const projectsDir = path.join(vaultRoot, 'projects');
  const aliases = readProjectAliases(vaultRoot);
  const list: VaultProjectListEntry[] = [];
  if (!fs.existsSync(projectsDir)) return list;

  for (const entry of fs.readdirSync(projectsDir)) {
    const projPath = path.join(projectsDir, entry);
    if (!fs.statSync(projPath).isDirectory()) continue;
    const meta = getProjectMetadata(entry, vaultRoot);
    list.push({
      id: entry,
      displayName: meta?.displayName || entry,
      aliasOf: aliases[entry] ?? null,
      recordCount: countProjectRecords(vaultRoot, entry)
    });
  }
  return list;
}

export function listIncomingAliases(vaultRoot: string, canonicalId: string): string[] {
  const aliases = readProjectAliases(vaultRoot);
  return Object.entries(aliases)
    .filter(([, to]) => to === canonicalId)
    .map(([from]) => from);
}

export async function setProjectAlias(
  from: string,
  to: string,
  vaultRoot: string = getVaultRoot()
): Promise<{ from: string; to: string }> {
  const source = normalizeProjectId(from);
  const target = normalizeProjectId(to);

  if (!source || !target) {
    throw new VaultManagerError('Both "from" and "to" project ids are required');
  }
  if (source === target) {
    throw new VaultManagerError('Alias source and target must differ');
  }
  if (!isFilesystemSafeProjectId(target)) {
    throw new VaultManagerError(`Invalid target project id "${target}"`);
  }
  if (!projectDirExists(vaultRoot, source) && !isAliasKey(vaultRoot, source)) {
    throw new VaultManagerError(`Unknown source project id "${source}"`);
  }
  if (!projectDirExists(vaultRoot, target) && !isAliasKey(vaultRoot, target)) {
    throw new VaultManagerError(`Unknown target project id "${target}"`);
  }

  return withVaultLock(vaultRoot, async () => {
    const aliases = { ...readProjectAliases(vaultRoot) };
    if (wouldCreateCycle(aliases, source, target)) {
      throw new VaultManagerError(`Alias would create a cycle between "${source}" and "${target}"`);
    }
    aliases[source] = target;
    writeProjectAliases(vaultRoot, aliases, `alias ${source} -> ${target}`);

    const sourceDir = path.join(vaultRoot, 'projects', source);
    if (projectDirExists(vaultRoot, source)) {
      const projectJsonPath = path.join(sourceDir, 'project.json');
      let meta: Record<string, unknown> = {};
      if (fs.existsSync(projectJsonPath)) {
        try {
          meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
        } catch {
          meta = {};
        }
      }
      meta.canonicalOf = target;
      fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
    }

    return { from: source, to: target };
  });
}

export async function removeProjectAlias(
  from: string,
  vaultRoot: string = getVaultRoot()
): Promise<{ from: string }> {
  const source = normalizeProjectId(from);
  if (!source) {
    throw new VaultManagerError('"from" project id is required');
  }

  return withVaultLock(vaultRoot, async () => {
    const aliases = { ...readProjectAliases(vaultRoot) };
    if (!aliases[source]) {
      throw new VaultManagerError(`No alias defined for "${source}"`, 404);
    }
    delete aliases[source];
    writeProjectAliases(vaultRoot, aliases, `remove alias ${source}`);

    const projectJsonPath = path.join(vaultRoot, 'projects', source, 'project.json');
    if (fs.existsSync(projectJsonPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
        delete meta.canonicalOf;
        fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
      } catch {
        // ignore corrupt project.json
      }
    }

    return { from: source };
  });
}

export async function createVaultProject(
  id: string,
  displayName: string,
  vaultRoot: string = getVaultRoot()
): Promise<{ id: string }> {
  const projectId = normalizeProjectId(id).toLowerCase();
  if (!isFilesystemSafeProjectId(projectId)) {
    throw new VaultManagerError(`Invalid project id "${id}"`);
  }
  if (projectDirExists(vaultRoot, projectId)) {
    throw new VaultManagerError(`Project "${projectId}" already exists`, 409);
  }

  return withVaultLock(vaultRoot, async () => {
    if (projectDirExists(vaultRoot, projectId)) {
      throw new VaultManagerError(`Project "${projectId}" already exists`, 409);
    }
    initVault({ vaultRoot, projectId });
    const identity = targetIdentity(projectId, vaultRoot);
    ensureProjectVault(identity, vaultRoot);
    const projectJsonPath = path.join(vaultRoot, 'projects', projectId, 'project.json');
    const meta = {
      ...(getProjectMetadata(projectId, vaultRoot) || {}),
      displayName: displayName || projectId,
      updated: new Date().toISOString()
    };
    fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
    commitVaultChange(`create project ${projectId}`, vaultRoot, [path.join('projects', projectId)]);
    return { id: projectId };
  });
}

export async function updateVaultProject(
  id: string,
  displayName: string,
  vaultRoot: string = getVaultRoot()
): Promise<{ id: string; displayName: string }> {
  const projectId = normalizeProjectId(id);
  if (!projectDirExists(vaultRoot, projectId)) {
    throw new VaultManagerError(`Unknown project id "${projectId}"`, 404);
  }

  return withVaultLock(vaultRoot, async () => {
    const projectJsonPath = path.join(vaultRoot, 'projects', projectId, 'project.json');
    let meta: Record<string, unknown> = {};
    if (fs.existsSync(projectJsonPath)) {
      meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
    }
    meta.displayName = displayName;
    meta.updated = new Date().toISOString();
    fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
    commitVaultChange(`update project ${projectId}`, vaultRoot, [path.join('projects', projectId)]);
    return { id: projectId, displayName };
  });
}

async function copyRecordsToTarget(
  sources: string[],
  target: string,
  vaultRoot: string
): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;
  ensureProjectVault(targetIdentity(target, vaultRoot), vaultRoot);
  const targetIds = new Set(
    listProjectRecords(vaultRoot, target).map((r) => String(r.frontmatter.id))
  );

  for (const source of sources) {
    const records = listProjectRecords(vaultRoot, source).filter(
      (r) => r.frontmatter.status !== 'archived'
    );
    for (const rec of records) {
      const recordId = String(rec.frontmatter.id);
      if (targetIds.has(recordId)) {
        skipped++;
        continue;
      }
      const kind = rec.frontmatter.kind;
      await upsertRecord({
        vaultRoot,
        projectId: target,
        kind,
        slug: String(rec.frontmatter.slug || rec.frontmatter.id),
        frontmatter: { ...rec.frontmatter, project: target },
        body: rec.body,
        allowDuplicate: true
      });
      targetIds.add(recordId);
      copied++;
    }
  }

  return { copied, skipped };
}

export async function mergeVaultProjects(options: {
  sources: string[];
  target: string;
  copyRecords?: boolean;
  vaultRoot?: string;
}): Promise<{
  ok: true;
  target: string;
  sources: string[];
  copied: number;
  skipped: number;
}> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const target = normalizeProjectId(options.target);
  const sources = (options.sources || []).map(normalizeProjectId).filter(Boolean);
  const copyRecords = options.copyRecords === true;

  if (!target) {
    throw new VaultManagerError('"target" project id is required');
  }
  if (!isFilesystemSafeProjectId(target)) {
    throw new VaultManagerError(`Invalid target project id "${target}"`);
  }
  if (sources.length === 0) {
    throw new VaultManagerError('At least one source project id is required');
  }
  if (sources.includes(target)) {
    throw new VaultManagerError('Target cannot appear in sources');
  }
  for (const src of sources) {
    if (!isFilesystemSafeProjectId(src)) {
      throw new VaultManagerError(`Invalid source project id "${src}"`);
    }
    if (!projectDirExists(vaultRoot, src) && !isAliasKey(vaultRoot, src)) {
      throw new VaultManagerError(`Unknown source project id "${src}"`);
    }
  }

  return withVaultLock(vaultRoot, async () => {
    if (!projectDirExists(vaultRoot, target)) {
      initVault({ vaultRoot, projectId: target });
      ensureProjectVault(targetIdentity(target, vaultRoot), vaultRoot);
    }

    let copied = 0;
    let skipped = 0;
    if (copyRecords) {
      const copyResult = await copyRecordsToTarget(sources, target, vaultRoot);
      copied = copyResult.copied;
      skipped = copyResult.skipped;
    }

    const aliases = { ...readProjectAliases(vaultRoot) };
    for (const src of sources) {
      if (wouldCreateCycle(aliases, src, target)) {
        throw new VaultManagerError(`Merge would create an alias cycle involving "${src}"`);
      }
      aliases[src] = target;
      const projectJsonPath = path.join(vaultRoot, 'projects', src, 'project.json');
      if (fs.existsSync(projectJsonPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
          meta.canonicalOf = target;
          fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
        } catch {
          // ignore
        }
      }
    }
    writeProjectAliases(vaultRoot, aliases, `merge -> ${target}`);

    if (copyRecords) {
      await rebuildIndex(vaultRoot);
      rebuildCompiledViews(target, vaultRoot);
    }

    commitVaultChange(`merge projects -> ${target}`, vaultRoot, [
      path.join('projects', target),
      ...sources.map((s) => path.join('projects', s))
    ]);

    return { ok: true, target, sources, copied, skipped };
  });
}

export async function deleteVaultProject(options: {
  id: string;
  confirm?: boolean;
  force?: boolean;
  vaultRoot?: string;
}): Promise<{ ok: true; id: string }> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const projectId = normalizeProjectId(options.id);

  if (!projectId) {
    throw new VaultManagerError('"id" is required');
  }
  if (options.confirm !== true) {
    throw new VaultManagerError('Delete confirmation required (confirm: true)');
  }
  if (!projectDirExists(vaultRoot, projectId)) {
    throw new VaultManagerError(`Unknown project id "${projectId}"`, 404);
  }

  const incoming = listIncomingAliases(vaultRoot, projectId);
  if (incoming.length > 0 && !options.force) {
    throw new VaultManagerError(
      `Cannot delete "${projectId}": aliases still point here (${incoming.join(', ')})`,
      409
    );
  }

  return withVaultLock(vaultRoot, async () => {
    const aliases = { ...readProjectAliases(vaultRoot) };
    if (aliases[projectId] && !options.force) {
      throw new VaultManagerError(
        `Cannot delete aliased project "${projectId}" without force (alias of ${aliases[projectId]})`,
        409
      );
    }

    const projectDir = path.join(vaultRoot, 'projects', projectId);
    fs.rmSync(projectDir, { recursive: true, force: true });

    delete aliases[projectId];
    for (const [from, to] of Object.entries(aliases)) {
      if (to === projectId) {
        delete aliases[from];
      }
    }
    writeProjectAliases(vaultRoot, aliases, `delete project ${projectId}`);
    await rebuildIndex(vaultRoot);

    return { ok: true, id: projectId };
  });
}
