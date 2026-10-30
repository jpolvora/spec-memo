'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execSync } = require('child_process');
const stateManager = require('./state_manager.cjs');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Renders the dispatch prompt for a DAG task (Spec 028).
 *
 * The prompt is a complete brief: assigned criteria verbatim, the criteria it
 * must not regress, its target files, a scope fence, dependency context,
 * partial progress inherited from an abandoned dispatch, explicit prohibitions,
 * an honest evidence template, a report contract, and the finish command.
 */
function renderTaskPrompt(options) {
  const {
    targetRoot, specSlug, specPath, runId, stateDir, task, specAcs, useWorktrees, taskWorktreeRel,
    dagTasks, taskStates, abandonments, absolutePaths, refineMode
  } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const absStateDir = stateDir ? (path.isAbsolute(stateDir) ? stateDir : path.resolve(root, stateDir)) : path.join(root, '.sdw', 'state');
  const taskPromptDir = path.join(absStateDir, specSlug, runId);

  if (!fs.existsSync(taskPromptDir)) {
    fs.mkdirSync(taskPromptDir, { recursive: true });
  }

  const promptFileAbs = path.join(taskPromptDir, `task-${task.id}.prompt.md`);
  const evidenceFileAbs = path.join(taskPromptDir, `task-${task.id}.evidence.json`);

  const promptFileRel = normalizePath(path.relative(root, promptFileAbs));
  const evidenceFileRel = normalizePath(path.relative(root, evidenceFileAbs));

  const workingDirRel = (useWorktrees && taskWorktreeRel) ? normalizePath(taskWorktreeRel) : '.';
  const workingDirDisplay = absolutePaths ? normalizePath(root) : workingDirRel;
  const evidenceDisplay = absolutePaths ? normalizePath(evidenceFileAbs) : evidenceFileRel;

  const coveredAcs = Array.isArray(task.coveredAcs) ? task.coveredAcs : [];
  const normalizedAcs = Array.isArray(specAcs)
    ? specAcs.map(ac => (typeof ac === 'string' ? { id: ac, text: '' } : { id: ac.id, text: ac.text || '' }))
    : [];

  const assignedAcs = normalizedAcs.filter(ac => coveredAcs.includes(ac.id));
  const remainingAcs = normalizedAcs.filter(ac => !coveredAcs.includes(ac.id));

  const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
  const acceptedById = (taskStates && typeof taskStates === 'object') ? taskStates : {};

  let prompt = `# Implementation Task Prompt: ${task.id} (${specSlug})\n\n`;

  prompt += `## Task Context\n`;
  prompt += `- **Task ID:** ${task.id}\n`;
  prompt += `- **Task Title:** ${task.title || task.id}\n`;
  prompt += `- **Specification:** ${specPath ? normalizePath(specPath) : '(not recorded)'}\n`;
  prompt += `- **Specification Slug:** ${specSlug}\n`;
  prompt += `- **Run ID:** ${runId}\n`;
  prompt += `- **Working Directory:** \`${workingDirDisplay}\`\n`;
  prompt += `- **Evidence File Destination:** \`${evidenceDisplay}\`\n\n`;

  if (refineMode) {
    prompt += `## Second Pass (Refinement) Mode\n`;
    prompt += `This specification is already delivered. Your first job is to close the distance between the specification and the code; simplification comes second.\n`;
    prompt += `1. Audit every acceptance criterion against the current implementation, including call sites, tests, configuration, and documentation.\n`;
    prompt += `2. Fill what is missing or drifted: when the specification states behavior that is absent, partial, or implemented differently, implement it now. Drift also covers stale documentation, configuration, schema entries, and tests that no longer match the delivered behavior. This gap closure is inside the specification's scope and is expected.\n`;
    prompt += `3. Then look for concrete simplification and quality opportunities in the files you are already touching: duplicated or dead logic, needless abstraction, missing validation, redundant tests.\n`;
    prompt += `4. Do not add features the specification does not require, do not rename for taste, and do not refactor unrelated code. No behavior changes beyond the gaps and drift the specification requires.\n`;
    prompt += `5. Report each criterion as already satisfied, gap filled, or drift repaired. \`filesChanged: []\` is honest only when every criterion already holds and no drift remains.\n`;
    prompt += `6. Your \`summary\` must list each gap, drift, and opportunity you considered and whether you applied or skipped it, with the reason.\n\n`;
  }

  prompt += `## Description\n`;
  prompt += `${task.description || 'Implement the assigned requirements in accordance with the specification.'}\n\n`;

  prompt += `## Assigned Acceptance Criteria\n`;
  if (assignedAcs.length > 0) {
    assignedAcs.forEach(ac => { prompt += `- ${ac.id}: ${ac.text || '(see specification)'}\n`; });
  } else {
    prompt += `- (none assigned; treat the task description as the requirement)\n`;
  }
  prompt += `\n`;

  if (remainingAcs.length > 0) {
    prompt += `## Remaining Acceptance Criteria (do not regress)\n`;
    prompt += `Other tasks own these criteria. Do not claim them and do not break them:\n`;
    prompt += remainingAcs.map(ac => `- ${ac.id}`).join('\n') + `\n\n`;
  }

  prompt += `## Target Files\n`;
  if (Array.isArray(task.targetFiles) && task.targetFiles.length > 0) {
    task.targetFiles.forEach(f => { prompt += `- \`${normalizePath(f)}\`\n`; });
  } else {
    prompt += `- No explicit targets. Modify the minimum number of files required to satisfy the assigned criteria.\n`;
  }
  prompt += `\n`;

  prompt += `## Scope Fence\n`;
  prompt += `- **Permitted:** the target files above, plus new files required by the assigned criteria.\n`;
  prompt += `- **Forbidden:** files owned by other tasks, \`.sdw/state/**\`, task prompt and evidence files of other tasks, and \`.git/**\`.\n`;
  if (specPath) {
    prompt += `- **Forbidden:** editing the specification (\`${normalizePath(specPath)}\`); report a needed spec change instead.\n`;
  }
  prompt += `\n`;

  if (dependencies.length > 0) {
    const acceptedDeps = dependencies
      .map(depId => ({ depId, record: acceptedById[depId] }))
      .filter(entry => entry.record && entry.record.status === 'completed');
    if (acceptedDeps.length > 0) {
      prompt += `## Dependency Context\n`;
      prompt += `Previously accepted tasks this task builds on:\n`;
      acceptedDeps.forEach(({ depId, record }) => {
        const files = Array.isArray(record.filesChanged) && record.filesChanged.length > 0
          ? record.filesChanged.map(normalizePath).join(', ')
          : '(no files recorded)';
        const summary = String(record.summary || '(no summary recorded)').replace(/\s+/g, ' ').trim();
        prompt += `- ${depId}: ${summary} — files: ${files}\n`;
      });
      prompt += `\n`;
    }
  }

  const abandoned = Array.isArray(abandonments)
    ? abandonments.filter(entry => entry && entry.taskId === task.id)
    : [];
  if (abandoned.length > 0) {
    const lastAbandonment = abandoned[abandoned.length - 1];
    const dirty = collectModifiedPaths(root);
    prompt += `## Prior Partial Progress\n`;
    prompt += `A previous worker was abandoned for this task: ${lastAbandonment.reason || 'no reason recorded'}.\n`;
    if (dirty.length > 0) {
      prompt += `The working tree already carries modifications. Inspect them first and keep what is correct; do not revert blindly:\n`;
      dirty.slice(0, 20).forEach(f => { prompt += `- \`${f}\`\n`; });
      if (dirty.length > 20) prompt += `- ... and ${dirty.length - 20} more modified path(s)\n`;
    } else {
      prompt += `The working tree carries no modifications, so start from the current files.\n`;
    }
    prompt += `\n`;
  }

  if (task.contextPrompt) {
    prompt += `## Architectural Guidance\n`;
    prompt += `${task.contextPrompt}\n\n`;
  }

  prompt += `## Implementation Rules (sdw-rules)\n`;
  prompt += `Load and follow the shared \`sdw-rules\` skill before acting (installed under \`.agents/skills/sdw-rules/\` or \`skills/sdw-rules/\`). It is the canonical source for the rules below.\n`;
  prompt += `- **Simplicity first:** write the minimum code that satisfies the assigned criteria; no speculative abstraction, layering, or configurability.\n`;
  prompt += `- **Surgical changes:** touch only the scope fence; no drive-by refactors, renames, or formatting churn.\n`;
  prompt += `- **No unrequested features:** implement exactly what the assigned criteria require.\n\n`;

  prompt += `## Test Discipline\n`;
  prompt += `- **While iterating:** run only the focused check for the files you touched, such as the single test file that covers them, one case, or \`node --check\` for syntax; do not re-run the full suite after every edit.\n`;
  prompt += `- **Full suite only when required:** the change touches a shared helper, an area shared by several tasks, or a gate failure outside this task's scope; record the run and the reason in \`tests\`.\n`;
  prompt += `- **Before reporting:** run the full suite once and record that run in \`tests\`.\n\n`;

  prompt += `## Prohibited Actions\n`;
  prompt += `- Do not run \`git commit\`, \`git push\`, \`git branch\`, \`git checkout\`, \`git worktree\`, or \`git tag\`. The orchestrator owns version control.\n`;
  prompt += `- Do not spawn subagents or delegate this task to another agent.\n`;
  prompt += `- Do not modify files outside the scope fence.\n`;
  prompt += `- Do not write run state, prompt files, or the specification.\n`;
  prompt += `- Do not record a test you did not execute.\n`;
  prompt += `- Do not report \`status: "success"\` while any assigned criterion is unmet.\n\n`;

  prompt += `## Evidence Schema (\`${evidenceDisplay}\`)\n`;
  prompt += `Write this file when the work is done. Fill every field honestly; no field is pre-filled:\n`;
  prompt += `\`\`\`json\n`;
  prompt += JSON.stringify({
    taskId: task.id,
    status: '',
    acIds: [],
    filesChanged: [],
    tests: [],
    summary: ''
  }, null, 2) + `\n`;
  prompt += `\`\`\`\n`;
  prompt += `- \`status\`: \`success\` when every assigned criterion is met; otherwise \`partial\`, \`failed\`, or \`blocked\`.\n`;
  prompt += `- \`acIds\`: the assigned criteria this task satisfies.\n`;
  prompt += `- \`filesChanged\`: project-relative paths you actually modified or created${refineMode ? '; \`[]\` is required when the refinement changed nothing' : ''}.\n`;
  prompt += `- \`tests\`: only commands you actually ran, with their real result; \`[]\` when nothing is testable.\n`;
  prompt += `- \`summary\`: one or two sentences describing what changed.\n\n`;

  prompt += `## Report Contract\n`;
  prompt += `Reply to the parent agent with a compact report, not code and not logs:\n`;
  prompt += `1. \`taskId\` and \`status\` (\`success\`, \`partial\`, \`failed\`, or \`blocked\`).\n`;
  prompt += `2. The project-relative \`filesChanged\` list.\n`;
  prompt += `3. The acceptance criteria ids satisfied.\n`;
  prompt += `4. Each test command executed with its result.\n`;
  prompt += `5. Blockers, when any criterion could not be met.\n`;
  prompt += `When \`status\` is not \`success\`, do not write a success evidence file; the parent will abandon and re-dispatch.\n\n`;

  prompt += `## Finish Command\n`;
  prompt += `Run this once the evidence file exists:\n`;
  prompt += `\`\`\`bash\n`;
  prompt += `node "${normalizePath(path.join(__dirname, 'sdw_run.cjs'))}" task finish --run-id ${runId} --task ${task.id} --evidence ${absolutePaths ? `"${evidenceDisplay}"` : evidenceFileRel}${absolutePaths ? ` --root "${normalizePath(root)}"` : ''}\n`;
  prompt += `\`\`\`\n`;

  fs.writeFileSync(promptFileAbs, prompt, 'utf8');

  return {
    promptFileAbs,
    promptFileRel,
    evidenceFileAbs,
    evidenceFileRel,
    workingDirRel,
    promptBytes: Buffer.byteLength(prompt, 'utf8')
  };
}

/**
 * Lists working-tree paths with uncommitted modifications (Spec 028 AC14).
 */
function collectModifiedPaths(root) {
  try {
    const statusOut = execSync('git status --porcelain', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return statusOut.split('\n')
      .map(line => line.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim())
      .filter(Boolean)
      .map(line => normalizePath(line.replace(/^"(.*)"$/, '$1')))
      .filter(p => !p.startsWith('.sdw/state/'));
  } catch (e) {
    return [];
  }
}

/**
 * Checks if all DAG dependencies for a task are completed.
 */
function checkTaskDependencies(dagPlan, taskId, completedTaskIds = new Set()) {
  if (!dagPlan || !Array.isArray(dagPlan.tasks)) {
    return { satisfied: true, missingDependencies: [] };
  }

  const targetTask = dagPlan.tasks.find(t => t.id === taskId);
  if (!targetTask) {
    return { satisfied: true, missingDependencies: [] };
  }

  const dependencies = targetTask.dependencies || [];
  const missing = [];
  for (const depId of dependencies) {
    if (!completedTaskIds.has(depId)) {
      missing.push(depId);
    }
  }

  return {
    satisfied: missing.length === 0,
    missingDependencies: missing
  };
}

/**
 * Creates an isolated git worktree for a task branching from the primary tree HEAD.
 */
function createTaskWorktree(targetRoot, runId, taskId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const worktreeRel = `.sdw/worktrees/${runId}/${taskId}`;
  const worktreeAbs = path.join(root, worktreeRel);
  const taskBranch = `task/${runId}/${taskId}`;

  const baseCommit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

  const addProc = spawnSync('git', ['worktree', 'add', worktreeRel, '-b', taskBranch, 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  });

  if (addProc.status !== 0) {
    throw new Error(`Failed to create git worktree at ${worktreeRel}: ${addProc.stderr || 'git worktree add error'}`);
  }

  return {
    worktreeRel: normalizePath(worktreeRel),
    worktreeAbs: normalizePath(worktreeAbs),
    branch: taskBranch,
    baseCommit
  };
}

/**
 * Captures the working-tree state at dispatch time (Spec 028 AC24, AC27).
 *
 * Records the paths already dirty before the task started, with a content hash
 * for each, so a task can be corroborated by comparing content instead of
 * trusting filesystem timestamps (which have coarse granularity on some hosts).
 */
function captureDispatchBaseline(root) {
  const cwd = root ? path.resolve(root) : process.cwd();
  const dirty = collectModifiedPaths(cwd);
  const hashes = {};
  for (const relPath of dirty) {
    try {
      const absPath = path.resolve(cwd, relPath);
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        hashes[relPath] = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      }
    } catch (e) {
      // Unreadable at dispatch: treat as changed, never as inherited dirt.
    }
  }
  return { dirty, hashes };
}

function hashFile(root, relPath) {
  try {
    const absPath = path.resolve(root, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Checks whether a task produced real changes (Spec 015 AC14/AC15, Spec 028 AC27).
 *
 * In primary-tree mode a listed file corroborates the task only when it is
 * modified now and either it was clean at dispatch or its content differs from
 * the hash captured then, so edits inherited from an earlier task never
 * satisfy the check. Non-git workspaces fall back to existence only (AC28).
 */
function checkTaskChanges(targetRoot, taskWorktreeAbs, useWorktrees, filesChanged = [], options = {}) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const baseline = options.baseline && typeof options.baseline === 'object' ? options.baseline : null;
  const baselineDirty = new Set(Array.isArray(baseline && baseline.dirty) ? baseline.dirty.map(normalizePath) : []);
  const baselineHashes = (baseline && baseline.hashes && typeof baseline.hashes === 'object') ? baseline.hashes : {};

  const isInheritedDirt = (relPath) => {
    if (!baselineDirty.has(normalizePath(relPath))) return false;
    const priorHash = baselineHashes[normalizePath(relPath)];
    if (!priorHash) return false;
    const currentHash = hashFile(root, relPath);
    return currentHash === priorHash;
  };

  if (useWorktrees && taskWorktreeAbs && fs.existsSync(taskWorktreeAbs)) {
    try {
      const statusOut = execSync('git status --porcelain', {
        cwd: taskWorktreeAbs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return Boolean(statusOut);
    } catch (e) {
      return false;
    }
  }

  // Primary-tree mode
  const isGit = fs.existsSync(path.join(root, '.git'));
  if (!isGit) {
    if (filesChanged && filesChanged.length > 0) {
      return filesChanged.every(f => fs.existsSync(path.resolve(root, f)));
    }
    return false;
  }

  try {
    const changed = new Set();
    const statusOut = execSync('git status --porcelain', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (statusOut) {
      statusOut.split('\n')
        .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim())
        .map(p => p.replace(/^"(.*)"$/, '$1'))
        .map(normalizePath)
        .map(p => p.replace(/^\.\//, ''))
        .forEach(p => changed.add(p));
    }

    const diffOut = execSync('git diff --name-only HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (diffOut) {
      diffOut.split('\n').map(l => normalizePath(l.trim())).filter(Boolean).forEach(p => changed.add(p));
    }

    for (const f of filesChanged) {
      const normF = normalizePath(f).replace(/^\.\//, '');
      if (changed.has(normF) && !isInheritedDirt(normF)) {
        return true;
      }
    }
  } catch (e) {
    return false;
  }

  return false;
}

/**
 * Commits changes inside task worktree, cherry-picks into primary tree, and cleans up worktree.
 */
function integrateTaskWorktree(options) {
  const { targetRoot, specSlug, taskId, taskWorktreeAbs, taskWorktreeRel, taskBranch } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();

  // 1. Commit inside task worktree (argv form: no shell interpolation of specSlug/taskId)
  const addProc = spawnSync('git', ['add', '-A'], { cwd: taskWorktreeAbs, stdio: 'ignore' });
  if (addProc.status !== 0) {
    throw new Error(`Failed to stage changes for task ${taskId} in worktree ${taskWorktreeRel}.`);
  }
  const commitProc = spawnSync('git', ['commit', '-m', `task(${specSlug}): ${taskId}`], {
    cwd: taskWorktreeAbs,
    stdio: 'ignore'
  });
  if (commitProc.status !== 0) {
    throw new Error(`Failed to commit changes for task ${taskId} in worktree ${taskWorktreeRel}.`);
  }
  const revProc = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: taskWorktreeAbs,
    encoding: 'utf8'
  });
  if (revProc.status !== 0 || !revProc.stdout) {
    throw new Error(`Failed to resolve task commit SHA for task ${taskId}.`);
  }
  const taskCommitSha = String(revProc.stdout).trim();

  // 2. Cherry-pick into primary tree (argv form: commit SHA passed without shell)
  const cherryProc = spawnSync('git', ['cherry-pick', taskCommitSha], { cwd: root, stdio: 'ignore' });
  if (cherryProc.status !== 0) {
    // Preserves worktree for inspection on conflict
    const conflictErr = new Error(`Cherry-pick conflict during integration of task ${taskId} (commit ${taskCommitSha}). Worktree preserved at ${taskWorktreeRel}.`);
    conflictErr.isConflict = true;
    conflictErr.commitSha = taskCommitSha;
    throw conflictErr;
  }

  // 3. Safe cleanup of worktree and branch (argv form: no shell interpolation)
  try {
    const rmProc = spawnSync('git', ['worktree', 'remove', taskWorktreeRel], { cwd: root, stdio: 'ignore' });
    if (rmProc.status !== 0) throw new Error('git worktree remove failed');
    // The cherry-pick above integrated the task commit as a new SHA, so the task
    // branch tip is never an ancestor of HEAD: `-d` would always refuse (AC13).
    const delProc = spawnSync('git', ['branch', '-D', taskBranch], { cwd: root, stdio: 'ignore' });
    if (delProc.status !== 0) throw new Error('git branch delete failed');
  } catch (rmErr) {
    console.warn(`[sdw-run] Warning: Failed to cleanly remove worktree ${taskWorktreeRel}: ${rmErr.message}`);
  }

  return {
    commitSha: taskCommitSha,
    integrated: true
  };
}

/**
 * Executes implementation command in command mode with token substitution and environment allowlist.
 */
function executeTaskCommand(options) {
  const { config, task, promptFile, evidenceFile, targetRoot, worktreeDir, specSlug } = options;
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const cwd = worktreeDir ? (path.isAbsolute(worktreeDir) ? worktreeDir : path.resolve(root, worktreeDir)) : root;

  const implConfig = (config && config.implementation) || {};
  const rawCommand = implConfig.command;
  if (!rawCommand || typeof rawCommand !== 'string') {
    return {
      success: false,
      exitCode: 1,
      error: 'Missing implementation.command configuration in command mode.'
    };
  }

  const absPromptFile = normalizePath(path.resolve(root, promptFile));
  const absEvidenceFile = normalizePath(path.resolve(root, evidenceFile));
  const absWorkingDir = normalizePath(cwd);
  const absTargetRoot = normalizePath(root);

  // Token substitutions (AC22). Path-valued tokens are shell-quoted per spec 015
  // (Security): an unquoted path breaks the command on spaces and metacharacters.
  const quotePath = (value) => {
    const str = String(value);
    if (process.platform === 'win32') {
      if (/["\r\n]/.test(str)) throw new Error(`Unsafe path for command substitution: ${str}`);
      return `"${str}"`;
    }
    return `'${str.replace(/'/g, "'\\''")}'`;
  };
  const substituted = rawCommand
    .replace(/\{taskId\}/g, task.id)
    .replace(/\{promptFile\}/g, quotePath(absPromptFile))
    .replace(/\{evidenceFile\}/g, quotePath(absEvidenceFile))
    .replace(/\{workingDir\}/g, quotePath(absWorkingDir))
    .replace(/\{targetRoot\}/g, quotePath(absTargetRoot))
    .replace(/\{cwd\}/g, quotePath(absWorkingDir))
    .replace(/\{slug\}/g, specSlug);

  // Environment allowlist (AC23)
  const defaultAllowlist = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'NODE_PATH', 'LANG', 'LC_ALL'];
  const allowlist = implConfig.envAllowlist || defaultAllowlist;
  const filteredEnv = {};
  for (const key of allowlist) {
    const foundKey = Object.keys(process.env).find(k => k.toUpperCase() === key.toUpperCase());
    if (foundKey) {
      filteredEnv[key] = process.env[foundKey];
    }
  }

  // SDW variables (AC23)
  filteredEnv.SDW_TASK_ID = task.id;
  filteredEnv.SDW_PROMPT_FILE = absPromptFile;
  filteredEnv.SDW_EVIDENCE_FILE = absEvidenceFile;
  filteredEnv.SDW_WORKING_DIR = absWorkingDir;
  filteredEnv.SDW_TARGET_ROOT = absTargetRoot;
  filteredEnv.SDW_SPEC_SLUG = specSlug;
  const acList = Array.isArray(task.coveredAcs)
    ? task.coveredAcs
    : (Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria
      : (Array.isArray(task.acIds) ? task.acIds : []));
  filteredEnv.SDW_AC_IDS = acList.join(',');

  const timeoutMs = implConfig.timeoutMs || 1800000;

  console.log(`[Step 4: Command Mode] Executing task command for ${task.id}...`);
  const proc = spawnSync(substituted, {
    cwd,
    shell: true,
    env: filteredEnv,
    timeout: timeoutMs,
    encoding: 'utf8'
  });

  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    console.error(`[Step 4: Command Mode] Command exceeded timeout of ${timeoutMs}ms for task ${task.id}.`);
    return {
      success: false,
      timedOut: true,
      exitCode: 1,
      error: `Implementation command timed out after ${timeoutMs}ms.`
    };
  }

  if (proc.status !== 0) {
    const errMsg = proc.stderr ? proc.stderr.trim() : `Command exited with status ${proc.status}`;
    console.error(`[Step 4: Command Mode] Implementation command failed for task ${task.id}: ${errMsg}`);
    return {
      success: false,
      exitCode: proc.status || 1,
      error: errMsg
    };
  }

  return {
    success: true,
    exitCode: 0,
    output: proc.stdout
  };
}

module.exports = {
  renderTaskPrompt,
  collectModifiedPaths,
  captureDispatchBaseline,
  hashFile,
  checkTaskDependencies,
  createTaskWorktree,
  checkTaskChanges,
  integrateTaskWorktree,
  executeTaskCommand
};
