import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BootstrapBrief, BootstrapOptions, MemoRecord, BootstrapBudgetReport, BudgetCandidateReport } from './types.js';
import { getProjectMetadata, getVaultRoot, ensureVaultStructure, ensureProjectVault } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { scanProjectRecords } from './compiler.js';
import { getRecord } from './store.js';
import { matchesAnyPattern } from './indexer.js';
import { isPathIgnored, resolveCaptureProductRoot } from './capture-ignore.js';
import { pullHybridProject } from './hybrid-sync.js';
import { cloneRecordWithStaleBadge } from './salience.js';
import { roundExplain } from './ranking-explain.js';
import { isRecordExpiredAt, defaultTtlDaysForKind } from './expiration.js';

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

  const specSlug = String(spec.frontmatter.id || spec.frontmatter.slug || 'unknown');
  const modifiedPaths: string[] = [];

  for (const relPath of linkedPaths) {
    const fullPath = path.resolve(productRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      modifiedPaths.push(relPath);
      continue;
    }

    if (isGit) {
      try {
        const gitPath = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
        const statusOutput = execFileSync('git', ['status', '--porcelain', '--', gitPath], {
          cwd: productRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();

        let diverged = statusOutput.length > 0;
        if (!diverged) {
          try {
            const atVerify = execFileSync('git', ['show', `${verifiedAtSha}:${gitPath}`], {
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

function recordByteWeight(record: MemoRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function decisionBootstrapScore(decision: MemoRecord, index: number, total: number): number {
  const updatedMs = Date.parse(String(decision.frontmatter.updated || '')) || 0;
  return roundExplain(updatedMs / 1000 + (total - index) * 0.001);
}

function buildBudgetReport(
  allTraps: MemoRecord[],
  includedTraps: MemoRecord[],
  allDecisions: MemoRecord[],
  includedDecisions: MemoRecord[],
  budgetBytes: number,
  consumedBytes: number,
  options: BootstrapOptions,
  pathFilter?: string,
  scratchTtlDays = 7,
  reviewTtlDays = 14
): BootstrapBudgetReport {
  const includedIds = new Set([
    ...includedTraps.map((r) => String(r.frontmatter.id)),
    ...includedDecisions.map((r) => String(r.frontmatter.id))
  ]);

  const candidates: BudgetCandidateReport[] = [];

  for (const trap of allTraps) {
    const id = String(trap.frontmatter.id);
    const status = trap.frontmatter.status !== 'active'
      ? 'excluded_expired'
      : isRecordExpiredAt(
            trap.frontmatter,
            Date.now(),
            defaultTtlDaysForKind('trap', scratchTtlDays, reviewTtlDays)
          )
        ? 'excluded_expired'
      : includedIds.has(id)
        ? 'included'
        : 'truncated_budget_exhausted';
    candidates.push({
      id,
      kind: 'trap',
      title: typeof trap.frontmatter.title === 'string' ? trap.frontmatter.title : undefined,
      score: roundExplain(scoreTrap(trap, options.query, pathFilter)),
      byteWeight: recordByteWeight(trap),
      status
    });
  }

  for (let i = 0; i < allDecisions.length; i++) {
    const decision = allDecisions[i];
    const id = String(decision.frontmatter.id);
    const status =
      decision.frontmatter.status !== 'active' && decision.frontmatter.status !== 'shipped'
        ? 'excluded_expired'
        : isRecordExpiredAt(
              decision.frontmatter,
              Date.now(),
              defaultTtlDaysForKind('decision', scratchTtlDays, reviewTtlDays)
            )
          ? 'excluded_expired'
        : includedIds.has(id)
          ? 'included'
          : 'truncated_budget_exhausted';
    candidates.push({
      id,
      kind: 'decision',
      title: typeof decision.frontmatter.title === 'string' ? decision.frontmatter.title : undefined,
      score: decisionBootstrapScore(decision, i, allDecisions.length),
      byteWeight: recordByteWeight(decision),
      status
    });
  }

  return {
    budgetBytes,
    consumedBytes,
    remainingBytes: Math.max(0, budgetBytes - consumedBytes),
    includedCount: includedIds.size,
    candidates
  };
}

export function formatBootstrapBudgetTable(report: BootstrapBudgetReport): string {
  const header = [
    'Bootstrap budget allocation',
    `Budget: ${report.budgetBytes} bytes | Consumed: ${report.consumedBytes} | Remaining: ${report.remainingBytes} | Included: ${report.includedCount}`,
    '',
    'ID'.padEnd(28) + 'Kind'.padEnd(10) + 'Score'.padStart(8) + 'Bytes'.padStart(8) + '  Status',
    '-'.repeat(72)
  ];
  const rows = report.candidates.map((c) => {
    const title = c.title ? ` (${c.title.slice(0, 24)})` : '';
    return (
      (c.id + title).slice(0, 28).padEnd(28) +
      c.kind.padEnd(10) +
      String(c.score).padStart(8) +
      String(c.byteWeight).padStart(8) +
      '  ' +
      c.status
    );
  });
  return [...header, ...rows].join('\n');
}

/**
 * Compile a token-budgeted session brief for AI agents at session bootstrap.
 */
export async function compileBootstrapBrief(options: BootstrapOptions = {}): Promise<BootstrapBrief> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  ensureProjectVault(identity, vaultRoot);
  const projectId = options.projectId || identity.projectId;
  const projectDir = path.join(vaultRoot, 'projects', projectId);

  const notices: string[] = [];

  // Best-effort hybrid pull prior to compiling brief (AC19)
  const config = ensureVaultStructure(vaultRoot);
  if (config.mode === 'hybrid') {
    try {
      await pullHybridProject(vaultRoot, projectId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notices.push(`Hybrid sync pull notice for '${projectId}': ${msg}`);
    }
  }

  const metadata = getProjectMetadata(projectId, vaultRoot);
  const allRecords = scanProjectRecords(projectDir);
  const captureRoot = resolveCaptureProductRoot({ cwd: options.cwd, projectId, vaultRoot });
  const pathFilter =
    options.path && !isPathIgnored(options.path, captureRoot, { projectId, vaultRoot })
      ? options.path
      : undefined;

  const scratchTtlDays = config.ttl?.scratchDays ?? 7;
  const reviewTtlDays = config.ttl?.reviewDays ?? 14;

  // 1. Gather & rank traps (all for explain report; active non-expired for brief)
  const allTrapsForReport = allRecords.filter((r) => r.frontmatter.kind === 'trap');
  const activeTraps = allTrapsForReport
    .filter(
      (r) =>
        r.frontmatter.status === 'active' &&
        !isRecordExpiredAt(
          r.frontmatter,
          Date.now(),
          defaultTtlDaysForKind('trap', scratchTtlDays, reviewTtlDays)
        )
    )
    .sort((a, b) => {
      const scoreA = scoreTrap(a, options.query, pathFilter);
      const scoreB = scoreTrap(b, options.query, pathFilter);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return (b.frontmatter.updated || '').localeCompare(a.frontmatter.updated || '');
    });

  // 2. Gather decisions (all for explain report; active/shipped for brief)
  const allDecisionsForReport = allRecords.filter((r) => r.frontmatter.kind === 'decision');
  const activeDecisions = allDecisionsForReport
    .filter(
      (r) =>
        (r.frontmatter.status === 'active' || r.frontmatter.status === 'shipped') &&
        !isRecordExpiredAt(
          r.frontmatter,
          Date.now(),
          defaultTtlDaysForKind('decision', scratchTtlDays, reviewTtlDays)
        )
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
        spec: spec ? cloneRecordWithStaleBadge(spec) : undefined,
        plan: plan ? cloneRecordWithStaleBadge(plan) : undefined,
        state: state ? cloneRecordWithStaleBadge(state) : undefined
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
  // Precedence: per-call maxBytes > vault config.bootstrap.maxBytes > 8192
  const configuredBudget = config.bootstrap?.maxBytes;
  const budgetBytes =
    options.maxBytes && options.maxBytes > 0
      ? options.maxBytes
      : configuredBudget && configuredBudget > 0
        ? configuredBudget
        : 8192;
  const currentTraps = activeTraps.map(cloneRecordWithStaleBadge);
  const currentDecisions = activeDecisions.map(cloneRecordWithStaleBadge);

  if (driftList.length > 0) {
    for (const d of driftList) {
      notices.push(`Spec drift detected for '${d.specSlug}': modified linked paths [${d.modifiedPaths.join(', ')}]`);
    }
  }

  const initialBrief: BootstrapBrief = {
    projectId,
    gitRemote: metadata?.gitRemote || identity.normalizedRemote,
    lastSeenRoot: identity.rootPath,
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

    // Add placeholder notice so its size is included during progressive trimming
    notices.push(`Context brief truncated to fit ${budgetBytes} byte budget.`);

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
    notices[notices.length - 1] =
      `Context brief truncated to fit ${budgetBytes} byte budget (dropped ${droppedTraps} trap(s), ${droppedDecisions} decision(s)).`;

    // If updating the notice message slightly increased payload size, trim one more item if needed
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentTraps.pop();
    }
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > budgetBytes) {
      currentDecisions.pop();
    }

    if (calculatePayloadSize(initialBrief) > budgetBytes) {
      initialBrief.traps = [];
      initialBrief.decisions = [];
      initialBrief.activeSlice = undefined;
      initialBrief.drift = undefined;
    }

    while (calculatePayloadSize(initialBrief) > budgetBytes && notices.length > 0) {
      notices.shift();
    }
    if (notices.length === 0 && initialBrief.truncated) {
      notices.push(`Brief truncated to fit ${budgetBytes} byte budget.`);
    }
    if (calculatePayloadSize(initialBrief) > budgetBytes) {
      notices.length = 0;
    }

    if (calculatePayloadSize(initialBrief) > budgetBytes) {
      initialBrief.lastSeenRoot = undefined;
      initialBrief.gitRemote = undefined;
    }

    if (calculatePayloadSize(initialBrief) > budgetBytes) {
      const minimal: BootstrapBrief = {
        projectId: initialBrief.projectId,
        traps: [],
        decisions: [],
        totalTrapsCount: initialBrief.totalTrapsCount,
        totalDecisionsCount: initialBrief.totalDecisionsCount,
        byteLength: 0,
        budgetBytes,
        truncated: true,
        notices: [`Brief truncated to fit ${budgetBytes} byte budget.`]
      };
      minimal.byteLength = calculatePayloadSize(minimal);
      if (minimal.byteLength > budgetBytes) {
        minimal.notices = [];
        minimal.byteLength = calculatePayloadSize(minimal);
      }
      if (options.explain) {
        minimal.budgetReport = buildBudgetReport(
          allTrapsForReport,
          [],
          allDecisionsForReport,
          [],
          budgetBytes,
          minimal.byteLength,
          options,
          pathFilter,
          scratchTtlDays,
          reviewTtlDays
        );
      }
      return minimal;
    }

    initialBrief.byteLength = calculatePayloadSize(initialBrief);
  }

  if (options.explain) {
    // budgetReport is diagnostic metadata outside the token-budgeted brief payload (AC6–AC8).
    // byteLength reflects only agent-facing brief fields, not explain diagnostics.
    initialBrief.budgetReport = buildBudgetReport(
      allTrapsForReport,
      currentTraps,
      allDecisionsForReport,
      currentDecisions,
      budgetBytes,
      initialBrief.byteLength,
      options,
      pathFilter,
      scratchTtlDays,
      reviewTtlDays
    );
  }

  return initialBrief;
}
