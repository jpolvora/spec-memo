#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function isPathInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Resolves sandboxDir with {projectRoot}, {skillsRoot}, and {temp} tokens and
// enforces the placement rule: the default location lives inside the project,
// every custom location must live outside it.
function resolveSandboxPath(root, rawValue, skillsRoot) {
  const projectRoot = path.resolve(root);
  const normalizedRoot = normalizePath(projectRoot);
  const normalizedSkills = skillsRoot ? normalizePath(path.resolve(skillsRoot)) : normalizedRoot;
  const value = typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : '{projectRoot}/.sdw/sandbox';
  const expanded = value
    .replace(/\{projectRoot\}/g, normalizedRoot)
    .replace(/\{skillsRoot\}/g, normalizedSkills)
    .replace(/\{temp\}/g, normalizePath(os.tmpdir()));
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(projectRoot, expanded);
  const defaultPath = path.resolve(projectRoot, '.sdw', 'sandbox');
  const normalizeCompare = (value) => (process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : path.resolve(value));
  const samePath = normalizeCompare(resolved) === normalizeCompare(defaultPath);
  const sameAsRoot = normalizeCompare(resolved) === normalizeCompare(projectRoot);
  if (!samePath && (sameAsRoot || isPathInside(resolved, projectRoot))) {
    throw new Error(`sandboxDir must resolve outside the project root unless it is the default "{projectRoot}/.sdw/sandbox" (resolved: ${normalizePath(resolved)}). Use "{temp}/sdw-sandbox" or an absolute path outside the repository.`);
  }
  return resolved;
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw'))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, '.git'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function hasSdwSkills(dir) {
  if (!dir) return false;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    const entries = fs.readdirSync(dir);
    return entries.some(e => {
      if (!e.startsWith('sdw-')) return false;
      try {
        const skillDir = path.join(dir, e);
        return fs.statSync(skillDir).isDirectory() && fs.existsSync(path.join(skillDir, 'SKILL.md'));
      } catch (err) {
        return false;
      }
    });
  } catch (e) {
    return false;
  }
}

function findEnclosingSkillsDir(startDir) {
  if (!startDir) return null;
  let curr = path.resolve(startDir);
  while (true) {
    const base = path.basename(curr);
    if (base === 'skills') {
      if (hasSdwSkills(curr)) return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

function detectSkillsMode(skillsPath, targetRoot, homeDir) {
  const normSkills = normalizePath(skillsPath);
  const root = targetRoot ? normalizePath(path.resolve(targetRoot)) : normalizePath(findProjectRoot(process.cwd()));
  if (normSkills === `${root}/skills`) return 'canonical';
  if (normSkills === `${root}/.agents/skills`) return 'local';
  const home = normalizePath(homeDir || os.homedir());
  const globalSkills = home ? normalizePath(path.join(home, '.agents', 'skills')) : '';
  if (globalSkills && (normSkills === globalSkills || normSkills.startsWith(`${globalSkills}/`))) return 'global';
  return 'local';
}

function resolveSkillsRoot(options = {}) {
  // 1. Explicit CLI / options override or environment variable (AC2)
  const explicit = options.skillsRoot || process.env.SDW_SKILLS_ROOT;
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    const norm = normalizePath(path.resolve(explicit.trim()));
    if (!hasSdwSkills(norm)) {
      return {
        skillsRoot: norm,
        mode: 'unknown',
        exists: false,
        error: `Configured skillsRoot is not a valid SDW skills directory: ${norm}`
      };
    }
    return {
      skillsRoot: norm,
      mode: detectSkillsMode(norm, options.root, options.homeDir),
      exists: true
    };
  }

  const targetRoot = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());

  // 2. Project-local canonical skills directory: {projectRoot}/skills (AC2, AC3)
  const canonicalDir = path.join(targetRoot, 'skills');
  if (!options.ignoreLocal && fs.existsSync(canonicalDir) && hasSdwSkills(canonicalDir)) {
    return {
      skillsRoot: normalizePath(canonicalDir),
      mode: 'canonical',
      exists: true
    };
  }

  // 3. Project-local consumer skills directory: {projectRoot}/.agents/skills (AC2, AC3)
  const consumerDir = path.join(targetRoot, '.agents', 'skills');
  if (!options.ignoreLocal && fs.existsSync(consumerDir) && hasSdwSkills(consumerDir)) {
    return {
      skillsRoot: normalizePath(consumerDir),
      mode: 'local',
      exists: true
    };
  }

  // 4. Enclosing directory of caller/executing script (AC2)
  const callerDir = options.callerDir !== undefined ? options.callerDir : __dirname;
  if (callerDir && !options.ignoreCaller) {
    const enclosing = findEnclosingSkillsDir(callerDir);
    if (enclosing && fs.existsSync(enclosing)) {
      return {
        skillsRoot: normalizePath(enclosing),
        mode: detectSkillsMode(enclosing, targetRoot, options.homeDir),
        exists: true
      };
    }
  }

  // 5. Global user directory: $HOME/.agents/skills (AC2, AC4)
  const home = options.homeDir || os.homedir();
  if (home) {
    const globalDir = path.join(home, '.agents', 'skills');
    if (fs.existsSync(globalDir) && hasSdwSkills(globalDir)) {
      return {
        skillsRoot: normalizePath(globalDir),
        mode: 'global',
        exists: true
      };
    }
  }

  return null;
}

function parseArgs(args) {
  const result = {
    subcommand: null,
    root: null,
    skillsRoot: null,
    force: false,
    json: false,
    key: null,
    executor: null
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') {
      result.force = true;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--root') {
      result.root = args[++i];
    } else if (arg === '--skills-root') {
      result.skillsRoot = args[++i];
    } else if (arg === '--key') {
      result.key = args[++i];
    } else if (arg === '--executor') {
      result.executor = args[++i];
    } else if (arg.startsWith('--root=')) {
      result.root = arg.slice(7);
    } else if (arg.startsWith('--skills-root=')) {
      result.skillsRoot = arg.slice(14);
    } else if (arg.startsWith('--key=')) {
      result.key = arg.slice(6);
    } else if (arg.startsWith('--executor=')) {
      result.executor = arg.slice(11);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  result.subcommand = positional[0] || null;
  return result;
}

// Branching presets (spec 00040). A preset describes the relationship between a
// work lane (where feature branches start) and an integration lane (where the
// pull request merges); every explicit `branching` key overrides the preset.
const BRANCHING_PRESETS = {
  trunk: {
    workBranch: null,
    integrationBranch: null,
    updateWorkBranch: false,
    syncWorkBranchAfterMerge: false
  },
  github: {
    mirrorWorkToIntegration: true,
    workBranch: null,
    integrationBranch: null,
    updateWorkBranch: true,
    syncWorkBranchAfterMerge: true
  },
  develop: {
    workBranch: 'develop',
    integrationBranch: null,
    updateWorkBranch: true,
    syncWorkBranchAfterMerge: true
  },
  gitflow: {
    workBranch: 'develop',
    integrationBranch: 'develop',
    updateWorkBranch: true,
    syncWorkBranchAfterMerge: true
  },
  gitlab: {
    mirrorWorkToIntegration: true,
    workBranch: null,
    integrationBranch: null,
    updateWorkBranch: true,
    syncWorkBranchAfterMerge: true
  }
};

const BRANCHING_DEFAULTS = {
  strategy: 'trunk',
  featurePrefix: 'feature/',
  workBranch: null,
  integrationBranch: null,
  updateWorkBranch: false,
  syncWorkBranchAfterMerge: false,
  pushSyncedWorkBranch: false
};

// Expands the configured preset and applies explicit overrides. `source` records
// whether the strategy came from `.sdw/config.json` ("config") or the default
// preset ("default").
function resolveBranching(config) {
  // `loadConfig` exposes the unmerged file contents as `raw`; prefer it so the
  // scaffolded default block is not mistaken for an explicit configuration.
  const configured = config && typeof config === 'object' && config.raw && typeof config.raw === 'object'
    ? config.raw.branching
    : (config && typeof config === 'object' && !Array.isArray(config) ? config.branching : undefined);
  const branching = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(branching, key);
  const strategy = has('strategy') ? branching.strategy : BRANCHING_DEFAULTS.strategy;
  if (typeof strategy !== 'string' || !Object.prototype.hasOwnProperty.call(BRANCHING_PRESETS, strategy)) {
    throw new Error(`Unknown branching.strategy "${strategy}". Allowed: ${Object.keys(BRANCHING_PRESETS).join(', ')}.`);
  }
  const preset = BRANCHING_PRESETS[strategy];
  const integrationBranch = has('integrationBranch') ? branching.integrationBranch : preset.integrationBranch;
  const workBranch = has('workBranch')
    ? branching.workBranch
    : (preset.mirrorWorkToIntegration ? integrationBranch : preset.workBranch);
  return {
    strategy,
    source: has('strategy') ? 'config' : 'default',
    mirrorWorkToIntegration: Boolean(preset.mirrorWorkToIntegration),
    workBranch,
    integrationBranch,
    featurePrefix: has('featurePrefix') ? branching.featurePrefix : BRANCHING_DEFAULTS.featurePrefix,
    updateWorkBranch: has('updateWorkBranch') ? branching.updateWorkBranch : preset.updateWorkBranch,
    syncWorkBranchAfterMerge: has('syncWorkBranchAfterMerge') ? branching.syncWorkBranchAfterMerge : preset.syncWorkBranchAfterMerge,
    pushSyncedWorkBranch: has('pushSyncedWorkBranch') ? branching.pushSyncedWorkBranch : BRANCHING_DEFAULTS.pushSyncedWorkBranch
  };
}

const DEFAULT_CONFIG = {
  $schema: './config.schema.json',
  specsDir: '{projectRoot}/.sdw/specs',
  scoreMin: 8,
  scoring: {
    judgeCommand: null,
    judgeModel: null,
    judgeProvider: null,
    judgeEffort: null,
    judgeApiEndpoint: null,
    judgeCriticity: 'strict'
  },
  scmCodeReviewEnabled: false,
  pushDelivery: false,
  automation: {
    autoShip: false,
    autoMerge: false
  },
  changelogEnabled: true,
  changelogFile: '{projectRoot}/CHANGELOG.md',
  stateDir: '{projectRoot}/.sdw/state',
  sandboxDir: '{projectRoot}/.sdw/sandbox',
  autoResolveGaps: true,
  securityChecksEnabled: false,
  useWorktrees: false,
  useFeatureBranches: false,
  scmProvider: 'none',
  implementation: {
    mode: 'subagent',
    command: null,
    timeoutMs: 1800000,
    envAllowlist: ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
  },
  verification: {
    buildCommand: null,
    testCommand: null,
    timeoutMs: 600000
  },
  requiredBuild: false,
  runAllTests: false,
  prePrCommand: '',
  prePrInstructions: '',
  reviewFixCommand: '',
  maxPreemptions: 3,
  memory: {
    backends: { wsMemo: true, traps: true, files: true }
  }
};

const DEFAULT_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://spec-driven-workflow.org/schemas/config.schema.json",
  "title": "SDW Configuration Schema",
  "description": "Configuration schema for Spec-Driven Workflow (.sdw/config.json).",
  "type": "object",
  "required": ["specsDir"],
  "properties": {
    "$schema": {
      "type": "string",
      "description": "Relative path or URL to the JSON schema definition file."
    },
    "specsDir": {
      "type": "string",
      "description": "Path to the directory containing feature specifications. Supports tokens {projectRoot} and {skillsRoot}.",
      "default": "{projectRoot}/.sdw/specs"
    },
    "automation": {
      "type": "object",
      "description": "Opt-in autonomous delivery. When both flags are true, Step 8 ships, converges, and merges in the same invocation; any failing gate still blocks delivery.",
      "properties": {
        "autoShip": {
          "type": "boolean",
          "description": "Allow Step 8 to push and poll the pull request without an operator round trip.",
          "default": false
        },
        "autoMerge": {
          "type": "boolean",
          "description": "Allow Step 8 to merge the pull request once every gate and review thread is clear.",
          "default": false
        }
      },
      "additionalProperties": false
    },
    "scoreMin": {
      "type": "integer",
      "description": "Minimum conformance score (0-10) required before creating delivery commits.",
      "minimum": 0,
      "maximum": 10,
      "default": 8
    },
    "scoring": {
      "type": "object",
      "description": "Configuration for Step 5 LLM-judge conformance scoring (Spec 027).",
      "properties": {
        "judgeCommand": {
          "type": ["string", "null"],
          "default": null,
          "description": "Optional command that judges conformance and writes the verdict JSON. Supports {promptFile}, {verdictFile}, {diffFile}, {criteriaFile}, {slug}, {targetRoot}. When null, the current agent model instance judges and submits the verdict via 'score submit'."
        },
        "judgeModel": {
          "type": ["string", "null"],
          "default": null,
          "description": "Judge model identifier passed to the judge command or the host agent."
        },
        "judgeProvider": {
          "type": ["string", "null"],
          "default": null,
          "description": "Judge provider identifier passed to the judge command or the host agent."
        },
        "judgeEffort": {
          "type": ["string", "null"],
          "default": null,
          "description": "Judge reasoning-effort hint passed to the judge command or the host agent."
        },
        "judgeApiEndpoint": {
          "type": ["string", "null"],
          "default": null,
          "description": "Judge API endpoint passed to the judge command or the host agent."
        },
        "judgeCriticity": {
          "type": "string",
          "enum": ["permissive", "strict", "perfectionist"],
          "default": "strict",
          "description": "Judge strictness: permissive credits partial attempts, strict requires the demanded behaviour, perfectionist requires complete implementation with verification."
        }
      },
      "additionalProperties": false
    },
    "scmCodeReviewEnabled": {
      "type": "boolean",
      "description": "Enable remote pull request review polling loop and automated review comment resolution.",
      "default": false
    },
    "pushDelivery": {
      "type": "boolean",
      "description": "Automatically push the delivery commit and branch to remote origin upon workflow completion.",
      "default": false
    },
    "changelogEnabled": {
      "type": "boolean",
      "description": "Enable appending delivery records to the project changelog. When false, sdw-changelog exits 0 with 'skipped: disabled' and writes nothing.",
      "default": true
    },
    "changelogFile": {
      "type": "string",
      "description": "Path to the project changelog. Supports the {projectRoot} token; the resolved path must stay inside the project root.",
      "default": "{projectRoot}/CHANGELOG.md"
    },
    "stateDir": {
      "type": "string",
      "description": "Path to the directory storing run session state files. Supports tokens {projectRoot} and {skillsRoot}.",
      "default": "{projectRoot}/.sdw/state"
    },
    "sandboxDir": {
      "type": "string",
      "description": "Path to the directory that holds sandbox clones created by sdw-run --sandbox. Defaults to {projectRoot}/.sdw/sandbox; any other value must resolve outside the project root. Supports tokens {projectRoot}, {skillsRoot}, and {temp}.",
      "default": "{projectRoot}/.sdw/sandbox"
    },
    "skillsRoot": {
      "type": "string",
      "description": "Path to the active skills directory. Supports tokens {projectRoot} and {skillsRoot}."
    },
    "autoResolveGaps": {
      "type": "boolean",
      "description": "Automatically apply recommended defaults for unhandled grilling gaps when running non-interactively.",
      "default": true
    },
    "securityChecksEnabled": {
      "type": "boolean",
      "description": "Enable pre-commit secrets and credentials leak scanning.",
      "default": false
    },
    "useWorktrees": {
      "type": "boolean",
      "description": "Enable per-task isolated git worktrees under .sdw/worktrees/{runId}/ for implementation.mode: command.",
      "default": false
    },
    "useFeatureBranches": {
      "type": "boolean",
      "description": "Automatically create and activate an isolated feature branch derived from specification slug.",
      "default": false
    },
    "branching": {
      "type": "object",
      "description": "Branch lane model (spec 00040): the work lane is where feature branches start and where the repository returns after delivery; the integration lane is where the pull request merges. `strategy` selects a preset and every explicit key overrides that preset.",
      "properties": {
        "strategy": {
          "type": "string",
          "enum": ["trunk", "github", "develop", "gitflow", "gitlab"],
          "default": "trunk",
          "description": "Preset: trunk (feature branches start from the checked-out branch), github (work lane mirrors the integration lane), develop (feature branches start from develop; pull requests target the auto-detected integration branch), gitflow (feature branches start from develop and pull requests merge into develop), gitlab (work lane mirrors the integration lane; promotions between environment lanes stay manual)."
        },
        "featurePrefix": {
          "type": "string",
          "default": "feature/",
          "description": "Prefix for the feature branch name: {branching.featurePrefix}{specSlug}."
        },
        "workBranch": {
          "type": ["string", "null"],
          "default": null,
          "description": "Branch where feature branches start and where the repository returns after delivery. null uses the checked-out branch; the github and gitlab presets mirror integrationBranch."
        },
        "integrationBranch": {
          "type": ["string", "null"],
          "default": null,
          "description": "Branch that receives the pull request merge. null means auto: the repository default branch resolved from origin/HEAD."
        },
        "updateWorkBranch": {
          "type": "boolean",
          "default": false,
          "description": "Fetch origin and fast-forward the work branch before creating the feature branch."
        },
        "syncWorkBranchAfterMerge": {
          "type": "boolean",
          "default": false,
          "description": "After the pull request merges, fast-forward the work branch to the integration branch."
        },
        "pushSyncedWorkBranch": {
          "type": "boolean",
          "default": false,
          "description": "Push the synchronized work branch to origin after the post-merge fast-forward."
        }
      },
      "additionalProperties": false
    },
    "scmProvider": {
      "type": "string",
      "enum": ["none", "ado", "github"],
      "default": "none",
      "description": "Configured SCM provider for issues, work items, and pull requests. Allowed: none, ado, github."
    },
    "implementation": {
      "type": "object",
      "description": "Configuration for task implementation execution in Step 4.",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["subagent", "command"],
          "default": "subagent",
          "description": "Implementation execution mode: subagent (sequential host-dispatched workers, one task at a time) or command (automated subprocess per task)."
        },
        "command": {
          "type": ["string", "null"],
          "default": null,
          "description": "Command to execute when implementation.mode is command."
        },
        "timeoutMs": {
          "type": "integer",
          "default": 1800000,
          "description": "Execution timeout in milliseconds for command mode."
        },
        "envAllowlist": {
          "type": "array",
          "items": { "type": "string" },
          "default": ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "LANG", "LC_ALL"],
          "description": "List of allowed environment variable names."
        }
      },
      "additionalProperties": false
    },
    "verification": {
      "type": "object",
      "description": "Configuration for build and test gates in Step 4.",
      "properties": {
        "buildCommand": {
          "type": ["string", "null"],
          "default": "npm run build",
          "description": "Command executed for build verification gate."
        },
        "testCommand": {
          "type": ["string", "null"],
          "default": "npm test",
          "description": "Command executed for test verification gate."
        },
        "timeoutMs": {
          "type": "integer",
          "default": 600000,
          "description": "Execution timeout in milliseconds."
        }
      },
      "additionalProperties": false
    },
    "requiredBuild": {
      "type": "boolean",
      "description": "Enforce successful build verification before creating delivery commit or PR.",
      "default": false
    },
    "runAllTests": {
      "type": "boolean",
      "description": "Enforce passing all test suites before creating delivery commit or PR.",
      "default": false
    },
    "prePrCommand": {
      "type": "string",
      "description": "Optional project-specific shell command to execute before PR preparation (e.g. version bump, lint).",
      "default": ""
    },
    "prePrInstructions": {
      "type": "string",
      "description": "Optional project-specific instructions or checklist for agents to verify prior to PR submission.",
      "default": ""
    },
    "reviewFixCommand": {
      "type": "string",
      "description": "Optional command that applies review-thread fixes. When unset, sdw-ship-pr never resolves active threads automatically.",
      "default": ""
    },
    "maxPreemptions": {
      "type": "integer",
      "minimum": 0,
      "description": "Maximum concurrent-push adaptation budget for post-PR review convergence before draining rounds.",
      "default": 3
    },
    "memory": {
      "type": "object",
      "description": "Product memory backend selection for sdw-memory (central knowledge wrapper). The ws-memo vault is the default integration; local traps file and memory files are fallbacks.",
      "properties": {
        "backends": {
          "type": "object",
          "description": "Enable or disable each memory store backend. Missing keys default to enabled.",
          "properties": {
            "wsMemo": {
              "type": "boolean",
              "description": "Use the ws-memo vault (memo CLI) as the default knowledge store.",
              "default": true
            },
            "traps": {
              "type": "boolean",
              "description": "Use the local .sdw/memory/traps.md table backend.",
              "default": true
            },
            "files": {
              "type": "boolean",
              "description": "Search local MEMORY.md and memory/*.md files (read-only).",
              "default": true
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": true
};

const DEFAULT_DIRECTORY_STRUCTURE = `# SDW Directory Structure & Guidelines

Baseline directory layout for consumer projects adopting Spec-Driven Workflow:

\`\`\`text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and layout rules
    ├── specs/                   # Target directory for canonical specifications
    ├── state/                   # Ephemeral execution run state files (*.state.json)
    │   └── {slug}/{runId}/      # Step artifacts ({slug}-step-{N}.md), dispatch prompts
    │                            # (task-{taskId}.prompt.md), task evidence (task-{taskId}.evidence.json),
    │                            # and Step 5 judge files (step-5-judge.prompt.md, .verdict.json)
    ├── memory/                   # Product knowledge entries (versioned)
    │   └── traps.md              # Central anti-regression trap log
    └── worktrees/               # Ephemeral per-task git worktrees (command mode only)
\`\`\`

## Skills Installation Topologies

SDW supports three installation topologies with automatic \`{skillsRoot}\` token resolution in \`.sdw/config.json\`:

1. **Canonical Development Repository:** \`{projectRoot}/skills/\`
2. **Consumer Project-Local Vendoring:** \`{projectRoot}/.agents/skills/\`
3. **User-Wide Shared Installation (Hybrid Mode):** \`$HOME/.agents/skills/\`

In **Hybrid Mode**, skills are installed once globally under \`$HOME/.agents/skills/\` and shared across all projects on the workstation, while each consumer project strictly maintains its own isolated \`.sdw/\` directory. All configuration (\`.sdw/config.json\`), specs (\`.sdw/specs/\`), and run states (\`.sdw/state/\`) remain local to the consumer repository and never leak into global storage.
`;

function validateConfigSchema(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Configuration must be a JSON object.'] };
  }

  // Required properties
  if (!('specsDir' in config)) {
    errors.push('Missing required property "specsDir".');
  } else if (typeof config.specsDir !== 'string' || config.specsDir.trim().length === 0) {
    errors.push('Property "specsDir" must be a non-empty string.');
  }

  // scoreMin
  if ('scoreMin' in config) {
    if (typeof config.scoreMin !== 'number' || !Number.isInteger(config.scoreMin) || config.scoreMin < 0 || config.scoreMin > 10) {
      errors.push('Property "scoreMin" must be an integer between 0 and 10.');
    }
  }

  // scoring (Spec 027)
  if ('scoring' in config) {
    if (!config.scoring || typeof config.scoring !== 'object' || Array.isArray(config.scoring)) {
      errors.push('Property "scoring" must be an object.');
    } else {
      for (const key of ['judgeCommand', 'judgeModel', 'judgeProvider', 'judgeEffort', 'judgeApiEndpoint']) {
        if (key in config.scoring && config.scoring[key] !== null && typeof config.scoring[key] !== 'string') {
          errors.push(`Property "scoring.${key}" must be a string or null.`);
        }
      }
      if ('judgeCriticity' in config.scoring) {
        const allowedCriticity = ['permissive', 'strict', 'perfectionist'];
        if (typeof config.scoring.judgeCriticity !== 'string' || !allowedCriticity.includes(config.scoring.judgeCriticity)) {
          errors.push(`Property "scoring.judgeCriticity" must be one of: ${allowedCriticity.join(', ')}.`);
        }
      }
    }
  }

  // scmCodeReviewEnabled
  if ('scmCodeReviewEnabled' in config) {
    if (typeof config.scmCodeReviewEnabled !== 'boolean') {
      errors.push('Property "scmCodeReviewEnabled" must be a boolean.');
    }
  }

  // stateDir
  if ('stateDir' in config) {
    if (typeof config.stateDir !== 'string' || config.stateDir.trim().length === 0) {
      errors.push('Property "stateDir" must be a string.');
    }
  }

  // sandboxDir
  if ('sandboxDir' in config) {
    if (typeof config.sandboxDir !== 'string' || config.sandboxDir.trim().length === 0) {
      errors.push('Property "sandboxDir" must be a string.');
    }
  }

  // skillsRoot
  if ('skillsRoot' in config) {
    if (typeof config.skillsRoot !== 'string' || config.skillsRoot.trim().length === 0) {
      errors.push('Property "skillsRoot" must be a string.');
    }
  }

  // autoResolveGaps
  if ('autoResolveGaps' in config) {
    if (typeof config.autoResolveGaps !== 'boolean') {
      errors.push('Property "autoResolveGaps" must be a boolean.');
    }
  }

  // securityChecksEnabled
  if ('securityChecksEnabled' in config) {
    if (typeof config.securityChecksEnabled !== 'boolean') {
      errors.push('Property "securityChecksEnabled" must be a boolean.');
    }
  }

  // useWorktrees
  if ('useWorktrees' in config) {
    if (typeof config.useWorktrees !== 'boolean') {
      errors.push('Property "useWorktrees" must be a boolean.');
    }
  }

  // useFeatureBranches
  if ('useFeatureBranches' in config) {
    if (typeof config.useFeatureBranches !== 'boolean') {
      errors.push('Property "useFeatureBranches" must be a boolean.');
    }
  }

  // branching (AC1-AC5)
  if ('branching' in config) {
    if (!config.branching || typeof config.branching !== 'object' || Array.isArray(config.branching)) {
      errors.push('Property "branching" must be an object.');
    } else {
      const allowedBranchingKeys = ['strategy', 'featurePrefix', 'workBranch', 'integrationBranch', 'updateWorkBranch', 'syncWorkBranchAfterMerge', 'pushSyncedWorkBranch'];
      for (const key of Object.keys(config.branching)) {
        if (!allowedBranchingKeys.includes(key)) {
          errors.push(`Property "branching.${key}" is not a recognized key. Expected one of: ${allowedBranchingKeys.join(', ')}.`);
        }
      }
      if ('strategy' in config.branching) {
        const allowedStrategies = Object.keys(BRANCHING_PRESETS);
        const strategy = config.branching.strategy;
        if (typeof strategy !== 'string') {
          errors.push(`Property "branching.strategy" must be a string; allowed values: ${allowedStrategies.join(', ')}.`);
        } else if (!allowedStrategies.includes(strategy)) {
          errors.push(`Property "branching.strategy" must be one of: ${allowedStrategies.join(', ')}; got unknown value "${strategy}".`);
        }
      }
      for (const key of ['featurePrefix', 'workBranch', 'integrationBranch']) {
        if (!(key in config.branching)) continue;
        const value = config.branching[key];
        if (value === null && key !== 'featurePrefix') continue;
        if (typeof value !== 'string') {
          errors.push(`Property "branching.${key}" must be a string${key === 'featurePrefix' ? '' : ' or null'}.`);
        }
      }
      for (const key of ['updateWorkBranch', 'syncWorkBranchAfterMerge', 'pushSyncedWorkBranch']) {
        if (key in config.branching && typeof config.branching[key] !== 'boolean') {
          errors.push(`Property "branching.${key}" must be a boolean.`);
        }
      }
    }
  }

  // scmProvider (AC1, AC2)
  if ('scmProvider' in config) {
    const allowed = ['none', 'ado', 'github'];
    if (typeof config.scmProvider !== 'string' || !allowed.includes(config.scmProvider)) {
      errors.push(`Property "scmProvider" must be one of: ${allowed.join(', ')}.`);
    }
  }

  // implementation (AC1, AC2, AC27, AC34)
  if ('implementation' in config) {
    if (!config.implementation || typeof config.implementation !== 'object' || Array.isArray(config.implementation)) {
      errors.push('Property "implementation" must be an object.');
    } else {
      if ('mode' in config.implementation) {
        const allowedModes = ['subagent', 'command'];
        if (typeof config.implementation.mode !== 'string' || !allowedModes.includes(config.implementation.mode)) {
          const remediation = String(config.implementation.mode) === 'handoff'
            ? ' The "handoff" mode was replaced by "subagent"; set implementation.mode to "subagent".'
            : '';
          errors.push(`Property "implementation.mode" must be one of: ${allowedModes.join(', ')}.${remediation}`);
        }
      }
      if (config.implementation.mode === 'command') {
        if (!config.implementation.command || typeof config.implementation.command !== 'string' || config.implementation.command.trim().length === 0) {
          errors.push('Property "implementation.command" must be a non-empty string when implementation.mode is "command".');
        }
      }
      if ('timeoutMs' in config.implementation) {
        if (typeof config.implementation.timeoutMs !== 'number' || config.implementation.timeoutMs <= 0) {
          errors.push('Property "implementation.timeoutMs" must be a positive integer.');
        }
      }
      if ('envAllowlist' in config.implementation) {
        if (!Array.isArray(config.implementation.envAllowlist) || !config.implementation.envAllowlist.every(e => typeof e === 'string')) {
          errors.push('Property "implementation.envAllowlist" must be an array of strings.');
        }
      }
    }
  }

  // verification
  if ('verification' in config) {
    if (!config.verification || typeof config.verification !== 'object' || Array.isArray(config.verification)) {
      errors.push('Property "verification" must be an object.');
    } else {
      if ('buildCommand' in config.verification && config.verification.buildCommand !== null) {
        if (typeof config.verification.buildCommand !== 'string') {
          errors.push('Property "verification.buildCommand" must be a string or null.');
        }
      }
      if ('testCommand' in config.verification && config.verification.testCommand !== null) {
        if (typeof config.verification.testCommand !== 'string') {
          errors.push('Property "verification.testCommand" must be a string or null.');
        }
      }
      if ('timeoutMs' in config.verification) {
        if (typeof config.verification.timeoutMs !== 'number' || config.verification.timeoutMs <= 0) {
          errors.push('Property "verification.timeoutMs" must be a positive integer.');
        }
      }
    }
  }

  // pushDelivery
  if ('pushDelivery' in config) {
    if (typeof config.pushDelivery !== 'boolean') {
      errors.push('Property "pushDelivery" must be a boolean.');
    }
  }

  // changelogEnabled / changelogFile (AC12)
  if ('changelogEnabled' in config) {
    if (typeof config.changelogEnabled !== 'boolean') {
      errors.push('Property "changelogEnabled" must be a boolean.');
    }
  }
  if ('changelogFile' in config) {
    if (typeof config.changelogFile !== 'string' || config.changelogFile.trim().length === 0) {
      errors.push('Property "changelogFile" must be a non-empty string.');
    }
  }

  // requiredBuild
  if ('requiredBuild' in config) {
    if (typeof config.requiredBuild !== 'boolean') {
      errors.push('Property "requiredBuild" must be a boolean.');
    } else if (config.requiredBuild === true) {
      const buildCmd = config.verification && config.verification.buildCommand;
      if (!buildCmd || typeof buildCmd !== 'string' || buildCmd.trim().length === 0) {
        errors.push('Missing required build command: "requiredBuild" is true but "verification.buildCommand" is not specified.');
      }
    }
  }

  // The top-level command keys are gone: verification.* is the single source.
  if ('buildCommand' in config) {
    errors.push('Property "buildCommand" was replaced by "verification.buildCommand".');
  }

  // runAllTests
  if ('runAllTests' in config) {
    if (typeof config.runAllTests !== 'boolean') {
      errors.push('Property "runAllTests" must be a boolean.');
    } else if (config.runAllTests === true) {
      const testCmd = config.verification && config.verification.testCommand;
      if (!testCmd || typeof testCmd !== 'string' || testCmd.trim().length === 0) {
        errors.push('Missing required test command: "runAllTests" is true but "verification.testCommand" is not specified.');
      }
    }
  }

  // The top-level command keys are gone: verification.* is the single source.
  if ('testCommand' in config) {
    errors.push('Property "testCommand" was replaced by "verification.testCommand".');
  }

  // prePrCommand
  if ('prePrCommand' in config) {
    if (typeof config.prePrCommand !== 'string') {
      errors.push('Property "prePrCommand" must be a string.');
    }
  }

  // prePrInstructions
  if ('prePrInstructions' in config) {
    if (typeof config.prePrInstructions !== 'string') {
      errors.push('Property "prePrInstructions" must be a string.');
    }
  }

  // reviewFixCommand
  if ('reviewFixCommand' in config) {
    if (typeof config.reviewFixCommand !== 'string') {
      errors.push('Property "reviewFixCommand" must be a string.');
    }
  }

  // maxPreemptions
  if ('maxPreemptions' in config) {
    if (typeof config.maxPreemptions !== 'number' || !Number.isInteger(config.maxPreemptions) || config.maxPreemptions < 0) {
      errors.push('Property "maxPreemptions" must be a non-negative integer.');
    }
  }

  // memory
  if ('memory' in config) {
    if (!config.memory || typeof config.memory !== 'object' || Array.isArray(config.memory)) {
      errors.push('Property "memory" must be an object.');
    } else if ('backends' in config.memory) {
      if (!config.memory.backends || typeof config.memory.backends !== 'object' || Array.isArray(config.memory.backends)) {
        errors.push('Property "memory.backends" must be an object.');
      } else {
        for (const key of ['wsMemo', 'traps', 'files']) {
          if (key in config.memory.backends && typeof config.memory.backends[key] !== 'boolean') {
            errors.push(`Property "memory.backends.${key}" must be a boolean.`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function loadConfig(targetRoot, options = {}) {
  const root = targetRoot ? path.resolve(targetRoot) : findProjectRoot(process.cwd());
  const normalizedRoot = normalizePath(root);
  const configFile = path.join(root, '.sdw', 'config.json');

  let rawConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      // Fallback
    }
  }

  // verification.* is the single command source: a legacy flat key that reached
  // loadConfig would be ignored by every gate and the run would silently fall
  // back to the built-in default, so it fails fast instead.
  for (const legacy of ['buildCommand', 'testCommand']) {
    if (rawConfig && Object.prototype.hasOwnProperty.call(rawConfig, legacy)) {
      throw new Error(`Property "${legacy}" was replaced by "verification.${legacy}". Update ${normalizePath(configFile)}.`);
    }
  }

  const configuredSkillsRoot = rawConfig && typeof rawConfig.skillsRoot === 'string' && rawConfig.skillsRoot.trim()
    ? normalizePath(path.resolve(root, rawConfig.skillsRoot.trim().replace(/\{projectRoot\}/g, normalizedRoot)))
    : undefined;
  const skillsInfo = resolveSkillsRoot({
    root,
    ...options,
    skillsRoot: options.skillsRoot || process.env.SDW_SKILLS_ROOT || configuredSkillsRoot
  });
  const resolvedSkillsRoot = skillsInfo ? skillsInfo.skillsRoot : normalizedRoot;

  const merged = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    implementation: {
      ...DEFAULT_CONFIG.implementation,
      ...((rawConfig && rawConfig.implementation) || {})
    },
    verification: {
      ...DEFAULT_CONFIG.verification,
      ...((rawConfig && rawConfig.verification) || {})
    }
  };
  const resolved = {};

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') {
      resolved[key] = value
        .replace(/\{projectRoot\}/g, normalizedRoot)
        .replace(/\{skillsRoot\}/g, resolvedSkillsRoot)
        .replace(/\{temp\}/g, normalizePath(os.tmpdir()));
    } else {
      resolved[key] = value;
    }
  }

  return {
    ...resolved,
    projectRoot: normalizedRoot,
    skillsRoot: resolvedSkillsRoot,
    skillsMode: skillsInfo ? skillsInfo.mode : 'unknown',
    raw: rawConfig,
    resolved
  };
}

function cmdInit(options) {
  const targetRoot = options.root ? path.resolve(options.root) : process.cwd();
  const sdwDir = path.join(targetRoot, '.sdw');
  const specsDir = path.join(sdwDir, 'specs');
  const stateDir = path.join(sdwDir, 'state');
  const configFile = path.join(sdwDir, 'config.json');
  const schemaFile = path.join(sdwDir, 'config.schema.json');
  const structureFile = path.join(sdwDir, 'directory-structure.md');

  const created = [];
  const skipped = [];

  if (!fs.existsSync(sdwDir)) {
    fs.mkdirSync(sdwDir, { recursive: true });
    created.push('.sdw/');
  }

  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
    created.push('.sdw/specs/');
  }

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
    created.push('.sdw/state/');
  }

  if (!fs.existsSync(schemaFile) || options.force) {
    fs.writeFileSync(schemaFile, JSON.stringify(DEFAULT_SCHEMA, null, 2) + '\n', 'utf8');
    created.push('.sdw/config.schema.json');
  } else {
    skipped.push('.sdw/config.schema.json (already exists)');
  }

  if (!fs.existsSync(configFile) || options.force) {
    fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    created.push('.sdw/config.json');
  } else {
    skipped.push('.sdw/config.json (already exists)');
  }

  if (!fs.existsSync(structureFile) || options.force) {
    fs.writeFileSync(structureFile, DEFAULT_DIRECTORY_STRUCTURE, 'utf8');
    created.push('.sdw/directory-structure.md');
  } else {
    skipped.push('.sdw/directory-structure.md (already exists)');
  }

  const skillsInfo = resolveSkillsRoot({ root: targetRoot, ...options });
  const result = {
    success: true,
    root: normalizePath(targetRoot),
    skillsRoot: skillsInfo ? skillsInfo.skillsRoot : null,
    skillsMode: skillsInfo ? skillsInfo.mode : null,
    created,
    skipped
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[sdw-config init] Initialized .sdw at ${normalizePath(targetRoot)}`);
    if (skillsInfo) {
      console.log(`[sdw-config init] Resolved skillsRoot: ${skillsInfo.skillsRoot} (Mode: ${skillsInfo.mode})`);
    }
    if (created.length > 0) {
      console.log('Created:');
      created.forEach(f => console.log(`  + ${f}`));
    }
    if (skipped.length > 0) {
      console.log('Skipped (use --force to overwrite):');
      skipped.forEach(f => console.log(`  = ${f}`));
    }
  }

  return 0;
}

function cmdCheck(options) {
  const targetRoot = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const sdwDir = path.join(targetRoot, '.sdw');
  const configFile = path.join(sdwDir, 'config.json');
  const structureFile = path.join(sdwDir, 'directory-structure.md');

  const checks = [];
  const errors = [];
  let valid = true;

  // 1. Check .sdw directory
  const sdwExists = fs.existsSync(sdwDir) && fs.statSync(sdwDir).isDirectory();
  checks.push({
    name: 'sdw_directory_exists',
    target: '.sdw/',
    passed: sdwExists
  });
  if (!sdwExists) {
    valid = false;
    errors.push('Missing .sdw directory. Run "sdw-config init" to create it.');
  }

  // 2. Check config.json exists
  const configExists = fs.existsSync(configFile);
  checks.push({
    name: 'config_file_exists',
    target: '.sdw/config.json',
    passed: configExists
  });
  if (!configExists) {
    valid = false;
    errors.push('Missing .sdw/config.json file.');
  }

  // 3. Parse config.json if it exists
  let parsedConfig = null;
  if (configExists) {
    try {
      const raw = fs.readFileSync(configFile, 'utf8');
      parsedConfig = JSON.parse(raw);
      checks.push({
        name: 'config_json_valid_syntax',
        target: '.sdw/config.json',
        passed: true
      });
    } catch (err) {
      valid = false;
      checks.push({
        name: 'config_json_valid_syntax',
        target: '.sdw/config.json',
        passed: false,
        detail: err.message
      });
      errors.push(`.sdw/config.json syntax error: ${err.message}`);
    }
  }

  // 3.5 Check config.schema.json exists
  const schemaFile = path.join(sdwDir, 'config.schema.json');
  const schemaExists = fs.existsSync(schemaFile);
  checks.push({
    name: 'config_schema_file_exists',
    target: '.sdw/config.schema.json',
    passed: schemaExists
  });
  if (!schemaExists) {
    valid = false;
    errors.push('Missing .sdw/config.schema.json schema file.');
  }

  // 3.6 Validate parsed config.json against schema
  if (parsedConfig) {
    const schemaValidation = validateConfigSchema(parsedConfig);
    checks.push({
      name: 'config_schema_validation',
      target: '.sdw/config.json',
      passed: schemaValidation.valid,
      detail: schemaValidation.errors.length > 0 ? schemaValidation.errors.join('; ') : undefined
    });
    if (!schemaValidation.valid) {
      valid = false;
      errors.push(...schemaValidation.errors);
    }
  }

  // Pre-resolve skillsInfo so {skillsRoot} can be expanded across checks (AC1, AC6)
  const configuredSkillsRoot = parsedConfig && typeof parsedConfig.skillsRoot === 'string' && parsedConfig.skillsRoot.trim()
    ? normalizePath(path.resolve(targetRoot, parsedConfig.skillsRoot.trim().replace(/\{projectRoot\}/g, normalizePath(targetRoot))))
    : undefined;
  const checkOptions = {
    root: targetRoot,
    ...options,
    skillsRoot: options.skillsRoot || process.env.SDW_SKILLS_ROOT || configuredSkillsRoot
  };
  if (options.callerDir === undefined && options.ignoreCaller === undefined) {
    const enclosing = findEnclosingSkillsDir(__dirname);
    const normTarget = normalizePath(targetRoot);
    const normEnclosing = enclosing ? normalizePath(enclosing) : '';
    const home = normalizePath(options.homeDir || os.homedir());
    const globalSkills = home ? normalizePath(path.join(home, '.agents', 'skills')) : '';
    const isGlobal = Boolean(globalSkills) && (normEnclosing === globalSkills || normEnclosing.startsWith(`${globalSkills}/`));
    if (normEnclosing && !normEnclosing.startsWith(normTarget) && !isGlobal) {
      checkOptions.callerDir = null;
    }
  }
  const skillsInfo = resolveSkillsRoot(checkOptions);

  // 4. Validate specsDir key and path
  if (parsedConfig) {
    const hasSpecsDir = typeof parsedConfig.specsDir === 'string' && parsedConfig.specsDir.trim().length > 0;
    checks.push({
      name: 'specs_dir_property_present',
      target: 'specsDir in config.json',
      passed: hasSpecsDir
    });

    if (!hasSpecsDir) {
      valid = false;
      errors.push('config.json missing required string property "specsDir".');
    } else {
      const resolvedSpecs = parsedConfig.specsDir
        .replace(/\{projectRoot\}/g, normalizePath(targetRoot))
        .replace(/\{skillsRoot\}/g, skillsInfo ? skillsInfo.skillsRoot : normalizePath(targetRoot));
      const specsExists = fs.existsSync(resolvedSpecs) && fs.statSync(resolvedSpecs).isDirectory();
      checks.push({
        name: 'specs_dir_exists_on_disk',
        target: resolvedSpecs,
        passed: specsExists
      });
      if (!specsExists) {
        valid = false;
        errors.push(`Configured specsDir does not exist on disk: ${resolvedSpecs}`);
      }
    }

    // 4.4 Validate sandboxDir placement: custom roots must live outside the project.
    if (typeof parsedConfig.sandboxDir === 'string' && parsedConfig.sandboxDir.trim()) {
      try {
        const resolvedSandbox = resolveSandboxPath(targetRoot, parsedConfig.sandboxDir, skillsInfo ? skillsInfo.skillsRoot : undefined);
        checks.push({
          name: 'sandbox_dir_location',
          target: normalizePath(resolvedSandbox),
          passed: true,
          detail: isPathInside(resolvedSandbox, targetRoot) ? 'default in-project location' : 'outside project root'
        });
      } catch (sandboxErr) {
        valid = false;
        errors.push(sandboxErr.message);
        checks.push({
          name: 'sandbox_dir_location',
          target: parsedConfig.sandboxDir,
          passed: false,
          detail: sandboxErr.message
        });
      }
    }

    // 4.5 Validate scmProvider CLI presence and authentication status (AC16)
    const provider = parsedConfig.scmProvider || 'none';
    const executor = typeof options.executor === 'function'
      ? options.executor
      : ((cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (provider === 'none') {
      checks.push({
        name: 'scm_provider_status',
        target: 'scmProvider: none',
        passed: true,
        detail: 'SCM integration disabled (none)'
      });
    } else if (provider === 'github' || provider === 'ado') {
      const binName = provider === 'github' ? 'gh' : 'az';
      let installed = false;
      try {
        const probeCmd = process.platform === 'win32' ? `where ${binName}` : `command -v ${binName}`;
        const out = executor(probeCmd);
        installed = Boolean(out && out.trim());
      } catch (e) {
        installed = false;
      }
      checks.push({
        name: `scm_cli_presence_${binName}`,
        target: `CLI: ${binName}`,
        passed: installed,
        detail: installed ? `${binName} is installed on PATH` : `${binName} is NOT installed on PATH`
      });
      if (!installed) {
        valid = false;
        errors.push(`Configured SCM provider "${provider}" requires CLI "${binName}", but it is not installed on PATH.`);
      } else {
        let authenticated = false;
        try {
          const authCmd = binName === 'gh' ? 'gh auth status' : 'az account show';
          executor(authCmd);
          authenticated = true;
        } catch (e) {
          authenticated = false;
        }
        checks.push({
          name: `scm_cli_authenticated_${binName}`,
          target: `CLI auth: ${binName}`,
          passed: authenticated,
          detail: authenticated ? `${binName} is authenticated` : `${binName} is NOT authenticated`
        });
        if (!authenticated) {
          valid = false;
          errors.push(`Configured SCM provider "${provider}" CLI "${binName}" is not authenticated.`);
        }
      }
    } else {
      valid = false;
      checks.push({
        name: 'scm_provider_status',
        target: `scmProvider: ${provider}`,
        passed: false,
        detail: `Unsupported or invalid SCM provider: ${provider}`
      });
      if (!errors.some(e => e.includes('scmProvider'))) {
        errors.push(`Property "scmProvider" must be one of: none, ado, github.`);
      }
    }
  }

  // 5. Check directory-structure.md exists
  const structureExists = fs.existsSync(structureFile);
  checks.push({
    name: 'directory_structure_doc_exists',
    target: '.sdw/directory-structure.md',
    passed: structureExists
  });
  if (!structureExists) {
    valid = false;
    errors.push('Missing .sdw/directory-structure.md documentation.');
  }

  // 6. Check skillsRoot resolution (AC6, AC9)
  const hasSkills = Boolean(skillsInfo && skillsInfo.exists);
  const skillsDetail = hasSkills
    ? `Mode: ${skillsInfo.mode} (${skillsInfo.skillsRoot})`
    : (skillsInfo && skillsInfo.error ? skillsInfo.error : 'Missing skills directory on disk');
  checks.push({
    name: 'skills_root_resolution',
    target: hasSkills ? skillsInfo.skillsRoot : (skillsInfo && skillsInfo.skillsRoot ? skillsInfo.skillsRoot : 'none'),
    passed: hasSkills,
    detail: skillsDetail
  });
  if (!hasSkills) {
    valid = false;
    if (skillsInfo && skillsInfo.error) errors.push(skillsInfo.error);
    errors.push('No valid skills directory found on disk (checked project-local and global $HOME/.agents/skills).');
  }

  const result = {
    valid,
    root: normalizePath(targetRoot),
    skillsRoot: skillsInfo ? skillsInfo.skillsRoot : null,
    skillsMode: skillsInfo ? skillsInfo.mode : null,
    checks,
    errors
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[sdw-config check] Target root: ${normalizePath(targetRoot)}`);
    if (skillsInfo) {
      console.log(`[sdw-config check] Skills root: ${skillsInfo.skillsRoot} (Mode: ${skillsInfo.mode})`);
    }
    console.log(`Status: ${valid ? 'PASS' : 'FAIL'}`);
    console.log('\nChecks:');
    checks.forEach(c => {
      const mark = c.passed ? '[PASS]' : '[FAIL]';
      console.log(`  ${mark} ${c.name} (${c.target})`);
      if (c.detail) console.log(`         Detail: ${c.detail}`);
    });
    if (errors.length > 0) {
      console.log('\nErrors:');
      errors.forEach(e => console.log(`  ! ${e}`));
    }
  }

  return valid ? 0 : 1;
}

function cmdParse(options) {
  const targetRoot = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const sdwDir = path.join(targetRoot, '.sdw');
  const configFile = path.join(sdwDir, 'config.json');

  if (!fs.existsSync(configFile)) {
    const err = { error: `Missing config file at ${normalizePath(configFile)}` };
    if (options.json) {
      console.log(JSON.stringify(err, null, 2));
    } else {
      console.error(`[sdw-config parse] Error: ${err.error}`);
    }
    return 1;
  }

  let rawConfig;
  try {
    rawConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    const errorRes = { error: `Invalid JSON in ${normalizePath(configFile)}: ${err.message}` };
    if (options.json) {
      console.log(JSON.stringify(errorRes, null, 2));
    } else {
      console.error(`[sdw-config parse] Error: ${errorRes.error}`);
    }
    return 1;
  }

  const normalizedRoot = normalizePath(targetRoot);
  const configuredSkillsRoot = rawConfig && typeof rawConfig.skillsRoot === 'string' && rawConfig.skillsRoot.trim()
    ? normalizePath(path.resolve(targetRoot, rawConfig.skillsRoot.trim().replace(/\{projectRoot\}/g, normalizedRoot)))
    : undefined;
  const skillsInfo = resolveSkillsRoot({
    root: targetRoot,
    ...options,
    skillsRoot: options.skillsRoot || process.env.SDW_SKILLS_ROOT || configuredSkillsRoot
  });
  const resolvedSkillsRoot = skillsInfo ? skillsInfo.skillsRoot : normalizedRoot;
  const resolved = {};

  for (const [key, value] of Object.entries(rawConfig)) {
    if (typeof value === 'string') {
      resolved[key] = value
        .replace(/\{projectRoot\}/g, normalizedRoot)
        .replace(/\{skillsRoot\}/g, resolvedSkillsRoot)
        .replace(/\{temp\}/g, normalizePath(os.tmpdir()));
    } else {
      resolved[key] = value;
    }
  }

  if (options.key) {
    if (options.key === 'skillsRoot' && !(options.key in resolved)) {
      resolved.skillsRoot = resolvedSkillsRoot;
    }
    if (options.key === 'skillsMode' && !(options.key in resolved)) {
      resolved.skillsMode = skillsInfo ? skillsInfo.mode : 'unknown';
    }
    if (options.key in resolved) {
      if (options.json) {
        console.log(JSON.stringify({ [options.key]: resolved[options.key] }, null, 2));
      } else {
        console.log(resolved[options.key]);
      }
      return 0;
    } else {
      const err = { error: `Key "${options.key}" not found in config` };
      if (options.json) {
        console.log(JSON.stringify(err, null, 2));
      } else {
        console.error(`[sdw-config parse] Error: ${err.error}`);
      }
      return 1;
    }
  }

  const output = {
    projectRoot: normalizedRoot,
    skillsRoot: resolvedSkillsRoot,
    skillsMode: skillsInfo ? skillsInfo.mode : 'unknown',
    raw: rawConfig,
    resolved
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[sdw-config parse] Project Root: ${normalizedRoot}`);
    console.log(`[sdw-config parse] Skills Root: ${resolvedSkillsRoot} (${skillsInfo ? skillsInfo.mode : 'unknown'})`);
    console.log('\nResolved Configuration:');
    for (const [k, v] of Object.entries(resolved)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  return 0;
}

function showHelp() {
  console.log(`Usage: node sdw_config.cjs <subcommand> [options]

Subcommands:
  init     Scaffold .sdw directory and default files in project root
  check    Verify .sdw directory structure, config syntax, and paths
  parse    Parse and resolve .sdw/config.json with {projectRoot} and {skillsRoot} tokens

Options:
  --root <path>        Explicit project root directory (default: auto-detected)
  --skills-root <path> Explicit skills root directory (default: auto-detected)
  --force              Overwrite existing files on init
  --json               Output results in JSON format
  --key <name>         (parse only) Extract a single resolved config key
  -h, --help           Show this help message
`);
}

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.subcommand || options.subcommand === 'help' || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(args.includes('-h') || args.includes('--help') || options.subcommand === 'help' ? 0 : 1);
  }

  let exitCode = 0;
  switch (options.subcommand) {
    case 'init':
      exitCode = cmdInit(options);
      break;
    case 'check':
      exitCode = cmdCheck(options);
      break;
    case 'parse':
      exitCode = cmdParse(options);
      break;
    default:
      console.error(`Unknown subcommand: "${options.subcommand}". Available: init, check, parse`);
      showHelp();
      exitCode = 1;
      break;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdInit,
  cmdCheck,
  cmdParse,
  loadConfig,
  validateConfigSchema,
  resolveBranching,
  resolveSkillsRoot,
  hasSdwSkills,
  findEnclosingSkillsDir,
  detectSkillsMode,
  DEFAULT_CONFIG,
  DEFAULT_SCHEMA,
  findProjectRoot,
  normalizePath,
  isPathInside,
  resolveSandboxPath,
  showHelp
};
