import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { commitVaultChange, withVaultLock } from '../vault.js';
import { indexRecord, openIndex } from '../indexer.js';
import { parseRecord, serializeRecord } from '../schema.js';
import { sanitizeToolOutput, scanPayloadForSecrets } from '../safety.js';
import type { ActivityBus } from '../activity.js';
import type { RecordKind, RecordFrontmatter } from '../types.js';
import type { VaultAiAgent, VaultAiRefineInput } from './types.js';

/**
 * Kinds eligible for background refine by default (spec § Eligible kinds).
 * `log`, `scratch`, `review`, `state`, `session` (and `prompt`) never enqueue.
 */
export const AI_REFINE_ELIGIBLE_KINDS: ReadonlySet<RecordKind> = new Set([
  'trap',
  'decision',
  'spec',
  'plan'
]);

export function isAiRefineEligibleKind(kind: RecordKind): boolean {
  return AI_REFINE_ELIGIBLE_KINDS.has(kind);
}

export function hashRecordBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export interface EnqueueRefineArgs {
  vaultRoot: string;
  projectId: string;
  filePath: string;
  id: string;
  kind: RecordKind;
  title: string;
  body: string;
  tags: string[];
  pathPatterns: string[];
  agent: VaultAiAgent;
  timeoutMs?: number;
  /** Global background parallelism cap (`config.ai.maxConcurrent`, default 1). */
  maxConcurrent?: number;
}

// --- module-global queue state (single-flight per record id, AC13) ---

const pendingJobs = new Map<string, { promise: Promise<void>; generation: number }>();
const droppedGenerations = new Map<string, number>();
let aiLastError: string | null = null;
let aiActivityBus: ActivityBus | null = null;
let activeRefineCount = 0;
interface WaitingRefine {
  args: EnqueueRefineArgs;
  generation: number;
  limit: number;
  begin: () => void;
}
const waitingRefines: WaitingRefine[] = [];

function pumpRefineQueue(): void {
  while (waitingRefines.length > 0) {
    const head = waitingRefines[0];
    if (!head || activeRefineCount >= head.limit) break;
    waitingRefines.shift();
    activeRefineCount += 1;
    head.begin();
  }
}

/**
 * Clearable timeout race shared by refine and rank. The timer is always
 * cleared on settle so background AI calls never hold the event loop open
 * (and never delay CLI exit) after success.
 */
export function withAiTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function setAiActivityBus(bus: ActivityBus | null): void {
  aiActivityBus = bus;
}

export function getAiActivityBus(): ActivityBus | null {
  return aiActivityBus;
}

/** Current refine queue depth for doctor/status (AC28–AC29). */
export function getAiQueueDepth(): number {
  return pendingJobs.size;
}

/** Last redacted refine/rank error for doctor/status (AC28). Secrets stripped. */
export function getAiLastError(): string | null {
  return aiLastError;
}

export function recordAiLastError(err: unknown): void {
  try {
    const raw = err instanceof Error ? err.message : String(err);
    const clean = String(sanitizeToolOutput(raw)).slice(0, 300);
    aiLastError = clean || 'ai error';
  } catch {
    aiLastError = 'ai error';
  }
}

export function clearAiStateForTests(): void {
  pendingJobs.clear();
  droppedGenerations.clear();
  waitingRefines.length = 0;
  activeRefineCount = 0;
  aiLastError = null;
  aiActivityBus = null;
}

function emitAiActivity(
  operation: 'ai.refine.ok' | 'ai.refine.fail' | 'ai.rank.ok' | 'ai.rank.fail',
  ok: boolean,
  durationMs: number,
  recordId?: string,
  projectId?: string
): void {
  const bus = aiActivityBus;
  if (!bus) return;
  try {
    // No prompt bodies, no snippets — recordId + duration only (AC30).
    bus.capture({
      type: 'system',
      kind: 'meta',
      ok,
      durationMs,
      summary: `${operation}${recordId ? ` ${recordId}` : ''} (${Math.round(durationMs)}ms)`,
      operation,
      projectId
    });
  } catch {
    // Activity must never break the AI path (fail-open).
  }
}

export function emitAiRankActivity(
  ok: boolean,
  durationMs: number,
  projectId?: string
): void {
  emitAiActivity(ok ? 'ai.rank.ok' : 'ai.rank.fail', ok, durationMs, undefined, projectId);
}

/**
 * Drop a pending refine job and its retrieval aids when a record is
 * forgotten/purged (AC19). In-flight jobs observe the drop and abort
 * before writing. Only the matching generation is cancelled, so a
 * re-upserted record keeps its fresh job.
 */
export function dropPendingRefineForRecord(id: string): void {
  const pending = pendingJobs.get(id);
  if (pending) {
    droppedGenerations.set(id, pending.generation);
    pendingJobs.delete(id);
  } else {
    droppedGenerations.delete(id);
  }
}

function isDropped(id: string, generation: number): boolean {
  return droppedGenerations.get(id) === generation;
}

function finishGeneration(id: string, generation: number): void {
  const pending = pendingJobs.get(id);
  if (pending && pending.generation === generation) {
    pendingJobs.delete(id);
  }
  if (droppedGenerations.get(id) === generation) {
    droppedGenerations.delete(id);
  }
}

function sanitizeTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return [];
  return terms
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

async function runRefineJob(args: EnqueueRefineArgs, generation: number): Promise<void> {
  const started = Date.now();
  const { vaultRoot, projectId, filePath, id, kind, agent } = args;

  try {
    if (isDropped(id, generation)) return;
    if (!agent.isAvailable()) return;

    // Always refine the latest file content so coalesced duplicates converge.
    let currentBody: string;
    let currentTitle: string;
    let currentTags: string[];
    let currentPatterns: string[];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseRecord(raw, filePath);
      currentBody = parsed.body;
      currentTitle =
        typeof parsed.frontmatter.title === 'string' && parsed.frontmatter.title.trim().length > 0
          ? parsed.frontmatter.title
          : args.title;
      currentTags = Array.isArray(parsed.frontmatter.tags)
        ? parsed.frontmatter.tags.map(String)
        : args.tags;
      currentPatterns = Array.isArray(parsed.frontmatter.pathPatterns)
        ? parsed.frontmatter.pathPatterns.map(String)
        : args.pathPatterns;
    } catch {
      return;
    }
    if (isDropped(id, generation)) return;

    const inputHash = hashRecordBody(currentBody);
    const input: VaultAiRefineInput = {
      id,
      kind,
      title: currentTitle,
      body: currentBody,
      tags: currentTags,
      pathPatterns: currentPatterns
    };
    const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 15000;
    const result = await withAiTimeout(
      Promise.resolve(agent.refineForSearch(input)),
      timeoutMs + 1000,
      'ai refine'
    );

    if (isDropped(id, generation)) return;
    if (!result || result.ok !== true) {
      if (result?.error) recordAiLastError(result.error);
      emitAiActivity('ai.refine.fail', false, Date.now() - started, id, projectId);
      return;
    }

    const searchTerms = sanitizeTerms(result.searchTerms);
    const summary =
      typeof result.summary === 'string' && result.summary.trim().length > 0
        ? result.summary.trim().slice(0, 500)
        : undefined;
    if (searchTerms.length === 0 && !summary) {
      emitAiActivity('ai.refine.ok', true, Date.now() - started, id, projectId);
      return;
    }
    // Defense in depth: a model echo of a redacted credential must never be
    // persisted as retrieval aids. Fail open — no sidecar write.
    const secretScan = scanPayloadForSecrets({ searchTerms, summary });
    if (secretScan.hasSecret) {
      recordAiLastError(
        `ai refine output contained a redacted secret (${secretScan.matches.join(', ')})`
      );
      emitAiActivity('ai.refine.fail', false, Date.now() - started, id, projectId);
      return;
    }

    // Persist retrieval aids only (never body) under the vault lock (AC15).
    await withVaultLock(vaultRoot, async () => {
      if (isDropped(id, generation)) return;
      let diskBody: string;
      let diskFm: Record<string, unknown>;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = parseRecord(raw, filePath);
        diskBody = parsed.body;
        diskFm = { ...(parsed.frontmatter as unknown as Record<string, unknown>) };
      } catch {
        return;
      }
      // Idempotent skip: aids already match this body hash (AC16).
      if (diskFm['aiRefineHash'] === inputHash) return;
      // Body moved while the agent worked: finish this generation first so
      // the re-enqueue is not swallowed by our own single-flight entry,
      // then refine the fresh text instead of attaching stale aids.
      if (hashRecordBody(diskBody) !== inputHash) {
        finishGeneration(id, generation);
        enqueueRefineJob({ ...args, body: diskBody });
        return;
      }
      diskFm['aiSearchTerms'] = searchTerms;
      if (summary) diskFm['aiSummary'] = summary;
      else delete diskFm['aiSummary'];
      diskFm['aiRefineHash'] = inputHash;
      const record = parseRecord(
        serializeRecord({
          frontmatter: diskFm as unknown as RecordFrontmatter,
          body: diskBody
        }),
        filePath
      );
      fs.writeFileSync(
        filePath,
        serializeRecord({ frontmatter: record.frontmatter, body: record.body }),
        'utf8'
      );
      try {
        const db = openIndex(vaultRoot);
        indexRecord(db, { frontmatter: record.frontmatter, body: record.body }, filePath);
      } catch (err) {
        recordAiLastError(err);
      }
      commitVaultChange(`ai-refine ${kind}:${id}`, vaultRoot, [
        path.join('projects', projectId)
      ]);
    });
    emitAiActivity('ai.refine.ok', true, Date.now() - started, id, projectId);
  } catch (err) {
    // Agent or I/O failure: markdown stays intact, FTS keeps pre-refine text (AC17).
    recordAiLastError(err);
    emitAiActivity('ai.refine.fail', false, Date.now() - started, id, projectId);
  } finally {
    finishGeneration(id, generation);
    activeRefineCount = Math.max(0, activeRefineCount - 1);
    pumpRefineQueue();
  }
}

/**
 * Enqueue at most one background refine job per record id (AC13).
 * Global parallelism is capped by `maxConcurrent` (default 1) so bursts of
 * upserts cannot stampede the agent or the vault lock. Overflow waits in a
 * FIFO and still counts toward queue depth.
 * The caller never awaits the agent. Floating promises are forbidden:
 * every path is handled via `void job.catch(...)` (AC14).
 * Returns true when a job is (or already is) queued.
 */
export function enqueueRefineJob(args: EnqueueRefineArgs): boolean {
  if (!isAiRefineEligibleKind(args.kind)) return false;
  if (!args.agent || !args.agent.isAvailable()) return false;
  if (pendingJobs.has(args.id)) return true;

  const limit = args.maxConcurrent && args.maxConcurrent > 0 ? Math.floor(args.maxConcurrent) : 1;
  const generation = (droppedGenerations.get(args.id) ?? 0) + 1;
  droppedGenerations.delete(args.id);

  let job: Promise<void>;
  const begin = (): void => {
    // Reserve the single-flight slot BEFORE starting the job: a fast path
    // (missing file, unavailable agent, idempotent skip) settles entirely in
    // runRefineJob's synchronous prefix, and its finally must observe — and
    // clean up — our entry exactly once. Setting the slot after the call
    // would orphan a stale entry that never clears.
    const slot: { promise: Promise<void>; generation: number } = {
      promise: Promise.resolve(),
      generation
    };
    pendingJobs.set(args.id, slot);
    const real = runRefineJob(args, generation);
    slot.promise = real;
    job = real;
    void real.catch((err: unknown) => {
      recordAiLastError(err);
    });
  };

  if (activeRefineCount >= limit) {
    // Deferred start: reserve the single-flight slot now so duplicates
    // coalesce while waiting, and pump the FIFO when a slot frees.
    job = new Promise<void>((resolve, reject) => {
      waitingRefines.push({
        args,
        generation,
        limit,
        begin: () => {
          try {
            begin();
            pendingJobs.get(args.id)?.promise.then(resolve, reject);
          } catch (err) {
            reject(err);
          }
        }
      });
    });
    pendingJobs.set(args.id, { promise: job, generation });
    void job.catch((err: unknown) => {
      recordAiLastError(err);
    });
    return true;
  }

  activeRefineCount += 1;
  begin();
  return true;
}
