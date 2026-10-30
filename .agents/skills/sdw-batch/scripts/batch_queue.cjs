'use strict';

// sdw-batch queue: iterates a specification list and delegates each item to
// sdw-run as one independent single-specification run. This module owns the
// manifest and the loop; it never duplicates orchestrator step logic.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Batch delegation is unattended and never passes --abort-on-gaps, so the only
// pause codes sdw-run can return here are dispatch (4) and judgment (5).
const PAUSE_STATUS = {
  4: 'awaiting_implementation',
  5: 'awaiting_judgment'
};

// Spec 00046: a completed run records its retrospective candidates in
// state.retro. The batch consumes them under one explicit policy: only
// critical/high candidates become draft specifications, and a follow-up item
// is never allowed to queue more follow-ups.
const FOLLOW_UP_POLICIES = ['queue', 'record', 'none'];
const DEFAULT_FOLLOW_UP_POLICY = 'queue';
const QUEUED_SEVERITIES = ['critical', 'high'];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

// Human progress belongs on stderr under --json so stdout stays one JSON document.
function say(options, message) {
  if (options && options.json) console.error(message);
  else console.log(message);
}

function loadConfig(targetRoot) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  const configFile = path.join(root, '.sdw', 'config.json');
  let raw = {};
  if (fs.existsSync(configFile)) {
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        || {};
    } catch (e) {
      throw new Error(`invalid .sdw/config.json: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('invalid .sdw/config.json: expected a JSON object');
    }
  }
  const expand = (value, fallback) => {
    const chosen = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return path.resolve(chosen.replace(/\{projectRoot\}/g, normalizePath(root)));
  };
  return {
    root,
    specsDir: expand(raw.specsDir, path.join(root, '.sdw', 'specs')),
    stateDir: expand(raw.stateDir, path.join(root, '.sdw', 'state')),
    retro: raw.retro && typeof raw.retro === 'object' && !Array.isArray(raw.retro) ? raw.retro : {}
  };
}

function runStateDir(config) {
  if (!fs.existsSync(config.stateDir)) fs.mkdirSync(config.stateDir, { recursive: true });
  return config.stateDir;
}

function resolveSpec(specInput, config) {
  const direct = path.isAbsolute(specInput) ? specInput : path.resolve(config.root, specInput);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const inSpecsDir = path.resolve(config.specsDir, specInput);
  if (fs.existsSync(inSpecsDir) && fs.statSync(inSpecsDir).isFile()) return inSpecsDir;
  if (fs.existsSync(`${inSpecsDir}.md`)) return `${inSpecsDir}.md`;
  return direct;
}

function inferSlug(specPath) {
  try {
    const content = fs.readFileSync(specPath, 'utf8');
    const match = content.match(/slug:\s*([^\r\n]+)/);
    if (match) return match[1].trim();
  } catch (e) {
    // Fall back to the file name.
  }
  return path.basename(specPath, path.extname(specPath));
}

function generateRunId(slug) {
  const clean = String(slug || 'spec').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30);
  return `run-${Date.now()}-${clean}`;
}

function manifestFilePath(config, batchId) {
  return path.join(runStateDir(config), `${batchId}.json`);
}

// A specification is already implemented when the registry records it as
// completed or archived; the queue must not re-run it from scratch.
function implementedStatuses(config) {
  try {
    const specIndex = require('../../sdw-spec/scripts/spec_index.cjs');
    const { entries } = specIndex.readIndex({ root: config.root });
    const statuses = new Map();
    for (const entry of entries || []) {
      if (entry.status === 'completed' || entry.status === 'archived') {
        statuses.set(entry.slug, entry.status);
      }
    }
    return statuses;
  } catch (e) {
    console.warn(`[sdw-batch] WARNING: could not read the specification index: ${e.message}`);
    return new Map();
  }
}

function createManifest({ specs, options, config }) {
  // Discovery without an explicit id only scans `batch-*.json`, so every batch
  // id is normalized to that prefix; a custom id stays resumable by itself.
  const requested = options.batchId ? String(options.batchId) : `batch-${Date.now()}`;
  const batchId = requested.startsWith('batch-') ? requested : `batch-${requested}`;
  const manifestFile = manifestFilePath(config, batchId);
  if (fs.existsSync(manifestFile)) {
    throw new Error(`batch "${batchId}" already exists at ${normalizePath(path.relative(config.root, manifestFile))}; pass a different --batch-id`);
  }
  const now = new Date().toISOString();
  const implemented = implementedStatuses(config);
  const queue = specs.map((specInput, index) => {
    const resolved = resolveSpec(specInput, config);
    const slug = inferSlug(resolved);
    const registryStatus = implemented.get(slug) || null;
    return {
      index,
      spec: normalizePath(path.relative(config.root, resolved)) || specInput,
      slug,
      status: registryStatus ? 'already_implemented' : 'pending',
      skipReason: registryStatus ? `already implemented (index.specs.md status: ${registryStatus})` : null,
      runId: null,
      deliveryCommit: null,
      branch: null,
      durationMs: null,
      error: null
    };
  });
  const manifest = {
    batchId,
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    policy: {
      continueOnError: Boolean(options.continueOnError),
      syncIndex: options.noSync ? false : true
    },
    total: queue.length,
    currentIndex: 0,
    queue
  };
  saveManifest(config, manifest);
  return manifest;
}

function saveManifest(config, manifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.mkdirSync(runStateDir(config), { recursive: true });
  fs.writeFileSync(manifestFilePath(config, manifest.batchId), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

function loadManifest(config, batchId) {
  const stateDir = runStateDir(config);
  if (batchId) {
    const clean = String(batchId).replace(/^batch-/, '');
    const direct = path.join(stateDir, `batch-${clean}.json`);
    if (fs.existsSync(direct)) return JSON.parse(fs.readFileSync(direct, 'utf8'));
    const alt = path.join(stateDir, `${batchId}.json`);
    if (fs.existsSync(alt)) return JSON.parse(fs.readFileSync(alt, 'utf8'));
    return null;
  }
  const files = fs.readdirSync(stateDir)
    .filter(name => name.startsWith('batch-') && name.endsWith('.json'))
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(stateDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(stateDir, files[0].name), 'utf8'));
}

function readRunState(config, runId) {
  if (!runId) return null;
  const file = path.join(runStateDir(config), `${runId}.state.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function retroFollowUpPolicy(config) {
  const followUp = config && config.retro ? config.retro.followUp : null;
  const value = typeof followUp === 'string' ? followUp.trim().toLowerCase() : '';
  return FOLLOW_UP_POLICIES.includes(value) ? value : DEFAULT_FOLLOW_UP_POLICY;
}

// One shape for every outcome: a status with no candidates still carries the
// fields the manifest and the summary read.
function followUpRecord(status, extras = {}) {
  return {
    status,
    candidates: 0,
    bySeverity: {},
    reportPath: null,
    queued: [],
    failures: [],
    processed: [],
    ...extras
  };
}

function describeCandidateValue(value) {
  if (value === null || value === undefined) return 'not recorded';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.artifact === 'string' && typeof value.ref === 'string') {
    return `${value.artifact}${value.ref}`;
  }
  if (typeof value === 'object' && typeof value.target === 'string') {
    const rest = { ...value };
    delete rest.target;
    return Object.keys(rest).length > 0 ? `${value.target} (${JSON.stringify(rest)})` : value.target;
  }
  return JSON.stringify(value);
}

function candidateSpecText(candidate) {
  const heading = candidate.id
    ? `Retro follow-up ${candidate.id}: ${candidate.title || 'untitled candidate'}`
    : `Retro follow-up: ${candidate.title || 'untitled candidate'}`;
  return [
    heading,
    '',
    `Proposed change: ${describeCandidateValue(candidate.proposedChange)}`,
    `Evidence: ${describeCandidateValue(candidate.evidence)}`
  ].join('\n');
}

function specScript() {
  return path.resolve(__dirname, '..', '..', 'sdw-spec', 'scripts', 'sdw_spec.cjs');
}

// Default seam: the sdw-spec CLI owns drafting, numbering, and index
// registration, so the batch never writes a specification itself.
function createSpecWithCli({ config, candidate }) {
  if (!config || !config.root) throw new Error('a resolved batch config is required to create a specification');
  const title = String(candidate.title || candidate.id || 'Retro follow-up').trim();
  const result = spawnSync(process.execPath, [
    specScript(),
    'new',
    candidateSpecText(candidate),
    '--title', title,
    '--root', config.root,
    '--json'
  ], { cwd: config.root, encoding: 'utf8' });
  if (result.error) throw result.error;
  let payload = null;
  try {
    payload = String(result.stdout || '').trim() ? JSON.parse(String(result.stdout).trim()) : null;
  } catch (e) {
    payload = null;
  }
  if (result.status !== 0 || !payload || payload.status === 'error') {
    const detail = (payload && payload.error) || String(result.stderr || '').trim();
    throw new Error(detail || `sdw-spec new exited with code ${result.status}`);
  }
  if (typeof payload.filePath !== 'string' || !payload.filePath.trim()) {
    throw new Error('sdw-spec new did not return the created specification path');
  }
  return payload;
}

function appendFollowUpQueueEntry(manifest, item, candidate, created, config) {
  if (!manifest || !Array.isArray(manifest.queue)) throw new Error('batch manifest has no queue');
  const filePath = created && (created.filePath || created.file);
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('sdw-spec new did not return the created specification path');
  }
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(config.root, filePath);
  const nextIndex = manifest.queue.reduce(
    (max, entry) => (Number.isInteger(entry.index) && entry.index > max ? entry.index : max),
    -1
  ) + 1;
  const entry = {
    index: nextIndex,
    spec: normalizePath(path.relative(config.root, absolute)),
    slug: created.slug || inferSlug(absolute),
    status: 'pending',
    followUpDepth: 1,
    origin: { candidateId: candidate.id || null, runId: item.runId || null }
  };
  manifest.queue.push(entry);
  manifest.total = manifest.queue.length;
  return entry;
}

function followUpReportPath(config, manifest) {
  return path.join(runStateDir(config), `${manifest.batchId}.followups.md`);
}

function renderFollowUpSection(item, followUp, candidates) {
  const lines = [
    `## [${item.index + 1}] ${item.slug || item.spec || 'item'}`,
    '',
    `- **Run:** ${item.runId || 'unknown'}`,
    `- **Report:** \`${followUp.reportPath}\``,
    `- **Candidates:** ${candidates.length}`,
    ''
  ];
  if (candidates.length === 0) lines.push('No candidates recorded.', '');
  for (const candidate of candidates) {
    lines.push(`### ${candidate.id || 'candidate'}: ${candidate.title || 'untitled'}`);
    lines.push('');
    lines.push(`- **Severity:** ${candidate.severity || 'unknown'}`);
    lines.push(`- **Category:** ${candidate.category || 'unknown'}`);
    lines.push(`- **Evidence:** ${describeCandidateValue(candidate.evidence)}`);
    lines.push(`- **Proposed change:** ${describeCandidateValue(candidate.proposedChange)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function writeFollowUpReport(config, manifest, item, followUp, candidates) {
  const file = followUpReportPath(config, manifest);
  const section = renderFollowUpSection(item, followUp, candidates);
  fs.mkdirSync(runStateDir(config), { recursive: true });
  if (fs.existsSync(file)) {
    fs.appendFileSync(file, section, 'utf8');
  } else {
    const header = [
      `# Batch Retro Follow-Ups: ${manifest.batchId}`,
      '',
      '- **Policy:** record',
      `- **Generated at:** ${new Date().toISOString()}`,
      ''
    ].join('\n');
    fs.writeFileSync(file, `${header}${section}`, 'utf8');
  }
  return file;
}

// Consumes the retrospective record of a completed item. It never throws: a
// missing report, a failed retro, malformed JSON, or a failed spec creation is
// recorded on the manifest and the queue keeps advancing.
function applyRetroFollowUp({ config, manifest, item, options, deps } = {}) {
  const record = followUp => {
    if (item) item.retroFollowUp = followUp;
    return followUp;
  };
  try {
    if (!item) return undefined;
    const policy = retroFollowUpPolicy(config);
    if (policy === 'none') return record({ status: 'skipped' });

    const state = readRunState(config, item.runId);
    const retro = state && state.retro;
    if (!retro) return record(followUpRecord('unavailable'));
    if (retro.status !== 'passed') {
      const failedPath = retro.reportJson ? normalizePath(retro.reportJson) : null;
      return record(followUpRecord('failed', { reportPath: failedPath }));
    }
    if (!retro.reportJson) return record(followUpRecord('unavailable'));
    const reportPath = normalizePath(retro.reportJson);

    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.resolve(config.root, reportPath), 'utf8'));
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 'unavailable' : 'invalid';
      return record(followUpRecord(status, { reportPath }));
    }
    if (!report || typeof report !== 'object' || !Array.isArray(report.candidates)) {
      return record(followUpRecord('invalid', { reportPath }));
    }
    const candidates = report.candidates.filter(
      candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    );
    const bySeverity = {};
    for (const candidate of candidates) {
      const severity = typeof candidate.severity === 'string' && candidate.severity ? candidate.severity : 'unknown';
      bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    }
    const followUp = followUpRecord(policy === 'record' ? 'recorded' : 'queued', {
      candidates: candidates.length,
      bySeverity,
      reportPath
    });
    // Carry the checkpoint and the history across a resume: processed ids stop
    // duplicate specs, queued and failed entries stay visible in the summary.
    const previous = item.retroFollowUp && typeof item.retroFollowUp === 'object' ? item.retroFollowUp : {};
    if (Array.isArray(previous.queued)) followUp.queued = [...previous.queued];
    if (Array.isArray(previous.failures)) followUp.failures = [...previous.failures];
    if (Array.isArray(previous.processed)) followUp.processed = [...previous.processed];

    if (policy === 'record') {
      writeFollowUpReport(config, manifest, item, followUp, candidates);
      return record(followUp);
    }

    // A follow-up item still records what its own retrospective found; the depth
    // bound suppresses new specifications, not the candidate summary.
    if (item.followUpDepth >= 1) return record({ ...followUp, status: 'depth-exceeded' });

    const createSpec = deps && typeof deps.createSpec === 'function' ? deps.createSpec : createSpecWithCli;
    const processed = new Set(Array.isArray(followUp.processed) ? followUp.processed : []);
    for (const candidate of candidates) {
      if (!QUEUED_SEVERITIES.includes(candidate.severity)) continue;
      const candidateId = candidate.id || null;
      if (candidateId && processed.has(candidateId)) continue;
      try {
        const created = createSpec({ config, manifest, item, candidate });
        const entry = appendFollowUpQueueEntry(manifest, item, candidate, created, config);
        followUp.queued.push({ candidateId, spec: entry.spec, slug: entry.slug });
      } catch (err) {
        followUp.failures.push({
          candidateId,
          error: err && err.message ? err.message : String(err)
        });
      }
      // Checkpoint by candidate id and persist the entry together with the
      // manifest: a resumed batch must neither re-create a queued spec nor
      // drop the candidates that were still pending when it stopped.
      if (candidateId) {
        processed.add(candidateId);
        followUp.processed = [...processed];
      }
      saveManifest(config, manifest);
    }
    return record(followUp);
  } catch (err) {
    return record({
      ...followUpRecord('failed'),
      failures: [{ candidateId: null, error: err && err.message ? err.message : String(err) }]
    });
  }
}

// A resumed batch re-enters the follow-up stage for completed items whose
// candidate loop was interrupted. Processed candidate ids make the re-entry
// idempotent, and the remaining critical/high candidates are queued now instead
// of being silently lost because the item already counts as completed.
function recoverFollowUps(manifest, config, options = {}, deps) {
  if (!manifest || !Array.isArray(manifest.queue)) return 0;
  if (retroFollowUpPolicy(config) !== 'queue') return 0;
  let recovered = 0;
  for (const item of manifest.queue) {
    if (!item || item.status !== 'completed') continue;
    if (item.followUpDepth >= 1) continue;
    const followUp = item.retroFollowUp;
    if (!followUp || followUp.status === 'skipped' || followUp.status === 'unavailable') continue;
    const before = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
    applyRetroFollowUp({ config, manifest, item, options, deps });
    const after = item.retroFollowUp && Array.isArray(item.retroFollowUp.queued)
      ? item.retroFollowUp.queued.length
      : 0;
    if (after > before) recovered += after - before;
  }
  if (recovered > 0) saveManifest(config, manifest);
  return recovered;
}

function triggerSpecSync(config) {
  try {
    const specSync = require('../../sdw-spec/scripts/spec_sync.cjs');
    if (specSync && typeof specSync.syncIndex === 'function') {
      specSync.syncIndex({ root: config.root });
      return true;
    }
  } catch (e) {
    // Index sync is best effort; the manifest outcome stays authoritative, but
    // the failure must reach the operator instead of leaving a stale registry.
    console.warn(`[sdw-batch] WARNING: spec index sync failed: ${e.message}`);
  }
  return false;
}

function orchestratorScript() {
  return path.resolve(__dirname, '..', '..', 'sdw-run', 'scripts', 'sdw_run.cjs');
}

function invokeOrchestrator({ config, runId, specPath, resume }) {
  const script = orchestratorScript();
  const args = resume
    ? [script, 'resume', '--run-id', runId, '--root', config.root]
    : [script, 'run', path.resolve(config.root, specPath), '--run-id', runId, '--unattended', '--root', config.root];
  const result = spawnSync(process.execPath, args, { cwd: config.root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return typeof result.status === 'number' ? result.status : 1;
}

function applyRunState(item, state) {
  if (!state) return;
  item.runId = state.runId || item.runId;
  item.branch = state.branch || item.branch || null;
  item.deliveryCommit = state.deliveryCommit || item.deliveryCommit || null;
}

function printSummary(manifest, options = {}) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const count = status => manifest.queue.filter(item => item.status === status).length;
  console.log('\n============================================================');
  console.log('SDW Batch Execution Summary');
  console.log(`Batch ID: ${manifest.batchId}`);
  console.log(`Status:   ${manifest.status}`);
  console.log(`Total:    ${manifest.total} (Completed: ${count('completed')}, Skipped: ${count('already_implemented')}, Failed: ${count('failed')}, Paused: ${manifest.queue.filter(item => item.status.startsWith('awaiting_')).length})`);
  console.log('------------------------------------------------------------');
  console.log('# | Slug                           | Status      | Duration | Delivery Commit');
  console.log('--|--------------------------------|-------------|----------|----------------');
  manifest.queue.forEach(item => {
    const index = String(item.index + 1).padEnd(2);
    const slug = String(item.slug || item.spec).padEnd(30).slice(0, 30);
    const status = String(item.status || 'unknown').padEnd(11);
    const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s`.padEnd(8) : '-       ';
    const commit = item.deliveryCommit ? String(item.deliveryCommit).slice(0, 12) : '-';
    console.log(`${index}| ${slug} | ${status} | ${duration} | ${commit}`);
  });
  // Follow-up outcomes stay visible: queued specs and creation failures are
  // the operator's only signal that the retrospective changed the queue.
  const followUps = manifest.queue.filter(item => {
    const followUp = item.retroFollowUp;
    if (!followUp) return false;
    return followUp.status === 'queued'
      || followUp.status === 'recorded'
      || (Array.isArray(followUp.failures) && followUp.failures.length > 0);
  });
  if (followUps.length > 0) {
    console.log('------------------------------------------------------------');
    console.log('Retro Follow-Ups');
    followUps.forEach(item => {
      const followUp = item.retroFollowUp;
      const breakdown = Object.entries(followUp.bySeverity || {})
        .map(([severity, count]) => `${severity}: ${count}`)
        .join(', ');
      const candidateLabel = `candidates: ${followUp.candidates || 0}${breakdown ? ` (${breakdown})` : ''}`;
      const queuedCount = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
      console.log(`${String(item.slug || item.spec).padEnd(30).slice(0, 30)} | ${String(followUp.status).padEnd(10)} | ${candidateLabel}, queued: ${queuedCount}`);
      (followUp.queued || []).forEach(entry => console.log(`  + ${entry.spec}`));
      (followUp.failures || []).forEach(failure => console.log(`  ! ${failure.candidateId || 'candidate'}: ${failure.error}`));
    });
  }
  console.log('============================================================\n');
}

function finishFailure(manifest, config, item, exitCode, message, options, continueOnError) {
  item.status = 'failed';
  item.error = message || `sdw-run exited with code ${exitCode}`;
  saveManifest(config, manifest);
  if (!continueOnError) {
    manifest.status = 'halted';
    saveManifest(config, manifest);
    console.error(`\n[sdw-batch] Halting queue on failure: "${item.slug}". Remaining ${manifest.total - item.index - 1} specification(s) pending.`);
    printSummary(manifest, options);
    // Batch exit codes stay unambiguous: 0 completed, 1 failure, 4/5 pause.
    return 1;
  }
  say(options, `[sdw-batch] "${item.slug}" failed; continuing queue (--continue-on-error).`);
  return null;
}

function executeQueue(manifest, config, options) {
  let anyFailed = false;
  const continueOnError = options.continueOnError !== undefined
    ? Boolean(options.continueOnError)
    : Boolean(manifest.policy.continueOnError);
  const syncIndex = options.noSync !== undefined
    ? !options.noSync
    : manifest.policy.syncIndex !== false;
  const implemented = implementedStatuses(config);

  for (let i = manifest.currentIndex; i < manifest.queue.length; i += 1) {
    const item = manifest.queue[i];
    if (item.status === 'completed') {
      say(options, `[sdw-batch] Skipping completed specification [${item.index + 1}/${manifest.total}]: ${item.slug}`);
      continue;
    }
    // Re-check the registry per item so a spec completed since the manifest was
    // created is never implemented twice, including on resume.
    if (item.status !== 'already_implemented' && implemented.has(item.slug)) {
      item.status = 'already_implemented';
      item.skipReason = `already implemented (index.specs.md status: ${implemented.get(item.slug)})`;
      saveManifest(config, manifest);
    }
    if (item.status === 'already_implemented') {
      say(options, `[sdw-batch] Skipping already-implemented specification [${item.index + 1}/${manifest.total}]: ${item.slug} (${item.skipReason})`);
      continue;
    }

    manifest.currentIndex = i;
    item.status = 'in_progress';
    saveManifest(config, manifest);

    say(options, `\n[sdw-batch] [${item.index + 1}/${manifest.total}] Delegating ${item.slug} to sdw-run (single run)`);
    const started = Date.now();
    const prior = readRunState(config, item.runId);
    const resumable = prior && (prior.status === 'paused' || prior.status === 'in_progress');
    let exitCode = 0;
    let failureMessage = null;

    if (prior && prior.status === 'completed') {
      say(options, `[sdw-batch] Run "${item.runId}" already completed; reconciling queue item.`);
      applyRunState(item, prior);
    } else {
      const runId = item.runId || generateRunId(item.slug);
      item.runId = runId;
      try {
        exitCode = options._invoke
          ? options._invoke({ config, runId, specPath: item.spec, resume: Boolean(resumable), runState: prior })
          : invokeOrchestrator({ config, runId, specPath: item.spec, resume: Boolean(resumable) });
      } catch (err) {
        exitCode = 1;
        failureMessage = err.message;
      }
      applyRunState(item, readRunState(config, item.runId));
    }

    item.durationMs = (item.durationMs || 0) + (Date.now() - started);

    if (exitCode === 0) {
      const finalState = readRunState(config, item.runId);
      if (!finalState || finalState.status !== 'completed') {
        anyFailed = true;
        const halt = finishFailure(manifest, config, item, 1, `Run "${item.runId}" exited 0 without completing`, options, continueOnError);
        if (halt !== null) return halt;
        continue;
      }
      applyRunState(item, finalState);
      item.status = 'completed';
      item.error = null;
      applyRetroFollowUp({ config, manifest, item, options, deps: options._retroDeps });
      const followUp = item.retroFollowUp || {};
      const queued = Array.isArray(followUp.queued) ? followUp.queued.length : 0;
      const failures = Array.isArray(followUp.failures) ? followUp.failures.length : 0;
      if (queued > 0) {
        say(options, `[sdw-batch] Queued ${queued} retro follow-up specification(s) after the remaining items.`);
      }
      if (failures > 0) {
        say(options, `[sdw-batch] ${failures} retro follow-up specification(s) failed; see the summary.`);
      }
      say(options, `[sdw-batch] "${item.slug}" completed in ${(item.durationMs / 1000).toFixed(1)}s.`);
      saveManifest(config, manifest);
      if (syncIndex) triggerSpecSync(config);
    } else if (PAUSE_STATUS[exitCode]) {
      item.status = PAUSE_STATUS[exitCode];
      item.error = null;
      manifest.status = 'paused';
      saveManifest(config, manifest);
      say(options, `\n[sdw-batch] "${item.slug}" paused with ${item.status} (sdw-run exit code ${exitCode}).`);
      say(options, `[sdw-batch] Continue that run, then resume the queue with: sdw-batch resume ${manifest.batchId}`);
      printSummary(manifest, options);
      return exitCode;
    } else {
      anyFailed = true;
      const halt = finishFailure(manifest, config, item, exitCode, failureMessage, options, continueOnError);
      if (halt !== null) return halt;
    }
  }

  // A resume can begin past items that already failed, so the terminal status is
  // derived from the whole queue, not only from failures observed this pass.
  const stillFailed = manifest.queue.some(item => item.status === 'failed');
  manifest.status = (anyFailed || stillFailed) ? 'completed_with_errors' : 'completed';
  saveManifest(config, manifest);
  printSummary(manifest, options);
  return manifest.status === 'completed' ? 0 : 1;
}

function validateSpecs(specs, config) {
  const resolved = [];
  for (const specInput of specs) {
    const specPath = resolveSpec(specInput, config);
    if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
      return { valid: false, missing: specInput, resolved: [] };
    }
    resolved.push(specPath);
  }
  return { valid: true, missing: null, resolved };
}

function runBatch(specs, options = {}) {
  const config = loadConfig(options.root);
  if (!specs || specs.length === 0) {
    console.error('Error: No specifications provided.');
    return 1;
  }
  const validation = validateSpecs(specs, config);
  if (!validation.valid) {
    console.error(`Error: Batch pre-flight failed: specification not found: "${validation.missing}"`);
    console.error('Batch rejected before any specification executed.');
    return 1;
  }
  if (options.dryRun) {
    const implemented = implementedStatuses(config);
    console.log(`\n[sdw-batch] Dry-run plan (${validation.resolved.length} specification(s)):`);
    validation.resolved.forEach((specPath, index) => {
      const slug = inferSlug(specPath);
      const registryStatus = implemented.get(slug);
      const note = registryStatus ? ` - skipped: already implemented (${registryStatus})` : '';
      console.log(`  ${index + 1}. ${slug} (${normalizePath(specPath)})${note}`);
    });
    console.log('No specification executed (--dry-run).\n');
    return 0;
  }
  const manifest = createManifest({ specs: validation.resolved, options, config });
  say(options, `[sdw-batch] Initialized "${manifest.batchId}" with ${manifest.total} specification(s).`);
  say(options, `Policy: continueOnError=${manifest.policy.continueOnError}, syncIndex=${manifest.policy.syncIndex}`);
  return executeQueue(manifest, config, options);
}

function resumeBatch(batchId, options = {}) {
  const config = loadConfig(options.root);
  const manifest = loadManifest(config, batchId);
  if (!manifest) {
    console.error(`Error: No batch manifest found (${batchId || 'latest'}).`);
    return 1;
  }
  if (manifest.status === 'completed' || manifest.status === 'completed_with_errors') {
    const ok = manifest.status === 'completed';
    say(options, `[sdw-batch] Batch "${manifest.batchId}" is already finished (${manifest.status}).`);
    printSummary(manifest, options);
    return ok ? 0 : 1;
  }
  manifest.status = 'in_progress';
  saveManifest(config, manifest);
  const recovered = recoverFollowUps(manifest, config, options, options._retroDeps);
  if (recovered > 0) {
    say(options, `[sdw-batch] Recovered ${recovered} interrupted retro follow-up specification(s).`);
  }
  say(options, `[sdw-batch] Resuming "${manifest.batchId}" (${manifest.currentIndex + 1}/${manifest.total})...`);
  return executeQueue(manifest, config, options);
}

function formatStatus(manifest) {
  if (!manifest) return 'No batch manifest found.';
  const lines = [
    `Batch ID: ${manifest.batchId}`,
    `Status:   ${manifest.status}`,
    `Progress: ${manifest.currentIndex + 1}/${manifest.total}`,
    'Queue:'
  ];
  manifest.queue.forEach(item => {
    lines.push(`  [${item.index + 1}] ${item.slug}: ${item.status}${item.runId ? ` (${item.runId})` : ''}`);
  });
  return lines.join('\n');
}

module.exports = {
  applyRetroFollowUp,
  createManifest,
  executeQueue,
  formatStatus,
  generateRunId,
  inferSlug,
  invokeOrchestrator,
  loadConfig,
  loadManifest,
  manifestFilePath,
  printSummary,
  readRunState,
  recoverFollowUps,
  resolveSpec,
  resumeBatch,
  runBatch,
  saveManifest,
  triggerSpecSync,
  validateSpecs
};
