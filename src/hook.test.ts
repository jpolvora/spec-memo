import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isBlockedWorkflowPath, generatePreCommitHookScript, installPreCommitHook } from './hook.js';

describe('Write-Block Pre-Commit Hook (Phase 2)', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-hook-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it('should block workflow artifact paths (.agents/plans, .agents/specs/*.spec.md, MEMORY.md)', () => {
    assert.equal(isBlockedWorkflowPath('.agents/plans/step-01.md'), true);
    assert.equal(isBlockedWorkflowPath('.agents/specs/feature-x.spec.md'), true);
    assert.equal(isBlockedWorkflowPath('MEMORY.md'), true);
    assert.equal(isBlockedWorkflowPath('subfolder/MEMORY.md'), true);
    assert.equal(isBlockedWorkflowPath('memory/trap-1.md'), true);
  });

  it('should allow legitimate product docs and source files', () => {
    assert.equal(isBlockedWorkflowPath('README.md'), false);
    assert.equal(isBlockedWorkflowPath('PRODUCT.PRD'), false);
    assert.equal(isBlockedWorkflowPath('FEATURES.md'), false);
    assert.equal(isBlockedWorkflowPath('PLAN.md'), false);
    assert.equal(isBlockedWorkflowPath('AGENTS.md'), false);
    assert.equal(isBlockedWorkflowPath('.agents/specs/index.PRD'), false);
    assert.equal(isBlockedWorkflowPath('src/main.ts'), false);
  });

  it('should install pre-commit hook in target git repository', () => {
    const res = installPreCommitHook(tempRepo);
    assert.equal(res.installed, true);
    assert.ok(fs.existsSync(res.path));

    const content = fs.readFileSync(res.path, 'utf8');
    assert.ok(content.includes('SKIP_MEMO_HOOK'));
    assert.ok(content.includes('spec-memo blocked staged workflow artifact'));
  });

  it('should back up an existing unrelated pre-commit hook before overwrite', () => {
    const gitHooksDir = path.join(tempRepo, '.git', 'hooks');
    fs.mkdirSync(gitHooksDir, { recursive: true });
    const hookPath = path.join(gitHooksDir, 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho other-hook\n', { mode: 0o755 });

    installPreCommitHook(tempRepo);

    const backup = `${hookPath}.spec-memo.bak`;
    assert.ok(fs.existsSync(backup));
    assert.ok(fs.readFileSync(backup, 'utf8').includes('other-hook'));
    assert.ok(fs.readFileSync(hookPath, 'utf8').includes('SKIP_MEMO_HOOK'));
  });
});
