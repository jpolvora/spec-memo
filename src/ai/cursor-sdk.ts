import { z } from 'zod';
import { redactSecretsInPayload, sanitizeToolOutput } from '../safety.js';
import type { VaultAiConfig } from '../types.js';
import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult
} from './types.js';

const RefineOutputSchema = z.object({
  searchTerms: z.array(z.string().min(1).max(80)).max(20).optional(),
  summary: z.string().max(2000).optional()
});

const RankOutputSchema = z.object({
  orderedIds: z.array(z.string().min(1)).max(50)
});

export interface CursorPromptOptions {
  apiKey: string;
  model: { id: string };
  cloud: { repos: [] };
}

export interface CursorPromptFn {
  (message: string, options: CursorPromptOptions): Promise<{ result?: string } | string>;
}

/**
 * Build the exact options passed to `@cursor/sdk` `Agent.prompt` (AC7–AC8).
 * Pure function so tests can assert the shape without live network:
 * - model comes from `config.ai.model` (default composer-2.5)
 * - cloud no-repo runtime (`cloud.repos: []`) — never a local `cwd`
 *   pointing at the product repo or vault root, so no filesystem tools
 *   can silently mutate the vault (AC8)
 * - the API key travels in `apiKey`, never in `config.json`
 */
export function buildCursorSdkPromptOptions(
  config: VaultAiConfig,
  apiKey: string
): CursorPromptOptions {
  const modelId = typeof config.model === 'string' && config.model.trim().length > 0
    ? config.model.trim()
    : 'composer-2.5';
  return {
    apiKey,
    model: { id: modelId },
    cloud: { repos: [] }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const clipped = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  return String(sanitizeToolOutput(clipped || 'cursor sdk call failed'));
}

/**
 * Extract the first JSON object from model text. The prompt demands
 * JSON-only output, but models may wrap it in fences or prose.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence/block scan
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new Error('model output was not valid JSON');
}

async function defaultPromptFn(
  message: string,
  options: CursorPromptOptions
): Promise<{ result?: string }> {
  // Imported lazily so the Noop path never requires `@cursor/sdk` (AC4, AC34).
  const sdk = (await import('@cursor/sdk')) as unknown as { Agent: { prompt: CursorPromptFn } };
  const agentApi = sdk.Agent;
  if (!agentApi || typeof agentApi.prompt !== 'function') {
    throw new Error('@cursor/sdk Agent.prompt is unavailable');
  }
  const raw = await agentApi.prompt(message, options);
  if (typeof raw === 'string') return { result: raw };
  return raw;
}

function redactPromptText(text: string): string {
  // AC31: existing secret redaction runs before the SDK call.
  // Any redaction failure throws here and the caller skips the call.
  const redacted = redactSecretsInPayload(text);
  if (typeof redacted !== 'string') {
    throw new Error('secret redaction rejected the prompt payload');
  }
  return redacted;
}

const REFINE_INSTRUCTION =
  'You assist a local developer-memory vault. Read the record below and reply with JSON ONLY, ' +
  'no markdown fences, no prose. Schema: {"searchTerms": string[<=20], "summary": string (<=500 chars)}. ' +
  'searchTerms: lowercase keyword phrases that improve full-text retrieval of this record. ' +
  'summary: one-paragraph retrieval aid, no secrets, no code dumps.';

const RANK_INSTRUCTION =
  'You rerank developer-memory search candidates. Reply with JSON ONLY, no markdown fences, no prose. ' +
  'Schema: {"orderedIds": string[]}. orderedIds must contain only ids from the candidate list, ' +
  'ordered most-relevant-first for the query. A subset is allowed; unknown ids are ignored.';

export interface CursorSdkAgentDeps {
  promptFn?: CursorPromptFn;
}

/**
 * `VaultAiAgent` backed by TypeScript `@cursor/sdk` `Agent.prompt` one-shot
 * (AC7). No `Agent.create` follow-up runs. Cloud no-repo runtime keeps the
 * agent away from the vault and product filesystems (AC8).
 */
export class CursorSdkVaultAiAgent implements VaultAiAgent {
  private readonly config: VaultAiConfig;
  private readonly promptFn: CursorPromptFn;

  constructor(config: VaultAiConfig, deps: CursorSdkAgentDeps = {}) {
    this.config = config;
    this.promptFn = deps.promptFn || defaultPromptFn;
  }

  private readApiKey(): string {
    const envName = this.config.apiKeyEnv;
    const key = process.env[envName];
    return typeof key === 'string' ? key.trim() : '';
  }

  isAvailable(): boolean {
    if (this.config.enabled !== true) return false;
    return this.readApiKey().length > 0;
  }

  async refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult> {
    const apiKey = this.readApiKey();
    if (!apiKey) return { ok: false, error: 'missing api key' };
    let prompt: string;
    try {
      // AC31: every free-text field is redacted, not just the body — a
      // credential pasted in a title or tag must never leave the vault.
      prompt =
        `${REFINE_INSTRUCTION}\n` +
        `RECORD id=${redactPromptText(input.id)} kind=${redactPromptText(input.kind)} title=${redactPromptText(input.title)}\n` +
        `tags: ${redactPromptText(input.tags.join(', '))}\n` +
        `pathPatterns: ${redactPromptText(input.pathPatterns.join(', '))}\n` +
        `BODY:\n${redactPromptText(input.body)}`;
    } catch (err) {
      return { ok: false, error: shortError(err) };
    }
    try {
      const options = buildCursorSdkPromptOptions(this.config, apiKey);
      const raw = await withTimeout(
        Promise.resolve(this.promptFn(prompt, options)),
        this.config.timeoutMs,
        'cursor refine'
      );
      const text = typeof raw === 'string' ? raw : String(raw?.result || '');
      const parsed = RefineOutputSchema.safeParse(extractJsonObject(text));
      if (!parsed.success) {
        return { ok: false, error: 'model output failed schema validation' };
      }
      const searchTerms = (parsed.data.searchTerms || [])
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20);
      const summary = typeof parsed.data.summary === 'string'
        ? parsed.data.summary.trim().slice(0, 500)
        : undefined;
      return { ok: true, searchTerms, summary };
    } catch (err) {
      return { ok: false, error: shortError(err) };
    }
  }

  async rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult> {
    const apiKey = this.readApiKey();
    if (!apiKey) return { orderedIds: input.candidates.map((c) => c.id), error: 'missing api key' };
    if (input.candidates.length === 0) return { orderedIds: [] };
    let prompt: string;
    try {
      const lines = input.candidates.map(
        (c) => `- id=${c.id} kind=${c.kind} title=${redactPromptText(c.title)}\n  snippet: ${redactPromptText(c.snippet)}`
      );
      prompt =
        `${RANK_INSTRUCTION}\nQUERY: ${redactPromptText(input.query)}\nCANDIDATES:\n${lines.join('\n')}`;
    } catch (err) {
      return { orderedIds: input.candidates.map((c) => c.id), error: shortError(err) };
    }
    try {
      const options = buildCursorSdkPromptOptions(this.config, apiKey);
      const raw = await withTimeout(
        Promise.resolve(this.promptFn(prompt, options)),
        this.config.timeoutMs,
        'cursor rank'
      );
      const text = typeof raw === 'string' ? raw : String(raw?.result || '');
      const parsed = RankOutputSchema.safeParse(extractJsonObject(text));
      if (!parsed.success) {
        return { orderedIds: input.candidates.map((c) => c.id), error: 'model output failed schema validation' };
      }
      const known = new Set(input.candidates.map((c) => c.id));
      const ordered = parsed.data.orderedIds.filter((id) => known.has(id));
      return { orderedIds: ordered };
    } catch (err) {
      return { orderedIds: input.candidates.map((c) => c.id), error: shortError(err) };
    }
  }
}
