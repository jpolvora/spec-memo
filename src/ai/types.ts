import type { RecordKind, VaultAiConfig, VaultAiStatus } from '../types.js';

export type { VaultAiConfig, VaultAiStatus };

/**
 * Input payload for background search-aid refinement (AC2).
 * Plain data only — never carries vault paths, cwd, or secrets.
 */
export interface VaultAiRefineInput {
  id: string;
  kind: RecordKind;
  title: string;
  body: string;
  tags: string[];
  pathPatterns: string[];
}

/**
 * Result of a refine call (AC2). `ok: false` always fail-opens:
 * no sidecar is written and the original markdown stays intact.
 */
export interface VaultAiRefineResult {
  ok: boolean;
  searchTerms?: string[];
  summary?: string;
  error?: string;
}

/**
 * Candidate row handed to the ranker (AC3).
 */
export interface VaultAiRankCandidate {
  id: string;
  kind: string;
  title: string;
  snippet: string;
}

/**
 * Input payload for post-FTS rerank (AC3).
 * `candidates.length` is always bounded by `config.ai.rankTopK`.
 */
export interface VaultAiRankInput {
  query: string;
  candidates: VaultAiRankCandidate[];
}

/**
 * Ordered list of candidate ids (subset allowed) plus optional error (AC3).
 * Ids unknown to the candidate set are ignored by the caller.
 */
export interface VaultAiRankResult {
  orderedIds: string[];
  error?: string;
}

/**
 * Bounded wiki polish snapshot (spec 0062). Titles/ids/counts only — no
 * record bodies. Shared with `src/wiki.ts` so the agent and regenerate path
 * agree on the payload shape.
 */
export interface VaultAiWikiSnapshot {
  projectId: string;
  inventory: {
    traps: number;
    trapsActive: number;
    decisions: number;
    specs: number;
    plans: number;
    sessions: number;
    prompts: number;
  };
  records: Array<{ id: string; kind: string; title: string }>;
}

/**
 * Input for optional wiki polish (spec 0062). Deterministic markdown plus
 * a fresh snapshot from the same regenerate call.
 */
export interface VaultAiWikiPolishInput {
  markdown: string;
  snapshot: VaultAiWikiSnapshot;
}

/**
 * Common contract for the optional vault intelligence layer (AC1).
 * Implementations must not use unchecked `any` for these payloads.
 * `polishWikiMarkdown` is optional so Noop and older wrappers stay valid.
 */
export interface VaultAiAgent {
  isAvailable(): boolean;
  refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult>;
  rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult>;
  /** Spec 0062: polish vault WIKI.md from snapshot; fail-open at the caller. */
  polishWikiMarkdown?(input: VaultAiWikiPolishInput): Promise<string>;
}

export type VaultAiProvider = 'cursor-sdk';
