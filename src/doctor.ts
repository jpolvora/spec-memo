import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { DoctorOptions, DoctorPollutionItem, DoctorResult } from './types.js';
import { getVaultRoot } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { openIndex, rebuildIndex } from './indexer.js';

/**
 * Recursively find all files in a directory, ignoring node_modules, .git, and dist.
 */
function findFilesRecursive(dir: string, maxDepth = 6, currentDepth = 0): string[] {
  if (currentDepth > maxDepth || !fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.spec-memo'
        ) {
          continue;
        }
        results.push(...findFilesRecursive(fullPath, maxDepth, currentDepth + 1));
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore unreadable dirs
  }

  return results;
}

/**
 * Scan a product repository for in-tree workflow pollution.
 */
export function scanForRepoPollution(rootPath: string): DoctorPollutionItem[] {
  const pollution: DoctorPollutionItem[] = [];
  if (!fs.existsSync(rootPath)) {
    return pollution;
  }

  const allFiles = findFilesRecursive(rootPath);

  for (const filePath of allFiles) {
    const rel = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const lowerRel = rel.toLowerCase();

    // 1. Check for .agents/plans residue
    if (lowerRel.startsWith('.agents/plans/') || lowerRel.startsWith('agents/plans/')) {
      pollution.push({
        path: rel,
        absolutePath: filePath,
        type: 'plan_residue',
        description: `In-repo agent plan residue detected under .agents/plans/`
      });
      continue;
    }

    // 2. Check for in-tree memory residue (MEMORY.md, memory/*.md, ws-shared/memory/)
    if (
      lowerRel === 'memory.md' ||
      lowerRel === 'ws-shared/memory.md' ||
      lowerRel === '.agents/memory.md' ||
      lowerRel.startsWith('memory/') ||
      lowerRel.startsWith('ws-shared/memory/') ||
      lowerRel.startsWith('.agents/memory/')
    ) {
      pollution.push({
        path: rel,
        absolutePath: filePath,
        type: 'memory_residue',
        description: `In-repo agent working memory residue detected (${rel})`
      });
      continue;
    }

    // 3. Check for run state / audit / telemetry residue
    if (
      lowerRel.endsWith('run.json') ||
      lowerRel.endsWith('.state.md') ||
      lowerRel.includes('/.state.md')
    ) {
      pollution.push({
        path: rel,
        absolutePath: filePath,
        type: 'state_residue',
        description: `In-repo workflow state residue detected (${rel})`
      });
      continue;
    }

    if (
      lowerRel.endsWith('telemetry.jsonl') ||
      lowerRel.includes('/telemetry/') ||
      lowerRel.startsWith('telemetry/')
    ) {
      pollution.push({
        path: rel,
        absolutePath: filePath,
        type: 'telemetry_residue',
        description: `In-repo telemetry dump residue detected (${rel})`
      });
      continue;
    }

    if (
      (lowerRel.includes('audit-') && lowerRel.endsWith('.log.md')) ||
      (lowerRel.startsWith('.agents/') && lowerRel.endsWith('.log'))
    ) {
      pollution.push({
        path: rel,
        absolutePath: filePath,
        type: 'log_residue',
        description: `In-repo agent audit log residue detected (${rel})`
      });
      continue;
    }
  }

  return pollution;
}

/**
 * Run diagnostic checks on vault health, SQLite FTS index, and repository cleanliness.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const searchRoot = options.productRoot || options.cwd || process.cwd();
  const identity = resolveProjectIdentity(searchRoot, { vaultRoot });
  const vaultExists = fs.existsSync(vaultRoot);

  const warnings: string[] = [];

  // Check vault directory
  if (!vaultExists) {
    warnings.push(`Vault root directory does not exist: ${vaultRoot}`);
  }

  // Check FTS index
  const dbPath = path.join(vaultRoot, 'memo.sqlite');
  const dbExists = fs.existsSync(dbPath);
  let indexedRecordsCount = 0;
  let ftsHealthy = false;

  if (dbExists) {
    try {
      const db = openIndex(vaultRoot);
      const row = db.prepare('SELECT count(*) as count FROM records_fts').get() as { count: number };
      indexedRecordsCount = row.count;
      ftsHealthy = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`SQLite FTS5 database error: ${msg}`);
    }
  } else {
    warnings.push(`SQLite FTS5 database not yet initialized at ${dbPath}`);
  }

  // Check project identity
  if (identity.isFallback) {
    warnings.push(
      `Project identity is using fallback path ID (${identity.projectId}) because no git remote origin was found. Moving or renaming the repository root will change its project ID.`
    );
  }

  // Optional rebuild execution (AC2)
  let rebuilt = false;
  if (options.rebuild) {
    try {
      const rebuildRes = await rebuildIndex(vaultRoot);
      indexedRecordsCount = rebuildRes.indexed;
      ftsHealthy = true;
      rebuilt = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`FTS index rebuild failed: ${msg}`);
    }
  }

  // Check product tree pollution
  let pollutionItems = scanForRepoPollution(identity.rootPath);
  let fixedCount = 0;

  // Optional fix execution (AC3)
  if (options.fix && pollutionItems.length > 0) {
    for (const item of pollutionItems) {
      try {
        if (fs.existsSync(item.absolutePath)) {
          fs.unlinkSync(item.absolutePath);
          fixedCount++;
        }
      } catch {
        // Ignore file delete errors
      }
    }
    // Rescan after fix
    pollutionItems = scanForRepoPollution(identity.rootPath);
  }

  if (pollutionItems.length > 0) {
    warnings.push(
      `Detected ${pollutionItems.length} in-tree workflow pollution file${pollutionItems.length === 1 ? '' : 's'} in ${identity.rootPath}`
    );
  }

  const healthy = vaultExists && ftsHealthy && pollutionItems.length === 0;

  const summary = healthy
    ? `spec-memo vault is healthy and product repository is clean (${indexedRecordsCount} records indexed).`
    : `spec-memo doctor detected issues (${warnings.length} warning${warnings.length === 1 ? '' : 's'}).`;

  return {
    healthy,
    vaultRoot,
    vaultExists,
    project: {
      projectId: identity.projectId,
      gitRemote: identity.normalizedRemote,
      rootPath: identity.rootPath,
      isGit: identity.isGit,
      isFallback: identity.isFallback
    },
    fts: {
      dbPath,
      dbExists,
      indexedRecordsCount,
      healthy: ftsHealthy,
      rebuilt
    },
    pollution: {
      detected: pollutionItems.length > 0,
      fixedCount,
      items: pollutionItems
    },
    warnings,
    summary
  };
}
