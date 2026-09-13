import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult
} from './types.js';

/**
 * Default agent: identity / passthrough (AC2 slice).
 * `isAvailable()` is always false so upsert/search behave exactly as
 * the pre-AI lexical path. Unit tests never touch the network.
 */
export class NoopVaultAiAgent implements VaultAiAgent {
  isAvailable(): boolean {
    return false;
  }

  async refineForSearch(_input: VaultAiRefineInput): Promise<VaultAiRefineResult> {
    return { ok: false, error: 'ai disabled (noop agent)' };
  }

  async rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult> {
    return { orderedIds: input.candidates.map((c) => c.id), error: 'ai disabled (noop agent)' };
  }
}
