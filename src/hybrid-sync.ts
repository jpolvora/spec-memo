import { exportChangeset, applyChangeset, Changeset, SyncResult } from './sync.js';
import { ensureVaultStructure, getVaultProjects, getVaultRoot, withVaultLockSync } from './vault.js';
import { readHybridState, writeHybridState } from './hybrid-state.js';
import { isTokenConfigured, getResolvedAuthToken, normalizeRemoteUrl } from './setup.js';
import { logErrorReport } from './error-logger.js';

export interface HybridSyncOptions {
  vaultRoot?: string;
  projectId?: string;
  all?: boolean;
  dryRun?: boolean;
  remoteUrl?: string;
  authToken?: string;
  force?: boolean;
}

export interface HybridSyncReport {
  projectId?: string;
  all: boolean;
  pulled: SyncResult;
  pushed: SyncResult;
  timestamp: string;
}

export const DEFAULT_SYNC_TIMEOUT_MS = 30000;

export function getSyncTimeoutMs(): number {
  const envVal = Number(process.env.SPEC_MEMO_SYNC_TIMEOUT_MS);
  return envVal > 0 ? envVal : DEFAULT_SYNC_TIMEOUT_MS;
}

function buildHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  const token = getResolvedAuthToken(authToken);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Pull remote changes for a given projectId or all projects.
 */
export async function pullHybridProject(
  vaultRootInput?: string,
  projectId?: string,
  remoteUrlInput?: string,
  authToken?: string,
  dryRun: boolean = false
): Promise<SyncResult> {
  const vaultRoot = getVaultRoot(vaultRootInput);
  const config = ensureVaultStructure(vaultRoot);
  const rawUrl = remoteUrlInput || config.remote?.url;

  if (!rawUrl) {
    throw new Error('Remote URL is not configured for hybrid sync.');
  }
  const remoteOrigin = normalizeRemoteUrl(rawUrl);

  const state = readHybridState(vaultRoot);
  const since = projectId && state.cursors ? state.cursors[projectId] : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getSyncTimeoutMs());
  try {
    const res = await fetch(`${remoteOrigin}/api/sync/pull`, {
      method: 'POST',
      headers: buildHeaders(authToken),
      body: JSON.stringify({ projectId, since }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Remote sync pull failed with HTTP ${res.status}: ${res.statusText}`);
    }

    const changeset = (await res.json()) as Changeset;
    const applyResult = await applyChangeset(vaultRoot, changeset, { dryRun });

    if (!dryRun) {
      const now = new Date().toISOString();
      let cursorsUpdate: Record<string, string> | undefined;
      if (applyResult.applied > 0) {
        const cursorVal = changeset.generatedAt || now;
        if (projectId) {
          cursorsUpdate = { [projectId]: cursorVal };
        } else {
          const projects = new Set<string>();
          for (const r of changeset.records) {
            if (r.project) projects.add(r.project);
          }
          if (projects.size > 0) {
            cursorsUpdate = {};
            for (const p of projects) {
              cursorsUpdate[p] = cursorVal;
            }
          }
        }
      }

      if (applyResult.conflicts > 0) {
        writeHybridState(vaultRoot, {
          dirty: true,
          dirtyProjects: projectId ? { [projectId]: true } : undefined,
          lastError: `Hybrid sync pull wrote ${applyResult.conflicts} conflict sidecar(s); review and run memo sync`,
          lastSyncAt: now,
          cursors: cursorsUpdate
        });
      } else {
        writeHybridState(vaultRoot, {
          lastSyncAt: now,
          cursors: cursorsUpdate
        });
      }
    }

    return applyResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErrorReport({
      subsystem: 'hybrid-sync',
      mode: 'hybrid',
      projectId,
      error: err,
      context: { phase: 'pull', remoteOrigin }
    }, { vaultRoot });
    if (projectId) {
      writeHybridState(vaultRoot, {
        dirty: true,
        dirtyProjects: { [projectId]: true },
        lastError: msg
      });
    } else {
      writeHybridState(vaultRoot, {
        dirty: true,
        lastError: msg
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Push local changes for a given projectId or all projects to remote daemon.
 */
export async function pushHybridProject(
  vaultRootInput?: string,
  projectId?: string,
  remoteUrlInput?: string,
  authToken?: string,
  dryRun: boolean = false,
  force: boolean = false,
  sinceOverride?: string
): Promise<SyncResult> {
  const vaultRoot = getVaultRoot(vaultRootInput);
  const config = ensureVaultStructure(vaultRoot);
  const rawUrl = remoteUrlInput || config.remote?.url;

  if (!rawUrl) {
    throw new Error('Remote URL is not configured for hybrid sync.');
  }
  const remoteOrigin = normalizeRemoteUrl(rawUrl);

  const state = readHybridState(vaultRoot);
  const isProjectDirty = Boolean(
    state.dirty && (!projectId || state.dirtyProjects?.[projectId] !== false)
  );
  const since =
    sinceOverride !== undefined
      ? sinceOverride
      : isProjectDirty
        ? undefined
        : projectId && state.cursors
          ? state.cursors[projectId]
          : undefined;

  const changeset = withVaultLockSync(vaultRoot, () =>
    exportChangeset(vaultRoot, { projectId, since })
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getSyncTimeoutMs());
  try {
    const res = await fetch(`${remoteOrigin}/api/sync/push`, {
      method: 'POST',
      headers: buildHeaders(authToken),
      body: JSON.stringify({ changeset, force, dryRun }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Remote sync push failed with HTTP ${res.status}: ${res.statusText}`);
    }

    const pushResult = (await res.json()) as SyncResult;

    if (!dryRun) {
      const now = new Date().toISOString();
      const cursorVal = changeset.generatedAt || now;
      let cursorsUpdate: Record<string, string> | undefined;
      if (pushResult.applied > 0) {
        if (projectId) {
          cursorsUpdate = { [projectId]: cursorVal };
        } else {
          const projects = new Set<string>();
          for (const r of changeset.records) {
            if (r.project) projects.add(r.project);
          }
          if (projects.size > 0) {
            cursorsUpdate = {};
            for (const p of projects) {
              cursorsUpdate[p] = cursorVal;
            }
          }
        }
      }

      const exportedCount = changeset.records.length + (changeset.deletions?.length ?? 0);
      const pushHadConflicts = pushResult.conflicts > 0;
      const pushIncomplete =
        (exportedCount > 0 && pushResult.applied === 0 && pushResult.skipped > 0) ||
        (exportedCount > 0 &&
          pushResult.applied + pushResult.skipped + pushResult.conflicts < exportedCount);

      if (pushHadConflicts || pushIncomplete) {
        const errorMsg = pushHadConflicts
          ? `Remote sync push reported ${pushResult.conflicts} conflict(s)`
          : pushResult.skipped > 0
            ? `Remote sync push skipped ${pushResult.skipped} record(s); pull to reconcile`
            : `Remote sync push applied 0 of ${exportedCount} exported record(s)`;
        writeHybridState(vaultRoot, {
          dirty: true,
          dirtyProjects: projectId ? { [projectId]: true } : undefined,
          lastError: errorMsg,
          lastSyncAt: now,
          cursors: cursorsUpdate
        });
        return pushResult;
      }

      if (projectId) {
        const current = readHybridState(vaultRoot);
        const updatedDirtyProjects = { ...(current.dirtyProjects || {}), [projectId]: false };
        const remainingDirty = Object.entries(updatedDirtyProjects).some(
          ([k, v]) => k !== projectId && Boolean(v)
        );
        writeHybridState(vaultRoot, {
          dirty: remainingDirty,
          dirtyProjects: updatedDirtyProjects,
          lastSyncAt: now,
          lastError: remainingDirty ? current.lastError : null,
          cursors: cursorsUpdate
        });
      } else {
        writeHybridState(vaultRoot, {
          dirty: false,
          dirtyProjects: {},
          lastSyncAt: now,
          lastError: null,
          cursors: cursorsUpdate
        });
      }
    }

    return pushResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logErrorReport({
      subsystem: 'hybrid-sync',
      mode: 'hybrid',
      projectId,
      error: err,
      context: { phase: 'push', remoteOrigin }
    }, { vaultRoot });
    if (projectId) {
      writeHybridState(vaultRoot, {
        dirty: true,
        dirtyProjects: { [projectId]: true },
        lastError: msg
      });
    } else {
      writeHybridState(vaultRoot, {
        dirty: true,
        lastError: msg
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute bidirectional hybrid synchronization (pull then push).
 */
export async function syncHybrid(
  options: HybridSyncOptions = {}
): Promise<HybridSyncReport> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);

  if (config.mode !== 'hybrid') {
    throw new Error(`memo sync is only available in hybrid mode (current mode: ${config.mode || 'local'}).`);
  }

  const isAll = options.all === true;
  const targetProjectId = isAll ? undefined : options.projectId;

  const stateBefore = readHybridState(vaultRoot);
  const isTargetDirty = Boolean(
    stateBefore.dirty && (!targetProjectId || stateBefore.dirtyProjects?.[targetProjectId] !== false)
  );
  const sinceForPush = isTargetDirty
    ? undefined
    : targetProjectId && stateBefore.cursors
      ? stateBefore.cursors[targetProjectId]
      : undefined;

  const pullResult = await pullHybridProject(
    vaultRoot,
    targetProjectId,
    options.remoteUrl,
    options.authToken,
    options.dryRun
  );

  const pushResult = await pushHybridProject(
    vaultRoot,
    targetProjectId,
    options.remoteUrl,
    options.authToken,
    options.dryRun,
    options.force,
    sinceForPush
  );

  return {
    projectId: targetProjectId,
    all: isAll,
    pulled: pullResult,
    pushed: pushResult,
    timestamp: new Date().toISOString()
  };
}

// Debounced push state (timers coalesce bursts; in-flight + pending single-flight per project)
const debounceTimers = new Map<string, { timer: NodeJS.Timeout; fire: () => void }>();
const pushInFlight = new Map<string, Promise<void | SyncResult>>();
const pushPending = new Set<string>();

function startDebouncedPush(vaultRoot: string, projectId: string | undefined, key: string): void {
  if (pushInFlight.has(key)) {
    pushPending.add(key);
    return;
  }

  const job = pushHybridProject(vaultRoot, projectId)
    .catch(() => {
      // Fail open: push error is already recorded in hybrid-state.json
    })
    .finally(() => {
      pushInFlight.delete(key);
      if (pushPending.delete(key)) {
        startDebouncedPush(vaultRoot, projectId, key);
      }
    });

  pushInFlight.set(key, job);
}

/**
 * Schedules debounced push for a projectId in hybrid mode (coalescing rapid bursts).
 */
export function scheduleHybridPush(
  vaultRootInput?: string,
  projectId?: string,
  delayMs: number = 2000
): void {
  const vaultRoot = getVaultRoot(vaultRootInput);
  const config = ensureVaultStructure(vaultRoot);

  if (config.mode !== 'hybrid') {
    return;
  }

  const key = `${vaultRoot}::${projectId || '*'}`;
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const fire = (): void => {
    debounceTimers.delete(key);
    startDebouncedPush(vaultRoot, projectId, key);
  };

  const timer = setTimeout(fire, delayMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  debounceTimers.set(key, { timer, fire });
}

/**
 * Clears all pending debounced push timers (useful for test teardown).
 */
export function clearDebouncedPushes(): void {
  for (const entry of debounceTimers.values()) {
    clearTimeout(entry.timer);
  }
  debounceTimers.clear();
  pushPending.clear();
}

/**
 * Fire pending debounce timers and wait for in-flight (and trailing) pushes.
 */
export async function flushDebouncedPushes(): Promise<void> {
  const drainTimers = (): void => {
    const entries = [...debounceTimers.values()];
    debounceTimers.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.fire();
    }
  };

  drainTimers();
  while (pushInFlight.size > 0 || debounceTimers.size > 0) {
    drainTimers();
    await Promise.all([...pushInFlight.values()]);
  }
}
