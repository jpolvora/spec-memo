import { z } from 'zod';
import { redactSecretsInPayload, sanitizeToolOutput } from '../safety.js';
import type { VaultAiConfig } from '../types.js';
import { VAULT_AI_DEFAULT_TIMEOUT_MS } from './config.js';
import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult,
  VaultAiWikiPolishInput
} from './types.js';
import { inspectAgentIo } from '../io-guard.js';

const RefineOutputSchema = z.object({
  searchTerms: z.array(z.string().min(1).max(80)).max(20).optional(),
  summary: z.string().max(2000).optional()
});

const RankOutputSchema = z.object({
  orderedIds: z.array(z.string().min(1)).max(50)
});

/** Tags cloud agents created by spec-memo so stale slots can be reclaimed. */
export const SPEC_MEMO_CLOUD_AGENT_METADATA = {
  source: 'spec-memo',
  purpose: 'vault-ai-ephemeral'
} as const;

export interface CursorPromptOptions {
  apiKey: string;
  model: { id: string };
  cloud: { repos: []; metadata: Record<string, string> };
  timeoutMs: number;
}

export interface CursorRunResult {
  status: 'finished' | 'error' | 'cancelled';
  result?: string;
  error?: { message?: string; code?: string };
}

export interface CursorRunHandle {
  readonly id: string;
  readonly agentId: string;
  supports?(operation: 'cancel'): boolean;
  cancel(): Promise<void>;
  wait(): Promise<CursorRunResult>;
}

export interface CursorSdkAgentHandle {
  readonly agentId?: string;
  send(message: string): Promise<CursorRunHandle>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CursorSdkAgentApi {
  create(options: {
    apiKey: string;
    model: { id: string };
    cloud: { repos: []; metadata: Record<string, string> };
  }): CursorSdkAgentHandle | Promise<CursorSdkAgentHandle>;
  cancelRun(
    runId: string,
    options: { runtime: 'cloud'; agentId: string; apiKey: string }
  ): Promise<void>;
  archive(agentId: string, options: { apiKey: string }): Promise<void>;
  delete(agentId: string, options: { apiKey: string }): Promise<void>;
  list(options: {
    runtime: 'cloud';
    apiKey: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    items: Array<{
      agentId: string;
      status?: 'running' | 'finished' | 'error';
      metadata?: Record<string, string>;
    }>;
    nextCursor?: string;
  }>;
}

export interface CursorPromptFn {
  (message: string, options: CursorPromptOptions): Promise<{ result?: string } | string>;
}

/**
 * Build the exact options passed to the managed Cursor SDK prompt path (AC7–AC8).
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
  const timeoutMs =
    typeof config.timeoutMs === 'number' && config.timeoutMs > 0
      ? config.timeoutMs
      : VAULT_AI_DEFAULT_TIMEOUT_MS;
  return {
    apiKey,
    model: { id: modelId },
    cloud: { repos: [], metadata: { ...SPEC_MEMO_CLOUD_AGENT_METADATA } },
    timeoutMs
  };
}

function readCloudAgentErrorText(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? String((err as { message?: unknown }).message)
        : String(err);
  const code =
    err instanceof Error
      ? (err as Error & { code?: unknown }).code
      : (err as { code?: unknown })?.code;
  return `${String(code ?? '')} ${msg}`;
}

export function isCloudAgentLimitError(err: unknown): boolean {
  const text = readCloudAgentErrorText(err);
  if (/cloud agent|reached the limit|upgrade to ultra/i.test(text)) return true;
  return /validation_error/i.test(text) && /\blimit\b/i.test(text);
}

function attachCloudAgentError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) {
    (err as Error & { code?: string }).code = code;
  }
  return err;
}

async function archiveCloudAgent(
  Agent: CursorSdkAgentApi,
  agentId: string | undefined,
  apiKey: string
): Promise<void> {
  if (!agentId || !agentId.startsWith('bc-')) return;
  try {
    await Agent.archive(agentId, { apiKey });
    return;
  } catch {
    // Fall through to delete when archive is unavailable.
  }
  try {
    await Agent.delete(agentId, { apiKey });
  } catch {
    // Fail-open: cleanup must never break refine/rank.
  }
}

/**
 * Archive finished/error spec-memo cloud agents that still occupy dashboard slots.
 * Running agents are left alone — callers should cancel the active run first.
 */
export async function archiveStaleSpecMemoCloudAgents(
  Agent: CursorSdkAgentApi,
  apiKey: string,
  limit = 32
): Promise<number> {
  let archived = 0;
  let cursor: string | undefined;
  let pages = 0;
  try {
    while (pages < 4 && archived < limit) {
      const page = await Agent.list({
        runtime: 'cloud',
        apiKey,
        includeArchived: false,
        limit: 50,
        cursor
      });
      for (const item of page.items) {
        if (archived >= limit) break;
        if (item.metadata?.source !== SPEC_MEMO_CLOUD_AGENT_METADATA.source) continue;
        if (item.status === 'running') continue;
        try {
          await Agent.archive(item.agentId, { apiKey });
          archived += 1;
        } catch {
          try {
            await Agent.delete(item.agentId, { apiKey });
            archived += 1;
          } catch {
            // Skip agents we cannot reclaim.
          }
        }
      }
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) break;
    }
  } catch {
    // Listing is best-effort recovery only.
  }
  return archived;
}

async function cancelCloudRun(
  Agent: CursorSdkAgentApi,
  run: CursorRunHandle | undefined,
  apiKey: string
): Promise<void> {
  if (!run) return;
  try {
    if (run.supports?.('cancel')) {
      await run.cancel();
      return;
    }
  } catch {
    // Fall through to the static cancel API.
  }
  if (!run.id || !run.agentId) return;
  try {
    await Agent.cancelRun(run.id, { runtime: 'cloud', agentId: run.agentId, apiKey });
  } catch {
    // Fail-open.
  }
}

/**
 * Race a promise against a timeout and invoke `onTimeout` so cloud runs can
 * be cancelled instead of lingering as concurrent agents.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout: () => Promise<void>,
  displayTimeoutMs?: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const reportedMs = displayTimeoutMs ?? ms;
  try {
    return await Promise.race([
      promise.then(
        (value) => {
          settled = true;
          return value;
        },
        (err) => {
          settled = true;
          throw err;
        }
      ),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          void Promise.race([
            onTimeout().catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, 2000))
          ]).finally(() => {
            if (!settled) {
              reject(new Error(`${label} timed out after ${reportedMs}ms`));
            }
          });
        }, ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

async function loadCursorSdkAgentApi(): Promise<CursorSdkAgentApi> {
  const sdk = (await import('@cursor/sdk')) as unknown as { Agent: CursorSdkAgentApi };
  const agentApi = sdk.Agent;
  if (!agentApi || typeof agentApi.create !== 'function') {
    throw new Error('@cursor/sdk Agent.create is unavailable');
  }
  return agentApi;
}

async function resolveCreatedAgent(
  created: CursorSdkAgentHandle | Promise<CursorSdkAgentHandle>
): Promise<CursorSdkAgentHandle> {
  const agent = await created;
  if (!agent || typeof agent.send !== 'function') {
    throw new Error('@cursor/sdk Agent.create did not return a handle with send()');
  }
  return agent;
}

async function runManagedCloudPrompt(
  message: string,
  options: CursorPromptOptions,
  Agent: CursorSdkAgentApi
): Promise<{ result?: string }> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : VAULT_AI_DEFAULT_TIMEOUT_MS;
  const agent = await resolveCreatedAgent(
    Agent.create({
      apiKey: options.apiKey,
      model: options.model,
      cloud: options.cloud
    })
  );
  let run: CursorRunHandle | undefined;
  let cloudAgentId: string | undefined;

  const cleanup = async (): Promise<void> => {
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      // Fail-open.
    }
    await archiveCloudAgent(Agent, cloudAgentId, options.apiKey);
  };

  try {
    const elapsedAfterCreate = Date.now() - startedAt;
    if (elapsedAfterCreate >= timeoutMs) {
      throw new Error(`cursor sdk prompt timed out after ${timeoutMs}ms`);
    }
    run = await agent.send(message);
    cloudAgentId = run.agentId || agent.agentId;
    const elapsed = Date.now() - startedAt;
    // Account for elapsed time during Agent.create and agent.send so that
    // raceWithTimeout and its cancellation hook fire BEFORE any outer deadline
    // abandons the promise. Leave a 500ms margin.
    const remainingMs = Math.max(100, timeoutMs - elapsed - 500);
    const result = await raceWithTimeout(
      run.wait(),
      remainingMs,
      'cursor sdk prompt',
      () => cancelCloudRun(Agent, run, options.apiKey),
      timeoutMs
    );
    if (result.status === 'cancelled') {
      throw new Error('cursor sdk prompt was cancelled');
    }
    if (result.status === 'error') {
      throw attachCloudAgentError(
        result.error?.message || 'cursor sdk prompt failed',
        result.error?.code
      );
    }
    return { result: result.result };
  } finally {
    // Bound cleanup so dispose/archive cannot extend the timeout SLA indefinitely.
    await Promise.race([
      cleanup().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ]);
  }
}

export function createDefaultPromptFn(
  resolveAgent: () => Promise<CursorSdkAgentApi> = loadCursorSdkAgentApi
): CursorPromptFn {
  return async (message, options) => {
    const Agent = await resolveAgent();
    try {
      return await runManagedCloudPrompt(message, options, Agent);
    } catch (err) {
      if (!isCloudAgentLimitError(err)) throw err;
      const reclaimed = await archiveStaleSpecMemoCloudAgents(Agent, options.apiKey);
      if (reclaimed === 0) throw err;
      return await runManagedCloudPrompt(message, options, Agent);
    }
  };
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

const WIKI_POLISH_INSTRUCTION =
  'You polish a vault project wiki page. Reply with Markdown ONLY (no JSON, no fences wrapping the whole page). ' +
  'Preserve every required ## heading and Topic catalog link targets exactly. Improve Overview and topic prose; ' +
  'do not invent vault paths, secrets, or absolute filesystem paths. Keep relative ./ links intact.';

export interface CursorSdkAgentDeps {
  promptFn?: CursorPromptFn;
  /** Test-only override for the managed SDK agent API loader. */
  agentApi?: CursorSdkAgentApi;
}

/**
 * `VaultAiAgent` backed by TypeScript `@cursor/sdk` managed cloud prompts.
 * Uses `Agent.create` + `send` + `wait` with explicit cancel/archive cleanup
 * so timed-out or completed runs do not linger against cloud agent limits.
 */
export class CursorSdkVaultAiAgent implements VaultAiAgent {
  private readonly config: VaultAiConfig;
  private readonly promptFn: CursorPromptFn;

  constructor(config: VaultAiConfig, deps: CursorSdkAgentDeps = {}) {
    this.config = config;
    this.promptFn =
      deps.promptFn ||
      createDefaultPromptFn(deps.agentApi ? async () => deps.agentApi! : loadCursorSdkAgentApi);
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
        options.timeoutMs,
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
        options.timeoutMs,
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

  async polishWikiMarkdown(input: VaultAiWikiPolishInput): Promise<string> {
    const apiKey = this.readApiKey();
    if (!apiKey) throw new Error('missing api key');
    let prompt: string;
    try {
      const snapshotJson = redactPromptText(JSON.stringify(input.snapshot));
      const md = redactPromptText(input.markdown);
      const io = inspectAgentIo(`${snapshotJson}\n${md}`);
      if (!io.ok) {
        throw new Error('IO_GUARD refused wiki polish prompt');
      }
      prompt =
        `${WIKI_POLISH_INSTRUCTION}\n` +
        `SNAPSHOT_JSON:\n${snapshotJson}\n` +
        `DETERMINISTIC_WIKI:\n${md}`;
    } catch (err) {
      throw new Error(shortError(err));
    }
    const options = buildCursorSdkPromptOptions(this.config, apiKey);
    const raw = await withTimeout(
      Promise.resolve(this.promptFn(prompt, options)),
      options.timeoutMs,
      'cursor wiki polish'
    );
    const text = typeof raw === 'string' ? raw : String(raw?.result || '');
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('empty wiki polish output');
    }
    const outIo = inspectAgentIo(trimmed);
    if (!outIo.ok) {
      throw new Error('IO_GUARD refused wiki polish output');
    }
    return String(sanitizeToolOutput(trimmed));
  }
}
