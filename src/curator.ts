import * as fs from 'node:fs';
import * as path from 'node:path';
import { GcOptions, GcResult, MemoRecord, RecordFrontmatter } from './types.js';
import { getVaultRoot, ensureVaultStructure, ensureProjectVault, withVaultLock, commitVaultChange } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { parseRecord, serializeRecord } from './schema.js';
import { openIndex, indexRecord, removeRecord, rebuildIndex } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';

/**
 * Check if a record has expired given its date, default TTL days, and optional custom TTL.
 */
export function isRecordExpired(
  dateStr: string,
  defaultTtlDays: number,
  customTtl?: string,
  now: number = Date.now()
): boolean {
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
 * Execute curator garbage collection:
 * 1. Purge expired scratch records (TTL default 7 days).
 * 2. Purge stale review artifacts (TTL default 14 days).
 * 3. Compact shipped plan records into summary artifacts.
 * 4. Update SQLite FTS index and rebuild compiled views.
 */
export async function runGc(options: GcOptions = {}): Promise<GcResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;
  const dryRun = Boolean(options.dryRun);

  const config = ensureVaultStructure(vaultRoot);
  ensureProjectVault(identity, vaultRoot);

  const scratchTtlDays = config.ttl?.scratchDays ?? 7;
  const reviewTtlDays = config.ttl?.reviewDays ?? 14;

  const projectDir = path.join(vaultRoot, 'projects', projectId);
  const purgedFiles: string[] = [];
  const compactedPlans: string[] = [];
  let purgedScratchCount = 0;
  let purgedReviewCount = 0;
  let compactedPlansCount = 0;

  const db = openIndex(vaultRoot);
  const now = Date.now();

  // 1. Clean scratch directory
  const scratchDir = path.join(projectDir, 'scratch');
  if (fs.existsSync(scratchDir)) {
    const files = fs.readdirSync(scratchDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(scratchDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const record = parseRecord(content, filePath);
          const dateStr = record.frontmatter.created || record.frontmatter.updated;
          if (isRecordExpired(dateStr, scratchTtlDays, record.frontmatter.ttl, now)) {
            purgedScratchCount++;
            purgedFiles.push(filePath);
            if (!dryRun) {
              fs.unlinkSync(filePath);
              removeRecord(db, record.frontmatter.id, projectId);
            }
          }
        } catch {
          // If corrupted scratch file, also delete on GC if older than TTL
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs >= scratchTtlDays * 86400 * 1000) {
              purgedScratchCount++;
              purgedFiles.push(filePath);
              if (!dryRun) {
                fs.unlinkSync(filePath);
              }
            }
          } catch {
            // Ignore stat error
          }
        }
      }
    }
  }

  // 2. Clean reviews directory
  const reviewsDir = path.join(projectDir, 'reviews');
  if (fs.existsSync(reviewsDir)) {
    const files = fs.readdirSync(reviewsDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const filePath = path.join(reviewsDir, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const record = parseRecord(content, filePath);
          const dateStr = record.frontmatter.created || record.frontmatter.updated;
          if (isRecordExpired(dateStr, reviewTtlDays, record.frontmatter.ttl, now)) {
            purgedReviewCount++;
            purgedFiles.push(filePath);
            if (!dryRun) {
              fs.unlinkSync(filePath);
              removeRecord(db, record.frontmatter.id, projectId);
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  // 3. Compact shipped plans
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

  // 4. Update index and compiled views
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
    compactedPlansCount,
    rebuiltFts,
    rebuiltViews: !dryRun,
    dryRun,
    details: {
      purgedFiles,
      compactedPlans
    }
  };
  });
}
