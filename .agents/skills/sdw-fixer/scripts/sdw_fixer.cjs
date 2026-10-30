#!/usr/bin/env node
'use strict';
/**
 * sdw-fixer Tier-3 helper (stdlib only: fs, path, child_process).
 * Validates findings, scores them, sweeps defect-class siblings via grep,
 * injects memory hints via sdw-memory, applies deterministic trivial patches,
 * and writes a JSON result report.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sdwMemory = require('../../sdw-memory/scripts/sdw_memory.cjs');

const SEVERITY_SCORE = { critical: 100, high: 75, medium: 50, low: 25 };
const RULE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CORE_MODULES = new Set(['fs', 'path', 'os', 'child_process', 'util']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_PREFIXES = ['.sdw/state', '.sdw/sandbox'];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HITS = 50;
const MAX_SCANNED_FILES = 2000;
const SNIPPET_LEN = 160;

const TRIVIAL_RULES = {
  no_debugger_statements: {
    tokens: ['debugger'],
    linePattern: /^\s*debugger\s*;?\s*$/
  }
};

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) ||
        fs.existsSync(path.join(curr, '.git')) ||
        fs.existsSync(path.join(curr, 'skills')) ||
        fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function parseArgs(args) {
  const o = { subcommand: null, findings: null, report: null, markdown: null, dryRun: false, json: false, verify: null, root: null, learn: true };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--findings') o.findings = args[++i];
    else if (a.startsWith('--findings=')) o.findings = a.slice(11);
    else if (a === '--report') o.report = args[++i];
    else if (a.startsWith('--report=')) o.report = a.slice(9);
    else if (a === '--markdown') o.markdown = args[++i];
    else if (a.startsWith('--markdown=')) o.markdown = a.slice(11);
    else if (a === '--verify') o.verify = args[++i];
    else if (a.startsWith('--verify=')) o.verify = a.slice(9);
    else if (a === '--root') o.root = args[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (a === '--no-learn') o.learn = false;
    else if (!a.startsWith('-')) positional.push(a);
  }
  o.subcommand = positional[0] || null;
  return o;
}

function isUnsafePath(file) {
  if (typeof file !== 'string' || file.trim() === '') return 'empty file path';
  const f = file.trim();
  if (path.isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f) || f.startsWith('/')) return 'absolute paths are rejected';
  if (f.split(/[\\/]/).includes('..')) return '".." traversal is rejected';
  return null;
}

function loadFindings(findingsPath, root) {
  const resolved = path.isAbsolute(findingsPath) ? findingsPath : path.resolve(root, findingsPath);
  if (!fs.existsSync(resolved)) return { error: `Findings file not found: ${findingsPath}` };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    return { error: `Findings file is not valid JSON: ${e.message}` };
  }
  const batchId = (data && typeof data === 'object' && !Array.isArray(data) && data.batchId) || `fix-${Date.now()}`;
  const list = Array.isArray(data) ? data : data.findings;
  if (!Array.isArray(list)) return { error: 'Findings payload must be an array or { batchId, findings: [...] }' };
  return { batchId, list };
}

function validateFinding(entry, idx) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return [`finding[${idx}]: entry must be an object`];
  const pathProblem = isUnsafePath(entry.file);
  if (pathProblem) errors.push(`finding[${idx}]: invalid file (${pathProblem})`);
  if (typeof entry.rule !== 'string' || entry.rule.trim() === '' || !RULE_PATTERN.test(entry.rule.trim())) {
    errors.push(`finding[${idx}]: rule must match ${RULE_PATTERN}`);
  }
  if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') {
    errors.push(`finding[${idx}]: evidence reference is required`);
  }
  if (entry.line !== undefined && entry.line !== null &&
      (!Number.isInteger(entry.line) || entry.line < 1)) {
    errors.push(`finding[${idx}]: line must be a positive integer when present`);
  }
  return errors;
}

function scoreOf(finding) {
  const hint = String(finding.severityHint || 'medium').toLowerCase();
  return SEVERITY_SCORE[hint] !== undefined ? SEVERITY_SCORE[hint] : SEVERITY_SCORE.medium;
}

function tokensForRule(rule) {
  if (TRIVIAL_RULES[rule]) return TRIVIAL_RULES[rule].tokens;
  return [rule];
}

function shouldSkipFile(relPath, stat) {
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return true;
  const parts = relPath.split('/');
  if (parts.some(p => SKIP_DIRS.has(p))) return true;
  if (SKIP_PREFIXES.some(p => relPath === p || relPath.startsWith(p + '/'))) return true;
  return false;
}

function grepSiblings(root, rule) {
  const tokens = tokensForRule(rule);
  const hits = [];
  let scanned = 0;
  const stack = [root];
  while (stack.length > 0 && hits.length < MAX_HITS && scanned < MAX_SCANNED_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || scanned >= MAX_SCANNED_FILES) break;
      const abs = path.join(dir, entry.name);
      const rel = norm(path.relative(root, abs));
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else {
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch (e) {
          continue;
        }
        if (shouldSkipFile(rel, stat)) continue;
        scanned += 1;
        let content;
        try {
          content = fs.readFileSync(abs, 'utf8');
        } catch (e) {
          continue;
        }
        if (content.indexOf('\0') !== -1) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const matched = tokens.some(t => lines[i].includes(t));
          if (matched) {
            hits.push({ file: rel, line: i + 1, snippet: lines[i].trim().slice(0, SNIPPET_LEN) });
            if (hits.length >= MAX_HITS) break;
          }
        }
      }
    }
  }
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const truncated = hits.length >= MAX_HITS || scanned >= MAX_SCANNED_FILES;
  return { hits, scanned, truncated };
}

function humanizeRule(rule) {
  const words = String(rule).replace(/[_.-]+/g, ' ').trim().replace(/\s+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(rule);
}

/* All product knowledge flows through the central sdw-memory wrapper
   (backends separated in skills/sdw-memory/scripts/backends/). This file
   never reads traps.md, MEMORY.md, or the memo vault directly. */
function consultKnowledge(root, rule) {
  const only = process.env.SDW_FIXER_NO_MEMO === '1' ? ['traps', 'files'] : undefined;
  const c = sdwMemory.consultMemory(root, rule, { limit: 5, ...(only ? { backends: only } : {}) });
  return {
    mem: { hints: c.traps.hints.map(h => ({ slug: h.slug, title: h.title, action: h.action })), skipped: c.traps.skipped },
    files: { hints: c.files.hints.map(h => ({ source: h.file, snippet: h.snippet })), skipped: c.files.skipped },
    memo: { hints: c.vault.hints, skipped: c.vault.skipped }
  };
}

function recordTrap(root, rule, summary) {
  const catalog = TRIVIAL_RULES[rule];
  const res = sdwMemory.recordTrap({
    kind: 'trap',
    title: humanizeRule(rule),
    avoid: `Reintroducing ${rule} lines (${summary})`,
    action: catalog ? `Delete lines matching ${catalog.linePattern.source} at finding plus verified sibling hits` : 'Apply the verified surgical fix at finding plus sibling hits',
    layer: 'implementation',
    root
  });
  if (res.recorded) console.log(`[sdw-fixer] Trap registered: ${res.slug}`);
  return res;
}

function applyTrivialFix(root, finding, siblingHits, dryRun) {
  const catalog = TRIVIAL_RULES[finding.rule];
  if (!catalog) return { status: 'skipped', reason: 'non-trivial: requires agent reasoning' };
  // Group candidate lines by file: the anchor file plus every sibling file
  // with grep hits. A defect class is closed only when each in-scope file is
  // either patched or recorded as skipped with an explicit reason.
  const candidates = new Map();
  const addCandidate = (file, line) => {
    const f = norm(String(file || '').trim());
    if (!f) return;
    if (!candidates.has(f)) candidates.set(f, new Set());
    if (Number.isInteger(line) && line > 0) candidates.get(f).add(line);
  };
  addCandidate(finding.file, finding.line);
  for (const h of siblingHits || []) addCandidate(h.file, h.line);
  const fixed = [];
  const skippedFiles = [];
  for (const [file, lines] of candidates) {
    let content;
    try {
      const abs = path.resolve(root, file);
      if (!fs.existsSync(abs)) { skippedFiles.push({ file, reason: 'file-not-found on disk' }); continue; }
      content = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      skippedFiles.push({ file, reason: `unreadable file: ${e.message}` });
      continue;
    }
    const fileLines = content.split('\n');
    const targets = [...lines]
      .filter(ln => fileLines[ln - 1] !== undefined && catalog.linePattern.test(fileLines[ln - 1]))
      .sort((a, b) => a - b);
    if (targets.length === 0) {
      skippedFiles.push({ file, reason: 'pattern mismatch: no patchable defect-class line in this file' });
      continue;
    }
    if (!dryRun) {
      try {
        const targetSet = new Set(targets);
        const next = fileLines.filter((_, i) => !targetSet.has(i + 1)).join('\n');
        fs.writeFileSync(path.resolve(root, file), next, 'utf8');
      } catch (e) {
        skippedFiles.push({ file, reason: `write failed: ${e.message}` });
        continue;
      }
    }
    for (const ln of targets) fixed.push({ file, line: ln });
  }
  if (fixed.length === 0) {
    const reason = skippedFiles.length > 0
      ? skippedFiles.map(s => `${s.file}: ${s.reason}`).join('; ')
      : 'pattern mismatch at cited line and sibling lines';
    return { status: 'skipped', reason, skippedFiles };
  }
  return { status: dryRun ? 'simulated' : 'fixed', fixed, skippedFiles };
}

function runVerification(root, command) {
  if (!command) {
    return { exitCode: null, status: 'skipped', reason: 'no --verify command given' };
  }
  const res = spawnSync(command, { cwd: root, shell: true, timeout: 600000, encoding: 'utf8' });
  return {
    exitCode: res.status !== null && res.status !== undefined ? res.status : 1,
    status: res.status === 0 ? 'passed' : 'failed',
    command,
    tail: norm(((res.stdout || '') + (res.stderr || '')).slice(-2000))
  };
}

function cmdRun(options) {
  const root = path.resolve(options.root || findProjectRoot());
  if (!options.findings) return { exit: 1, error: 'run requires --findings <path>' };
  if (!options.report) return { exit: 1, error: 'run requires --report <path>' };

  const loaded = loadFindings(options.findings, root);
  if (loaded.error) return { exit: 1, error: loaded.error };

  const errors = [];
  loaded.list.forEach((entry, idx) => errors.push(...validateFinding(entry, idx)));
  if (errors.length > 0) return { exit: 1, error: errors.join('; ') };

  const scored = loaded.list.map((f, i) => ({ finding: f, index: i, score: scoreOf(f) }));
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  console.log(`[sdw-fixer] Scoring ${scored.length} findings`);

  const fixed = [];
  const skipped = [];
  const wouldFix = [];
  const covered = [];
  const details = [];
  const knowledgeCache = new Map();
  const handled = new Set(); // file:line keys already patched in this batch
  // Structured deviations from the scored plan (adapted from the ws-fix-pr
  // amendment log): recorded when evidence changes a finding's planned action.
  const amendments = [];
  const amend = (finding, from, to, reason, evidence) => {
    amendments.push({
      at: new Date().toISOString(),
      file: finding.file.trim(),
      line: finding.line || null,
      rule: finding.rule.trim(),
      from,
      to,
      reason,
      evidence
    });
  };

  for (const { finding, score } of scored) {
    const file = finding.file.trim();
    const rule = finding.rule.trim();
    const { hits: rawHits, scanned, truncated } = grepSiblings(root, rule);
    // Run-own artifacts (findings input, JSON report) are not product code:
    // never patch them and never report them as siblings.
    const ownFiles = new Set(
      [options.findings, options.report]
        .map(f => { try { return norm(path.relative(root, path.resolve(root, f))); } catch (e) { return null; } })
        .filter(Boolean)
    );
    const hits = rawHits.filter(h => !ownFiles.has(h.file));
    if (truncated) {
      skipped.push({ file, reason: `sibling sweep truncated at ${MAX_HITS} hits; remaining occurrences unverified` });
      amend(finding, 'fix', 'partial', 'sibling sweep truncated; remaining class occurrences unverified', `max-hits:${MAX_HITS}`);
    }
    let cached = knowledgeCache.get(rule);
    if (!cached) {
      cached = consultKnowledge(root, rule);
      knowledgeCache.set(rule, cached);
    }
    const { mem, files: memFiles, memo: specMemo } = cached;
    console.log(`[sdw-fixer] Memory hints for ${rule}: traps=${mem.hints.length} files=${memFiles.hints.length} vault=${specMemo.hints.length}`);
    const sourcesConsulted = [
      `code-grep:${hits.length} hits/${scanned} files`,
      mem.skipped ? 'memory-traps:consult-skipped' : `memory-traps:${mem.hints.length} hints`,
      memFiles.skipped ? 'memory-files:consult-skipped' : `memory-files:${memFiles.hints.length} hints`,
      specMemo.skipped ? 'spec-memo:consult-skipped' : `spec-memo:${specMemo.hints.length} hints`,
      'pr-context:consult-skipped'
    ];
    const outcome = (() => {
      // Duplicate or overlapping finding on a line this batch already
      // patched: the defect is closed, so report coverage instead of a
      // contradictory pattern-mismatch skip.
      const anchorKey = finding.line ? `${norm(file)}:${finding.line}` : null;
      if (anchorKey && handled.has(anchorKey)) {
        return { status: 'covered', fixed: [], skippedFiles: [] };
      }
      return applyTrivialFix(root, finding, hits, options.dryRun);
    })();
    const detail = {
      file, line: finding.line || null, rule,
      score, sourcesConsulted, siblingHits: hits,
      memoryHints: mem.hints, memoryFileHints: memFiles.hints, specMemoHints: specMemo.hints,
      outcome: outcome.status
    };
    if (outcome.status === 'covered') {
      covered.push({ file, line: finding.line, defectClass: finding.rule.trim() });
      detail.coveredBy = [{ file, line: finding.line }];
      amend(finding, 'fix', 'covered', 'the same line was already patched by this batch', 'duplicate-line');
    } else if (outcome.status === 'fixed') {
      for (const f of outcome.fixed) {
        fixed.push({
          file: f.file,
          line: f.line,
          defectClass: finding.rule.trim(),
          threadId: finding.threadId || null
        });
        handled.add(`${norm(f.file)}:${f.line}`);
      }
      for (const s of outcome.skippedFiles || []) skipped.push({ file: s.file, reason: s.reason });
      detail.fixedFiles = outcome.fixed;
    } else if (outcome.status === 'simulated') {
      for (const f of outcome.fixed) { wouldFix.push({ file: f.file, line: f.line, defectClass: finding.rule.trim() }); handled.add(`${norm(f.file)}:${f.line}`); }
      for (const s of outcome.skippedFiles || []) skipped.push({ file: s.file, reason: s.reason });
      detail.simulatedFiles = outcome.fixed;
    } else {
      skipped.push({ file, reason: outcome.reason });
      amend(finding, 'fix', 'skipped', outcome.reason, 'scope-gate');
      for (const s of outcome.skippedFiles || []) {
        if (s.file !== file) skipped.push({ file: s.file, reason: s.reason });
      }
      detail.skipReason = outcome.reason;
    }
    details.push(detail);
  }

  // Resolution comments ready for the caller to post on the matching review
  // threads (adapted from the ws-fix-pr resolution-reply contract).
  const comments = fixed.map(f => ({
    threadId: f.threadId,
    file: f.file,
    line: f.line,
    defectClass: f.defectClass,
    comment: `<!-- resolution-reply -->\nResolved review issue: fixed ${f.defectClass} at ${f.file}:${f.line}.\n\nSummary: deterministic ${f.defectClass} patch applied to the anchored line and verified sibling lines.`
  }));

  const verification = runVerification(root, options.verify);
  const learned = [];
  const learnEnabled = options.learn !== false;
  if (!options.dryRun && learnEnabled && verification.status !== 'failed') {
    const byRule = new Map();
    for (const f of fixed) {
      if (!byRule.has(f.defectClass)) byRule.set(f.defectClass, []);
      byRule.get(f.defectClass).push(f);
    }
    for (const [rule, items] of byRule) {
      const files = [...new Set(items.map(i => i.file))];
      const res = recordTrap(root, rule, `${items.length} line(s) in ${files.join(', ')}`);
      learned.push({ rule, slug: res.slug || sdwMemory.slugOf(rule), recorded: res.recorded, ...(res.reason ? { reason: res.reason } : {}) });
    }
  }
  const status = verification.status === 'failed' ? 'verify-failed'
    : (fixed.length === 0 && covered.length === 0 && skipped.length > 0) ? 'no-op'
    : loaded.list.length === 0 ? 'no-op' : 'completed';
  const report = {
    batchId: loaded.batchId,
    status,
    fixed,
    skipped,
    wouldFix,
    covered,
    comments,
    amendments,
    learned,
    verification: { exitCode: verification.exitCode, status: verification.status,
      ...(verification.reason ? { reason: verification.reason } : {}),
      ...(verification.command ? { command: verification.command } : {}) },
    reportPath: options.report,
    details
  };
  const reportAbs = path.isAbsolute(options.report) ? options.report : path.resolve(root, options.report);
  fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
  fs.writeFileSync(reportAbs, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[sdw-fixer] Report written to ${norm(path.relative(root, reportAbs))}`);

  // Optional human-readable round report (adapted from the ws-fix-pr round report).
  if (options.markdown) {
    const mdAbs = path.isAbsolute(options.markdown) ? options.markdown : path.resolve(root, options.markdown);
    const lines = [];
    lines.push(`# sdw-fixer batch ${report.batchId}`);
    lines.push('');
    lines.push(`- Status: ${report.status}`);
    lines.push(`- Fixed: ${fixed.length}`);
    lines.push(`- Covered: ${covered.length}`);
    lines.push(`- Skipped: ${skipped.length}`);
    lines.push(`- Would fix (dry-run): ${wouldFix.length}`);
    lines.push(`- Verification: ${verification.status}`);
    lines.push('');
    lines.push('| File | Line | Defect class | Score | Outcome |');
    lines.push('|---|---|---|---|---|');
    for (const d of details) {
      lines.push(`| ${d.file} | ${d.line || ''} | ${d.rule} | ${d.score} | ${d.outcome} |`);
    }
    if (skipped.length > 0) {
      lines.push('');
      lines.push('## Skipped');
      for (const s of skipped) lines.push(`- ${s.file}: ${s.reason}`);
    }
    if (amendments.length > 0) {
      lines.push('');
      lines.push('## Amendments');
      for (const a of amendments) lines.push(`- ${a.file}:${a.line || ''} (${a.rule}): ${a.from} -> ${a.to}; ${a.reason}`);
    }
    fs.mkdirSync(path.dirname(mdAbs), { recursive: true });
    fs.writeFileSync(mdAbs, lines.join('\n') + '\n', 'utf8');
    report.markdownPath = norm(path.relative(root, mdAbs));
    fs.writeFileSync(reportAbs, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  if (options.json) console.log(JSON.stringify({ batchId: report.batchId, status, fixed, skipped, wouldFix, covered, verification: report.verification }, null, 2));
  else console.log(`[sdw-fixer] Batch ${report.batchId}: ${fixed.length} fixed, ${covered.length} already-covered, ${skipped.length} skipped${options.dryRun ? `, ${wouldFix.length} would-fix (dry-run)` : ''}, verification ${verification.status}`);

  return { exit: verification.status === 'failed' ? 1 : 0, report };
}

function cmdDoctor(options) {
  const root = path.resolve(options.root || findProjectRoot());
  const issues = [];
  const skillDir = path.join(root, 'skills', 'sdw-fixer');

  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    issues.push('SKILL.md missing');
  } else {
    const content = fs.readFileSync(skillMd, 'utf8');
    const lineCount = content.split(/\r?\n/).length;
    if (lineCount > 120) issues.push(`SKILL.md exceeds 120 lines (${lineCount})`);
    if (!/>\s*When this skill is loaded,\s*output/i.test(content)) issues.push('SKILL.md missing announcement banner');
    if (!/sdw-rules/i.test(content)) issues.push('SKILL.md missing sdw-rules reference');
  }
  if (!fs.existsSync(path.join(skillDir, 'references', 'fixer_protocol.md'))) {
    issues.push('references/fixer_protocol.md missing');
  }
  const selfCheck = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (selfCheck.status !== 0) issues.push(`script syntax check failed: ${(selfCheck.stderr || '').trim()}`);
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    const requires = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map(m => m[1]);
    const external = requires.filter(r => !CORE_MODULES.has(r) && !r.startsWith('.') && !r.startsWith('/'));
    if (external.length > 0) issues.push(`external runtime dependencies: ${external.join(', ')}`);
  } catch (e) {
    issues.push(`cannot self-inspect requires: ${e.message}`);
  }

  const passed = issues.length === 0;
  const result = { passed, skill: 'sdw-fixer', issues,
    summary: passed ? 'sdw-fixer doctor passed.' : `sdw-fixer doctor failed: ${issues.join('; ')}` };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sdw-fixer doctor] ${result.summary}`);
  return { exit: passed ? 0 : 1, result };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.subcommand || options.subcommand === 'help' || options.subcommand === '--help') {
    console.log(`sdw-fixer — shared findings intake and surgical remediation
Usage:
  node sdw_fixer.cjs run --findings <path> --report <path> [--dry-run] [--json] [--verify <cmd>] [--root <path>] [--no-learn]
  node sdw_fixer.cjs doctor [--json] [--root <path>]`);
    process.exit(0);
  }
  if (options.subcommand === 'run') {
    const r = cmdRun(options);
    if (r.error) console.error(`[sdw-fixer] Error: ${r.error}`);
    process.exit(r.exit);
  }
  if (options.subcommand === 'doctor') {
    const r = cmdDoctor(options);
    process.exit(r.exit);
  }
  console.error(`[sdw-fixer] Unknown subcommand "${options.subcommand}". Use run or doctor.`);
  process.exit(1);
}

module.exports = {
  findProjectRoot, loadFindings, validateFinding, scoreOf,
  grepSiblings, consultKnowledge,
  applyTrivialFix, recordTrap, cmdRun, cmdDoctor
};

if (require.main === module) main();
