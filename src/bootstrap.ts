import * as path from 'node:path';
import { BootstrapBrief, BootstrapOptions, MemoRecord } from './types.js';
import { getProjectMetadata, getVaultRoot } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { scanProjectRecords } from './compiler.js';
import { getRecord } from './store.js';
import { matchesAnyPattern } from './indexer.js';

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 400,
  high: 300,
  medium: 200,
  low: 100
};

/**
 * Compute byte length of JSON-serialized payload in UTF-8.
 */
export function calculatePayloadSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Score a trap based on severity, path relevance, and query matching.
 */
export function scoreTrap(trap: MemoRecord, query?: string, pathFilter?: string): number {
  const sev = trap.frontmatter.severity || 'medium';
  let score = SEVERITY_WEIGHT[sev] || 200;

  // Path pattern matching bonus
  if (pathFilter && trap.frontmatter.pathPatterns && trap.frontmatter.pathPatterns.length > 0) {
    if (matchesAnyPattern(pathFilter, trap.frontmatter.pathPatterns)) {
      score += 1000;
    }
  }

  // Keyword query relevance bonus
  if (query) {
    const qLower = query.toLowerCase();
    const title = String(trap.frontmatter.title || '').toLowerCase();
    const body = String(trap.body || '').toLowerCase();
    const rawTags = trap.frontmatter.tags;
    const tags = Array.isArray(rawTags) ? rawTags.map((t) => String(t).toLowerCase()) : [];

    const terms = qLower.split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (title.includes(term)) score += 80;
      if (tags.some((t) => t.includes(term))) score += 50;
      if (body.includes(term)) score += 20;
    }
  }

  return score;
}

/**
 * Compile a token-budgeted session brief for AI agents at session bootstrap.
 */
export async function compileBootstrapBrief(options: BootstrapOptions = {}): Promise<BootstrapBrief> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;
  const projectDir = path.join(vaultRoot, 'projects', projectId);

  const metadata = getProjectMetadata(projectId, vaultRoot);
  const allRecords = scanProjectRecords(projectDir);

  // 1. Gather & rank active traps
  const activeTraps = allRecords
    .filter((r) => r.frontmatter.kind === 'trap' && r.frontmatter.status === 'active')
    .sort((a, b) => {
      const scoreA = scoreTrap(a, options.query, options.path);
      const scoreB = scoreTrap(b, options.query, options.path);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return (b.frontmatter.updated || '').localeCompare(a.frontmatter.updated || '');
    });

  // 2. Gather active/accepted decisions
  const activeDecisions = allRecords
    .filter(
      (r) =>
        r.frontmatter.kind === 'decision' &&
        (r.frontmatter.status === 'active' || r.frontmatter.status === 'shipped')
    )
    .sort((a, b) => (b.frontmatter.updated || '').localeCompare(a.frontmatter.updated || ''));

  // 3. Resolve active slice spec / plan / state if slug provided
  let activeSlice: BootstrapBrief['activeSlice'] = undefined;
  if (options.slug) {
    const spec = await getRecord({
      cwd: options.cwd,
      projectId,
      vaultRoot,
      kind: 'spec',
      slug: options.slug
    });
    const plan = await getRecord({
      cwd: options.cwd,
      projectId,
      vaultRoot,
      kind: 'plan',
      slug: options.slug
    });
    const state = await getRecord({
      cwd: options.cwd,
      projectId,
      vaultRoot,
      kind: 'state',
      slug: options.slug
    });

    if (spec || plan || state) {
      activeSlice = {
        slug: options.slug,
        spec: spec || undefined,
        plan: plan || undefined,
        state: state || undefined
      };
    }
  }

  // 4. Budget constraints and progressive truncation
  const budgetBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 8192;
  const currentTraps = [...activeTraps];
  const currentDecisions = [...activeDecisions];
  const notices: string[] = [];

  const initialBrief: BootstrapBrief = {
    projectId,
    gitRemote: metadata?.gitRemote || identity.normalizedRemote,
    lastSeenRoot: metadata?.lastSeenRoot || identity.rootPath,
    activeSlice,
    traps: currentTraps,
    decisions: currentDecisions,
    totalTrapsCount: activeTraps.length,
    totalDecisionsCount: activeDecisions.length,
    byteLength: 0,
    budgetBytes,
    truncated: false,
    notices
  };

  initialBrief.byteLength = calculatePayloadSize(initialBrief);

  if (initialBrief.byteLength > budgetBytes) {
    initialBrief.truncated = true;

    // Drop lower-ranked traps first
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentTraps.pop();
      initialBrief.byteLength = calculatePayloadSize(initialBrief);
    }

    // If still over budget, drop older decisions
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentDecisions.pop();
      initialBrief.byteLength = calculatePayloadSize(initialBrief);
    }

    const droppedTraps = activeTraps.length - currentTraps.length;
    const droppedDecisions = activeDecisions.length - currentDecisions.length;
    notices.push(
      `Context brief truncated to fit ${budgetBytes} byte budget (dropped ${droppedTraps} trap(s), ${droppedDecisions} decision(s)).`
    );

    initialBrief.byteLength = calculatePayloadSize(initialBrief);
  }

  return initialBrief;
}
