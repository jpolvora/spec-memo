#!/usr/bin/env node
'use strict';

// validate_candidates.cjs — deterministic gate for sdw-retro candidates.
//
// A candidate is complete only when it carries the AC7 shape, an
// `evidence.artifact` that resolves inside the project, an exact locator in
// `evidence.ref` (state path or artifact line range), and a
// `proposedChange.target`. Candidates must be ordered critical -> low.
//
// Memory candidates draft an `sdw-memory` record instead of proposing a
// repository edit. Direct `skills/` edits are never proposed; they are
// rejected with `skills-requires-spec` and the specification route.
//
// Exit codes: 0 when every candidate is accepted, 1 otherwise.

const fs = require('fs');
const path = require('path');

const { CANDIDATE_FIELDS, CATEGORIES, SEVERITIES } = require('./retro.cjs');

const USAGE = 'Usage: validate_candidates.cjs --input <file> [--root <path>] [--json]';
const MEMORY_KINDS = Object.freeze(['trap', 'gap', 'pattern', 'error']);
const MEMORY_TARGET = 'sdw-memory';
const SPECIFICATION_ROUTE = 'author a specification under .sdw/specs/ with sdw-spec and implement it through sdw-run';
const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE_REF_PATTERN = /^[A-Za-z_$][\w$-]*(?:\.(?:[A-Za-z0-9_$][\w$-]*)|\[\d+\])*$/;
const LINE_REF_PATTERN = /^L(\d+)(?:-L(\d+))?$/;

const REASON_CODES = Object.freeze({
  INVALID_INPUT: 'invalid-input',
  INVALID_CANDIDATE: 'invalid-candidate',
  MISSING_FIELD: 'missing-field',
  MISSING_EVIDENCE_ARTIFACT: 'missing-evidence-artifact',
  MISSING_EVIDENCE_REF: 'missing-evidence-ref',
  MISSING_PROPOSED_CHANGE_TARGET: 'missing-proposed-change-target',
  UNRESOLVABLE_ARTIFACT: 'unresolvable-artifact',
  INVALID_EVIDENCE_REF: 'invalid-evidence-ref',
  INVALID_SEVERITY: 'invalid-severity',
  INVALID_CATEGORY: 'invalid-category',
  DUPLICATE_ID: 'duplicate-id',
  CANDIDATE_ORDER: 'candidate-order',
  SKILLS_REQUIRES_SPEC: 'skills-requires-spec',
  MEMORY_TARGET_NOT_ROUTE: 'memory-target-not-route',
  MISSING_MEMORY_DRAFT: 'missing-memory-draft',
  INVALID_MEMORY_DRAFT: 'invalid-memory-draft'
});

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
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

function reason(code, field, message, extra) {
  return { code, field, message, ...extra };
}

function candidateId(candidate) {
  return isObject(candidate) && isNonEmptyString(candidate.id) ? candidate.id.trim() : null;
}

function resolveArtifact(root, declared) {
  const value = normalizePath(isNonEmptyString(declared) ? declared.trim() : '');
  if (value === '') {
    return { ok: false, code: REASON_CODES.MISSING_EVIDENCE_ARTIFACT, message: 'evidence.artifact is required' };
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('/')) {
    return { ok: false, code: REASON_CODES.UNRESOLVABLE_ARTIFACT, message: `evidence.artifact must be project-relative: ${value}` };
  }
  if (value.split('/').includes('..')) {
    return { ok: false, code: REASON_CODES.UNRESOLVABLE_ARTIFACT, message: `evidence.artifact must not traverse outside the project: ${value}` };
  }
  const absolute = path.resolve(root, value);
  if (!isInside(root, absolute)) {
    return { ok: false, code: REASON_CODES.UNRESOLVABLE_ARTIFACT, message: `evidence.artifact resolves outside the project: ${value}` };
  }
  let stats = null;
  try {
    stats = fs.statSync(absolute);
  } catch (error) {
    stats = null;
  }
  if (!stats || !stats.isFile()) {
    return { ok: false, code: REASON_CODES.UNRESOLVABLE_ARTIFACT, message: `evidence.artifact does not resolve to a file: ${value}` };
  }
  return { ok: true, absolute, relative: normalizePath(path.relative(root, absolute)) };
}

function countLines(absolute) {
  try {
    const content = fs.readFileSync(absolute, 'utf8');
    return content === '' ? 0 : content.split(/\r?\n/).length;
  } catch (error) {
    return 0;
  }
}

// `evidence.ref` is exactly one of:
//   #steps.4.dispatch.abandonments[0]   state path inside the artifact
//   #L120-L138                          line range inside the artifact
// A ref may repeat the artifact path before the `#`; it must name the same file.
function parseEvidenceRef(ref, artifactRelative, artifactAbsolute) {
  const raw = isNonEmptyString(ref) ? ref.trim() : '';
  if (raw === '') {
    return { ok: false, code: REASON_CODES.MISSING_EVIDENCE_REF, message: 'evidence.ref is required' };
  }
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) {
    return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: `evidence.ref must be an exact state path or artifact line range: ${raw}` };
  }
  const refPath = normalizePath(raw.slice(0, hashIndex).trim());
  const fragment = raw.slice(hashIndex + 1).trim();
  if (refPath !== '' && refPath !== artifactRelative) {
    return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: `evidence.ref names a different artifact than evidence.artifact: ${refPath}` };
  }
  if (fragment === '') {
    return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: 'evidence.ref needs a state path or line range after "#"' };
  }
  const lineMatch = fragment.match(LINE_REF_PATTERN);
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = lineMatch[2] === undefined ? start : Number(lineMatch[2]);
    if (start < 1 || end < start) {
      return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: `evidence.ref line range is not a valid range: ${fragment}` };
    }
    if (artifactAbsolute) {
      const total = countLines(artifactAbsolute);
      if (total === 0 || end > total) {
        return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: `evidence.ref line range ${fragment} is outside the artifact (${total} line(s))` };
      }
    }
    return { ok: true, kind: 'lines', fragment, start, end };
  }
  if (STATE_REF_PATTERN.test(fragment)) {
    return { ok: true, kind: 'state', fragment };
  }
  return { ok: false, code: REASON_CODES.INVALID_EVIDENCE_REF, message: `evidence.ref is not an exact state path or artifact line range: ${fragment}` };
}

function validateMemoryDraft(draft) {
  const errors = [];
  if (!isObject(draft)) {
    return [reason(REASON_CODES.MISSING_MEMORY_DRAFT, 'proposedChange.memoryRecord', 'memory candidates must draft an sdw-memory record')];
  }
  if (!MEMORY_KINDS.includes(draft.kind)) {
    errors.push(reason(REASON_CODES.INVALID_MEMORY_DRAFT, 'proposedChange.memoryRecord.kind', `memory record kind must be one of ${MEMORY_KINDS.join(', ')}`));
  }
  for (const field of ['title', 'avoid', 'action']) {
    if (!isNonEmptyString(draft[field])) {
      errors.push(reason(REASON_CODES.INVALID_MEMORY_DRAFT, `proposedChange.memoryRecord.${field}`, `memory record ${field} is required`));
    }
  }
  if (draft.slug !== undefined && (!isNonEmptyString(draft.slug) || !SLUG_PATTERN.test(draft.slug))) {
    errors.push(reason(REASON_CODES.INVALID_MEMORY_DRAFT, 'proposedChange.memoryRecord.slug', 'memory record slug must be kebab-case'));
  }
  if (draft.paths !== undefined) {
    if (!Array.isArray(draft.paths) || draft.paths.some((item) => !isNonEmptyString(item))) {
      errors.push(reason(REASON_CODES.INVALID_MEMORY_DRAFT, 'proposedChange.memoryRecord.paths', 'memory record paths must be an array of project-relative paths'));
    } else if (draft.paths.some((item) => path.isAbsolute(item) || /^[A-Za-z]:/.test(item) || normalizePath(item).split('/').includes('..'))) {
      errors.push(reason(REASON_CODES.INVALID_MEMORY_DRAFT, 'proposedChange.memoryRecord.paths', 'memory record paths must not be absolute or traverse outside the project'));
    }
  }
  return errors;
}

function validateCandidate(candidate, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const errors = [];

  if (!isObject(candidate)) {
    return { valid: false, errors: [reason(REASON_CODES.INVALID_CANDIDATE, 'candidate', 'candidate must be an object')] };
  }

  for (const field of CANDIDATE_FIELDS) {
    const value = candidate[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      errors.push(reason(REASON_CODES.MISSING_FIELD, field, `candidate.${field} is required`));
    }
  }

  if (candidate.severity !== undefined && !SEVERITIES.includes(candidate.severity)) {
    errors.push(reason(REASON_CODES.INVALID_SEVERITY, 'severity', `severity must be one of ${SEVERITIES.join(', ')}`, { allowed: [...SEVERITIES] }));
  }
  if (candidate.category !== undefined && !CATEGORIES.includes(candidate.category)) {
    errors.push(reason(REASON_CODES.INVALID_CATEGORY, 'category', `category must be one of ${CATEGORIES.join(', ')}`, { allowed: [...CATEGORIES] }));
  }

  const evidence = isObject(candidate.evidence) ? candidate.evidence : {};
  const artifact = resolveArtifact(root, evidence.artifact);
  if (!artifact.ok) {
    errors.push(reason(artifact.code, 'evidence.artifact', artifact.message, artifact.code === REASON_CODES.UNRESOLVABLE_ARTIFACT ? { artifact: normalizePath(evidence.artifact || '') } : undefined));
  }
  const ref = parseEvidenceRef(
    evidence.ref,
    artifact.ok ? artifact.relative : normalizePath(evidence.artifact || ''),
    artifact.ok ? artifact.absolute : null
  );
  if (!ref.ok) errors.push(reason(ref.code, 'evidence.ref', ref.message));

  const proposedChange = isObject(candidate.proposedChange) ? candidate.proposedChange : {};
  const target = isNonEmptyString(proposedChange.target) ? proposedChange.target.trim() : '';
  if (target === '') {
    errors.push(reason(REASON_CODES.MISSING_PROPOSED_CHANGE_TARGET, 'proposedChange.target', 'proposedChange.target is required'));
  } else if (/(^|\/)skills\//.test(normalizePath(target))) {
    errors.push(reason(
      REASON_CODES.SKILLS_REQUIRES_SPEC,
      'proposedChange.target',
      `direct skills/ edits are not proposed; ${SPECIFICATION_ROUTE}`,
      { target, specificationRoute: SPECIFICATION_ROUTE }
    ));
  }

  if (candidate.category === 'memory') {
    if (target !== '' && target !== MEMORY_TARGET) {
      errors.push(reason(
        REASON_CODES.MEMORY_TARGET_NOT_ROUTE,
        'proposedChange.target',
        `memory candidates propose the ${MEMORY_TARGET} route, not a repository modification: ${target}`,
        { expectedTarget: MEMORY_TARGET }
      ));
    }
    errors.push(...validateMemoryDraft(proposedChange.memoryRecord));
  }

  return { valid: errors.length === 0, errors };
}

function normalizeCandidates(input) {
  if (Array.isArray(input)) return input;
  if (isObject(input) && Array.isArray(input.candidates)) return input.candidates;
  throw new Error('candidate input must be an array or an object with a candidates array');
}

function validateCandidates(input, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const candidates = normalizeCandidates(input);
  const accepted = [];
  const rejected = [];
  const memoryDrafts = [];
  const actualSeverities = [];
  const seenIds = new Set();
  let previousRank = null;

  candidates.forEach((candidate, index) => {
    const result = validateCandidate(candidate, { root });
    const errors = [...result.errors];
    const severity = isObject(candidate) && SEVERITIES.includes(candidate.severity) ? candidate.severity : null;
    if (severity) {
      const rank = SEVERITY_ORDER[severity];
      if (previousRank !== null && rank < previousRank) {
        errors.push(reason(
          REASON_CODES.CANDIDATE_ORDER,
          'severity',
          `candidate order must run critical -> low; ${severity} follows a less urgent candidate`,
          { expected: [...SEVERITIES], actual: [...actualSeverities, severity] }
        ));
      }
      previousRank = rank;
      actualSeverities.push(severity);
    }
    const id = candidateId(candidate);
    if (id) {
      if (seenIds.has(id)) {
        errors.push(reason(REASON_CODES.DUPLICATE_ID, 'id', `duplicate candidate id: ${id}`));
      }
      seenIds.add(id);
    }

    if (errors.length > 0) {
      rejected.push({
        index,
        id,
        severity,
        category: isObject(candidate) && isNonEmptyString(candidate.category) ? candidate.category : null,
        reasonCodes: [...new Set(errors.map((error) => error.code))],
        errors
      });
      return;
    }

    const entry = {
      index,
      id,
      title: candidate.title,
      severity: candidate.severity,
      category: candidate.category,
      target: candidate.proposedChange.target,
      evidence: { artifact: normalizePath(candidate.evidence.artifact), ref: candidate.evidence.ref }
    };
    accepted.push(entry);
    if (candidate.category === 'memory') {
      const draft = { candidateId: id, ...candidate.proposedChange.memoryRecord };
      entry.memoryDraft = draft;
      memoryDrafts.push(draft);
    }
  });

  const reasonCodes = [...new Set(rejected.flatMap((entry) => entry.reasonCodes))].sort();
  return {
    valid: rejected.length === 0,
    root: normalizePath(root),
    total: candidates.length,
    accepted,
    rejected,
    memoryDrafts,
    order: {
      expected: [...SEVERITIES],
      actual: actualSeverities,
      ordered: !reasonCodes.includes(REASON_CODES.CANDIDATE_ORDER)
    },
    reasonCodes,
    specificationRoute: SPECIFICATION_ROUTE
  };
}

function renderHuman(result, input) {
  const lines = [];
  lines.push(`validate_candidates: input=${normalizePath(input)} root=${result.root}`);
  for (const entry of result.accepted) {
    lines.push(`ACCEPTED ${entry.id} (${entry.severity}, ${entry.category}) -> ${entry.target}`);
  }
  for (const entry of result.rejected) {
    lines.push(`REJECTED ${entry.id || `candidate[${entry.index}]`}: ${entry.reasonCodes.join(', ')}`);
    for (const error of entry.errors) {
      lines.push(`  - ${error.code} (${error.field}): ${error.message}`);
    }
  }
  for (const draft of result.memoryDrafts) {
    lines.push(`MEMORY DRAFT ${draft.candidateId}: sdw-memory record --kind ${draft.kind}${draft.slug ? ` --slug ${draft.slug}` : ''} "${draft.title}"`);
  }
  lines.push(`order: ${result.order.ordered ? 'critical -> low' : 'violated'}`);
  lines.push(`result: ${result.accepted.length} accepted, ${result.rejected.length} rejected${result.reasonCodes.length ? ` (${result.reasonCodes.join(', ')})` : ''}`);
  if (result.reasonCodes.includes(REASON_CODES.SKILLS_REQUIRES_SPEC)) {
    lines.push(`specification route: ${result.specificationRoute}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { input: null, root: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--input') {
      options.input = argv[++index];
      if (options.input === undefined) throw new Error('missing value for --input');
    } else if (arg.startsWith('--input=')) options.input = arg.slice('--input='.length);
    else if (arg === '--root') {
      options.root = argv[++index];
      if (options.root === undefined) throw new Error('missing value for --root');
    } else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!isNonEmptyString(options.input)) throw new Error('--input <file> is required');
  if (options.root !== null && !isNonEmptyString(options.root)) throw new Error('missing value for --root');
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

  const root = path.resolve(options.root || findProjectRoot(process.cwd()));
  const inputPath = path.isAbsolute(options.input) ? options.input : path.resolve(process.cwd(), options.input);
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (error) {
    const failure = {
      valid: false,
      root: normalizePath(root),
      input: normalizePath(inputPath),
      total: 0,
      accepted: [],
      rejected: [],
      memoryDrafts: [],
      order: { expected: [...SEVERITIES], actual: [], ordered: true },
      reasonCodes: [REASON_CODES.INVALID_INPUT],
      specificationRoute: SPECIFICATION_ROUTE,
      error: error.message
    };
    if (options.json) process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    else process.stderr.write(`ERROR: cannot read candidates from ${normalizePath(options.input)}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  let result = null;
  try {
    result = validateCandidates(input, { root });
  } catch (error) {
    result = {
      valid: false,
      root: normalizePath(root),
      total: 0,
      accepted: [],
      rejected: [],
      memoryDrafts: [],
      order: { expected: [...SEVERITIES], actual: [], ordered: true },
      reasonCodes: [REASON_CODES.INVALID_INPUT],
      specificationRoute: SPECIFICATION_ROUTE
    };
    result.error = error.message;
  }
  result.input = normalizePath(inputPath);

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderHuman(result, inputPath));
  process.exitCode = result.valid ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  CANDIDATE_FIELDS,
  CATEGORIES,
  MEMORY_KINDS,
  MEMORY_TARGET,
  REASON_CODES,
  SEVERITIES,
  SPECIFICATION_ROUTE,
  main,
  parseEvidenceRef,
  resolveArtifact,
  validateCandidate,
  validateCandidates
};
