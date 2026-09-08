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
import {
  findMatchingNonTrapRecord,
  findMatchingTrap,
  getSubdirForKind,
  listProjectRecords,
  normalizeTitleForMerge,
  slugKeyForRecord
} from './store.js';
import { indexRecord, openIndex, rebuildIndex } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';
import { serializeRecord } from './schema.js';
import { hitCountOf, occurrenceOf } from './recurrence.js';
import { MemoRecord, MergeMetrics, ProjectIdentity } from './types.js';

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
    vaultProjectPath: path.join(vaultRoot, 'projects', projectId),
    identitySource: 'path',
    configFilePath: null
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

function maxIsoTimestamp(...candidates: Array<string | undefined | null>): string {
  const now = new Date().toISOString();
  let best = now;
  for (const c of [...candidates, now]) {
    if (typeof c === 'string' && c.length > 0 && c > best) {
      best = c;
    }
  }
  return best;
}

function unionTags(a?: unknown, b?: unknown): string[] | undefined {
  const list = [...(Array.isArray(a) ? a.map(String) : []), ...(Array.isArray(b) ? b.map(String) : [])];
  if (list.length === 0) return undefined;
  return Array.from(new Set(list));
}

/**
 * Lock-free inner write path for merge (called under outer withVaultLock).
 * Uses direct fs writes + indexRecord on a shared DB handle instead of
 * upsertRecord (which would re-resolve cwd identity and commit per record).
 * withVaultLock is re-entrant in-process (vaultLockDepth), so nested calls
 * would not deadlock, but direct writes keep batching and identity correct.
 * Trap: session-end-vault-lock-merge.
 */
async function copyRecordsToTarget(
  sources: string[],
  target: string,
  vaultRoot: string,
  opts: { dedup?: boolean } = {}
): Promise<MergeMetrics> {
  const dedup = opts.dedup !== false;
  let copied = 0;
  let deduplicated = 0;
  let skipped = 0;
  ensureProjectVault(targetIdentity(target, vaultRoot), vaultRoot);
  const targetDir = path.join(vaultRoot, 'projects', target);
  const db = openIndex(vaultRoot);

  // Load target index once for deterministic dedup lookups.
  const byId = new Map<string, MemoRecord>();
  const bySlug = new Map<string, MemoRecord>();
  const titleMap = new Map<string, MemoRecord>();
  const refreshTargetMaps = (rec: MemoRecord): void => {
    const id = String(rec.frontmatter.id);
    byId.set(id, rec);
    const slug = slugKeyForRecord(rec.frontmatter);
    if (slug) bySlug.set(slug, rec);
    if (typeof rec.frontmatter.title === 'string' && rec.frontmatter.title.trim()) {
      titleMap.set(`${rec.frontmatter.kind}:${normalizeTitleForMerge(rec.frontmatter.title)}`, rec);
    }
  };
  for (const existing of listProjectRecords(vaultRoot, target)) {
    if (existing.frontmatter.status === 'archived') continue;
    refreshTargetMaps(existing);
  }

  const writeCopiedRecord = (rec: MemoRecord): void => {
    const kind = rec.frontmatter.kind;
    const subdir = getSubdirForKind(kind);
    const targetSubdir = path.join(targetDir, subdir);
    if (!fs.existsSync(targetSubdir)) {
      fs.mkdirSync(targetSubdir, { recursive: true });
    }
    const slug = slugKeyForRecord(rec.frontmatter) || String(rec.frontmatter.id);
    let filename: string;
    if (rec.path) {
      filename = path.basename(rec.path);
    } else {
      filename = `${slug}.md`;
    }
    if (!filename.endsWith('.md')) filename = `${filename}.md`;
    const destPath = path.join(targetSubdir, filename);
    const nextFm = { ...rec.frontmatter, project: target } as MemoRecord['frontmatter'];
    const content = serializeRecord({ frontmatter: nextFm, body: rec.body });
    fs.writeFileSync(destPath, content, 'utf8');
    try {
      indexRecord(db, { frontmatter: nextFm, body: rec.body }, destPath);
    } catch {
      // Non-blocking if index fails; final rebuildIndex repairs FTS.
    }
    refreshTargetMaps({ frontmatter: nextFm, body: rec.body, path: destPath });
  };

  const mergeTrapRecords = (targetRec: MemoRecord, sourceRec: MemoRecord): void => {
    const now = new Date().toISOString();
    const mergedFm = {
      ...targetRec.frontmatter,
      occurrences: occurrenceOf(targetRec.frontmatter) + occurrenceOf(sourceRec.frontmatter),
      hits: hitCountOf(targetRec.frontmatter) + hitCountOf(sourceRec.frontmatter),
      lastSeen: maxIsoTimestamp(
        typeof targetRec.frontmatter.lastSeen === 'string' ? targetRec.frontmatter.lastSeen : undefined,
        typeof sourceRec.frontmatter.lastSeen === 'string' ? sourceRec.frontmatter.lastSeen : undefined,
        now
      ),
      updated: maxIsoTimestamp(
        typeof targetRec.frontmatter.updated === 'string' ? targetRec.frontmatter.updated : undefined,
        typeof sourceRec.frontmatter.updated === 'string' ? sourceRec.frontmatter.updated : undefined,
        now
      ),
      tags: unionTags(targetRec.frontmatter.tags, sourceRec.frontmatter.tags)
    } as MemoRecord['frontmatter'];
    // Keep target canonical pathPatterns/body/layer/severity/module.
    if (mergedFm.tags === undefined) {
      delete (mergedFm as Record<string, unknown>).tags;
    }
    const destPath = targetRec.path || path.join(targetDir, getSubdirForKind('trap'), `${slugKeyForRecord(targetRec.frontmatter)}.md`);
    const content = serializeRecord({ frontmatter: mergedFm, body: targetRec.body });
    fs.writeFileSync(destPath, content, 'utf8');
    try {
      indexRecord(db, { frontmatter: mergedFm, body: targetRec.body }, destPath);
    } catch {
      // Non-blocking; final rebuild repairs.
    }
    refreshTargetMaps({ frontmatter: mergedFm, body: targetRec.body, path: destPath });
  };

  const mergeNonTrapRecords = (targetRec: MemoRecord, sourceRec: MemoRecord): void => {
    const targetUpdated = typeof targetRec.frontmatter.updated === 'string' ? targetRec.frontmatter.updated : '';
    const sourceUpdated = typeof sourceRec.frontmatter.updated === 'string' ? sourceRec.frontmatter.updated : '';
    const keepSourceBody = sourceUpdated > targetUpdated;
    const mergedFm = {
      ...targetRec.frontmatter,
      hits: hitCountOf(targetRec.frontmatter) + hitCountOf(sourceRec.frontmatter),
      updated: maxIsoTimestamp(targetUpdated || undefined, sourceUpdated || undefined, new Date().toISOString()),
      tags: unionTags(targetRec.frontmatter.tags, sourceRec.frontmatter.tags)
    } as MemoRecord['frontmatter'];
    if (mergedFm.tags === undefined) {
      delete (mergedFm as Record<string, unknown>).tags;
    }
    const mergedBody = keepSourceBody ? sourceRec.body : targetRec.body;
    const destPath = targetRec.path || path.join(targetDir, getSubdirForKind(targetRec.frontmatter.kind), `${slugKeyForRecord(targetRec.frontmatter)}.md`);
    const content = serializeRecord({ frontmatter: mergedFm, body: mergedBody });
    fs.writeFileSync(destPath, content, 'utf8');
    try {
      indexRecord(db, { frontmatter: mergedFm, body: mergedBody }, destPath);
    } catch {
      // Non-blocking; final rebuild repairs.
    }
    refreshTargetMaps({ frontmatter: mergedFm, body: mergedBody, path: destPath });
  };

  for (const source of sources) {
    const records = listProjectRecords(vaultRoot, source).filter(
      (r) => r.frontmatter.status !== 'archived'
    );
    for (const rec of records) {
      const recordId = String(rec.frontmatter.id);
      // Exact ID match in target: skipped (no write, no dedup).
      if (byId.has(recordId)) {
        skipped++;
        continue;
      }
      if (!dedup) {
        writeCopiedRecord(rec);
        copied++;
        continue;
      }
      const kind = rec.frontmatter.kind;
      const slug = slugKeyForRecord(rec.frontmatter);
      const title = typeof rec.frontmatter.title === 'string' ? rec.frontmatter.title : '';
      let match: MemoRecord | null = null;
      if (kind === 'trap') {
        // Decision table: slug -> title -> semantic (same pathPatterns + overlap>=0.7).
        if (slug && bySlug.has(slug)) {
          match = bySlug.get(slug) || null;
        }
        if (!match && rec.frontmatter.id && bySlug.has(String(rec.frontmatter.id))) {
          match = bySlug.get(String(rec.frontmatter.id)) || null;
        }
        if (!match && title.trim()) {
          const key = `${kind}:${normalizeTitleForMerge(title)}`;
          if (titleMap.has(key)) match = titleMap.get(key) || null;
        }
        if (!match) {
          try {
            const semantic = findMatchingTrap(
              targetDir,
              recordId,
              slug,
              Array.isArray(rec.frontmatter.pathPatterns) ? [...(rec.frontmatter.pathPatterns as string[])] : undefined,
              rec.body
            );
            if (semantic) {
              // Re-resolve via byId to get the freshest merged copy.
              match = byId.get(String(semantic.frontmatter.id)) || semantic;
            }
          } catch {
            match = null;
          }
        }
        if (match) {
          mergeTrapRecords(match, rec);
          deduplicated++;
        } else {
          writeCopiedRecord(rec);
          copied++;
        }
      } else {
        // Decisions/specs/plans (and other non-trap kinds): slug or normalized title.
        if (slug && bySlug.has(slug)) {
          match = bySlug.get(slug) || null;
        }
        if (!match && title.trim()) {
          const key = `${kind}:${normalizeTitleForMerge(title)}`;
          if (titleMap.has(key)) match = titleMap.get(key) || null;
        }
        if (!match) {
          try {
            const nonTrap = findMatchingNonTrapRecord(targetDir, kind, slug, title);
            if (nonTrap) {
              match = byId.get(String(nonTrap.frontmatter.id)) || nonTrap;
            }
          } catch {
            match = null;
          }
        }
        if (match) {
          mergeNonTrapRecords(match, rec);
          deduplicated++;
        } else {
          writeCopiedRecord(rec);
          copied++;
        }
      }
    }
  }

  return { copied, deduplicated, skipped };
}

export async function renameVaultProject(
  from: string,
  to: string,
  vaultRoot: string = getVaultRoot()
): Promise<{ ok: true; from: string; to: string }> {
  const source = normalizeProjectId(from).toLowerCase();
  const dest = normalizeProjectId(to).toLowerCase();
  if (!source || !dest) {
    throw new VaultManagerError('Both "from" and "to" project ids are required');
  }
  if (source === dest) {
    throw new VaultManagerError('Rename source and target must differ');
  }
  if (!isFilesystemSafeProjectId(dest)) {
    throw new VaultManagerError(`Invalid target project id "${to}"`);
  }
  if (!isFilesystemSafeProjectId(source)) {
    throw new VaultManagerError(`Invalid source project id "${from}"`);
  }
  if (!projectDirExists(vaultRoot, source)) {
    throw new VaultManagerError(`Unknown source project id "${source}"`, 404);
  }
  if (projectDirExists(vaultRoot, dest) || isAliasKey(vaultRoot, dest)) {
    throw new VaultManagerError(`Target project id "${dest}" already exists`, 409);
  }

  return withVaultLock(vaultRoot, async () => {
    // Re-check races under lock.
    if (!projectDirExists(vaultRoot, source)) {
      throw new VaultManagerError(`Unknown source project id "${source}"`, 404);
    }
    if (projectDirExists(vaultRoot, dest) || isAliasKey(vaultRoot, dest)) {
      throw new VaultManagerError(`Target project id "${dest}" already exists`, 409);
    }
    const fromDir = path.join(vaultRoot, 'projects', source);
    const toDir = path.join(vaultRoot, 'projects', dest);
    fs.renameSync(fromDir, toDir);
    const projectJsonPath = path.join(toDir, 'project.json');
    try {
      let meta: Record<string, unknown> = {};
      if (fs.existsSync(projectJsonPath)) {
        meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8')) as Record<string, unknown>;
      }
      meta.projectId = dest;
      meta.updated = new Date().toISOString();
      delete meta.canonicalOf;
      fs.writeFileSync(projectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      // Ignore corrupt project.json; directory rename already succeeded.
    }
    const aliases = { ...readProjectAliases(vaultRoot) };
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(aliases)) {
      let nk = k;
      let nv = v;
      if (v === source) nv = dest;
      if (k === source) nk = dest;
      next[nk] = nv;
    }
    // Drop self-loop if created.
    if (next[dest] === dest) {
      delete next[dest];
    }
    // Cycle guard before write: verify no cycle in final map.
    const visitedCheck = (start: string): boolean => {
      const seen = new Set<string>();
      let cur: string | undefined = start;
      while (cur && next[cur]) {
        if (seen.has(cur)) return true;
        seen.add(cur);
        cur = next[cur];
      }
      return false;
    };
    for (const k of Object.keys(next)) {
      if (visitedCheck(k)) {
        try {
          if (!projectDirExists(vaultRoot, source) && projectDirExists(vaultRoot, dest)) {
            fs.renameSync(toDir, fromDir);
          }
        } catch {
          // Best effort.
        }
        throw new VaultManagerError(`Rename would create an alias cycle involving "${k}"`);
      }
    }
    writeProjectAliases(vaultRoot, next, `rename ${source} -> ${dest}`);
    await rebuildIndex(vaultRoot);
    try {
      rebuildCompiledViews(dest, vaultRoot);
    } catch {
      // Non-blocking if views fail; index already rebuilt.
    }
    commitVaultChange(`rename ${source} -> ${dest}`, vaultRoot, [path.join('projects', dest)]);
    return { ok: true as const, from: source, to: dest };
  });
}

export async function mergeVaultProjects(options: {
  sources: string[];
  target: string;
  copyRecords?: boolean;
  dedup?: boolean;
  deleteSources?: boolean;
  vaultRoot?: string;
}): Promise<{
  ok: true;
  target: string;
  sources: string[];
  copied: number;
  deduplicated: number;
  skipped: number;
}> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const target = normalizeProjectId(options.target);
  const sources = (options.sources || []).map(normalizeProjectId).filter(Boolean);
  const copyRecords = options.copyRecords === true;
  // dedup defaults to true when copyRecords is true, otherwise ignored.
  const dedup = options.dedup === undefined ? true : options.dedup === true;
  const deleteSources = options.deleteSources === true;

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
  if (deleteSources && !copyRecords) {
    throw new VaultManagerError('"deleteSources" requires "copyRecords" to preserve records');
  }
  for (const src of sources) {
    if (!isFilesystemSafeProjectId(src)) {
      throw new VaultManagerError(`Invalid source project id "${src}"`);
    }
    if (!projectDirExists(vaultRoot, src) && !isAliasKey(vaultRoot, src)) {
      throw new VaultManagerError(`Unknown source project id "${src}"`, 404);
    }
  }

  return withVaultLock(vaultRoot, async () => {
    if (!projectDirExists(vaultRoot, target)) {
      initVault({ vaultRoot, projectId: target });
      ensureProjectVault(targetIdentity(target, vaultRoot), vaultRoot);
    }

    const aliases = { ...readProjectAliases(vaultRoot) };
    if (aliases[target]) {
      delete aliases[target];
    }
    for (const src of sources) {
      if (wouldCreateCycle(aliases, src, target)) {
        throw new VaultManagerError(`Merge would create an alias cycle involving "${src}"`);
      }
      aliases[src] = target;
    }

    let copied = 0;
    let deduplicated = 0;
    let skipped = 0;
    if (copyRecords) {
      const copyResult = await copyRecordsToTarget(sources, target, vaultRoot, { dedup });
      copied = copyResult.copied;
      deduplicated = copyResult.deduplicated;
      skipped = copyResult.skipped;
    }

    const targetProjectJsonPath = path.join(vaultRoot, 'projects', target, 'project.json');
    if (fs.existsSync(targetProjectJsonPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(targetProjectJsonPath, 'utf8')) as Record<string, unknown>;
        if (meta.canonicalOf) {
          delete meta.canonicalOf;
          fs.writeFileSync(targetProjectJsonPath, JSON.stringify(meta, null, 2), 'utf8');
        }
      } catch {
        // ignore
      }
    }
    for (const src of sources) {
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

    if (deleteSources) {
      for (const src of sources) {
        if (src === target) continue;
        const srcDir = path.join(vaultRoot, 'projects', src);
        try {
          if (fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
            fs.rmSync(srcDir, { recursive: true, force: true });
          }
        } catch {
          // Best effort; alias redirect already retained.
        }
      }
    }

    if (copyRecords || deleteSources) {
      await rebuildIndex(vaultRoot);
      try {
        rebuildCompiledViews(target, vaultRoot);
      } catch {
        // Non-blocking if views fail; index already rebuilt.
      }
    }

    commitVaultChange(`merge projects -> ${target}`, vaultRoot, [
      path.join('projects', target),
      ...sources.map((s) => path.join('projects', s))
    ]);

    return { ok: true, target, sources, copied, deduplicated, skipped };
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
