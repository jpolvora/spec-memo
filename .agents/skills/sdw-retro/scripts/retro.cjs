#!/usr/bin/env node
'use strict';

// retro.cjs — retrospective over a completed sdw-run run, invoked manually or
// by sdw-run when `retro.enabled` is true.
//
// Inputs are the run state file, the step artifacts that state declares, and
// the transcript files explicitly named by `retro.transcripts` or
// `--transcript`. Host transcripts are never discovered: the scanner does not
// enumerate host log locations, and an unconfigured declared path that looks
// like a transcript, session log, or chat log is skipped and reported as an
// excluded input. Configured transcripts are scanned line by line for
// orchestrator command signatures; the report cites path and line numbers
// only, never line bodies. Missing declared artifacts are reported as
// absences; their content is never synthesized. An unreadable transcript is
// reported as a signal and never fails the command.
//
// `retro run` writes <runId>.retro.md and <runId>.retro.json inside the run
// artifact directory. It never writes anywhere else and never touches git.

const fs = require('fs');
const path = require('path');
const util = require('util');
const zlib = require('zlib');

const STATE_DIR = '.sdw/state';
const USAGE = 'Usage: retro.cjs run [--run-id <id>] [--root <path>] [--transcript <path>]... [--transcript-mode <host|captured>] [--json]';

// A named transcript can be a host session file: a zstd frame sequence where
// one zstdDecompressSync call returns only the first frame.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TRANSCRIPT_MODES = Object.freeze(['host', 'captured']);

const CANDIDATE_FIELDS = Object.freeze(['id', 'title', 'severity', 'category', 'evidence', 'proposedChange']);
const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const CATEGORIES = Object.freeze([
  'memory',
  'harness-directive',
  'reviewer-standard',
  'automated-check',
  'navigation-pointer',
  'no-op-deletion'
]);

// Host-owned inputs that retro must never read (AC3).
const HOST_LOG_PATTERNS = Object.freeze([
  /(^|\/)(transcripts?|sessions?|chats?|chat[-_]?logs?|conversations?|agent[-_]?logs?)(\/|$)/i,
  /(^|\/)(transcript|session|chat)[-_.]/i,
  /\.(jsonl|chat|transcript)$/i
]);

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function isHostLogPath(value) {
  const normalized = normalizePath(value);
  return HOST_LOG_PATTERNS.some((pattern) => pattern.test(normalized));
}

function findProjectRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.sdw'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function isInside(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveDeclared(root, declared) {
  const absolute = path.isAbsolute(declared) ? path.normalize(declared) : path.resolve(root, declared);
  return {
    absolute,
    relative: normalizePath(path.relative(root, absolute)),
    inside: isInside(root, absolute)
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRunId(value) {
  return String(value || '').trim().replace(/\.state\.json$/i, '');
}

function matchesRunId(entry, wanted) {
  const runId = String(entry.state.runId || '').trim();
  const fileName = entry.name.replace(/\.state\.json$/i, '');
  if (runId === wanted || fileName === wanted) return true;
  if (runId.startsWith(`${wanted}-`) || runId.startsWith(`run-${wanted}-`)) return true;
  if (runId.endsWith(`-${wanted}`)) return true;
  return false;
}

function runSortValue(entry) {
  const stamp = entry.state.updatedAt || entry.state.completedAt || entry.state.createdAt;
  const parsed = Date.parse(stamp);
  if (Number.isFinite(parsed)) return parsed;
  try {
    return fs.statSync(entry.file).mtimeMs;
  } catch (error) {
    return 0;
  }
}

function readStateFiles(root) {
  const stateDir = path.join(root, STATE_DIR);
  if (!fs.existsSync(stateDir) || !fs.statSync(stateDir).isDirectory()) {
    throw new Error(`state directory not found: ${STATE_DIR}`);
  }
  const entries = [];
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.endsWith('.state.json') || isHostLogPath(name)) continue;
    const file = path.join(stateDir, name);
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) {
        entries.push({ name, file, state });
      }
    } catch (error) {
      // A malformed state file is not a retro input; the run is simply not selectable.
    }
  }
  return entries;
}

function selectRunEntry(entries, wantedRunId) {
  let candidates = entries;
  if (wantedRunId) {
    const wanted = normalizeRunId(wantedRunId);
    candidates = entries.filter((entry) => matchesRunId(entry, wanted));
    if (candidates.length === 0) throw new Error(`run not found: ${wantedRunId}`);
  } else {
    candidates = entries.filter((entry) => entry.state.status === 'completed');
    if (candidates.length === 0) {
      throw new Error(`no completed run found under ${STATE_DIR}`);
    }
  }
  candidates.sort((a, b) => runSortValue(b) - runSortValue(a)
    || String(b.state.runId || b.name).localeCompare(String(a.state.runId || a.name)));
  return candidates[0];
}

function selectRun(root, wantedRunId) {
  return selectRunEntry(readStateFiles(root), wantedRunId);
}

// Spec 00045 AC5: sibling run states of the same specification that never
// reached a terminal status. Only files already read for run selection are used.
function collectLeftoverRuns(entries, selected) {
  const specSlug = selected.state.specSlug;
  if (!specSlug) return [];
  return entries
    .filter((entry) => entry.file !== selected.file && entry.state.specSlug === specSlug)
    .filter((entry) => entry.state.status !== 'completed' && entry.state.status !== 'failed')
    .map((entry) => {
      const stamp = entry.state.updatedAt || entry.state.createdAt;
      const parsed = Date.parse(stamp);
      return {
        runId: entry.state.runId || entry.name.replace(/\.state\.json$/i, ''),
        status: entry.state.status || 'unknown',
        ageMs: Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null
      };
    })
    .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Spec 00045 AC6: transcripts are opt-in inputs. `retro.transcripts` in
// .sdw/config.json and repeated `--transcript` flags name them; nothing is
// discovered on the host.
function readConfiguredTranscripts(root) {
  const configFile = path.join(root, '.sdw', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const listed = config && config.retro && Array.isArray(config.retro.transcripts)
      ? config.retro.transcripts
      : [];
    return listed
      .map((entry) => (entry === null || entry === undefined ? '' : String(entry).trim()))
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function resolveTranscript(root, declared) {
  const expanded = String(declared).trim().replace(/\{projectRoot\}/g, normalizePath(root));
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
  return {
    absolute,
    reported: isInside(root, absolute) ? normalizePath(path.relative(root, absolute)) : normalizePath(expanded)
  };
}

function countLines(content) {
  return content === '' ? 0 : content.split(/\r?\n/).length;
}

// Spec 00047 AC2: host session files hold thousands of concatenated zstd
// frames, and decoding only the first one loses almost everything. Split on
// the frame magic, decode each frame, and concatenate the results.
function zstdFrameOffsets(buffer) {
  const offsets = [];
  let offset = buffer.indexOf(ZSTD_MAGIC);
  while (offset !== -1) {
    offsets.push(offset);
    offset = buffer.indexOf(ZSTD_MAGIC, offset + ZSTD_MAGIC.length);
  }
  return offsets;
}

function decodeZstdFrames(buffer) {
  const offsets = zstdFrameOffsets(buffer);
  const parts = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
    } catch (error) {
      // A magic sequence that does not begin a frame must not abort the run.
    }
  }
  return parts.length === 0 ? null : Buffer.concat(parts);
}

// Spec 00047 AC2/AC5: zstd frames are decoded in memory; anything that is
// neither valid UTF-8 text nor a decodable zstd frame is not a transcript.
function decodeTranscriptContent(buffer) {
  const isZstd = buffer.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC);
  const bytes = isZstd ? decodeZstdFrames(buffer) : buffer;
  if (!bytes) return null;
  try {
    return new util.TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return null;
  }
}

// Spec 00045 AC7, 00048 AC1/AC2: format-agnostic command signatures. A line is
// an orchestrator invocation only when the executable is immediately followed
// by the `run` or `resume` command word, allowing a closing quote (and the
// backslashes that escape it inside JSON) between them. A line that mentions
// the executable and the word `run` in separate clauses is prose.
const ORCHESTRATOR_INVOCATION = /(?:sdw-run\b|sdw_run\.cjs)\\*["']?\s+(resume|run)\b/i;

// Spec 00048 AC3: the `--spec` value may be wrapped in quotes or backticks,
// escaped as a JSON string, and followed by punctuation. Strip the wrappers
// before the file stem is derived.
function normalizeSpecValue(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[\\`"']+/, '')
    .replace(/[\\`"'.,;:!?)\]}>]+$/, '');
}

// Spec 00048 AC4: one invocation is often recorded twice, once in the message
// that issued it and once in the tool record that echoed it, so the two lines
// differ in their host envelope. Compare a normalized command excerpt instead:
// the command word `run` plus the normalized `--spec` value when present, which
// ignores envelope text, whitespace runs, quoting, and escape noise.
function orchestratorInvocation(line) {
  const invocation = line.match(ORCHESTRATOR_INVOCATION);
  if (!invocation) return null;
  if (invocation[1].toLowerCase() === 'resume') {
    return { verb: 'resume', specification: null, excerpt: null };
  }
  const rest = line.slice(invocation.index + invocation[0].length);
  const match = rest.match(/--spec(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const value = match ? normalizeSpecValue(match[1] || match[2] || match[3]) : '';
  const specification = value
    ? path.posix.basename(normalizePath(value).replace(/^\.\//, '')).replace(/\.md$/i, '')
    : null;
  return {
    verb: 'run',
    specification: specification || null,
    excerpt: value ? `run --spec ${value}` : 'run'
  };
}

function scanTranscriptLines(reportedPath, content) {
  const findings = [];
  const pending = new Map();
  let previous = null;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const invocation = orchestratorInvocation(lines[index]);
    if (!invocation) continue;
    if (invocation.verb === 'resume') {
      pending.clear();
      previous = null;
      continue;
    }
    if (!invocation.specification) continue;
    // Spec 00048 AC4: the same command excerpt on the immediately preceding
    // line is the call echoed by its result, not a second invocation. Advance
    // the reference line so a chain of identical adjacent records keeps
    // collapsing instead of tripping a two-line gap on the third record.
    if (previous
      && index - previous.index === 1
      && previous.excerpt === invocation.excerpt
      && previous.specification === invocation.specification) {
      previous = { index, excerpt: invocation.excerpt, specification: invocation.specification };
      continue;
    }
    previous = { index, excerpt: invocation.excerpt, specification: invocation.specification };
    const prior = pending.get(invocation.specification);
    if (prior !== undefined) {
      findings.push({
        path: reportedPath,
        specification: invocation.specification,
        lines: [prior, index + 1]
      });
    }
    pending.set(invocation.specification, index + 1);
  }
  return findings;
}

// Spec 00045 AC6-AC8, 00047 AC2-AC5: read every explicitly named transcript
// once, decoding zstd frames in memory. Unreadable paths become signals; they
// never abort the report.
function collectTranscripts(root, declaredPaths, mode) {
  const inputs = [];
  const unreadable = [];
  const repeated = [];
  const seen = new Set();
  for (const declared of toArray(declaredPaths)) {
    const resolved = resolveTranscript(root, declared);
    if (seen.has(resolved.absolute)) continue;
    seen.add(resolved.absolute);
    let buffer = null;
    try {
      buffer = fs.readFileSync(resolved.absolute);
    } catch (error) {
      unreadable.push({
        path: resolved.reported,
        reason: error && error.code === 'ENOENT' ? 'not-found' : 'read-error'
      });
      continue;
    }
    const content = decodeTranscriptContent(buffer);
    if (content === null) {
      unreadable.push({ path: resolved.reported, reason: 'not-text' });
      continue;
    }
    inputs.push({ path: resolved.reported, lines: countLines(content), mode });
    repeated.push(...scanTranscriptLines(resolved.reported, content));
  }
  return { inputs, unreadable, repeated };
}

function artifactDirectory(root, state) {
  const declared = typeof state.artifactsDir === 'string' && state.artifactsDir.trim()
    ? state.artifactsDir.trim()
    : `${STATE_DIR}/${state.specSlug || 'unknown-spec'}/${state.runId || 'unknown-run'}`;
  const resolved = resolveDeclared(root, declared);
  if (!resolved.inside) {
    throw new Error(`run artifact directory escapes the project root: ${declared}`);
  }
  return resolved.absolute;
}

// Every path the run state declares as an artifact is expected. The state is
// authoritative: retro never invents paths that the state does not name.
function collectExpectedArtifacts(state) {
  const expected = [];
  const seen = new Set();
  const add = (declared, expectedBy) => {
    if (typeof declared !== 'string' || declared.trim() === '') return;
    const key = normalizePath(declared.trim());
    if (seen.has(key)) return;
    seen.add(key);
    expected.push({ path: key, expectedBy });
  };

  const steps = state.steps && typeof state.steps === 'object' ? state.steps : {};
  for (const key of Object.keys(steps)) {
    const step = steps[key];
    if (step && typeof step === 'object') add(step.artifact, `steps.${key}.artifact`);
  }

  const step4 = steps['4'] && typeof steps['4'] === 'object' ? steps['4'] : null;
  const tasks = step4 && step4.tasks && typeof step4.tasks === 'object' ? step4.tasks : {};
  for (const taskId of Object.keys(tasks)) {
    const task = tasks[taskId];
    if (!task || typeof task !== 'object') continue;
    add(task.promptPath, `steps.4.tasks.${taskId}.promptPath`);
    add(task.evidencePath, `steps.4.tasks.${taskId}.evidencePath`);
  }

  const step5Output = steps['5'] && steps['5'].output && typeof steps['5'].output === 'object'
    ? steps['5'].output
    : {};
  add(step5Output.judgePromptPath, 'steps.5.output.judgePromptPath');
  add(step5Output.judgeVerdictPath, 'steps.5.output.judgeVerdictPath');

  return expected;
}

function inspectArtifacts(root, expected) {
  const artifacts = [];
  const missingArtifacts = [];
  const excludedInputs = [];
  const inputs = [];

  for (const item of expected) {
    const resolved = resolveDeclared(root, item.path);
    if (!resolved.inside) {
      excludedInputs.push({ path: item.path, reason: 'outside-project-root' });
      continue;
    }
    if (isHostLogPath(resolved.relative)) {
      excludedInputs.push({ path: resolved.relative, reason: 'host-log' });
      continue;
    }
    let stats = null;
    try {
      stats = fs.statSync(resolved.absolute);
    } catch (error) {
      stats = null;
    }
    if (!stats || !stats.isFile()) {
      missingArtifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, present: false });
      artifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, exists: false });
      continue;
    }
    try {
      const content = fs.readFileSync(resolved.absolute, 'utf8');
      inputs.push(resolved.relative);
      artifacts.push({
        path: resolved.relative,
        expectedBy: item.expectedBy,
        exists: true,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content === '' ? 0 : content.split(/\r?\n/).length
      });
    } catch (error) {
      missingArtifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, present: true, readable: false });
      artifacts.push({ path: resolved.relative, expectedBy: item.expectedBy, exists: true, read: false });
    }
  }

  return { artifacts, missingArtifacts, excludedInputs, inputs };
}

function durationBetween(start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

function collectSignals(state, inspection, leftoverRuns = [], transcripts = {}) {
  const steps = state.steps && typeof state.steps === 'object' ? state.steps : {};
  const stepKeys = Object.keys(steps).sort((a, b) => toNumber(a) - toNumber(b));
  const step4 = steps['4'] && typeof steps['4'] === 'object' ? steps['4'] : {};
  const step5Output = steps['5'] && steps['5'].output && typeof steps['5'].output === 'object'
    ? steps['5'].output
    : {};
  const step7Output = steps['7'] && steps['7'].output && typeof steps['7'].output === 'object'
    ? steps['7'].output
    : {};
  const step8Output = steps['8'] && steps['8'].output && typeof steps['8'].output === 'object'
    ? steps['8'].output
    : {};
  const convergence = step8Output.reviewConvergence
    && typeof step8Output.reviewConvergence === 'object'
    && !Array.isArray(step8Output.reviewConvergence)
    ? step8Output.reviewConvergence
    : null;

  const dispatch = step4.dispatch && typeof step4.dispatch === 'object' ? step4.dispatch : {};
  const abandonments = toArray(dispatch.abandonments);

  const timestamps = {
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
    durationMs: durationBetween(state.createdAt, state.updatedAt),
    steps: stepKeys.map((key) => {
      const step = steps[key] && typeof steps[key] === 'object' ? steps[key] : {};
      return {
        step: toNumber(key),
        name: step.name || null,
        status: step.status || null,
        startedAt: step.startedAt || null,
        completedAt: step.completedAt || null
      };
    })
  };

  const scoreIterations = toNumber(state.scoreIteration);
  const reviewIterations = toNumber(state.reviewIteration);
  const reviewRounds = convergence ? toNumber(convergence.rounds) : 0;
  const retries = {
    scoreIterations,
    reviewIterations,
    reviewRounds,
    dispatchAbandonments: abandonments.length,
    total: scoreIterations + reviewIterations + reviewRounds + abandonments.length
  };

  const abandonedDispatches = abandonments.map((item, index) => ({
    taskId: item && item.taskId ? item.taskId : null,
    reason: item && item.reason ? item.reason : null,
    at: item && item.at ? item.at : null,
    ref: `#steps.4.dispatch.abandonments[${index}]`
  }));

  const scoreSignals = {
    score: step5Output.score !== undefined ? step5Output.score : null,
    minScore: step5Output.minScore !== undefined ? step5Output.minScore : null,
    passed: typeof step5Output.passed === 'boolean' ? step5Output.passed : null,
    judgeScore: step5Output.judge && typeof step5Output.judge === 'object'
      && step5Output.judge.reportedScore !== undefined
      ? step5Output.judge.reportedScore
      : null,
    iteration: scoreIterations,
    ref: '#steps.5.output'
  };

  const gates = [];
  const seenGates = new Set();
  const gateSources = [
    { values: step4.gates, prefix: 'steps.4.gates' },
    { values: step4.output && step4.output.gates, prefix: 'steps.4.output.gates' }
  ];
  for (const source of gateSources) {
    if (!source.values || typeof source.values !== 'object' || Array.isArray(source.values)) continue;
    for (const name of Object.keys(source.values)) {
      const gate = source.values[name] && typeof source.values[name] === 'object' ? source.values[name] : {};
      const key = `${name}|${gate.status || ''}|${gate.exitCode === undefined ? '' : gate.exitCode}`;
      if (seenGates.has(key)) continue;
      seenGates.add(key);
      gates.push({
        gate: name,
        status: gate.status || null,
        exitCode: gate.exitCode === undefined ? null : gate.exitCode,
        durationMs: gate.durationMs === undefined ? null : gate.durationMs,
        ref: `#${source.prefix}.${name}`
      });
    }
  }
  const gateRepairs = gates.filter((gate) => gate.status !== 'passed'
    || (gate.exitCode !== null && gate.exitCode !== 0));

  const rawFindings = toArray(step7Output.findings);
  const findings = rawFindings.map((finding, index) => ({
    id: finding && finding.id ? finding.id : null,
    severity: finding && finding.severity ? finding.severity : null,
    path: finding && finding.path ? finding.path : null,
    line: finding && finding.line !== undefined ? finding.line : null,
    status: finding && finding.status ? finding.status : null,
    ref: `#steps.7.output.findings[${index}]`
  }));
  const bySeverity = {};
  for (const finding of findings) {
    const severity = finding.severity || 'unknown';
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }
  const reviewFindings = {
    total: findings.length,
    open: findings.filter((finding) => finding.status === 'open').length,
    bySeverity,
    blockingCount: step7Output.blockingCount !== undefined ? step7Output.blockingCount : null,
    findings
  };

  const pendingThreads = toArray(convergence && convergence.pendingThreads).map((thread, index) => ({
    threadId: thread && thread.threadId ? thread.threadId : null,
    path: thread && thread.path ? thread.path : null,
    line: thread && thread.line !== undefined ? thread.line : null,
    ref: `#steps.8.output.reviewConvergence.pendingThreads[${index}]`
  }));
  const unresolvedThreads = {
    available: Boolean(convergence),
    active: convergence && convergence.activeThreads !== undefined ? convergence.activeThreads : null,
    resolved: convergence && convergence.resolvedThreads !== undefined ? convergence.resolvedThreads : null,
    pending: pendingThreads
  };

  return {
    timestamps,
    retries,
    abandonedDispatches,
    scoreIterations: scoreSignals,
    gateRepairs,
    reviewFindings,
    unresolvedThreads,
    missingArtifacts: inspection.missingArtifacts,
    leftover_run: leftoverRuns,
    repeated_run_invocation: toArray(transcripts.repeated),
    transcript_unreadable: toArray(transcripts.unreadable)
  };
}

function candidateContract() {
  return {
    fields: [...CANDIDATE_FIELDS],
    severity: [...SEVERITIES],
    category: [...CATEGORIES]
  };
}

// Candidate record shape (AC7) and value restrictions (AC8). Evidence
// completeness and artifact resolution belong to the candidate validator.
function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: [{ code: 'invalid-candidate', message: 'candidate must be an object' }] };
  }
  const errors = [];
  for (const field of CANDIDATE_FIELDS) {
    if (!(field in candidate) || candidate[field] === undefined || candidate[field] === null
      || String(candidate[field]).trim() === '') {
      errors.push({ code: 'missing-field', field });
    }
  }
  if (candidate.severity !== undefined && !SEVERITIES.includes(candidate.severity)) {
    errors.push({ code: 'invalid-severity', field: 'severity', allowed: [...SEVERITIES] });
  }
  if (candidate.category !== undefined && !CATEGORIES.includes(candidate.category)) {
    errors.push({ code: 'invalid-category', field: 'category', allowed: [...CATEGORIES] });
  }
  return { valid: errors.length === 0, errors };
}

function buildReport(options) {
  const candidates = [];
  for (const candidate of toArray(options.candidates)) {
    const result = validateCandidate(candidate);
    if (!result.valid) {
      throw new Error(`invalid candidate: ${result.errors.map((error) => error.code).join(', ')}`);
    }
    candidates.push(candidate);
  }
  return {
    runId: options.state.runId || options.runIdFallback || null,
    specSlug: options.state.specSlug || null,
    status: options.state.status || null,
    statePath: options.statePath,
    artifactsDir: options.artifactsDir,
    generatedAt: new Date().toISOString(),
    transcriptMode: options.transcriptMode || 'host',
    inputs: [...options.inspection.inputs],
    transcripts: toArray(options.transcripts),
    excludedInputs: [...options.inspection.excludedInputs],
    artifacts: [...options.inspection.artifacts],
    signals: options.signals,
    candidates,
    candidateContract: candidateContract()
  };
}

function renderMarkdown(report) {
  const lines = [];
  const signals = report.signals;
  lines.push(`# Run Retrospective: ${report.runId}`, '');
  lines.push(`- **Specification:** ${report.specSlug || 'unknown'}`);
  lines.push(`- **Run status:** ${report.status || 'unknown'}`);
  lines.push(`- **State file:** \`${report.statePath}\``);
  lines.push(`- **Artifact directory:** \`${report.artifactsDir}\``);
  lines.push(`- **Generated at:** ${report.generatedAt}`);
  lines.push('');

  lines.push('## Inputs', '');
  const transcriptInputs = new Map(toArray(report.transcripts).map((item) => [item.path, item]));
  if (report.inputs.length === 0) {
    lines.push('No inputs were read.');
  } else {
    for (const input of report.inputs) {
      const transcript = transcriptInputs.get(input);
      lines.push(transcript
        ? `- \`${input}\` (transcript, ${transcript.lines} lines, ${transcript.mode || 'host'})`
        : `- \`${input}\``);
    }
  }
  lines.push('');

  lines.push('## Signals', '');
  lines.push('### Timestamps', '');
  lines.push('| Step | Name | Status | Started | Completed |');
  lines.push('|---|---|---|---|---|');
  for (const step of signals.timestamps.steps) {
    lines.push(`| ${step.step} | ${step.name || '-'} | ${step.status || '-'} | ${step.startedAt || '-'} | ${step.completedAt || '-'} |`);
  }
  if (signals.timestamps.steps.length === 0) lines.push('| - | - | - | - | - |');
  lines.push('');

  lines.push('### Retries', '');
  lines.push(`- Score iterations: ${signals.retries.scoreIterations}`);
  lines.push(`- Review iterations: ${signals.retries.reviewIterations}`);
  lines.push(`- Review rounds: ${signals.retries.reviewRounds}`);
  lines.push(`- Dispatch abandonments: ${signals.retries.dispatchAbandonments}`);
  lines.push('');

  lines.push('### Abandoned Dispatches', '');
  if (signals.abandonedDispatches.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const item of signals.abandonedDispatches) {
      lines.push(`- \`${item.taskId || 'unknown task'}\` at ${item.at || 'unknown time'}: ${item.reason || 'no reason'} (${item.ref})`);
    }
  }
  lines.push('');

  lines.push('### Score Iterations', '');
  lines.push(`- Score: ${signals.scoreIterations.score === null ? 'not recorded' : signals.scoreIterations.score}`);
  lines.push(`- Minimum score: ${signals.scoreIterations.minScore === null ? 'not recorded' : signals.scoreIterations.minScore}`);
  lines.push(`- Passed: ${signals.scoreIterations.passed === null ? 'not recorded' : signals.scoreIterations.passed}`);
  lines.push(`- Iterations: ${signals.scoreIterations.iteration}`);
  lines.push('');

  lines.push('### Gate Repairs', '');
  if (signals.gateRepairs.length === 0) {
    lines.push('None recorded.');
  } else {
    for (const gate of signals.gateRepairs) {
      lines.push(`- Gate \`${gate.gate}\`: status ${gate.status || 'unknown'}, exit ${gate.exitCode === null ? 'unknown' : gate.exitCode} (${gate.ref})`);
    }
  }
  lines.push('');

  lines.push('### Review Findings', '');
  lines.push(`- Total: ${signals.reviewFindings.total}`);
  lines.push(`- Open: ${signals.reviewFindings.open}`);
  for (const item of signals.reviewFindings.findings) {
    lines.push(`- \`${item.id || 'finding'}\` (${item.severity || 'unknown'}, ${item.status || 'unknown'}) at ${item.path || 'unknown path'}${item.line === null ? '' : `:${item.line}`} (${item.ref})`);
  }
  lines.push('');

  lines.push('### Unresolved Threads', '');
  if (!signals.unresolvedThreads.available) {
    lines.push('Step 8 did not report review convergence.');
  } else {
    lines.push(`- Active: ${signals.unresolvedThreads.active === null ? 'not recorded' : signals.unresolvedThreads.active}`);
    lines.push(`- Resolved: ${signals.unresolvedThreads.resolved === null ? 'not recorded' : signals.unresolvedThreads.resolved}`);
    for (const thread of signals.unresolvedThreads.pending) {
      lines.push(`- \`${thread.threadId || 'thread'}\` at ${thread.path || 'unknown path'}${thread.line === null ? '' : `:${thread.line}`} (${thread.ref})`);
    }
  }
  lines.push('');

  lines.push('### Missing Artifacts', '');
  if (signals.missingArtifacts.length === 0) {
    lines.push('Every declared artifact is present.');
  } else {
    for (const item of signals.missingArtifacts) {
      lines.push(`- \`${item.path}\` (expected by \`${item.expectedBy}\`): absent. Content was not read or synthesized.`);
    }
  }
  lines.push('');

  lines.push('### Transcripts', '');
  if (signals.repeated_run_invocation.length === 0 && signals.transcript_unreadable.length === 0) {
    lines.push('No repeated run invocation or unreadable transcript was found.');
  } else {
    for (const item of signals.transcript_unreadable) {
      lines.push(`- \`${item.path}\`: transcript unreadable (${item.reason}). Its content was not read.`);
    }
    for (const item of signals.repeated_run_invocation) {
      lines.push(`- \`${item.path}\` lines ${item.lines.join(' and ')}: two \`sdw-run run\` invocations for \`${item.specification}\` with no \`resume\` between them.`);
    }
  }
  lines.push('');

  lines.push('### Leftover Runs', '');
  if (signals.leftover_run.length === 0) {
    lines.push('No sibling run is open for this specification.');
  } else {
    for (const item of signals.leftover_run) {
      lines.push(`- \`${item.runId}\` (status ${item.status || 'unknown'}, age ${formatAge(item.ageMs)}): a sibling run that never reached a terminal status.`);
    }
  }
  lines.push('');

  lines.push('## Candidates', '');
  if (report.candidates.length === 0) {
    lines.push('No candidates recorded. A report with signals and no candidates is valid.');
  } else {
    for (const candidate of report.candidates) {
      lines.push(`- \`${candidate.id}\` (${candidate.severity}, ${candidate.category}): ${candidate.title}`);
    }
  }
  const contract = report.candidateContract;
  lines.push('');
  lines.push(`Candidate contract: fields ${contract.fields.map((field) => `\`${field}\``).join(', ')}; severity ${contract.severity.join('|')}; category ${contract.category.join('|')}.`);
  lines.push('');

  lines.push('## Excluded Inputs', '');
  if (report.excludedInputs.length === 0) {
    lines.push('None.');
  } else {
    for (const item of report.excludedInputs) {
      lines.push(`- \`${item.path}\` (${item.reason})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function writeReports(root, artifactsDirectoryPath, report) {
  fs.mkdirSync(artifactsDirectoryPath, { recursive: true });
  const markdownPath = path.join(artifactsDirectoryPath, `${report.runId}.retro.md`);
  const jsonPath = path.join(artifactsDirectoryPath, `${report.runId}.retro.json`);
  const outputs = {
    markdown: normalizePath(path.relative(root, markdownPath)),
    json: normalizePath(path.relative(root, jsonPath))
  };
  report.outputs = outputs;
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  return outputs;
}

function runRetro(options = {}) {
  const root = path.resolve(options.root || findProjectRoot(process.cwd()));
  const entries = readStateFiles(root);
  const selected = selectRunEntry(entries, options.runId);
  const state = selected.state;
  const statePath = normalizePath(path.relative(root, selected.file));
  const artifactsDirectoryPath = artifactDirectory(root, state);
  const artifactsDir = normalizePath(path.relative(root, artifactsDirectoryPath));

  // Tell the operator which run and directory were selected before analysis.
  const announce = (message) => {
    if (options.json) process.stderr.write(`${message}\n`);
    else process.stdout.write(`${message}\n`);
  };
  announce(`retro: run=${state.runId || selected.name} spec=${state.specSlug || 'unknown'} status=${state.status || 'unknown'}`);
  announce(`retro: artifacts=${artifactsDir}`);

  const expected = collectExpectedArtifacts(state);
  const inspection = inspectArtifacts(root, expected);
  const transcriptMode = options.transcriptMode || 'host';
  const transcripts = collectTranscripts(root, [
    ...readConfiguredTranscripts(root),
    ...toArray(options.transcripts)
  ], transcriptMode);
  for (const transcript of transcripts.inputs) {
    if (!inspection.inputs.includes(transcript.path)) inspection.inputs.push(transcript.path);
  }
  const signals = collectSignals(state, inspection, collectLeftoverRuns(entries, selected), transcripts);
  const report = buildReport({
    state,
    runIdFallback: selected.name.replace(/\.state\.json$/i, ''),
    statePath,
    artifactsDir,
    transcriptMode,
    inspection,
    signals,
    transcripts: transcripts.inputs,
    candidates: options.candidates
  });
  const outputs = writeReports(root, artifactsDirectoryPath, report);
  return { root, artifactsDir, outputs, report };
}

function parseArgs(argv) {
  const options = {
    subcommand: null,
    runId: null,
    root: null,
    transcripts: [],
    transcriptMode: 'host',
    json: false,
    help: false
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--run-id') {
      options.runId = argv[++index];
      if (options.runId === undefined) throw new Error('missing value for --run-id');
    } else if (arg.startsWith('--run-id=')) options.runId = arg.slice('--run-id='.length);
    else if (arg === '--root') {
      options.root = argv[++index];
      if (options.root === undefined) throw new Error('missing value for --root');
    } else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else if (arg === '--transcript') {
      const value = argv[++index];
      if (value === undefined) throw new Error('missing value for --transcript');
      options.transcripts.push(value);
    } else if (arg.startsWith('--transcript=')) options.transcripts.push(arg.slice('--transcript='.length));
    else if (arg === '--transcript-mode') {
      options.transcriptMode = argv[++index];
      if (options.transcriptMode === undefined) throw new Error('missing value for --transcript-mode');
    } else if (arg.startsWith('--transcript-mode=')) {
      options.transcriptMode = arg.slice('--transcript-mode='.length);
    } else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else positional.push(arg);
  }
  options.subcommand = positional[0] || null;
  if (positional.length > 1) throw new Error(`unexpected argument: ${positional[1]}`);
  if (options.runId !== null && String(options.runId).trim() === '') throw new Error('missing value for --run-id');
  if (options.root !== null && String(options.root).trim() === '') throw new Error('missing value for --root');
  if (options.transcripts.some((value) => String(value).trim() === '')) throw new Error('missing value for --transcript');
  if (!TRANSCRIPT_MODES.includes(options.transcriptMode)) {
    throw new Error(`invalid --transcript-mode: ${options.transcriptMode}; expected ${TRANSCRIPT_MODES.join('|')}`);
  }
  options.transcripts = options.transcripts.map((value) => String(value).trim());
  return options;
}

function main(argv) {
  let options = null;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.subcommand !== 'run') {
    process.stderr.write(`ERROR: expected subcommand "run"\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = runRetro(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      process.stdout.write(`retro: wrote ${result.outputs.markdown}\n`);
      process.stdout.write(`retro: wrote ${result.outputs.json}\n`);
    }
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  CANDIDATE_FIELDS,
  CATEGORIES,
  SEVERITIES,
  buildReport,
  candidateContract,
  collectExpectedArtifacts,
  collectSignals,
  inspectArtifacts,
  isHostLogPath,
  main,
  parseArgs,
  renderMarkdown,
  runRetro,
  selectRun,
  validateCandidate
};
