import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { HandoffPayload, HandoffRecord, SessionObjective } from './types.js';
import { withVaultLockSync } from './vault.js';
import { recordTelemetry } from './telemetry.js';

const HANDOFFS_SUBDIR = '.sync/handoffs';
const OBJECTIVES_SUBDIR = '.sync/objectives';
const SHARED_FILENAME = '_shared.json';

export function resolveGitBranch(cwd: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return branch || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function resolveOwner(cwd: string): string {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (email) return email;
    const name = execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (name) return name;
  } catch {
    // fall through
  }
  try {
    return os.userInfo().username || 'local';
  } catch {
    return 'local';
  }
}

function sanitizeKeyPart(value: string): string {
  return encodeURIComponent(value.replace(/[/\\]/g, '_')).slice(0, 120);
}

function handoffFileName(owner: string, branch: string, shared: boolean): string {
  if (shared) return SHARED_FILENAME;
  return `${sanitizeKeyPart(owner)}__${sanitizeKeyPart(branch)}.json`;
}

function handoffsDir(projectDir: string): string {
  const dir = path.join(projectDir, HANDOFFS_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function objectivesDir(projectDir: string): string {
  const dir = path.join(projectDir, OBJECTIVES_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function objectiveFileName(owner: string, branch: string): string {
  return `${sanitizeKeyPart(owner)}__${sanitizeKeyPart(branch)}.json`;
}

function readHandoffFile(filePath: string): HandoffRecord | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as HandoffRecord;
    if (!parsed || parsed.claimed) return null;
    if (!Array.isArray(parsed.nextSteps) || parsed.nextSteps.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeHandoffFile(filePath: string, record: HandoffRecord): void {
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
}

export function createHandoff(options: {
  projectDir: string;
  cwd: string;
  payload: HandoffPayload;
  sessionId?: string;
  harness?: string;
  vaultRoot?: string;
  projectId?: string;
}): HandoffRecord {
  const owner = options.payload.owner || resolveOwner(options.cwd);
  const branch = options.payload.branch || resolveGitBranch(options.cwd);
  const shared = Boolean(options.payload.shared);
  const nextSteps = options.payload.nextSteps.filter((s) => typeof s === 'string' && s.trim());
  if (nextSteps.length === 0) {
    throw new Error('handoff.nextSteps must contain at least one non-empty step.');
  }

  const record: HandoffRecord = {
    id: `handoff-${Date.now()}-${randomBytes(3).toString('hex')}`,
    owner,
    branch,
    shared,
    nextSteps,
    failedApproaches: options.payload.failedApproaches?.filter(Boolean),
    openQuestions: options.payload.openQuestions?.filter(Boolean),
    harness: options.harness,
    createdAt: new Date().toISOString(),
    sessionId: options.sessionId,
    claimed: false
  };

  const dir = handoffsDir(options.projectDir);
  const filePath = path.join(dir, handoffFileName(owner, branch, shared));
  writeHandoffFile(filePath, record);

  recordTelemetry({
    category: 'handoff',
    operation: 'handoff_created',
    durationMs: 0,
    success: true,
    vaultRoot: options.vaultRoot,
    projectId: options.projectId,
    metadata: {
      sessionId: options.sessionId,
      branch,
      owner,
      shared,
      handoffId: record.id
    }
  });

  return record;
}

export function listPendingHandoffs(projectDir: string): HandoffRecord[] {
  const dir = path.join(projectDir, HANDOFFS_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  const results: HandoffRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const record = readHandoffFile(path.join(dir, name));
    if (record) results.push(record);
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function matchEligibleHandoff(
  handoffs: HandoffRecord[],
  owner: string,
  branch: string
): HandoffRecord | null {
  const ownerBranch = handoffs.filter(
    (h) =>
      !h.claimed &&
      !h.shared &&
      h.owner === owner &&
      h.branch === branch
  );
  if (ownerBranch.length > 0) {
    return ownerBranch.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  const shared = handoffs.filter((h) => !h.claimed && h.shared);
  if (shared.length > 0) {
    return shared.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  return null;
}

export function peekEligibleHandoff(options: {
  projectDir: string;
  cwd: string;
  owner?: string;
  branch?: string;
}): HandoffRecord | null {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const pending = listPendingHandoffs(options.projectDir);
  return matchEligibleHandoff(pending, owner, branch);
}

export function findHandoffFile(projectDir: string, record: HandoffRecord): string | null {
  const dir = path.join(projectDir, HANDOFFS_SUBDIR);
  const expected = handoffFileName(record.owner, record.branch, record.shared);
  const candidate = path.join(dir, expected);
  if (fs.existsSync(candidate)) return candidate;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HandoffRecord;
      if (parsed.id === record.id) return filePath;
    } catch {
      // skip malformed
    }
  }
  return null;
}

export function claimHandoff(options: {
  projectDir: string;
  record: HandoffRecord;
  claimedBySession?: string;
  vaultRoot?: string;
  projectId?: string;
}): HandoffRecord {
  const filePath = findHandoffFile(options.projectDir, options.record);
  if (!filePath) {
    throw new Error(`Handoff '${options.record.id}' not found or already claimed.`);
  }

  const now = new Date().toISOString();
  const claimed: HandoffRecord = {
    ...options.record,
    claimed: true,
    claimedAt: now,
    claimedBySession: options.claimedBySession
  };
  writeHandoffFile(filePath, claimed);

  recordTelemetry({
    category: 'handoff',
    operation: 'handoff_claimed',
    durationMs: 0,
    success: true,
    vaultRoot: options.vaultRoot,
    projectId: options.projectId,
    metadata: {
      sessionId: options.claimedBySession,
      branch: claimed.branch,
      owner: claimed.owner,
      shared: claimed.shared,
      handoffId: claimed.id
    }
  });

  return claimed;
}

export function cancelHandoffForContext(options: {
  projectDir: string;
  cwd: string;
  owner?: string;
  branch?: string;
}): boolean {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const dir = path.join(options.projectDir, HANDOFFS_SUBDIR);
  const filePath = path.join(dir, handoffFileName(owner, branch, false));
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function dismissHandoffById(projectDir: string, handoffId: string): boolean {
  const dir = path.join(projectDir, HANDOFFS_SUBDIR);
  if (!fs.existsSync(dir)) return false;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HandoffRecord;
      if (parsed.id === handoffId && !parsed.claimed) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch {
      // skip
    }
  }
  return false;
}

export function getActiveHandoffForContext(options: {
  projectDir: string;
  cwd: string;
  owner?: string;
  branch?: string;
}): HandoffRecord | null {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const pending = listPendingHandoffs(options.projectDir);
  return matchEligibleHandoff(pending, owner, branch);
}

export function renderHandoffMarkdown(record: HandoffRecord): string {
  const lines = [
    '## 🤝 Active Session Handoff',
    '',
    `- **From:** ${record.harness || 'unknown harness'}`,
    `- **Owner:** ${record.owner}`,
    `- **Branch:** ${record.branch}${record.shared ? ' (shared)' : ''}`,
    '',
    '### Next steps',
    ...record.nextSteps.map((s) => `- ${s}`)
  ];
  if (record.failedApproaches && record.failedApproaches.length > 0) {
    lines.push('', '### Failed approaches', ...record.failedApproaches.map((s) => `- ${s}`));
  }
  if (record.openQuestions && record.openQuestions.length > 0) {
    lines.push('', '### Open questions', ...record.openQuestions.map((s) => `- ${s}`));
  }
  return lines.join('\n');
}

export function setSessionObjective(options: {
  projectDir: string;
  cwd: string;
  objective: string;
  owner?: string;
  branch?: string;
  sessionId?: string;
}): SessionObjective {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const record: SessionObjective = {
    owner,
    branch,
    objective: options.objective.trim(),
    sessionId: options.sessionId,
    updatedAt: new Date().toISOString()
  };
  const dir = objectivesDir(options.projectDir);
  const filePath = path.join(dir, objectiveFileName(owner, branch));
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function getSessionObjective(options: {
  projectDir: string;
  cwd: string;
  owner?: string;
  branch?: string;
  requireActiveSession?: boolean;
}): SessionObjective | null {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const filePath = path.join(objectivesDir(options.projectDir), objectiveFileName(owner, branch));
  if (!fs.existsSync(filePath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionObjective;
    if (options.requireActiveSession !== false && record.sessionId) {
      const sessionPath = path.join(options.projectDir, 'sessions', `session-${record.sessionId}.md`);
      if (!fs.existsSync(sessionPath)) return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function clearSessionObjective(options: {
  projectDir: string;
  cwd: string;
  owner?: string;
  branch?: string;
}): void {
  const owner = options.owner || resolveOwner(options.cwd);
  const branch = options.branch || resolveGitBranch(options.cwd);
  const filePath = path.join(objectivesDir(options.projectDir), objectiveFileName(owner, branch));
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function deliverAndClaimHandoff(options: {
  projectDir: string;
  cwd: string;
  vaultRoot: string;
  sessionId?: string;
  projectId?: string;
  owner?: string;
  branch?: string;
}): HandoffRecord | null {
  return withVaultLockSync(options.vaultRoot, () => {
    const owner = options.owner || resolveOwner(options.cwd);
    const branch = options.branch || resolveGitBranch(options.cwd);
    const pending = listPendingHandoffs(options.projectDir);
    const matched = matchEligibleHandoff(pending, owner, branch);
    if (!matched) return null;
    return claimHandoff({
      projectDir: options.projectDir,
      record: matched,
      claimedBySession: options.sessionId,
      vaultRoot: options.vaultRoot,
      projectId: options.projectId
    });
  });
}

export function writeHandoffOnSessionEnd(options: {
  projectDir: string;
  cwd: string;
  vaultRoot: string;
  payload: HandoffPayload;
  sessionId?: string;
  harness?: string;
  projectId?: string;
}): HandoffRecord | undefined {
  if (!options.payload?.nextSteps?.length) return undefined;
  return withVaultLockSync(options.vaultRoot, () =>
    createHandoff({
      projectDir: options.projectDir,
      cwd: options.cwd,
      payload: options.payload,
      sessionId: options.sessionId,
      harness: options.harness,
      vaultRoot: options.vaultRoot,
      projectId: options.projectId
    })
  );
}
