'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { parseAcceptanceCriteria } = require('./dag_planner.cjs');

const CRITICITY_LEVELS = ['permissive', 'strict', 'perfectionist'];
const DEFAULT_CRITICITY = 'strict';
const VERDICT_VALUES = ['verified', 'failed'];
const DIFF_BYTE_LIMIT = 120000;
const JUDGE_TIMEOUT_MS = 600000;
const DEFAULT_ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];

const CRITICITY_RUBRIC = {
  permissive: 'Credit partial satisfaction. A criterion passes when the diff contains any concrete attempt that plausibly addresses it.',
  strict: 'A criterion passes only when the diff contains the behaviour the criterion demands, including its failure path.',
  perfectionist: 'A criterion passes only when the diff implements it completely, with tests or explicit verification covering the stated behaviour.'
};

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function getTouchedFiles(baseCommit, projectRoot) {
  const cwd = projectRoot || process.cwd();
  const fileSet = new Set();
  try {
    if (baseCommit) {
      const diffUncommitted = execSync(`git diff --name-only ${baseCommit}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffUncommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));

      const diffCommitted = execSync(`git diff --name-only ${baseCommit} HEAD`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      diffCommitted.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
    }

    const statusOut = execSync('git status --porcelain', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    statusOut.split('\n')
      .map(l => l.trim().replace(/^[A-Z?]{1,2}\s+/, '').trim())
      .filter(Boolean)
      .forEach(f => fileSet.add(normalizePath(f)));
  } catch (err) {
    // Git errors are ignored: a non-git workspace simply reports no touched files.
  }
  return Array.from(fileSet);
}

/**
 * Resolves the judge configuration (Spec 027 AC4, AC5, AC6).
 * Precedence for the judge command: explicit option or config value, then the
 * SDW_JUDGE_COMMAND environment variable (CI/unattended injection). When no
 * command is configured the judge defaults to the current agent model instance:
 * the host agent performs the judgment and submits the verdict.
 */
function resolveJudgeConfig(config) {
  const scoring = (config && typeof config.scoring === 'object' && config.scoring) ? config.scoring : {};
  const rawCriticity = String(scoring.judgeCriticity || '').trim().toLowerCase();
  const criticity = CRITICITY_LEVELS.includes(rawCriticity) ? rawCriticity : DEFAULT_CRITICITY;
  const command = normOpt(scoring.judgeCommand) || normOpt(process.env.SDW_JUDGE_COMMAND) || null;

  return {
    mode: command ? 'command' : 'agent',
    command,
    model: normOpt(scoring.judgeModel),
    provider: normOpt(scoring.judgeProvider),
    effort: normOpt(scoring.judgeEffort),
    apiEndpoint: normOpt(scoring.judgeApiEndpoint),
    criticity
  };
}

function normOpt(value) {
  const str = typeof value === 'string' ? value.trim() : '';
  return str ? str : null;
}

/**
 * Resolves judge artifact paths under the run directory.
 */
function resolveJudgePaths(options) {
  const root = path.resolve(options.targetRoot || process.cwd());
  const stateDir = options.stateDir ? path.resolve(root, options.stateDir) : path.join(root, '.sdw', 'state');
  const dir = path.join(stateDir, options.slug, options.runId);
  const rel = (p) => normalizePath(path.relative(root, p));
  const promptFile = path.join(dir, 'step-5-judge.prompt.md');
  const verdictFile = path.join(dir, 'step-5-judge.verdict.json');
  const diffFile = path.join(dir, 'step-5-judge.diff.txt');
  const criteriaFile = path.join(dir, 'step-5-judge.criteria.txt');
  return {
    dir,
    promptFileAbs: promptFile,
    promptFileRel: rel(promptFile),
    verdictFileAbs: verdictFile,
    verdictFileRel: rel(verdictFile),
    diffFileAbs: diffFile,
    diffFileRel: rel(diffFile),
    criteriaFileAbs: criteriaFile,
    criteriaFileRel: rel(criteriaFile)
  };
}

/**
 * Collects the generated diff for the judge context (Spec 027 AC3).
 */
function collectDiff(targetRoot, baseCommit) {
  const cwd = targetRoot || process.cwd();
  let text = '';
  let files = [];
  try {
    text = execSync(baseCommit ? `git diff ${baseCommit}` : 'git diff HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (e) {
    text = '';
  }
  try {
    const names = execSync(baseCommit ? `git diff --name-only ${baseCommit}` : 'git diff --name-only HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    files = names.split('\n').map(l => normalizePath(l.trim())).filter(Boolean);
  } catch (e) {
    files = [];
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  let truncated = false;
  if (bytes > DIFF_BYTE_LIMIT) {
    text = Buffer.from(text, 'utf8').subarray(0, DIFF_BYTE_LIMIT).toString('utf8') + '\n... [diff truncated at ' + DIFF_BYTE_LIMIT + ' bytes]\n';
    truncated = true;
  }

  return { text, bytes, truncated, files };
}

function criteriaBlock(acs) {
  return acs.map(ac => `- ${ac.id.trim()}: ${ac.text}`).join('\n');
}

/**
 * Builds the fenced judge prompt: acceptance criteria plus diff only
 * (Spec 027 AC3). Cumulative transcripts, evidence records, and blueprints are
 * deliberately excluded so the judge cannot inherit the implementer's claims.
 */
function buildJudgePrompt(options) {
  const { slug, acs, diff, criticity, judge } = options;
  const criticityLevel = CRITICITY_LEVELS.includes(criticity) ? criticity : DEFAULT_CRITICITY;
  const total = acs.length;

  const lines = [];
  lines.push(`# Conformance judge — ${slug}`);
  lines.push('');
  lines.push('You are an independent acceptance-criteria judge. Decide, for every criterion below, whether the provided diff satisfies it.');
  lines.push('');
  lines.push(`## Criticity: ${criticityLevel}`);
  lines.push(CRITICITY_RUBRIC[criticityLevel]);
  lines.push('');
  lines.push(`## Acceptance criteria (${total})`);
  lines.push(criteriaBlock(acs));
  lines.push('');
  lines.push(`## Code diff (${diff.files.length} file(s), ${diff.bytes} byte(s)${diff.truncated ? ', TRUNCATED' : ''})`);
  lines.push('```diff');
  lines.push(diff.text || '(empty diff)');
  lines.push('```');
  lines.push('');
  lines.push('## Output contract');
  lines.push('Reply with JSON only, no prose around it:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "score": 0,');
  lines.push('  "verdicts": [');
  lines.push('    { "id": "AC1", "verdict": "verified", "evidence": "path/to/file:line" }');
  lines.push('  ],');
  lines.push('  "notes": "optional short justification"');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Rules');
  lines.push('- `score` is an integer from 0 to 10 and must equal round(verified criteria / total criteria * 10).');
  lines.push('- Every criterion above appears exactly once in `verdicts`, with `verdict` set to `verified` or `failed`.');
  lines.push('- `evidence` cites a file path from the diff; when failing, state the missing behaviour instead.');
  lines.push('- Judge the criteria and the diff only. Never assume work that is not visible in the diff.');
  lines.push('- When the diff is truncated, judge only what is visible and say so in `notes`.');
  lines.push('');

  const judgeMeta = [];
  if (judge && judge.model) judgeMeta.push(`model=${judge.model}`);
  if (judge && judge.provider) judgeMeta.push(`provider=${judge.provider}`);
  if (judge && judge.effort) judgeMeta.push(`effort=${judge.effort}`);
  if (judge && judge.apiEndpoint) judgeMeta.push(`endpoint=${judge.apiEndpoint}`);

  return {
    prompt: lines.join('\n'),
    criteriaText: criteriaBlock(acs) + '\n',
    criticity: criticityLevel,
    judgeMeta,
    totalAcs: total,
    diffBytes: diff.bytes,
    diffTruncated: diff.truncated,
    diffFiles: diff.files
  };
}

/**
 * Validates a judge verdict against the specification criteria (Spec 027 AC7, AC10).
 */
function validateVerdict(raw, options) {
  const acs = (options && options.acs) || [];
  const errors = [];
  const knownIds = new Set(acs.map(ac => ac.id.trim()));

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Verdict must be a JSON object of the shape {"score": <0-10>, "verdicts": [...]}.'], data: null };
  }

  const score = raw.score;
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    errors.push(`Verdict "score" must be an integer between 0 and 10 (received: ${JSON.stringify(score)}).`);
  }

  const verdicts = raw.verdicts;
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    errors.push('Verdict "verdicts" must be a non-empty array.');
  } else {
    const seen = new Set();
    verdicts.forEach((entry, index) => {
      const label = `verdicts[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${label} must be an object.`);
        return;
      }
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) {
        errors.push(`${label}.id must be a non-empty acceptance criterion id.`);
        return;
      }
      if (!knownIds.has(id)) {
        errors.push(`${label}.id "${id}" is not an acceptance criterion of this specification.`);
        return;
      }
      if (seen.has(id)) {
        errors.push(`${label}.id "${id}" appears more than once.`);
      }
      seen.add(id);
      const verdict = typeof entry.verdict === 'string' ? entry.verdict.trim().toLowerCase() : '';
      if (!VERDICT_VALUES.includes(verdict)) {
        errors.push(`${label}.verdict must be one of: ${VERDICT_VALUES.join(', ')} (received: ${JSON.stringify(entry.verdict)}).`);
      }
      const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
      if (!evidence) {
        errors.push(`${label}.evidence must be a non-empty string citing the diff or the missing behaviour.`);
      }
    });
    for (const ac of acs) {
      const id = ac.id.trim();
      if (!seen.has(id)) {
        errors.push(`Missing verdict for acceptance criterion ${id}.`);
      }
    }
  }

  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') {
    errors.push('Verdict "notes" must be a string when present.');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? {
      score,
      verdicts: raw.verdicts.map(entry => ({
        id: entry.id.trim(),
        verdict: String(entry.verdict).trim().toLowerCase(),
        evidence: entry.evidence.trim()
      })),
      notes: typeof raw.notes === 'string' ? raw.notes : null
    } : null
  };
}

/**
 * Applies a validated verdict to produce the Step 5 score report (Spec 027 AC7, AC9).
 * The score is derived from the per-criterion verdicts so it stays deterministic;
 * a divergent judge-reported score is recorded instead of trusted.
 */
function applyVerdict(verdict, options) {
  const acs = (options && options.acs) || [];
  const minScore = options && options.minScore !== undefined ? options.minScore : 8;
  const judgeMeta = (options && options.judge) || {};

  const byId = {};
  for (const entry of verdict.verdicts) {
    byId[entry.id] = entry;
  }

  const verifiedAcs = [];
  const failingAcs = [];
  for (const ac of acs) {
    const id = ac.id.trim();
    const entry = byId[id];
    if (entry && entry.verdict === 'verified') {
      verifiedAcs.push({ id, text: ac.text, evidence: entry.evidence });
    } else {
      failingAcs.push({
        id,
        text: ac.text,
        reason: entry && entry.verdict === 'failed' ? entry.evidence : 'No verdict produced for this criterion.'
      });
    }
  }

  const totalAcs = acs.length;
  const verifiedCount = verifiedAcs.length;
  const score = totalAcs === 0 ? 0 : Math.max(0, Math.min(10, Math.round((verifiedCount / totalAcs) * 10)));
  const passed = totalAcs > 0 && score >= minScore;

  let feedback;
  if (totalAcs === 0) {
    feedback = 'Specification has no acceptance criteria. Fails closed with score 0/10.';
  } else if (!passed) {
    feedback = `Conformance score is ${score}/10 (minimum required: ${minScore}/10).\n` +
      `The following acceptance criteria were judged unmet:\n` +
      failingAcs.map(f => `- ${f.id}: ${f.text}\n  Reason: ${f.reason}`).join('\n') +
      `\nAddress the reasons above and re-run the workflow.`;
  } else {
    feedback = `Conformance score is ${score}/10 (meets or exceeds required threshold ${minScore}/10). ${verifiedCount}/${totalAcs} acceptance criteria judged verified against the diff.`;
  }

  return {
    score,
    passed,
    minScore,
    totalAcs,
    verifiedCount,
    failingCount: failingAcs.length,
    verifiedAcs,
    failingAcs,
    touchedFiles: options && Array.isArray(options.touchedFiles) ? options.touchedFiles : [],
    evidenceLinks: {},
    judge: {
      mode: judgeMeta.mode || 'agent',
      criticity: judgeMeta.criticity || DEFAULT_CRITICITY,
      model: judgeMeta.model || null,
      provider: judgeMeta.provider || null,
      effort: judgeMeta.effort || null,
      apiEndpoint: judgeMeta.apiEndpoint || null,
      reportedScore: verdict.score,
      scoreMismatch: verdict.score !== score,
      notes: verdict.notes || null,
      diffBytes: judgeMeta.diffBytes !== undefined ? judgeMeta.diffBytes : null,
      diffTruncated: Boolean(judgeMeta.diffTruncated)
    },
    feedback
  };
}

/**
 * Executes a configured judge command (Spec 027 AC4).
 * Tokens: {promptFile}, {verdictFile}, {diffFile}, {criteriaFile}, {slug}, {targetRoot}.
 */
function runJudgeCommand(options) {
  const config = options.config || {};
  const judge = options.judge || resolveJudgeConfig(config);
  if (!judge.command) {
    return { success: false, exitCode: 1, error: 'No scoring.judgeCommand configured.' };
  }

  const quote = (value) => {
    const str = String(value);
    if (process.platform === 'win32') {
      if (/["\r\n]/.test(str)) throw new Error(`Unsafe path for judge command substitution: ${str}`);
      return `"${str}"`;
    }
    return `'${str.replace(/'/g, "'\\''")}'`;
  };

  const substituted = judge.command
    .replace(/\{promptFile\}/g, quote(options.promptFileAbs))
    .replace(/\{verdictFile\}/g, quote(options.verdictFileAbs))
    .replace(/\{diffFile\}/g, quote(options.diffFileAbs))
    .replace(/\{criteriaFile\}/g, quote(options.criteriaFileAbs))
    .replace(/\{slug\}/g, options.slug)
    .replace(/\{targetRoot\}/g, quote(options.targetRoot));

  const allowlist = (config.implementation && Array.isArray(config.implementation.envAllowlist) && config.implementation.envAllowlist.length > 0)
    ? config.implementation.envAllowlist
    : DEFAULT_ENV_ALLOWLIST;
  const filteredEnv = {};
  for (const key of allowlist) {
    const foundKey = Object.keys(process.env).find(k => k.toUpperCase() === String(key).toUpperCase());
    if (foundKey) filteredEnv[key] = process.env[foundKey];
  }
  filteredEnv.SDW_JUDGE_PROMPT = options.promptFileAbs;
  filteredEnv.SDW_JUDGE_VERDICT = options.verdictFileAbs;
  filteredEnv.SDW_JUDGE_DIFF = options.diffFileAbs;
  filteredEnv.SDW_JUDGE_CRITERIA = options.criteriaFileAbs;
  filteredEnv.SDW_SPEC_SLUG = options.slug;
  filteredEnv.SDW_TARGET_ROOT = options.targetRoot;
  if (judge.model) filteredEnv.SDW_JUDGE_MODEL = judge.model;
  if (judge.provider) filteredEnv.SDW_JUDGE_PROVIDER = judge.provider;
  if (judge.effort) filteredEnv.SDW_JUDGE_EFFORT = judge.effort;
  if (judge.apiEndpoint) filteredEnv.SDW_JUDGE_API_ENDPOINT = judge.apiEndpoint;

  const proc = spawnSync(substituted, {
    cwd: options.targetRoot,
    shell: true,
    env: filteredEnv,
    timeout: JUDGE_TIMEOUT_MS,
    encoding: 'utf8'
  });

  if (proc.error && proc.error.code === 'ETIMEDOUT') {
    return { success: false, timedOut: true, exitCode: 1, error: `Judge command timed out after ${JUDGE_TIMEOUT_MS}ms.` };
  }
  if (proc.status !== 0) {
    const stderr = proc.stderr ? String(proc.stderr).trim() : '';
    return { success: false, exitCode: proc.status || 1, error: stderr || `Judge command exited with status ${proc.status}.` };
  }
  return { success: true, exitCode: 0, stdout: proc.stdout };
}

/**
 * Reads and parses a verdict file.
 */
function readVerdictFile(verdictFileAbs) {
  if (!fs.existsSync(verdictFileAbs)) {
    return { ok: false, error: `Verdict file not found: "${normalizePath(verdictFileAbs)}".` };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(verdictFileAbs, 'utf8'));
  } catch (err) {
    return { ok: false, error: `Verdict file "${normalizePath(verdictFileAbs)}" is not valid JSON: ${err.message}` };
  }
  return { ok: true, verdict: parsed };
}

module.exports = {
  CRITICITY_LEVELS,
  DEFAULT_CRITICITY,
  VERDICT_VALUES,
  DIFF_BYTE_LIMIT,
  CRITICITY_RUBRIC,
  getTouchedFiles,
  resolveJudgeConfig,
  resolveJudgePaths,
  collectDiff,
  buildJudgePrompt,
  validateVerdict,
  applyVerdict,
  runJudgeCommand,
  readVerdictFile,
  parseAcceptanceCriteria
};
