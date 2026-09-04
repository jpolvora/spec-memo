import * as fs from 'node:fs';
import * as path from 'node:path';
import { DoctorOptions, DoctorPollutionItem, DoctorResult } from './types.js';
import { ensureVaultStructure, getVaultRoot, resolveVaultGitAtomic, redactVaultGitRemoteUrl } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { openIndex, rebuildIndex } from './indexer.js';
import { wrapSqliteOpenError } from './sqlite.js';
import { isTokenConfigured, getResolvedAuthToken } from './setup.js';
import { readHybridState } from './hybrid-state.js';
import { readVaultGitState } from './vault-git-state.js';
import { isPathInside } from './safety.js';

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

/**
 * Scan a product repository for in-tree workflow pollution.
 * If rootPath is within the vault root, returns empty (the vault is where records belong).
 */
export function scanForRepoPollution(rootPath: string, vaultRoot?: string): DoctorPollutionItem[] {
  const pollution: DoctorPollutionItem[] = [];
  if (!fs.existsSync(rootPath)) {
    return pollution;
  }

  const resolvedVault = path.resolve(vaultRoot || getVaultRoot());
  const resolvedRoot = path.resolve(rootPath);
  if (resolvedRoot === resolvedVault || isPathInside(resolvedRoot, resolvedVault)) {
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
      lowerRel.endsWith('/memory.md') ||
      lowerRel.startsWith('memory/') ||
      lowerRel.startsWith('.agents/memory/') ||
      lowerRel.startsWith('ws-shared/memory/') ||
      lowerRel.includes('/ws-shared/memory/')
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
  let pollutionItems = scanForRepoPollution(identity.rootPath, vaultRoot);
  let fixedCount = 0;

  // Optional fix execution (AC3)
  if (options.fix) {
    if (pollutionItems.length > 0) {
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
      pollutionItems = scanForRepoPollution(identity.rootPath, vaultRoot);
    }

    try {
      const { cleanConflictSidecars } = await import('./sync.js');
      // Only auto-clean semantically identical sidecars during --fix.
      // Divergent sidecars require explicit 'memo reconcile --prefer local|remote --clean-sidecars'.
      const cleanRes = cleanConflictSidecars(vaultRoot);
      fixedCount += cleanRes.cleaned;
      if (cleanRes.cleaned > 0) {
        const { rebuildIndex } = await import('./indexer.js');
        const { rebuildCompiledViews } = await import('./compiler.js');
        await rebuildIndex(vaultRoot);
        for (const pid of new Set(cleanRes.filesCleaned.map((f) => f.split('/')[0]))) {
          if (pid) rebuildCompiledViews(pid, vaultRoot);
        }
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

  const summary = healthy
    ? `spec-memo vault is healthy and product repository is clean (${indexedRecordsCount} records indexed, mode: ${effectiveMode}).`
    : `spec-memo doctor detected issues (${warnings.length} warning${warnings.length === 1 ? '' : 's'}, mode: ${effectiveMode}).`;

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
      items: pollutionItems
    },
    warnings,
    summary
  };
}
