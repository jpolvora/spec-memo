#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const builtinModules = require('module').builtinModules;

const ALLOWED_BUILTINS = new Set(builtinModules.map(m => m.replace(/^node:/, '')));

const EXPECTED_SKILLS = [
  'sdw-batch',
  'sdw-changelog',
  'sdw-code-review',
  'sdw-config',
  'sdw-doctor',
  'sdw-fixer',
  'sdw-memory',
  'sdw-run',
  'sdw-retro',
  'sdw-router',
  'sdw-rules',
  'sdw-security-checks',
  'sdw-ship-pr',
  'sdw-spec'
];

const CORE_SKILLS = ['sdw-config', 'sdw-run', 'sdw-router', 'sdw-rules', 'sdw-spec'];

const SKILL_LINE_LIMIT = 120;
const RULES_LINE_LIMIT = 80;
const REQUIRED_FRONTMATTER = ['name', 'description', 'version', 'invocation_names'];

const INSTALL_REMEDIATION = [
  'npx skills add jpolvora/spec-driven-workflow -y',
  'npx skills update'
];

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function finding(level, code, subject, message) {
  return { level, code, subject, message };
}

function countErrors(findings) {
  return findings.filter(f => f.level === 'error').length;
}

function countWarnings(findings) {
  return findings.filter(f => f.level === 'warning').length;
}

function parseFrontmatter(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const values = {};
  let currentList = null;
  for (const raw of match[1].split('\n')) {
    const listItem = raw.match(/^\s*-\s+(.+)$/);
    if (listItem && currentList) {
      values[currentList].push(listItem[1].trim());
      continue;
    }
    const item = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!item) continue;
    const key = item[1];
    const value = item[2].trim().replace(/^['"]|['"]$/g, '');
    if (value === '') {
      values[key] = [];
      currentList = key;
    } else {
      values[key] = value;
      currentList = null;
    }
  }
  return values;
}

function listSdwSkills(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(name => name.startsWith('sdw-') && fs.existsSync(path.join(dir, name, 'SKILL.md')))
      .sort();
  } catch (e) {
    return [];
  }
}

function hasSdwSkills(dir) {
  return listSdwSkills(dir).length > 0;
}

function readSkill(skillDir) {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  return fs.readFileSync(skillMd, 'utf8');
}

function collectRelativeLinks(content) {
  const links = new Set();
  const re = /\]\(([^)\s]+)\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (target) links.add(target);
  }
  return [...links];
}

function scanRequires(code) {
  const found = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(code)) !== null) found.push(match[1]);
  return found;
}

function checkSkill(skillDir, skillName, findings) {
  const relative = `skills/${skillName}`;
  const content = readSkill(skillDir);
  if (content === null) {
    findings.push(finding('error', 'skill-entry-missing', skillName, `Missing Tier 1 entrypoint: ${relative}/SKILL.md`));
    return;
  }

  const lines = content.split(/\r?\n/);
  const limit = skillName === 'sdw-rules' ? RULES_LINE_LIMIT : SKILL_LINE_LIMIT;
  if (lines.length > limit) {
    findings.push(finding('error', 'skill-line-budget', skillName, `${relative}/SKILL.md has ${lines.length} lines (limit ${limit})`));
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    findings.push(finding('error', 'skill-frontmatter', skillName, `${relative}/SKILL.md has no valid YAML frontmatter`));
  } else {
    for (const key of REQUIRED_FRONTMATTER) {
      const value = fm[key];
      const missing = Array.isArray(value) ? value.length === 0 : !value;
      if (missing) {
        findings.push(finding('error', 'skill-frontmatter-key', skillName, `Missing frontmatter key "${key}" in ${relative}/SKILL.md`));
      }
    }
    if (fm.name && fm.name !== skillName) {
      findings.push(finding('error', 'skill-name-mismatch', skillName, `Frontmatter name "${fm.name}" does not match directory "${skillName}"`));
    }
  }

  if (!/>\s*When this skill is loaded,\s*output/i.test(content)) {
    findings.push(finding('error', 'skill-announcement', skillName, `${relative}/SKILL.md is missing the load announcement line`));
  }

  if (skillName !== 'sdw-rules' && !content.includes('sdw-rules')) {
    findings.push(finding('error', 'skill-rules-reference', skillName, `${relative}/SKILL.md does not reference sdw-rules`));
  }

  for (const link of collectRelativeLinks(content)) {
    const target = path.resolve(skillDir, link);
    if (!fs.existsSync(target)) {
      findings.push(finding('error', 'skill-link-missing', skillName, `Broken link "${link}" in ${relative}/SKILL.md`));
    }
  }

  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    for (const script of fs.readdirSync(scriptsDir).filter(name => name.endsWith('.cjs'))) {
      const scriptPath = path.join(scriptsDir, script);
      const code = fs.readFileSync(scriptPath, 'utf8');
      const syntax = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
      if (syntax.status !== 0) {
        findings.push(finding('error', 'skill-script-syntax', skillName, `${relative}/scripts/${script} fails "node --check": ${(syntax.stderr || '').trim().split('\n')[0]}`));
      }
      for (const required of scanRequires(code)) {
        if (required.startsWith('.') || required.startsWith('/') || required.startsWith('node:')) continue;
        const bare = required.split('/')[0];
        if (!ALLOWED_BUILTINS.has(bare)) {
          findings.push(finding('error', 'skill-script-dependency', skillName, `${relative}/scripts/${script} requires external module "${required}"`));
        }
      }
    }
  }
}

function checkSkillsRoot(skillsRoot, findings) {
  const present = listSdwSkills(skillsRoot);
  for (const expected of EXPECTED_SKILLS) {
    if (!present.includes(expected)) {
      findings.push(finding('error', 'skill-missing', expected, `Skill "${expected}" is not installed under ${toPosix(skillsRoot)}`));
    }
  }
  for (const skillName of present) {
    checkSkill(path.join(skillsRoot, skillName), skillName, findings);
  }
  return present;
}

function quickCheckGlobal(globalRoot, findings) {
  if (!globalRoot || !fs.existsSync(globalRoot)) {
    findings.push(finding('error', 'global-root-missing', '(global)', `Global skills root not found: ${toPosix(globalRoot || '(none)')}`));
    return false;
  }
  const present = listSdwSkills(globalRoot);
  if (present.length === 0) {
    findings.push(finding('error', 'global-skills-missing', '(global)', `No SDW skills found under ${toPosix(globalRoot)}`));
    return false;
  }
  for (const core of CORE_SKILLS) {
    if (!present.includes(core)) {
      findings.push(finding('error', 'global-skill-missing', core, `Global installation is missing core skill "${core}"`));
    }
  }
  for (const skillName of present) {
    const content = readSkill(path.join(globalRoot, skillName));
    if (content === null) {
      findings.push(finding('error', 'global-skill-unreadable', skillName, `Global skill "${skillName}" has no readable SKILL.md`));
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name || !fm.version) {
      findings.push(finding('warning', 'global-skill-frontmatter', skillName, `Global skill "${skillName}" has incomplete frontmatter`));
    }
  }
  return true;
}

function checkWorkspace(root, findings) {
  const sdwDir = path.join(root, '.sdw');
  if (!fs.existsSync(sdwDir)) {
    findings.push(finding('warning', 'workspace-missing', '.sdw', `No .sdw workspace at ${toPosix(sdwDir)}; project configuration checks skipped`));
    return;
  }

  const configPath = path.join(sdwDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    findings.push(finding('error', 'workspace-config-missing', '.sdw/config.json', 'Missing .sdw/config.json'));
  } else {
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      findings.push(finding('error', 'workspace-config-json', '.sdw/config.json', `Invalid JSON: ${e.message}`));
    }
    if (config) {
      let validator = null;
      try {
        validator = require('../../sdw-config/scripts/sdw_config.cjs');
      } catch (e) {
        validator = null;
      }
      if (validator && typeof validator.validateConfigSchema === 'function') {
        const result = validator.validateConfigSchema(config);
        for (const error of result.errors || []) {
          findings.push(finding('error', 'workspace-config-schema', '.sdw/config.json', error));
        }
      } else {
        findings.push(finding('warning', 'workspace-config-validator', '.sdw/config.json', 'sdw-config is unavailable; schema validation skipped'));
      }
    }
  }

  for (const required of ['config.schema.json', 'directory-structure.md', 'specs/index.specs.md']) {
    if (!fs.existsSync(path.join(sdwDir, required))) {
      findings.push(finding('error', 'workspace-file-missing', `.sdw/${required}`, `Missing .sdw/${required}`));
    }
  }

  const specsDir = path.join(sdwDir, 'specs');
  if (!fs.existsSync(specsDir)) {
    findings.push(finding('error', 'workspace-specs-missing', '.sdw/specs', 'Missing .sdw/specs directory'));
    return;
  }

  const specFiles = fs.readdirSync(specsDir).filter(name => /^\d{5}-.*\.md$/.test(name)).sort();
  const index = fs.existsSync(path.join(specsDir, 'index.specs.md'))
    ? fs.readFileSync(path.join(specsDir, 'index.specs.md'), 'utf8')
    : '';
  const registered = [...index.matchAll(/^\|\s*\d{5}\s*\|\s*([^|]+?)\s*\|/gm)].map(m => m[1].trim());

  for (const row of registered) {
    if (!fs.existsSync(path.join(specsDir, `${row}.md`))) {
      findings.push(finding('error', 'spec-file-missing', row, `Registry row "${row}" has no specification file`));
    }
  }
  for (const file of specFiles) {
    const slug = file.replace(/\.md$/, '');
    if (!registered.includes(slug)) {
      findings.push(finding('warning', 'spec-unregistered', slug, `Specification "${slug}" is not registered in index.specs.md`));
    }
  }

  let validateFile = null;
  try {
    validateFile = require('../../sdw-spec/scripts/validate_spec.cjs').validateFile;
  } catch (e) {
    validateFile = null;
  }
  if (!validateFile) {
    findings.push(finding('warning', 'spec-validator-missing', '.sdw/specs', 'sdw-spec is unavailable; specification validation skipped'));
    return;
  }
  for (const file of specFiles) {
    try {
      const result = validateFile(path.join(specsDir, file), { mode: 'authoring' });
      if (!result.ok) {
        const first = (result.errors && result.errors[0] && result.errors[0].message) || 'validation failed';
        findings.push(finding('error', 'spec-invalid', file, `${file}: ${first}`));
      }
    } catch (e) {
      findings.push(finding('error', 'spec-unreadable', file, `${file}: ${e.message}`));
    }
  }
}

function isUpstreamRoot(root, skillsDir) {
  if (listSdwSkills(skillsDir).length < 3) return false;
  if (fs.existsSync(path.join(root, 'scripts', 'verify_skills.cjs'))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'spec-driven-workflow';
  } catch (e) {
    return false;
  }
}

function detectInstallation(root, homeDir) {
  const canonicalRoot = path.join(root, 'skills');
  const projectRoot = path.join(root, '.agents', 'skills');
  const globalRoot = path.join(homeDir || os.homedir(), '.agents', 'skills');

  if (isUpstreamRoot(root, canonicalRoot)) {
    return { mode: 'upstream', skillsRoot: canonicalRoot, globalRoot: null };
  }
  if (hasSdwSkills(projectRoot)) {
    return { mode: 'consumer-local', skillsRoot: projectRoot, globalRoot: null };
  }
  if (hasSdwSkills(globalRoot)) {
    const hasWorkspace = fs.existsSync(path.join(root, '.sdw', 'config.json'));
    return { mode: hasWorkspace ? 'hybrid' : 'consumer-global', skillsRoot: globalRoot, globalRoot };
  }
  return { mode: 'missing', skillsRoot: null, globalRoot: null };
}

function buildRemediation(mode, findings) {
  const codes = new Set(findings.filter(f => f.level === 'error').map(f => f.code));
  const installErrors = [...codes].some(code => code.startsWith('skill-') || code.startsWith('installation-') || code.startsWith('global-'));
  const configErrors = [...codes].some(code => code.startsWith('workspace-config'));
  const specErrors = [...codes].some(code => code.startsWith('spec-'));
  const lines = [];

  if (mode === 'upstream') {
    if (installErrors) {
      lines.push('Fix the canonical source under skills/, then re-run: node scripts/verify_skills.cjs verify');
    }
  } else if (mode === 'missing' || installErrors) {
    lines.push(...INSTALL_REMEDIATION);
  }

  if (configErrors) {
    lines.push('Complete the workspace configuration with: node skills/sdw-config/scripts/sdw_config.cjs init');
    lines.push('Then verify it with: node skills/sdw-config/scripts/sdw_config.cjs check');
  }

  if (specErrors) {
    lines.push('Repair the registry and specifications with: node skills/sdw-spec/scripts/sdw_spec.cjs sync');
    lines.push('Validate one specification with: node skills/sdw-spec/scripts/validate_spec.cjs --mode=authoring <specPath>');
  }

  if (lines.length > 0) {
    lines.push('Stop: repair the installation and configuration before invoking another SDW skill.');
  }
  return lines;
}

function runDoctor(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const installation = detectInstallation(root, options.homeDir);
  const findings = [];

  if (installation.mode === 'missing') {
    findings.push(finding('error', 'installation-missing', '(install)',
      `No SDW skills found in ${toPosix(path.join(root, 'skills'))}, ${toPosix(path.join(root, '.agents', 'skills'))}, or the global skills root`));
  } else {
    checkSkillsRoot(installation.skillsRoot, findings);
    if (installation.mode === 'hybrid' || installation.mode === 'consumer-global') {
      quickCheckGlobal(installation.globalRoot, findings);
    }
    checkWorkspace(root, findings);
  }

  const errors = findings.filter(f => f.level === 'error');
  const remediation = buildRemediation(installation.mode, findings);

  return {
    ok: errors.length === 0,
    mode: installation.mode,
    root: toPosix(root),
    skillsRoot: installation.skillsRoot ? toPosix(installation.skillsRoot) : null,
    globalRoot: installation.globalRoot ? toPosix(installation.globalRoot) : null,
    presentSkills: installation.skillsRoot ? listSdwSkills(installation.skillsRoot) : [],
    expectedSkills: EXPECTED_SKILLS,
    findings,
    errors: errors.length,
    warnings: findings.filter(f => f.level === 'warning').length,
    remediation
  };
}

function findSmokeState(root) {
  const sandboxDir = path.join(root, '.sdw', 'sandbox');
  if (!fs.existsSync(sandboxDir)) return null;
  let newest = null;
  for (const entry of fs.readdirSync(sandboxDir)) {
    const stateDir = path.join(sandboxDir, entry, 'repo', '.sdw', 'state');
    if (!fs.existsSync(stateDir)) continue;
    for (const file of fs.readdirSync(stateDir).filter(name => name.endsWith('.state.json'))) {
      const full = path.join(stateDir, file);
      const stat = fs.statSync(full);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: stat.mtimeMs };
    }
  }
  if (!newest) return null;
  try {
    return JSON.parse(fs.readFileSync(newest.file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function smokeSuggestions(text) {
  const suggestions = [];
  if (/No valid skills directory|Cannot find module/i.test(text)) {
    suggestions.push('Reinstall the skills: npx skills add jpolvora/spec-driven-workflow -y');
  }
  if (/Specification file not found/i.test(text)) {
    suggestions.push('Verify specsDir and the smoke spec path, then run sdw-spec sync.');
  }
  if (/Evidence validation failed|None of the files listed/i.test(text)) {
    suggestions.push('Inspect the evidence contract: the smoke worker must write status, acIds, and a filesChanged entry that changed during the run.');
  }
  if (/Verification Gate|Tests failed|Test verification failed/i.test(text)) {
    suggestions.push('Run the configured verification command manually and fix the failing gate.');
  }
  if (/Conformance score below|reimplementation_needed/i.test(text)) {
    suggestions.push('Inspect step-5-judge.verdict.json; the smoke judge verifies every acceptance criterion.');
  }
  if (/sandbox creation failed|git clone/i.test(text)) {
    suggestions.push('Verify git is installed and the project is a git repository with at least one commit.');
  }
  if (suggestions.length === 0) {
    suggestions.push('Inspect the sandbox report and the run state, then run sdw-doctor check.');
  }
  return suggestions;
}

function buildIssueReport(result) {
  const lines = [
    `sdw-doctor sandbox smoke test failed (mode: ${result.mode}).`,
    '',
    `- Project root: ${result.projectRoot}`,
    `- Skills root: ${result.skillsRoot}`,
    `- Exit code: ${result.exitCode}`,
    `- Run id: ${result.runId || '(none)'}`,
    `- State status: ${result.stateStatus || '(none)'}`,
    `- Node: ${process.version} (${process.platform}/${process.arch})`,
    '',
    '## Captured errors',
    ''
  ];
  if (result.errors.length === 0) lines.push('- (no structured errors; see output tail)');
  for (const error of result.errors.slice(-20)) lines.push(`- [step ${error.step || '?'}] ${error.error}`);
  lines.push('', '## Suggested fixes', '');
  for (const suggestion of result.suggestions) lines.push(`- ${suggestion}`);
  lines.push('', '## Output tail', '', '```', (result.stderr || result.stdout || '').trim().split('\n').slice(-30).join('\n'), '```');
  return lines.join('\n');
}

function maybeOpenIssue(root, result) {
  const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (gh.status !== 0) return { opened: false, reason: 'gh CLI is not available' };
  const title = `[sdw-doctor] sandbox smoke test failed: ${(result.errors[0] && result.errors[0].error ? result.errors[0].error : 'unknown error').slice(0, 90)}`;
  const proc = spawnSync('gh', ['issue', 'create', '--title', title, '--body', buildIssueReport(result)], { cwd: root, encoding: 'utf8' });
  if (proc.status !== 0) return { opened: false, reason: (proc.stderr || 'gh issue create failed').trim() };
  return { opened: true, url: (proc.stdout || '').trim() };
}

function runSmokeTest(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const installation = detectInstallation(root, options.homeDir);
  const base = {
    ok: false,
    mode: 'smoke',
    installationMode: installation.mode,
    projectRoot: root,
    skillsRoot: installation.skillsRoot ? toPosix(installation.skillsRoot) : null,
    runId: null,
    stateStatus: null,
    steps: {},
    exitCode: null,
    errors: [],
    suggestions: [],
    issue: null,
    kept: Boolean(options.keep),
    stdout: '',
    stderr: ''
  };

  if (!installation.skillsRoot) {
    base.errors.push({ step: 0, error: 'No SDW skills installation found to smoke test.' });
    base.suggestions = smokeSuggestions('No valid skills directory');
    return base;
  }

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdw-doctor-smoke-'));
  try {
    fs.cpSync(installation.skillsRoot, path.join(projectDir, '.agents', 'skills'), { recursive: true, force: true });
    const sdwDir = path.join(projectDir, '.sdw');
    fs.mkdirSync(path.join(sdwDir, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(sdwDir, 'smoke'), { recursive: true });

    const config = {
      specsDir: '{projectRoot}/.sdw/specs',
      stateDir: '{projectRoot}/.sdw/state',
      sandboxDir: '{projectRoot}/.sdw/sandbox',
      scoreMin: 8,
      scoring: { judgeCommand: 'node .sdw/smoke/judge.cjs' },
      implementation: {
        mode: 'command',
        command: 'node .sdw/smoke/impl.cjs',
        timeoutMs: 60000,
        envAllowlist: ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
      },
      verification: { testCommand: 'node -e "process.exit(0)"', timeoutMs: 60000 },
      requiredBuild: false,
      runAllTests: true,
      pushDelivery: false,
      scmProvider: 'none',
      securityChecksEnabled: false,
      useWorktrees: false,
      useFeatureBranches: false
    };
    fs.writeFileSync(path.join(sdwDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'config.schema.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'directory-structure.md'), '# Smoke workspace\n', 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'specs', 'index.specs.md'), `# Specification Index

| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |
|---|---|---|---|---|---|---|---|
| 00001 | 00001-doctor-smoke | Doctor Smoke | pending | local | 2026-10-21 | PASS | - |
`, 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'specs', '00001-doctor-smoke.md'), `---
id: null
slug: 00001-doctor-smoke
title: "Doctor Smoke"
source: local
status: ready-to-implement
specDate: 2026-10-21
---
# Specification — Doctor Smoke
## Description
Minimal specification used by sdw-doctor to exercise the full sdw-run pipeline in a sandbox.
### Design Intent
Prove that the installed skills can plan, implement, score, deliver, review, and prepare a PR without external services.
## Acceptance Criteria
- AC1: The system shall complete the doctor sandbox smoke pipeline.
## Notes
Generated automatically by sdw-doctor test; safe to delete.
## Out of Scope
| Feature | Reason |
|---|---|
| Real product behaviour | The smoke test only proves the pipeline runs. |
## Assumptions & Open Questions
| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Local git repository | Initialized by sdw-doctor | Sandbox mode clones committed HEAD. | Yes |
## Definition of Ready (DoR)
| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Spec valid | Authoring validation passes | validate_spec.cjs |
## Validation & Observation Notes
### Telemetry & Observable Signals
- sdw-run exits 0 and the run state reaches completed.
### Negative & Failing Test Scenarios
- A missing skill or invalid config makes the smoke test exit 1.
`, 'utf8');

    fs.writeFileSync(path.join(sdwDir, 'smoke', 'impl.cjs'), `'use strict';
const fs = require('fs');
fs.mkdirSync('.sdw/smoke', { recursive: true });
fs.writeFileSync('.sdw/smoke/result.txt', 'ok\\n');
fs.writeFileSync(process.env.SDW_EVIDENCE_FILE, JSON.stringify({
  taskId: process.env.SDW_TASK_ID,
  status: 'success',
  acIds: ['AC1'],
  filesChanged: ['.sdw/smoke/result.txt'],
  tests: [],
  summary: 'sdw-doctor sandbox smoke implementation'
}, null, 2));
`, 'utf8');
    fs.writeFileSync(path.join(sdwDir, 'smoke', 'judge.cjs'), `'use strict';
const fs = require('fs');
const criteria = fs.readFileSync(process.env.SDW_JUDGE_CRITERIA, 'utf8');
const ids = [...criteria.matchAll(/^- (AC\\d+):/gm)].map(m => m[1]);
const verdicts = ids.map(id => ({ id, verdict: 'verified', evidence: '.sdw/smoke/result.txt' }));
fs.writeFileSync(process.env.SDW_JUDGE_VERDICT, JSON.stringify({ score: 10, verdicts, notes: 'sdw-doctor smoke judge' }, null, 2));
`, 'utf8');

    const gitInit = spawnSync('git', ['init', '-b', 'main'], { cwd: projectDir, encoding: 'utf8' });
    if (gitInit.status !== 0) {
      spawnSync('git', ['init'], { cwd: projectDir, encoding: 'utf8' });
      spawnSync('git', ['checkout', '-b', 'main'], { cwd: projectDir, encoding: 'utf8' });
    }
    spawnSync('git', ['config', 'user.email', 'sdw-doctor@example.invalid'], { cwd: projectDir, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'sdw-doctor'], { cwd: projectDir, encoding: 'utf8' });
    spawnSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf8' });
    const commit = spawnSync('git', ['commit', '-m', 'sdw-doctor smoke baseline'], { cwd: projectDir, encoding: 'utf8' });
    if (commit.status !== 0) {
      base.errors.push({ step: 0, error: `git commit failed: ${(commit.stderr || '').trim()}` });
      base.suggestions = smokeSuggestions('git');
      return base;
    }

    const runScript = path.join(projectDir, '.agents', 'skills', 'sdw-run', 'scripts', 'sdw_run.cjs');
    const proc = spawnSync(process.execPath, [runScript, 'run', '.sdw/specs/00001-doctor-smoke.md', '--sandbox', '--root', projectDir], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: options.timeoutMs || 180000,
      env: { ...process.env }
    });

    base.exitCode = proc.status;
    base.stdout = proc.stdout || '';
    base.stderr = proc.stderr || '';
    const state = findSmokeState(projectDir);
    if (state) {
      base.runId = state.runId || null;
      base.stateStatus = state.status || null;
      base.steps = {};
      for (const [id, step] of Object.entries(state.steps || {})) base.steps[id] = step.status;
      if (Array.isArray(state.errors)) base.errors = state.errors.map(error => ({ step: error.step, error: error.error }));
    }

    const stepStatuses = Object.values(base.steps);
    const allResolved = stepStatuses.length >= 8 && stepStatuses.every(status => status === 'completed' || status === 'skipped');
    base.ok = proc.status === 0 && state && state.status === 'completed' && allResolved;

    if (!base.ok) {
      const text = [base.stdout, base.stderr, ...base.errors.map(error => error.error)].join('\n');
      base.suggestions = smokeSuggestions(text);
      if (options.openIssue) {
        if (installation.mode === 'upstream') base.issue = maybeOpenIssue(root, base);
        else base.issue = { opened: false, reason: 'issue filing requires upstream mode' };
      }
    }
    return base;
  } finally {
    if (!options.keep) fs.rmSync(projectDir, { recursive: true, force: true });
    else base.projectRoot = toPosix(projectDir);
  }
}

function printSmokeResult(result) {
  console.log(`[sdw-doctor test] Sandbox smoke test: ${result.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Installation: ${result.installationMode}`);
  console.log(`  Skills root:  ${result.skillsRoot || '(none)'}`);
  console.log(`  Exit code:    ${result.exitCode}`);
  console.log(`  Run id:       ${result.runId || '(none)'}`);
  console.log(`  State:        ${result.stateStatus || '(none)'}`);
  if (result.kept) console.log(`  Kept project: ${result.projectRoot}`);

  if (result.errors.length > 0) {
    console.log('  Captured errors:');
    for (const error of result.errors.slice(-10)) console.log(`    - [step ${error.step || '?'}] ${error.error}`);
  }
  if (!result.ok) {
    console.log('  Suggested fixes:');
    for (const suggestion of result.suggestions) console.log(`    - ${suggestion}`);
    if (result.issue) {
      console.log(result.issue.opened
        ? `  Issue opened: ${result.issue.url}`
        : `  Issue not opened: ${result.issue.reason}`);
    }
  }
}

function printResult(result) {
  console.log(`[sdw-doctor] Installation mode: ${result.mode}`);
  console.log(`  Project root: ${result.root}`);
  console.log(`  Skills root:  ${result.skillsRoot || '(none)'}`);
  if (result.globalRoot) console.log(`  Global root:  ${result.globalRoot} (quick check)`);
  console.log(`  Skills:       ${result.presentSkills.length}/${result.expectedSkills.length} present`);

  for (const item of result.findings) {
    const label = item.level === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  ${label} [${item.subject}] ${item.message}`);
  }

  if (result.ok) {
    console.log(`[sdw-doctor] PASS: installation and workspace checks passed (${result.warnings} warning(s)).`);
    return;
  }

  console.log(`[sdw-doctor] FAIL: ${result.errors} error(s), ${result.warnings} warning(s).`);
  if (result.remediation.length > 0) {
    console.log('[sdw-doctor] Remediation:');
    for (const line of result.remediation) console.log(`  ${line}`);
  }
  console.log('[sdw-doctor] Stopping. Do not invoke other SDW skills until the installation is repaired.');
}

function showHelp() {
  console.log(`Usage: node sdw_doctor.cjs [check|test] [--root <path>] [--home <path>] [--json]

Checks an SDW installation and the consuming workspace.

Subcommands:
  check            Audit skills, references, scripts, workspace config, registry, and specs (default)
  test             Run a fake specification through sdw-run in a sandbox and verify every step

Modes:
  upstream         Canonical repository: audits skills/ and the .sdw/ template in place
  consumer-local   Project-local install: audits {projectRoot}/.agents/skills plus .sdw/
  consumer-global  Global install only: audits the global skills root plus .sdw/
  hybrid           Global skills with a local .sdw/: audits both

Options:
  --root <path>    Project root to inspect (default: current directory)
  --home <path>    Override the home directory used to locate global skills
  --timeout <ms>   Smoke test timeout (default: 180000)
  --keep           Keep the generated smoke project for inspection
  --open-issue     Upstream only: open a GitHub issue when the smoke test fails
  --json           Emit structured JSON
  -h, --help       Show this help

Exit codes:
  0  all checks passed (warnings allowed)
  1  errors found; remediation printed and the caller must stop
`);
}

function main() {
  const argv = process.argv.slice(2);
  const options = { root: null, homeDir: null, json: false, keep: false, openIssue: false, timeoutMs: 180000 };
  let command = 'check';
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--open-issue') options.openIssue = true;
    else if (arg === '--root') options.root = argv[++i];
    else if (arg.startsWith('--root=')) options.root = arg.slice(7);
    else if (arg === '--home') options.homeDir = argv[++i];
    else if (arg.startsWith('--home=')) options.homeDir = arg.slice(7);
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) || options.timeoutMs;
    else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.slice(10)) || options.timeoutMs;
    else if (arg === 'check' || arg === 'doctor') command = 'check';
    else if (arg === 'test') command = 'test';
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (help) {
    showHelp();
    process.exit(0);
  }

  if (command === 'test') {
    const result = runSmokeTest(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printSmokeResult(result);
    process.exit(result.ok ? 0 : 1);
  }

  const result = runDoctor(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_SKILLS,
  detectInstallation,
  runDoctor,
  runSmokeTest,
  buildIssueReport,
  parseFrontmatter
};
