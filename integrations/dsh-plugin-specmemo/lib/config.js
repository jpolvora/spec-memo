const EVENT_TOGGLES = Object.freeze({
  bootstrap: true,
  promptRecord: true,
  toolAudit: false,
  syncOnFlush: true,
  sessionEnd: true
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  memoCommand: Object.freeze(['memo']),
  vaultRoot: null,
  productRoot: null,
  timeoutMs: 2000,
  debounceMs: 1500,
  queueLimit: 64,
  maxBodyBytes: 8000,
  events: EVENT_TOGGLES
});

function readBoolean(value, fallback, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TypeError(`specmemo-bridge config: ${field} must be a boolean`);
  }
  return value;
}

function readInteger(value, fallback, field, min) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new TypeError(`specmemo-bridge config: ${field} must be an integer >= ${min}`);
  }
  return value;
}

function splitCommand(value) {
  const parts = String(value).trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
}

function readCommand(value) {
  if (value === undefined) return [...DEFAULT_CONFIG.memoCommand];
  if (typeof value === 'string') {
    const parts = splitCommand(value);
    if (parts.length === 0) {
      throw new TypeError('specmemo-bridge config: memoCommand must not be empty');
    }
    return parts;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new TypeError('specmemo-bridge config: memoCommand must not be an empty array');
    }
    return value.map((part) => {
      if (typeof part !== 'string' || part.trim().length === 0) {
        throw new TypeError('specmemo-bridge config: memoCommand entries must be non-empty strings');
      }
      return part;
    });
  }
  throw new TypeError('specmemo-bridge config: memoCommand must be a string or an array of strings');
}

function readPathOrNull(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`specmemo-bridge config: ${field} must be a non-empty string or null`);
  }
  return value;
}

/**
 * Normalize and validate raw plugin config. Unknown keys are ignored, known
 * keys are type checked, and every unset key falls back to the documented
 * defaults.
 */
export function normalizeConfig(rawConfig = {}) {
  if (rawConfig === null || rawConfig === undefined) rawConfig = {};
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new TypeError('specmemo-bridge config must be an object');
  }

  const rawEvents = rawConfig.events ?? {};
  if (typeof rawEvents !== 'object' || rawEvents === null || Array.isArray(rawEvents)) {
    throw new TypeError('specmemo-bridge config: events must be an object');
  }

  const events = {};
  for (const [key, fallback] of Object.entries(EVENT_TOGGLES)) {
    events[key] = readBoolean(rawEvents[key], fallback, `events.${key}`);
  }

  return {
    enabled: readBoolean(rawConfig.enabled, DEFAULT_CONFIG.enabled, 'enabled'),
    memoCommand: readCommand(rawConfig.memoCommand),
    vaultRoot: readPathOrNull(rawConfig.vaultRoot, 'vaultRoot'),
    productRoot: readPathOrNull(rawConfig.productRoot, 'productRoot'),
    timeoutMs: readInteger(rawConfig.timeoutMs, DEFAULT_CONFIG.timeoutMs, 'timeoutMs', 1),
    debounceMs: readInteger(rawConfig.debounceMs, DEFAULT_CONFIG.debounceMs, 'debounceMs', 0),
    queueLimit: readInteger(rawConfig.queueLimit, DEFAULT_CONFIG.queueLimit, 'queueLimit', 1),
    maxBodyBytes: readInteger(rawConfig.maxBodyBytes, DEFAULT_CONFIG.maxBodyBytes, 'maxBodyBytes', 1),
    events
  };
}
