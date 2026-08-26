import * as fs from 'node:fs';
import * as path from 'node:path';
import { HybridState } from './types.js';
import { getVaultRoot, withVaultLockSync } from './vault.js';

export const DEFAULT_HYBRID_STATE: HybridState = {
  dirty: false,
  lastSyncAt: null,
  lastError: null,
  cursors: {}
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
      cursors: typeof parsed.cursors === 'object' && parsed.cursors !== null ? parsed.cursors : {}
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

    const merged: HybridState = {
      dirty: updates.dirty !== undefined ? updates.dirty : current.dirty,
      lastSyncAt: updates.lastSyncAt !== undefined ? updates.lastSyncAt : current.lastSyncAt,
      lastError: updates.lastError !== undefined ? updates.lastError : current.lastError,
      cursors: mergedCursors
    };

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  });
}
