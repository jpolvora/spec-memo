/**
 * Redaction helpers for harness diagnostics (AC13).
 *
 * The bridge never logs prompt bodies or argv arrays. Strings that do reach a
 * log line can still come from third parties (host spawn errors, config
 * messages), so every diagnostic passes through `redactText` before it is
 * emitted and every `lastError` message is stored already redacted.
 */

/** Hard cap for one diagnostic string, in UTF-16 code units. */
export const MAX_DIAGNOSTIC_LENGTH = 240;

/**
 * Ordered patterns: specific credential shapes first, generic
 * `name=value` assignments last so they cannot swallow the whole line.
 */
const REDACTIONS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '[redacted-jwt]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gi, '[redacted-key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gi, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gi, '[redacted-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{6,}\b/gi, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted-key]'],
  [
    /\b[A-Za-z0-9_.-]*(?:token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|authorization|credential)[A-Za-z0-9_.-]*\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
    '[redacted-secret]'
  ]
]);

/**
 * Mask secret-shaped substrings, collapse line breaks, and cap the result.
 * Always returns a single-line string no longer than `maxLength`.
 */
export function redactText(value, { maxLength = MAX_DIAGNOSTIC_LENGTH } = {}) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let text = value;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : MAX_DIAGNOSTIC_LENGTH;
  if (text.length > limit) {
    text = `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
  return text;
}

/**
 * Turn an unknown thrown value into a short, redacted, single-line message.
 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown-error';
  if (typeof error === 'string') return redactText(error);
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : null;
  let message;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error?.message === 'string') {
    message = error.message;
  } else {
    message = String(error);
  }
  const combined = code && !message.includes(code) ? `${code}: ${message}` : message;
  return redactText(combined);
}
