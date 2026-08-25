import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * AC1-AC4: Detect code-specification drift by comparing verifiedAtSha with current git SHA of linkedPaths.
 */
export function checkSpecDrift(
  spec: MemoRecord,
  productRoot: string,
  isGit: boolean
): { specSlug: string; modifiedPaths: string[] } | null {
  const linkedPaths = spec.frontmatter.linkedPaths;
  const verifiedAtSha = spec.frontmatter.verifiedAtSha;
  if (!Array.isArray(linkedPaths) || linkedPaths.length === 0 || !verifiedAtSha) {
    return null;
  }

  const specSlug = String(spec.frontmatter.slug || spec.frontmatter.id || 'unknown');
  const modifiedPaths: string[] = [];

  for (const relPath of linkedPaths) {
    const fullPath = path.resolve(productRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      modifiedPaths.push(relPath);
      continue;
    }

    if (isGit) {
      try {
        const statusOutput = execFileSync('git', ['status', '--porcelain', '--', relPath], {
          cwd: productRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        let diverged = statusOutput.length > 0;
        if (!diverged) {
          try {
            const atVerify = execFileSync('git', ['show', `${verifiedAtSha}:${relPath.replace(/\\/g, '/')}`], {
              cwd: productRoot,
              stdio: ['ignore', 'pipe', 'ignore']
            }) as Buffer;
            const current = fs.readFileSync(fullPath);
            diverged = Buffer.compare(Buffer.from(atVerify), current) !== 0;
          } catch {
            // Missing blob at verified SHA, or git show failed: treat as drift
            diverged = true;
          }
        }

        if (diverged) {
          modifiedPaths.push(relPath);
        }
      } catch {
        // If git fails, fallback to assumption of safe
      }
    }
  }

  if (modifiedPaths.length > 0) {
    return { specSlug, modifiedPaths };
  }

  return null;
}

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

  // 3b. Scan for spec drift across all active specs
  const driftList: Array<{ specSlug: string; modifiedPaths: string[] }> = [];
  const activeSpecs = allRecords.filter((r) => r.frontmatter.kind === 'spec' && r.frontmatter.status === 'active');
  for (const s of activeSpecs) {
    const driftResult = checkSpecDrift(s, identity.rootPath, identity.isGit);
    if (driftResult) {
      driftList.push(driftResult);
    }
  }

  // 4. Budget constraints and progressive truncation
  const budgetBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : 8192;
  const currentTraps = [...activeTraps];
  const currentDecisions = [...activeDecisions];
  const notices: string[] = [];

  if (driftList.length > 0) {
    for (const d of driftList) {
      notices.push(`Spec drift detected for '${d.specSlug}': modified linked paths [${d.modifiedPaths.join(', ')}]`);
    }
  }

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
    drift: driftList.length > 0 ? driftList : undefined,
    notices
  };

  initialBrief.byteLength = calculatePayloadSize(initialBrief);

  if (initialBrief.byteLength > budgetBytes) {
    initialBrief.truncated = true;

    // Drop lower-ranked traps first
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentTraps.pop();
    }

    // If still over budget, drop older decisions
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentDecisions.pop();
    }

    // Then trim activeSlice (state → plan → spec) so the byte cap is fail-closed
    while (calculatePayloadSize(initialBrief) > budgetBytes && initialBrief.activeSlice) {
      const slice = initialBrief.activeSlice;
      if (slice.state) {
        delete slice.state;
        continue;
      }
      if (slice.plan) {
        delete slice.plan;
        continue;
      }
      if (slice.spec) {
        delete slice.spec;
        continue;
      }
      initialBrief.activeSlice = undefined;
    }

    if (initialBrief.drift) {
      while (initialBrief.drift.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
        initialBrief.drift.pop();
      }
      if (initialBrief.drift.length === 0) {
        initialBrief.drift = undefined;
      }
    }

    const droppedTraps = activeTraps.length - currentTraps.length;
    const droppedDecisions = activeDecisions.length - currentDecisions.length;
    notices.push(
      `Context brief truncated to fit ${budgetBytes} byte budget (dropped ${droppedTraps} trap(s), ${droppedDecisions} decision(s)).`
    );

    if (calculatePayloadSize(initialBrief) > budgetBytes) {
      initialBrief.traps = [];
      initialBrief.decisions = [];
      initialBrief.activeSlice = undefined;
      initialBrief.drift = undefined;
      while (calculatePayloadSize(initialBrief) > budgetBytes && notices.length > 1) {
        notices.pop();
      }
    }

    initialBrief.byteLength = calculatePayloadSize(initialBrief);
  }

  return initialBrief;
}
