#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function runGit(projectRoot, args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) || fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, 'skills')) || fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function parseArgs(args) {
  const result = {
    subcommand: 'run',
    base: null,
    target: null,
    report: null,
    fix: false,
    fixExplicit: false,
    dryRun: false,
    json: false,
    maxIterations: 3,
    help: false
  };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'run' || arg === 'fix' || arg === 'doctor') {
      if (!positional.length && result.subcommand === 'run' && i === 0) {
        result.subcommand = arg;
      } else {
        positional.push(arg);
      }
    } else if (arg === '--base' && args[i + 1]) {
      result.base = args[++i];
    } else if (arg.startsWith('--base=')) {
      result.base = arg.slice(7);
    } else if ((arg === '--target' || arg === '--root' || arg === '--project-root') && args[i + 1]) {
      result.target = args[++i];
    } else if (arg.startsWith('--target=')) {
      result.target = arg.slice(9);
    } else if (arg.startsWith('--root=')) {
      result.target = arg.slice(7);
    } else if ((arg === '--report' || arg === '--report-path') && args[i + 1]) {
      result.report = args[++i];
    } else if (arg.startsWith('--report=')) {
      result.report = arg.slice(9);
    } else if (arg === '--fix') {
      result.fix = true;
      result.fixExplicit = true;
    } else if (arg === '--no-fix') {
      result.fix = false;
      result.fixExplicit = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--max-iterations' && args[i + 1]) {
      result.maxIterations = parseInt(args[++i], 10) || 3;
    } else if (arg.startsWith('--max-iterations=')) {
      result.maxIterations = parseInt(arg.slice(17), 10) || 3;
    } else if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (!arg.startsWith('-')) {
      if (positional.length === 0 && (arg === 'run' || arg === 'fix' || arg === 'doctor')) {
        result.subcommand = arg;
      } else {
        positional.push(arg);
      }
    }
  }
  if (result.subcommand === 'fix' && !result.fixExplicit) {
    result.fix = true;
  }
  if (result.maxIterations < 1) result.maxIterations = 1;
  if (result.maxIterations > 10) result.maxIterations = 10;
  return result;
}

function loadProjectConfig(projectRoot) {
  const cfgPath = path.join(projectRoot, '.sdw', 'config.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function gitVerifies(projectRoot, ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: projectRoot, encoding: 'utf8', stdio: 'ignore' });
  return r.status === 0;
}

function resolveBaseRef(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const explicitBase = options.base || options.explicitBase || null;

  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(`Not a Git repository: "${projectRoot}" has no Git history. Run inside a Git work tree.`);
  }

  if (explicitBase) {
    if (!gitVerifies(projectRoot, explicitBase)) {
      throw new Error(`Unresolvable base reference: "${explicitBase}" is not a valid Git ref.`);
    }
    return { base: explicitBase, source: 'explicit' };
  }

  const config = loadProjectConfig(projectRoot);

  // AC11: the integration lane is the primary review base.
  let integrationBranch = null;
  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    const branching = sdwConfig.resolveBranching(config);
    if (branching && typeof branching.integrationBranch === 'string' && branching.integrationBranch.trim()) {
      integrationBranch = branching.integrationBranch.trim();
    }
  } catch (e) {
    integrationBranch = null;
  }
  if (integrationBranch) {
    const candidates = [integrationBranch, `origin/${integrationBranch}`, `refs/heads/${integrationBranch}`, `refs/remotes/origin/${integrationBranch}`];
    for (const c of candidates) {
      if (gitVerifies(projectRoot, c)) {
        return { base: c, source: 'branching' };
      }
    }
  }

  if (config.baseBranch && typeof config.baseBranch === 'string' && config.baseBranch.trim()) {
    const cfgBase = config.baseBranch.trim();
    const candidates = [cfgBase, `origin/${cfgBase}`, `refs/heads/${cfgBase}`, `refs/remotes/origin/${cfgBase}`];
    for (const c of candidates) {
      if (gitVerifies(projectRoot, c)) {
        return { base: c, source: 'config' };
      }
    }
  }

  const tracking = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'origin/main', 'origin/master'];
  for (const t of tracking) {
    if (gitVerifies(projectRoot, t)) {
      return { base: t, source: 'tracking-remote' };
    }
  }

  const local = ['refs/heads/main', 'refs/heads/master', 'main', 'master'];
  for (const l of local) {
    if (gitVerifies(projectRoot, l)) {
      return { base: l, source: 'local' };
    }
  }

  try {
    const mergeBase = execSync('git merge-base HEAD origin/main', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (mergeBase) return { base: mergeBase, source: 'merge-base' };
  } catch (e) {}

  try {
    const rootCommit = execSync('git rev-list --max-parents=0 HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim();
    if (rootCommit) return { base: rootCommit, source: 'initial-commit' };
  } catch (e) {}

  throw new Error('Unable to auto-detect base branch (checked config baseBranch, origin/main|master, main|master, merge-base, initial commit). Pass --base <ref>.');
}

function getHeadInfo(projectRoot) {
  let head = null;
  let targetBranch = null;
  try {
    head = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (e) { head = null; }
  try {
    const br = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    targetBranch = br || null;
  } catch (e) { targetBranch = null; }
  return { head, targetBranch };
}

function getChangedFiles(options) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const base = options.base || null;
  const fileSet = new Set();

  if (base) {
    try {
      const out = runGit(projectRoot, ['diff', '--name-only', base, 'HEAD']);
      out.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
    } catch (e) {}
    try {
      const out2 = runGit(projectRoot, ['diff', '--name-only', base]);
      out2.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
    } catch (e) {}
  }
  try {
    const unstaged = execSync('git diff --name-only', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    unstaged.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
  } catch (e) {}
  try {
    const staged = execSync('git diff --cached --name-only', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    staged.split('\n').map(l => l.trim()).filter(Boolean).forEach(f => fileSet.add(normalizePath(f)));
  } catch (e) {}
  try {
    const status = execSync('git status --porcelain -uall', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    status.split('\n').forEach(line => {
      if (!line.trim()) return;
      const m = line.match(/^.{1,2}\s+(.+)$/);
      if (!m) return;
      let f = m[1].trim().replace(/^"(.*)"$/, '$1');
      const arrow = f.indexOf(' -> ');
      if (arrow !== -1) f = f.slice(arrow + 4);
      if (f) fileSet.add(normalizePath(f));
    });
  } catch (e) {}

  return Array.from(fileSet).filter(f => f && !f.startsWith('.git/')).sort();
}

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', regex: /\b(gh[ps]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9]{36,})\b/ },
  { name: 'Slack Token', regex: /\bxox[bpras]-[0-9a-zA-Z-]{24,}\b/ },
  { name: 'API Key (sk-...)', regex: /\bsk-[a-zA-Z0-9]{32,}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Database URL with credentials', regex: /(postgresql|mysql|mongodb(\+srv)?|redis|jdbc):\/\/[^:\s]+:[^@\s]+@/ }
];

const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/\\]+$/,
  /\.(pfx|p12)$/i,
  /(^|\/)secrets\.ya?ml$/i,
  /(^|\/)credentials\.(json|toml)$/i,
  /(^|\/)id_(rsa|ecdsa|ed25519)$/i,
  /\.(pem|key)$/i
];

const SCANNABLE_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py']);

function isTestFile(file) {
  const n = normalizePath(file);
  return /(^|\/)tests?\//.test(n)
    || /(^|\/)__tests__\//.test(n)
    || /\.(test|spec)\.[^/]+$/.test(n);
}

function getAddedLines(projectRoot, base, file) {
  if (!base) {
    try {
      const abs = path.join(projectRoot, file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return fs.readFileSync(abs, 'utf8').split('\n').length;
      }
    } catch (e) {}
    return 0;
  }
  try {
    const out = runGit(projectRoot, ['diff', '--numstat', base, '--', file]).trim();
    if (out) {
      const first = out.split('\n')[0].split('\t');
      const added = parseInt(first[0], 10);
      if (Number.isFinite(added)) return added;
    }
  } catch (e) {}
  try {
    const abs = path.join(projectRoot, file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ls = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: projectRoot, encoding: 'utf8', stdio: 'ignore' });
      if (ls.status !== 0) {
        return fs.readFileSync(abs, 'utf8').split('\n').length;
      }
    }
  } catch (e) {}
  return 0;
}

function buildHunk(lines, lineNum) {
  const start = Math.max(1, lineNum - 1);
  const end = Math.min(lines.length, lineNum + 1);
  const slice = [];
  for (let i = start; i <= end; i++) {
    let content = lines[i - 1] || '';
    for (const p of SECRET_PATTERNS) {
      content = content.replace(p.regex, '***REDACTED***');
    }
    slice.push(`L${i}: ${content}`);
  }
  return slice.join('\n');
}

function fixPrescription(rule, filePath) {
  switch (rule) {
    case 'no_debugger_statements':
      return `1. Delete the standalone debugger line at ${filePath}. 2. Re-run relevant tests. 3. Re-run sdw-code-review to confirm 0 blocking findings.`;
    case 'unresolved_todos':
      return `1. Resolve the TODO at ${filePath} or file it as a tracked task. 2. Remove the comment or convert it to a spec AC. 3. Re-run review.`;
    case 'hardcoded_secret':
      return `1. Revoke the exposed credential immediately. 2. Remove it from code and history. 3. Replace with an env var or config reference. 4. Re-run review plus a secret scan.`;
    case 'sensitive_filename':
      return `1. Remove the sensitive file from the diff (git rm --cached) and add it to .gitignore. 2. Rotate any committed credentials. 3. Re-run review.`;
    case 'no_python_in_skills':
      return `1. Rewrite the helper in Node.js 22 CommonJS (.cjs) with stdlib only. 2. Delete the .py file under skills/. 3. Re-run review.`;
    case 'unrequested_scope_expansion':
      return `1. Remove the unrequested or speculative code, or confirm scope via ask_question. 2. Keep the diff minimal. 3. Re-run review.`;
    case 'oversized_diff':
      return `1. Split the change into smaller stacked diffs (each under 300 added lines). 2. Keep each diff surgical. 3. Re-run review.`;
    default:
      return `1. Address the finding at ${filePath} per sdw-rules simplicity. 2. Re-run review.`;
  }
}

function analyzeChangedFiles(projectRoot, base, files) {
  const raw = [];
  for (const f of files) {
    const norm = normalizePath(f);

    if (norm.startsWith('skills/') && norm.endsWith('.py')) {
      raw.push({
        severity: 'critical',
        path: `${norm}:1`,
        file: norm,
        line: 1,
        rule: 'no_python_in_skills',
        message: 'Skills must only use Node.js CommonJS (.cjs) helpers. Python scripts are prohibited.',
        fixable: false,
        hunk: `L1: (python file under skills/)`
      });
    }

    if (SENSITIVE_FILE_PATTERNS.some(re => re.test(norm))) {
      if (!norm.includes('test') && !norm.includes('example')) {
        raw.push({
          severity: 'warning',
          path: `${norm}:1`,
          file: norm,
          line: 1,
          rule: 'sensitive_filename',
          message: `File name "${norm}" suggests sensitive credential or key material.`,
          fixable: false,
          hunk: `L1: (sensitive filename in diff)`
        });
      }
    }

    const ext = path.extname(norm).toLowerCase();
    const testFile = isTestFile(norm);
    const abs = path.join(projectRoot, norm);
    let exists = false;
    try { exists = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch (e) { exists = false; }
    if (!exists) continue;
    if (!SCANNABLE_EXTS.has(ext)) continue;
    if (testFile) continue;

    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const line = lines[i];
      if (/^\s*debugger\s*;?\s*$/.test(line)) {
        raw.push({
          severity: 'critical',
          path: `${norm}:${lineNum}`,
          file: norm,
          line: lineNum,
          rule: 'no_debugger_statements',
          message: `Found active "debugger;" statement at ${norm}:${lineNum}.`,
          fixable: true,
          hunk: buildHunk(lines, lineNum)
        });
      }
      if (/(?:\/\/\s*(?:TODO|FIXME)\b|\/\*\s*(?:TODO|FIXME)\b|#\s*(?:TODO|FIXME)\b|^\s*\*\s*(?:TODO|FIXME)\b)/.test(line)) {
        raw.push({
          severity: 'warning',
          path: `${norm}:${lineNum}`,
          file: norm,
          line: lineNum,
          rule: 'unresolved_todos',
          message: `Unresolved TODO/FIXME comment at ${norm}:${lineNum}.`,
          fixable: false,
          hunk: buildHunk(lines, lineNum)
        });
      }
      const hasUnrequestedMarker = /(?:\/\/\s*UNREQUESTED\b|\/\*\s*UNREQUESTED\b|#\s*UNREQUESTED\b|^\s*\*\s*UNREQUESTED\b)/i.test(line)
        || /(?:\/\/|#|\/\*|^\s*\*).*?@(?:unrequested|speculative)\b/i.test(line);
      if (hasUnrequestedMarker) {
        raw.push({
          severity: 'warning',
          path: `${norm}:${lineNum}`,
          file: norm,
          line: lineNum,
          rule: 'unrequested_scope_expansion',
          message: `Unrequested or speculative code marker at ${norm}:${lineNum}.`,
          fixable: false,
          hunk: buildHunk(lines, lineNum)
        });
      }
      const allowlisted = /pragma:\s*allowlist/i.test(line);
      if (!allowlisted) {
        for (const p of SECRET_PATTERNS) {
          if (p.regex.test(line)) {
            raw.push({
              severity: 'critical',
              path: `${norm}:${lineNum}`,
              file: norm,
              line: lineNum,
              rule: 'hardcoded_secret',
              message: `Possible committed ${p.name} at ${norm}:${lineNum} (value redacted).`,
              fixable: false,
              hunk: buildHunk(lines, lineNum)
            });
            break;
          }
        }
      }
    }

    const added = getAddedLines(projectRoot, base, norm);
    if (added > 300) {
      raw.push({
        severity: 'suggestion',
        path: `${norm}:1`,
        file: norm,
        line: 1,
        rule: 'oversized_diff',
        message: `File "${norm}" adds ${added} lines vs base; split into smaller surgical diffs.`,
        fixable: false,
        hunk: `(diff adds ${added} lines vs base)`
      });
    }
  }

  raw.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.rule < b.rule ? -1 : 1;
  });

  return raw.map((f, idx) => ({
    id: `CR-${String(idx + 1).padStart(3, '0')}`,
    severity: f.severity,
    path: f.path,
    file: f.file,
    line: f.line,
    rule: f.rule,
    message: f.message,
    fix: fixPrescription(f.rule, f.path),
    hunk: f.hunk,
    fixable: Boolean(f.fixable),
    status: 'open'
  }));
}

function applyAutoFixes(findings, projectRoot) {
  const fixedFiles = new Set();
  for (const finding of findings) {
    if (finding.rule === 'no_debugger_statements' && finding.fixable !== false) {
      const fullPath = path.join(projectRoot, finding.file || finding.path.split(':')[0]);
      if (fs.existsSync(fullPath)) {
        try {
          const text = fs.readFileSync(fullPath, 'utf8');
          const next = text.split('\n').filter(l => !/^\s*debugger\s*;?\s*$/.test(l)).join('\n');
          if (next !== text) {
            fs.writeFileSync(fullPath, next, 'utf8');
            fixedFiles.add(normalizePath(finding.file || finding.path.split(':')[0]));
          }
        } catch (e) {}
      }
    }
  }
  return Array.from(fixedFiles);
}

function defaultReportPath(projectRoot) {
  return path.join(projectRoot, '.sdw', 'state', 'code-review.report.md');
}

function writeMarkdownReport(report, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  let md = `# Code Review Report\n\n`;
  md += `- **Target Branch:** ${report.targetBranch || 'unknown'}\n`;
  md += `- **Base Branch:** ${report.base || 'unknown'} (source: ${report.baseSource || 'unknown'})\n`;
  md += `- **HEAD Commit:** ${report.head || 'uncommitted'}\n`;
  md += `- **Reviewed Files:** ${report.reviewedFiles.length}\n`;
  md += `- **Status:** ${report.passed ? 'PASSED' : 'FAILED'}${report.dryRun ? ' (dry-run)' : ''}\n`;
  md += `- **Generated At:** ${now}\n`;
  md += `- **Blocking (critical + warning):** ${report.blockingCount}\n`;
  md += `- **Fixed This Run:** ${report.fixedCount}\n\n`;

  if (report.reviewedFiles.length > 0) {
    md += `## Reviewed Scope\n\n`;
    for (const f of report.reviewedFiles) md += `- \`${f}\`\n`;
    md += `\n`;
  }

  md += `## Findings Summary\n\n`;
  if (report.findings.length === 0) {
    md += `No findings. Working tree and HEAD diffs are clean.\n\n`;
  } else {
    md += `| ID | Severity | Path | Rule | Status |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const f of report.findings) {
      md += `| ${f.id} | ${f.severity} | \`${f.path}\` | \`${f.rule}\` | ${f.status} |\n`;
    }
    md += `\n`;
  }

  if (report.findings.length > 0) {
    md += `## Detailed Findings\n\n`;
    for (const f of report.findings) {
      md += `### ${f.id} — ${f.rule} (${f.severity}) at \`${f.path}\` [${f.status}]\n\n`;
      md += `- **Location:** \`${f.path}\`\n`;
      md += `- **Rule:** \`${f.rule}\`\n`;
      md += `- **Severity:** ${f.severity} ${f.severity === 'suggestion' ? '(advisory)' : '(blocking)'}\n\n`;
      md += `Offending hunk:\n\n\`\`\`\n${f.hunk || '(unavailable)'}\n\`\`\`\n\n`;
      md += `Why it fails: ${f.message}\n\n`;
      md += `Fix prescription: ${f.fix}\n\n`;
    }
  }

  md += `## Fix Plan\n\n`;
  const open = report.findings.filter(f => f.status === 'open');
  const planned = report.findings.filter(f => f.status === 'planned');
  if (report.dryRun && planned.length > 0) {
    md += `Dry-run: no files were modified. Planned fixes:\n\n`;
    planned.forEach(f => { md += `- [ ] ${f.id} ${f.rule} at \`${f.path}\` — ${f.fix}\n`; });
    md += `\n`;
  } else if (open.length === 0) {
    md += `No action required. Advance to the next workflow step.\n`;
  } else {
    md += `Execute in order (surgical, one finding at a time):\n\n`;
    open.forEach(f => { md += `- [ ] ${f.id} (${f.severity}) \`${f.path}\` — ${f.fix}\n`; });
    md += `\nRe-run \`node "${normalizePath(__filename)}" run --json\` until blocking findings reach 0.\n`;
  }

  fs.writeFileSync(destPath, md, 'utf8');
  return destPath;
}

function runCodeReview(options) {
  const rawTarget = options.projectRoot || options.target || process.cwd();
  const projectRoot = path.resolve(rawTarget);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Invalid target directory: "${rawTarget}" does not exist or is not a directory.`);
  }

  const maxIterations = options.maxIterations || 3;
  const wantFix = Boolean(options.fix);
  const dryRun = Boolean(options.dryRun);

  const resolved = resolveBaseRef({ projectRoot, base: options.base });
  const { head, targetBranch } = getHeadInfo(projectRoot);
  const changedFiles = getChangedFiles({ projectRoot, base: resolved.base });

  let findings = analyzeChangedFiles(projectRoot, resolved.base, changedFiles);
  let fixedFiles = [];
  let fixedRecords = [];
  let plannedFixes = [];

  if (wantFix && dryRun) {
    plannedFixes = findings.filter(f => f.fixable && f.status === 'open');
    findings = findings.map(f => (f.fixable ? { ...f, status: 'planned' } : f));
  } else if (wantFix && !dryRun) {
    let iterations = 0;
    const fixedAcc = [];
    while (iterations < maxIterations) {
      const fixable = findings.filter(f => f.fixable && f.status === 'open');
      const blocking = findings.filter(f => (f.severity === 'critical' || f.severity === 'warning') && f.status === 'open');
      if (blocking.length === 0) break;
      if (fixable.length === 0) break;
      iterations++;
      const fixed = applyAutoFixes(fixable, projectRoot);
      if (fixed.length === 0) break;
      fixed.forEach(f => { if (!fixedFiles.includes(f)) fixedFiles.push(f); });
      fixable.forEach(f => { fixedAcc.push({ ...f, status: 'fixed' }); });
      findings = analyzeChangedFiles(projectRoot, resolved.base, getChangedFiles({ projectRoot, base: resolved.base }));
    }
    fixedRecords = fixedAcc;
  }

  const openFindings = findings.filter(f => f.status === 'open');
  const criticalOpen = openFindings.filter(f => f.severity === 'critical').length;
  const warningOpen = openFindings.filter(f => f.severity === 'warning').length;
  const suggestionOpen = openFindings.filter(f => f.severity === 'suggestion').length;
  const blockingCount = criticalOpen + warningOpen;
  const passed = blockingCount === 0;

  const seenFindingKeys = new Set();
  const allFindings = [...openFindings, ...fixedRecords]
    .filter(f => {
      const key = `${f.file}:${f.line}:${f.rule}`;
      if (seenFindingKeys.has(key)) return false;
      seenFindingKeys.add(key);
      return true;
    })
    .sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.rule < b.rule ? -1 : 1;
    })
    .map((f, index) => ({ ...f, id: `CR-${String(index + 1).padStart(3, '0')}` }));
  const plannedAll = findings.filter(f => f.status === 'planned');
  const reportFindings = dryRun ? findings : allFindings;

  let reportPath = options.reportPath || options.report || null;
  if (reportPath) {
    reportPath = path.isAbsolute(reportPath) ? reportPath : path.resolve(projectRoot, reportPath);
  } else if (!dryRun) {
    reportPath = defaultReportPath(projectRoot);
  }

  const report = {
    passed,
    base: resolved.base,
    baseSource: resolved.source,
    head,
    targetBranch,
    reviewedFiles: changedFiles,
    reviewedCount: changedFiles.length,
    errorCount: criticalOpen,
    criticalCount: criticalOpen,
    warningCount: warningOpen,
    suggestionCount: suggestionOpen,
    blockingCount,
    fixedCount: fixedFiles.length,
    fixedFiles,
    plannedFixes: plannedAll.map(f => f.id),
    findings: reportFindings,
    reportPath: reportPath ? normalizePath(path.relative(projectRoot, reportPath) || reportPath) : null,
    reportAbsPath: reportPath || null,
    dryRun
  };

  if (reportPath) {
    writeMarkdownReport(report, reportPath);
  }
  return report;
}

function cmdDoctor(options) {
  const root = path.resolve((options && (options.root || options.target)) || findProjectRoot());
  const checks = [];
  const skillDir = path.join(root, 'skills', 'sdw-code-review');
  checks.push({ name: 'skill_dir', passed: fs.existsSync(skillDir), detail: normalizePath(skillDir) });
  checks.push({ name: 'skill_md', passed: fs.existsSync(path.join(skillDir, 'SKILL.md')), detail: 'SKILL.md' });
  checks.push({ name: 'reference', passed: fs.existsSync(path.join(skillDir, 'references', 'code_review_rules.md')), detail: 'references/code_review_rules.md' });
  checks.push({ name: 'script', passed: fs.existsSync(path.join(skillDir, 'scripts', 'sdw_code_review.cjs')), detail: 'scripts/sdw_code_review.cjs' });
  let gitOk = false;
  try {
    execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    gitOk = true;
  } catch (e) { gitOk = false; }
  checks.push({ name: 'git_available', passed: gitOk, detail: 'git --version' });
  const cfgPath = path.join(root, '.sdw', 'config.json');
  checks.push({ name: 'config_readable', passed: !fs.existsSync(cfgPath) || (() => { try { JSON.parse(fs.readFileSync(cfgPath, 'utf8')); return true; } catch (e) { return false; } })(), detail: '.sdw/config.json' });
  const passed = checks.every(c => c.passed);
  return { passed, root: normalizePath(root), checks };
}

function showHelp() {
  console.log(`Spec-Driven Workflow — Code Review CLI (sdw-code-review)

Usage:
  node sdw_code_review.cjs <run|fix|doctor> [options]

Subcommands:
  run                    Review working tree and HEAD diffs against base (default)
  fix                    Review with surgical auto-fixes up to iteration ceiling
  doctor                 Validate skill integrity, git availability, and config

Options:
  --base <ref>           Explicit base Git ref (default: auto-detect)
  --target <path>        Target project root (alias: --root)
  --report <path>        Markdown report destination (default: .sdw/state/code-review.report.md)
  --fix                  Apply surgical auto-fixes for fixable findings
  --no-fix               Disable auto-fixes (default for run)
  --dry-run              Simulate analysis and planned fixes without file writes
  --json                 Output structured JSON report on stdout
  --max-iterations <n>   Auto-fix iteration ceiling (default: 3, max: 10)
  -h, --help             Show this help message
`);
}

function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.help || args.includes('help') && opts.subcommand === 'run' && args.length === 1) {
    showHelp();
    process.exit(0);
  }

  if (opts.subcommand === 'doctor') {
    const report = cmdDoctor({ root: opts.target });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[sdw-code-review doctor] ${report.passed ? 'ALL CHECKS PASSED' : 'CHECKS FAILED'}`);
      report.checks.forEach(c => console.log(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`));
    }
    process.exit(report.passed ? 0 : 1);
  }

  const targetRoot = opts.target ? path.resolve(opts.target) : findProjectRoot();
  if (opts.target && (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory())) {
    const msg = `Invalid target directory: "${opts.target}" does not exist or is not a directory.`;
    if (opts.json) {
      console.log(JSON.stringify({ passed: false, error: msg, findings: [], errorCount: 0, warningCount: 0, suggestionCount: 0 }, null, 2));
    } else {
      console.error(`[sdw-code-review] Error: ${msg}`);
    }
    process.exit(1);
  }

  const log = opts.json ? console.error : console.log;
  try {
    log(`[sdw-code-review] Comparing working tree and HEAD against base '${opts.base || 'auto'}'...`);
    const report = runCodeReview({
      projectRoot: targetRoot,
      base: opts.base,
      report: opts.report,
      fix: opts.fix,
      dryRun: opts.dryRun,
      maxIterations: opts.maxIterations
    });
    if (opts.dryRun && opts.fix) {
      log(`[sdw-code-review] (dry-run) Would apply ${report.plannedFixes.length} fix(es); no files modified.`);
    }
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.reportAbsPath) {
        log(`[sdw-code-review] Report written to ${report.reportPath}`);
      } else {
        log('[sdw-code-review] (dry-run) Report not written; no files modified.');
      }
      if (report.passed) {
        const total = report.findings.filter(f => f.status === 'open').length;
        if (total === 0) log('[sdw-code-review] Code review passed with 0 findings.');
        else log(`[sdw-code-review] Code review passed with ${report.suggestionCount} advisory suggestion(s).`);
      } else {
        log(`[sdw-code-review] Code review failed with ${report.blockingCount} blocking error(s).`);
      }
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ passed: false, error: err.message, findings: [], errorCount: 0, warningCount: 0, suggestionCount: 0 }, null, 2));
    } else {
      console.error(`[sdw-code-review] Error: ${err.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  findProjectRoot,
  parseArgs,
  loadProjectConfig,
  resolveBaseRef,
  resolveBase: resolveBaseRef,
  getChangedFiles,
  getFilesToReview: getChangedFiles,
  analyzeChangedFiles,
  applyAutoFixes,
  runCodeReview,
  runAutomatedReview: (options) => {
    const projectRoot = (options && options.projectRoot) || process.cwd();
    const base = (options && (options.base || options.baseCommit)) || null;
    try {
      const resolved = base ? { base, source: 'explicit' } : resolveBaseRef({ projectRoot });
      const files = getChangedFiles({ projectRoot, base: resolved.base });
      const detailed = analyzeChangedFiles(projectRoot, resolved.base, files);
      const errorCount = detailed.filter(f => f.severity === 'critical').length;
      const warningCount = detailed.filter(f => f.severity === 'warning').length;
      return {
        passed: errorCount === 0 && warningOpenCompat(detailed),
        errorCount,
        warningCount,
        totalFindings: detailed.length,
        findings: detailed.map(d => ({ file: d.file, severity: d.severity === 'critical' ? 'error' : d.severity, rule: d.rule, message: d.message, fixable: d.fixable })),
        summary: errorCount === 0 ? 'Code review passed.' : `Code review failed with ${errorCount} blocking errors.`
      };
    } catch (e) {
      return { passed: false, errorCount: 1, warningCount: 0, totalFindings: 1, findings: [], summary: e.message, error: e.message };
    }
  },
  writeMarkdownReport,
  cmdDoctor,
  defaultReportPath,
  SECRET_PATTERNS
};

function warningOpenCompat(detailed) {
  return detailed.filter(f => f.severity === 'warning').length === 0;
}
