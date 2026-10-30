#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

// Import SCM provider contract from sdw-spec
let scmContract;
try {
  scmContract = require('../../sdw-spec/scripts/scm_provider_contract.cjs');
} catch (e) {
  try {
    scmContract = require(path.join(__dirname, '../../sdw-spec/scripts/scm_provider_contract.cjs'));
  } catch (err) {
    scmContract = null;
  }
}

// Branching configuration helper from sdw-config (spec 00040).
let sdwConfig;
try {
  sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
} catch (e) {
  sdwConfig = null;
}

function assertSafeSlug(specSlug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(specSlug))) {
    throw new Error(
      `Invalid specification slug "${specSlug}". Expected lowercase letters, digits, and hyphens (^[a-z0-9][a-z0-9-]*$).`
    );
  }
}

function assertSafeRef(ref, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(ref)) || String(ref).includes('..')) {
    throw new Error(`Invalid ${label} branch name "${ref}".`);
  }
}

function safeGit(executor, cmd) {
  try {
    return String(executor(cmd) || '');
  } catch (e) {
    return '';
  }
}

function listBranchCommits(executor, base, head) {
  const out = safeGit(executor, `git log ${base}..${head} --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad --date=short`).trim();
  if (!out) return [];
  const commits = out.split(/\r?\n/).map((line) => {
    const parts = line.split('\x1f');
    return {
      hash: (parts[0] || '').trim(),
      short: (parts[1] || '').trim(),
      subject: (parts[2] || '').trim(),
      author: (parts[3] || '').trim(),
      date: (parts[4] || '').trim()
    };
  }).filter((c) => c.hash && c.subject);
  if (commits.length > 0) return commits.slice(0, 50);
  return [];
}

function listBranchFiles(executor, base, head) {
  const out = safeGit(executor, `git diff --name-status ${base}...${head}`).trim()
    || safeGit(executor, `git diff --name-only ${base}...${head}`).trim();
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 100);
}

function getSpecTitle(projectRoot, specSlug) {
  try {
    if (!specSlug) return null;
    const dir = path.join(projectRoot, '.sdw', 'specs');
    if (!fs.existsSync(dir)) return null;
    const normSlug = String(specSlug).replace(/^\d+-/, '');
    const files = fs.readdirSync(dir).filter((f) => f === `${specSlug}.md` || f.replace(/^\d+-/, '').replace(/\.md$/, '') === normSlug);
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(0, 25).join('\n');
      const m = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch (e) {}
  return null;
}

// Spec 00051: the provider-specific closing keyword is the only SCM syntax the
// body needs; where it appears is provider-agnostic.
const ISSUE_CLOSING_KEYWORDS = new Map([
  ['github', (id) => `Closes #${id}`],
  ['azure-devops', (id) => `Fixes AB#${id}`]
]);

// Matches a standalone closing line, e.g. `Closes #12`, `Fixes AB#12`, `Resolves #7`.
const CLOSING_KEYWORD_LINE = /^(Closes|Fixes|Resolves)\s+(AB)?#\d+\b/i;

function parseFrontmatterValue(frontmatter, key) {
  const match = String(frontmatter || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return null;
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  return raw && raw !== 'null' && raw !== '~' ? raw : null;
}

/**
 * Reads the `id` and `source` frontmatter of the specification selected by
 * `--spec` and derives the provider closing keyword (spec 00051).
 * A missing specification, a null id, or an unsupported provider yields no
 * keyword: shipping still proceeds.
 */
function resolveIssueLink(projectRoot, specSlug) {
  const empty = { id: null, provider: null, keyword: null, present: false };
  try {
    if (!specSlug) return empty;
    const dir = path.join(projectRoot, '.sdw', 'specs');
    if (!fs.existsSync(dir)) return empty;
    const normSlug = String(specSlug).replace(/^\d+-/, '');
    const files = fs.readdirSync(dir).filter((f) => f === `${specSlug}.md` || f.replace(/^\d+-/, '').replace(/\.md$/, '') === normSlug);
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(0, 25).join('\n');
      const id = parseFrontmatterValue(content, 'id');
      const provider = parseFrontmatterValue(content, 'source');
      const formatKeyword = id ? ISSUE_CLOSING_KEYWORDS.get(provider || '') : null;
      const keyword = formatKeyword ? formatKeyword(id) : null;
      return { id, provider, keyword, present: Boolean(keyword) };
    }
  } catch (e) {}
  return empty;
}

function stripClosingKeywordLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !CLOSING_KEYWORD_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Appends the current closing keyword to an assembled body after removing any
 * already present closing line, so the body carries it exactly once (AC6).
 */
function appendClosingKeyword(body, keyword) {
  if (!keyword) return String(body || '');
  const kept = stripClosingKeywordLines(body);
  return kept ? `${kept}\n\n${keyword}` : keyword;
}

// The full description needed to replace a reused pull-request body in one
// write. The provider contract exposes no body getter, so the same read the
// providers use for `appendBody` is issued here; a failure degrades to append.
function readPullRequestBody(providerName, prNumber, executor) {
  if (!/^\d+$/.test(String(prNumber || ''))) return null;
  try {
    if (providerName === 'github') {
      const data = JSON.parse(executor(`gh pr view ${prNumber} --json body`) || '{}');
      return typeof data.body === 'string' ? data.body : null;
    }
    if (providerName === 'ado' || providerName === 'azure-devops') {
      const body = String(executor(`az repos pr show --id ${prNumber} --query description -o tsv`) || '');
      return body.replace(/\r?\n$/, '');
    }
  } catch (e) {}
  return null;
}

function buildPrTitle({ explicit, specSlug, specTitle, head, base, commits }) {
  if (explicit) return explicit;
  if (!commits || commits.length === 0) {
    return specSlug ? `feat(${specSlug}): deliver ${specSlug}` : `feat: deliver changes from ${head}`;
  }
  const count = commits.length;
  if (specSlug) {
    const subject = specTitle || specSlug;
    const suffix = count > 1 ? ` (${count} commits)` : '';
    return `feat(${specSlug}): deliver ${subject}${suffix}`.slice(0, 120);
  }
  const first = String(commits[0].subject || '').slice(0, 80);
  const suffix = count > 1 ? ` (+${count - 1} more, ${head}→${base})` : ` (${head}→${base})`;
  return `feat(${head}): ${first}${suffix}`.slice(0, 120);
}

function buildPrBody({ explicit, specSlug, specTitle, head, base, commits, files, config, issueLink }) {
  if (explicit) return explicit;
  const closingKeyword = issueLink && issueLink.present ? issueLink.keyword : null;
  if ((!commits || commits.length === 0) && (!files || files.length === 0)) {
    const fallback = specSlug ? `Automated delivery for specification ${specSlug}.` : `Automated delivery pull request.`;
    return appendClosingKeyword(fallback, closingKeyword);
  }
  const lines = [];
  lines.push('## Summary');
  lines.push(`Automated delivery \`${head}\` → \`${base}\`.`);
  if (specSlug) lines.push(`- Spec: \`${specSlug}\`${specTitle ? ` — ${specTitle}` : ''}`);
  lines.push(`- Commits: ${commits.length}`);
  lines.push(`- Files changed: ${files.length}`);
  if (closingKeyword) lines.push('', closingKeyword);
  lines.push('');
  if (commits.length > 0) {
    lines.push('## Commits');
    commits.slice(0, 30).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject} (${c.author}, ${c.date})`));
    if (commits.length > 30) lines.push(`- ... and ${commits.length - 30} more`);
    lines.push('');
    const feats = commits.filter((c) => /^feat(\(|:)/i.test(c.subject));
    const fixes = commits.filter((c) => /^fix(\(|:)/i.test(c.subject));
    const others = commits.filter((c) => !/^(feat|fix)(\(|:)/i.test(c.subject));
    lines.push('## Features');
    if (feats.length > 0) {
      lines.push('### Features');
      feats.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    if (fixes.length > 0) {
      lines.push('### Fixes');
      fixes.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    if (others.length > 0) {
      lines.push('### Other');
      others.slice(0, 20).forEach((c) => lines.push(`- \`${c.short}\` ${c.subject}`));
    }
    lines.push('');
  }
  if (files.length > 0) {
    lines.push('## Files changed');
    files.slice(0, 50).forEach((f) => lines.push(`- ${f}`));
    if (files.length > 50) lines.push(`- ... and ${files.length - 50} more`);
    lines.push('');
  }
  lines.push('## Verification');
  if (config.prePrCommand) lines.push(`- prePrCommand: \`${config.prePrCommand}\``);
  if (config.requiredBuild) lines.push(`- Build: \`${(config.verification && config.verification.buildCommand) || 'npm run build'}\``);
  if (config.runAllTests) lines.push(`- Tests: \`${(config.verification && config.verification.testCommand) || 'npm test'}\``);
  lines.push(`- Security checks: ${config.securityChecksEnabled ? 'enabled' : 'disabled'}`);
  return lines.join('\n');
}

/**
 * Builds the default sdw-fixer CLI command from active review threads.
 * Used when reviewFixCommand is unset (AC13): writes thread-derived findings
 * to a temp file and returns a `sdw_fixer.cjs run` invocation the caller
 * executes through the executor, reusing the existing verify/stage/commit
 * gates. Returns null when the fixer script is absent or threads are empty.
 */
function buildDefaultFixerCommand(projectRoot, activeList) {
  const fixerScript = path.join(projectRoot, 'skills', 'sdw-fixer', 'scripts', 'sdw_fixer.cjs');
  if (!fs.existsSync(fixerScript)) return null;
  const threads = (activeList || []).filter(t => t && !t.isResolved);
  if (threads.length === 0) return null;
  const findings = threads.map(t => {
    const rawPath = typeof t.path === 'string' ? t.path.trim().replace(/\\/g, '/') : '';
    const safe = rawPath && !path.isAbsolute(rawPath) && !/^[A-Za-z]:[\\/]/.test(rawPath) && !rawPath.split('/').includes('..');
    // Every comment body, in the provider's chronological order, without a
    // length cut: the fixer must see the reasoning that names the defect.
    const bodies = (Array.isArray(t.comments) ? t.comments : [])
      .map(comment => String((comment && comment.body) || ''))
      .filter(body => body.trim().length > 0);
    const evidence = bodies.length > 0 ? bodies.join('\n\n') : 'Review feedback';
    return {
      threadId: t.id || null,
      file: safe ? rawPath : 'REVIEW_THREADS.md',
      line: Number.isInteger(t.line) && t.line > 0 ? t.line : 1,
      rule: 'review_thread_feedback',
      evidence,
      severityHint: 'medium'
    };
  });
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-fixer-'));
  } catch (e) {
    return null;
  }
  const findingsPath = path.join(dir, 'findings.json');
  const reportPath = path.join(dir, 'result.json');
  try {
    fs.writeFileSync(findingsPath, JSON.stringify({ batchId: `ship-pr-fix-${Date.now()}`, findings }, null, 2), 'utf8');
  } catch (e) {
    return null;
  }
  return { command: `node "${fixerScript}" run --findings "${findingsPath}" --report "${reportPath}"`, findingsPath, reportPath };
}

function resolveStateDir(projectRoot, config = {}) {
  const configured = config.stateDir || '{projectRoot}/.sdw/state';
  let skillsRootVal = typeof config.skillsRoot === 'string' && config.skillsRoot.trim()
    ? config.skillsRoot.replace(/\{projectRoot\}/g, projectRoot)
    : projectRoot;
  if (skillsRootVal.includes('{skillsRoot}')) skillsRootVal = projectRoot;
  const raw = String(configured).replace(/\{projectRoot\}/g, projectRoot).replace(/\{skillsRoot\}/g, skillsRootVal).replace(/\{projectRoot\}/g, projectRoot);
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
}

function listChangedPaths(executor) {
  let out = '';
  try {
    out = String(executor('git status --porcelain -z -uall') || '');
  } catch (e) {
    return new Set();
  }
  return new Set(parsePorcelain(out).map(entry => entry.path));
}

function stageChangedSince(executor, before, projectRoot) {
  const after = listChangedPaths(executor);
  const changed = Array.from(after).filter(file => !before.has(file));
  if (changed.length === 0) return [];

  // argv form: filenames are never interpreted by a shell.
  const result = spawnSync('git', ['add', '--', ...changed], { cwd: projectRoot, stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error('Failed to stage the changed files for the scoped commit.');
  }
  return changed;
}

/**
 * Parses CLI arguments
 */
function parseArgs(args) {
  const options = {
    subcommand: null,
    pr: null,
    threadId: null,
    commentId: null,
    comment: null,
    runId: null,
    ackPrepare: null,
    spec: null,
    head: null,
    base: null,
    title: null,
    body: null,
    push: false,
    pollPr: false,
    dryRun: false,
    json: false,
    maxIterations: 3,
    pollIntervalMs: 20000,
    checksStartTimeoutMs: 30000,
    checksStartIntervalMs: 5000,
    maxPreemptions: null,
    nativeWatch: true
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'list-threads' || arg === 'resolve-thread' || arg === 'check-status' || arg === 'dirty-plan') {
      options.subcommand = arg;
    } else if ((arg === '--pr' || arg === '--pr-number') && args[i + 1]) {
      options.pr = args[++i];
    } else if ((arg === '--thread' || arg === '--thread-id') && args[i + 1]) {
      options.threadId = args[++i];
    } else if (arg === '--comment-id' && args[i + 1]) {
      options.commentId = args[++i];
    } else if (arg === '--comment' && args[i + 1]) {
      options.comment = args[++i];
    } else if (arg === '--run-id' && args[i + 1]) {
      options.runId = args[++i];
    } else if (arg === '--ack-prepare' && args[i + 1]) {
      options.ackPrepare = args[++i];
    } else if (arg === '--spec' && args[i + 1]) {
      options.spec = args[++i];
    } else if (arg === '--head' && args[i + 1]) {
      options.head = args[++i];
    } else if (arg === '--base' && args[i + 1]) {
      options.base = args[++i];
    } else if (arg === '--title' && args[i + 1]) {
      options.title = args[++i];
    } else if (arg === '--body' && args[i + 1]) {
      options.body = args[++i];
    } else if (arg === '--push') {
      options.push = true;
    } else if (arg === '--poll-pr') {
      options.pollPr = true;
    } else if (arg === '--merge' || arg === '--allow-merge') {
      options.merge = true;
    } else if (arg === '--dirty-files') {
      options.dirtyFilesPath = args[++i];
    } else if (arg.startsWith('--dirty-files=')) {
      options.dirtyFilesPath = arg.slice(14);
    } else if (arg === '--no-native-watch') {
      options.nativeWatch = false;
    } else if (arg === '--native-watch') {
      options.nativeWatch = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--max-iterations' && args[i + 1]) {
      options.maxIterations = parseInt(args[++i], 10) || 3;
    } else if (arg === '--poll-interval' && args[i + 1]) {
      const parsedInterval = parseInt(args[++i], 10);
      options.pollIntervalMs = Number.isFinite(parsedInterval) && parsedInterval >= 0 ? parsedInterval : 20000;
    } else if (arg === '--checks-start-timeout' && args[i + 1]) {
      const parsedTimeout = parseInt(args[++i], 10);
      options.checksStartTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 30000;
    } else if (arg === '--checks-start-interval' && args[i + 1]) {
      const parsedStartInterval = parseInt(args[++i], 10);
      options.checksStartIntervalMs = Number.isFinite(parsedStartInterval) && parsedStartInterval >= 0 ? parsedStartInterval : 5000;
    } else if (arg === '--max-preemptions' && args[i + 1]) {
      const parsedPreemptions = parseInt(args[++i], 10);
      options.maxPreemptions = Number.isFinite(parsedPreemptions) && parsedPreemptions >= 0 ? parsedPreemptions : 3;
    } else if (arg === '--review-fix-command' && args[i + 1]) {
      options.reviewFixCommand = args[++i];
    } else if ((arg === '--root' || arg === '--project-root') && args[i + 1]) {
      options.projectRoot = args[++i];
    }
  }

  return options;
}

/**
 * Loads project configuration from .sdw/config.json
 */
function loadConfig(projectRoot = process.cwd()) {
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      const loaded = sdwConfig.loadConfig(projectRoot);
      if (loaded && typeof loaded === 'object') return loaded;
    }
  } catch (e) {}
  const configPath = path.join(projectRoot, '.sdw', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn(`[sdw-ship-pr] Warning: Failed to parse .sdw/config.json: ${e.message}`);
    }
  }
  return {};
}

/**
 * Locates and reads run state file if runId is supplied
 */
function locateStateFile(projectRoot, runId, specSlug = null, config = {}) {
  if (!runId) return null;
  const stateDir = resolveStateDir(projectRoot, config);
  if (!fs.existsSync(stateDir)) return null;

  // Direct state file: .sdw/state/{runId}.state.json
  const directPath = path.join(stateDir, `${runId}.state.json`);
  if (fs.existsSync(directPath)) return directPath;

  // Subdirectory: .sdw/state/{spec}/{runId}.state.json
  if (specSlug) {
    const specSubPath = path.join(stateDir, specSlug, `${runId}.state.json`);
    if (fs.existsSync(specSubPath)) return specSubPath;
  }

  // Scan subdirectories
  const entries = fs.readdirSync(stateDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const nested = path.join(stateDir, ent.name, `${runId}.state.json`);
      if (fs.existsSync(nested)) return nested;
    }
  }

  return null;
}

// Spec 00050: pre-PR discovery scan and run-state evidence gate.
const PRE_PR_DISCOVERY_MODES = ['block', 'warn', 'off'];
const PRE_PR_DISCOVERY_FILES = ['AGENTS.md', 'CONTRIBUTING.md', 'RELEASE.md', 'PUBLISH.md'];
const PRE_PR_PREPARE_HEADING = /prepare|before push|before publish|before deliver|before delivery|before merge/i;
const PRE_PR_DISCOVERY_MAX_LINES = 8;
const PRE_PR_DISCOVERY_MAX_CHARS = 1200;

function formatPrePrBoard(board = []) {
  const cell = value => String(value === null || value === undefined ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
  const lines = [
    '| Check | Status | Evidence |',
    '| --- | --- | --- |'
  ];
  for (const row of board) {
    lines.push(`| ${cell(row.check)} | ${cell(row.status)} | ${cell(row.evidence)} |`);
  }
  return lines.join('\n');
}

function resolvePrePrDiscovery(config = {}) {
  const configured = config.prePrDiscovery;
  if (configured === undefined || configured === null) return 'block';
  const mode = String(configured).trim().toLowerCase();
  if (!PRE_PR_DISCOVERY_MODES.includes(mode)) {
    throw new Error(
      `Invalid prePrDiscovery value "${configured}". Allowed values: ${PRE_PR_DISCOVERY_MODES.join(', ')}.`
    );
  }
  return mode;
}

function discoverPrepareObligations(projectRoot, config = {}) {
  const rows = [];
  for (const fileName of PRE_PR_DISCOVERY_FILES) {
    const filePath = path.join(projectRoot, fileName);
    let lines;
    try {
      if (!fs.existsSync(filePath)) continue;
      lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    } catch (e) {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
      if (!headingMatch || !PRE_PR_PREPARE_HEADING.test(headingMatch[1])) continue;
      const bodyLines = [];
      for (let j = i + 1; j < lines.length && bodyLines.length < PRE_PR_DISCOVERY_MAX_LINES; j++) {
        if (/^#{1,6}\s+/.test(lines[j])) break;
        bodyLines.push(lines[j]);
      }
      rows.push({
        source: fileName,
        heading: headingMatch[1].trim(),
        body: bodyLines.join('\n').trim().slice(0, PRE_PR_DISCOVERY_MAX_CHARS)
      });
    }
  }
  const instructions = typeof config.prePrInstructions === 'string' ? config.prePrInstructions.trim() : '';
  if (instructions) {
    rows.push({
      source: '.sdw/config.json',
      heading: 'prePrInstructions',
      body: instructions.slice(0, PRE_PR_DISCOVERY_MAX_CHARS)
    });
  }
  return rows;
}

function evaluateRunStateGate(projectRoot, runId, specSlug, config = {}, options = {}) {
  const gate = {
    runId,
    stateFile: null,
    score: null,
    scoreMin: null,
    steps: {},
    codeReviewRequired: Boolean(options.scmCodeReviewEnabled),
    passed: false,
    reason: null
  };
  let stateFilePath;
  try {
    stateFilePath = locateStateFile(projectRoot, runId, specSlug, config);
  } catch (e) {
    gate.reason = `run state for "${runId}" is unreadable (${e.message}); refusing to ship without run evidence`;
    return gate;
  }
  if (!stateFilePath) {
    gate.reason = `run state "${runId}.state.json" was not found; refusing to ship without run evidence`;
    return gate;
  }
  gate.stateFile = path.relative(projectRoot, stateFilePath).split(path.sep).join('/');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  } catch (e) {
    gate.reason = `run state "${gate.stateFile}" is unreadable (${e.message}); refusing to ship`;
    return gate;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    gate.reason = `run state "${gate.stateFile}" is malformed; refusing to ship`;
    return gate;
  }
  const steps = state.steps && typeof state.steps === 'object' ? state.steps : {};
  const statusOf = (n) => (steps[n] && typeof steps[n] === 'object' && steps[n].status !== undefined
    ? String(steps[n].status)
    : null);
  gate.steps = { 4: statusOf(4), 6: statusOf(6) };
  if (gate.codeReviewRequired) gate.steps[7] = statusOf(7);
  gate.score = Number.isFinite(Number(state.score)) ? Number(state.score) : null;
  gate.scoreMin = Number.isFinite(Number(config.scoreMin)) ? Number(config.scoreMin) : 8;

  const failures = [];
  if (gate.steps[4] !== 'completed') failures.push(`step 4 is "${gate.steps[4] || 'missing'}" (expected "completed")`);
  if (gate.steps[6] !== 'completed') failures.push(`step 6 is "${gate.steps[6] || 'missing'}" (expected "completed")`);
  if (gate.codeReviewRequired && gate.steps[7] !== 'completed') {
    failures.push(`step 7 is "${gate.steps[7] || 'missing'}" (expected "completed" because code review is enabled)`);
  }
  if (gate.score === null) failures.push(`run score is missing (scoreMin ${gate.scoreMin})`);
  else if (gate.score < gate.scoreMin) failures.push(`run score ${gate.score} is below scoreMin ${gate.scoreMin}`);

  gate.passed = failures.length === 0;
  gate.reason = gate.passed ? null : failures.join('; ');
  return gate;
}

/**
 * Commits a dirty working tree before publishing. Returns null when the tree is clean.
 */
function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  // cmd.exe does not treat single quotes as quoting, so Windows needs double
  // quotes; POSIX shells get the safer single-quoted form.
  if (process.platform === 'win32') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// Parses `git status --porcelain` output. With -z the entries are NUL
// terminated, which keeps quoted, non-ASCII, and renamed paths intact.
function parsePorcelain(statusText) {
  const text = String(statusText || '');
  const entries = [];
  if (text.includes('\0')) {
    const tokens = text.split('\0');
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token.trim()) continue;
      const status = token.slice(0, 2).trim();
      entries.push({ status, path: token.slice(3).trim().replace(/\\/g, '/') });
      // Rename/copy entries carry the original path in the next NUL token.
      if (status.startsWith('R') || status.startsWith('C')) i += 1;
    }
    return entries.filter(entry => entry.path);
  }
  return text
    .split('\n')
    .filter(line => line.trim())
    .map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim().replace(/\\/g, '/') }))
    .filter(entry => entry.path);
}

function selectDirtyFiles(statusText, options = {}) {
  const normalize = p => String(p || '').trim().replace(/\\/g, '/');
  const entries = parsePorcelain(statusText);
  const approved = Array.isArray(options.approved) && options.approved.length > 0
    ? new Set(options.approved.map(normalize))
    : null;
  const runFiles = new Set((Array.isArray(options.runFiles) ? options.runFiles : []).map(normalize));
  const selected = approved
    ? entries.filter(entry => approved.has(entry.path))
    : entries.filter(entry => runFiles.has(entry.path));
  const excluded = entries.filter(entry => !selected.includes(entry));
  return {
    entries,
    selected,
    excluded,
    mode: approved ? 'approved-list' : (runFiles.size > 0 ? 'run-scope' : 'none')
  };
}

function commitDirtyWorktree(executor, projectRoot, options = {}) {
  const dryRun = Boolean(options.dryRun);
  let status = '';
  try {
    status = String(executor('git status --porcelain -z -uall') || '');
  } catch (e) {
    return null;
  }
  if (!status.trim()) return null;
  const selection = selectDirtyFiles(status, {
    approved: options.approved,
    runFiles: options.runFiles
  });
  const excluded = selection.excluded.map(entry => entry.path);
  if (selection.selected.length === 0) {
    return {
      skipped: true,
      mode: selection.mode,
      reason: selection.mode === 'none'
        ? 'no approved or run-scoped files; refusing to commit unrelated working-tree changes'
        : 'no approved or run-scoped file is currently dirty',
      excluded
    };
  }
  const files = selection.selected.map(entry => entry.path);
  if (dryRun) return { simulated: true, mode: selection.mode, files, excluded };
  const message = options.message || 'chore(delivery): include pending working-tree changes';
  try {
    for (const file of files) executor(`git add -A -- ${shellQuote(file)}`);
    // A plain `git commit` would commit the whole index, including files the
    // caller staged before this run. The pathspec limits the commit to the
    // approved selection and leaves everything else staged but uncommitted.
    executor(`git commit -m ${shellQuote(message)} -- ${files.map(shellQuote).join(' ')}`);
    const sha = String(executor('git rev-parse --short HEAD') || '').trim();
    return { sha, mode: selection.mode, files, excluded, message };
  } catch (e) {
    return { error: e.message, mode: selection.mode, files, excluded };
  }
}

// Reads an approved dirty-file list: a JSON file (`["a","b"]` or
// `{"files":[...]}`) or a comma-separated argument value.
function resolveApprovedDirtyFiles(value) {
  if (!value) return null;
  try {
    if (fs.existsSync(value)) {
      const data = JSON.parse(fs.readFileSync(value, 'utf8'));
      const list = Array.isArray(data) ? data : (Array.isArray(data.files) ? data.files : null);
      return list ? list.map(String) : null;
    }
  } catch (e) {
    return null;
  }
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

// Files the current run actually produced, used as the conservative default
// when the host agent has not produced an approved dirty-file list.
function collectRunFiles(projectRoot, options = {}, config = {}) {
  try {
    const specSlug = options.spec || options.specSlug || null;
    const statePath = locateStateFile(projectRoot, options.runId, specSlug, config);
    if (!statePath || !fs.existsSync(statePath)) return [];
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const files = new Set();
    const tasks = (state.steps && state.steps[4] && state.steps[4].tasks) || {};
    for (const task of Object.values(tasks)) {
      for (const file of task.filesChanged || []) files.add(String(file).replace(/\\/g, '/'));
    }
    if (state.specPath) files.add(String(state.specPath).replace(/\\/g, '/'));
    return [...files];
  } catch (e) {
    return [];
  }
}

/**
 * Post-merge work-lane synchronization (spec 00040 AC12/AC13).
 * Fast-forwards the work lane to the integration lane and optionally pushes it.
 * Any failure is reported as `blocked` and never fails the completed delivery.
 */
function syncWorkBranchAfterMerge(options = {}) {
  const executor = options.executor;
  const branching = options.branching || {};
  const integrationBranch = options.integrationBranch || null;
  const result = {
    status: 'skipped',
    reason: null,
    integrationBranch: null,
    workBranch: null,
    at: new Date().toISOString()
  };

  if (options.dryRun) {
    result.reason = 'dry-run';
    return result;
  }
  if (!branching.syncWorkBranchAfterMerge) {
    result.reason = 'syncWorkBranchAfterMerge disabled';
    return result;
  }
  const workBranch = typeof branching.workBranch === 'string' && branching.workBranch.trim()
    ? branching.workBranch.trim()
    : null;
  if (!workBranch) {
    result.reason = 'no work branch configured';
    return result;
  }

  const integration = integrationBranch || workBranch;
  result.workBranch = workBranch;
  result.integrationBranch = integration;

  let originalBranch = '';
  try {
    originalBranch = String(executor('git rev-parse --abbrev-ref HEAD') || '').trim();
  } catch (e) {
    originalBranch = '';
  }

  // AC13: a dirty working tree blocks the synchronization before any switch.
  let dirty = '';
  try {
    dirty = String(executor('git status --porcelain') || '').trim();
  } catch (statusErr) {
    result.status = 'blocked';
    result.reason = `unable to inspect the working tree: ${statusErr.message}`;
    return result;
  }
  if (dirty) {
    result.status = 'blocked';
    result.reason = 'working tree is dirty';
    return result;
  }

  const sameLane = workBranch === integration;
  const remediation = sameLane
    ? `git switch ${workBranch} && git fetch origin && git merge --ff-only origin/${integration}`
    : `git switch ${workBranch} && git fetch origin +refs/heads/${integration}:refs/remotes/origin/${integration} && git merge --ff-only origin/${integration}`;

  try {
    executor(`git switch ${workBranch}`);
  } catch (switchErr) {
    result.status = 'blocked';
    result.reason = `cannot switch to work branch "${workBranch}": ${switchErr.message}`;
    return result;
  }

  try {
    if (sameLane) {
      executor('git fetch origin');
      executor(`git merge --ff-only origin/${integration}`);
    } else {
      // AC13: write only the remote-tracking ref, so a failed fast-forward cannot
      // move the local integration branch and a narrowed fetch refspec cannot
      // leave origin/<integration> missing or stale.
      executor(`git fetch origin +refs/heads/${integration}:refs/remotes/origin/${integration}`);
      executor(`git merge --ff-only origin/${integration}`);
    }
  } catch (syncErr) {
    // AC13: never leave the repository on a half-synchronized branch.
    if (originalBranch) {
      try { executor(`git switch ${originalBranch}`); } catch (rollbackErr) {}
    }
    result.status = 'blocked';
    result.reason = `fast-forward to "${integration}" failed: ${syncErr.message}; resolve manually with: ${remediation}`;
    return result;
  }

  if (branching.pushSyncedWorkBranch) {
    try {
      executor(`git push origin ${workBranch}`);
    } catch (pushErr) {
      result.status = 'blocked';
      result.reason = `fast-forward applied but push failed: ${pushErr.message}`;
      return result;
    }
  }

  result.status = 'synced';
  result.reason = null;
  return result;
}

/**
 * Core PR Shipping execution
 */
async function runShipPr(options = {}, customExecutor = null) {
  const projectRoot = options.projectRoot || process.cwd();
  const executor = customExecutor || ((cmd, opts = {}) => execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }));

  const config = options.config || loadConfig(projectRoot);
  const dryRun = Boolean(options.dryRun);
  const verificationTimeoutMs = Number(config.verification && config.verification.timeoutMs) > 0
    ? Number(config.verification.timeoutMs)
    : 600000;

  // 1. Resolve branches
  let head = options.head;
  if (!head) {
    try {
      head = executor('git rev-parse --abbrev-ref HEAD').trim();
    } catch (e) {
      head = 'HEAD';
    }
  }

  // AC11: the pull request base is the configured integration lane; explicit
  // --base and the legacy fallbacks keep lower priority.
  let branching = null;
  if (sdwConfig && typeof sdwConfig.resolveBranching === 'function') {
    try {
      branching = sdwConfig.resolveBranching(config);
    } catch (branchConfigErr) {
      branching = null;
    }
  }
  const integrationBranch = branching && typeof branching.integrationBranch === 'string' && branching.integrationBranch.trim()
    ? branching.integrationBranch.trim()
    : null;

  let base = options.base || integrationBranch || config.baseBranch || 'master';
  if (!options.base && !integrationBranch && !config.baseBranch) {
    try {
      const remotes = executor('git remote').trim();
      if (remotes) {
        const remoteInfo = executor('git remote show origin');
        const match = remoteInfo.match(/HEAD branch:\s*([^\s]+)/);
        if (match && match[1]) {
          base = match[1];
        }
      }
    } catch (e) {
      base = 'master';
    }
  }

  // AC2: `auto` integration lanes resolve to the detected base, so mirror
  // presets (github, gitlab) get a concrete work lane for post-merge sync.
  if (branching && (!branching.integrationBranch || !String(branching.integrationBranch).trim())) {
    branching.integrationBranch = base;
    if (branching.mirrorWorkToIntegration && (!branching.workBranch || !String(branching.workBranch).trim())) {
      branching.workBranch = base;
    }
  }

  const specSlug = options.spec || options.specSlug || null;
  if (specSlug) assertSafeSlug(specSlug);
  assertSafeRef(head, 'head');
  assertSafeRef(base, 'base');
  const specTitle = getSpecTitle(projectRoot, specSlug);
  const issueLink = resolveIssueLink(projectRoot, specSlug);
  const branchCommits = listBranchCommits(executor, base, head);
  const branchFiles = listBranchFiles(executor, base, head);
  const title = buildPrTitle({ explicit: options.title, specSlug, specTitle, head, base, commits: branchCommits });
  const body = buildPrBody({
    explicit: options.body, specSlug, specTitle, head, base,
    commits: branchCommits, files: branchFiles, config, issueLink
  });

  const pushDelivery = options.push || Boolean(config.pushDelivery);
  const scmProviderName = config.scmProvider || 'none';
  const scmCodeReviewEnabled = options.pollPr || Boolean(config.scmCodeReviewEnabled);
  // Spec 00050 AC9: Step 7 only exists when review actually runs for this ship.
  const codeReviewGateEnabled = scmCodeReviewEnabled && scmProviderName !== 'none';

  const report = {
    success: false,
    head,
    base,
    scmProvider: scmProviderName,
    // AC8: the resolved linkage is observable on success and failure runs.
    issueLink,
    pushed: false,
    prePrPassed: false,
    prePrBoard: [],
    prepareDiscovery: null,
    prepareObligations: [],
    prepareAck: null,
    runStateGate: null,
    pullRequest: null,
    // Spec 024 AC26: when merge is requested, an audit record exists from the
    // start, so a delivery that fails before the merge step still explains why
    // no merge happened.
    merge: options.merge
      ? { requested: true, attempted: false, ok: null, reason: 'delivery did not reach merge step' }
      : null,
    branchingSync: null,
    reviewConvergence: {
      enabled: scmCodeReviewEnabled,
      converged: false,
      rounds: 0,
      resolvedThreads: 0,
      activeThreads: 0,
      pendingThreads: [],
      failingChecks: [],
      checksStart: null,
      issuesFixed: []
    },
    shipStatus: 'pending',
    error: null
  };

  const log = options.json ? console.error : console.log;
  const warn = options.json ? console.error : console.warn;

  // AC7: dry-run prints the assembled body, closing keyword included, and the
  // simulated PR path issues no create or edit command.
  if (dryRun) {
    log('[sdw-ship-pr] (dry-run) Assembled pull request body:');
    log(body);
  }

  try {
    // Step 1: Pre-PR Verification Gates
    log('[sdw-ship-pr] Evaluating pre-PR requirements...');

    if (config.prePrInstructions) {
      log(`[sdw-ship-pr] Pre-PR Instructions: ${config.prePrInstructions}`);
    }

    const gateFailures = [];
    const boardRow = (check, status, evidence) => report.prePrBoard.push({ check, status, evidence });
    const failGate = (check, message) => {
      boardRow(check, 'fail', message);
      gateFailures.push(message);
    };

    if (!config.prePrCommand) {
      boardRow('prePrCommand', 'skipped', 'prePrCommand is not configured');
    } else if (dryRun) {
      log(`[sdw-ship-pr] (dry-run) prePrCommand not executed: "${config.prePrCommand}".`);
      boardRow('prePrCommand', 'skipped', 'dry-run: prePrCommand was not executed');
    } else {
      log(`[sdw-ship-pr] Running prePrCommand: "${config.prePrCommand}"...`);
      const beforePrePr = listChangedPaths(executor);
      try {
        executor(config.prePrCommand, { timeout: verificationTimeoutMs });

        // Stage only files produced by the command; never sweep unrelated worktree changes.
        const changed = stageChangedSince(executor, beforePrePr, projectRoot);
        if (changed.length > 0) {
          // Scan the staged pre-PR changes before creating history.
          if (config.securityChecksEnabled) {
            let securityScanner = null;
            try {
              securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
            } catch (e) {
              securityScanner = null;
            }
            if (!securityScanner || typeof securityScanner.scan !== 'function') {
              throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
            }
            const scanResult = securityScanner.scan({ root: projectRoot, staged: true });
            if (scanResult.exitCode !== 0) {
              throw new Error(`Security checks failed on pre-PR changes: ${scanResult.message || 'blocking findings detected'}`);
            }
          }

          log(`[sdw-ship-pr] Committing ${changed.length} pre-PR change(s)...`);
          const safeSlug = specSlug && specSlug !== 'unspecified' && /^[a-z0-9][a-z0-9-]*$/.test(specSlug) ? specSlug : null;
          const commitMsg = safeSlug ? `chore(${safeSlug}): apply pre-pr requirements` : 'chore: apply pre-pr requirements';
          const commitRes = spawnSync('git', ['commit', '-m', commitMsg], { cwd: projectRoot, stdio: 'ignore' });
          if (commitRes.status !== 0) {
            throw new Error(`pre-PR commit failed with exit code ${commitRes.status}`);
          }
        }
        boardRow('prePrCommand', 'pass', `"${config.prePrCommand}" exited 0`);
      } catch (cmdErr) {
        const message = /^prePrCommand failed:/.test(cmdErr.message)
          ? cmdErr.message
          : `prePrCommand failed: ${cmdErr.message}`;
        failGate('prePrCommand', message);
      }
    }

    if (!config.requiredBuild) {
      boardRow('build', 'skipped', 'requiredBuild is false');
    } else if (dryRun) {
      log('[sdw-ship-pr] (dry-run) requiredBuild not executed.');
      boardRow('build', 'skipped', 'dry-run: build was not executed');
    } else {
      const buildCmd = (config.verification && config.verification.buildCommand) || 'npm run build';
      log(`[sdw-ship-pr] Running requiredBuild (${buildCmd})...`);
      try {
        executor(buildCmd, { timeout: verificationTimeoutMs });
        boardRow('build', 'pass', `${buildCmd} exited 0`);
      } catch (buildErr) {
        failGate('build', `requiredBuild failed: ${buildErr.message}`);
      }
    }

    if (!config.runAllTests) {
      boardRow('tests', 'skipped', 'runAllTests is false');
    } else if (dryRun) {
      log('[sdw-ship-pr] (dry-run) runAllTests not executed.');
      boardRow('tests', 'skipped', 'dry-run: tests were not executed');
    } else {
      const testCmd = (config.verification && config.verification.testCommand) || 'npm test';
      log(`[sdw-ship-pr] Running runAllTests (${testCmd})...`);
      try {
        executor(testCmd, { timeout: verificationTimeoutMs });
        boardRow('tests', 'pass', `${testCmd} exited 0`);
      } catch (testErr) {
        failGate('tests', `runAllTests failed: ${testErr.message}`);
      }
    }

    if (!config.securityChecksEnabled) {
      boardRow('security', 'skipped', 'securityChecksEnabled is false');
    } else if (dryRun) {
      log('[sdw-ship-pr] (dry-run) security leak checks not executed.');
      boardRow('security', 'skipped', 'dry-run: security scan was not executed');
    } else {
      log('[sdw-ship-pr] Evaluating security leak checks...');
      try {
        let securityScanner = null;
        try {
          securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
        } catch (e) {
          securityScanner = null;
        }
        if (!securityScanner || typeof securityScanner.scan !== 'function') {
          throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
        }

        // Scan the worktree: pre-PR changes are not staged yet.
        const scanResult = securityScanner.scan({ root: projectRoot, staged: false });
        if (scanResult.exitCode !== 0) {
          throw new Error(`Security checks failed: ${scanResult.message || 'blocking findings detected'}`);
        }
        boardRow('security', 'pass', 'sdw-security-checks found no blocking leak');
      } catch (securityErr) {
        failGate('security', securityErr.message);
      }
    }

    // Step 1b: Run-state evidence and discovered prepare obligations (spec 00050).
    // Both are read-only file checks, so they are evaluated in dry-run too; the
    // ship refuses after every unmet obligation has been printed.
    const discoveryMode = resolvePrePrDiscovery(config);
    report.prepareDiscovery = discoveryMode;

    if (options.runId) {
      const runStateGate = evaluateRunStateGate(projectRoot, options.runId, specSlug, config, {
        scmCodeReviewEnabled: codeReviewGateEnabled
      });
      report.runStateGate = runStateGate;
      if (runStateGate.passed) {
        const stepsLabel = runStateGate.codeReviewRequired ? 'step 4, step 6 and step 7' : 'step 4 and step 6';
        log(`[sdw-ship-pr] Run-state gate passed: ${stepsLabel} completed, score ${runStateGate.score} >= scoreMin ${runStateGate.scoreMin}.`);
        boardRow('runState', 'pass', `${stepsLabel} completed; score ${runStateGate.score} >= scoreMin ${runStateGate.scoreMin}`);
      } else {
        warn(`[sdw-ship-pr] Run-state gate failed: ${runStateGate.reason}.`);
        failGate('runState', `run-state gate failed for "${options.runId}": ${runStateGate.reason}`);
      }
    } else {
      log('[sdw-ship-pr] Run-state gate skipped: --run-id not supplied (standalone ship).');
      boardRow('runState', 'skipped', '--run-id not supplied (standalone ship)');
    }

    if (discoveryMode === 'off') {
      log('[sdw-ship-pr] Prepare discovery skipped: prePrDiscovery is "off".');
      boardRow('discovery', 'skipped', 'prePrDiscovery is "off"');
    } else {
      const prepareObligations = discoverPrepareObligations(projectRoot, config);
      report.prepareObligations = prepareObligations;
      if (prepareObligations.length > 0) {
        log(`[sdw-ship-pr] Discovered ${prepareObligations.length} prepare obligation(s) (prePrDiscovery: ${discoveryMode}):`);
        for (const row of prepareObligations) {
          log(`[sdw-ship-pr]   [${row.source}] ${row.heading}`);
          if (row.body) {
            for (const line of row.body.split('\n')) log(`[sdw-ship-pr]     ${line}`);
          }
        }
      } else {
        log('[sdw-ship-pr] No prepare obligations discovered.');
      }

      if (prepareObligations.length === 0) {
        boardRow('discovery', 'pass', 'no prepare obligations discovered');
      } else if (options.ackPrepare) {
        boardRow('discovery', 'pass', `acknowledged via --ack-prepare: ${options.ackPrepare}`);
      } else if (discoveryMode === 'block') {
        report.prepareDiscovery = 'blocked';
        failGate('discovery', `prepare discovery gate failed: prePrDiscovery is "block" and ${prepareObligations.length} prepare obligation(s) are unacknowledged; complete them and re-run with --ack-prepare "<note>"`);
      } else {
        warn(`[sdw-ship-pr] prePrDiscovery is "warn": continuing despite ${prepareObligations.length} prepare obligation(s).`);
        boardRow('discovery', 'pass', `prePrDiscovery "warn": ${prepareObligations.length} obligation(s) printed; ship continues`);
      }
    }

    if (options.ackPrepare) {
      report.prepareAck = { note: options.ackPrepare, at: new Date().toISOString() };
      log(`[sdw-ship-pr] Prepare obligations acknowledged via --ack-prepare: ${options.ackPrepare}`);
    }

    // Spec 00050 AC11/AC12: one row per evaluated check, printed before the push.
    if (!options.json) {
      for (const row of report.prePrBoard) {
        log(`[sdw-ship-pr] prePrBoard ${row.status}: ${row.check} - ${row.evidence}`);
      }
      log('[sdw-ship-pr] Pre-PR board:');
      log(formatPrePrBoard(report.prePrBoard));
    }

    if (gateFailures.length > 0) {
      throw new Error(`Pre-PR enforcement refused to push or create a pull request. ${gateFailures.join(' ')}`);
    }
    report.prePrPassed = true;

    // Check if an active PR is already open for this branch
    let activePrEarly = null;
    let providerEarly = null;
    if (scmProviderName !== 'none' && scmContract) {
      try {
        const capability = scmContract.checkScmCapability(scmProviderName, { executor });
        if (capability.available || dryRun) {
          providerEarly = scmContract.createScmProvider(scmProviderName, { executor });
          if (typeof providerEarly.findActivePullRequest === 'function') {
            activePrEarly = await providerEarly.findActivePullRequest({ head, base });
            if (activePrEarly) {
              log(`[sdw-ship-pr] Active PR #${activePrEarly.number} detected (${activePrEarly.url || 'open'}). Notice: Amending an active pull request while review/approval is pending is not a recommended practice, but adapting as a non-blocking operation: complementing PR with new commits and delivery details.`);
            }
          }
        }
      } catch (e) {}
    }

    // Step 2: Remote Branch Publishing
    if (pushDelivery) {
      if (dryRun) {
        log(`[sdw-ship-pr] (dry-run) git push -u origin ${head}`);
        report.pushed = true;
      } else {
        let hasRemote = false;
        try {
          const remotes = executor('git remote').toString().trim();
          hasRemote = Boolean(remotes);
        } catch (e) {}

        if (!hasRemote) {
          log('[sdw-ship-pr] Remote push skipped: no git remote configured.');
        } else {
          const approvedFiles = resolveApprovedDirtyFiles(options.dirtyFilesPath);
          const runFiles = collectRunFiles(projectRoot, options, config);
          const dirtyCommit = commitDirtyWorktree(executor, projectRoot, {
            approved: approvedFiles,
            runFiles,
            message: options.dirtyCommitMessage || config.dirtyCommitMessage
          });
          if (dirtyCommit) {
            report.dirtyCommit = dirtyCommit;
            if (dirtyCommit.skipped) {
              warn(`[sdw-ship-pr] Working tree is dirty; commit skipped (${dirtyCommit.reason}).`);
            } else if (dirtyCommit.error) {
              // A selected commit that fails means the push would publish a branch
              // without the delivered work. Fail closed instead of shipping it.
              throw new Error(`Selected working-tree changes could not be committed before push: ${dirtyCommit.error}`);
            } else {
              log(`[sdw-ship-pr] Committed ${dirtyCommit.files.length} ${dirtyCommit.mode} file(s) as ${dirtyCommit.sha} before pushing${dirtyCommit.excluded.length ? `; ${dirtyCommit.excluded.length} unrelated file(s) left dirty` : ''}.`);
            }
          }
          log(`[sdw-ship-pr] Pushing branch ${head} to remote origin${activePrEarly ? ` (complementing active PR #${activePrEarly.number})` : ''}...`);
          try {
            executor(`git push -u origin ${head}`);
            report.pushed = true;
          } catch (pushErr) {
            throw new Error(`git push failed: ${pushErr.message}`);
          }
        }
      }
    }

    // Step 3: Pull Request Creation / Idempotent Reuse
    if (scmProviderName === 'none') {
      log('[sdw-ship-pr] scmProvider is set to "none". Skipping remote pull request creation.');
      report.shipStatus = 'delivered_local';
      report.success = true;
    } else {
      if (!scmContract) {
        throw new Error('SCM provider contract module is unavailable.');
      }

      const capability = scmContract.checkScmCapability(scmProviderName, { executor });
      if (!capability.available && !dryRun) {
        throw new Error(capability.error || `SCM CLI capability check failed for ${scmProviderName}.`);
      }

      log(`[sdw-ship-pr] Preparing pull request via ${scmProviderName}...`);
      const provider = providerEarly || scmContract.createScmProvider(scmProviderName, { executor });

      const prResult = await provider.createPullRequest({
        title,
        body,
        head,
        base,
        draft: false,
        dryRun
      });

      report.pullRequest = {
        number: prResult.number,
        url: prResult.url,
        head: prResult.head,
        base: prResult.base,
        reused: prResult.reused || false,
        dryRun: prResult.dryRun || false
      };

      log(`[sdw-ship-pr] Pull request ${prResult.reused ? 'reused' : 'created'}: ${prResult.url || '(dry-run simulated)'}`);

      // When an active PR is open/reused, complement the PR and update description if relevant
      if (prResult.reused && prResult.number && typeof provider.updatePullRequest === 'function') {
        const headCommit = safeGit(executor, 'git rev-parse --short HEAD').trim() || 'HEAD';
        const latestList = branchCommits.slice(0, 5).map((c) => `- \`${c.short}\` ${c.subject}`).join('\n');
        const amendmentNote = [
          `### Amending Delivery${specSlug && specSlug !== 'unspecified' ? `: ${specSlug}` : ''}`,
          `- Commit: \`${headCommit}\``,
          `- HEAD: \`${headCommit}\``,
          `- Timestamp: ${new Date().toISOString()}`,
          `- Commits in range \`${base}..${head}\`: ${branchCommits.length}`,
          `- Files changed: ${branchFiles.length}`,
          latestList ? `#### Latest commits\n${latestList}` : null
        ].filter(Boolean).join('\n');
        const amendment = options.body || amendmentNote || body;
        const closingKeyword = issueLink.present ? issueLink.keyword : null;
        let newBodyContent = amendment;
        let appendBody = true;
        if (closingKeyword) {
          // AC6: the body carries the closing keyword exactly once. Read the
          // reused body, drop any previous closing line, and rewrite in one write.
          const existingBody = readPullRequestBody(scmProviderName, prResult.number, executor);
          if (existingBody !== null) {
            const combined = [existingBody, amendment].filter((part) => String(part || '').trim()).join('\n\n---\n\n');
            newBodyContent = appendClosingKeyword(combined, closingKeyword);
            appendBody = false;
          } else {
            // The existing body could not be read; append the amendment with the
            // keyword rather than overwrite content this run did not see.
            newBodyContent = appendClosingKeyword(amendment, closingKeyword);
          }
        }
        if (newBodyContent || (!options.title && title)) {
          try {
            log(`[sdw-ship-pr] Notice: Amending an active pull request while review/approval is pending is not a recommended practice, but adapting as a non-blocking operation: complementing PR #${prResult.number} description with amending delivery...`);
            await provider.updatePullRequest({
              prNumber: prResult.number,
              title: options.title ? undefined : title,
              body: newBodyContent,
              appendBody,
              dryRun
            });
            log(`[sdw-ship-pr] Successfully updated PR description for PR #${prResult.number}.`);
          } catch (editErr) {
            warn(`[sdw-ship-pr] Warning: Could not update description for active PR #${prResult.number}: ${editErr.message}`);
          }
        }
      }

      // Step 4: Post-PR Review Convergence
      if (scmCodeReviewEnabled) {
        log(`[sdw-ship-pr] SCM review convergence enabled for PR #${prResult.number || 'simulate'}.`);
        const maxRounds = options.maxIterations || 3;
        const pollIntervalMs = options.pollIntervalMs === undefined
          ? 20000
          : Math.max(0, Number(options.pollIntervalMs) || 0);
        // Native SCM wait first: a provider that supports watch blocks until the
        // checks settle, so no shell timer is needed. Otherwise interval polling.
        const nativeWatch = pollIntervalMs > 0
          && !dryRun
          && options.nativeWatch !== false
          && Boolean(provider && typeof provider.supportsNativeWatch === 'function' && provider.supportsNativeWatch());
        const checksStartTimeoutMs = options.checksStartTimeoutMs === undefined
          ? 30000
          : (Number.isFinite(Number(options.checksStartTimeoutMs)) ? Math.max(0, Number(options.checksStartTimeoutMs)) : 30000);
        const checksStartIntervalMs = options.checksStartIntervalMs === undefined
          ? 5000
          : (Number.isFinite(Number(options.checksStartIntervalMs)) ? Math.max(10, Number(options.checksStartIntervalMs)) : 5000);
        const awaitChecksToStart = async () => {
          if (dryRun || pollIntervalMs <= 0 || checksStartTimeoutMs <= 0 || !prResult.number) return;
          const startedAt = Date.now();
          let polls = 0;
          while (true) {
            polls += 1;
            let observed = 0;
            try {
              const snapshot = await provider.checkPrStatus(prResult.number);
              observed = snapshot && Array.isArray(snapshot.checks) ? snapshot.checks.length : 0;
            } catch (e) {
              observed = 0;
            }
            const waitedMs = Date.now() - startedAt;
            if (observed > 0) {
              report.reviewConvergence.checksStart = { detected: true, waitedMs, polls };
              if (waitedMs >= 1000) {
                log(`[sdw-ship-pr] ${observed} check(s) reported after ${waitedMs}ms; watching the pipeline.`);
              }
              return;
            }
            if (waitedMs + checksStartIntervalMs > checksStartTimeoutMs) {
              report.reviewConvergence.checksStart = { detected: false, waitedMs, polls };
              warn(`[sdw-ship-pr] No check run started within ${checksStartTimeoutMs}ms; continuing with ${nativeWatch ? 'the native check watch' : 'the poll interval'}.`);
              return;
            }
            await new Promise(r => setTimeout(r, checksStartIntervalMs));
          }
        };
        const waitForNextRound = async () => {
          await awaitChecksToStart();
          if (nativeWatch && prResult.number) {
            try {
              const seconds = Math.max(1, Math.ceil(pollIntervalMs / 1000) || 10);
              log(`[sdw-ship-pr] Waiting with native check watch (${scmProviderName} PR #${prResult.number}).`);
              await provider.watchPrChecks(prResult.number, { intervalSeconds: seconds });
              return;
            } catch (watchErr) {
              // The watch can end early (no checks registered yet, runner errors).
              // Fall through to the interval fallback so the settle period is kept.
              warn(`[sdw-ship-pr] Native check watch ended (${watchErr.message}); falling back to the poll interval.`);
            }
          }
          if (pollIntervalMs > 0) await new Promise(r => setTimeout(r, pollIntervalMs));
        };
        const reviewFixCommand = options.reviewFixCommand || config.reviewFixCommand || null;
        const testCommand = (config.verification && config.verification.testCommand) || 'npm test';
        const runReviewSecurityGate = () => {
          if (!config.securityChecksEnabled || dryRun) return;
          let securityScanner = null;
          try {
            securityScanner = require('../../sdw-security-checks/scripts/sdw_security_checks.cjs');
          } catch (e) {
            securityScanner = null;
          }
          if (!securityScanner || typeof securityScanner.scan !== 'function') {
            throw new Error('Security checks enabled but the sdw-security-checks scanner is unavailable.');
          }
          const scanResult = securityScanner.scan({ root: projectRoot, staged: false });
          if (scanResult.exitCode !== 0) {
            throw new Error(`Security checks failed on review fix: ${scanResult.message || 'blocking findings detected'}`);
          }
        };
        let round = 0;
        let converged = false;

        // Concurrent-push adaptation: CI check states observed per round so a
        // superseded run (cancelled by a newer push) is recognized as preemption,
        // not failure. A preempted round grants the replacement run a fresh
        // convergence window instead of burning the iteration budget.
        const FAILED_CHECK_STATES = new Set(['fail', 'failure', 'failed', 'action_required', 'rejected', 'broken', 'timed_out', 'startup_failure']);
        const SUPERSEDED_CHECK_STATES = new Set(['cancelled', 'cancel']);
        const PENDING_CHECK_STATES = new Set(['pending', 'in_progress', 'queued', 'waiting', 'running']);
        const stateOf = c => String(c.state || '').toLowerCase();
        const bucketOf = c => String(c.bucket || '').toLowerCase();
        const isFailedCheck = c => !isSupersededCheck(c) && (FAILED_CHECK_STATES.has(stateOf(c)) || FAILED_CHECK_STATES.has(bucketOf(c)));
        const isSupersededCheck = c => SUPERSEDED_CHECK_STATES.has(stateOf(c)) || SUPERSEDED_CHECK_STATES.has(bucketOf(c));
        const checkClassOf = c => {
          if (isFailedCheck(c)) return 'failed';
          if (isSupersededCheck(c)) return 'superseded';
          if (PENDING_CHECK_STATES.has(stateOf(c)) || PENDING_CHECK_STATES.has(bucketOf(c))) return 'pending';
          return 'passed';
        };
        const maxPreemptions = Number.isFinite(Number(options.maxPreemptions ?? config.maxPreemptions))
          ? Math.max(0, Number(options.maxPreemptions ?? config.maxPreemptions))
          : 3;
        let preemptions = 0;
        let prevCheckClasses = null;
        report.reviewConvergence.preemptions = 0;
        report.reviewConvergence.supersededChecks = [];

        while (round < maxRounds && !converged) {
          round++;
          report.reviewConvergence.rounds = round;
          log(`[sdw-ship-pr] Convergence round ${round}/${maxRounds}...`);

          if (dryRun) {
            log('[sdw-ship-pr] (dry-run) Simulating review convergence checks and active thread resolution.');
            report.reviewConvergence.converged = true;
            report.reviewConvergence.activeThreads = 0;
            converged = true;
            break;
          }

          // Check CI and policies
          const status = await provider.checkPrStatus(prResult.number);
          const reviewThreads = await provider.listReviewThreads(prResult.number);

          report.reviewConvergence.activeThreads = reviewThreads.activeCount;

          if (status.allPassed && reviewThreads.activeCount === 0) {
            log('[sdw-ship-pr] All checks passed and 0 active review threads detected. Review converged successfully.');
            converged = true;
            report.reviewConvergence.converged = true;
            break;
          }

          const activeList = reviewThreads.threads.filter(t => !t.isResolved);
          const failingChecks = (status.checks || []).filter(isFailedCheck);
          const supersededChecks = (status.checks || []).filter(isSupersededCheck);
          report.reviewConvergence.failingChecks = failingChecks;
          report.reviewConvergence.supersededChecks = supersededChecks;

          // Adaptation: a check that moved from a terminal state back to pending
          // (or a changed check set between rounds) means a newer CI run replaced
          // the observed one, typically after a concurrent push to the head branch.
          // Grant the replacement run a fresh window instead of halting.
          const checkClasses = new Map((status.checks || []).map(c => [c.name, checkClassOf(c)]));
          let preempted = false;
          if (prevCheckClasses && prevCheckClasses.size > 0) {
            if (checkClasses.size !== prevCheckClasses.size) {
              preempted = true;
            } else {
              for (const [name, cls] of checkClasses) {
                const prev = prevCheckClasses.get(name);
                const wasTerminal = prev === 'superseded' || prev === 'failed' || prev === 'passed';
                if (wasTerminal && cls === 'pending') {
                  preempted = true;
                  break;
                }
                if ((prev === 'superseded' || prev === 'failed') && cls === 'passed') {
                  preempted = true;
                  break;
                }
              }
            }
          }
          prevCheckClasses = checkClasses;
          if (preempted) {
            if (preemptions < maxPreemptions) {
              preemptions++;
              report.reviewConvergence.preemptions = preemptions;
              log(`[sdw-ship-pr] Detected superseded CI run replaced by a newer run (preemption ${preemptions}/${maxPreemptions}). Adapting: resetting convergence window.`);
              round = 0;
              await waitForNextRound();
              continue;
            }
            warn(`[sdw-ship-pr] Preemption budget exhausted (${maxPreemptions}); continuing with latest status.`);
          }
          if (supersededChecks.length > 0 && failingChecks.length === 0) {
            log(`[sdw-ship-pr] ${supersededChecks.length} superseded check(s) awaiting replacement run; waiting without treating them as failures.`);
          }

          // Failing CI with no review threads still needs a fixer. Reuse the same
          // test/security/scoped-commit/push gates before polling again.
          if (failingChecks.length > 0 && activeList.length === 0) {
            if (reviewFixCommand) {
              log(`[sdw-ship-pr] ${failingChecks.length} failing check(s); applying reviewFixCommand...`);
              const beforeCheckFix = listChangedPaths(executor);
              executor(reviewFixCommand);
              if (config.runAllTests) executor(testCommand);
              runReviewSecurityGate();
              const changed = stageChangedSince(executor, beforeCheckFix, projectRoot);
              if (changed.length > 0) {
                executor('git commit -m "fix(review): address failing checks"');
                executor(`git push origin ${head}`);
                await waitForNextRound();
                continue;
              }
              warn('[sdw-ship-pr] reviewFixCommand produced no changes for the failing checks.');
            } else if (typeof options.threadFixer === 'function') {
              const fixResult = await options.threadFixer({
                provider,
                prNumber: prResult.number,
                threads: [],
                checks: failingChecks,
                projectRoot,
                executor
              });
              if (fixResult && fixResult.fixed === true) {
                runReviewSecurityGate();
                await waitForNextRound();
                continue;
              }
              warn('[sdw-ship-pr] threadFixer did not confirm a fix for the failing checks.');
            } else {
              warn(`[sdw-ship-pr] ${failingChecks.length} failing check(s) with no configured fixer; leaving them as blockers.`);
            }
          }

          // If active threads exist, resolve them
          if (activeList.length > 0) {
            log(`[sdw-ship-pr] Detected ${activeList.length} active review thread(s).`);

            const pendingThreads = activeList.map(thread => ({
              threadId: thread.id,
              path: thread.path || null,
              line: thread.line || null,
              body: thread.comments && thread.comments[0] ? thread.comments[0].body : 'Review feedback'
            }));

            let fixSummary = 'Applied and verified the requested review fix.';
            let canResolve = false;
            let fixResult = null;
            // Structured sdw-fixer output, consumed collaboratively: fixed
            // threads get the fixer's own resolution comment, skipped threads
            // stay open with the recorded reason.
            let fixerReport = null;
            // Delegate to sdw-fixer when no explicit reviewFixCommand is set (AC13).
            // Non-catalog rules record skipped entries with status no-op, so the
            // delegation is observable and never misread as completed work.
            const defaultFixer = reviewFixCommand ? null : buildDefaultFixerCommand(projectRoot, activeList);
            const effectiveFixCommand = reviewFixCommand || (defaultFixer && defaultFixer.command) || null;
            if (defaultFixer) {
              log(`[sdw-ship-pr] reviewFixCommand unset; delegating to sdw-fixer: ${defaultFixer.command}`);
            }
            if (typeof options.threadFixer === 'function') {
              // The caller owns applying, testing, committing, and pushing the fix.
              fixResult = await options.threadFixer({
                provider,
                prNumber: prResult.number,
                threads: activeList,
                projectRoot,
                executor
              });
              if (!fixResult || fixResult.fixed !== true) {
                warn('[sdw-ship-pr] threadFixer did not confirm a fix; leaving review threads active.');
                report.reviewConvergence.pendingThreads = pendingThreads;
                break;
              }
              fixSummary = fixResult.summary || fixSummary;
              runReviewSecurityGate();
              canResolve = true;
            } else if (effectiveFixCommand) {
              log(`[sdw-ship-pr] Applying review fixes via review fix command: ${effectiveFixCommand}`);
              const beforeReviewFix = listChangedPaths(executor);
              executor(effectiveFixCommand);

              if (config.runAllTests) {
                log(`[sdw-ship-pr] Verifying review fixes with test command: ${testCommand}`);
                executor(testCommand);
              }

              runReviewSecurityGate();

              const changed = stageChangedSince(executor, beforeReviewFix, projectRoot);
              // Surface a fixer no-op explicitly: a delegated batch that changed
              // nothing is not remediation — threads stay open for agent handling.
              try {
                const fixerReportPath = defaultFixer && defaultFixer.reportPath;
                if (fixerReportPath && fs.existsSync(fixerReportPath)) {
                  fixerReport = JSON.parse(fs.readFileSync(fixerReportPath, 'utf8'));
                  if (fixerReport && fixerReport.status === 'no-op') {
                    warn('[sdw-ship-pr] sdw-fixer reported no-op: no deterministic fix applies to these threads; manual agent remediation required (see cooperative protocol above).');
                  }
                  if (fixerReport && Array.isArray(fixerReport.amendments) && fixerReport.amendments.length > 0) {
                    log(`[sdw-ship-pr] sdw-fixer recorded ${fixerReport.amendments.length} amendment(s) while applying the batch.`);
                  }
                }
              } catch (e) {}
              if (changed.length === 0) {
                // Nothing deterministic to apply. If CI is still settling, consume
                // the native watch (or interval fallback) and re-read the PR state
                // instead of ending on a stale snapshot.
                const checksStillSettling = !status || !Array.isArray(status.checks) || status.checks.length === 0
                  || status.checks.some(c => PENDING_CHECK_STATES.has(stateOf(c)) || PENDING_CHECK_STATES.has(bucketOf(c)));
                if (checksStillSettling) {
                  warn('[sdw-ship-pr] reviewFixCommand produced no changes; waiting for checks to settle before re-polling.');
                  await waitForNextRound();
                  continue;
                }
                warn('[sdw-ship-pr] reviewFixCommand produced no changes; refusing to resolve review threads.');
                report.reviewConvergence.pendingThreads = pendingThreads;
                break;
              }

              executor('git commit -m "fix(review): address review feedback"');
              executor(`git push origin ${head}`);
              canResolve = true;
            } else {
              warn('[sdw-ship-pr] Active review threads require a code fix. Follow the cooperative review fix protocol:');
              warn('  1. Fetch all threads (list-threads)');
              warn('  2. Analyze root causes & name defect class across the pull request');
              warn('  3. Proactively fix all occurrences in sibling files');
              warn('  4. Verify with test suite (npm test)');
              warn('  5. Stage and commit (git commit -m "fix(review): address review feedback")');
              warn('  6. Push to remote tracking branch (git push origin <head>)');
              warn('  7. Close related threads with resolution comment (resolve-thread)');
              report.reviewConvergence.pendingThreads = pendingThreads;
              // Do not break: the external reviewer or a separate agent may resolve the threads
              // after applying fixes. The loop only observes and never resolves them itself.
            }

            if (canResolve) {
              let commitSha = '';
              try {
                commitSha = executor('git rev-parse --short HEAD').toString().trim();
              } catch (e) {}

              // Consume the fixer report: only threads the fixer actually fixed
              // are resolved, each with the fixer's own resolution comment.
              const fixerComments = new Map();
              if (fixerReport && Array.isArray(fixerReport.comments)) {
                for (const c of fixerReport.comments) {
                  if (c && c.threadId) fixerComments.set(c.threadId, c.comment);
                }
              }
              const fixerDelegated = Boolean(defaultFixer);
              if (fixerDelegated && fixerComments.size === 0) {
                warn('[sdw-ship-pr] sdw-fixer produced no readable report; leaving every review thread open.');
              }
              for (const thread of activeList) {
                if (fixerDelegated && fixerComments.size === 0) continue;
                if (fixerComments.size > 0 && !fixerComments.has(thread.id)) {
                  warn(`[sdw-ship-pr] sdw-fixer left thread ${thread.id} open: no deterministic fix applied.`);
                  continue;
                }
                const fixerNote = fixerComments.get(thread.id);
                const perThreadSummary = fixerNote
                  || (fixResult && fixResult.resolutions && fixResult.resolutions[thread.id])
                  || fixSummary;
                const commitLine = commitSha ? `Fixed in commit ${commitSha}.\n\n` : '';
                const summaryNote = fixerNote
                  ? `${fixerNote}\n\n${commitLine}`.trim()
                  : `<!-- resolution-reply -->\nResolved review issue: applied fix and verified acceptance criteria.\n\n${commitLine}Summary: ${perThreadSummary}`;

                const resolveRes = await provider.resolveReviewThread({
                  prNumber: prResult.number,
                  threadId: thread.id,
                  commentId: thread.comments && thread.comments[0] ? thread.comments[0].id : null,
                  comment: summaryNote,
                  model: 'sdw-ship-pr',
                  dryRun
                });

                if (resolveRes.resolved) {
                  report.reviewConvergence.resolvedThreads++;
                  report.reviewConvergence.issuesFixed.push({
                    threadId: thread.id,
                    resolution: summaryNote
                  });
                  log(`[sdw-ship-pr] Closed and resolved review thread ${thread.id} with resolution summary.`);
                }
              }
            }

            // Re-evaluate checks and review threads after the resolution pass. The pre-fix status
            // snapshot is stale once a commit is pushed.
            const updatedStatus = await provider.checkPrStatus(prResult.number);
            const updatedThreads = await provider.listReviewThreads(prResult.number);
            report.reviewConvergence.activeThreads = updatedThreads.activeCount;
            if (updatedStatus.allPassed && updatedThreads.activeCount === 0) {
              log('[sdw-ship-pr] All checks passed and 0 active review threads detected after resolution pass. Review converged successfully.');
              converged = true;
              report.reviewConvergence.converged = true;
              break;
            }
          }

          if (round >= maxRounds && !converged) {
            warn(`[sdw-ship-pr] Reached maximum review convergence rounds (${maxRounds}) with residual active threads.`);
          } else if (!converged) {
            // Primary settle point: block on the provider's native watch when
            // available, otherwise fall back to the configured poll interval.
            await waitForNextRound();
          }
        }

        if (!converged && !dryRun) {
          report.shipStatus = 'review_pending';
          const hasActivePr = Boolean(report.pullRequest && (report.pullRequest.url || report.pullRequest.number));
          const residualThreads = Number(report.reviewConvergence.activeThreads) || 0;
          const residualChecks = Array.isArray(report.reviewConvergence.failingChecks)
            ? report.reviewConvergence.failingChecks.length
            : 0;
          report.blocking = residualThreads > 0 || residualChecks > 0;
          if (report.blocking) {
            report.error = `Pull request did not converge: ${residualChecks} failing check(s), ${residualThreads} active thread(s) remain`;
            log(`[sdw-ship-pr] ${report.error}.`);
          } else if (hasActivePr) {
            log(`[sdw-ship-pr] Active PR #${report.pullRequest.number || ''} is in review / awaiting approval.`);
            report.nonBlocking = true;
            report.adaptedActivePr = true;
          }
          report.success = false;
        } else {
          report.shipStatus = 'delivered';
          report.success = true;
        }
      } else {
        report.shipStatus = 'delivered';
        report.success = true;
      }
    }

    // Step 4.5: Optional merge (opt-in, fire and forget)
    // `--merge` / `--allow-merge` asks the SCM CLI to merge the converged pull
    // request. The outcome is advisory: missing permissions, approvals, or
    // unmet branch rules are outside this skill's contract and must never fail
    // the delivery.
    if (options.merge) {
      const mergePrNumber = report.pullRequest ? report.pullRequest.number : null;
      const convergedOk = Boolean(report.reviewConvergence && report.reviewConvergence.converged);
      report.merge = { requested: true, attempted: false, ok: null, reason: null };

      if (dryRun) {
        report.merge.reason = 'dry-run';
      } else if (mergePrNumber === null || mergePrNumber === undefined) {
        report.merge.reason = 'no pull request';
      } else if (!report.reviewConvergence.enabled) {
        report.merge.reason = 'review convergence disabled';
      } else if (!convergedOk) {
        report.merge.reason = 'review did not converge';
      } else if (scmProviderName === 'none' || !scmContract) {
        report.merge.reason = 'scm provider disabled';
      } else {
        report.merge.attempted = true;
        const mergeStartedAt = Date.now();
        try {
          const mergeProvider = providerEarly || scmContract.createScmProvider(scmProviderName, { executor });
          const mergeResult = await mergeProvider.mergePullRequest({ prNumber: mergePrNumber });
          report.merge.ok = true;
          report.merge.result = mergeResult;
          log(`[sdw-ship-pr] Merge command accepted for PR #${mergePrNumber} (fire and forget).`);
        } catch (mergeErr) {
          report.merge.ok = false;
          report.merge.error = mergeErr.message;
          warn(`[sdw-ship-pr] Merge attempt for PR #${mergePrNumber} did not complete (${mergeErr.message}). Ignored by design: permissions, approvals, and branch rules are outside this skill's contract.`);
        }
        report.merge.durationMs = Date.now() - mergeStartedAt;
      }

      if (report.merge.reason) {
        log(`[sdw-ship-pr] Merge skipped: ${report.merge.reason}.`);
      }
    }

    // Step 4.6: Post-merge work-lane synchronization (spec 00040 AC12/AC13).
    // Runs only after the pull request is observed as MERGED, not merely after
    // the merge command was accepted, and never changes the delivery result.
    // The sync is driven by the observed pull-request state, not by whether this
    // run issued the merge: a maintainer merging later still closes the loop.
    const mergeAccepted = Boolean(report.merge && report.merge.ok === true);
    const syncEnabled = Boolean(branching && branching.syncWorkBranchAfterMerge);
    const prNumberForSync = report.pullRequest && report.pullRequest.number;
    let mergeObserver = null;
    if (syncEnabled && !dryRun) {
      try {
        mergeObserver = providerEarly || (scmContract && scmContract.createScmProvider
          ? scmContract.createScmProvider(scmProviderName, { executor })
          : null);
      } catch (observerErr) {
        mergeObserver = null;
      }
    }
    const observedMerged = mergeObserver && typeof mergeObserver.isPullRequestMerged === 'function'
      ? Boolean(await mergeObserver.isPullRequestMerged(prNumberForSync))
      : false;
    const prMerged = dryRun ? mergeAccepted : observedMerged;
    if (!prMerged && syncEnabled) {
      report.branchingSync = {
        status: 'skipped',
        reason: 'pull request not observed as MERGED',
        integrationBranch: integrationBranch || base,
        workBranch: branching.workBranch || null,
        at: new Date().toISOString()
      };
      log('[Branch Sync] skipped: the pull request is not MERGED yet.');
    }
    if (prMerged && syncEnabled) {
      report.branchingSync = syncWorkBranchAfterMerge({
        executor,
        branching,
        integrationBranch: integrationBranch || base,
        dryRun
      });
      if (report.branchingSync.status === 'synced') {
        let syncSha = '';
        try { syncSha = String(executor('git rev-parse --short HEAD') || '').trim(); } catch (e) {}
        log(`[Branch Sync] ${branching.strategy}: fast-forwarded ${report.branchingSync.workBranch} to ${report.branchingSync.integrationBranch}${syncSha ? ` at ${syncSha}` : ''}.`);
      } else if (report.branchingSync.status === 'blocked') {
        warn(`[Branch Sync] blocked: ${report.branchingSync.reason}`);
      }
    }

    // Step 5: State Persistence (never in dry-run: AC13 forbids writing run state)
    if (options.runId && !dryRun) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug, config);
      if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
          if (!stateData.steps) stateData.steps = {};
          
          const hasActivePr = Boolean(report.pullRequest && (report.pullRequest.url || report.pullRequest.number));
          const isStepCompleted = report.success || (hasActivePr && report.shipStatus === 'review_pending');
          const existingStep8 = stateData.steps[8] || {};
          stateData.steps[8] = {
            step: 8,
            name: 'pr_preparation',
            status: isStepCompleted ? 'completed' : 'failed',
            timestamp: new Date().toISOString(),
            artifact: existingStep8.artifact !== undefined ? existingStep8.artifact : null,
            output: {
              ...(existingStep8.output || {}),
              pullRequest: report.pullRequest,
              shipStatus: report.shipStatus,
              nonBlocking: Boolean(report.nonBlocking),
              adaptedActivePr: Boolean(report.adaptedActivePr),
              pushedBranch: report.pushed ? head : null,
              merge: report.merge || null,
              branchingSync: report.branchingSync || null,
              reviewConvergence: report.reviewConvergence
            }
          };

          stateData.pullRequest = report.pullRequest;
          stateData.shipStatus = report.shipStatus;
          if (report.branchingSync) stateData.branchingSync = report.branchingSync;
          fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
          log(`[sdw-ship-pr] Updated run state at ${stateFilePath}`);
        } catch (saveErr) {
          warn(`[sdw-ship-pr] Warning: Could not update state file: ${saveErr.message}`);
        }
      }
    }

    return report;
  } catch (err) {
    report.success = false;
    report.shipStatus = 'failed';
    report.error = err.message;
    // Expose the partial report (including the merge audit record) to callers.
    err.report = report;

    if (options.runId && !dryRun) {
      const stateFilePath = locateStateFile(projectRoot, options.runId, specSlug, config);
      if (stateFilePath && fs.existsSync(stateFilePath)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
          if (!stateData.errors) stateData.errors = [];
          stateData.errors.push({
            step: 8,
            timestamp: new Date().toISOString(),
            error: err.message
          });
          fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2), 'utf8');
        } catch (e) {}
      }
    }

    throw err;
  }
}

/**
 * Renders a review-thread report with every comment printed in full.
 * A review thread is the specification of a defect, so the report keeps each
 * body verbatim (line breaks included) and separates consecutive comments and
 * consecutive threads instead of narrowing the thread to its first comment.
 */
function formatThreadsReport(result, prNumber) {
  const threads = result && Array.isArray(result.threads) ? result.threads : [];
  const activeCount = result && Number.isInteger(result.activeCount)
    ? result.activeCount
    : threads.filter(t => !t.isResolved).length;
  const totalCount = result && Number.isInteger(result.totalCount)
    ? result.totalCount
    : threads.length;

  const sections = threads.map(thread => {
    const status = thread.isResolved ? 'RESOLVED' : 'ACTIVE';
    const location = thread.path ? ` [${thread.path}:${thread.line || 1}]` : '';
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const lines = [`  - [${status}] Thread ${thread.id}${location} · ${comments.length} comment(s)`];
    if (comments.length === 0) {
      lines.push('    (no comments)');
      return lines.join('\n');
    }
    comments.forEach((comment, index) => {
      const author = comment.author || 'unknown';
      const createdAt = comment.createdAt || 'unknown';
      lines.push('');
      lines.push(`    comment ${index + 1}/${comments.length} · ${author} · ${createdAt}`);
      lines.push(String(comment.body || ''));
    });
    return lines.join('\n');
  });

  const header = `[sdw-ship-pr] PR #${prNumber} Review Threads (${activeCount} active, ${totalCount} total):`;
  return [header, ...sections].join('\n\n');
}

/**
 * Lists review threads for a pull request
 */
async function cmdListThreads(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  if (!prNumber) {
    throw new Error('--pr <prNumber> is required for list-threads.');
  }
  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }
  return await provider.listReviewThreads(prNumber);
}

/**
 * Resolves a review thread on a pull request with an explanatory comment
 */
async function cmdResolveThread(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  const threadId = options.threadId || options.thread;
  const comment = options.comment;
  if (!prNumber) throw new Error('--pr <prNumber> is required for resolve-thread.');
  if (!threadId) throw new Error('--thread <threadId> is required for resolve-thread.');
  if (scmContract && scmContract.assertResolutionComment) {
    scmContract.assertResolutionComment(comment);
  } else {
    const normalized = String(comment || '')
      .replace(/<!--\s*resolution-reply\s*-->/gi, '')
      .replace(/^[\s`'"]+|[\s`'"]+$/g, '')
      .trim();
    if (!normalized || /^[0-9a-f]{4,64}$/i.test(normalized)) {
      throw new Error('A resolution comment must explain the fix and cannot be empty or a bare commit hash.');
    }
  }

  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }

  // Format comment with resolution reply marker if not already present
  const formattedComment = comment.includes('<!-- resolution-reply -->')
    ? comment
    : `<!-- resolution-reply -->\n${comment}`;

  return await provider.resolveReviewThread({
    prNumber,
    threadId,
    commentId: options.commentId || null,
    comment: formattedComment,
    model: options.model || 'sdw-ship-pr',
    dryRun: Boolean(options.dryRun)
  });
}

/**
 * Checks CI check runs and review status for a pull request
 */
async function cmdCheckStatus(options, customExecutor) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  const prNumber = options.pr || options.prNumber;
  if (!prNumber) throw new Error('--pr <prNumber> is required for check-status.');

  const providerName = options.provider || config.scmProvider || 'github';
  const provider = (scmContract && scmContract.createScmProvider)
    ? scmContract.createScmProvider(providerName, { cwd: projectRoot, executor: customExecutor })
    : null;
  if (!provider) {
    throw new Error(`SCM provider contract is not available for provider: ${providerName}`);
  }
  return await provider.checkPrStatus(prNumber);
}

/**
 * Plans the dirty-worktree commit: lists the candidates plus the files the
 * current run actually produced, so the host agent (LLM) can decide which
 * changes belong to this session before ship-pr stages anything.
 */
function cmdDirtyPlan(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const config = loadConfig(projectRoot);
  let status = '';
  try {
    status = String(execSync('git status --porcelain -uall', {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }) || '');
  } catch (e) {
    status = '';
  }
  const runFiles = collectRunFiles(projectRoot, options, config);
  const selection = selectDirtyFiles(status, { runFiles });
  let statePath = null;
  try {
    statePath = locateStateFile(projectRoot, options.runId, options.spec || options.specSlug, config);
  } catch (e) {
    statePath = null;
  }
  return {
    projectRoot,
    runId: options.runId || null,
    specSlug: options.spec || options.specSlug || null,
    statePath,
    mode: selection.mode,
    runFiles,
    candidates: selection.entries,
    suggested: selection.selected.map(entry => entry.path),
    excluded: selection.excluded.map(entry => entry.path),
    instructions: 'Review every candidate against the current session tasks, prompts, and dependencies; write the approved project-relative paths as a JSON array to .sdw/state/<runId>/dirty-files.json, then run sdw-ship-pr with --dirty-files <path>.'
  };
}

// CLI Execution entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.subcommand === 'dirty-plan') {
    process.stdout.write(JSON.stringify(cmdDirtyPlan(options), null, 2) + '\n');
    process.exit(0);
  }

  let runnerPromise;
  if (options.subcommand === 'list-threads') {
    runnerPromise = cmdListThreads(options);
  } else if (options.subcommand === 'resolve-thread') {
    runnerPromise = cmdResolveThread(options);
  } else if (options.subcommand === 'check-status') {
    runnerPromise = cmdCheckStatus(options);
  } else {
    runnerPromise = runShipPr(options);
  }

  runnerPromise
    .then(result => {
      const hasActivePr = Boolean(result && result.pullRequest && (result.pullRequest.url || result.pullRequest.number));
      const ok = options.subcommand === 'check-status'
        ? Boolean(result && result.allPassed === true)
        : Boolean(result && (result.success !== false || (hasActivePr && result.shipStatus === 'review_pending')) && result.resolved !== false);
      if (options.subcommand === 'list-threads') {
        // The full-thread report can be large; exit from the write callback so a
        // piped stdout is flushed before the process ends.
        const output = options.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : `\n${formatThreadsReport(result, options.pr)}\n`;
        process.stdout.write(output, () => process.exit(ok ? 0 : 1));
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (options.subcommand === 'resolve-thread') {
        console.log(`\n[sdw-ship-pr] Resolved thread ${options.threadId} on PR #${options.pr}:`);
        console.log(`  Status: ${result.resolved ? 'Resolved' : 'Pending'}`);
      } else if (options.subcommand === 'check-status') {
        console.log(`\n[sdw-ship-pr] PR #${options.pr} Status:`);
        console.log(`  All passed: ${result.allPassed}`);
        console.log(`  State:      ${result.state}`);
      } else {
        console.log('\n[sdw-ship-pr] Delivery Complete:');
        console.log(`  Status:       ${result.shipStatus}`);
        console.log(`  Head:         ${result.head}`);
        console.log(`  Base:         ${result.base}`);
        console.log(`  SCM Provider: ${result.scmProvider}`);
        if (result.pullRequest && result.pullRequest.url) {
          console.log(`  PR URL:       ${result.pullRequest.url}`);
        }
      }
      process.exit(ok ? 0 : 1);
    })
    .catch(err => {
      console.error(`\n[sdw-ship-pr] Error: ${err.message}`);
      if (options.json) {
        // AC8: the failure report keeps the resolved `issueLink`; only failures
        // raised before a report exists fall back to the bare error payload.
        const failureReport = err.report && typeof err.report === 'object'
          ? { ...err.report, success: false, error: err.message }
          : { success: false, error: err.message };
        process.stdout.write(JSON.stringify(failureReport, null, 2) + '\n');
      }
      process.exit(1);
    });
}

module.exports = {
  runShipPr,
  parseArgs,
  loadConfig,
  locateStateFile,
  resolvePrePrDiscovery,
  discoverPrepareObligations,
  evaluateRunStateGate,
  cmdListThreads,
  formatThreadsReport,
  cmdResolveThread,
  cmdCheckStatus,
  listBranchCommits,
  listBranchFiles,
  getSpecTitle,
  resolveIssueLink,
  stripClosingKeywordLines,
  appendClosingKeyword,
  buildPrTitle,
  buildPrBody,
  buildDefaultFixerCommand,
  syncWorkBranchAfterMerge,
  selectDirtyFiles,
  commitDirtyWorktree,
  cmdDirtyPlan
};
