import * as fs from 'node:fs';
import * as path from 'node:path';
import { HybridState } from './types.js';
import { getVaultRoot, withVaultLockSync } from './vault.js';

export const DEFAULT_HYBRID_STATE: HybridState = {
  dirty: false,
  lastSyncAt: null,
  lastError: null,
  cursors: {},
  dirtyProjects: {}
};

export function getHybridStatePath(vaultRootInput?: string): string {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return path.join(vaultRoot, '.sync', 'hybrid-state.json');
}

export function readHybridState(vaultRootInput?: string): HybridState {
  const filePath = getHybridStatePath(vaultRootInput);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_HYBRID_STATE };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      dirty: Boolean(parsed.dirty),
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      cursors: typeof parsed.cursors === 'object' && parsed.cursors !== null ? parsed.cursors : {},
      dirtyProjects: typeof parsed.dirtyProjects === 'object' && parsed.dirtyProjects !== null ? parsed.dirtyProjects : {}
    };
  } catch {
    return { ...DEFAULT_HYBRID_STATE };
  }
}

export function writeHybridState(
  vaultRootInput: string | undefined,
  updates: Partial<HybridState>
): HybridState {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return withVaultLockSync(vaultRoot, () => {
    const filePath = getHybridStatePath(vaultRoot);
    const syncDir = path.dirname(filePath);

    if (!fs.existsSync(syncDir)) {
      fs.mkdirSync(syncDir, { recursive: true });
    }

    const current = readHybridState(vaultRoot);
    let mergedCursors = current.cursors || {};
    if (updates.cursors !== undefined) {
      mergedCursors = { ...mergedCursors };
      for (const [pId, newCursor] of Object.entries(updates.cursors)) {
        const existing = mergedCursors[pId];
        if (!existing || newCursor >= existing) {
          mergedCursors[pId] = newCursor;
        }
      }
    }

    let mergedDirtyProjects = current.dirtyProjects || {};
    if (updates.dirtyProjects !== undefined) {
      mergedDirtyProjects = { ...mergedDirtyProjects, ...updates.dirtyProjects };
    }

    let effectiveDirty = current.dirty;
    if (updates.dirty !== undefined) {
      effectiveDirty = updates.dirty;
    } else if (updates.dirtyProjects !== undefined) {
      effectiveDirty = Object.values(mergedDirtyProjects).some(Boolean);
    }

    if (updates.dirty === false) {
      mergedDirtyProjects = {};
    }

    const merged: HybridState = {
      dirty: effectiveDirty,
      lastSyncAt: updates.lastSyncAt !== undefined ? updates.lastSyncAt : current.lastSyncAt,
      lastError: updates.lastError !== undefined ? updates.lastError : (effectiveDirty ? current.lastError : null),
      cursors: mergedCursors,
      dirtyProjects: mergedDirtyProjects
    };

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  });
}

/**
 * Migrate per-project sync state across rename/merge (AC18): moves hybrid
 * cursors (max-wins when the target already has one) and OR-combines
 * per-project dirty flags from each source id to its target id, deleting the
 * source keys so no split cursors, split dirty flags, or split ownership can
 * survive the operation. Top-level dirty is never cleared here.
 */
export function migrateProjectSyncState(
  vaultRootInput: string | undefined,
  moves: Record<string, string>
): { movedCursors: number; movedDirty: number } {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return withVaultLockSync(vaultRoot, () => {
    const filePath = getHybridStatePath(vaultRoot);
    if (!fs.existsSync(filePath)) return { movedCursors: 0, movedDirty: 0 };
    let parsed: { cursors?: Record<string, string>; dirtyProjects?: Record<string, boolean> };
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return { movedCursors: 0, movedDirty: 0 };
    }
    const cursors: Record<string, string> = { ...(parsed.cursors || {}) };
    const dirtyProjects: Record<string, boolean> = { ...(parsed.dirtyProjects || {}) };
    let movedCursors = 0;
    let movedDirty = 0;
    for (const [from, to] of Object.entries(moves)) {
      if (!from || !to || from === to) continue;
      if (from in cursors) {
        const sv = String(cursors[from]);
        delete cursors[from];
        movedCursors++;
        if (!(to in cursors) || sv > String(cursors[to])) cursors[to] = sv;
      }
      if (from in dirtyProjects) {
        const dv = Boolean(dirtyProjects[from]);
        delete dirtyProjects[from];
        movedDirty++;
        dirtyProjects[to] = Boolean(dirtyProjects[to]) || dv;
      }
    }
    parsed.cursors = cursors;
    parsed.dirtyProjects = dirtyProjects;
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    return { movedCursors, movedDirty };
  });
}

