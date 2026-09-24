import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type ResidueVerdict = 'active' | 'completed' | 'stale';

export interface ResidueInput {
  rel: string;
  mtimeMs: number;
  workflowStatus?: string | null;
  nowMs?: number;
}

export interface ResidueResult {
  rel: string;
  verdict: ResidueVerdict;
  evidence: string;
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read-only classifier for gitignored workflow-plan residue (AC2).
 * Never deletes or rewrites plan artifacts; returns verdict + evidence only.
 */
export function classifyWorkflowResidue(inputs: ResidueInput[]): ResidueResult[] {
  const now = Date.now();
  return inputs.map((item) => {
    const at = item.nowMs ?? now;
    const status = (item.workflowStatus ?? '').toLowerCase();
    if (status === 'active' || status === 'paused') {
      return { rel: item.rel, verdict: 'active', evidence: `state status=${item.workflowStatus}` };
    }
    if (status === 'completed' || status === 'merged' || status === 'shipped') {
      return { rel: item.rel, verdict: 'completed', evidence: `state status=${item.workflowStatus}` };
    }
    const age = at - item.mtimeMs;
    if (age < 0 || age <= STALE_AFTER_MS) {
      return { rel: item.rel, verdict: 'active', evidence: `mtime ${(Math.max(age, 0) / 86400000).toFixed(1)}d ago, no completed state` };
    }
    return { rel: item.rel, verdict: 'stale', evidence: `mtime ${(age / 86400000).toFixed(1)}d ago, no active state` };
  });
}

export interface DestructiveGate {
  backupFresh: boolean;
  manifestsReviewed: boolean;
  explicitConfirm: boolean;
}

/**
 * Backup-gated destructive-work guard (AC4). Throws naming every missing
 * precondition; returns true only when backup + review + confirm all hold.
 */
export function requireDestructiveGate(gate: DestructiveGate): true {
  const missing: string[] = [];
  if (!gate.backupFresh) missing.push('fresh backup');
  if (!gate.manifestsReviewed) missing.push('reviewed manifests');
  if (!gate.explicitConfirm) missing.push('explicit confirmation');
  if (missing.length > 0) {
    throw new Error(`Destructive work blocked until: ${missing.join(', ')}.`);
  }
  return true;
}

export interface BaselineSnapshot {
  files: number;
  idsHash: string;
}

/**
 * Read-only baseline snapshot (AC1): walks canonical record dirs, hashes
 * sorted record ids. Performs zero writes.
 */
export function snapshotBaseline(vaultRoot: string): BaselineSnapshot {
  const subdirs = ['traps', 'decisions', 'specs', 'plans', 'logs', 'reviews', 'scratch', 'prompts', 'sessions'];
  const ids: string[] = [];
  let files = 0;
  const projectsDir = path.join(vaultRoot, 'projects');
  if (!fs.existsSync(projectsDir)) return { files: 0, idsHash: createHash('sha256').update('').digest('hex') };
  for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const sub of subdirs) {
      const dir = path.join(projectsDir, project.name, sub);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
        files++;
        try {
          const text = fs.readFileSync(path.join(dir, file), 'utf8');
          const m = /^id:\s*(\S+)/m.exec(text) || /"(id)"\s*:\s*"([^"]+)"/.exec(text);
          const id = m ? (m[1] === 'id' ? m[2] : m[1]) : file;
          ids.push(String(id));
        } catch {
          ids.push(file);
        }
      }
    }
  }
  ids.sort();
  return { files, idsHash: createHash('sha256').update(ids.join('\n')).digest('hex') };
}
