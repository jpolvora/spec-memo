import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DoctorOptions, DoctorPollutionItem, DoctorResult } from './types.js';
import { ensureVaultStructure, getVaultRoot, resolveVaultGitAtomic, redactVaultGitRemoteUrl } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { openIndex, rebuildIndex, findActiveSemanticContradictions } from './indexer.js';
import { wrapSqliteOpenError } from './sqlite.js';
import { isTokenConfigured, getResolvedAuthToken } from './setup.js';
import { getPackageVersion } from './version.js';
import { readHybridState } from './hybrid-state.js';
import { readVaultGitState } from './vault-git-state.js';
import { isPathInside } from './safety.js';
import { inspectAgentHooks } from './hooks-install.js';
import {
  checkCapturePath,
  evaluatePathIgnore,
  formatCheckCaptureResult,
  loadIgnoreRules
} from './capture-ignore.js';
import { parseRecord } from './schema.js';
import { RECORD_SUBDIRS } from './vault.js';
import { helpfulCountOf, staleCountOf, isFlaggedStale } from './salience.js';

export const DEFAULT_HEALTH_TIMEOUT_MS = 10000;

export function getHealthTimeoutMs(): number {
  const envVal = Number(process.env.SPEC_MEMO_HEALTH_TIMEOUT_MS || process.env.SPEC_MEMO_SYNC_TIMEOUT_MS);
  return envVal > 0 ? envVal : DEFAULT_HEALTH_TIMEOUT_MS;
}

export async function checkRemoteHealth(
  origin: string,
  token?: string
): Promise<{ reachable: boolean; statusCode?: number; message?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getHealthTimeoutMs());
  try {
    const healthUrl = `${origin.replace(/\/+$/, '')}/health`;
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(healthUrl, { headers, signal: controller.signal });
    if (res.ok) {
      return { reachable: true, statusCode: res.status };
    }
    return { reachable: false, statusCode: res.status, message: `HTTP ${res.status}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { reachable: false, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

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

function scanPotentiallyObsoleteRecords(
  vaultRoot: string
): Array<{ id: string; title?: string; helpfulCount: number; staleCount: number }> {
  const obsolete: Array<{ id: string; title?: string; helpfulCount: number; staleCount: number }> = [];
  const projectsDir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return obsolete;

  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsDir, project.name);
    for (const sub of RECORD_SUBDIRS) {
      const dir = path.join(projectDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
        try {
          const record = parseRecord(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (!isFlaggedStale(record.frontmatter)) continue;
          obsolete.push({
            id: String(record.frontmatter.id),
            title: typeof record.frontmatter.title === 'string' ? record.frontmatter.title : undefined,
            helpfulCount: helpfulCountOf(record.frontmatter),
            staleCount: staleCountOf(record.frontmatter)
          });
        } catch {
          // skip
        }
      }
    }
  }
  return obsolete;
}

/**
 * Scan a product repository for in-tree workflow pollution.
 * If rootPath is within the vault root, returns empty (the vault is where records belong).
 *
 * Every residue candidate is filtered through the same ignore boundary that
 * `memo doctor --check-capture` enforces (project `.spec-memo-ignore` plus vault
 * `config.json` `projects.{id}.ignorePaths` via `evaluatePathIgnore`). Ignored
 * candidates never appear in `items`; they are counted in `excludedByIgnoreCount`.
 */
export function scanForRepoPollution(
  rootPath: string,
  vaultRoot?: string,
  opts: { projectId?: string } = {}
): { items: DoctorPollutionItem[]; excludedByIgnoreCount: number } {
  const pollution: DoctorPollutionItem[] = [];
  let excludedByIgnoreCount = 0;
  const empty = (): { items: DoctorPollutionItem[]; excludedByIgnoreCount: number } => ({
    items: pollution,
    excludedByIgnoreCount
  });
  if (!fs.existsSync(rootPath)) {
    return empty();
  }

  const resolvedVault = path.resolve(vaultRoot || getVaultRoot());
  const resolvedRoot = path.resolve(rootPath);
  if (resolvedRoot === resolvedVault || isPathInside(resolvedRoot, resolvedVault)) {
    return empty();
  }

  const ignoreCtx = { projectId: opts.projectId, vaultRoot: resolvedVault };
  // Prime the ignore-rule cache once; per-file evaluation below reuses the loaded rules.
  loadIgnoreRules(resolvedRoot, ignoreCtx);

  const allFiles = findFilesRecursive(rootPath);

  /**
   * Push a residue item unless the path is excluded by the ignore boundary.
   * At most one boundary evaluation runs per file (callers `continue` after a push).
   */
  const tryPush = (
    filePath: string,
    rel: string,
    type: DoctorPollutionItem['type'],
    description: string
  ): boolean => {
    if (evaluatePathIgnore(filePath, resolvedRoot, ignoreCtx).ignored) {
      excludedByIgnoreCount++;
      return false;
    }
    pollution.push({
      path: rel,
      absolutePath: filePath,
      type,
      description
    });
    return true;
  };

  for (const filePath of allFiles) {
    const rel = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const lowerRel = rel.toLowerCase();

    // 1. Check for .agents/plans residue
    if (lowerRel.startsWith('.agents/plans/') || lowerRel.startsWith('agents/plans/')) {
      tryPush(
        filePath,
        rel,
        'plan_residue',
        `In-repo agent plan residue detected under .agents/plans/`
      );
      continue;
    }

    // 2. Check for in-tree memory residue (MEMORY.md, memory/*.md, ws-shared/memory/)
    if (
      lowerRel === 'memory.md' ||
      lowerRel.endsWith('/memory.md') ||
      lowerRel.startsWith('memory/') ||
      lowerRel.startsWith('.agents/memory/') ||
      lowerRel.startsWith('ws-shared/memory/') ||
      lowerRel.includes('/ws-shared/memory/')
    ) {
      tryPush(
        filePath,
        rel,
        'memory_residue',
        `In-repo agent working memory residue detected (${rel})`
      );
      continue;
    }

    // 3. Check for run state / audit / telemetry residue
    // run.json matches as a full basename only: my-run.json / my_run.json /
    // my.run.json are user files and must never be flagged (let alone --fix deleted).
    if (
      /(^|\/)run\.json$/.test(lowerRel) ||
      lowerRel.endsWith('.state.md') ||
      lowerRel.includes('/.state.md')
    ) {
      tryPush(
        filePath,
        rel,
        'state_residue',
        `In-repo workflow state residue detected (${rel})`
      );
      continue;
    }

    if (
      lowerRel.endsWith('telemetry.jsonl') ||
      lowerRel.includes('/telemetry/') ||
      lowerRel.startsWith('telemetry/')
    ) {
      tryPush(
        filePath,
        rel,
        'telemetry_residue',
        `In-repo telemetry dump residue detected (${rel})`
      );
      continue;
    }

    if (
      (lowerRel.includes('audit-') && lowerRel.endsWith('.log.md')) ||
      (lowerRel.startsWith('.agents/') && lowerRel.endsWith('.log'))
    ) {
      tryPush(
        filePath,
        rel,
        'log_residue',
        `In-repo agent audit log residue detected (${rel})`
      );
      continue;
    }
  }

  return { items: pollution, excludedByIgnoreCount };
}

/**
 * List git-tracked paths (posix, repo-root-relative) for a product root.
 * Returns an empty set when the root is not a git repository (nothing is tracked).
 * Returns `null` when tracked status cannot be determined inside a git repository;
 * callers must treat every candidate as tracked in that case (never delete on ambiguity).
 */
function listTrackedFiles(rootPath: string, isGit: boolean): Set<string> | null {
  if (!isGit) {
    return new Set<string>();
  }
  try {
    const out = execFileSync('git', ['-C', rootPath, 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const tracked = new Set<string>();
    for (const entry of out.split('\0')) {
      if (entry) {
        const posix = entry.replace(/\\/g, '/');
        tracked.add(posix);
        tracked.add(posix.toLowerCase());
      }
    }
    return tracked;
  } catch {
    return null;
  }
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

  if (options.checkCapture) {
    const captureCheck = checkCapturePath(options.checkCapture, identity.rootPath, {
      projectId: identity.projectId,
      vaultRoot
    });
    const boundary = loadIgnoreRules(identity.rootPath, {
      projectId: identity.projectId,
      vaultRoot
    });
    return {
      healthy: captureCheck.status === 'CAPTURED',
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
        dbPath: path.join(vaultRoot, 'memo.sqlite'),
        dbExists: fs.existsSync(path.join(vaultRoot, 'memo.sqlite')),
        indexedRecordsCount: 0,
        healthy: false
      },
      pollution: { detected: false, items: [] },
      exclusionBoundary: {
        activeRuleCount: boundary.activeRuleCount,
        invalidLineCount: boundary.invalidLines.length,
        invalidLines: boundary.invalidLines
      },
      captureCheck,
      warnings,
      summary: formatCheckCaptureResult(captureCheck)
    };
  }

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
      const msg = wrapSqliteOpenError(err).message;
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
      const msg = wrapSqliteOpenError(err).message;
      warnings.push(`FTS index rebuild failed: ${msg}`);
    }
  }

  // Check product tree pollution
  let scan = scanForRepoPollution(identity.rootPath, vaultRoot, {
    projectId: identity.projectId
  });
  let pollutionItems = scan.items;
  let excludedByIgnoreCount = scan.excludedByIgnoreCount;
  let skippedTracked: string[] = [];
  let fixedCount = 0;

  // Optional fix execution (AC3)
  if (options.fix) {
    if (pollutionItems.length > 0) {
      // Tracked files are curated, never residue: skip them unless explicitly opted in.
      const tracked = listTrackedFiles(identity.rootPath, identity.isGit);
      if (tracked === null) {
        warnings.push(
          `Could not determine git tracked status in ${identity.rootPath}; treating all candidates as tracked (use --include-tracked to override).`
        );
      }
      const deletedTracked: string[] = [];
      for (const item of pollutionItems) {
        const relPosix = item.path.replace(/\\/g, '/');
        const isTracked =
          tracked === null || tracked.has(relPosix) || tracked.has(relPosix.toLowerCase());
        if (isTracked && options.includeTracked !== true) {
          skippedTracked.push(item.path);
          continue;
        }
        try {
          if (fs.existsSync(item.absolutePath)) {
            fs.unlinkSync(item.absolutePath);
            fixedCount++;
            if (isTracked) {
              deletedTracked.push(item.path);
            }
          }
        } catch {
          // Ignore file delete errors
        }
      }
      if (skippedTracked.length > 0) {
        warnings.push(
          `Skipped ${skippedTracked.length} git-tracked file${skippedTracked.length === 1 ? '' : 's'} (use --include-tracked to delete): ${skippedTracked.join(', ')}`
        );
      }
      if (deletedTracked.length > 0) {
        warnings.push(
          `--include-tracked: deleted ${deletedTracked.length} git-tracked file${deletedTracked.length === 1 ? '' : 's'}: ${deletedTracked.join(', ')}`
        );
      }
      // Rescan after fix
      scan = scanForRepoPollution(identity.rootPath, vaultRoot, {
        projectId: identity.projectId
      });
      pollutionItems = scan.items;
      excludedByIgnoreCount = scan.excludedByIgnoreCount;
    }

    try {
      const { withVaultLock } = await import('./vault.js');
      const { cleanConflictSidecars } = await import('./sync.js');
      // Only auto-clean semantically identical sidecars during --fix.
      // Divergent sidecars require explicit 'memo reconcile --prefer local|remote --clean-sidecars'.
      // Serialized under vault lock vs concurrent daemon auto-sync.
      const cleanRes = await withVaultLock(vaultRoot, async () => cleanConflictSidecars(vaultRoot));
      fixedCount += cleanRes.cleaned;
      if (cleanRes.cleaned > 0) {
        await withVaultLock(vaultRoot, async () => {
          const { rebuildIndex } = await import('./indexer.js');
          const { rebuildCompiledViews } = await import('./compiler.js');
          await rebuildIndex(vaultRoot);
          for (const pid of new Set(cleanRes.filesCleaned.map((f) => f.split('/')[0]))) {
            if (pid) rebuildCompiledViews(pid, vaultRoot);
          }
        });
      }
    } catch {
      // Ignore sidecar cleanup errors
    }
  } else {
    try {
      const { cleanConflictSidecars } = await import('./sync.js');
      const dryScan = cleanConflictSidecars(vaultRoot, { dryRun: true });
      const totalConflicts = dryScan.cleaned + dryScan.retained;
      if (totalConflicts > 0) {
        warnings.push(
          `Detected ${totalConflicts} conflict sidecar file${totalConflicts === 1 ? '' : 's'} in vault. Run 'memo reconcile --clean-sidecars' or 'memo doctor --fix' to clean.`
        );
      }
    } catch {
      // Ignore sidecar scan errors
    }
  }

  if (pollutionItems.length > 0) {
    warnings.push(
      `Detected ${pollutionItems.length} in-tree workflow pollution file${pollutionItems.length === 1 ? '' : 's'} in ${identity.rootPath}`
    );
  }

  // Deployment mode diagnostics (AC11, AC12, AC13)
  const config = ensureVaultStructure(vaultRoot);
  const effectiveMode = config.mode || 'local';
  const remoteUrl = config.remote?.url || null;
  const tokenConfigured = isTokenConfigured();
  const token = getResolvedAuthToken();

  let hybridState: import('./types.js').HybridState | null = null;
  let remoteHealth: { reachable: boolean; statusCode?: number; message?: string } | null = null;

  if (effectiveMode === 'hybrid') {
    hybridState = readHybridState(vaultRoot);
    if (remoteUrl) {
      remoteHealth = await checkRemoteHealth(remoteUrl, token);
      if (!remoteHealth.reachable) {
        warnings.push(
          `Remote daemon unreachable at ${remoteUrl} (${remoteHealth.message || 'connection failed'}). Local vault remains operational.`
        );
      }
    } else {
      warnings.push(`Hybrid mode configured without a valid remote URL.`);
    }
    if (!tokenConfigured) {
      warnings.push(`Hybrid mode requires SPEC_MEMO_AUTH_TOKEN or SPEC_MEMO_SSE_TOKEN in the environment.`);
    }
  } else if (effectiveMode === 'remote') {
    if (!remoteUrl) {
      warnings.push(`Remote mode configured without a remote URL.`);
    } else {
      remoteHealth = await checkRemoteHealth(remoteUrl, token);
      if (!remoteHealth.reachable) {
        warnings.push(
          `Remote daemon unreachable at ${remoteUrl} (${remoteHealth.message || 'connection failed'}). Cannot proxy in remote mode.`
        );
      }
    }
    if (!tokenConfigured) {
      warnings.push(`Remote mode requires SPEC_MEMO_AUTH_TOKEN or SPEC_MEMO_SSE_TOKEN in the environment.`);
    }
  }

  let healthy = vaultExists && ftsHealthy && pollutionItems.length === 0;
  if (effectiveMode === 'remote') {
    healthy =
      Boolean(remoteHealth?.reachable) &&
      tokenConfigured &&
      pollutionItems.length === 0;
  }

  const agentHooks = inspectAgentHooks({
    cwd: options.cwd,
    productRoot: identity.rootPath
  });
  const exclusionBoundary = loadIgnoreRules(identity.rootPath, {
    projectId: identity.projectId,
    vaultRoot
  });
  if (exclusionBoundary.invalidLines.length > 0) {
    for (const bad of exclusionBoundary.invalidLines) {
      warnings.push(
        `Exclusion boundary: invalid .spec-memo-ignore line ${bad.line}: ${bad.reason} (${bad.text.trim()})`
      );
    }
  }
  if (agentHooks.installed) {
    for (const h of agentHooks.hosts) {
      if (h.outdated) {
        warnings.push(
          `Agent hook templates for ${h.host} may be outdated (installed: ${h.version || 'unknown'}, running: ${getPackageVersion()}). Re-run 'memo install-hooks --apply --force'.`
        );
      }
    }
  }

  const summary = healthy
    ? `spec-memo vault is healthy and product repository is clean (${indexedRecordsCount} records indexed, mode: ${effectiveMode}).`
    : `spec-memo doctor detected issues (${warnings.length} warning${warnings.length === 1 ? '' : 's'}, mode: ${effectiveMode}).`;

  let semanticContradictions: import('./types.js').SemanticContradiction[] = [];
  let potentiallyObsolete: Array<{ id: string; title?: string; helpfulCount: number; staleCount: number }> = [];
  if (ftsHealthy) {
    try {
      semanticContradictions = findActiveSemanticContradictions(vaultRoot);
      potentiallyObsolete = scanPotentiallyObsoleteRecords(vaultRoot);
      for (const c of semanticContradictions) {
        warnings.push(
          `Active semantic contradiction: ${c.sourceId} contradicts ${c.targetId} (both active). Consider archival or supersession.`
        );
      }
      for (const o of potentiallyObsolete) {
        warnings.push(
          `Potentially obsolete record: ${o.id} (stale=${o.staleCount}, helpful=${o.helpfulCount}).`
        );
      }
    } catch {
      // fail-open
    }
  }

  return {
    healthy,
    vaultRoot,
    vaultExists,
    mode: effectiveMode,
    remoteUrl,
    tokenConfigured,
    hybridState,
    vaultGit: {
      enabled: Boolean(config.vaultGit?.enabled),
      atomic: resolveVaultGitAtomic(config),
      remoteUrl: redactVaultGitRemoteUrl(config.vaultGit?.remoteUrl),
      dirty: readVaultGitState(vaultRoot).dirty,
      lastError: readVaultGitState(vaultRoot).lastError,
      lastSyncAt: readVaultGitState(vaultRoot).lastSyncAt
    },
    remoteHealth,
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
      items: pollutionItems,
      skippedTracked,
      excludedByIgnoreCount
    },
    agentHooks,
    exclusionBoundary: {
      activeRuleCount: exclusionBoundary.activeRuleCount,
      invalidLineCount: exclusionBoundary.invalidLines.length,
      invalidLines: exclusionBoundary.invalidLines
    },
    warnings,
    summary,
    semanticContradictions,
    potentiallyObsolete
  };
}
