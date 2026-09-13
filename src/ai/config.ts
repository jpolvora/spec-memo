import { z } from 'zod';
import type { VaultAiConfig } from '../types.js';

export const VAULT_AI_DEFAULT_MODEL = 'composer-2.5';
export const VAULT_AI_DEFAULT_API_KEY_ENV = 'CURSOR_API_KEY';
export const VAULT_AI_DEFAULT_TIMEOUT_MS = 15000;
export const VAULT_AI_DEFAULT_RANK_TOP_K = 20;
export const VAULT_AI_DEFAULT_MAX_CONCURRENT = 1;
export const VAULT_AI_DEFAULT_OPS_LOG_MAX_BYTES = 8192;
export const VAULT_AI_DEFAULT_OPS_LOG_MAX_FILE_SIZE_MB = 10;

const nonEmptyStringWithDefault = (fallback: string): z.ZodType<string> =>
  z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length > 0 ? val.trim() : fallback),
    z.string().min(1)
  ) as z.ZodType<string>;

/**
 * Zod schema for the dedicated vault `config.json` `ai` section (AC27).
 * Unknown providers fail closed here: the parse rejects and MCP must not
 * start with a half-wired agent (AC4).
 */
export const VaultAiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['cursor-sdk']).default('cursor-sdk'),
  model: nonEmptyStringWithDefault(VAULT_AI_DEFAULT_MODEL).default(VAULT_AI_DEFAULT_MODEL),
  apiKeyEnv: nonEmptyStringWithDefault(VAULT_AI_DEFAULT_API_KEY_ENV).default(
    VAULT_AI_DEFAULT_API_KEY_ENV
  ),
  // Bounded: sub-second timeouts silently disable ranking, and unbounded
  // values overflow the timer while bootstrap blocks on rank.
  timeoutMs: z.number().int().min(1000).max(120000).default(VAULT_AI_DEFAULT_TIMEOUT_MS),
  rankTopK: z.number().int().min(1).max(50).default(VAULT_AI_DEFAULT_RANK_TOP_K),
  maxConcurrent: z.number().int().min(1).max(4).default(VAULT_AI_DEFAULT_MAX_CONCURRENT),
  // Durable AI ops journal (spec 0057). `opsLogEnabled` omitted follows
  // `enabled`; explicit false writes zero rows even when AI runs.
  opsLogEnabled: z.boolean().optional(),
  opsLogMaxBytes: z
    .number()
    .int()
    .min(1024)
    .max(65536)
    .default(VAULT_AI_DEFAULT_OPS_LOG_MAX_BYTES),
  opsLogMaxFileSizeMb: z
    .number()
    .min(1)
    .max(100)
    .default(VAULT_AI_DEFAULT_OPS_LOG_MAX_FILE_SIZE_MB)
});

export type ValidatedAiConfig = z.infer<typeof VaultAiConfigSchema> & VaultAiConfig;

export function defaultAiConfig(): VaultAiConfig {
  return {
    enabled: false,
    provider: 'cursor-sdk',
    model: VAULT_AI_DEFAULT_MODEL,
    apiKeyEnv: VAULT_AI_DEFAULT_API_KEY_ENV,
    timeoutMs: VAULT_AI_DEFAULT_TIMEOUT_MS,
    rankTopK: VAULT_AI_DEFAULT_RANK_TOP_K,
    maxConcurrent: VAULT_AI_DEFAULT_MAX_CONCURRENT,
    opsLogEnabled: undefined,
    opsLogMaxBytes: VAULT_AI_DEFAULT_OPS_LOG_MAX_BYTES,
    opsLogMaxFileSizeMb: VAULT_AI_DEFAULT_OPS_LOG_MAX_FILE_SIZE_MB
  };
}

/**
 * Parse the raw `ai` value from vault `config.json`.
 * Returns `null` when the section is absent (equals disabled, AC27).
 * Throws on schema-invalid values — including unknown providers (AC4).
 */
export function parseAiConfig(raw: unknown): VaultAiConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid config.json: ai must be an object');
  }
  const parsed = VaultAiConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid config.json: ai section is invalid (${details})`);
  }
  return parsed.data;
}

/**
 * Resolve the effective AI config for a vault config object.
 * Omitting `ai` equals disabled (AC27).
 */
export function resolveAiConfig(vaultConfig: { ai?: unknown }): VaultAiConfig {
  const parsed = parseAiConfig(vaultConfig.ai);
  return parsed || defaultAiConfig();
}
