import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  BootstrapBrief,
  BootstrapOptions,
  BootstrapTaskLens,
  MemoRecord,
  BootstrapBudgetReport,
  BudgetCandidateReport,
  SessionResume
} from './types.js';
import { getProjectMetadata, getVaultRoot, ensureVaultStructure, ensureProjectVault, withVaultLockSync } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { scanProjectRecords } from './compiler.js';
import { getRecord } from './store.js';
import { matchesAnyPattern } from './indexer.js';
import { isPathIgnored, resolveCaptureProductRoot } from './capture-ignore.js';
import { pullHybridProject } from './hybrid-sync.js';
import { cloneRecordWithStaleBadge } from './salience.js';
import { roundExplain } from './ranking-explain.js';
import { isRecordExpiredAt, defaultTtlDaysForKind } from './expiration.js';
import {
  claimHandoff,
  getSessionObjective,
  peekEligibleHandoff,
  renderHandoffMarkdown,
  rollbackHandoffClaim
} from './handoff.js';
import { HandoffRecord, SessionObjective } from './types.js';
import { hitCountOf } from './recurrence.js';
import { inspectAgentIo, IO_GUARD_NOTICE, IO_GUARD_QUERY_DROPPED_NOTICE } from './io-guard.js';
import type { VaultAiAgent } from './ai/types.js';
import { rankRecordsWithAgent } from './ai/rank.js';
import {
  inferTaskLens,
  releaseDecisionScore,
  releaseLensNotice,
  taskLensDecisionMultiplier,
  taskLensTrapMultiplier
} from './retrieval-lens.js';

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
export function scoreTrap(
  trap: MemoRecord,
  query?: string,
  pathFilter?: string,
  taskLens: BootstrapTaskLens = 'general'
): number {
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

  if (query && taskLens !== 'general') {
    score *= taskLensTrapMultiplier(taskLens);
  }

  return score;
}

function scoreDecisionForBootstrap(
  decision: MemoRecord,
  index: number,
  total: number,
  query?: string,
  taskLens: BootstrapTaskLens = 'general'
): number {
  let score =
    taskLens === 'release'
      ? releaseDecisionScore(decision)
      : decisionBootstrapScore(decision, index, total);
  if (query && taskLens !== 'general') {
    score *= taskLensDecisionMultiplier(taskLens);
  }
  return score;
}

function compareContinuationTraps(
  a: MemoRecord,
  b: MemoRecord,
  query?: string,
  pathFilter?: string
): number {
  const hitsDiff = hitCountOf(b.frontmatter) - hitCountOf(a.frontmatter);
  if (hitsDiff !== 0) return hitsDiff;
  const sevA = SEVERITY_WEIGHT[String(a.frontmatter.severity || 'medium')] || 200;
  const sevB = SEVERITY_WEIGHT[String(b.frontmatter.severity || 'medium')] || 200;
  if (sevB !== sevA) return sevB - sevA;
  return scoreTrap(b, query, pathFilter) - scoreTrap(a, query, pathFilter);
}

function findLatestSessionResume(records: MemoRecord[]): SessionResume | undefined {
  const sessions = records
    .filter((r) => r.frontmatter.kind === 'session')
    .sort((a, b) => String(b.frontmatter.updated || '').localeCompare(String(a.frontmatter.updated || '')));

  for (const session of sessions) {
    const summary = typeof session.frontmatter.summary === 'string' ? session.frontmatter.summary.trim() : '';
    const body = String(session.body || '').trim();
    if (!summary && !body) continue;
    return {
      id: String(session.frontmatter.id),
      sessionId:
        typeof session.frontmatter.sessionId === 'string' ? session.frontmatter.sessionId : undefined,
      summary: summary || undefined,
      body: body || undefined,
      updated: typeof session.frontmatter.updated === 'string' ? session.frontmatter.updated : undefined
    };
  }
  return undefined;
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
  reviewTtlDays = 14,
  taskLens: BootstrapTaskLens = 'general',
  includeExplainFields = false
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
      score: roundExplain(scoreTrap(trap, options.query, pathFilter, taskLens)),
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

  const report: BootstrapBudgetReport = {
    budgetBytes,
    consumedBytes,
    remainingBytes: Math.max(0, budgetBytes - consumedBytes),
    includedCount: includedIds.size,
    candidates
  };

  if (includeExplainFields) {
    report.taskLens = taskLens;
    report.omittedIds = candidates
      .filter((c) => c.status === 'truncated_budget_exhausted')
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        reason: 'truncated_budget_exhausted' as const
      }));
  }

  return report;
}

export function formatBootstrapBudgetTable(report: BootstrapBudgetReport): string {
  const header = [
    'Bootstrap budget allocation',
    `Budget: ${report.budgetBytes} bytes | Consumed: ${report.consumedBytes} | Remaining: ${report.remainingBytes} | Included: ${report.includedCount}`,
    '',
    'ID'.padEnd(28) + 'Kind'.padEnd(10) + 'Score'.padStart(8) + 'Bytes'.padStart(8) + '  Status',
    '-'.repeat(72)
  ];
  const omittedRows =
    report.omittedIds && report.omittedIds.length > 0
      ? [
          '',
          'Omitted (truncated_budget_exhausted):',
          ...report.omittedIds.map((o) => `  ${o.id} (${o.kind})`)
        ]
      : [];

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
  return [...header, ...rows, ...omittedRows].join('\n');
}

/**
 * Optional AI rerank inputs for bootstrap (spec 0056, AC5/AC23).
 * When `agent` is provided it overrides config construction for this call.
 */
export interface BootstrapAi {
  agent?: VaultAiAgent | null;
  rankTopK?: number;
  timeoutMs?: number;
}

/**
 * Compile a token-budgeted session brief for AI agents at session bootstrap.
 */
export async function compileBootstrapBrief(
  options: BootstrapOptions = {},
  ai: BootstrapAi = {}
): Promise<BootstrapBrief> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  ensureProjectVault(identity, vaultRoot);
  const projectId = options.projectId || identity.projectId;
  const projectDir = path.join(vaultRoot, 'projects', projectId);

  const notices: string[] = [];

  // Spec 0059 inbound queries (drop-not-fail, AC11): a query matching the
  // override table compiles as if omitted; the read path stays available.
  const rawQuery = typeof options.query === 'string' ? options.query : undefined;
  const queryDropped =
    rawQuery !== undefined && rawQuery.trim().length > 0 && !inspectAgentIo(rawQuery).ok;
  const briefQuery = queryDropped ? undefined : rawQuery;
  if (queryDropped) {
    notices.push(IO_GUARD_QUERY_DROPPED_NOTICE);
  }

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
  const cwd = options.cwd || process.cwd();

  // Handoff delivery (AC7-AC11): peek before budget pass; claim only after brief fits
  let handoffCandidate: HandoffRecord | null = null;
  let handoffMarkdown: string | undefined;
  let sessionObjective: SessionObjective | undefined;
  try {
    sessionObjective = getSessionObjective({ projectDir, cwd }) || undefined;
    handoffCandidate = peekEligibleHandoff({ projectDir, cwd });
    if (handoffCandidate) {
      handoffMarkdown = renderHandoffMarkdown(handoffCandidate);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    notices.push(`Handoff delivery warning: ${msg}`);
  }

  const captureRoot = resolveCaptureProductRoot({ cwd: options.cwd, projectId, vaultRoot });
  const pathFilter =
    options.path && !isPathIgnored(options.path, captureRoot, { projectId, vaultRoot })
      ? options.path
      : undefined;

  const scratchTtlDays = config.ttl?.scratchDays ?? 7;
  const reviewTtlDays = config.ttl?.reviewDays ?? 14;
  const taskLens = inferTaskLens(briefQuery);
  const continuation = options.continuation === true;

  if (taskLens === 'release') {
    notices.push(releaseLensNotice());
  }

  // 1. Gather & rank traps (all for explain report; active non-expired for brief)
  const allTrapsForReport = allRecords.filter((r) => r.frontmatter.kind === 'trap');
  let activeTraps = allTrapsForReport
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
      const scoreA = scoreTrap(a, briefQuery, pathFilter, taskLens);
      const scoreB = scoreTrap(b, briefQuery, pathFilter, taskLens);
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return (b.frontmatter.updated || '').localeCompare(a.frontmatter.updated || '');
    });

  if (continuation) {
    activeTraps = [...activeTraps]
      .sort((a, b) => compareContinuationTraps(a, b, briefQuery, pathFilter))
      .slice(0, 3);
  }

  // 2. Gather decisions (all for explain report; active/shipped for brief)
  const allDecisionsForReport = allRecords.filter((r) => r.frontmatter.kind === 'decision');
  let activeDecisions = allDecisionsForReport
    .filter(
      (r) =>
        (r.frontmatter.status === 'active' || r.frontmatter.status === 'shipped') &&
        !isRecordExpiredAt(
          r.frontmatter,
          Date.now(),
          defaultTtlDaysForKind('decision', scratchTtlDays, reviewTtlDays)
        )
    )
    .map((record, index, arr) => ({ record, index, total: arr.length }))
    .sort((a, b) => {
      const scoreA = scoreDecisionForBootstrap(a.record, a.index, a.total, briefQuery, taskLens);
      const scoreB = scoreDecisionForBootstrap(b.record, b.index, b.total, briefQuery, taskLens);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return String(b.record.frontmatter.updated || '').localeCompare(
        String(a.record.frontmatter.updated || '')
      );
    })
    .map((entry) => entry.record);

  const sessionResume = continuation ? findLatestSessionResume(allRecords) : undefined;

  // Spec 0056 AC23: same post-lexical rank helper on trap/decision candidates
  // when the query is non-empty and AI is available. Empty query skips rank
  // (no extra LLM call). Rank only reorders — it cannot expand past budget.
  if (ai.agent && ai.agent.isAvailable() && (briefQuery || '').trim().length > 0) {
    const rankTopK = ai.rankTopK && ai.rankTopK > 0 ? ai.rankTopK : 20;
    const toCandidate = (r: MemoRecord): { id: string; kind: string; title: string; snippet: string } => ({
      id: String(r.frontmatter.id),
      kind: String(r.frontmatter.kind),
      title: String(r.frontmatter.title || r.frontmatter.id),
      snippet: String(r.body || '').slice(0, 300)
    });
    try {
      const rankedTraps = await rankRecordsWithAgent({
        agent: ai.agent,
        query: briefQuery,
        items: activeTraps,
        toCandidate,
        rankTopK,
        timeoutMs: ai.timeoutMs,
        projectId,
        vaultRoot
      });
      activeTraps = rankedTraps.items;
      const rankedDecisions = await rankRecordsWithAgent({
        agent: ai.agent,
        query: briefQuery,
        items: activeDecisions,
        toCandidate,
        rankTopK,
        timeoutMs: ai.timeoutMs,
        projectId,
        vaultRoot
      });
      activeDecisions = rankedDecisions.items;
    } catch {
      // Fail-open: keep the lexical order.
    }
  }

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

  // Spec 0059 outbound (always wrap): every brief with any trap/decision
  // body carries the stable untrusted-data notice (AC7 in Description).
  {
    const hasBody = [...currentTraps, ...currentDecisions].some(
      (r) => typeof r.body === 'string' && r.body.trim().length > 0
    );
    if (hasBody && !notices.includes(IO_GUARD_NOTICE)) {
      notices.push(IO_GUARD_NOTICE);
    }
  }

  const initialBrief: BootstrapBrief = {
    projectId,
    gitRemote: metadata?.gitRemote || identity.normalizedRemote,
    lastSeenRoot: identity.rootPath,
    handoffMarkdown,
    sessionObjective,
    activeSlice,
    traps: currentTraps,
    decisions: currentDecisions,
    totalTrapsCount: activeTraps.length,
    totalDecisionsCount: activeDecisions.length,
    byteLength: 0,
    budgetBytes,
    truncated: false,
    drift: driftList.length > 0 ? driftList : undefined,
    notices,
    ...(sessionResume ? { sessionResume } : {})
  };

  initialBrief.byteLength = calculatePayloadSize(initialBrief);

  const finalizeBrief = (brief: BootstrapBrief): BootstrapBrief => {
    if (!handoffCandidate || !handoffMarkdown) {
      brief.byteLength = calculatePayloadSize(brief);
      return brief;
    }
    const deliverable: BootstrapBrief = {
      ...brief,
      handoffMarkdown,
      sessionObjective: brief.sessionObjective ?? sessionObjective
    };
    // Pre-claim estimate includes the unclaimed candidate so the claim
    // itself cannot push a fitted brief over budget without a re-check.
    const preClaim: BootstrapBrief = {
      ...deliverable,
      handoff: handoffCandidate
    };
    const mustShedObject = calculatePayloadSize(preClaim) > budgetBytes;
    // When even the markdown alone cannot fit, deliver nothing and leave
    // the handoff pending (no claim) for a larger-budget session — a
    // claimed-but-undelivered handoff would be lost (never redelivered).
    if (calculatePayloadSize(deliverable) > budgetBytes) {
      delete brief.handoff;
      delete brief.handoffMarkdown;
      brief.byteLength = calculatePayloadSize(brief);
      return brief;
    }
    if (mustShedObject) {
      // The object cannot fit but the markdown can: deliver markdown only
      // WITHOUT claiming, so the handoff stays pending. Redelivery across
      // tight-budget sessions beats loss; a roomy session claims it later.
      deliverable.byteLength = calculatePayloadSize(deliverable);
      return deliverable;
    }
    try {
      deliverable.handoff = withVaultLockSync(vaultRoot, () =>
        claimHandoff({
          projectDir,
          record: handoffCandidate!,
          claimedBySession: options.sessionId,
          vaultRoot,
          projectId
        })
      );
      deliverable.byteLength = calculatePayloadSize(deliverable);
      // The claim stamps claimedAt/claimedBySession bytes; shed the object
      // first (keeping the markdown content), then the markdown, so a
      // fitted brief never returns over budget. (mustShedObject already
      // returned early, so this only handles stamp overflow.)
      if (deliverable.byteLength > budgetBytes) {
        delete deliverable.handoff;
        deliverable.byteLength = calculatePayloadSize(deliverable);
      }
      if (deliverable.byteLength > budgetBytes) {
        // Full shed after a claim: roll the claim back so the handoff
        // stays pending instead of being marked consumed but undelivered.
        rollbackHandoffClaim(projectDir, handoffCandidate.id);
        delete deliverable.handoffMarkdown;
        deliverable.byteLength = calculatePayloadSize(deliverable);
      }
      return deliverable;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notices.push(`Handoff claim warning: ${msg}`);
      delete brief.handoff;
      delete brief.handoffMarkdown;
      brief.byteLength = calculatePayloadSize(brief);
      return brief;
    }
  };

  // Reserve immutable handoff/objective bytes before trap/decision trimming (AC10)
  const immutableReserve =
    (handoffMarkdown ? Buffer.byteLength(handoffMarkdown, 'utf8') : 0) +
    (sessionObjective ? Buffer.byteLength(JSON.stringify(sessionObjective), 'utf8') : 0) +
    (handoffCandidate ? Buffer.byteLength(JSON.stringify(handoffCandidate), 'utf8') : 0) +
    64;
  const effectiveBudget = Math.max(512, budgetBytes - immutableReserve);

  const dropContinuationOverflow = (): void => {
    if (!continuation) return;
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentTraps.pop();
    }
    if (initialBrief.sessionResume && calculatePayloadSize(initialBrief) > effectiveBudget) {
      delete initialBrief.sessionResume;
    }
  };

  if (initialBrief.byteLength > effectiveBudget) {
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentTraps.pop();
    }
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentDecisions.pop();
    }
    dropContinuationOverflow();
  }

  if (initialBrief.byteLength > budgetBytes) {
    initialBrief.truncated = true;

    // Add placeholder notice so its size is included during progressive trimming
    notices.push(`Context brief truncated to fit ${budgetBytes} byte budget.`);

    // Drop lower-ranked traps first
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentTraps.pop();
    }

    // If still over budget, drop older decisions
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentDecisions.pop();
    }
    dropContinuationOverflow();

    // Then trim activeSlice (state → plan → spec) so the byte cap is fail-closed
    while (calculatePayloadSize(initialBrief) > effectiveBudget && initialBrief.activeSlice) {
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
      while (initialBrief.drift.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
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
    while (currentTraps.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
      currentTraps.pop();
    }
    while (currentDecisions.length > 0 && calculatePayloadSize(initialBrief) > effectiveBudget) {
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
        handoffMarkdown,
        sessionObjective,
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
          { ...options, query: briefQuery },
          pathFilter,
          scratchTtlDays,
          reviewTtlDays,
          taskLens,
          true
        );
      }
      return finalizeBrief(minimal);
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
      { ...options, query: briefQuery },
      pathFilter,
      scratchTtlDays,
      reviewTtlDays,
      taskLens,
      true
    );
  }

  return finalizeBrief(initialBrief);
}
