import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MemoRecord,
  MemoryRecordListItem,
  RecordFrontmatter,
  RecordKind,
  RecordStatus
} from './types.js';
import { serializeRecord, parseRecord } from './schema.js';
import {
  getVaultRoot,
  withVaultLock,
  commitVaultChange,
  RECORD_SUBDIRS,
  getVaultProjects
} from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { openIndex, indexRecord } from './indexer.js';
import { logErrorReport } from './error-logger.js';
import { occurrenceOf, lastSeenOf, hitCountOf, lastHitOf } from './recurrence.js';
import { rebuildCompiledViews } from './compiler.js';

/** Overridable for fail-open tests. */
let writeRecordFile: typeof fs.writeFileSync = fs.writeFileSync.bind(fs);

/** Test helper — inject write failures for AC22 fail-open coverage. */
export function setMemoryHitWriteFileForTests(
  fn: typeof fs.writeFileSync | null
): void {
  writeRecordFile = fn ? fn : fs.writeFileSync.bind(fs);
}

export { hitCountOf, lastHitOf, compareHitsSearch } from './recurrence.js';

export const HIT_ELIGIBLE_KINDS: readonly RecordKind[] = [
  'trap',
  'decision',
  'spec',
  'plan'
];

export type MemoryHitSource = 'bootstrap' | 'get' | 'search';

export interface RecordMemoryHitsOptions {
  ids: string[];
  sessionId?: string;
  source: MemoryHitSource;
  projectId?: string;
  /** Optional per-record projectId hints (e.g. from SearchHit.projectId). */
  idProjectHints?: Record<string, string>;
  vaultRoot?: string;
  cwd?: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;

interface PersistedSessionEntry {
  updatedAt: string;
  ids: string[];
}

interface PersistedSessionsFile {
  sessions: Record<string, PersistedSessionEntry>;
}

interface SessionCacheEntry {
  updatedAt: string;
  ids: Set<string>;
}

/** In-memory session de-dupe cache: key = `${vaultRoot}::${sessionId}`. Backed by vault file. */
const sessionHitSeen = new Map<string, SessionCacheEntry>();

function sessionsFilePath(vaultRoot: string): string {
  return path.join(vaultRoot, '.sync', 'memory-hit-sessions.json');
}

function sessionKey(vaultRoot: string, sessionId: string): string {
  return `${vaultRoot}::${sessionId}`;
}

function parseSessionIdFromKey(key: string, vaultRoot: string): string | null {
  const prefix = `${vaultRoot}::`;
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length) || null;
}

/** Load persisted sessions for a vault into the in-memory cache (fail-open). */
function hydrateSessionsFromDisk(vaultRoot: string): void {
  const filePath = sessionsFilePath(vaultRoot);
  if (!fs.existsSync(filePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersistedSessionsFile;
    const sessions = raw?.sessions;
    if (!sessions || typeof sessions !== 'object') return;
    const now = Date.now();
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== 'object') continue;
      const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : '';
      const ts = updatedAt ? Date.parse(updatedAt) : NaN;
      if (Number.isFinite(ts) && now - ts > SESSION_TTL_MS) continue;
      const ids = Array.isArray(entry.ids)
        ? entry.ids.filter((id) => typeof id === 'string' && id.trim())
        : [];
      const key = sessionKey(vaultRoot, sessionId);
      const existing = sessionHitSeen.get(key);
      if (existing) {
        for (const id of ids) existing.ids.add(id);
        if (updatedAt && (!existing.updatedAt || updatedAt > existing.updatedAt)) {
          existing.updatedAt = updatedAt;
        }
      } else {
        sessionHitSeen.set(key, {
          updatedAt: updatedAt || new Date().toISOString(),
          ids: new Set(ids)
        });
      }
    }
  } catch {
    // fail-open
  }
}

/** Persist in-memory session cache for a vault (prune + fail-open). */
function persistSessionsToDisk(vaultRoot: string): void {
  try {
    const now = Date.now();
    const entries: Array<{ sessionId: string; updatedAt: string; ids: string[] }> = [];
    for (const [key, entry] of sessionHitSeen) {
      const sessionId = parseSessionIdFromKey(key, vaultRoot);
      if (!sessionId) continue;
      const ts = Date.parse(entry.updatedAt);
      if (Number.isFinite(ts) && now - ts > SESSION_TTL_MS) {
        sessionHitSeen.delete(key);
        continue;
      }
      entries.push({
        sessionId,
        updatedAt: entry.updatedAt,
        ids: [...entry.ids]
      });
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const kept = entries.slice(0, MAX_SESSIONS);
    const dropped = new Set(entries.slice(MAX_SESSIONS).map((e) => e.sessionId));
    for (const sessionId of dropped) {
      sessionHitSeen.delete(sessionKey(vaultRoot, sessionId));
    }

    const payload: PersistedSessionsFile = { sessions: {} };
    for (const e of kept) {
      payload.sessions[e.sessionId] = { updatedAt: e.updatedAt, ids: e.ids };
    }

    const filePath = sessionsFilePath(vaultRoot);
    const syncDir = path.dirname(filePath);
    if (!fs.existsSync(syncDir)) {
      fs.mkdirSync(syncDir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // fail-open
  }
}

/** Test helper — clears in-memory session de-dupe state (disk untouched). */
export function resetMemoryHitSessionsForTests(): void {
  sessionHitSeen.clear();
}

function alreadyHitInSession(vaultRoot: string, sessionId: string, recordId: string): boolean {
  const set = sessionHitSeen.get(sessionKey(vaultRoot, sessionId));
  return Boolean(set?.ids.has(recordId));
}

function markHitInSession(vaultRoot: string, sessionId: string, recordId: string): void {
  const key = sessionKey(vaultRoot, sessionId);
  let entry = sessionHitSeen.get(key);
  if (!entry) {
    entry = { updatedAt: new Date().toISOString(), ids: new Set() };
    sessionHitSeen.set(key, entry);
  }
  entry.ids.add(recordId);
  entry.updatedAt = new Date().toISOString();
}

function scanProjectForRecord(
  vaultRoot: string,
  projectId: string,
  recordId: string
): { record: MemoRecord; filePath: string; projectId: string } | null {
  const projectDir = path.join(vaultRoot, 'projects', projectId);
  if (!fs.existsSync(projectDir)) return null;

  for (const sub of RECORD_SUBDIRS) {
    const direct = path.join(projectDir, sub, `${recordId}.md`);
    if (fs.existsSync(direct)) {
      try {
        const record = parseRecord(fs.readFileSync(direct, 'utf8'), direct);
        return { record, filePath: direct, projectId };
      } catch {
        return null;
      }
    }
  }

  // Slow path: scan frontmatter id
  for (const sub of RECORD_SUBDIRS) {
    const dir = path.join(projectDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
      const filePath = path.join(dir, file);
      try {
        const record = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
        if (String(record.frontmatter.id) === recordId) {
          return { record, filePath, projectId };
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

/**
 * Resolve a record by id across vault projects.
 * Prefer hint projectId, then primaryProjectId, then scan getVaultProjects.
 */
function findRecordFile(
  vaultRoot: string,
  recordId: string,
  primaryProjectId: string,
  hintProjectId?: string
): { record: MemoRecord; filePath: string; projectId: string } | null {
  const tried = new Set<string>();

  const tryProject = (projectId: string | undefined) => {
    if (!projectId || tried.has(projectId)) return null;
    tried.add(projectId);
    return scanProjectForRecord(vaultRoot, projectId, recordId);
  };

  const fromHint = tryProject(hintProjectId);
  if (fromHint) return fromHint;

  const fromPrimary = tryProject(primaryProjectId);
  if (fromPrimary) return fromPrimary;

  for (const p of getVaultProjects(vaultRoot)) {
    const found = tryProject(p.id);
    if (found) return found;
  }
  return null;
}

/**
 * Bump retrieval hits on eligible records. Fail-open: never throws to callers.
 * Markdown remains source of truth; follows vault-git atomic/batched via commitVaultChange.
 * Resolves ids across vault projects when needed (crossProject search hits).
 */
export async function recordMemoryHits(options: RecordMemoryHitsOptions): Promise<{ bumped: string[] }> {
  const bumped: string[] = [];
  const uniqueIds = [...new Set((options.ids || []).filter((id) => typeof id === 'string' && id.trim()))];
  if (uniqueIds.length === 0) return { bumped };

  const vaultRoot = options.vaultRoot || getVaultRoot();
  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId.trim()
      ? options.sessionId.trim()
      : undefined;
  const idProjectHints = options.idProjectHints || {};

  try {
    await withVaultLock(vaultRoot, async () => {
      // Refresh session cache from disk under lock so CLI/SSE share de-dupe state.
      hydrateSessionsFromDisk(vaultRoot);

      const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
      const primaryProjectId = options.projectId || identity.projectId;
      const now = new Date().toISOString();
      const touchedProjects = new Set<string>();
      let sessionDirty = false;

      for (const id of uniqueIds) {
        if (sessionId && alreadyHitInSession(vaultRoot, sessionId, id)) {
          continue;
        }

        const hint = typeof idProjectHints[id] === 'string' ? idProjectHints[id] : undefined;
        const found = findRecordFile(vaultRoot, id, primaryProjectId, hint);
        if (!found) continue;
        if (!isHitEligibleKind(found.record.frontmatter.kind)) continue;

        const nextHits = hitCountOf(found.record.frontmatter) + 1;
        const nextFm: RecordFrontmatter = {
          ...found.record.frontmatter,
          hits: nextHits,
          lastHit: now
        };

        const content = serializeRecord({ frontmatter: nextFm, body: found.record.body });
        writeRecordFile(found.filePath, content, 'utf8');
        try {
          const db = openIndex(vaultRoot);
          indexRecord(db, { frontmatter: nextFm, body: found.record.body }, found.filePath);
        } catch {
          // Non-blocking FTS; doctor --rebuild can repair
        }

        if (sessionId) {
          markHitInSession(vaultRoot, sessionId, id);
          sessionDirty = true;
        }
        bumped.push(id);
        touchedProjects.add(found.projectId);
      }

      if (sessionDirty) {
        persistSessionsToDisk(vaultRoot);
      }

      if (touchedProjects.size > 0) {
        for (const pid of touchedProjects) {
          rebuildCompiledViews(pid, vaultRoot);
        }
        commitVaultChange(
          `memory-hits ${options.source}`,
          vaultRoot,
          [...touchedProjects].map((pid) => path.join('projects', pid))
        );
      }
    });
  } catch (err: unknown) {
    logErrorReport(
      {
        subsystem: 'memory-hits',
        tool: options.source,
        projectId: options.projectId,
        error: err,
        context: { ids: uniqueIds, sessionId, source: options.source }
      },
      { vaultRoot }
    );
  }

  return { bumped };
}

/**
 * Collect hit-eligible record ids present in a bootstrap brief payload.
 */
export function collectBootstrapHitIds(brief: {
  traps?: MemoRecord[];
  decisions?: MemoRecord[];
  activeSlice?: { spec?: MemoRecord; plan?: MemoRecord; state?: MemoRecord };
}): string[] {
  const ids: string[] = [];
  for (const trap of brief.traps || []) {
    if (isHitEligibleKind(trap.frontmatter.kind) && trap.frontmatter.id) {
      ids.push(String(trap.frontmatter.id));
    }
  }
  for (const decision of brief.decisions || []) {
    if (isHitEligibleKind(decision.frontmatter.kind) && decision.frontmatter.id) {
      ids.push(String(decision.frontmatter.id));
    }
  }
  const slice = brief.activeSlice;
  if (slice?.spec?.frontmatter?.id && isHitEligibleKind(slice.spec.frontmatter.kind)) {
    ids.push(String(slice.spec.frontmatter.id));
  }
  if (slice?.plan?.frontmatter?.id && isHitEligibleKind(slice.plan.frontmatter.kind)) {
    ids.push(String(slice.plan.frontmatter.id));
  }
  return ids;
}

export interface ListMemoryRecordsOptions {
  vaultRoot?: string;
  projectId?: string;
  kind?: RecordKind | string;
  sort?: 'hits' | 'occurrences' | 'updated';
  limit?: number;
  /** When true, include prompt/session/log/scratch. Default excludes them. */
  includeEphemeral?: boolean;
}

const DEFAULT_EXCLUDED_KINDS = new Set(['prompt', 'session', 'log', 'scratch']);

/**
 * Read-only listing for status monitor Memory tab. Never increments hits.
 */
export function listMemoryRecords(options: ListMemoryRecordsOptions = {}): MemoryRecordListItem[] {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const projectIds = options.projectId
    ? [options.projectId]
    : getVaultProjects(vaultRoot).map((p) => p.id);

  const items: MemoryRecordListItem[] = [];

  for (const projectId of projectIds) {
    const projectDir = path.join(vaultRoot, 'projects', projectId);
    if (!fs.existsSync(projectDir)) continue;

    for (const sub of RECORD_SUBDIRS) {
      const dir = path.join(projectDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
        const filePath = path.join(dir, file);
        try {
          const record = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
          const kind = record.frontmatter.kind;
          if (options.kind && kind !== options.kind) continue;
          if (!options.includeEphemeral && DEFAULT_EXCLUDED_KINDS.has(kind)) continue;

          const body = record.body || '';
          const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 400);
          items.push({
            id: String(record.frontmatter.id),
            projectId: String(record.frontmatter.project || projectId),
            kind,
            status: record.frontmatter.status as RecordStatus,
            title:
              typeof record.frontmatter.title === 'string'
                ? record.frontmatter.title
                : undefined,
            hits: hitCountOf(record.frontmatter),
            occurrences: occurrenceOf(record.frontmatter),
            lastHit: lastHitOf(record.frontmatter) || null,
            lastSeen: lastSeenOf(record.frontmatter) || null,
            updated: String(record.frontmatter.updated || ''),
            snippet: snippet || undefined
          });
        } catch {
          // skip malformed
        }
      }
    }
  }

  const sort = options.sort || 'hits';
  if (sort === 'occurrences') {
    items.sort((a, b) => {
      const occ = b.occurrences - a.occurrences;
      if (occ !== 0) return occ;
      return String(b.updated).localeCompare(String(a.updated));
    });
  } else if (sort === 'updated') {
    items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  } else {
    items.sort((a, b) => {
      const h = b.hits - a.hits;
      if (h !== 0) return h;
      const lh = String(b.lastHit || '').localeCompare(String(a.lastHit || ''));
      if (lh !== 0) return lh;
      return String(b.updated).localeCompare(String(a.updated));
    });
  }

  const limit = options.limit && options.limit > 0 ? options.limit : 200;
  return items.slice(0, limit);
}

export function isHitEligibleKind(kind: unknown): kind is RecordKind {
  return typeof kind === 'string' && (HIT_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}
