import * as fs from 'node:fs';
import * as path from 'node:path';
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
  | 'canvas'
  | 'cli'
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
