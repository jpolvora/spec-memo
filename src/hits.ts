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
  vaultRoot?: string;
  cwd?: string;
}

/** In-process session de-dupe: key = `${vaultRoot}::${sessionId}` → set of record ids. */
const sessionHitSeen = new Map<string, Set<string>>();

/** Test helper — clears session de-dupe state. */
export function resetMemoryHitSessionsForTests(): void {
  sessionHitSeen.clear();
}

export function isHitEligibleKind(kind: unknown): kind is RecordKind {
  return typeof kind === 'string' && (HIT_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}

function sessionKey(vaultRoot: string, sessionId: string): string {
  return `${vaultRoot}::${sessionId}`;
}

function alreadyHitInSession(vaultRoot: string, sessionId: string, recordId: string): boolean {
  const set = sessionHitSeen.get(sessionKey(vaultRoot, sessionId));
  return Boolean(set?.has(recordId));
}

function markHitInSession(vaultRoot: string, sessionId: string, recordId: string): void {
  const key = sessionKey(vaultRoot, sessionId);
  let set = sessionHitSeen.get(key);
  if (!set) {
    set = new Set();
    sessionHitSeen.set(key, set);
  }
  set.add(recordId);
}

function findRecordFile(
  vaultRoot: string,
  projectId: string,
  recordId: string
): { record: MemoRecord; filePath: string } | null {
  const projectDir = path.join(vaultRoot, 'projects', projectId);
  if (!fs.existsSync(projectDir)) return null;

  for (const sub of RECORD_SUBDIRS) {
    const direct = path.join(projectDir, sub, `${recordId}.md`);
    if (fs.existsSync(direct)) {
      try {
        const record = parseRecord(fs.readFileSync(direct, 'utf8'), direct);
        return { record, filePath: direct };
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
          return { record, filePath };
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

/**
 * Bump retrieval hits on eligible records. Fail-open: never throws to callers.
 * Markdown remains source of truth; follows vault-git atomic/batched via commitVaultChange.
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

  try {
    await withVaultLock(vaultRoot, async () => {
      const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
      const projectId = options.projectId || identity.projectId;
      const now = new Date().toISOString();
      let anyWritten = false;

      for (const id of uniqueIds) {
        if (sessionId && alreadyHitInSession(vaultRoot, sessionId, id)) {
          continue;
        }

        const found = findRecordFile(vaultRoot, projectId, id);
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
        }
        bumped.push(id);
        anyWritten = true;
      }

      if (anyWritten) {
        rebuildCompiledViews(projectId, vaultRoot);
        commitVaultChange(`memory-hits ${options.source}`, vaultRoot, [
          path.join('projects', projectId)
        ]);
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
