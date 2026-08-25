import * as path from 'node:path';

/**
 * Common regex signatures for sensitive credentials and keys.
 */
export const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'Private Key (PEM block)',
    regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY[ A-Z0-9_-]*-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY[ A-Z0-9_-]*-----/i
  },
  {
    name: 'Private Key Header',
    regex: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY[ A-Z0-9_-]*-----/i
  },
  {
    name: 'AWS Access Key ID',
    regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/
  },
  {
    name: 'GitHub Personal Access Token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,255}\b/
  },
  {
    name: 'Slack Token',
    regex: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/
  },
  {
    name: 'Generic API Key / Secret Assignment',
    regex: /(?:api_key|apikey|secret_key|private_key|auth_token|access_token|secret_token|client_secret)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i
  },
  {
    name: 'Bearer Token Header',
    regex: /\bBearer\s+[a-zA-Z0-9_\-\.]{25,}\b/i
  }
];

export interface SecretCheckResult {
  hasSecret: boolean;
  matches: string[];
}

/**
 * Scan text content against known secret signatures.
 */
export function detectSecrets(text: string): SecretCheckResult {
  if (!text || typeof text !== 'string') {
    return { hasSecret: false, matches: [] };
  }

  const matches: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      matches.push(pattern.name);
    }
  }

  return {
    hasSecret: matches.length > 0,
    matches
  };
}

/**
 * Scan an object or text payload recursively for secrets.
 */
export function scanPayloadForSecrets(payload: unknown): SecretCheckResult {
  const matches: string[] = [];

  function scan(val: unknown) {
    if (typeof val === 'string') {
      const res = detectSecrets(val);
      if (res.hasSecret) {
        matches.push(...res.matches);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        scan(item);
      }
    } else if (val !== null && typeof val === 'object') {
      for (const key of Object.keys(val as Record<string, unknown>)) {
        scan((val as Record<string, unknown>)[key]);
      }
    }
  }

  scan(payload);

  const uniqueMatches = Array.from(new Set(matches));
  return {
    hasSecret: uniqueMatches.length > 0,
    matches: uniqueMatches
  };
}

/**
 * Assert that payload contains no secrets; throw safety error if any detected.
 */
export function assertNoSecrets(payload: unknown, contextDesc = 'record payload'): void {
  const result = scanPayloadForSecrets(payload);
  if (result.hasSecret) {
    throw new Error(
      `Safety violation: Secret detected in ${contextDesc} (${result.matches.join(', ')}). Private keys, tokens, and credentials must not be stored in spec-memo.`
    );
  }
}

const VAULT_PATH_KEYS = new Set(['path', 'filepath', 'targetPath', 'purgedFiles', 'compactedPlans']);

/**
 * Redact credential-like strings in a JSON-serializable payload (read-path fail-closed).
 */
export function redactSecretsInPayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    let out = payload;
    for (const pattern of SECRET_PATTERNS) {
      const global = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`);
      out = out.replace(global, `[REDACTED:${pattern.name}]`);
    }
    return out;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => redactSecretsInPayload(item));
  }
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = redactSecretsInPayload(value);
    }
    return out;
  }
  return payload;
}

/**
 * Strip absolute vault filesystem paths from caller-facing MCP/CLI payloads.
 * Keeps product-relative fields such as pathPatterns and destination.
 */
export function stripVaultPaths(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => stripVaultPaths(item));
  }
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (VAULT_PATH_KEYS.has(key)) {
        continue;
      }
      out[key] = stripVaultPaths(value);
    }
    return out;
  }
  return payload;
}

/**
 * Prepare a tool result for MCP/CLI callers: redact secrets then omit vault paths.
 */
export function redactAbsolutePathsInText(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s)'"`]+/g, '[path]')
    .replace(/(^|[\s(])(\/(?:[^/\s)]+\/)+[^/\s)]+)/g, '$1[path]');
}

export function sanitizeToolOutput(payload: unknown): unknown {
  return stripVaultPaths(redactSecretsInPayload(redactPathsDeep(payload)));
}

function redactPathsDeep(payload: unknown): unknown {
  if (typeof payload === 'string') {
    return redactAbsolutePathsInText(payload);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => redactPathsDeep(item));
  }
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = redactPathsDeep(value);
    }
    return out;
  }
  return payload;
}

/**
 * Check whether a target path is located inside a product repository.
 */
export function isPathInside(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);

  // Normalize Windows drive letters and separators
  const normTarget = resolvedTarget.toLowerCase().replace(/\\/g, '/');
  const normRoot = resolvedRoot.toLowerCase().replace(/\\/g, '/');

  if (normTarget === normRoot) {
    return true;
  }

  const rootWithSlash = normRoot.endsWith('/') ? normRoot : `${normRoot}/`;
  return normTarget.startsWith(rootWithSlash);
}

/**
 * Assert that target file write is outside consumer product repository.
 */
export function assertNotInProductRoot(targetPath: string, productRoot: string | null, _isGit = true): void {
  if (!productRoot) {
    return;
  }

  if (isPathInside(targetPath, productRoot)) {
    throw new Error(
      `Safety violation: Attempted to write memory record inside consumer product repository (${targetPath}). Workflow artifacts must be stored outside the product repository in the spec-memo vault.`
    );
  }
}
