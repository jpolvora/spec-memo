import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { getVaultRoot, withVaultLockSync } from '../vault.js';
import { redactSecretsInPayload, sanitizeToolOutput } from '../safety.js';
import { sanitizeLogContext, logErrorReport } from '../error-logger.js';
import type { VaultAiConfig } from '../types.js';
import {
  VAULT_AI_DEFAULT_OPS_LOG_MAX_BYTES,
  VAULT_AI_DEFAULT_OPS_LOG_MAX_FILE_SIZE_MB,
  resolveAiConfig
} from './config.js';
import type {
  VaultAiAgent,
  VaultAiRankInput,
  VaultAiRankResult,
  VaultAiRefineInput,
  VaultAiRefineResult,
  VaultAiWikiPolishInput
} from './types.js';
import { NoopVaultAiAgent } from './noop.js';

export const AI_OPS_DIR_NAME = 'ai-ops';
export const AI_OPS_FILE_PREFIX = 'ai-ops-';
export const AI_OPS_ERROR_SNIPPET_MAX = 200;

export type AiOpsOperation = 'refine' | 'rank' | 'wiki' | 'test';

export interface AiOpsEntry {
  id: string;
  timestamp: string;
  operation: AiOpsOperation;
  ok: boolean;
  durationMs: number;
  recordId?: string;
  projectId?: string;
  provider?: string;
  model?: string;
  error?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AiOpsListItem {
  id: string;
  timestamp: string;
  operation: AiOpsOperation;
  ok: boolean;
  durationMs: number;
  recordId?: string;
  projectId?: string;
  error?: string;
}

export interface AiOpsListQuery {
  limit?: number;
  offset?: number;
  operation?: AiOpsOperation;
  ok?: boolean;
  projectId?: string;
}

export interface AiOpsListResult {
  items: AiOpsListItem[];
  total: number;
}

export const AiOpsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  operation: z.enum(['refine', 'rank', 'wiki', 'test']).optional(),
  ok: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  projectId: z.string().min(1).max(256).optional()
});

export function getAiOpsDir(vaultRoot?: string): string {
  return path.join(getVaultRoot(vaultRoot), AI_OPS_DIR_NAME);
}

function utcDatePrefix(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Effective journal switch (AC4): explicit `opsLogEnabled` wins; when
 * omitted, journaling follows `ai.enabled`. Noop/disabled AI writes zero rows.
 */
export function isAiOpsLogEnabled(config: VaultAiConfig): boolean {
  if (config.opsLogEnabled !== undefined) return config.opsLogEnabled === true;
  return config.enabled === true;
}

export function resolveAiOpsLogLimits(config: VaultAiConfig): {
  maxBytes: number;
  maxFileSizeBytes: number;
} {
  const maxBytes =
    typeof config.opsLogMaxBytes === 'number' && Number.isFinite(config.opsLogMaxBytes)
      ? Math.floor(config.opsLogMaxBytes)
      : VAULT_AI_DEFAULT_OPS_LOG_MAX_BYTES;
  const maxMb =
    typeof config.opsLogMaxFileSizeMb === 'number' && Number.isFinite(config.opsLogMaxFileSizeMb)
      ? config.opsLogMaxFileSizeMb
      : VAULT_AI_DEFAULT_OPS_LOG_MAX_FILE_SIZE_MB;
  return {
    maxBytes: Math.min(65536, Math.max(1024, maxBytes)),
    maxFileSizeBytes: Math.min(100, Math.max(1, maxMb)) * 1024 * 1024
  };
}

const opsLogConfigCache = new Map<string, { mtime: number; config: VaultAiConfig }>();

function configMtime(root: string): number {
  try {
    return fs.statSync(path.join(root, 'config.json')).mtimeMs;
  } catch {
    return 0;
  }
}

/** Cached vault AI config read for the journal hot path (fail-open to defaults). */
export function readAiOpsConfig(vaultRoot?: string): VaultAiConfig {
  const root = getVaultRoot(vaultRoot);
  try {
    const mtime = configMtime(root);
    const cached = opsLogConfigCache.get(root);
    if (cached && cached.mtime === mtime) return cached.config;
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as {
      ai?: unknown;
    };
    const { resolveAiConfig: resolve } = { resolveAiConfig };
    const config = resolve({ ai: raw?.ai });
    opsLogConfigCache.set(root, { mtime, config });
    return config;
  } catch {
    const cached = opsLogConfigCache.get(root);
    if (cached) return cached.config;
    const { resolveAiConfig: resolve } = { resolveAiConfig };
    return resolve({});
  }
}

export function resetAiOpsConfigCacheForTests(vaultRoot?: string): void {
  if (vaultRoot !== undefined) {
    opsLogConfigCache.delete(getVaultRoot(vaultRoot));
    return;
  }
  opsLogConfigCache.clear();
}

/** Scrub live secret values (env API keys) that regex redaction cannot know. */
function secretValues(config: VaultAiConfig): string[] {
  const secrets: string[] = [];
  const envNames = new Set<string>(['CURSOR_API_KEY']);
  if (config.apiKeyEnv) envNames.add(config.apiKeyEnv);
  for (const name of envNames) {
    const v = process.env[name];
    if (typeof v === 'string' && v.length >= 8) secrets.push(v);
  }
  return secrets;
}

function stripKnownSecretValues(value: unknown, config: VaultAiConfig): unknown {
  const secrets = secretValues(config);
  if (secrets.length === 0) return value;
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const s of secrets) {
        if (out.includes(s)) out = out.split(s).join('[REDACTED]');
      }
      return out;
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (isRecordObject(input)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) out[k] = scrub(v);
      return out;
    }
    return input;
  };
  return scrub(value);
}

/**
 * Redact a scalar journal string (error/recordId/…) the same way payloads
 * are redacted: regex signatures first, then live env secret values (AC11).
 */
function redactOpsString(value: string | undefined, config: VaultAiConfig): string | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSecretsInPayload(value);
  const text = typeof redacted === 'string' ? redacted : String(redacted);
  const stripped = stripKnownSecretValues(text, config);
  return typeof stripped === 'string' ? stripped : text;
}

function redactOpsPayload(value: unknown, config: VaultAiConfig): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const redacted = redactSecretsInPayload(value);
  const contextual = sanitizeLogContext(isRecordObject(redacted) ? redacted : { value: redacted });
  const stripped = stripKnownSecretValues(contextual, config);
  if (isRecordObject(stripped)) return stripped;
  return { value: stripped };
}

function utf8Bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}

interface StringRef {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  value: string;
}

function collectStringRefs(
  root: Record<string, unknown> | undefined,
  out: StringRef[]
): void {
  if (!root) return;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string') out.push({ parent: node, key: i, value: v });
        else if (v && typeof v === 'object') visit(v);
      }
      return;
    }
    if (isRecordObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') out.push({ parent: node, key: k, value: v });
        else if (v && typeof v === 'object') visit(v);
      }
    }
  };
  visit(root);
}

const TRUNC_MARKER = '…[truncated]';

function setStringRef(target: StringRef, next: string): void {
  if (Array.isArray(target.parent)) {
    (target.parent as unknown[])[target.key as number] = next;
  } else {
    (target.parent as Record<string, unknown>)[target.key as string] = next;
  }
}

/**
 * Enforce the per-row input+output byte cap (AC3). Every pass truncates all
 * over-long string fields (longest first); overflow always sets
 * `metadata.truncated: true`. A hard fallback drops the larger side (then
 * both) to a marker, so the cap holds even for pathological many-field or
 * non-string payloads where per-field truncation cannot converge.
 */
export function truncateOpsPayloadToBudget(
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  maxBytes: number
): { input?: Record<string, unknown>; output?: Record<string, unknown>; metadata?: Record<string, unknown> } {
  const meta: Record<string, unknown> = { ...(metadata || {}) };
  let current = utf8Bytes(input ?? null) + utf8Bytes(output ?? null);
  if (current <= maxBytes) return { input, output, metadata: meta };
  meta['truncated'] = true;
  for (let round = 0; round < 200 && current > maxBytes; round++) {
    const refs: StringRef[] = [];
    collectStringRefs(input, refs);
    collectStringRefs(output, refs);
    if (refs.length === 0) break;
    refs.sort((a, b) => b.value.length - a.value.length);
    let progressed = false;
    for (const target of refs) {
      if (current <= maxBytes) break;
      // Tiny fields stay: appending the marker would grow them.
      if (target.value.length <= 32) continue;
      const budget = Math.max(0, maxBytes - (current - Buffer.byteLength(target.value, 'utf8')));
      // `keep` is always below the current length, so every pass shrinks.
      const keep = Math.min(target.value.length - 1, Math.max(32, Math.floor(budget / 2)));
      setStringRef(target, `${target.value.slice(0, keep)}${TRUNC_MARKER}`);
      progressed = true;
      current = utf8Bytes(input ?? null) + utf8Bytes(output ?? null);
    }
    if (!progressed) break;
  }
  // Hard guarantee: drop the larger side to a marker, then both if needed.
  if (current > maxBytes) {
    if (utf8Bytes(output ?? null) >= utf8Bytes(input ?? null)) {
      output = { truncated: true };
    } else {
      input = { truncated: true };
    }
    current = utf8Bytes(input ?? null) + utf8Bytes(output ?? null);
  }
  if (current > maxBytes) {
    input = { truncated: true };
    output = { truncated: true };
  }
  return { input, output, metadata: meta };
}

function resolvePartFile(
  dir: string,
  datePrefix: string,
  incomingBytes: number,
  maxFileSizeBytes: number
): string {
  const prefix = `${AI_OPS_FILE_PREFIX}${datePrefix}.part-`;
  const suffix = '.jsonl';
  let highest = 0;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(prefix) && file.endsWith(suffix)) {
        const n = parseInt(file.slice(prefix.length, file.length - suffix.length), 10);
        if (Number.isFinite(n) && n > highest) highest = n;
      }
    }
  } catch {
    highest = 0;
  }
  if (highest < 1) highest = 1;
  else {
    try {
      const candidate = path.join(dir, `${prefix}${highest}${suffix}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).size + incomingBytes > maxFileSizeBytes) {
        highest += 1;
      }
    } catch {
      // fall through with current part
    }
  }
  return path.join(dir, `${prefix}${highest}${suffix}`);
}

export interface RecordAiOpsArgs {
  vaultRoot?: string;
  config?: VaultAiConfig;
  operation: AiOpsOperation;
  ok: boolean;
  durationMs: number;
  recordId?: string;
  projectId?: string;
  provider?: string;
  model?: string;
  error?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Append one journal row (AC5: fail-open, never throws, no floating promises).
 * Sync write under the vault lock = single-writer queue semantics without
 * unhandled async. Failures are reported to `error.logs` subsystem `ai`.
 */
export function recordAiOpsEvent(args: RecordAiOpsArgs): string | null {
  let vaultRoot: string;
  try {
    vaultRoot = getVaultRoot(args.vaultRoot);
  } catch {
    return null;
  }
  let config: VaultAiConfig;
  try {
    config = args.config || readAiOpsConfig(vaultRoot);
  } catch {
    return null;
  }
  try {
    if (!isAiOpsLogEnabled(config)) return null;
    const { maxBytes, maxFileSizeBytes } = resolveAiOpsLogLimits(config);
    const redactedInput = redactOpsPayload(args.input, config);
    const redactedOutput = redactOpsPayload(args.output, config);
    const redactedMeta = redactOpsPayload(args.metadata, config);
    const capped = truncateOpsPayloadToBudget(
      redactedInput,
      redactedOutput,
      isRecordObject(redactedMeta) ? redactedMeta : undefined,
      maxBytes
    );
    const entry: AiOpsEntry = {
      id: `aiops-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      operation: args.operation,
      ok: args.ok === true,
      durationMs: Math.max(0, Math.round((args.durationMs || 0) * 10) / 10),
      ...(args.recordId ? { recordId: redactOpsString(String(args.recordId), config) } : {}),
      ...(args.projectId ? { projectId: redactOpsString(String(args.projectId), config) } : {}),
      ...(args.provider || config.provider
        ? { provider: redactOpsString(String(args.provider || config.provider), config) }
        : {}),
      ...(args.model || config.model
        ? { model: redactOpsString(String(args.model || config.model), config) }
        : {}),
      ...(args.error ? { error: redactOpsString(String(args.error), config)?.slice(0, 500) } : {}),
      ...(capped.input ? { input: capped.input } : {}),
      ...(capped.output ? { output: capped.output } : {}),
      ...(capped.metadata && Object.keys(capped.metadata).length > 0 ? { metadata: capped.metadata } : {})
    };
    const line = `${JSON.stringify(entry)}\n`;
    const incoming = Buffer.byteLength(line, 'utf8');
    withVaultLockSync(vaultRoot, () => {
      const dir = getAiOpsDir(vaultRoot);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = resolvePartFile(dir, utcDatePrefix(), incoming, maxFileSizeBytes);
      fs.appendFileSync(filePath, line, 'utf8');
    });
    return entry.id;
  } catch (err: unknown) {
    try {
      logErrorReport(
        {
          subsystem: 'ai',
          error: err instanceof Error ? err : new Error(String(err)),
          context: {
            operation: args.operation,
            recordId: args.recordId,
            durationMs: args.durationMs
          }
        },
        { vaultRoot }
      );
    } catch {
      // error logging itself is fail-safe; never propagate.
    }
    return null;
  }
}

function toListItem(entry: AiOpsEntry): AiOpsListItem {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    operation: entry.operation,
    ok: entry.ok,
    durationMs: entry.durationMs,
    ...(entry.recordId ? { recordId: entry.recordId } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
    ...(entry.error ? { error: String(entry.error).slice(0, AI_OPS_ERROR_SNIPPET_MAX) } : {})
  };
}

/** Part files newest-first (filenames sort chronologically, so reverse = newest). */
function listAiOpsFilesNewestFirst(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(AI_OPS_FILE_PREFIX) && f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function parseAiOpsLine(line: string): AiOpsEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as AiOpsEntry;
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.timestamp === 'string' &&
      (parsed.operation === 'refine' ||
        parsed.operation === 'rank' ||
        parsed.operation === 'wiki' ||
        parsed.operation === 'test') &&
      typeof parsed.ok === 'boolean' &&
      typeof parsed.durationMs === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    // ignore corrupted lines
    return null;
  }
}

function aiOpsMatchesQuery(entry: AiOpsEntry, query: AiOpsListQuery): boolean {
  if (query.operation && entry.operation !== query.operation) return false;
  if (query.ok !== undefined && entry.ok !== query.ok) return false;
  if (query.projectId && entry.projectId !== query.projectId) return false;
  return true;
}

/**
 * List journal rows newest-first with filters + pagination (REST backing).
 * Exact filtered `total` requires scanning all parts (same tradeoff as the
 * telemetry readers), but only the requested page window is materialized,
 * so memory stays O(page) instead of O(history) as the journal grows.
 */
export function listAiOpsEntries(vaultRoot: string | undefined, query: AiOpsListQuery): AiOpsListResult {
  const dir = getAiOpsDir(getVaultRoot(vaultRoot));
  if (!fs.existsSync(dir)) return { items: [], total: 0 };
  const offset = query.offset && query.offset > 0 ? Math.floor(query.offset) : 0;
  const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : 50;
  let total = 0;
  const window: AiOpsEntry[] = [];
  for (const file of listAiOpsFilesNewestFirst(dir)) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseAiOpsLine(lines[i] ?? '');
      if (!entry || !aiOpsMatchesQuery(entry, query)) continue;
      const idx = total++;
      if (idx >= offset && window.length < limit) window.push(entry);
    }
  }
  // Stable newest-first order inside the page (timestamp ties across parts).
  window.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return { items: window.map(toListItem), total };
}

/**
 * Fetch one journal row by id (sanitized at the REST layer). Scans
 * newest-first and returns on the first id hit instead of loading history.
 */
export function getAiOpsEntry(vaultRoot: string | undefined, id: string): AiOpsEntry | null {
  const dir = getAiOpsDir(getVaultRoot(vaultRoot));
  if (!fs.existsSync(dir)) return null;
  for (const file of listAiOpsFilesNewestFirst(dir)) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseAiOpsLine(lines[i] ?? '');
      if (entry && entry.id === id) return entry;
    }
  }
  return null;
}

export function sanitizeAiOpsEntry(entry: AiOpsEntry): AiOpsEntry {
  return sanitizeToolOutput(entry) as AiOpsEntry;
}

/** Parse + validate the list query; throws a 400-flavoured Error on invalid input. */
export function parseAiOpsListQuery(raw: Record<string, string | string[] | null>): AiOpsListQuery {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      if (v.length > 0 && v[0] != null) flat[k] = String(v[0]);
    } else if (v != null) {
      flat[k] = String(v);
    }
  }
  const parsed = AiOpsListQuerySchema.safeParse(flat);
  if (!parsed.success) {
    const details = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    const err = new Error(`Invalid ai-ops query (${details})`);
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }
  return parsed.data;
}

export interface JournaledAgentOptions {
  vaultRoot?: string;
  config?: VaultAiConfig;
  projectId?: string;
}

/**
 * Agent-boundary decorator (AC7–AC10): one journal row per refine/rank
 * settlement (success and failure), redacted + byte-capped. The Noop agent
 * writes zero rows (AC9); activity events stay body-free (AC10).
 */
export class AiOpsJournaledAgent implements VaultAiAgent {
  private readonly inner: VaultAiAgent;
  private readonly options: JournaledAgentOptions;

  constructor(inner: VaultAiAgent, options: JournaledAgentOptions = {}) {
    this.inner = inner;
    this.options = options;
  }

  isAvailable(): boolean {
    try {
      return this.inner.isAvailable();
    } catch {
      return false;
    }
  }

  private resolveConfig(): VaultAiConfig | null {
    try {
      if (this.options.config) return this.options.config;
      const root = getVaultRoot(this.options.vaultRoot);
      return readAiOpsConfig(root);
    } catch {
      return null;
    }
  }

  async refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult> {
    if (this.inner instanceof NoopVaultAiAgent) {
      return this.inner.refineForSearch(input);
    }
    const started = Date.now();
    const config = this.resolveConfig();
    try {
      const result = await this.inner.refineForSearch(input);
      if (config && isAiOpsLogEnabled(config)) {
        recordAiOpsEvent({
          vaultRoot: this.options.vaultRoot,
          config,
          operation: 'refine',
          ok: result?.ok === true,
          durationMs: Date.now() - started,
          recordId: input.id,
          projectId: this.options.projectId,
          input: {
            recordId: input.id,
            kind: input.kind,
            title: input.title,
            tags: input.tags,
            pathPatterns: input.pathPatterns,
            bodyExcerpt: typeof input.body === 'string' ? input.body.slice(0, 2000) : ''
          },
          output: result?.ok === true
            ? { searchTerms: result.searchTerms, summary: result.summary }
            : undefined,
          error: result?.ok === true ? undefined : result?.error,
          metadata: { agent: 'vault-ai' }
        });
      }
      return result;
    } catch (err: unknown) {
      if (config && isAiOpsLogEnabled(config)) {
        recordAiOpsEvent({
          vaultRoot: this.options.vaultRoot,
          config,
          operation: 'refine',
          ok: false,
          durationMs: Date.now() - started,
          recordId: input.id,
          projectId: this.options.projectId,
          input: { recordId: input.id, kind: input.kind, title: input.title },
          error: err instanceof Error ? err.message : String(err),
          metadata: { agent: 'vault-ai', threw: true }
        });
      }
      throw err;
    }
  }

  async rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult> {
    if (this.inner instanceof NoopVaultAiAgent) {
      return this.inner.rankCandidates(input);
    }
    const started = Date.now();
    const config = this.resolveConfig();
    try {
      const result = await this.inner.rankCandidates(input);
      if (config && isAiOpsLogEnabled(config)) {
        recordAiOpsEvent({
          vaultRoot: this.options.vaultRoot,
          config,
          operation: 'rank',
          ok: !result?.error,
          durationMs: Date.now() - started,
          projectId: this.options.projectId,
          input: {
            query: input.query,
            candidateIds: input.candidates.map((c) => c.id)
          },
          output: { orderedIds: result?.orderedIds },
          error: result?.error,
          metadata: { agent: 'vault-ai', candidateCount: input.candidates.length }
        });
      }
      return result;
    } catch (err: unknown) {
      if (config && isAiOpsLogEnabled(config)) {
        recordAiOpsEvent({
          vaultRoot: this.options.vaultRoot,
          config,
          operation: 'rank',
          ok: false,
          durationMs: Date.now() - started,
          projectId: this.options.projectId,
          input: {
            query: input.query,
            candidateIds: input.candidates.map((c) => c.id)
          },
          error: err instanceof Error ? err.message : String(err),
          metadata: { agent: 'vault-ai', threw: true }
        });
      }
      throw err;
    }
  }

  async polishWikiMarkdown(input: VaultAiWikiPolishInput): Promise<string> {
    const innerPolish = this.inner.polishWikiMarkdown?.bind(this.inner);
    if (!innerPolish) {
      throw new Error('wiki polish unavailable');
    }
    // Single-observe: regenerateWiki owns the one operation=wiki journal row
    // via emitWikiOps; journaling here would write a second row per regenerate.
    return innerPolish(input);
  }
}

/** Wrap any agent with journal capture; Noop passes through untouched. */
export function withAiOpsJournal(
  agent: VaultAiAgent,
  options: JournaledAgentOptions = {}
): VaultAiAgent {
  if (!agent || agent instanceof NoopVaultAiAgent) return agent;
  return new AiOpsJournaledAgent(agent, options);
}
