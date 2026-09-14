import type { SearchHit, AiRankDisposition } from '../types.js';
import type { VaultAiAgent } from './types.js';
import { emitAiRankActivity, recordAiLastError, reportAiFailure, withAiTimeout } from './refine-queue.js';
import { recordAiOpsEvent, readAiOpsConfig, isAiOpsLogEnabled } from './ops-log.js';
import { VAULT_AI_DEFAULT_TIMEOUT_MS } from './config.js';

export interface RankRecordsArgs<T> {
  agent: VaultAiAgent | null | undefined;
  query: string | undefined;
  items: T[];
  toCandidate: (item: T) => { id: string; kind: string; title: string; snippet: string };
  rankTopK: number;
  timeoutMs?: number;
  projectId?: string;
  /** Vault root for the durable AI ops journal (spec 0057). Omitted skips journaling. */
  vaultRoot?: string;
}

export interface RankRecordsResult<T> {
  items: T[];
  aiRank: AiRankDisposition;
}

/**
 * Durable AI ops journal row for one rank settlement (spec 0057, AC8).
 * `candidateIds` carries ids only — never snippets (AC8). Fail-open.
 */
function journalRankSettlement(args: {
  vaultRoot?: string;
  projectId?: string;
  query: string;
  candidateIds: string[];
  orderedIds?: string[];
  ok: boolean;
  durationMs: number;
  error?: string;
  candidateCount: number;
}): void {
  if (!args.vaultRoot) return;
  try {
    const config = readAiOpsConfig(args.vaultRoot);
    if (!isAiOpsLogEnabled(config)) return;
    recordAiOpsEvent({
      vaultRoot: args.vaultRoot,
      config,
      operation: 'rank',
      ok: args.ok,
      durationMs: args.durationMs,
      projectId: args.projectId,
      input: { query: args.query, candidateIds: args.candidateIds },
      output: args.ok ? { orderedIds: args.orderedIds } : undefined,
      error: args.ok ? undefined : args.error,
      metadata: { agent: 'vault-ai', candidateCount: args.candidateCount }
    });
  } catch {
    // Journal must never break the rank path (fail-open).
  }
}

/**
 * Generic post-lexical rerank: reorder at most the first `rankTopK` items
 * via the agent; unreturned ids keep their relative lexical tail order
 * after the ranked prefix. Fail-open on any error.
 */
export async function rankRecordsWithAgent<T>(args: RankRecordsArgs<T>): Promise<RankRecordsResult<T>> {
  const started = Date.now();
  const { agent, query, items, toCandidate, projectId, vaultRoot } = args;
  if (!agent || !agent.isAvailable()) return { items, aiRank: 'skipped' };
  const q = (query || '').trim();
  if (!q) return { items, aiRank: 'skipped' };
  if (items.length < 2) return { items, aiRank: 'skipped' };

  const topK = args.rankTopK > 0 ? Math.floor(args.rankTopK) : 20;
  const head = items.slice(0, topK);
  const tail = items.slice(topK);
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : VAULT_AI_DEFAULT_TIMEOUT_MS;
  const candidates = head.map(toCandidate);
  const candidateIds = candidates.map((c) => String(c.id));

  try {
    const result = await withAiTimeout(
      Promise.resolve(
        agent.rankCandidates({ query: q, candidates })
      ),
      timeoutMs + 1000,
      'ai rank'
    );

    const orderedIds = Array.isArray(result?.orderedIds) ? result.orderedIds : [];
    if (orderedIds.length === 0) {
      if (result?.error) recordAiLastError(result.error);
      journalRankSettlement({
        vaultRoot,
        projectId,
        query: q,
        candidateIds,
        ok: false,
        durationMs: Date.now() - started,
        error: result?.error || 'ai rank returned no ordering',
        candidateCount: candidates.length
      });
      emitAiRankActivity(false, Date.now() - started, projectId);
      return { items, aiRank: 'skipped' };
    }
    const byId = new Map(head.map((h) => [toCandidate(h).id, h]));
    const seen = new Set<string>();
    const ranked: T[] = [];
    for (const id of orderedIds) {
      const item = byId.get(String(id));
      if (item !== undefined && !seen.has(String(id))) {
        seen.add(String(id));
        ranked.push(item);
      }
    }
    if (ranked.length === 0) {
      journalRankSettlement({
        vaultRoot,
        projectId,
        query: q,
        candidateIds,
        ok: false,
        durationMs: Date.now() - started,
        error: 'ai rank returned only unknown ids',
        candidateCount: candidates.length
      });
      emitAiRankActivity(false, Date.now() - started, projectId);
      return { items, aiRank: 'skipped' };
    }
    for (const h of head) {
      if (!seen.has(toCandidate(h).id)) ranked.push(h);
    }
    journalRankSettlement({
      vaultRoot,
      projectId,
      query: q,
      candidateIds,
      orderedIds: ranked.slice(0, topK).map((h) => String(toCandidate(h).id)),
      ok: true,
      durationMs: Date.now() - started,
      candidateCount: candidates.length
    });
    emitAiRankActivity(true, Date.now() - started, projectId);
    return { items: [...ranked, ...tail], aiRank: 'applied' };
  } catch (err) {
    recordAiLastError(err);
    if (vaultRoot) {
      reportAiFailure({
        vaultRoot,
        operation: 'rank',
        projectId,
        durationMs: Date.now() - started,
        error: err
      });
    }
    journalRankSettlement({
      vaultRoot,
      projectId,
      query: q,
      candidateIds,
      ok: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      candidateCount: candidates.length
    });
    emitAiRankActivity(false, Date.now() - started, projectId);
    return { items, aiRank: 'skipped' };
  }
}

export interface RankSearchHitsArgs {
  agent: VaultAiAgent | null | undefined;
  query: string | undefined;
  hits: SearchHit[];
  rankTopK: number;
  timeoutMs?: number;
  projectId?: string;
  /** Vault root for the durable AI ops journal (spec 0057). Omitted skips journaling. */
  vaultRoot?: string;
}

export interface RankSearchHitsResult {
  hits: SearchHit[];
  aiRank: AiRankDisposition;
}

/**
 * Post-FTS rerank (AC21–AC22). Candidates still come from FTS (plus the
 * existing embeddings filter); only then may `rankCandidates` reorder the
 * first `rankTopK` hits. Ids not returned by the agent keep their relative
 * lexical tail order after the ranked prefix. Any timeout or throw keeps
 * the lexical order (fail-open).
 */
export async function rankSearchHitsWithAgent(
  args: RankSearchHitsArgs
): Promise<RankSearchHitsResult> {
  const res = await rankRecordsWithAgent<SearchHit>({
    agent: args.agent,
    query: args.query,
    items: args.hits,
    toCandidate: (h) => ({
      id: String(h.id),
      kind: String(h.kind),
      title: String(h.title || h.id),
      snippet: String(h.snippet || '')
    }),
    rankTopK: args.rankTopK,
    timeoutMs: args.timeoutMs,
    projectId: args.projectId,
    vaultRoot: args.vaultRoot
  });
  return { hits: res.items, aiRank: res.aiRank };
}
