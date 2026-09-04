import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compileBootstrapBrief } from './bootstrap.js';
import { startSessionRecord, endSessionRecord, cancelHandoffRecord, showHandoffRecord } from './prompt.js';
import {
  createHandoff,
  getActiveHandoffForContext,
  listPendingHandoffs,
  matchEligibleHandoff,
  resolveGitBranch,
  resolveOwner
} from './handoff.js';
import { ensureVaultStructure } from './vault.js';

function createTempVault(): { vaultRoot: string; projectId: string; projectDir: string; cleanup: () => void } {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-handoff-'));
  ensureVaultStructure(vaultRoot);
  const projectId = 'test-project-handoff';
  const projectDir = path.join(vaultRoot, 'projects', projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ projectId, lastSeenRoot: process.cwd(), updatedAt: new Date().toISOString() }),
    'utf8'
  );
  return {
    vaultRoot,
    projectId,
    projectDir,
    cleanup: () => {
      try {
        fs.rmSync(vaultRoot, { recursive: true, force: true });
      } catch {
        // Windows lock tolerance
      }
    }
  };
}

test('handoff owner/branch isolation prevents cross-branch delivery', async () => {
  const { vaultRoot, projectId, projectDir, cleanup } = createTempVault();
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['Fix cookie test'], branch: 'feat/auth', owner: 'alice@test.dev' },
      sessionId: 's1',
      vaultRoot,
      projectId
    });

    const pending = listPendingHandoffs(projectDir);
    assert.equal(pending.length, 1);

    const wrongBranch = matchEligibleHandoff(pending, 'alice@test.dev', 'fix/db');
    assert.equal(wrongBranch, null);

    const wrongOwner = matchEligibleHandoff(pending, 'bob@test.dev', 'feat/auth');
    assert.equal(wrongOwner, null);

    const match = matchEligibleHandoff(pending, 'alice@test.dev', 'feat/auth');
    assert.ok(match);
    assert.equal(match.nextSteps[0], 'Fix cookie test');
  } finally {
    cleanup();
  }
});

test('shared handoff is visible to any owner on any branch', () => {
  const { projectDir, cleanup } = createTempVault();
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['Deploy staging'], shared: true },
      sessionId: 's2'
    });
    const pending = listPendingHandoffs(projectDir);
    const match = matchEligibleHandoff(pending, 'anyone@test.dev', 'any-branch');
    assert.ok(match?.shared);
  } finally {
    cleanup();
  }
});

test('session_end writes handoff and bootstrap claims it once', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  const owner = resolveOwner(process.cwd());
  const branch = resolveGitBranch(process.cwd());
  try {
    await startSessionRecord({ vaultRoot, projectId, sessionId: 'handoff-s1', cwd: process.cwd() });
    await endSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'handoff-s1',
      cwd: process.cwd(),
      body: 'Done for now',
      handoff: {
        nextSteps: ['Run npm test', 'Ship PR'],
        failedApproaches: ['Mock-only fix'],
        openQuestions: ['Need review?'],
        owner,
        branch
      },
      ide: 'cursor'
    });

    const before = showHandoffRecord({ vaultRoot, projectId, cwd: process.cwd() });
    assert.ok(before.handoff);
    assert.equal(before.handoff?.claimed, false);

    const brief1 = await compileBootstrapBrief({ vaultRoot, projectId, cwd: process.cwd(), sessionId: 'incoming-1' });
    assert.ok(brief1.handoff);
    assert.ok(brief1.handoffMarkdown?.includes('Active Session Handoff'));

    const brief2 = await compileBootstrapBrief({ vaultRoot, projectId, cwd: process.cwd(), sessionId: 'incoming-2' });
    assert.equal(brief2.handoff, undefined);

    const after = showHandoffRecord({ vaultRoot, projectId, cwd: process.cwd() });
    assert.equal(after.handoff, null);
  } finally {
    cleanup();
  }
});

test('cancel handoff exits cleanly when none exists', () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    const result = cancelHandoffRecord({ vaultRoot, projectId, cwd: process.cwd() });
    assert.equal(result.cancelled, false);
  } finally {
    cleanup();
  }
});

test('new handoff supersedes previous for same owner and branch', () => {
  const { projectDir, cleanup } = createTempVault();
  const owner = 'alice@test.dev';
  const branch = 'feat/x';
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['Old step'], owner, branch }
    });
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['New step'], owner, branch }
    });
    const pending = listPendingHandoffs(projectDir).filter((h) => !h.shared && h.owner === owner && h.branch === branch);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].nextSteps[0], 'New step');
  } finally {
    cleanup();
  }
});

test('getActiveHandoffForContext returns branch-scoped pending baton', () => {
  const { projectDir, cleanup } = createTempVault();
  const owner = 'alice@test.dev';
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['On auth branch'], owner, branch: 'feat/auth' }
    });
    const active = getActiveHandoffForContext({
      projectDir,
      cwd: process.cwd(),
      owner,
      branch: 'feat/auth'
    });
    assert.ok(active);
    assert.equal(active?.branch, 'feat/auth');
  } finally {
    cleanup();
  }
});

test('session_start claims eligible handoff baton', async () => {
  const { vaultRoot, projectId, projectDir, cleanup } = createTempVault();
  const owner = resolveOwner(process.cwd());
  const branch = resolveGitBranch(process.cwd());
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['Continue refactor'], owner, branch },
      sessionId: 'writer'
    });
    const start = await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'incoming-s2',
      cwd: process.cwd()
    });
    assert.ok(start.handoff);
    assert.equal(start.handoff?.claimed, true);
    const after = showHandoffRecord({ vaultRoot, projectId, cwd: process.cwd() });
    assert.equal(after.handoff, null);
  } finally {
    cleanup();
  }
});

test('bootstrap preserves handoff when trap trimming is required', async () => {
  const { vaultRoot, projectId, projectDir, cleanup } = createTempVault();
  const owner = resolveOwner(process.cwd());
  const branch = resolveGitBranch(process.cwd());
  try {
    createHandoff({
      projectDir,
      cwd: process.cwd(),
      payload: { nextSteps: ['Ship handoff slice'], owner, branch },
      sessionId: 'writer'
    });
    for (let i = 0; i < 40; i++) {
      const trapDir = path.join(projectDir, 'traps');
      fs.mkdirSync(trapDir, { recursive: true });
      fs.writeFileSync(
        path.join(trapDir, `trap-${i}.md`),
        `---\nid: trap-${i}\nkind: trap\nstatus: active\nseverity: low\ntitle: Trap ${i}\nupdated: 2026-09-04T00:00:00.000Z\n---\n${'x'.repeat(400)}`,
        'utf8'
      );
    }
    const brief = await compileBootstrapBrief({
      vaultRoot,
      projectId,
      cwd: process.cwd(),
      maxBytes: 8192,
      sessionId: 'budget-test'
    });
    assert.ok(brief.handoffMarkdown?.includes('Ship handoff slice'));
    assert.ok(brief.handoff?.claimed);
  } finally {
    cleanup();
  }
});
