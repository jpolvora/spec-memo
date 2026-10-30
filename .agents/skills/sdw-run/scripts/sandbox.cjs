'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKER_REL = path.join('.sdw', 'sandbox', '.sandbox-marker.json');

function normalizePath(p) {
  return String(p).replace(/\\/g, '/');
}

function runGit(cwd, args) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    const detail = String(proc.stderr || proc.stdout || '').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(proc.stdout || '').trim();
}

function isGitRepo(root) {
  try {
    return runGit(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch (e) {
    return false;
  }
}

function isDirty(root) {
  try {
    return runGit(root, ['status', '--porcelain']).length > 0;
  } catch (e) {
    return false;
  }
}

function sandboxParent(sourceRoot, sandboxDir) {
  // Sandbox placement is configuration, so sdw-config owns the token expansion
  // and the "custom roots must stay outside the project" rule. Only a missing
  // sibling module falls back; a validation error must propagate.
  let sdwConfig = null;
  try {
    sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
  } catch (e) {
    sdwConfig = null;
  }
  if (sdwConfig && typeof sdwConfig.resolveSandboxPath === 'function') {
    return sdwConfig.resolveSandboxPath(sourceRoot, sandboxDir);
  }
  if (!sandboxDir) return path.join(sourceRoot, '.sdw', 'sandbox');
  const value = String(sandboxDir).trim().replace(/\{temp\}/g, normalizePath(os.tmpdir()));
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(sourceRoot, value);
}

function getSandboxDir(sourceRoot, runId, sandboxDir) {
  return path.join(sandboxParent(sourceRoot, sandboxDir), runId);
}

function getCloneDir(sourceRoot, runId, sandboxDir) {
  return path.join(getSandboxDir(sourceRoot, runId, sandboxDir), 'repo');
}

function getMetadataPath(sourceRoot, runId, sandboxDir) {
  return path.join(getSandboxDir(sourceRoot, runId, sandboxDir), 'sandbox.json');
}

function getReportPath(sourceRoot, runId, sandboxDir) {
  return path.join(getSandboxDir(sourceRoot, runId, sandboxDir), 'report.md');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readMarker(root) {
  if (!root) return null;
  const marker = readJson(path.join(path.resolve(root), MARKER_REL));
  return marker && marker.runId ? marker : null;
}

function readMetadata(sourceRoot, runId, sandboxDir) {
  return readJson(getMetadataPath(sourceRoot, runId, sandboxDir));
}

function updateMetadata(sourceRoot, runId, patch, sandboxDir) {
  const existing = readMetadata(sourceRoot, runId, sandboxDir);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  writeJson(getMetadataPath(sourceRoot, runId, sandboxDir), next);
  return next;
}

function linkNodeModules(sourceRoot, cloneRoot) {
  const source = path.join(sourceRoot, 'node_modules');
  const target = path.join(cloneRoot, 'node_modules');
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  try {
    fs.symlinkSync(path.resolve(source), target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (e) {
    console.warn(`[sandbox] Warning: could not link node_modules: ${e.message}`);
    return false;
  }
}

function copySpecIfMissing(sourceRoot, cloneRoot, specPath, metadata) {
  if (!specPath) return metadata;
  const absolute = path.resolve(sourceRoot, specPath);
  if (!fs.existsSync(absolute)) return metadata;
  const relative = normalizePath(path.relative(sourceRoot, absolute));
  const destination = path.join(cloneRoot, relative);
  if (fs.existsSync(destination)) return metadata;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(absolute, destination);
  return { ...metadata, specCopied: true };
}

function removeTree(dir) {
  // Windows keeps a junction locked while the directory tree is walked, so drop
  // the node_modules link first, then retry the recursive removal.
  const nodeModules = path.join(dir, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    try { fs.unlinkSync(nodeModules); } catch (e) {
      try { fs.rmdirSync(nodeModules); } catch (err) {}
    }
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function copyGitIdentity(sourceRoot, cloneRoot) {
  // A local identity in the source repository is not cloned. Without it, the
  // orchestrator's delivery commits fail on hosts that only configure it per repo.
  for (const key of ['user.name', 'user.email']) {
    try {
      const value = runGit(sourceRoot, ['config', '--local', '--get', key]);
      if (value) runGit(cloneRoot, ['config', '--local', key, value]);
    } catch (e) {}
  }
}

function resolveSourceHead(sourceRoot) {
  let branch = null;
  try {
    const value = runGit(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (value && value !== 'HEAD') branch = value;
  } catch (e) {}
  const sha = runGit(sourceRoot, ['rev-parse', 'HEAD']);
  return { branch, sha };
}

// A shallow, single-branch clone is enough for a sandbox: it only walks forward
// from HEAD, so one commit and one branch keep creation cheap. `--no-local` is
// required because git ignores --depth for --local clones.
function cloneSource(sourceRoot, cloneRoot) {
  const head = resolveSourceHead(sourceRoot);
  const args = ['clone', '--no-local', '--depth', '1', '--single-branch'];
  if (head.branch) args.push('--branch', head.branch);
  args.push(sourceRoot, cloneRoot);
  runGit(sourceRoot, args);

  let clonedSha = '';
  try {
    clonedSha = runGit(cloneRoot, ['rev-parse', 'HEAD']);
  } catch (e) {}

  if (clonedSha === head.sha) {
    return { sourceBranch: head.branch, sourceSha: head.sha, depth: 1, singleBranch: true, fallback: false };
  }

  // Rare fallback: a shallow clone that cannot reproduce the exact HEAD commit.
  removeTree(cloneRoot);
  runGit(sourceRoot, ['clone', '--local', sourceRoot, cloneRoot]);
  runGit(cloneRoot, ['checkout', '--detach', head.sha]);
  return { sourceBranch: head.branch, sourceSha: head.sha, depth: null, singleBranch: false, fallback: true };
}

function createSandbox(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const runId = String(options.runId || '').trim();
  if (!runId) throw new Error('A run id is required to create a sandbox.');
  if (readMarker(sourceRoot)) {
    throw new Error(`Nested sandbox execution is not supported: "${sourceRoot}" is already a sandbox for run "${readMarker(sourceRoot).runId}".`);
  }
  if (!isGitRepo(sourceRoot)) {
    throw new Error(`Sandbox mode requires a git repository: "${normalizePath(sourceRoot)}" is not one.`);
  }

  const parentDir = sandboxParent(sourceRoot, options.sandboxDir);
  const sandboxDir = getSandboxDir(sourceRoot, runId, options.sandboxDir);
  if (fs.existsSync(sandboxDir)) {
    const relativeDir = normalizePath(path.relative(sourceRoot, sandboxDir));
    throw new Error(`Sandbox target already exists at ${relativeDir}. Run "node skills/sdw-run/scripts/sdw_run.cjs sandbox clean --run-id ${runId}" before starting a new run (or delete the directory manually).`);
  }

  const baselineDirty = isDirty(sourceRoot);
  const cloneRoot = getCloneDir(sourceRoot, runId, options.sandboxDir);
  const branch = `sdw-sandbox/${runId}`;
  fs.mkdirSync(sandboxDir, { recursive: true });

  let cloneInfo = null;
  try {
    cloneInfo = cloneSource(sourceRoot, cloneRoot);
    copyGitIdentity(sourceRoot, cloneRoot);
    runGit(cloneRoot, ['switch', '-c', branch]);
    runGit(cloneRoot, ['remote', 'remove', 'origin']);
  } catch (err) {
    try { removeTree(sandboxDir); } catch (cleanupErr) {}
    throw new Error(`Failed to create sandbox clone: ${err.message}`);
  }

  const baseCommit = runGit(cloneRoot, ['rev-parse', 'HEAD']);
  const createdAt = new Date().toISOString();

  let metadata = {
    runId,
    slug: options.slug || null,
    sourceRoot: normalizePath(sourceRoot),
    sandboxDir: normalizePath(parentDir),
    root: normalizePath(path.relative(sourceRoot, cloneRoot)),
    branch,
    baseCommit,
    createdAt,
    updatedAt: createdAt,
    baselineDirty,
    specCopied: false,
    clone: cloneInfo,
    status: 'active'
  };

  metadata = copySpecIfMissing(sourceRoot, cloneRoot, options.specPath, metadata);
  const nodeModulesLinked = linkNodeModules(sourceRoot, cloneRoot);
  metadata.nodeModulesLinked = nodeModulesLinked;

  writeJson(getMetadataPath(sourceRoot, runId, options.sandboxDir), metadata);
  writeJson(path.join(cloneRoot, MARKER_REL), {
    sourceRoot: normalizePath(sourceRoot),
    sandboxDir: normalizePath(parentDir),
    runId,
    branch,
    createdAt
  });

  return { ...metadata, absoluteRoot: cloneRoot };
}

function listSandboxes(sourceRoot, sandboxDir) {
  const parent = sandboxParent(sourceRoot, sandboxDir);
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent)
    .map((entry) => readJson(path.join(parent, entry, 'sandbox.json')))
    .filter(Boolean)
    .map((meta) => ({
      ...meta,
      ageMs: Date.now() - Date.parse(meta.createdAt || 0)
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readRunState(cloneRoot, runId) {
  const stateDir = path.join(cloneRoot, '.sdw', 'state');
  if (!fs.existsSync(stateDir)) return null;
  const preferred = path.join(stateDir, `${runId}.state.json`);
  const candidates = fs.existsSync(preferred)
    ? [preferred]
    : fs.readdirSync(stateDir).filter((f) => f.endsWith('.state.json')).map((f) => path.join(stateDir, f));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return readJson(candidates[0]);
}

function gitFacts(cloneRoot, baseCommit) {
  const facts = { commits: '', diffStat: '' };
  try {
    facts.commits = runGit(cloneRoot, ['log', '--oneline', `${baseCommit}..HEAD`]);
  } catch (e) {}
  try {
    facts.diffStat = runGit(cloneRoot, ['diff', '--stat', baseCommit, 'HEAD']);
  } catch (e) {}
  return facts;
}

function clonePathFromMetadata(sourceRoot, metadata) {
  // Different Windows drives make path.relative return an absolute path, so
  // resolve instead of join (join would glue the absolute path onto the root).
  return path.resolve(sourceRoot, metadata.root || '');
}

function suggestSandboxFixes(state) {
  if (!state || state.status === 'completed') return [];
  const errors = Array.isArray(state.errors) ? state.errors.map(err => err.error || '').join('\n') : '';
  const stepStatuses = Object.values(state.steps || {}).map(step => (step && step.status) || '').join(' ');
  const text = `${errors}\n${stepStatuses}`;
  const fixes = [];
  if (/No valid skills directory|Cannot find module/i.test(text)) {
    fixes.push('Run `sdw-doctor check`; reinstall with `npx skills add jpolvora/spec-driven-workflow -y`.');
  }
  if (/Specification file not found/i.test(text)) {
    fixes.push('Verify the specification path and `specsDir`, then run `sdw-spec sync`.');
  }
  if (/Evidence validation failed|None of the files listed/i.test(text)) {
    fixes.push('Inspect the worker evidence contract and the task scope fence.');
  }
  if (/Verification Gate|Tests failed|Test verification failed/i.test(text)) {
    fixes.push('Run the configured verification command manually, then re-run the gate.');
  }
  if (/Conformance score below|reimplementation_needed/i.test(text)) {
    fixes.push('Read the Step 5 artifact and address the failing acceptance criteria.');
  }
  if (/Judge command failed|judge/i.test(text) && fixes.length === 0) {
    fixes.push('Check `scoring.judgeCommand` and its stdin/stdout contract.');
  }
  if (fixes.length === 0) {
    fixes.push('Inspect `.sdw/state/{runId}.state.json`, then re-run `sdw-doctor test`.');
  }
  return fixes;
}

function renderReport(sourceRoot, metadata) {
  const cloneRoot = clonePathFromMetadata(sourceRoot, metadata);
  const state = readRunState(cloneRoot, metadata.runId);
  const git = gitFacts(cloneRoot, metadata.baseCommit);
  const status = state && state.status ? state.status : (metadata.status || 'unknown');
  const lines = [];

  lines.push(`# Sandbox Run Report — ${metadata.runId}`);
  lines.push('');
  lines.push(`- Source root: \`${metadata.sourceRoot}\``);
  lines.push(`- Sandbox clone: \`${normalizePath(metadata.root)}\``);
  lines.push(`- Branch: \`${metadata.branch}\``);
  lines.push(`- Base commit: \`${metadata.baseCommit}\``);
  if (metadata.clone) {
    const cloneMode = metadata.clone.fallback
      ? 'full local fallback (detached)'
      : `shallow single-branch (${metadata.clone.sourceBranch || 'detached HEAD'})`;
    lines.push(`- Clone: ${cloneMode}`);
  }
  lines.push(`- Baseline dirty: ${metadata.baselineDirty ? 'true' : 'false'}`);
  lines.push(`- Specification copied: ${metadata.specCopied ? 'true' : 'false'}`);
  lines.push(`- Status: **${status}**`);
  lines.push(`- Created: ${metadata.createdAt}`);
  lines.push(`- Updated: ${new Date().toISOString()}`);
  lines.push('');

  if (state) {
    lines.push('## Steps');
    lines.push('');
    lines.push('| Step | Name | Status | Started | Completed | Artifact |');
    lines.push('|---|---|---|---|---|---|');
    for (let i = 1; i <= (state.totalSteps || 8); i++) {
      const step = (state.steps || {})[i] || {};
      const artifact = step.artifact ? step.artifact : '-';
      lines.push(`| ${i} | ${step.name || '-'} | ${step.status || 'pending'} | ${step.startedAt || '-'} | ${step.completedAt || '-'} | ${artifact} |`);
    }
    lines.push('');

    const tasks = (state.steps && state.steps[4] && state.steps[4].tasks) || {};
    const taskIds = Object.keys(tasks);
    if (taskIds.length > 0) {
      lines.push('## Tasks');
      lines.push('');
      lines.push('| Task | Title | Status | ACs | Files | Commit |');
      lines.push('|---|---|---|---|---|---|');
      for (const id of taskIds) {
        const task = tasks[id] || {};
        lines.push(`| ${id} | ${task.title || '-'} | ${task.status || '-'} | ${(task.acIds || task.coveredAcs || []).join(', ') || '-'} | ${(task.filesChanged || []).length} | ${task.commitSha || '-'} |`);
      }
      lines.push('');
    }

    const gates = (state.steps && state.steps[4] && state.steps[4].gates) || {};
    const gateNames = Object.keys(gates);
    if (gateNames.length > 0) {
      lines.push('## Verification Gates');
      lines.push('');
      for (const name of gateNames) {
        lines.push(`- ${name}: ${gates[name].status || 'unknown'}${gates[name].error ? ` — ${gates[name].error}` : ''}`);
      }
      lines.push('');
    }

    if (state.score !== null && state.score !== undefined) {
      lines.push('## Conformance Score');
      lines.push('');
      lines.push(`${state.score}/10 (threshold ${state.scoreThreshold || 'n/a'})`);
      lines.push('');
    }

    if (Array.isArray(state.errors) && state.errors.length > 0) {
      lines.push('## Errors');
      lines.push('');
      for (const err of state.errors.slice(-20)) {
        lines.push(`- [step ${err.step || '?'}] ${err.error}`);
      }
      lines.push('');
    }

    const fixes = suggestSandboxFixes(state);
    if (fixes.length > 0) {
      lines.push('## Suggested Fixes');
      lines.push('');
      for (const fix of fixes) lines.push(`- ${fix}`);
      lines.push('');
    }
  } else {
    lines.push('_No run state was found in the sandbox clone._');
    lines.push('');
  }

  lines.push('## Commits Since Base');
  lines.push('');
  lines.push('```');
  lines.push(git.commits || '(no commits)');
  lines.push('```');
  lines.push('');
  lines.push('## Changed Files');
  lines.push('');
  lines.push('```');
  lines.push(git.diffStat || '(no changes)');
  lines.push('```');
  lines.push('');
  lines.push('## Inspect Or Keep');
  lines.push('');
  lines.push('```bash');
  lines.push(`git -C ${normalizePath(metadata.root)} log --oneline`);
  lines.push(`git -C ${normalizePath(metadata.root)} diff --stat ${metadata.baseCommit}..HEAD`);
  lines.push(`git fetch ${normalizePath(metadata.root)} ${metadata.branch}:refs/heads/${metadata.branch}`);
  lines.push('```');
  lines.push('');
  lines.push('## Remove');
  lines.push('');
  lines.push('```bash');
  lines.push(`node skills/sdw-run/scripts/sdw_run.cjs sandbox clean --run-id ${metadata.runId}`);
  lines.push('```');

  return lines.join('\n') + '\n';
}

function writeReport(sourceRoot, runId, sandboxDir) {
  const metadata = readMetadata(sourceRoot, runId, sandboxDir);
  if (!metadata) throw new Error(`Unknown sandbox run id "${runId}".`);
  const report = renderReport(sourceRoot, metadata);
  const reportPath = getReportPath(sourceRoot, runId, sandboxDir);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report, 'utf8');
  const state = readRunState(clonePathFromMetadata(sourceRoot, metadata), runId);
  const status = state && state.status ? state.status : metadata.status;
  updateMetadata(sourceRoot, runId, { status }, sandboxDir);
  return { reportPath, report, metadata: readMetadata(sourceRoot, runId, sandboxDir) };
}

function refreshReportForRoot(root) {
  const marker = readMarker(root);
  if (!marker) return null;
  try {
    return writeReport(marker.sourceRoot, marker.runId, marker.sandboxDir);
  } catch (err) {
    console.warn(`[sandbox] Warning: could not refresh report: ${err.message}`);
    return null;
  }
}

function cleanSandbox(sourceRoot, runId, sandboxDir) {
  const metadata = readMetadata(sourceRoot, runId, sandboxDir);
  if (!metadata) {
    // An interrupted creation can leave the target directory without metadata.
    const orphanDir = getSandboxDir(sourceRoot, runId, sandboxDir);
    if (!fs.existsSync(orphanDir)) throw new Error(`Unknown sandbox run id "${runId}".`);
    removeTree(orphanDir);
    if (fs.existsSync(orphanDir)) {
      throw new Error(`Failed to remove orphaned sandbox directory at ${normalizePath(orphanDir)}. Remove it manually and retry.`);
    }
    return { runId, status: 'cleaned', orphan: true, removedAt: new Date().toISOString() };
  }
  try {
    writeReport(sourceRoot, runId, sandboxDir);
  } catch (err) {
    console.warn(`[sandbox] Warning: could not refresh report before cleanup: ${err.message}`);
  }
  const cloneRoot = clonePathFromMetadata(sourceRoot, metadata);
  removeTree(cloneRoot);
  if (fs.existsSync(cloneRoot)) {
    throw new Error(`Failed to remove sandbox clone at ${normalizePath(cloneRoot)}. Remove it manually and retry "sandbox clean".`);
  }
  return updateMetadata(sourceRoot, runId, { status: 'cleaned', cleanedAt: new Date().toISOString() }, sandboxDir);
}

module.exports = {
  normalizePath,
  isGitRepo,
  isDirty,
  sandboxParent,
  getSandboxDir,
  getCloneDir,
  getMetadataPath,
  getReportPath,
  readMarker,
  readMetadata,
  updateMetadata,
  createSandbox,
  listSandboxes,
  renderReport,
  suggestSandboxFixes,
  writeReport,
  refreshReportForRoot,
  cleanSandbox
};
