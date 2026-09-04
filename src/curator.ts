import * as fs from 'node:fs';
import * as path from 'node:path';
import { GcOptions, GcResult, MemoRecord, RecordFrontmatter } from './types.js';
import { getVaultRoot, ensureVaultStructure, ensureProjectVault, withVaultLock, commitVaultChange } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { parseRecord, serializeRecord } from './schema.js';
import { openIndex, indexRecord, removeRecord, rebuildIndex } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';
import { recordTombstone } from './sync.js';
import { recordTelemetry } from './telemetry.js';
import {
  isRecordExpiredAt,
  defaultTtlDaysForKind,
  resolveExpiresAtMs
} from './expiration.js';

/**
 * Check if a record has expired given its date, default TTL days, optional custom TTL, or explicit expires_at.
 */
export function isRecordExpired(
  dateStr: string,
  defaultTtlDays: number,
  customTtl?: string,
  now: number = Date.now(),
  expiresAt?: string
): boolean {
  if (expiresAt) {
    const expMs = resolveExpiresAtMs(
      { id: 'x', kind: 'trap', project: 'x', status: 'active', created: dateStr, updated: dateStr, source: 'agent', expires_at: expiresAt },
      defaultTtlDays
    );
    if (expMs !== null) return now >= expMs;
  }

  const recordTime = new Date(dateStr).getTime();
  if (isNaN(recordTime)) {
    return false;
  }

  if (customTtl) {
    const parsedDate = new Date(customTtl).getTime();
    if (!isNaN(parsedDate) && customTtl.includes('-')) {
      return now >= parsedDate;
    }

    const durMatch = customTtl.match(/^(\d+(?:\.\d+)?)\s*([dhms]|days?|hours?|mins?|minutes?|secs?|seconds?)?$/i);
    if (durMatch) {
      const num = parseFloat(durMatch[1]);
      const unit = (durMatch[2] || 'd').toLowerCase();
      let ms = num * 86400 * 1000;
      if (unit.startsWith('h')) ms = num * 3600 * 1000;
      else if (unit.startsWith('m')) ms = num * 60 * 1000;
      else if (unit.startsWith('s')) ms = num * 1000;
      else if (unit.startsWith('d')) ms = num * 86400 * 1000;
      return now - recordTime >= ms;
    }
  }

  const defaultMs = defaultTtlDays * 86400 * 1000;
  return now - recordTime >= defaultMs;
}

const EXPIRATION_SWEEP_DIRS = ['traps', 'decisions', 'plans', 'state', 'scratch', 'reviews'] as const;
const ARCHIVE_ON_EXPIRE_KINDS = new Set<RecordFrontmatter['kind']>(['trap', 'decision', 'plan']);

function sweepExpiredRecords(
  projectDir: string,
  projectId: string,
  vaultRoot: string,
  db: ReturnType<typeof openIndex>,
  options: {
    dryRun: boolean;
    purge: boolean;
    now: number;
    scratchTtlDays: number;
    reviewTtlDays: number;
  }
): {
  purgedScratchCount: number;
  purgedReviewCount: number;
  trapsArchivedCount: number;
  decisionsArchivedCount: number;
  plansArchivedCount: number;
  purgedFiles: string[];
} {
  let purgedScratchCount = 0;
  let purgedReviewCount = 0;
  let trapsArchivedCount = 0;
  let decisionsArchivedCount = 0;
  let plansArchivedCount = 0;
  const purgedFiles: string[] = [];

  for (const subdir of EXPIRATION_SWEEP_DIRS) {
    const dir = path.join(projectDir, subdir);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const record = parseRecord(content, filePath);
        const fm = record.frontmatter;
        if (fm.status === 'archived' || fm.compacted) continue;

        const defaultDays = defaultTtlDaysForKind(fm.kind, options.scratchTtlDays, options.reviewTtlDays);
        if (!isRecordExpiredAt(fm, options.now, defaultDays)) continue;

        const shouldPurge = options.purge || !ARCHIVE_ON_EXPIRE_KINDS.has(fm.kind);

        if (shouldPurge) {
          if (fm.kind === 'scratch') purgedScratchCount++;
          else if (fm.kind === 'review') purgedReviewCount++;
          purgedFiles.push(filePath);
          if (!options.dryRun) {
            recordTombstone(
              vaultRoot,
              projectId,
              fm.kind,
              fm.id,
              String(fm.slug || fm.id)
            );
            fs.unlinkSync(filePath);
            removeRecord(db, fm.id, projectId);
          }
        } else {
          if (fm.kind === 'trap') trapsArchivedCount++;
          else if (fm.kind === 'decision') decisionsArchivedCount++;
          else if (fm.kind === 'plan') plansArchivedCount++;
          purgedFiles.push(filePath);
          if (!options.dryRun) {
            const archivedFm: RecordFrontmatter = {
              ...fm,
              status: 'archived',
              archivedReason: 'expired',
              updated: new Date(options.now).toISOString()
            };
            const serialized = serializeRecord({ frontmatter: archivedFm, body: record.body });
            fs.writeFileSync(filePath, serialized, 'utf8');
            indexRecord(db, { frontmatter: archivedFm, body: record.body }, filePath);
          }
        }
      } catch {
        // skip unreadable records
      }
    }
  }

  return {
    purgedScratchCount,
    purgedReviewCount,
    trapsArchivedCount,
    decisionsArchivedCount,
    plansArchivedCount,
    purgedFiles
  };
}

/**
 * Compact a shipped plan into a concise summary record.
 */
export function compactPlanRecord(record: MemoRecord): { frontmatter: RecordFrontmatter; body: string } {
  const fm = { ...record.frontmatter };
  const title = fm.title || fm.id;
  const now = new Date().toISOString();

  fm.compacted = true;
  fm.updated = now;

  const dateCompleted = fm.updated || fm.created;
  const commitSha = fm.verifiedAtSha || (typeof fm.commit === 'string' ? fm.commit : null);
  const relatedSlug = fm.relatedSlug || fm.slug;

  let compactBody = `# Plan Summary: ${title}

- **Status:** Shipped
- **Outcome:** Delivery completed successfully
- **Completion Date:** ${dateCompleted}
`;

  if (commitSha) {
    compactBody += `- **Verified Commit / SHA:** \`${commitSha}\`\n`;
  }
  if (relatedSlug) {
    compactBody += `- **Related Slug:** \`${relatedSlug}\`\n`;
  }

  compactBody += `\n*This plan was compacted by spec-memo curator GC after shipping.*`;

  return {
    frontmatter: fm,
    body: compactBody
  };
}

/**
 * Compact individual historical log event files into monthly roll-up archives.
 */
export function compactMonthlyLogs(
  projectDir: string,
  projectId: string,
  vaultRoot: string,
  options: { dryRun?: boolean; minAgeDays?: number; now?: number } = {}
): { compactedCount: number; rollupFiles: string[]; unlinkedFiles: string[] } {
  const logsDir = path.join(projectDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    return { compactedCount: 0, rollupFiles: [], unlinkedFiles: [] };
  }

  const dryRun = Boolean(options.dryRun);
  const now = options.now ?? Date.now();
  const minAgeMs = (options.minAgeDays ?? 30) * 86400 * 1000;
  const currentMonthKey = new Date(now).toISOString().slice(0, 7); // e.g. "2026-08"

  const files = fs.readdirSync(logsDir);
  const eligibleByMonth = new Map<string, Array<{ filePath: string; record: MemoRecord }>>();
  const existingRollups = new Map<string, MemoRecord>();

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(logsDir, file);

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const record = parseRecord(content, filePath);

      if (record.frontmatter.kind !== 'log') continue;

      if (file.startsWith('log-rollup-') || record.frontmatter.compacted) {
        const match = file.match(/^log-rollup-(\d{4}-\d{2})\.md$/);
        const monthKey = match ? match[1] : (record.frontmatter.created || '').slice(0, 7);
        if (monthKey) {
          existingRollups.set(monthKey, record);
        }
        continue;
      }

      // Determine date and month
      const createdStr = record.frontmatter.created || record.frontmatter.updated || '';
      const eventTime = new Date(createdStr).getTime();
      const monthKey = createdStr ? createdStr.slice(0, 7) : '';

      if (!monthKey || isNaN(eventTime)) continue;

      // Eligible if from prior month or older than minAge
      const isPriorMonth = monthKey < currentMonthKey;
      const isOldEnough = now - eventTime >= minAgeMs;

      if (isPriorMonth || isOldEnough) {
        if (!eligibleByMonth.has(monthKey)) {
          eligibleByMonth.set(monthKey, []);
        }
        eligibleByMonth.get(monthKey)!.push({ filePath, record });
      }
    } catch {
      // Ignore unparseable log file
    }
  }

  let compactedCount = 0;
  const rollupFiles: string[] = [];
  const unlinkedFiles: string[] = [];
  const db = openIndex(vaultRoot);

  for (const [monthKey, items] of eligibleByMonth.entries()) {
    if (items.length === 0) continue;

    // Sort items chronologically
    items.sort((a, b) => {
      const ta = new Date(a.record.frontmatter.created || 0).getTime();
      const tb = new Date(b.record.frontmatter.created || 0).getTime();
      return ta - tb;
    });

    const rollupFilePath = path.join(logsDir, `log-rollup-${monthKey}.md`);
    const existing = existingRollups.get(monthKey);

    let existingBody = existing ? existing.body : '';
    if (!existingBody.trim()) {
      existingBody = `# Monthly Log Roll-up — ${monthKey}\n\nConsolidated event logs for project \`${projectId}\` (${monthKey}).\n`;
    }

    let appendSection = '';
    for (const item of items) {
      const fm = item.record.frontmatter;
      const ts = fm.created || 'unknown date';
      const eventId = fm.id;
      const source = fm.source || 'agent';

      appendSection += `\n---\n\n### Event: \`${eventId}\`\n- **Timestamp:** ${ts}\n- **Source:** ${source}\n`;
      if (fm.details && typeof fm.details === 'object') {
        appendSection += `- **Details:** \`${JSON.stringify(fm.details)}\`\n`;
      }
      appendSection += `\n${item.record.body.trim()}\n`;
    }

    const mergedBody = existingBody.trimEnd() + '\n' + appendSection;
    const earliestCreated = existing?.frontmatter.created || items[0].record.frontmatter.created || new Date(now).toISOString();

    const rollupFm: RecordFrontmatter = {
      id: `log-rollup-${monthKey}`,
      kind: 'log',
      project: projectId,
      status: 'active',
      created: earliestCreated,
      updated: new Date(now).toISOString(),
      source: 'agent',
      compacted: true,
      tags: ['rollup', 'monthly-log', monthKey]
    };

    rollupFiles.push(rollupFilePath);

    if (!dryRun) {
      const serialized = serializeRecord({ frontmatter: rollupFm, body: mergedBody });
      fs.writeFileSync(rollupFilePath, serialized, 'utf8');
      indexRecord(db, { frontmatter: rollupFm, body: mergedBody }, rollupFilePath);

      for (const item of items) {
        try {
          if (fs.existsSync(item.filePath)) {
            recordTombstone(
              vaultRoot,
              projectId,
              item.record.frontmatter.kind,
              item.record.frontmatter.id,
              String(item.record.frontmatter.slug || item.record.frontmatter.id)
            );
            fs.unlinkSync(item.filePath);
            unlinkedFiles.push(item.filePath);
            removeRecord(db, item.record.frontmatter.id, projectId);
            compactedCount++;
          }
        } catch {
          // Ignore
        }
      }
    } else {
      compactedCount += items.length;
      for (const item of items) {
        unlinkedFiles.push(item.filePath);
      }
    }
  }

  return { compactedCount, rollupFiles, unlinkedFiles };
}

/**
 * Execute curator garbage collection:
 * 1. Purge expired scratch records (TTL default 7 days).
 * 2. Purge stale review artifacts (TTL default 14 days).
 * 3. Compact shipped plan records into summary artifacts.
 * 4. Compact historical log event records into monthly roll-up archives.
 * 5. Update SQLite FTS index and rebuild compiled views.
 */
export async function runGc(options: GcOptions = {}): Promise<GcResult> {
  const started = performance.now();
  const vaultRoot = options.vaultRoot || getVaultRoot();
  let projectId: string | undefined;
  let succeeded = false;
  let errorCode: string | undefined;

  try {
    const result = await withVaultLock(vaultRoot, async () => {
      const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
      projectId = options.projectId || identity.projectId;
      const dryRun = Boolean(options.dryRun);

      const config = ensureVaultStructure(vaultRoot);
      ensureProjectVault(identity, vaultRoot);

  const scratchTtlDays = config.ttl?.scratchDays ?? 7;
  const reviewTtlDays = config.ttl?.reviewDays ?? 14;
  const purge = Boolean(options.purge);

  const projectDir = path.join(vaultRoot, 'projects', projectId);
  const purgedFiles: string[] = [];
  const compactedPlans: string[] = [];
  let compactedPlansCount = 0;

  const db = openIndex(vaultRoot);
  const now = options.now ?? Date.now();

  const sweep = sweepExpiredRecords(projectDir, projectId, vaultRoot, db, {
    dryRun,
    purge,
    now,
    scratchTtlDays,
    reviewTtlDays
  });
  let purgedScratchCount = sweep.purgedScratchCount;
  let purgedReviewCount = sweep.purgedReviewCount;
  const trapsArchivedCount = sweep.trapsArchivedCount;
  const decisionsArchivedCount = sweep.decisionsArchivedCount;
  const plansArchivedCount = sweep.plansArchivedCount;
  purgedFiles.push(...sweep.purgedFiles);
  const plansDir = path.join(projectDir, 'plans');
  if (fs.existsSync(plansDir)) {
    const files = fs.readdirSync(plansDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(plansDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const record = parseRecord(content, filePath);
          if (
            record.frontmatter.kind === 'plan' &&
            record.frontmatter.status === 'shipped' &&
            !record.frontmatter.compacted
          ) {
            compactedPlansCount++;
            compactedPlans.push(filePath);
            if (!dryRun) {
              const compacted = compactPlanRecord(record);
              const serialized = serializeRecord(compacted);
              fs.writeFileSync(filePath, serialized, 'utf8');
              indexRecord(db, compacted, filePath);
            }
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  // 4. Compact historical monthly logs
  const logCompaction = compactMonthlyLogs(projectDir, projectId, vaultRoot, { dryRun, now });
  const compactedLogsCount = logCompaction.compactedCount;

  // 5. Update index and compiled views
  let rebuiltFts = false;
  if (!dryRun) {
    rebuildCompiledViews(projectId, vaultRoot);
    await rebuildIndex(vaultRoot);
    rebuiltFts = true;
    commitVaultChange(`gc ${projectId}`, vaultRoot, [path.join('projects', projectId)]);
  }

    return {
      projectId,
      purgedScratchCount,
      purgedReviewCount,
      trapsArchivedCount,
      decisionsArchivedCount,
      plansArchivedCount,
      compactedPlansCount,
      compactedLogsCount,
      rebuiltFts,
      rebuiltViews: !dryRun,
      dryRun,
      details: {
        purgedFiles,
        compactedPlans,
        compactedLogs: logCompaction.unlinkedFiles
      }
    };
    });
    succeeded = true;
    return result;
  } catch (err: unknown) {
    errorCode = err instanceof Error ? err.name : 'GC_FAILED';
    throw err;
  } finally {
    const durationMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
    recordTelemetry({
      category: 'curator_gc',
      operation: 'memo_gc',
      durationMs,
      success: succeeded,
      errorCode,
      projectId,
      vaultRoot,
      metadata: { dryRun: Boolean(options.dryRun) }
    });
  }
}
