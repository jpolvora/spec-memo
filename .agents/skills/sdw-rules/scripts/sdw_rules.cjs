#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function normalizePath(p) {
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
  const result = {
    subcommand: null,
    specFile: null,
    slug: null,
    title: null,
    avoid: null,
    action: null,
    layer: 'general',
    root: null,
    json: false
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--root') {
      result.root = args[++i];
    } else if (arg.startsWith('--root=')) {
      result.root = arg.slice(7);
    } else if (arg === '--slug') {
      result.slug = args[++i];
    } else if (arg.startsWith('--slug=')) {
      result.slug = arg.slice(7);
    } else if (arg === '--title') {
      result.title = args[++i];
    } else if (arg.startsWith('--title=')) {
      result.title = arg.slice(8);
    } else if (arg === '--avoid') {
      result.avoid = args[++i];
    } else if (arg.startsWith('--avoid=')) {
      result.avoid = arg.slice(8);
    } else if (arg === '--action') {
      result.action = args[++i];
    } else if (arg.startsWith('--action=')) {
      result.action = arg.slice(9);
    } else if (arg === '--layer') {
      result.layer = args[++i];
    } else if (arg.startsWith('--layer=')) {
      result.layer = arg.slice(8);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  result.subcommand = positional[0] || null;
  result.specFile = positional[1] || null;

  return result;
}

/**
 * Subcommand: doctor
 * Audits skills for context line budget (<= 120 lines) and cross-references to sdw-rules.
 */
function cmdDoctor(options) {
  const root = path.resolve(options.root || findProjectRoot());
  const skillsDir = path.join(root, 'skills');
  const violations = [];
  const checkedSkills = [];

  if (!fs.existsSync(skillsDir)) {
    return {
      passed: false,
      error: `Skills directory not found at ${normalizePath(skillsDir)}`,
      checkedSkills: [],
      violations: [{ skill: 'skills', rule: 'dir_exists', message: 'skills directory does not exist' }]
    };
  }

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillMdPath = path.join(skillsDir, skillName, 'SKILL.md');
    
    if (!fs.existsSync(skillMdPath)) {
      violations.push({
        skill: skillName,
        rule: 'skill_md_exists',
        message: `Missing SKILL.md in ${skillName}`
      });
      continue;
    }

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const lineCount = lines.length;
    const skillInfo = { name: skillName, lineCount, referencesRules: false, hasBanner: false };

    // 1. Line budget check (<= 120 lines)
    if (lineCount > 120) {
      violations.push({
        skill: skillName,
        rule: 'line_budget_exceeded',
        message: `SKILL.md in "${skillName}" exceeds 120 lines (${lineCount} lines)`
      });
    }

    // 2. Announcement banner check
    if (/>\s*When this skill is loaded,\s*output/i.test(content)) {
      skillInfo.hasBanner = true;
    } else {
      violations.push({
        skill: skillName,
        rule: 'missing_announcement_banner',
        message: `SKILL.md in "${skillName}" is missing required announcement banner`
      });
    }

    // 3. Every skill except sdw-rules must reference the shared rules skill.
    if (skillName !== 'sdw-rules') {
      if (/sdw-rules/i.test(content)) {
        skillInfo.referencesRules = true;
      } else {
        violations.push({
          skill: skillName,
          rule: 'missing_rules_reference',
          message: `Skill "${skillName}" does not reference "sdw-rules"`
        });
      }
    } else if (/sdw-rules/i.test(content)) {
      skillInfo.referencesRules = true;
    }

    checkedSkills.push(skillInfo);
  }

  const passed = violations.length === 0;

  return {
    passed,
    checkedSkillsCount: checkedSkills.length,
    checkedSkills,
    violationsCount: violations.length,
    violations,
    summary: passed
      ? `sdw-rules doctor passed: ${checkedSkills.length} skills verified with 0 violations.`
      : `sdw-rules doctor failed: ${violations.length} violations found across ${checkedSkills.length} skills.`
  };
}

/**
 * Subcommand: audit-spec
 * Scans a spec file for potential scope creep markers or excessive complexity.
 */
function cmdAuditSpec(specPath, options) {
  const root = path.resolve(options.root || findProjectRoot());
  let resolvedPath = path.isAbsolute(specPath) ? specPath : path.resolve(root, specPath);
  
  if (!fs.existsSync(resolvedPath)) {
    const insideSpecs = path.resolve(root, '.sdw', 'specs', specPath);
    if (fs.existsSync(insideSpecs)) {
      resolvedPath = insideSpecs;
    } else if (fs.existsSync(`${insideSpecs}.md`)) {
      resolvedPath = `${insideSpecs}.md`;
    } else {
      return {
        passed: false,
        error: `Specification file not found at: ${specPath}`,
        findings: []
      };
    }
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  const findings = [];

  // Check 1: Out of Scope section presence
  if (!/##\s*Out of Scope/i.test(content)) {
    findings.push({
      severity: 'warning',
      rule: 'missing_out_of_scope_section',
      message: 'Specification is missing a dedicated "## Out of Scope" section to bound scope.'
    });
  }

  // Check 2: Unrequested or speculative scope creep markers
  const speculativeKeywords = [
    { pattern: /\b(speculative|speculatively)\b/i, label: 'speculative feature mention' },
    { pattern: /\b(future enhancements?|planned for future)\b/i, label: 'unrequested future expansion' },
    { pattern: /\b(optional extras?|nice to have)\b/i, label: 'scope creep: nice-to-have items' }
  ];

  for (const kw of speculativeKeywords) {
    if (kw.pattern.test(content)) {
      findings.push({
        severity: 'warning',
        rule: 'speculative_scope_marker',
        message: `Found potential scope creep marker: "${kw.label}"`
      });
    }
  }

  // Check 3: Composite acceptance criteria check (anti-pattern: composite criteria)
  const acMatches = content.match(/- AC\d+:([^\r\n]+)/g) || [];
  for (const ac of acMatches) {
    const acText = ac.replace(/^- AC\d+:\s*/, '');
    // Check if AC has multiple clauses like "shall ... and shall ..." or multiple conjunctions
    if (/\bshall\b.+\band\b.+\bshall\b/i.test(acText)) {
      findings.push({
        severity: 'warning',
        rule: 'composite_acceptance_criteria',
        message: `Composite acceptance criteria detected (split into atomic criteria): "${acText.slice(0, 80)}..."`
      });
    }
  }

  const hasErrors = findings.some(f => f.severity === 'error');
  const passed = !hasErrors;

  return {
    passed,
    file: normalizePath(path.relative(root, resolvedPath)),
    findingsCount: findings.length,
    findings,
    summary: passed
      ? (findings.length === 0 ? 'Specification scope audit passed with zero findings.' : `Specification scope audit passed with ${findings.length} advisory warning(s).`)
      : `Specification scope audit failed with blocking issues.`
  };
}

/**
 * Subcommand: log-trap
 * Records a verified trap through the central sdw-memory wrapper
 * (vault first, local `.sdw/memory/traps.md` table as fallback).
 */
function cmdLogTrap(options) {
  const root = path.resolve(options.root || findProjectRoot());
  const { slug, title, avoid, action, layer } = options;

  if (!avoid || !action) {
    return {
      success: false,
      error: 'Missing required parameters: both --avoid and --action are mandatory for logging a trap.'
    };
  }

  const trapSlug = slug || 'trap-' + Date.now();
  const trapTitle = title || trapSlug;
  const trapLayer = layer || 'general';
  const today = new Date().toISOString().slice(0, 10);

  // All writes go through sdw-memory when the skill is installed; otherwise
  // fall back to a direct local table append (same schema) so standalone
  // checkouts and hermetic tests never depend on the vault.
  let memoryModule = null;
  try {
    const memScriptPath = path.join(root, 'skills', 'sdw-memory', 'scripts', 'sdw_memory.cjs');
    if (fs.existsSync(memScriptPath)) memoryModule = require(memScriptPath);
  } catch (e) {
    memoryModule = null;
  }

  const trapsFile = (memoryModule && typeof memoryModule.trapsPathFor === 'function')
    ? memoryModule.trapsPathFor(root)
    : path.join(root, '.sdw', 'memory', 'traps.md');

  let memorySynced = false;
  if (memoryModule && typeof memoryModule.recordTrap === 'function') {
    let res;
    try {
      res = memoryModule.recordTrap({ slug: trapSlug, title: trapTitle, avoid, action, layer: trapLayer, root, backend: 'all' });
    } catch (e) {
      return { success: false, error: `sdw-memory record failed: ${e.message}` };
    }
    if (!res || !res.recorded) {
      return { success: false, error: (res && res.reason) || 'sdw-memory refused the trap entry' };
    }
    memorySynced = res.backend === 'ws-memo';
  } else {
    // Sanitize fields for markdown table
    const clean = str => String(str).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

    const row = `| ${clean(trapSlug)} | ${clean(trapTitle)} | ${clean(trapLayer)} | ${clean(avoid)} | ${clean(action)} | ${today} |\n`;

    // Ensure .sdw/memory directory exists
    const memDir = path.join(root, '.sdw', 'memory');
    if (!fs.existsSync(memDir)) {
      fs.mkdirSync(memDir, { recursive: true });
    }

    if (!fs.existsSync(trapsFile)) {
      const header = `# Anti-Regression Traps Log\n\nCentral repository log of behavioral and engineering traps to prevent repeating mistakes.\n\n| Slug | Title | Layer | Avoid | Action | Date |\n|---|---|---|---|---|---|\n`;
      fs.writeFileSync(trapsFile, header + row, 'utf8');
    } else {
      fs.appendFileSync(trapsFile, row, 'utf8');
    }
  }

  return {
    success: true,
    file: normalizePath(path.relative(root, trapsFile)),
    entry: {
      slug: trapSlug,
      title: trapTitle,
      layer: trapLayer,
      avoid,
      action,
      date: today
    },
    memorySynced
  };
}

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand) {
    console.error('Usage: sdw_rules.cjs <doctor|audit-spec|log-trap> [options]');
    process.exit(1);
  }

  if (options.subcommand === 'doctor') {
    const result = cmdDoctor(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[sdw-rules doctor] ${result.summary}`);
      if (result.violations.length > 0) {
        for (const v of result.violations) {
          console.error(`  - [${v.rule}] ${v.skill}: ${v.message}`);
        }
      }
    }
    process.exit(result.passed ? 0 : 1);
  } else if (options.subcommand === 'audit-spec') {
    if (!options.specFile) {
      console.error('Error: audit-spec requires <specFile>');
      process.exit(1);
    }
    const result = cmdAuditSpec(options.specFile, options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[sdw-rules audit-spec] ${result.summary}`);
      if (result.findings && result.findings.length > 0) {
        for (const f of result.findings) {
          console.log(`  * [${f.severity}] ${f.message}`);
        }
      }
    }
    process.exit(result.passed ? 0 : 1);
  } else if (options.subcommand === 'log-trap') {
    const result = cmdLogTrap(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.success) {
        console.log(`[sdw-rules log-trap] Trap recorded in ${result.file}: "${result.entry.title}"`);
      } else {
        console.error(`[sdw-rules log-trap] Error: ${result.error}`);
      }
    }
    process.exit(result.success ? 0 : 1);
  } else {
    console.error(`Unknown subcommand "${options.subcommand}". Available: doctor, audit-spec, log-trap`);
    process.exit(1);
  }
}

module.exports = {
  cmdDoctor,
  cmdAuditSpec,
  cmdLogTrap,
  findProjectRoot
};

if (require.main === module) {
  main();
}
