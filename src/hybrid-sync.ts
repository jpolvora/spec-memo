import { exportChangeset, applyChangeset, Changeset, SyncResult } from './sync.js';
import { ensureVaultStructure, getVaultProjects, getVaultRoot } from './vault.js';
import { readHybridState, writeHybridState } from './hybrid-state.js';
import { isTokenConfigured, getResolvedAuthToken, normalizeRemoteUrl } from './setup.js';

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
  const timer = setTimeout(() => controller.abort(), 3000);
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
      const updatedCursors = { ...(state.cursors || {}) };
      if (projectId) {
        updatedCursors[projectId] = changeset.generatedAt || now;
      }
      writeHybridState(vaultRoot, {
        lastSyncAt: now,
        lastError: null,
        cursors: updatedCursors
      });
    }

    return applyResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeHybridState(vaultRoot, {
      dirty: true,
      lastError: msg
    });
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
  force: boolean = false
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
  const changeset = exportChangeset(vaultRoot, { projectId, since });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
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
      const updatedCursors = { ...(state.cursors || {}) };
      if (projectId) {
        updatedCursors[projectId] = changeset.generatedAt || now;
      }
      writeHybridState(vaultRoot, {
        lastSyncAt: now,
        lastError: null,
        cursors: updatedCursors
      });
    }

    return pushResult;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeHybridState(vaultRoot, {
      dirty: true,
      lastError: msg
    });
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
    options.force
  );

  return {
    projectId: targetProjectId,
    all: isAll,
    pulled: pullResult,
    pushed: pushResult,
    timestamp: new Date().toISOString()
  };
}

// Debounced push state
const debounceTimers = new Map<string, NodeJS.Timeout>();

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
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    debounceTimers.delete(key);
    try {
      await pushHybridProject(vaultRoot, projectId);
    } catch {
      // Fail open: push error is already recorded in hybrid-state.json
    }
  }, delayMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  debounceTimers.set(key, timer);
}

/**
 * Clears all pending debounced push timers (useful for test teardown).
 */
export function clearDebouncedPushes(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
