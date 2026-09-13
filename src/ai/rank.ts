import type { SearchHit, AiRankDisposition } from '../types.js';
import type { VaultAiAgent } from './types.js';
import { emitAiRankActivity, recordAiLastError, withAiTimeout } from './refine-queue.js';

export interface RankRecordsArgs<T> {
  agent: VaultAiAgent | null | undefined;
  query: string | undefined;
  items: T[];
  toCandidate: (item: T) => { id: string; kind: string; title: string; snippet: string };
  rankTopK: number;
  timeoutMs?: number;
  projectId?: string;
}

export interface RankRecordsResult<T> {
  items: T[];
  aiRank: AiRankDisposition;
}

/**
 * Generic post-lexical rerank: reorder at most the first `rankTopK` items
 * via the agent; unreturned ids keep their relative lexical tail order
 * after the ranked prefix. Fail-open on any error.
 */
export async function rankRecordsWithAgent<T>(args: RankRecordsArgs<T>): Promise<RankRecordsResult<T>> {
  const started = Date.now();
  const { agent, query, items, toCandidate, projectId } = args;
  if (!agent || !agent.isAvailable()) return { items, aiRank: 'skipped' };
  const q = (query || '').trim();
  if (!q) return { items, aiRank: 'skipped' };
  if (items.length < 2) return { items, aiRank: 'skipped' };

  const topK = args.rankTopK > 0 ? Math.floor(args.rankTopK) : 20;
  const head = items.slice(0, topK);
  const tail = items.slice(topK);
  const timeoutMs = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 15000;

  try {
    const result = await withAiTimeout(
      Promise.resolve(
        agent.rankCandidates({ query: q, candidates: head.map(toCandidate) })
      ),
      timeoutMs + 1000,
      'ai rank'
    );

    const orderedIds = Array.isArray(result?.orderedIds) ? result.orderedIds : [];
    if (orderedIds.length === 0) {
      if (result?.error) recordAiLastError(result.error);
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
      emitAiRankActivity(false, Date.now() - started, projectId);
      return { items, aiRank: 'skipped' };
    }
    for (const h of head) {
      if (!seen.has(toCandidate(h).id)) ranked.push(h);
    }
    emitAiRankActivity(true, Date.now() - started, projectId);
    return { items: [...ranked, ...tail], aiRank: 'applied' };
  } catch (err) {
    recordAiLastError(err);
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
    projectId: args.projectId
  });
  return { hits: res.items, aiRank: res.aiRank };
}
