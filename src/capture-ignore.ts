import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesPathPattern } from './indexer.js';
import { isPathInside } from './safety.js';
import { ensureVaultStructure, getVaultRoot } from './vault.js';

export type IgnoreRuleSource = 'builtin' | '.spec-memo-ignore' | 'config.json';

export interface IgnoreRule {
  pattern: string;
  negated: boolean;
  source: IgnoreRuleSource;
  line?: number;
}

export interface IgnoreMatchResult {
  ignored: boolean;
  rule?: IgnoreRule;
}

export interface IgnoreBoundaryDiagnostics {
  activeRuleCount: number;
  invalidLines: Array<{ line: number; text: string; reason: string }>;
  rules: IgnoreRule[];
}

export interface CheckCaptureResult {
  status: 'CAPTURED' | 'IGNORED';
  path: string;
  relativePath: string;
  match?: {
    pattern: string;
    line?: number;
    source: IgnoreRuleSource;
  };
}

const IGNORE_MARKER = '.spec-memo-ignore';

/** Built-in baseline patterns active even without a project marker file (AC2). */
export const DEFAULT_IGNORE_PATTERNS: string[] = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  '.venv/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.crt',
  '*.p12',
  '*.pfx',
  '*.bin',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.7z',
  '*.rar',
  '*.iso',
  '*.dmg',
  '*.img',
  '*.sqlite',
  '*.db'
];

interface IgnoreCacheEntry {
  mtimeMs: number;
  rules: IgnoreRule[];
  invalidLines: Array<{ line: number; text: string; reason: string }>;
}

const ignoreCache = new Map<string, IgnoreCacheEntry>();

function cacheKey(productRoot: string, projectId?: string, vaultRoot?: string): string {
  const root = path.resolve(productRoot);
  const marker = path.join(root, IGNORE_MARKER);
  const mtime = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
  return `${root}|${projectId || ''}|${vaultRoot || ''}|${mtime}`;
}

function normalizeRelativePath(filePath: string, productRoot: string): string | null {
  const resolvedRoot = path.resolve(productRoot);
  const resolvedTarget = path.resolve(
    path.isAbsolute(filePath) ? filePath : path.join(resolvedRoot, filePath)
  );

  if (!isPathInside(resolvedTarget, resolvedRoot)) {
    return null;
  }

  return path.relative(resolvedRoot, resolvedTarget).replace(/\\/g, '/');
}

function validatePatternSyntax(pattern: string): string | null {
  if (!pattern || !pattern.trim()) {
    return 'empty pattern';
  }
  try {
    matchesPathPattern('sample/path.ts', pattern);
    return null;
  } catch {
    return 'invalid glob syntax';
  }
}

function parseIgnoreFile(content: string, source: IgnoreRuleSource): {
  rules: IgnoreRule[];
  invalidLines: Array<{ line: number; text: string; reason: string }>;
} {
  const rules: IgnoreRule[] = [];
  const invalidLines: Array<{ line: number; text: string; reason: string }> = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    let negated = false;
    let pattern = trimmed;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1).trim();
    }
    if (!pattern) {
      invalidLines.push({ line: i + 1, text: raw, reason: 'empty negation pattern' });
      continue;
    }

    const syntaxError = validatePatternSyntax(pattern);
    if (syntaxError) {
      invalidLines.push({ line: i + 1, text: raw, reason: syntaxError });
      continue;
    }

    rules.push({ pattern, negated, source, line: i + 1 });
  }

  return { rules, invalidLines };
}

function loadConfigIgnorePaths(projectId: string | undefined, vaultRoot: string): IgnoreRule[] {
  if (!projectId) {
    return [];
  }
  try {
    const config = ensureVaultStructure(vaultRoot);
    const projectCfg = config.projects?.[projectId];
    const ignorePaths = projectCfg?.ignorePaths;
    if (!Array.isArray(ignorePaths)) {
      return [];
    }
    return ignorePaths
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((pattern) => ({
        pattern: pattern.trim(),
        negated: false,
        source: 'config.json' as const
      }));
  } catch {
    return [];
  }
}

/**
 * Load merged ignore rules for a product repository (cached per marker mtime).
 */
export function loadIgnoreRules(
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): IgnoreBoundaryDiagnostics {
  const resolvedRoot = path.resolve(productRoot);
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const key = cacheKey(resolvedRoot, options.projectId, vaultRoot);
  const markerPath = path.join(resolvedRoot, IGNORE_MARKER);
  const markerMtime = fs.existsSync(markerPath) ? fs.statSync(markerPath).mtimeMs : 0;

  const cached = ignoreCache.get(key);
  if (cached && cached.mtimeMs === markerMtime) {
    return {
      activeRuleCount: cached.rules.length,
      invalidLines: cached.invalidLines,
      rules: cached.rules
    };
  }

  const rules: IgnoreRule[] = DEFAULT_IGNORE_PATTERNS.map((pattern) => ({
    pattern,
    negated: false,
    source: 'builtin' as const
  }));

  const invalidLines: Array<{ line: number; text: string; reason: string }> = [];

  if (fs.existsSync(markerPath)) {
    try {
      const parsed = parseIgnoreFile(fs.readFileSync(markerPath, 'utf8'), '.spec-memo-ignore');
      rules.push(...parsed.rules);
      invalidLines.push(...parsed.invalidLines);
      for (const bad of parsed.invalidLines) {
        console.warn(
          `Warning: .spec-memo-ignore line ${bad.line}: ${bad.reason} (${bad.text.trim()})`
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      invalidLines.push({ line: 0, text: markerPath, reason: msg });
      console.warn(`Warning: failed to read ${IGNORE_MARKER}: ${msg}`);
    }
  }

  rules.push(...loadConfigIgnorePaths(options.projectId, vaultRoot));

  ignoreCache.set(key, { mtimeMs: markerMtime, rules, invalidLines });
  return { activeRuleCount: rules.length, invalidLines, rules };
}

function pathMatchesRule(relativePath: string, rule: IgnoreRule): boolean {
  const normPath = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const pattern = rule.pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  const candidates = [pattern];
  if (!pattern.includes('/')) {
    candidates.push(`**/${pattern}`);
  }
  if (pattern.endsWith('/')) {
    const dirPattern = pattern.slice(0, -1);
    if (dirPattern) {
      candidates.push(`${dirPattern}/**`);
    }
  }

  for (const candidate of candidates) {
    if (matchesPathPattern(normPath, candidate)) {
      return true;
    }
    if (candidate.endsWith('/')) {
      const dirOnly = candidate.slice(0, -1);
      if (normPath === dirOnly || normPath.startsWith(`${dirOnly}/`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluate whether a file path is excluded from capture/indexing (AC5).
 */
export function isPathIgnored(
  filePath: string,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): boolean {
  return evaluatePathIgnore(filePath, productRoot, options).ignored;
}

export function evaluatePathIgnore(
  filePath: string,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): IgnoreMatchResult {
  const relativePath = normalizeRelativePath(filePath, productRoot);
  if (relativePath === null) {
    return { ignored: true };
  }

  const { rules } = loadIgnoreRules(productRoot, options);
  let ignored = false;
  let matchedRule: IgnoreRule | undefined;

  for (const rule of rules) {
    if (!pathMatchesRule(relativePath, rule)) {
      continue;
    }
    if (rule.negated) {
      ignored = false;
      matchedRule = undefined;
    } else {
      ignored = true;
      matchedRule = rule;
    }
  }

  return { ignored, rule: ignored ? matchedRule : undefined };
}

/**
 * Strip pathPatterns that target ignored paths; throw if all patterns removed (AC6).
 */
export function sanitizePathPatterns(
  pathPatterns: string[] | undefined,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): string[] {
  if (!pathPatterns || pathPatterns.length === 0) {
    return [];
  }

  const kept: string[] = [];
  for (const pattern of pathPatterns) {
    if (isPathPatternIgnored(pattern, productRoot, options)) {
      continue;
    }
    kept.push(pattern);
  }

  if (pathPatterns.length > 0 && kept.length === 0) {
    throw new Error('Safety violation: all pathPatterns match ignored paths.');
  }

  return kept;
}

function isPathPatternIgnored(
  pattern: string,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string }
): boolean {
  const sample = pattern
    .replace(/\*\*/g, 'sample')
    .replace(/\*/g, 'sample')
    .replace(/\?/g, 'x')
    .replace(/^\//, '');

  if (sample && isPathIgnored(sample, productRoot, options)) {
    return true;
  }

  const dirOnly = pattern.replace(/\/\*\*$/, '').replace(/\/$/, '');
  if (dirOnly && dirOnly !== pattern && isPathIgnored(dirOnly, productRoot, options)) {
    return true;
  }

  return false;
}

const PATH_TOKEN_REGEX =
  /(?:^|[\s('"`,\[])(?:(?:file:\/\/)?(?:[A-Za-z]:[/\\]|\/)[^\s'"`,\]]+|(?:\.{0,2}\/)?(?:[\w.-]+[/\\])+[\w.-]+\.[\w.-]+)(?=$|[\s'"`,\]\):])/g;

/**
 * Redact file path references in prompt text that match ignore rules (AC7).
 */
export function redactIgnoredPathsInText(
  text: string,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  return text.replace(PATH_TOKEN_REGEX, (match, offset, full) => {
    const prefix = match.match(/^[\s('"`,\[]*/)?.[0] || '';
    const token = match.slice(prefix.length);
    if (!token || token === '[PATH_IGNORED]') {
      return match;
    }

    const candidate = token.replace(/^file:\/\//, '');
    if (isPathIgnored(candidate, productRoot, options)) {
      return `${prefix}[PATH_IGNORED]`;
    }
    return match;
  });
}

export function checkCapturePath(
  targetPath: string,
  productRoot: string,
  options: { projectId?: string; vaultRoot?: string } = {}
): CheckCaptureResult {
  const relativePath = normalizeRelativePath(targetPath, productRoot);
  const evalResult = evaluatePathIgnore(targetPath, productRoot, options);

  if (evalResult.ignored) {
    const rule = evalResult.rule;
    return {
      status: 'IGNORED',
      path: path.resolve(productRoot, relativePath || targetPath),
      relativePath: relativePath || targetPath.replace(/\\/g, '/'),
      match: rule
        ? {
            pattern: rule.pattern,
            line: rule.line,
            source: rule.source
          }
        : undefined
    };
  }

  return {
    status: 'CAPTURED',
    path: path.resolve(productRoot, relativePath || targetPath),
    relativePath: relativePath || targetPath.replace(/\\/g, '/')
  };
}

export function formatCheckCaptureResult(result: CheckCaptureResult): string {
  if (result.status === 'IGNORED' && result.match) {
    const linePart = result.match.line != null ? ` line ${result.match.line}` : '';
    return `${result.status} (matched${linePart}: ${result.match.pattern}, source: ${result.match.source})`;
  }
  if (result.status === 'IGNORED') {
    return `${result.status} (outside repository root or matched ignore boundary)`;
  }
  return `${result.status} (no ignore rule matched)`;
}

export function clearIgnoreCacheForTests(): void {
  ignoreCache.clear();
}
