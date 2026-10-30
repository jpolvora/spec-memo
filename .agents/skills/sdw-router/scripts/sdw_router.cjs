#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Finds the project root by locating .git, .sdw, or package.json, or skills directory.
 */
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

/**
 * Parses simple YAML frontmatter from a markdown file without external dependencies.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const yamlBlock = match[1];
  const result = {};

  const lines = yamlBlock.split(/\r?\n/);
  let currentKey = null;
  let isArray = false;

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const val = keyMatch[2].trim();
      if (val === '') {
        result[currentKey] = [];
        isArray = true;
      } else {
        result[currentKey] = val.replace(/^["']|["']$/g, '');
        isArray = false;
      }
    } else if (isArray && currentKey && /^\s*-\s*(.+)$/.test(line)) {
      const itemMatch = line.match(/^\s*-\s*(.+)$/);
      if (itemMatch) {
        result[currentKey].push(itemMatch[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
  }

  return result;
}

/**
 * Scans available skills in canonical (skills/), consumer (.agents/skills/), and global ($HOME/.agents/skills/) directories.
 */
function scanSkills(options) {
  const root = path.resolve((options && options.root) || findProjectRoot());
  const discovered = new Map();

  const home = (options && 'homeDir' in options) ? options.homeDir : os.homedir();
  const searchLocations = [
    { dir: path.join(root, 'skills'), type: 'canonical' },
    { dir: path.join(root, '.agents', 'skills'), type: 'consumer' }
  ];
  if (home && (!options || !options.ignoreGlobal)) {
    searchLocations.push({ dir: path.join(home, '.agents', 'skills'), type: 'global' });
  }

  for (const loc of searchLocations) {
    if (fs.existsSync(loc.dir)) {
      try {
        const entries = fs.readdirSync(loc.dir);
        for (const entry of entries) {
          const skillPath = path.join(loc.dir, entry).replace(/\\/g, '/');
          let stat;
          try {
            stat = fs.statSync(skillPath);
          } catch (e) {
            continue;
          }

          if (stat.isDirectory()) {
            const skillMdPath = path.join(skillPath, 'SKILL.md').replace(/\\/g, '/');
            const hasSkillMd = fs.existsSync(skillMdPath);
            let metadata = {};

            if (hasSkillMd) {
              try {
                const content = fs.readFileSync(skillMdPath, 'utf8');
                metadata = parseFrontmatter(content);
              } catch (e) {
                metadata.readError = e.message;
              }
            }

            const skillName = metadata.name || entry;
            // Precedence: canonical > consumer > global
            const existing = discovered.get(skillName);
            const shouldReplace = !existing ||
              (loc.type === 'canonical') ||
              (loc.type === 'consumer' && existing.locationType === 'global');

            if (shouldReplace) {
              discovered.set(skillName, {
                name: skillName,
                dirName: entry,
                path: skillPath,
                skillMdPath,
                hasSkillMd,
                locationType: loc.type,
                version: metadata.version || '0.1.0',
                description: metadata.description || '',
                invocationNames: metadata.invocation_names || [skillName],
                exists: true,
                readable: hasSkillMd && !metadata.readError
              });
            }
          }
        }
      } catch (err) {
        // Directory read error
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Routing keyword intent rules and weights
 */
const INTENT_RULES = {
  'sdw-config': {
    primaryKeywords: ['config', 'configuration', 'config.json', 'directory-structure', 'environment verification'],
    secondaryKeywords: ['init', 'check', 'parse', 'setup', 'settings', 'dry-run', 'scaffold'],
    recommendedOption: 'Initialize or verify workspace configuration using sdw-config'
  },
  'sdw-doctor': {
    primaryKeywords: ['sdw-doctor', 'installation health', 'install check', 'workspace health'],
    secondaryKeywords: ['doctor check', 'missing skill', 'skill not found', 'hybrid install', 'global install check', 'broken install', 'npx reinstall', 'check skills'],
    recommendedOption: 'Audit the SDW installation and workspace health using sdw-doctor'
  },
  'sdw-spec': {
    primaryKeywords: ['spec', 'specification', 'index.specs.md', 'prd index', 'ears', 'authoring', 'grill'],
    secondaryKeywords: ['new spec', 'import spec', 'list specs', 'sync specs', 'validate spec', 'archive spec', 'formatting', 'acceptance criteria', 'format spec', 'grill me', 'refine spec', 'spec status', 'awaiting-approval'],
    recommendedOption: 'Author, grill, validate, or synchronize specifications using sdw-spec'
  },
  'sdw-run': {
    primaryKeywords: ['orchestrator', 'orchestration', 'implement spec', 'run spec', 'execute spec', 'specification implementation', 'workflow execution'],
    secondaryKeywords: ['workflow', 'implement', 'implementation', 'execute', 'execution', 'resumption', 'resume', 'status', 'dag', 'conformance', 'delivery commit', 'automated review', 'pull request', 'push'],
    recommendedOption: 'Orchestrate end-to-end implementation and delivery using sdw-run'
  },
  'sdw-batch': {
    primaryKeywords: ['multiple specs', 'multiple specifications', 'spec queue', 'specification queue', 'all specs', 'implement all specs', 'queue specs', 'run specs in sequence'],
    secondaryKeywords: ['batch', 'multi-spec', 'resume batch', 'batch status', 'sequential delivery', 'specs in sequence'],
    recommendedOption: 'Queue specifications through single sdw-run runs using sdw-batch'
  },
  'sdw-rules': {
    primaryKeywords: ['sdw-rules', 'shared rules', 'engineering principles', 'simplicity first', 'scope enclosure', 'anti-overengineering'],
    secondaryKeywords: ['guideline', 'guidelines', 'yagni', 'surgical diff', 'traps log', 'audit-spec', 'log-trap', 'traps.md'],
    recommendedOption: 'Review behavioral rules, anti-patterns, or log traps using sdw-rules'
  },
  'sdw-security-checks': {
    primaryKeywords: ['security-checks', 'security checks', 'secret leak', 'leak scan', 'credentials check', 'pre-commit security'],
    secondaryKeywords: ['secrets', 'leaks', 'pii', 'credentials', 'api keys', 'securityChecksEnabled', 'allowlist secret', 'scan --staged'],
    recommendedOption: 'Scan workspace or staged diff for secrets, credentials, and leaks using sdw-security-checks'
  },
  'sdw-ship-pr': {
    primaryKeywords: ['ship pr', 'ship-pr', 'create pr', 'open pr', 'submit pr', 'review convergence', 'pr review loop'],
    secondaryKeywords: ['ship', 'deliver pr', 'pre-pr', 'poll pr', 'resolve review', 'resolve thread', 'pull request review', 'converge'],
    recommendedOption: 'Ship pull request, check pre-PR requirements, and run review convergence using sdw-ship-pr'
  },
  'sdw-fixer': {
    primaryKeywords: ['sdw-fixer', 'fixer', 'apply-fix', 'apply fix', 'remediate', 'remediation'],
    secondaryKeywords: ['fix batch', 'fix findings', 'remediation batch', 'defect siblings', 'surgical fix', 'fixing review findings'],
    recommendedOption: 'Apply surgical remediation to review findings using sdw-fixer'
  },
  'sdw-memory': {
    primaryKeywords: ['sdw-memory', 'memory skill', 'traps', 'knowledge base', 'project memory'],
    secondaryKeywords: ['trap', 'gap', 'pattern', 'shareable knowledge', 'record trap', 'query memory', 'consolidate memory', 'classify'],
    recommendedOption: 'Query, record, or consolidate product knowledge using sdw-memory'
  },
  'sdw-code-review': {
    primaryKeywords: ['code-review', 'code review', 'review code', 'sdw-code-review', 'deep review'],
    secondaryKeywords: ['review findings', 'fix review', 'review fix plan', 'run review', 'review working tree', 'blocking findings', 'code review report'],
    recommendedOption: 'Run deep working-tree code review and fix planning using sdw-code-review'
  }
};

/**
 * Evaluates a user prompt and determines target skill, confidence, and ambiguity status.
 */
function routePrompt(prompt, options) {
  if (!prompt || typeof prompt !== 'string') {
    return {
      matched: false,
      passThrough: true,
      error: 'Empty or invalid prompt supplied.'
    };
  }

  const root = path.resolve((options && options.root) || findProjectRoot());
  const availableSkills = (options && options.skills) || scanSkills({ root });
  const normalized = prompt.trim();
  const lower = normalized.toLowerCase();

  // 1. Explicit Invocation Check (AC6)
  // Check for patterns like /sdw-config, @sdw-spec, sdw-run
  for (const skill of availableSkills) {
    const explicitPatterns = [
      new RegExp(`(?:^|\\s)[/@]?${skill.name}\\b`, 'i'),
      new RegExp(`(?:^|\\s)@(?:skills/|\\.agents/skills/)?${skill.name}\\b`, 'i')
    ];

    if (Array.isArray(skill.invocationNames)) {
      for (const inv of skill.invocationNames) {
        explicitPatterns.push(new RegExp(`(?:^|\\s)[/@]?${inv}\\b`, 'i'));
      }
    }

    for (const pat of explicitPatterns) {
      if (pat.test(lower)) {
        // Disk existence check (AC8)
        const isReadable = fs.existsSync(skill.path) && skill.hasSkillMd;
        if (!isReadable) {
          return {
            matched: true,
            targetSkill: skill.name,
            confidence: 1.0,
            reason: 'explicit_invocation',
            hasError: true,
            error: `Routed skill "${skill.name}" directory is missing or unreadable on disk at "${skill.path}". Please ensure the skill is installed under skills/, .agents/skills/, or $HOME/.agents/skills/.`
          };
        }

        return {
          matched: true,
          targetSkill: skill.name,
          confidence: 1.0,
          reason: 'explicit_invocation',
          skill,
          isAmbiguous: false
        };
      }
    }
  }

  // Also check for explicit standalone invocation words or /sdw-* / @sdw-* pattern even if not in scanned list
  const explicitSdwMatch = lower.match(/(?:^|\s)[/@](sdw-[a-zA-Z0-9_-]+)\b/);
  if (explicitSdwMatch) {
    const sdwName = explicitSdwMatch[1];
    const existing = availableSkills.find(sk => sk.name === sdwName);
    if (!existing) {
      return {
        matched: true,
        targetSkill: sdwName,
        confidence: 1.0,
        reason: 'explicit_invocation',
        hasError: true,
        error: `Routed skill "${sdwName}" directory is missing or unreadable on disk at "skills/${sdwName}", ".agents/skills/${sdwName}", or "$HOME/.agents/skills/${sdwName}". Please ensure the skill is installed.`
      };
    }
  }

  const knownExplicitSkills = ['sdw-config', 'sdw-doctor', 'sdw-spec', 'sdw-run', 'sdw-router', 'sdw-rules', 'sdw-security-checks', 'sdw-ship-pr', 'sdw-code-review', 'sdw-fixer'];
  for (const s of knownExplicitSkills) {
    if (new RegExp(`(?:^|\\s)[/@]?${s}\\b`, 'i').test(lower)) {
      // It was explicitly requested but might be missing on disk
      const existing = availableSkills.find(sk => sk.name === s);
      if (!existing) {
        return {
          matched: true,
          targetSkill: s,
          confidence: 1.0,
          reason: 'explicit_invocation',
          hasError: true,
          error: `Routed skill "${s}" directory is missing or unreadable on disk. Please ensure the skill is installed under skills/, .agents/skills/, or $HOME/.agents/skills/.`
        };
      }
    }
  }

  // Multi-specification requests belong to sdw-batch; sdw-run runs exactly one spec.
  const multiSpecRequest =
    /\b(?:multiple|several)\s+(?:specs?|specifications?)\b/.test(lower) ||
    /\b(?:specs?|specifications?)\s+queue\b/.test(lower) ||
    /\bqueue\s+(?:the\s+|these\s+)?(?:specs?|specifications?)\b/.test(lower) ||
    /\b(?:implement|run|execute|deliver|process|batch|queue)\b[^.]*\b(?:all|these|the)\s+(?:specs?|specifications?)\b/.test(lower) ||
    /\b(?:specs?|specifications?)\b[^.]*\b(?:in sequence|one by one|sequentially)\b/.test(lower);
  if (multiSpecRequest) {
    const batchSkill = availableSkills.find(s => s.name === 'sdw-batch');
    if (batchSkill) {
      return {
        matched: true,
        targetSkill: 'sdw-batch',
        confidence: 0.9,
        reason: 'multi_spec_intent',
        skill: batchSkill,
        isAmbiguous: false
      };
    }
  }

  // 2. Keyword & Intent Scoring (AC3, AC4, AC5)
  const scores = {};
  for (const [skillName, rules] of Object.entries(INTENT_RULES)) {
    let score = 0;
    for (const pk of rules.primaryKeywords) {
      if (lower.includes(pk)) score += 3;
    }
    for (const sk of rules.secondaryKeywords) {
      if (lower.includes(sk)) score += 1;
    }
    scores[skillName] = score;
  }

  // Find candidate matches with scores > 0
  const scoredEntries = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  // 3. Passive Non-Interference Pass-Through (AC12)
  if (scoredEntries.length === 0) {
    return {
      matched: false,
      passThrough: true,
      prompt: normalized,
      reason: 'No recognized SDW skill intent in prompt; passing through cleanly.'
    };
  }

  const topScore = scoredEntries[0][1];
  const topCandidates = scoredEntries.filter(([_, s]) => s === topScore);

  // 4. Ambiguity Resolution on Tied Confidence (AC7)
  if (topCandidates.length > 1) {
    // Determine recommended default
    // If sdw-run and sdw-spec are tied, sdw-run is recommended for implementation
    let recommendedDefault = topCandidates[0][0];
    if (topCandidates.some(c => c[0] === 'sdw-run')) {
      recommendedDefault = 'sdw-run';
    }

    const optionsList = topCandidates.map(([name]) => {
      const isRec = name === recommendedDefault;
      const desc = INTENT_RULES[name]?.recommendedOption || `Execute ${name}`;
      return isRec ? `(Recommended) ${desc}` : desc;
    });

    return {
      matched: true,
      isAmbiguous: true,
      confidence: 0.5,
      candidates: topCandidates.map(c => c[0]),
      recommendedDefault,
      clarification: {
        question: `Your request contains matching terms for multiple skills with equal confidence. How would you like to proceed?`,
        options: optionsList,
        recommendedDefault
      }
    };
  }

  // Single winning candidate
  const winningSkillName = topCandidates[0][0];
  const targetSkillInfo = availableSkills.find(s => s.name === winningSkillName);

  // Check if directory exists on disk (AC8)
  if (!targetSkillInfo || !fs.existsSync(targetSkillInfo.path) || !targetSkillInfo.hasSkillMd) {
    return {
      matched: true,
      targetSkill: winningSkillName,
      confidence: Math.min(1.0, topScore / 6),
      reason: 'intent_match',
      hasError: true,
      error: `Routed skill "${winningSkillName}" directory is missing or unreadable on disk at "${targetSkillInfo ? targetSkillInfo.path : 'skills/' + winningSkillName}". Please ensure the skill is installed under skills/, .agents/skills/, or $HOME/.agents/skills/.`
    };
  }

  return {
    matched: true,
    targetSkill: winningSkillName,
    confidence: Math.min(1.0, topScore / 6),
    reason: 'intent_match',
    skill: targetSkillInfo,
    isAmbiguous: false
  };
}

/**
 * Health check & diagnostic report for the router.
 */
function doctorCheck(options) {
  const root = path.resolve((options && options.root) || findProjectRoot());
  const skills = scanSkills({ root, ...options });
  const issues = [];

  const expectedSkills = ['sdw-config', 'sdw-spec', 'sdw-run', 'sdw-router'];

  if (skills.length === 0) {
    issues.push({
      severity: 'error',
      skill: 'all',
      message: 'No skills found. Neither local (skills/, .agents/skills/) nor global ($HOME/.agents/skills/) skills directories exist on disk.'
    });
  }

  for (const expected of expectedSkills) {
    const found = skills.find(s => s.name === expected);
    if (!found) {
      issues.push({
        severity: 'warning',
        skill: expected,
        message: `Expected skill "${expected}" not found in canonical skills/, consumer .agents/skills/, or global $HOME/.agents/skills/.`
      });
    } else {
      if (!found.hasSkillMd) {
        issues.push({
          severity: 'error',
          skill: expected,
          message: `Skill directory "${found.path}" is missing SKILL.md.`
        });
      }
      if (!found.readable) {
        issues.push({
          severity: 'error',
          skill: expected,
          message: `SKILL.md at "${found.skillMdPath}" could not be read or parsed.`
        });
      }
    }
  }

  return {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    root,
    skillsCount: skills.length,
    skills: skills.map(s => ({
      name: s.name,
      locationType: s.locationType,
      path: s.path,
      version: s.version,
      hasSkillMd: s.hasSkillMd
    })),
    issues
  };
}

// CLI Execution Entry Point
function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const rootIndex = args.indexOf('--root');
  const customRoot = rootIndex !== -1 ? args[rootIndex + 1] : null;

  const positional = args.filter(a => !a.startsWith('--') && (rootIndex === -1 || a !== args[rootIndex + 1]));
  const subcommand = positional[0];

  if (!subcommand || subcommand === '--help' || subcommand === 'help') {
    console.log(`Spec-Driven Workflow — Router CLI (sdw-router)

Usage:
  node sdw_router.cjs <subcommand> [options]

Subcommands:
  scan                   Discover and list all installed skills in canonical, consumer, and global ($HOME/.agents/skills) directories
  route <prompt>         Analyze prompt intent, detect explicit invocations, or pass-through
  doctor                 Run router health check and diagnostic audit on skills integrity

Options:
  --root <path>          Specify custom project root (default: auto-detected)
  --json                 Output structured JSON payload
  --help                 Show this help message
`);
    process.exit(0);
  }

  if (subcommand === 'scan') {
    const skills = scanSkills({ root: customRoot });
    if (jsonMode) {
      console.log(JSON.stringify({ total: skills.length, skills }, null, 2));
    } else {
      console.log(`[sdw-router] Discovered ${skills.length} available skill(s):`);
      skills.forEach(s => {
        console.log(`  * ${s.name} (${s.locationType}) -> ${s.path} [SKILL.md: ${s.hasSkillMd ? 'YES' : 'MISSING'}]`);
      });
    }
    process.exit(0);
  }

  if (subcommand === 'route') {
    const promptText = positional.slice(1).join(' ');
    if (!promptText) {
      console.error('Error: "route" subcommand requires a prompt argument.');
      process.exit(1);
    }

    const result = routePrompt(promptText, { root: customRoot });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.hasError) {
        console.error(`[sdw-router] Error: ${result.error}`);
        process.exit(1);
      } else if (result.passThrough) {
        console.log(`[sdw-router] Pass-through: No SDW workflow intent detected. Standard execution allowed.`);
      } else if (result.isAmbiguous) {
        console.log(`[sdw-router] Ambiguous Intent Detected: Candidates [${result.candidates.join(', ')}]`);
        console.log(`  Question: ${result.clarification.question}`);
        result.clarification.options.forEach((opt, idx) => console.log(`  ${idx + 1}. ${opt}`));
      } else {
        console.log(`[sdw-router] Routing intent to "${result.targetSkill}" (confidence: ${result.confidence.toFixed(2)}, reason: ${result.reason})`);
      }
    }
    process.exit(result.hasError ? 1 : 0);
  }

  if (subcommand === 'doctor') {
    const report = doctorCheck({ root: customRoot });
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[sdw-router doctor] Audit completed. Skills discovered: ${report.skillsCount}`);
      report.skills.forEach(s => {
        console.log(`  - ${s.name} [${s.locationType}]: ${s.path}`);
      });
      if (report.issues.length > 0) {
        console.log('\nIssues detected:');
        report.issues.forEach(i => {
          console.log(`  [${i.severity.toUpperCase()}] ${i.skill}: ${i.message}`);
        });
      } else {
        console.log('\nRouter health check: ALL CHECKS PASSED.');
      }
    }
    process.exit(report.passed ? 0 : 1);
  }

  console.error(`Unknown subcommand: "${subcommand}". Use --help for usage instructions.`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  findProjectRoot,
  parseFrontmatter,
  scanSkills,
  routePrompt,
  doctorCheck,
  INTENT_RULES
};
