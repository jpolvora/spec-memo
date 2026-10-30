'use strict';

const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function resolveStateDir(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let stateDir = path.join(root, '.sdw', 'state');
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    const config = sdwConfig.loadConfig(root);
    if (config && config.stateDir) {
      stateDir = path.resolve(config.stateDir);
    }
  } catch (e) {
    const configFile = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(configFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (raw.stateDir) {
          stateDir = path.resolve(raw.stateDir.replace(/\{projectRoot\}/g, normalizePath(root)));
        }
      } catch (err) {}
    }
  }
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

function generateRunId(specSlug) {
  const cleanSlug = (specSlug || 'unnamed').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30);
  const timestamp = Date.now();
  return `run-${timestamp}-${cleanSlug}`;
}

function getStateFilePath(targetRoot, runId) {
  const stateDir = resolveStateDir(targetRoot);
  return path.join(stateDir, `${runId}.state.json`);
}

function resolveArtifactsDir(targetRoot, specSlug, runId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const stateDir = resolveStateDir(root);
  return normalizePath(path.join(stateDir, specSlug, runId));
}

function getArtifactsRelDir(targetRoot, specSlug, runId) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const absDir = resolveArtifactsDir(root, specSlug, runId);
  return normalizePath(path.relative(root, absDir));
}

function createRunState(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const specPath = options.specPath ? normalizePath(path.resolve(targetRoot, options.specPath)) : null;
  const specSlug = options.slug || (specPath ? path.basename(specPath, path.extname(specPath)).replace(/^step-\d+-/, '') : 'spec');
  const runId = options.runId || generateRunId(specSlug);
  const stateFilePath = getStateFilePath(targetRoot, runId);

  // If state already exists for this runId and overwrite is not forced, return existing state
  if (!options.overwrite && fs.existsSync(stateFilePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (!existing.artifactsDir) {
        existing.artifactsDir = getArtifactsRelDir(targetRoot, existing.specSlug || specSlug, existing.runId || runId);
      }
      return existing;
    } catch (e) {
      // If corrupted, recreate
    }
  }

  const artifactsRelDir = getArtifactsRelDir(targetRoot, specSlug, runId);

  const state = {
    orchestrator: 'sdw-run',
    runId,
    specSlug,
    specPath,
    projectRoot: normalizePath(targetRoot),
    status: 'in_progress', // 'in_progress' | 'paused' | 'completed' | 'failed'
    currentStep: 1,
    totalSteps: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baseCommit: options.baseCommit || null,
    refineMode: Boolean(options.refineMode),
    deliveryCommitCreated: null,
    branch: options.branch || null,
    baseBranch: options.baseBranch || null,
    branchReused: Boolean(options.branchReused),
    branching: options.branching || null,
    branchingSync: options.branchingSync || null,
    worktrees: [],
    worktreeSkipReason: null,
    runtimeOverrides: options.runtimeOverrides || null,
    scm: options.scm || {
      provider: 'none',
      resolvedFrom: 'default',
      cliInstalled: null,
      cliAuthenticated: null,
      skipped: false,
      skipReason: null,
      errors: []
    },
    deliveryCommit: null,
    reviewCommit: null,
    score: null,
    scoreIteration: 0,
    reviewIteration: 0,
    dagTasks: [],
    artifactsDir: options.artifactsDir || artifactsRelDir,
    steps: {
      1: { name: 'derivation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      2: { name: 'refinement', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      3: { name: 'dag_generation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      4: { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {}, dispatch: { activeTaskId: null, sequence: 0, dispatchedAt: null, abandonments: [] } },
      5: { name: 'scoring', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      6: { name: 'delivery_commit', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      7: { name: 'code_review', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null },
      8: { name: 'pr_preparation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null }
    },
    errors: []
  };
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

function loadRunState(targetRoot, runId) {
  const stateFilePath = getStateFilePath(targetRoot, runId);
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(`State file not found for runId "${runId}" at ${normalizePath(stateFilePath)}`);
  }
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupted state file for runId "${runId}": ${err.message}`);
  }
}

function findLatestRunState(targetRoot) {
  const stateDir = resolveStateDir(targetRoot);
  const files = fs.readdirSync(stateDir).filter(f => f.endsWith('.state.json'));
  if (files.length === 0) return null;

  files.sort((a, b) => {
    const statA = fs.statSync(path.join(stateDir, a));
    const statB = fs.statSync(path.join(stateDir, b));
    return statB.mtimeMs - statA.mtimeMs;
  });

  const latestFile = path.join(stateDir, files[0]);
  return JSON.parse(fs.readFileSync(latestFile, 'utf8'));
}

function saveRunState(targetRoot, state) {
  const stateFilePath = getStateFilePath(targetRoot, state.runId);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

function getResumptionStep(state) {
  for (let s = 1; s <= state.totalSteps; s++) {
    const stepObj = state.steps[s];
    if (!stepObj || (stepObj.status !== 'completed' && stepObj.status !== 'skipped')) {
      return s;
    }
  }
  return state.totalSteps;
}

function recordError(targetRoot, runId, stepNum, errorMessage) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  state.errors.push({ step: stepNum, timestamp: now, error: String(errorMessage) });
  state.status = 'failed';
  if (state.steps[stepNum]) {
    state.steps[stepNum].status = 'failed';
    state.steps[stepNum].error = String(errorMessage);
  }
  return saveRunState(targetRoot, state);
}

function recordWarning(targetRoot, runId, stepNum, warningMessage) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  state.errors = state.errors || [];
  state.errors.push({ step: stepNum, timestamp: now, error: String(warningMessage), warning: true });
  return saveRunState(targetRoot, state);
}

function recordStepArtifact(targetRoot, runId, stepNum, artifactRelPath) {
  const state = loadRunState(targetRoot, runId);
  if (state.steps && state.steps[stepNum]) {
    state.steps[stepNum].artifact = normalizePath(artifactRelPath);
  }
  return saveRunState(targetRoot, state);
}

function updateStepState(targetRoot, runId, stepNum, status, outputData, error, options) {
  const state = loadRunState(targetRoot, runId);
  const now = new Date().toISOString();
  if (!state.steps[stepNum]) {
    state.steps[stepNum] = { name: `step_${stepNum}`, status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null };
  }

  const stepObj = state.steps[stepNum];
  stepObj.status = status;
  if (status === 'in_progress' && !stepObj.startedAt) {
    stepObj.startedAt = now;
  }
  if (status === 'completed' || status === 'skipped') {
    stepObj.completedAt = now;
  }
  if (outputData !== undefined) {
    stepObj.output = outputData;
  }

  let opt = options;
  if (error && typeof error === 'object' && !error.message && !Array.isArray(error) && (error.artifact || error.artifactsDir)) {
    opt = error;
    error = null;
  }
  if (opt && opt.artifact) {
    stepObj.artifact = normalizePath(opt.artifact);
  }
  if (opt && opt.artifactsDir) {
    state.artifactsDir = normalizePath(opt.artifactsDir);
  }

  if (error) {
    stepObj.error = error;
    state.errors.push({ step: stepNum, timestamp: now, error: String(error) });
    state.status = 'failed';
  }

  state.currentStep = stepNum;
  return saveRunState(targetRoot, state);
}

function updateTaskState(targetRoot, runId, taskId, taskState) {
  const state = loadRunState(targetRoot, runId);
  if (!state.steps[4]) {
    state.steps[4] = { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {} };
  }
  state.steps[4].tasks = state.steps[4].tasks || {};
  state.steps[4].tasks[taskId] = { ...(state.steps[4].tasks[taskId] || {}), ...taskState };
  return saveRunState(targetRoot, state);
}

function updateGateState(targetRoot, runId, gateName, gateState) {
  const state = loadRunState(targetRoot, runId);
  if (!state.steps[4]) {
    state.steps[4] = { name: 'implementation', status: 'pending', startedAt: null, completedAt: null, output: null, artifact: null, tasks: {}, gates: {} };
  }
  state.steps[4].gates = state.steps[4].gates || {};
  state.steps[4].gates[gateName] = { ...(state.steps[4].gates[gateName] || {}), ...gateState };
  return saveRunState(targetRoot, state);
}

module.exports = {
  normalizePath,
  resolveStateDir,
  resolveArtifactsDir,
  getArtifactsRelDir,
  generateRunId,
  getStateFilePath,
  createRunState,
  loadRunState,
  findLatestRunState,
  saveRunState,
  getResumptionStep,
  recordError,
  recordWarning,
  recordStepArtifact,
  updateStepState,
  updateTaskState,
  updateGateState
};
