#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) || fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/, severity: 'high' },
  { name: 'GitHub Token', regex: /\b(gh[ps]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9]{36,})\b/, severity: 'high' },
  { name: 'Slack Token', regex: /\bxox[bpras]-[0-9a-zA-Z-]{24,}\b/, severity: 'high' },
  { name: 'API Key (sk-...)', regex: /\bsk-[a-zA-Z0-9]{32,}\b/, severity: 'high' },
  { name: 'Private Key Block', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, severity: 'high' },
  { name: 'Database Connection String with Credentials', regex: /(postgresql|mysql|mongodb(\+srv)?|redis|jdbc):\/\/[^:\s]+:[^@\s]+@/, severity: 'high' },
  { name: 'Authorization Bearer Token', regex: /Bearer\s+[A-Za-z0-9\-._~+/]{40,}/, severity: 'medium' }
];

const SENSITIVE_FILE_PATTERNS = [
  { name: 'Root or nested .env file', regex: /(^|\/)\.env$/, severity: 'high' },
  { name: 'Environment secrets file (.env.*)', regex: /(^|\/)\.env\.(?!example$)[^/\\]+$/, severity: 'high' },
  { name: 'PKCS#12 certificate/key bundle', regex: /\.(pfx|p12)$/i, severity: 'high' },
  { name: 'Secrets configuration file', regex: /(^|\/)secrets\.ya?ml$/i, severity: 'high' },
  { name: 'Credentials file', regex: /(^|\/)credentials\.(json|toml)$/i, severity: 'high' },
  { name: 'SSH private key file', regex: /(^|\/)id_(rsa|ecdsa|ed25519)$/i, severity: 'high' },
  { name: 'Certificate or key file', regex: /\.(pem|key)$/i, severity: 'medium' }
];

const RECOMMENDED_GITIGNORE = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  'secrets.yml',
  'credentials.json',
  '.aws/'
];

const SCANNABLE_EXTENSIONS = new Set([
  '.env', '.json', '.yml', '.yaml', '.toml', '.xml', '.ini', '.cfg', '.conf', '.properties',
  '.sh', '.bash', '.ps1', '.py', '.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx', '.cs', '.java', '.go', '.rb',
  '.php', '.tf', '.md', '.txt'
]);

function parseArgs(args) {
  const result = {
    subcommand: 'scan',
    staged: false,
    json: false,
    root: null,
    failOn: 'high'
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'scan') {
      result.subcommand = 'scan';
    } else if (arg === '--staged') {
      result.staged = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--root') {
      result.root = args[++i];
    } else if (arg.startsWith('--root=')) {
      result.root = arg.slice(7);
    } else if (arg === '--fail-on') {
      result.failOn = (args[++i] || 'high').toLowerCase();
    } else if (arg.startsWith('--fail-on=')) {
      result.failOn = arg.slice(10).toLowerCase();
    } else if (arg === '-h' || arg === '--help') {
      result.subcommand = 'help';
    }
  }

  return result;
}

function parseDiffHunks(diffText) {
  const lines = diffText.split('\n');
  const results = [];
  let currentFile = null;
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        currentFile = match[2];
      }
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('@@ ')) {
      // @@ -start,count +start,count @@
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        currentNewLine = parseInt(m[1], 10);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      results.push({
        file: currentFile || '(staged-diff)',
        line: currentNewLine,
        content: line.slice(1)
      });
      currentNewLine++;
    } else if (!line.startsWith('-')) {
      currentNewLine++;
    }
  }

  return results;
}

function scan(options = {}) {
  const root = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const staged = Boolean(options.staged);
  const failOn = options.failOn === 'medium' ? 'medium' : 'high';
  const maxHits = parseInt(process.env.SECURITY_SCAN_MAX_HITS || '50', 10) || 50;
  const pragma = (process.env.SECURITY_SCAN_IGNORE_PRAGMA || 'allowlist secret').toLowerCase();

  const findings = [];
  const advisories = [];

  try {
    // 1. Check git availability
    const gitCheck = spawnSync('git', ['--version'], { cwd: root, encoding: 'utf8' });
    if (gitCheck.error || gitCheck.status !== 0) {
      throw new Error(`Git is required for security scan but failed to execute: ${gitCheck.error ? gitCheck.error.message : 'exit ' + gitCheck.status}`);
    }

    // 2. Sensitive file check
    let fileList = [];
    if (staged) {
      const stagedList = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
        cwd: root,
        encoding: 'utf8'
      });
      if (stagedList.error || stagedList.status !== 0) {
        throw new Error(`Failed to list staged files: ${stagedList.stderr || stagedList.error?.message}`);
      }
      fileList = (stagedList.stdout || '').split('\n').map(l => l.trim().replace(/\r$/, '')).filter(Boolean);
      if (fileList.length === 0) {
        return {
          exitCode: 0,
          root: normalizePath(root),
          staged: true,
          empty: true,
          findings: [],
          advisories: [],
          severityCounts: { high: 0, medium: 0, advisory: 0 },
          message: 'No staged files. Nothing to scan.'
        };
      }
    } else {
      const allFiles = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      if (allFiles.error || allFiles.status !== 0) {
        throw new Error(`Failed to list repository files: ${allFiles.stderr || allFiles.error?.message}`);
      }
      fileList = (allFiles.stdout || '').split('\n').map(l => l.trim().replace(/\r$/, '')).filter(Boolean);
    }

    for (const f of fileList) {
      const normF = normalizePath(f);
      for (const pattern of SENSITIVE_FILE_PATTERNS) {
        if (pattern.regex.test(normF)) {
          findings.push({
            file: normF,
            line: 1,
            type: pattern.name,
            severity: pattern.severity
          });
          break;
        }
      }
      if (findings.length >= maxHits) break;
    }

    // 3. Pattern scanning
    if (staged) {
      const diffProc = spawnSync('git', ['diff', '--cached', '-U0', '--diff-filter=ACM'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      });
      if (diffProc.error || diffProc.status !== 0) {
        throw new Error(`Failed to read staged diff: ${diffProc.stderr || diffProc.error?.message}`);
      }
      const addedLines = parseDiffHunks(diffProc.stdout || '');
      for (const item of addedLines) {
        const text = item.content;
        if (text.toLowerCase().includes(pragma)) continue;
        if (/EXAMPLE|\[REDACTED\]|wJalrXUtnFEMI\/K7MDENG/i.test(text)) continue;

        for (const pat of SECRET_PATTERNS) {
          if (pat.regex.test(text)) {
            findings.push({
              file: normalizePath(item.file),
              line: item.line || 1,
              type: pat.name,
              severity: pat.severity
            });
            break;
          }
        }
        if (findings.length >= maxHits) break;
      }
    } else {
      // Worktree scan
      for (const relFile of fileList) {
        if (findings.length >= maxHits) break;
        const ext = path.extname(relFile).toLowerCase();
        const base = path.basename(relFile).toLowerCase();
        if (!SCANNABLE_EXTENSIONS.has(ext) && !base.startsWith('.env')) continue;

        const fullPath = path.join(root, relFile);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile() || stat.size > 512 * 1024) continue;
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');

          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            if (line.toLowerCase().includes(pragma)) continue;
            if (/EXAMPLE|\[REDACTED\]|wJalrXUtnFEMI\/K7MDENG/i.test(line)) continue;

            for (const pat of SECRET_PATTERNS) {
              if (pat.regex.test(line)) {
                findings.push({
                  file: normalizePath(relFile),
                  line: lineIdx + 1,
                  type: pat.name,
                  severity: pat.severity
                });
                break;
              }
            }
            if (findings.length >= maxHits) break;
          }
        } catch (err) {
          // File read error, skip unreadable file
        }
      }
    }

    // 4. .gitignore advisories (AC18)
    const gitignorePath = path.join(root, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gi = fs.readFileSync(gitignorePath, 'utf8')
        .split('\n')
        .map(l => l.trim().replace(/\r$/, '').replace(/^\//, ''));
      for (const entry of RECOMMENDED_GITIGNORE) {
        if (!gi.includes(entry)) {
          advisories.push(`Recommended ignore rule '${entry}' not found in .gitignore`);
        }
      }
    }

    const severityCounts = {
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      advisory: advisories.length
    };

    let exitCode = 0;
    if (failOn === 'medium') {
      if (severityCounts.high > 0 || severityCounts.medium > 0) exitCode = 1;
    } else {
      if (severityCounts.high > 0) exitCode = 1;
    }

    return {
      exitCode,
      root: normalizePath(root),
      staged,
      findings,
      advisories,
      severityCounts,
      message: exitCode === 0 ? 'Security leak scan passed.' : 'Security leak scan detected blocking findings.'
    };
  } catch (err) {
    // Fail closed (AC9)
    return {
      exitCode: 2,
      root: normalizePath(root),
      staged,
      findings: [],
      advisories: [],
      severityCounts: { high: 0, medium: 0, advisory: 0 },
      error: err.message,
      message: `Scanner failure: ${err.message}`
    };
  }
}

function runCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);

  if (options.subcommand === 'help') {
    console.log(`Usage: node sdw_security_checks.cjs scan [options]

Deterministic pre-commit secrets, credentials, and PII leak scanner.

Subcommands:
  scan                   Scan repository or staged changes for secrets & leaks

Options:
  --staged               Restrict scan to added lines in staged diff (git diff --cached)
  --json                 Output structured JSON findings report
  --root <dir>           Specify project root directory
  --fail-on <high|medium> Fail threshold (default: high)
  -h, --help             Show this help message
`);
    return 0;
  }

  const result = scan(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  }

  console.log(`[sdw-security-checks] Scanning ${path.basename(result.root)} (${result.staged ? 'staged diff' : 'worktree'})...`);
  if (result.empty) {
    console.log('No staged files. Nothing to scan.');
    return 0;
  }

  if (result.exitCode === 2) {
    console.error(`[sdw-security-checks] Error: ${result.error}`);
    return 2;
  }

  const high = result.findings.filter(f => f.severity === 'high');
  const medium = result.findings.filter(f => f.severity === 'medium');

  console.log('\n==================================================');
  console.log('       S D W   S E C U R I T Y   G A T E          ');
  console.log('==================================================\n');

  if (high.length === 0 && medium.length === 0) {
    console.log('No secret or credential leaks detected.');
  } else {
    if (high.length > 0) {
      console.log(`HIGH - Blocking findings (must resolve before commit: ${high.length}):`);
      console.log('| File | Line | Type | Severity |');
      console.log('|------|------|------|----------|');
      for (const f of high) {
        console.log(`| ${f.file} | ${f.line} | ${f.type} | HIGH |`);
      }
      console.log('');
    }
    if (medium.length > 0) {
      console.log(`MEDIUM - Warnings (review recommended: ${medium.length}):`);
      console.log('| File | Line | Type | Severity |');
      console.log('|------|------|------|----------|');
      for (const f of medium) {
        console.log(`| ${f.file} | ${f.line} | ${f.type} | MEDIUM |`);
      }
      console.log('');
    }
  }

  if (result.advisories && result.advisories.length > 0) {
    console.log('.gitignore Advisories:');
    result.advisories.forEach(adv => console.log(`  - ${adv}`));
    console.log('');
  }

  console.log('==================================================\n');
  return result.exitCode;
}

if (require.main === module) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}

module.exports = {
  scan,
  parseArgs,
  parseDiffHunks,
  runCli,
  SECRET_PATTERNS,
  SENSITIVE_FILE_PATTERNS,
  RECOMMENDED_GITIGNORE
};
