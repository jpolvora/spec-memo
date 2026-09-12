import {
  ensureVaultStructure,
  getVaultRoot,
  flushVaultGit,
  getShutdownFlushMs,
  type VaultGitChannelResult
} from './vault.js';
import { flushDebouncedPushes, syncHybrid, type HybridSyncReport } from './hybrid-sync.js';
import { readHybridState } from './hybrid-state.js';
import { logErrorReport } from './error-logger.js';
import { recordTelemetry } from './telemetry.js';
import { safeVaultGitError } from './vault-git-redact.js';

export type DualSyncTrigger = 'sync' | 'session_end' | 'shutdown';

export interface DualSyncOptions {
  vaultRoot?: string;
  projectId?: string;
  all?: boolean;
  dryRun?: boolean;
  trigger: DualSyncTrigger;
  sessionId?: string;
  force?: boolean;
  prefer?: 'local' | 'remote';
  strategy?: import('./types.js').ConflictStrategy;
  cleanSidecars?: boolean;
}

export interface DualSyncHybridChannel {
  ok: boolean;
  error?: string;
  report?: HybridSyncReport;
}

export interface DualSyncReport {
  trigger: DualSyncTrigger;
  ok: boolean;
  hybrid?: DualSyncHybridChannel;
  vaultGit?: VaultGitChannelResult;
  timestamp: string;
}

const EMPTY_HYBRID: HybridSyncReport = {
  all: false,
  pulled: { applied: 0, skipped: 0, conflicts: 0, dryRun: false, recordsApplied: [] },
  pushed: { applied: 0, skipped: 0, conflicts: 0, dryRun: false, recordsApplied: [] },
  timestamp: new Date(0).toISOString()
};

function buildEmptyHybrid(all: boolean | undefined): HybridSyncReport {
  return {
    ...EMPTY_HYBRID,
    all: Boolean(all),
    pulled: { ...EMPTY_HYBRID.pulled },
    pushed: { ...EMPTY_HYBRID.pushed },
    timestamp: new Date().toISOString()
  };
}

function isHybridReportSuccessful(report: HybridSyncReport, vaultRoot: string): boolean {
  if ((report.pulled?.conflicts ?? 0) > 0 || (report.pushed?.conflicts ?? 0) > 0) {
    return false;
  }
  const state = readHybridState(vaultRoot);
  return !state.dirty;
}

function describeHybridDirty(vaultRoot: string): string | undefined {
  try {
    const state = readHybridState(vaultRoot);
    if (!state.dirty) return undefined;
    if (state.lastError) return state.lastError;
    const dirtyProjects = Object.entries(state.dirtyProjects || {})
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k);
    if (dirtyProjects.length > 0) {
      return `Hybrid state dirty for project(s): ${dirtyProjects.join(', ')}`;
    }
    return 'Hybrid state dirty; review hybrid-state.json lastError';
  } catch {
    return undefined;
  }
}

/**
 * Dual-mode orchestrator: hybrid HTTP runs first, then vault-git commits the
 * hybrid-rewritten views in the same run. Sequential execution avoids the
 * dirty-tree race where a concurrent hybrid pull dirties compiled views
 * between the vault-git flush commit and `pull --rebase --autostash`
 * (issue #55 follow-up: autostash pile-up).
 */
export async function syncDual(options: DualSyncOptions): Promise<DualSyncReport> {
  const started = performance.now();
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);
  const trigger = options.trigger;
  const hybridEnabled = config.mode === 'hybrid' && Boolean(config.remote?.url);
  const gitEnabled = Boolean(config.vaultGit?.enabled) && config.mode !== 'remote';

  if (!hybridEnabled && !gitEnabled) {
    throw new Error(
      `memo sync requires hybrid mode or vaultGit.enabled in config.json (current mode: ${config.mode || 'local'}).`
    );
  }

  let hybrid: DualSyncHybridChannel | undefined;
  if (hybridEnabled) {
    try {
      if (trigger === 'session_end' || trigger === 'shutdown') {
        await flushDebouncedPushes();
      }
      const report = await syncHybrid({
        vaultRoot,
        projectId: options.projectId,
        all: options.all,
        dryRun: options.dryRun,
        force: options.force,
        prefer: options.prefer,
        strategy: options.strategy,
        cleanSidecars: options.cleanSidecars
      });
      const ok = isHybridReportSuccessful(report, vaultRoot);
      if (ok) {
        hybrid = { ok, report };
      } else {
        const dirtyMsg = describeHybridDirty(vaultRoot);
        const conflictCount = (report.pulled?.conflicts ?? 0) + (report.pushed?.conflicts ?? 0);
        const fallback =
          conflictCount > 0 ? `Hybrid sync reported ${conflictCount} conflict(s)` : undefined;
        hybrid = { ok, report, ...(dirtyMsg || fallback ? { error: dirtyMsg ?? fallback } : {}) };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logErrorReport(
        {
          subsystem: 'hybrid-sync',
          mode: config.mode,
          projectId: options.projectId,
          error: err,
          context: { phase: 'orchestrate', trigger }
        },
        { vaultRoot }
      );
      hybrid = { ok: false, error: msg, report: buildEmptyHybrid(options.all) };
    }
  }

  let vaultGit: VaultGitChannelResult | undefined;
  if (gitEnabled) {
    try {
      vaultGit = await flushVaultGit(vaultRoot, {
        dryRun: options.dryRun,
        trigger,
        sessionId: options.sessionId
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const safe = safeVaultGitError(msg) || 'vault-git sync failed';
      vaultGit = {
        ok: false,
        committed: false,
        pulled: false,
        pushed: false,
        message: safe,
        error: safe
      };
    }
  }

  const enabledResults: boolean[] = [];
  if (hybrid) enabledResults.push(hybrid.ok);
  if (vaultGit) enabledResults.push(vaultGit.ok);
  const ok = enabledResults.length > 0 && enabledResults.every(Boolean);

  const report: DualSyncReport = {
    trigger,
    ok,
    hybrid,
    vaultGit,
    timestamp: new Date().toISOString()
  };

  recordTelemetry({
    category: 'sync_operation',
    operation: 'sync_dual',
    durationMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10),
    success: ok,
    errorCode: ok ? undefined : 'DUAL_SYNC_FAILED',
    projectId: options.projectId,
    vaultRoot,
    metadata: { trigger, hybrid: Boolean(hybridEnabled), vaultGit: Boolean(gitEnabled) }
  });

  return report;
}

/**
 * Best-effort flush on process shutdown. Never throws. Caps wait at 8s (override SPEC_MEMO_SYNC_TIMEOUT_MS).
 */
export async function flushOnShutdown(vaultRoot?: string): Promise<void> {
  const root = getVaultRoot(vaultRoot);
  const config = ensureVaultStructure(root);
  const hybridEnabled = config.mode === 'hybrid' && Boolean(config.remote?.url);
  const gitEnabled = Boolean(config.vaultGit?.enabled) && config.mode !== 'remote';
  if (!hybridEnabled && !gitEnabled) {
    return;
  }
  const cap = getShutdownFlushMs();
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, cap);
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([
      syncDual({ vaultRoot: root, trigger: 'shutdown', all: true }).then(() => undefined),
      timeout
    ]);
    if (timedOut) {
      logErrorReport(
        {
          subsystem: 'vault-git',
          error: `shutdown flush timed out after ${cap}ms`,
          context: { phase: 'flush', trigger: 'shutdown' }
        },
        { vaultRoot: root }
      );
    }
  } catch (err: unknown) {
    logErrorReport(
      {
        subsystem: 'vault-git',
        error: err,
        context: { phase: 'flush', trigger: 'shutdown' }
      },
      { vaultRoot: root }
    );
  }
}
