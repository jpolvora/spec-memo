import { searchIndex } from '../indexer.js';
import type { AiRankDisposition, SearchHit, SearchOptions } from '../types.js';
import { rankSearchHitsWithAgent } from './rank.js';
import type { VaultAiAgent } from './types.js';

export interface RankedSearchAi {
  agent?: VaultAiAgent | null;
  rankTopK?: number;
  timeoutMs?: number;
  projectId?: string;
  /** Vault root for the durable AI ops journal (spec 0057). Defaults to options.vaultRoot. */
  vaultRoot?: string;
}

export interface RankedSearchResult {
  hits: SearchHit[];
  aiRank: AiRankDisposition;
}

/**
 * Lexical search first, optional post-FTS AI rerank second (AC20–AC22).
 * With AI disabled the hit id order matches the pre-AI FTS path
 * byte-for-byte. Non-relevance sorts never rerank (their ordering is the
 * contract, e.g. `memo rank` semantics).
 */
export async function searchIndexRanked(
  options: SearchOptions,
  ai: RankedSearchAi = {}
): Promise<RankedSearchResult> {
  const hits = searchIndex(options);
  const sort = options.sort || 'relevance';
  let aiRank: AiRankDisposition = 'skipped';
  let ranked = hits;

  if (sort === 'relevance' && ai.agent && ai.agent.isAvailable()) {
    const res = await rankSearchHitsWithAgent({
      agent: ai.agent,
      query: options.query,
      hits,
      rankTopK: ai.rankTopK && ai.rankTopK > 0 ? ai.rankTopK : 20,
      timeoutMs: ai.timeoutMs,
      projectId: ai.projectId || options.projectId,
      vaultRoot: ai.vaultRoot || options.vaultRoot
    });
    ranked = res.hits;
    aiRank = res.aiRank;
  }

  if (options.explain) {
    for (const hit of ranked) {
      if (hit.explain) {
        hit.explain.aiRank = aiRank;
      }
    }
  }
  return { hits: ranked, aiRank };
}
