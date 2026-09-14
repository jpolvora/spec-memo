import { readVaultConfig } from '../vault.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VaultAiConfig, VaultAiStatus } from '../types.js';
import { defaultAiConfig, parseAiConfig, resolveAiConfig } from './config.js';
import { NoopVaultAiAgent } from './noop.js';
import { CursorSdkVaultAiAgent } from './cursor-sdk.js';
import { withAiOpsJournal } from './ops-log.js';
import { getAiLastError, getAiQueueDepth } from './refine-queue.js';
import type { VaultAiAgent } from './types.js';

export * from './types.js';
export * from './config.js';
export { NoopVaultAiAgent } from './noop.js';
export { CursorSdkVaultAiAgent, buildCursorSdkPromptOptions } from './cursor-sdk.js';
export {
  enqueueRefineJob,
  dropPendingRefineForRecord,
  getAiQueueDepth,
  getAiLastError,
  recordAiLastError,
  clearAiStateForTests,
  setAiActivityBus,
  getAiActivityBus,
  emitAiRankActivity,
  withAiTimeout,
  isAiRefineEligibleKind,
  hashRecordBody,
  AI_REFINE_ELIGIBLE_KINDS
} from './refine-queue.js';
export { rankRecordsWithAgent, rankSearchHitsWithAgent } from './rank.js';
export type { RankRecordsArgs, RankRecordsResult } from './rank.js';
export { searchIndexRanked } from './search.js';
export type { RankedSearchAi, RankedSearchResult } from './search.js';
export {
  recordAiOpsEvent,
  listAiOpsEntries,
  getAiOpsEntry,
  sanitizeAiOpsEntry,
  parseAiOpsListQuery,
  isAiOpsLogEnabled,
  resolveAiOpsLogLimits,
  readAiOpsConfig,
  resetAiOpsConfigCacheForTests,
  truncateOpsPayloadToBudget,
  getAiOpsDir,
  withAiOpsJournal,
  AiOpsJournaledAgent,
  AiOpsListQuerySchema,
  AI_OPS_ERROR_SNIPPET_MAX
} from './ops-log.js';
export type {
  AiOpsEntry,
  AiOpsListItem,
  AiOpsListQuery,
  AiOpsListResult,
  AiOpsOperation,
  RecordAiOpsArgs,
  JournaledAgentOptions
} from './ops-log.js';

/**
 * Process-startup agent construction from `readVaultConfig` (AC4):
 * - missing `ai`, `ai.enabled` omitted, or `ai.enabled === false`
 *   yields `NoopVaultAiAgent` (no SDK import on that path)
 * - `ai.enabled === true` with `provider === "cursor-sdk"` yields
 *   `CursorSdkVaultAiAgent`
 * - unknown provider throws at config parse (Zod): callers at process
 *   startup must fail closed instead of running a half-wired agent
 */
export function resolveVaultAiAgent(
  vaultRoot: string,
  aiConfig?: VaultAiConfig
): { agent: VaultAiAgent; config: VaultAiConfig } {
  let config: VaultAiConfig;
  if (aiConfig) {
    config = aiConfig;
  } else {
    const { config: vaultConfig } = readVaultConfig(vaultRoot);
    config = resolveAiConfig(vaultConfig);
  }
  if (config.enabled !== true) {
    return { agent: withAiOpsJournal(new NoopVaultAiAgent(), { vaultRoot, config }), config };
  }
  if (config.provider === 'cursor-sdk') {
    return {
      agent: withAiOpsJournal(new CursorSdkVaultAiAgent(config), { vaultRoot, config }),
      config
    };
  }
  throw new Error(
    `Invalid config.json: unknown ai.provider '${String((config as { provider?: unknown }).provider)}'`
  );
}

/**
 * Validate the `ai` section at process startup (MCP stdio, SSE, CLI serve).
 * Throws on unknown providers so the daemon never starts half-wired (AC4).
 *
 * Reads the raw `config.json` file: the merged vault config already falls
 * back to defaults on parse errors (fail-open reads), so validating the
 * merged object could never observe an unknown provider.
 */
export function assertAiConfigValid(vaultRoot: string): VaultAiConfig {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(vaultRoot, 'config.json'), 'utf8')
    ) as { ai?: unknown };
    const strict = parseAiConfig(raw?.ai);
    if (strict) return strict;
  } catch (err) {
    if (err instanceof Error && err.message.includes('config.json: ai')) {
      throw err;
    }
    // Missing/unreadable file equals disabled; fall through to merged config.
  }
  const { config: vaultConfig } = readVaultConfig(vaultRoot);
  return resolveAiConfig(vaultConfig);
}

/**
 * Read-only AI status snapshot for doctor `--json` and `/api/status`
 * (AC28–AC29). Never throws, never leaks secrets.
 */
export function getVaultAiStatus(vaultRoot: string): VaultAiStatus {
  let config: VaultAiConfig;
  try {
    config = assertAiConfigValid(vaultRoot);
  } catch {
    config = defaultAiConfig();
  }
  let available = false;
  try {
    available = resolveVaultAiAgent(vaultRoot, config).agent.isAvailable();
  } catch {
    available = false;
  }
  return {
    enabled: config.enabled === true,
    provider: config.provider,
    available,
    queueDepth: getAiQueueDepth(),
    lastError: getAiLastError()
  };
}
