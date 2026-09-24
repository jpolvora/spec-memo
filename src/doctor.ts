import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DoctorOptions, DoctorPollutionItem, DoctorResult } from './types.js';
import { readVaultConfig, getVaultRoot, resolveVaultGitAtomic, redactVaultGitRemoteUrl } from './vault.js';
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
import { getVaultAiStatus } from './ai/index.js';
import { inspectVaultGitLive } from './vault-git-inspect.js';
import { scanSpecLifecycleDrift } from './spec-lifecycle.js';
import { summarizeTelemetry, type TelemetrySummary } from './telemetry.js';

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
function isGitWorkTree(rootPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', rootPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function listGitIgnoredRelPaths(rootPath: string, rels: string[]): Set<string> {
  const ignored = new Set<string>();
  if (rels.length === 0 || !isGitWorkTree(rootPath)) {
    return ignored;
  }
  for (const rel of rels) {
    try {
      execFileSync('git', ['-C', rootPath, 'check-ignore', '-q', '--', rel], {
        stdio: ['ignore', 'ignore', 'ignore']
      });
      ignored.add(rel.replace(/\\/g, '/'));
    } catch (err: unknown) {
      const status = err && typeof err === 'object' && 'status' in err ? Number((err as { status?: number }).status) : 1;
      if (status === 0) {
        ignored.add(rel.replace(/\\/g, '/'));
      }
    }
  }
  return ignored;
}

function countMarkdownRecordIds(vaultRoot: string): { ids: Set<string>; files: number } {
  const ids = new Set<string>();
  let files = 0;
  const projectsDir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return { ids, files };
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const sub of RECORD_SUBDIRS) {
      const dir = path.join(projectsDir, project.name, sub);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
        files++;
        try {
          const record = parseRecord(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (record.frontmatter.id) ids.add(String(record.frontmatter.id));
        } catch {
          // skip malformed
        }
      }
    }
  }
  return { ids, files };
}

export function scanForRepoPollution(
  rootPath: string,
  vaultRoot?: string,
  opts: { projectId?: string } = {}
): {
  items: DoctorPollutionItem[];
  excludedByIgnoreCount: number;
  gitignoredCount: number;
  classifiedResidue: DoctorPollutionItem[];
} {
  const pollution: DoctorPollutionItem[] = [];
  const classifiedResidue: DoctorPollutionItem[] = [];
  let excludedByIgnoreCount = 0;
  let gitignoredCount = 0;
  const empty = () => ({
    items: pollution,
    excludedByIgnoreCount,
    gitignoredCount,
    classifiedResidue
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
  const pending: DoctorPollutionItem[] = [];

  /**
   * Queue a residue item unless the path is excluded by the spec-memo ignore boundary.
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
    pending.push({
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

  const gitIgnored = listGitIgnoredRelPaths(
    resolvedRoot,
    pending.map((p) => p.path)
  );
  for (const item of pending) {
    if (gitIgnored.has(item.path) || gitIgnored.has(item.path.toLowerCase())) {
      gitignoredCount++;
      classifiedResidue.push({
        ...item,
        description: `${item.description} (gitignored; classified, not deleted)`
      });
      continue;
    }
    pollution.push(item);
  }

  return { items: pollution, excludedByIgnoreCount, gitignoredCount, classifiedResidue };
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
  let gitignoredCount = scan.gitignoredCount;
  let classifiedResidue = scan.classifiedResidue;
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
      gitignoredCount = scan.gitignoredCount;
      classifiedResidue = scan.classifiedResidue;
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
  if (classifiedResidue.length > 0) {
    warnings.push(
      `Classified ${classifiedResidue.length} gitignored workflow residue file${classifiedResidue.length === 1 ? '' : 's'} (not deleted; doctor remains healthy).`
    );
  }

  // Deployment mode diagnostics (AC11, AC12, AC13)
  const { config, configValid, issues: configIssues } = readVaultConfig(vaultRoot);
  if (!configValid) {
    for (const issue of configIssues) warnings.push(`Vault config: ${issue}`);
  }
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

  const packageVersion = getPackageVersion();
  const configVersion = typeof config.version === 'string' ? config.version : undefined;
  if (configVersion && configVersion !== packageVersion) {
    warnings.push(
      `Vault config.json version ${configVersion} differs from running package ${packageVersion}.`
    );
  }

  let ftsMarkdownFiles = 0;
  let ftsMarkdownIds = 0;
  let ftsIndexIds = indexedRecordsCount;
  let ftsConsistent = true;
  let ftsMissingIds: string[] = [];
  let ftsUnexpectedIds: string[] = [];
  if (ftsHealthy && vaultExists) {
    try {
      const md = countMarkdownRecordIds(vaultRoot);
      ftsMarkdownFiles = md.files;
      ftsMarkdownIds = md.ids.size;
      const db = openIndex(vaultRoot);
      const rows = db.prepare('SELECT id FROM records_fts').all() as Array<{ id: string }>;
      const indexed = new Set(rows.map((r) => String(r.id)));
      ftsIndexIds = indexed.size;
      // AC8: compare full identity sets, not counts. countMarkdownRecordIds walks only
      // canonical RECORD_SUBDIRS and skips .conflict. sidecars, so compiled views,
      // project metadata, and conflict sidecars are excluded by construction.
      ftsMissingIds = [...md.ids].filter((id) => !indexed.has(id)).sort().slice(0, 20);
      ftsUnexpectedIds = [...indexed].filter((id) => !md.ids.has(id)).sort().slice(0, 20);
      const missingTotal = [...md.ids].filter((id) => !indexed.has(id)).length;
      const unexpectedTotal = [...indexed].filter((id) => !md.ids.has(id)).length;
      ftsConsistent = missingTotal === 0 && unexpectedTotal === 0;
      if (!ftsConsistent) {
        warnings.push(
          `FTS index identity mismatch: ${[...md.ids].filter((id) => !indexed.has(id)).length} missing / ${[...indexed].filter((id) => !md.ids.has(id)).length} unexpected — ${md.ids.size} markdown ids / ${md.files} files vs ${indexed.size} indexed ids. Missing: ${ftsMissingIds.join(', ') || 'none listed'}. Unexpected: ${ftsUnexpectedIds.join(', ') || 'none listed'}. Run memo doctor --rebuild.`
        );
      }
    } catch {
      // fail-open
    }
  }

  const gitPersisted = readVaultGitState(vaultRoot);
  const vaultGitLive = inspectVaultGitLive(vaultRoot, gitPersisted, Boolean(config.vaultGit?.enabled));
  if (vaultGitLive.enabled && !vaultGitLive.author.configured) {
    warnings.push(
      'Vault Git has no configured author (user.email). Commits will fail with Author identity unknown until git user.name/email is set.'
    );
  }
  if (vaultGitLive.persistedStale) {
    warnings.push(
      `Vault Git persisted dirty=${vaultGitLive.persistedDirty} but live porcelain dirty=${vaultGitLive.liveDirty} (${vaultGitLive.porcelainPaths.length} path(s)).`
    );
  }

  let telemetrySummary: TelemetrySummary | undefined;
  try {
    telemetrySummary = summarizeTelemetry(vaultRoot, { maxEvents: 5000 });
  } catch {
    telemetrySummary = undefined;
  }

  for (const drift of scanSpecLifecycleDrift(identity.rootPath)) {
    warnings.push(`Spec lifecycle: ${drift.slug} — ${drift.reason}`);
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
      dirty: vaultGitLive.liveDirty || gitPersisted.dirty,
      lastError: gitPersisted.lastError,
      lastSyncAt: gitPersisted.lastSyncAt,
      liveDirty: vaultGitLive.liveDirty,
      persistedDirty: gitPersisted.dirty,
      persistedStale: vaultGitLive.persistedStale,
      authorConfigured: vaultGitLive.author.configured,
      authorSource: vaultGitLive.author.source,
      porcelainCount: vaultGitLive.porcelainPaths.length
    },
    configVersion,
    packageVersion,
    telemetry: telemetrySummary
      ? {
          enabled: Boolean(config.enableTelemetry),
          logFile: telemetrySummary.logFile,
          eventCount: telemetrySummary.eventCount,
          failureCount: telemetrySummary.failureCount,
          failureRate: telemetrySummary.failureRate,
          productFaults: telemetrySummary.productFaults,
          expectedFaults: telemetrySummary.expectedFaults,
          p50Ms: telemetrySummary.p50Ms,
          p95Ms: telemetrySummary.p95Ms,
          p99Ms: telemetrySummary.p99Ms,
          topErrorCodes: telemetrySummary.topErrorCodes,
          perProject: telemetrySummary.perProject,
          counters: telemetrySummary.counters
        }
      : undefined,
    // Spec 0056 AC28: AI provider, enabled flag, queue depth, redacted error.
    ai: getVaultAiStatus(vaultRoot),
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
      rebuilt,
      markdownRecordFiles: ftsMarkdownFiles,
      markdownRecordIds: ftsMarkdownIds,
      indexedDistinctIds: ftsIndexIds,
      consistent: ftsConsistent,
      missingIds: ftsMissingIds,
      unexpectedIds: ftsUnexpectedIds,
      missingCount: ftsMissingIds.length,
      unexpectedCount: ftsUnexpectedIds.length
    },
    pollution: {
      detected: pollutionItems.length > 0,
      fixedCount,
      items: pollutionItems,
      skippedTracked,
      excludedByIgnoreCount,
      gitignoredCount,
      classifiedResidue
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
