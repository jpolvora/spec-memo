import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { getVaultRoot } from './vault.js';
import { redactSecretsInPayload } from './safety.js';
import { redactVaultGitError } from './vault-git-redact.js';

export type ErrorLogLevel = 'ERROR' | 'FATAL' | 'WARN';

export type ErrorLogSubsystem =
  | 'sse-server'
  | 'status-server'
  | 'mcp-server'
  | 'mcp-tool'
  | 'remote-proxy'
  | 'hybrid-sync'
  | 'sync-reconcile'
  | 'vault-git'
  | 'vault'
  | 'io-guard'
  | 'canvas'
  | 'cli'
  | 'ai'
  | 'system';

export interface ErrorReport {
  timestamp?: string;
  level?: ErrorLogLevel;
  subsystem: ErrorLogSubsystem | string;
  port?: number;
  host?: string;
  mode?: 'local' | 'hybrid' | 'remote' | string;
  endpoint?: string;
  method?: string;
  tool?: string;
  projectId?: string;
  clientIp?: string;
  error: Error | string | unknown;
  context?: Record<string, unknown>;
  stack?: string;
}

export interface ErrorLogOptions {
  vaultRoot?: string;
  logPath?: string;
}

/**
 * Resolves the destination file path for error.logs.
 * Priority: customPath argument > SPEC_MEMO_ERROR_LOG env var > <vaultRoot>/error.logs
 */
export function resolveErrorLogPath(vaultRoot?: string, customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    return path.resolve(customPath);
  }
  if (process.env.SPEC_MEMO_ERROR_LOG && process.env.SPEC_MEMO_ERROR_LOG.trim().length > 0) {
    return path.resolve(process.env.SPEC_MEMO_ERROR_LOG.trim());
  }
  const root = getVaultRoot(vaultRoot);
  return path.join(root, 'error.logs');
}

export const SENSITIVE_CONTEXT_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'token',
  'authtoken',
  'password',
  'secret'
]);

/**
 * Sanitizes context metadata by explicitly scrubbing known credential keys in
 * headers, query, params, body, or args objects regardless of secret length,
 * then applying regex-based redaction across all remaining payload fields.
 */
export function sanitizeLogContext(value: unknown): unknown {
  const redacted = redactSecretsInPayload(value);
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) return redacted;
  const out: Record<string, unknown> = { ...(redacted as Record<string, unknown>) };

  for (const nestedKey of ['headers', 'query', 'params', 'body', 'args'] as const) {
    const nested = out[nestedKey];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const cleaned: Record<string, unknown> = { ...(nested as Record<string, unknown>) };
    for (const [k] of Object.entries(cleaned)) {
      if (SENSITIVE_CONTEXT_KEYS.has(k.toLowerCase())) {
        cleaned[k] = '[REDACTED]';
      }
    }
    out[nestedKey] = cleaned;
  }

  for (const [k] of Object.entries(out)) {
    if (SENSITIVE_CONTEXT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    }
  }

  return redactVaultGitContextDeep(out);
}

function redactVaultGitContextDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactVaultGitError(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactVaultGitContextDeep(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactVaultGitContextDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Formats a structured ErrorReport into a detailed, human-readable, machine-parseable log block.
 */
export function formatErrorReport(report: ErrorReport): string {
  const timestamp = report.timestamp || new Date().toISOString();
  const level = report.level || 'ERROR';
  const subsystem = report.subsystem || 'system';

  let errorMessage = '';
  let stackTrace = report.stack;

  if (report.error instanceof Error) {
    errorMessage = report.error.message;
    if (!stackTrace && report.error.stack) {
      stackTrace = report.error.stack;
    }
  } else if (typeof report.error === 'string') {
    errorMessage = report.error;
  } else if (report.error && typeof report.error === 'object') {
    const rec = report.error as Record<string, unknown>;
    const msgVal = rec.message || rec.error;
    errorMessage = typeof msgVal === 'string' ? msgVal : JSON.stringify(report.error);
    if (!stackTrace && rec.stack) {
      stackTrace = String(rec.stack);
    }
  } else {
    errorMessage = String(report.error || 'Unknown error');
  }

  // Redact secrets from error message and stack trace
  errorMessage = redactVaultGitError(String(redactSecretsInPayload(errorMessage))) ?? errorMessage;
  if (stackTrace) {
    stackTrace = redactVaultGitError(String(redactSecretsInPayload(stackTrace))) ?? stackTrace;
  }

  const metaParts: string[] = [];
  if (report.port != null) metaParts.push(`Port: ${report.port}`);
  if (report.host) metaParts.push(`Host: ${report.host}`);
  if (report.mode) metaParts.push(`Mode: ${report.mode}`);
  const metaLine = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';

  const lines: string[] = [
    '================================================================================',
    `[${timestamp}] [${level}] [${subsystem}]${metaLine}`,
    '--------------------------------------------------------------------------------'
  ];

  if (report.endpoint || report.method) {
    lines.push(`Endpoint:    ${report.method ? `${report.method} ` : ''}${report.endpoint || ''}`);
  }
  if (report.tool) {
    lines.push(`Tool:        ${report.tool}`);
  }
  if (report.projectId) {
    lines.push(`Project ID:  ${report.projectId}`);
  }
  if (report.clientIp) {
    lines.push(`Client IP:   ${report.clientIp}`);
  }

  lines.push(`Error:       ${errorMessage}`);

  if (stackTrace) {
    lines.push('Stack Trace:');
    const indentedStack = stackTrace
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    lines.push(indentedStack);
  }

  if (report.context && Object.keys(report.context).length > 0) {
    const cleanContext = sanitizeLogContext(report.context);
    lines.push('Context Details:');
    const contextJson = JSON.stringify(cleanContext, null, 2);
    lines.push(
      contextJson
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')
    );
  }

  lines.push('================================================================================\n');

  return lines.join('\n');
}

/**
 * Appends a detailed error report to the resolved error.logs file.
 * Fail-safe: catches write errors to ensure calling servers never crash due to logging.
 */
export function logErrorReport(report: ErrorReport, options: ErrorLogOptions = {}): string {
  const formatted = formatErrorReport(report);
  const targetPath = resolveErrorLogPath(options.vaultRoot, options.logPath);

  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(targetPath, formatted, 'utf8');
  } catch (appendErr) {
    try {
      console.error(`[spec-memo] Failed to append to error log at ${targetPath}:`, appendErr);
      console.error(formatted);
    } catch {
      // ignore
    }
  }

  return formatted;
}

/**
 * Read contents of error.logs.
 */
export function readErrorLogs(vaultRoot?: string, customPath?: string): string {
  const targetPath = resolveErrorLogPath(vaultRoot, customPath);
  if (!fs.existsSync(targetPath)) {
    return '';
  }
  try {
    return fs.readFileSync(targetPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Clear/delete error.logs (useful for testing and maintenance).
 */
export function clearErrorLogs(vaultRoot?: string, customPath?: string): void {
  const targetPath = resolveErrorLogPath(vaultRoot, customPath);
  if (fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
    } catch {
      // ignore
    }
  }
}

/** Max bytes scanned from the end of error.logs (newest blocks first). */
export const ERROR_LOG_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/** Max chars for the list-view error snippet (AC14). */
export const ERROR_LOG_LIST_ERROR_MAX = 300;

/** Max chars for detail-view stack/context (AC15). */
export const ERROR_LOG_DETAIL_STACK_MAX = 4000;

/** Max chars for the detail-view error message (AC15 truncated contract). */
export const ERROR_LOG_DETAIL_ERROR_MAX = 4000;

export interface ErrorLogListItem {
  id: string;
  timestamp: string;
  level: ErrorLogLevel;
  subsystem: string;
  error: string;
  endpoint?: string;
  tool?: string;
  projectId?: string;
}

export interface ErrorLogDetail extends ErrorLogListItem {
  stack?: string;
  context?: unknown;
}

export interface ErrorLogListQuery {
  limit?: number;
  offset?: number;
  level?: ErrorLogLevel;
  subsystem?: string;
}

export interface ErrorLogListResult {
  items: ErrorLogListItem[];
  total: number;
  truncated: boolean;
}

interface ParsedErrorBlock {
  timestamp: string;
  level: ErrorLogLevel;
  subsystem: string;
  endpoint?: string;
  tool?: string;
  projectId?: string;
  error: string;
  stack?: string;
  context?: unknown;
}

/**
 * Content-stable list id (`elog-` + 12 hex chars) so a detail fetch resolves
 * the same block even when new entries are appended between list and detail
 * (positional indexes would shift under concurrent writers).
 */
export function errorLogStableId(e: Pick<ParsedErrorBlock, 'timestamp' | 'level' | 'subsystem' | 'error' | 'stack'>): string {
  return `elog-${crypto
    .createHash('sha1')
    .update(`${e.timestamp}|${e.level}|${e.subsystem}|${e.error}|${e.stack ?? ''}`)
    .digest('hex')
    .slice(0, 12)}`;
}

function parseErrorLogBlock(block: string): ParsedErrorBlock | null {
  const lines = block.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] || '').match(/^\[(.+?)\]\s+\[(ERROR|WARN|FATAL)\]\s+\[(.+?)\]/);
    if (m) {
      headerIdx = i;
      const timestamp = (m[1] || '').trim();
      const level = (m[2] || 'ERROR') as ErrorLogLevel;
      const subsystem = (m[3] || 'system').trim() || 'system';
      const out: ParsedErrorBlock = { timestamp, level, subsystem, error: '' };
      // Field lines after the ---- separator
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j] || '';
        if (/^-{5,}\s*$/.test(line)) continue;
        if (/^={5,}\s*$/.test(line)) break;
        let fm: RegExpMatchArray | null;
        if ((fm = line.match(/^Endpoint:\s*(.+)\s*$/))) {
          const v = (fm[1] || '').trim();
          if (v) {
            const parts = v.split(/\s+/);
            out.endpoint = parts.length > 1 ? parts.slice(1).join(' ') : v;
          }
          continue;
        }
        if ((fm = line.match(/^Tool:\s*(.+)\s*$/))) {
          const v = (fm[1] || '').trim();
          if (v) out.tool = v;
          continue;
        }
        if ((fm = line.match(/^Project ID:\s*(.+)\s*$/))) {
          const v = (fm[1] || '').trim();
          if (v) out.projectId = v;
          continue;
        }
        if ((fm = line.match(/^Error:\s*([\s\S]*)$/))) {
          out.error = (fm[1] || '').trim();
          continue;
        }
        if (/^Stack Trace:\s*$/.test(line)) {
          const stackLines: string[] = [];
          let k = j + 1;
          for (; k < lines.length; k++) {
            const sl = lines[k] || '';
            if (/^Context Details:\s*$/.test(sl) || /^={5,}\s*$/.test(sl)) break;
            stackLines.push(sl.replace(/^  /, ''));
          }
          const stack = stackLines.join('\n').trim();
          if (stack) out.stack = stack;
          j = k - 1;
          continue;
        }
        if (/^Context Details:\s*$/.test(line)) {
          const ctxLines: string[] = [];
          let k = j + 1;
          for (; k < lines.length; k++) {
            const cl = lines[k] || '';
            if (/^={5,}\s*$/.test(cl)) break;
            ctxLines.push(cl.replace(/^  /, ''));
          }
          const raw = ctxLines.join('\n').trim();
          if (raw) {
            try {
              out.context = JSON.parse(raw) as unknown;
            } catch {
              out.context = raw;
            }
          }
          j = k - 1;
        }
      }
      if (!out.error) out.error = 'Unknown error';
      return out;
    }
  }
  void headerIdx;
  return null;
}

function splitErrorLogBlocks(content: string): string[] {
  // Blocks are delimited by ==== lines from formatErrorReport.
  const parts = content.split(/^={10,}\s*$/m);
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = (part || '').trim();
    if (!trimmed) continue;
    if (!/^\[.+?\]\s+\[(ERROR|WARN|FATAL)\]/.test(trimmed) && !/\[.+?\]\s+\[.+?\]/.test(trimmed)) {
      // Keep only blocks that carry a header line.
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

function readErrorLogTail(targetPath: string): { content: string; truncated: boolean } {
  try {
    const st = fs.statSync(targetPath);
    if (st.size <= ERROR_LOG_SCAN_MAX_BYTES) {
      return { content: fs.readFileSync(targetPath, 'utf8'), truncated: false };
    }
    const fd = fs.openSync(targetPath, 'r');
    try {
      const start = st.size - ERROR_LOG_SCAN_MAX_BYTES;
      const buf = Buffer.alloc(ERROR_LOG_SCAN_MAX_BYTES);
      fs.readSync(fd, buf, 0, ERROR_LOG_SCAN_MAX_BYTES, start);
      let content = buf.toString('utf8');
      // Drop a leading partial block: start after the first ==== delimiter.
      const delim = content.search(/^={10,}\s*$/m);
      if (delim > 0) {
        content = content.slice(delim);
      }
      return { content, truncated: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { content: '', truncated: false };
  }
}

/**
 * Validate list query; throws a 400-flavoured Error on invalid input.
 */
export function parseErrorLogListQuery(raw: Record<string, string | null>): ErrorLogListQuery {
  const out: ErrorLogListQuery = {};
  const limitRaw = raw.limit ?? null;
  if (limitRaw !== null && limitRaw !== '') {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      const err = new Error('Invalid error-logs query (limit must be an integer 1..200)');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    out.limit = n;
  }
  const offsetRaw = raw.offset ?? null;
  if (offsetRaw !== null && offsetRaw !== '') {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0) {
      const err = new Error('Invalid error-logs query (offset must be a non-negative integer)');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    out.offset = n;
  }
  const levelRaw = raw.level ?? null;
  if (levelRaw !== null && levelRaw !== '') {
    if (levelRaw !== 'ERROR' && levelRaw !== 'WARN' && levelRaw !== 'FATAL') {
      const err = new Error('Invalid error-logs query (level must be ERROR, WARN, or FATAL)');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    out.level = levelRaw;
  }
  const subsystemRaw = raw.subsystem ?? null;
  if (subsystemRaw !== null && subsystemRaw !== '') {
    if (subsystemRaw.length > 120) {
      const err = new Error('Invalid error-logs query (subsystem too long)');
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    out.subsystem = subsystemRaw;
  }
  return out;
}

/**
 * List parsed error.logs blocks newest-first with a 2MiB tail cap.
 * Missing file yields an empty 200-style result (never throws).
 */
export function listErrorLogEntries(
  vaultRoot?: string,
  query: ErrorLogListQuery = {},
  customPath?: string
): ErrorLogListResult {
  const targetPath = resolveErrorLogPath(vaultRoot, customPath);
  if (!fs.existsSync(targetPath)) {
    return { items: [], total: 0, truncated: false };
  }
  const { content, truncated } = readErrorLogTail(targetPath);
  if (!content.trim()) {
    return { items: [], total: 0, truncated };
  }
  const blocks = splitErrorLogBlocks(content);
  const parsed: ParsedErrorBlock[] = [];
  for (const block of blocks) {
    try {
      const entry = parseErrorLogBlock(block);
      if (entry) parsed.push(entry);
    } catch {
      // skip malformed blocks
    }
  }
  // Newest-first: file order is oldest-first, so reverse.
  parsed.reverse();
  // List ids are content-stable hashes (errorLogStableId), so filtered rows
  // and detail fetches resolve the same block (see getErrorLogEntry).
  const filtered = parsed.filter((e) => {
    if (query.level && e.level !== query.level) return false;
    if (query.subsystem && e.subsystem !== query.subsystem) return false;
    return true;
  });
  const total = filtered.length;
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const window = filtered.slice(offset, offset + limit);
  const items: ErrorLogListItem[] = window.map((e) => {
    const item: ErrorLogListItem = {
      id: errorLogStableId(e),
      timestamp: e.timestamp,
      level: e.level,
      subsystem: e.subsystem,
      error: e.error.length > ERROR_LOG_LIST_ERROR_MAX ? e.error.slice(0, ERROR_LOG_LIST_ERROR_MAX) : e.error
    };
    if (e.endpoint) item.endpoint = e.endpoint;
    if (e.tool) item.tool = e.tool;
    if (e.projectId) item.projectId = e.projectId;
    return item;
  });
  return { items, total, truncated };
}

/**
 * Fetch one parsed block by list id over the same 2MiB tail window.
 * List-issued content-stable ids resolve by hash; legacy positional `elog-N`
 * ids still resolve positionally (subject to append shift). Returns null when unknown.
 */
export function getErrorLogEntry(
  vaultRoot?: string,
  id?: string,
  customPath?: string
): ErrorLogDetail | null {
  if (!id || !/^elog-(?:[0-9a-f]{12}|\d+)$/.test(id)) return null;
  const targetPath = resolveErrorLogPath(vaultRoot, customPath);
  if (!fs.existsSync(targetPath)) return null;
  const { content } = readErrorLogTail(targetPath);
  if (!content.trim()) return null;
  const blocks = splitErrorLogBlocks(content);
  const parsed: ParsedErrorBlock[] = [];
  for (const block of blocks) {
    try {
      const entry = parseErrorLogBlock(block);
      if (entry) parsed.push(entry);
    } catch {
      // skip
    }
  }
  parsed.reverse();
  let entry = parsed.find((e) => errorLogStableId(e) === id);
  if (!entry && /^elog-\d+$/.test(id)) {
    entry = parsed[Number(id.slice('elog-'.length))];
  }
  if (!entry) return null;
  const detail: ErrorLogDetail = {
    id,
    timestamp: entry.timestamp,
    level: entry.level,
    subsystem: entry.subsystem,
    error:
      entry.error.length > ERROR_LOG_DETAIL_ERROR_MAX
        ? `${entry.error.slice(0, ERROR_LOG_DETAIL_ERROR_MAX)}…[truncated]`
        : entry.error
  };
  if (entry.endpoint) detail.endpoint = entry.endpoint;
  if (entry.tool) detail.tool = entry.tool;
  if (entry.projectId) detail.projectId = entry.projectId;
  if (entry.stack) {
    detail.stack =
      entry.stack.length > ERROR_LOG_DETAIL_STACK_MAX
        ? `${entry.stack.slice(0, ERROR_LOG_DETAIL_STACK_MAX)}…[truncated]`
        : entry.stack;
  }
  if (entry.context !== undefined) {
    // AC15 promises truncated stack AND context: cap serialized context like stack.
    const raw = typeof entry.context === 'string' ? entry.context : JSON.stringify(entry.context);
    detail.context =
      raw.length > ERROR_LOG_DETAIL_STACK_MAX
        ? `${raw.slice(0, ERROR_LOG_DETAIL_STACK_MAX)}…[truncated]`
        : entry.context;
  }
  return detail;
}
