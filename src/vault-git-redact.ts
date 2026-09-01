import { redactSecretsInPayload } from './safety.js';

/** Redact credentials in persisted/exposed vault-git error strings. */
export function redactVaultGitError(msg: string | null | undefined): string | null {
  if (msg == null || msg === '') return null;
  let s = String(redactSecretsInPayload(msg));
  s = s.replace(/\/\/([^/@:\s]+):([^@/]+)@/g, '//***:***@');
  return s;
}

export function safeVaultGitError(err: string | undefined): string | undefined {
  if (!err) return undefined;
  return redactVaultGitError(err) ?? undefined;
}
