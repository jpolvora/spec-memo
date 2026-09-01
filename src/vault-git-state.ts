import * as fs from 'node:fs';
import * as path from 'node:path';
import { getVaultRoot, withVaultLockSync } from './vault.js';
import { redactVaultGitError } from './vault-git-redact.js';

export { redactVaultGitError } from './vault-git-redact.js';

export interface VaultGitState {
  dirty: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
}

export const DEFAULT_VAULT_GIT_STATE: VaultGitState = {
  dirty: false,
  lastError: null,
  lastSyncAt: null
};

export function getVaultGitStatePath(vaultRootInput?: string): string {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return path.join(vaultRoot, '.sync', 'vault-git-state.json');
}

export function readVaultGitState(vaultRootInput?: string): VaultGitState {
  const filePath = getVaultGitStatePath(vaultRootInput);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_VAULT_GIT_STATE };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<VaultGitState>;
    return {
      dirty: Boolean(parsed.dirty),
      lastError:
        typeof parsed.lastError === 'string' ? redactVaultGitError(parsed.lastError) : null,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null
    };
  } catch {
    return { ...DEFAULT_VAULT_GIT_STATE };
  }
}

export function writeVaultGitState(
  vaultRootInput: string | undefined,
  updates: Partial<VaultGitState>
): VaultGitState {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return withVaultLockSync(vaultRoot, () => {
    const filePath = getVaultGitStatePath(vaultRoot);
    const syncDir = path.dirname(filePath);
    if (!fs.existsSync(syncDir)) {
      fs.mkdirSync(syncDir, { recursive: true });
    }
    const current = readVaultGitState(vaultRoot);
    const merged: VaultGitState = {
      dirty: updates.dirty !== undefined ? updates.dirty : current.dirty,
      lastError:
        updates.lastError !== undefined
          ? redactVaultGitError(updates.lastError)
          : current.lastError,
      lastSyncAt: updates.lastSyncAt !== undefined ? updates.lastSyncAt : current.lastSyncAt
    };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  });
}
