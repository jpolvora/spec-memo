export const INTENT_KIND_BOOST = 1.5;

export type SearchIntent = 'decision' | 'trap' | 'log' | 'none';

export type TaskLens =
  | 'bugfix'
  | 'feature'
  | 'release'
  | 'onboarding'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'general';

const TRAP_INTENT_TOKENS = [
  'fail',
  'failed',
  'failure',
  'gotcha',
  'trap',
  'do-not',
  'donot',
  'dont',
  "don't",
  'regression'
] as const;

const LOG_INTENT_TOKENS = ['changed', 'commit', 'commits', 'shipped', 'changelog'] as const;

const DECISION_INTENT_TOKENS = ['why', 'rationale', 'tradeoff', 'trade-off', 'decision'] as const;

const TASK_LENS_ROWS: ReadonlyArray<{ lens: TaskLens; tokens: readonly string[] }> = [
  {
    lens: 'bugfix',
    tokens: ['bug', 'bugfix', 'fix', 'hotfix', 'fail', 'failed', 'failure', 'error', 'regression']
  },
  { lens: 'feature', tokens: ['feature', 'feat', 'add', 'implement', 'new'] },
  { lens: 'release', tokens: ['release', 'ship', 'shipped', 'version', 'changelog'] },
  { lens: 'onboarding', tokens: ['onboard', 'onboarding', 'getting-started', 'setup', 'install'] },
  { lens: 'refactor', tokens: ['refactor', 'cleanup', 'rename'] },
  { lens: 'docs', tokens: ['docs', 'doc', 'readme', 'documentation'] },
  { lens: 'test', tokens: ['test', 'tests', 'coverage', 'spec'] }
];

function compactAlphanumeric(value: string): string {
  return value.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '');
}

/**
 * Tokenize query: lowercase, strip apostrophes, split on non-alphanumeric runs.
 */
export function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().replace(/['']/g, '');
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenMatchesTableEntry(tokens: string[], tableToken: string): boolean {
  const entryParts = tableToken.toLowerCase().replace(/['']/g, '').split(/[\s-]+/).filter(Boolean);
  if (entryParts.length === 0) return false;

  const tokenSet = new Set(tokens);
  const compactTokens = new Set(tokens.map((t) => t.replace(/-/g, '')));

  if (entryParts.length === 1) {
    const part = entryParts[0];
    const compactPart = part.replace(/-/g, '');
    return tokenSet.has(part) || compactTokens.has(compactPart);
  }

  return entryParts.every((part) => {
    const compactPart = part.replace(/-/g, '');
    return tokenSet.has(part) || compactTokens.has(compactPart);
  });
}

function queryHasPhrase(tokens: string[], parts: string[]): boolean {
  return parts.every((part) => tokenMatchesTableEntry(tokens, part));
}

export function inferSearchIntent(query: string): SearchIntent {
  const trimmed = query.trim();
  if (!trimmed) return 'none';

  const tokens = tokenizeQuery(trimmed);

  if (TRAP_INTENT_TOKENS.some((entry) => tokenMatchesTableEntry(tokens, entry))) {
    return 'trap';
  }
  if (queryHasPhrase(tokens, ['what', 'changed'])) {
    return 'log';
  }
  if (LOG_INTENT_TOKENS.some((entry) => tokenMatchesTableEntry(tokens, entry))) {
    return 'log';
  }
  if (DECISION_INTENT_TOKENS.some((entry) => tokenMatchesTableEntry(tokens, entry))) {
    return 'decision';
  }
  return 'none';
}

export function intentKindBoost(intent: SearchIntent, kind: string): number {
  if (intent === 'none') return 1;
  if (intent === kind) return INTENT_KIND_BOOST;
  return 1;
}

function matchesTaskLensToken(tokens: string[], entry: string): boolean {
  if (entry === 'spec') {
    const specIdx = tokens.indexOf('spec');
    if (specIdx >= 0 && tokens[specIdx + 1] === 'memo') {
      return false;
    }
  }
  return tokenMatchesTableEntry(tokens, entry);
}

export function inferTaskLens(query?: string): TaskLens {
  if (!query || !query.trim()) return 'general';
  const tokens = tokenizeQuery(query);
  for (const row of TASK_LENS_ROWS) {
    if (row.tokens.some((entry) => matchesTaskLensToken(tokens, entry))) {
      return row.lens;
    }
  }
  return 'general';
}

export function taskLensTrapMultiplier(lens: TaskLens): number {
  switch (lens) {
    case 'bugfix':
      return 1.5;
    case 'feature':
      return 1;
    case 'onboarding':
    case 'refactor':
      return 1.15;
    default:
      return 1;
  }
}

export function taskLensDecisionMultiplier(lens: TaskLens): number {
  switch (lens) {
    case 'feature':
      return 1.5;
    case 'docs':
    case 'test':
      return 1.15;
    default:
      return 1;
  }
}

export function releaseDecisionScore(decision: { frontmatter: { status?: string; updated?: string } }): number {
  const updatedMs = Date.parse(String(decision.frontmatter.updated || '')) || 0;
  const shippedBoost = decision.frontmatter.status === 'shipped' ? 1_000_000_000_000 : 0;
  return shippedBoost + updatedMs;
}

export function releaseLensNotice(): string {
  return 'Release context: search for kind=log records to view changelog entries.';
}

/** Whole-token check used in tests (e.g. spec vs spec-memo). */
export function taskLensMatchesToken(query: string, token: string): boolean {
  return tokenizeQuery(query).includes(token);
}

export function hyphenApostropheIntentProbe(query: string): boolean {
  const compact = compactAlphanumeric(query);
  return compact.includes('tradeoff') || compact.includes('dont');
}
