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

function isHybridReportSuccessful(report: HybridSyncReport, vaultRoot: string): boolean {
  if ((report.pulled?.conflicts ?? 0) > 0 || (report.pushed?.conflicts ?? 0) > 0) {
    return false;
  }
  const state = readHybridState(vaultRoot);
  return !state.dirty;
}

/**
 * Dual-mode orchestrator: hybrid HTTP and vault-git run concurrently when both are enabled.
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

  const hybridJob: Promise<DualSyncHybridChannel | undefined> = hybridEnabled
    ? (async () => {
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
          return { ok: isHybridReportSuccessful(report, vaultRoot), report };
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
          return { ok: false, error: msg, report: { ...EMPTY_HYBRID, timestamp: new Date().toISOString() } };
        }
      })()
    : Promise.resolve(undefined);

  const gitJob: Promise<VaultGitChannelResult | undefined> = gitEnabled
    ? flushVaultGit(vaultRoot, {
        dryRun: options.dryRun,
        trigger,
        sessionId: options.sessionId
      })
    : Promise.resolve(undefined);

  const [hybridSettled, gitSettled] = await Promise.allSettled([hybridJob, gitJob]);

  const hybrid =
    hybridSettled.status === 'fulfilled'
      ? hybridSettled.value
      : {
          ok: false,
          error: hybridSettled.reason instanceof Error ? hybridSettled.reason.message : String(hybridSettled.reason)
        };
  const vaultGit =
    gitSettled.status === 'fulfilled'
      ? gitSettled.value
      : {
          ok: false,
          committed: false,
          pulled: false,
          pushed: false,
          message: safeVaultGitError(
            gitSettled.reason instanceof Error ? gitSettled.reason.message : String(gitSettled.reason)
          ) || 'vault-git sync failed',
          error: safeVaultGitError(
            gitSettled.reason instanceof Error ? gitSettled.reason.message : String(gitSettled.reason)
          )
        };

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
