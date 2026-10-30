# .sdw Configuration & Directory Structure Reference

## 1. Directory Structure

Consumer projects following the Spec-Driven Workflow (SDW) standard store project-level workflow assets inside the `.sdw/` folder located at the project root:

```text
{projectRoot}/
└── .sdw/
    ├── config.json              # Main project workflow configuration
    ├── config.schema.json       # JSON Schema definition for config.json validation
    ├── directory-structure.md   # Structural guidelines and layout rules
    ├── specs/                   # Target directory for canonical specifications
    └── state/                   # Ephemeral execution run state files (*.state.json)
```

### 1.1 Components

- **`.sdw/config.json`**: Primary JSON configuration file defining paths and behaviors for SDW skills and tools.
- **`.sdw/config.schema.json`**: JSON Schema draft-07 specification validating `config.json`.
- **`.sdw/directory-structure.md`**: Textual specification and inventory of the directory hierarchy.
- **`.sdw/specs/`**: Default repository for feature specifications formatted with YAML frontmatter, EARS acceptance criteria, and Definition of Ready.
- **`.sdw/state/`**: Isolated session state files (`run-*.state.json`) recording execution progress, conformance scores, and DAG tasks.

---

## 2. Configuration Schema (`config.json`)

The configuration file `.sdw/config.json` conforms to `config.schema.json`:

```json
{
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
    "scoreMin": {
      "type": "integer",
      "description": "Minimum conformance score (0-10) required before creating delivery commits.",
      "minimum": 0,
      "maximum": 10,
      "default": 8
    },
    "retro": {
      "type": "object",
      "description": "Automatic retrospective after a run reaches completed (spec 00045).",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": false,
          "description": "When true, sdw-run runs sdw-retro for the completed run and records the outcome in state.retro. When false or absent, it prints the advisory retro command only."
        },
        "followUp": {
          "type": "string",
          "enum": [
            "queue",
            "record",
            "none"
          ],
          "default": "queue",
          "description": "sdw-batch policy for the retrospective candidates of a completed item: queue (create draft specs for critical/high candidates and append them to the batch queue), record (write .sdw/state/batch-{batchId}.followups.md and create nothing), or none (read no report). Follow-up items (followUpDepth 1) still record their candidate summary but never queue more specifications."
        },
        "transcripts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": [],
          "description": "Explicit transcript files the retrospective scans line by line for sdw-run command signatures. Supports the {projectRoot} token; project-relative paths stay inside the project root. Empty by default: transcripts are never discovered."
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
      "description": "Enable per-task isolated git worktrees for dispatched subagents under .sdw/worktrees/{runId}/.",
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
    "requiredBuild": {
      "type": "boolean",
      "description": "Enforce successful build verification in Step 8 before creating delivery commit or PR.",
      "default": false
    },
    "runAllTests": {
      "type": "boolean",
      "description": "Enforce passing all test suites in Step 8 before creating delivery commit or PR.",
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
}
```

### 2.1 Supported Properties

| Key | Type | Default | Description |
|:---|:---|:---|:---|
| `$schema` | `string` | `"./config.schema.json"` | Schema definition reference for editor autocomplete and validation |
| `specsDir` | `string` | `"{projectRoot}/.sdw/specs"` | Path to specifications directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `scoreMin` | `integer` | `8` | Minimum acceptable conformance score (range: 0–10) |
| `scoring.judgeCommand` | `string \| null` | `null` | Optional judge command that writes the Step 5 verdict JSON. Supports `{promptFile}`, `{verdictFile}`, `{diffFile}`, `{criteriaFile}`, `{slug}`, `{targetRoot}`. When unset, the current agent model instance judges via `score submit`. Env fallback: `SDW_JUDGE_COMMAND` |
| `scoring.judgeModel` | `string \| null` | `null` | Judge model identifier passed to the judge command or host agent |
| `scoring.judgeProvider` | `string \| null` | `null` | Judge provider identifier passed to the judge command or host agent |
| `scoring.judgeEffort` | `string \| null` | `null` | Judge reasoning-effort hint passed to the judge command or host agent |
| `scoring.judgeApiEndpoint` | `string \| null` | `null` | Judge API endpoint passed to the judge command or host agent |
| `scoring.judgeCriticity` | `string` | `"strict"` | Judge strictness: `permissive`, `strict`, or `perfectionist` |
| `retro.enabled` | `boolean` | `false` | Run `sdw-retro` automatically when a run reaches `completed` and record the outcome in `state.retro` (status, report paths, error). When `false` or absent, sdw-run prints the advisory retro command only. This repository enables it. |
| `retro.followUp` | `string` | `"queue"` | `sdw-batch` policy for a completed item's retrospective candidates: `queue` creates one draft specification per `critical`/`high` candidate and appends it after the remaining queue items; `record` writes `.sdw/state/batch-{batchId}.followups.md` and creates no specification; `none` reads no report. Follow-up items record `followUpDepth: 1`; their candidates are summarized but never queued. |
| `retro.transcripts` | `string[]` | `[]` | Explicit transcript files the retrospective scans line by line for `sdw-run run` and `resume` signatures; each is listed under report inputs with its line count. Supports `{projectRoot}`; empty by default, so transcripts are never discovered. A missing path produces a `transcript_unreadable` signal and the retro still exits `0`. |
| `implementation.mode` | `string` | `"subagent"` | Step 4 mode: `subagent` (sequential host-dispatched workers) or `command` (automated subprocess per task). `handoff` was replaced by `subagent` |
| `implementation.command` | `string \| null` | `null` | Required when `implementation.mode` is `command`; supports `{taskId}`, `{promptFile}`, `{evidenceFile}`, `{workingDir}`, `{targetRoot}`, `{slug}` |
| `implementation.timeoutMs` | `integer` | `1800000` | Per-task execution timeout for `command` mode |
| `scmCodeReviewEnabled` | `boolean` | `false` | Whether remote PR comment polling and automated fix resolution loop is active |
| `pushDelivery` | `boolean` | `false` | Whether to automatically push delivery commits to remote origin |
| `changelogEnabled` | `boolean` | `true` | Enable appending delivery records to the project changelog; `false` skips the append with exit `0` and writes nothing |
| `changelogFile` | `string` | `"{projectRoot}/CHANGELOG.md"` | Changelog path; supports `{projectRoot}` and must resolve inside the project root |
| `stateDir` | `string` | `"{projectRoot}/.sdw/state"` | Path to isolated execution run state directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `sandboxDir` | `string` | `"{projectRoot}/.sdw/sandbox"` | Root directory for `sdw-run --sandbox` clones; each run creates `{sandboxDir}/{runId}/repo`. Supports `{projectRoot}`, `{skillsRoot}`, and `{temp}` (OS temp directory). A custom value must resolve **outside** the project root; only the default may live inside it |
| `skillsRoot` | `string` | — | Path to the active skills directory (supports `{projectRoot}` and `{skillsRoot}`) |
| `autoResolveGaps` | `boolean` | `true` | Whether to auto-apply recommended grilling defaults when non-interactive |
| `securityChecksEnabled` | `boolean` | `false` | Enable pre-commit secrets and credentials leak scanning |
| `useWorktrees` | `boolean` | `false` | Enable per-task isolated git worktrees for dispatched subagents under `.sdw/worktrees/{runId}/` |
| `useFeatureBranches` | `boolean` | `false` | Automatically create and activate an isolated feature branch derived from specification slug |
| `branching.strategy` | `string` | `"trunk"` | Branch preset: `trunk`, `github`, `develop`, `gitflow`, or `gitlab` (see §2.4) |
| `branching.featurePrefix` | `string` | `"feature/"` | Prefix for the feature branch name: `{branching.featurePrefix}{specSlug}` |
| `branching.workBranch` | `string \| null` | `null` | Work lane: where feature branches start and where the repository returns after delivery. `null` uses the checked-out branch; `github` and `gitlab` mirror `integrationBranch` |
| `branching.integrationBranch` | `string \| null` | `null` | Integration lane: the branch that receives the pull request merge. `null` means auto (`origin/HEAD`) |
| `branching.updateWorkBranch` | `boolean` | `false` | Fetch `origin` and fast-forward the work branch before creating the feature branch (default `true` for every preset that names a work lane) |
| `branching.syncWorkBranchAfterMerge` | `boolean` | `false` | Fast-forward the work branch to the integration branch after the pull request merges (default `true` for every preset that names a work lane) |
| `branching.pushSyncedWorkBranch` | `boolean` | `false` | Push the synchronized work branch to `origin` after the post-merge fast-forward |
| `scmProvider` | `string` | `"none"` | Configured SCM provider for issues, work items, and pull requests (`none`, `ado`, `github`) |
| `requiredBuild` | `boolean` | `false` | Enforce successful build verification in Step 8 before creating delivery commit or PR |
| `verification.buildCommand` | `string \| null` | `"npm run build"` | Command to execute for build verification; the only build command source |
| `verification.testCommand` | `string \| null` | `"npm test"` | Command to execute for test verification pass; the only test command source |
| `verification.timeoutMs` | `integer` | `600000` | Execution timeout for both verification gates |
| `runAllTests` | `boolean` | `false` | Enforce passing all test suites in Step 8 before creating delivery commit or PR |
| `prePrCommand` | `string` | `""` | Optional project-specific shell command to execute before PR preparation |
| `prePrInstructions` | `string` | `""` | Optional project-specific instructions or checklist for agents to verify prior to PR |
| `reviewFixCommand` | `string` | `""` | Optional command that applies review-thread fixes. When unset, sdw-ship-pr never resolves active threads automatically |
| `maxPreemptions` | `integer` | `3` | Maximum concurrent-push adaptation budget for post-PR review convergence before draining rounds |
| `memory.backends.wsMemo` | `boolean` | `true` | Use the ws-memo vault (memo CLI) as the default sdw-memory knowledge store |
| `memory.backends.traps` | `boolean` | `true` | Use the local .sdw/memory/traps.md table backend |
| `memory.backends.files` | `boolean` | `true` | Search local MEMORY.md and memory/*.md files (read-only) |

### 2.2 Supported Path Tokens

- `{projectRoot}`: Replaced by the absolute, forward-slash normalized path of the consumer project root (e.g., `C:/projects/my-app` or `/home/user/my-app`).
- `{skillsRoot}`: Replaced by the absolute, forward-slash normalized path of the resolved active skills directory.

### 2.3 Default Configuration Baseline

```json
{
  "$schema": "./config.schema.json",
  "specsDir": "{projectRoot}/.sdw/specs",
  "scoreMin": 8,
  "scmCodeReviewEnabled": false,
  "pushDelivery": false,
  "changelogEnabled": true,
  "changelogFile": "{projectRoot}/CHANGELOG.md",
  "stateDir": "{projectRoot}/.sdw/state",
  "sandboxDir": "{projectRoot}/.sdw/sandbox",
  "autoResolveGaps": true,
  "securityChecksEnabled": false,
  "useWorktrees": false,
  "useFeatureBranches": false,
  "branching": {
    "strategy": "trunk",
    "featurePrefix": "feature/",
    "workBranch": null,
    "integrationBranch": null,
    "updateWorkBranch": false,
    "syncWorkBranchAfterMerge": false,
    "pushSyncedWorkBranch": false
  },
  "scmProvider": "none",
  "requiredBuild": false,
  "runAllTests": false,
  "reviewFixCommand": "",
  "maxPreemptions": 3
}
```

### 2.4 Branching Strategy & Presets

`branching` models the delivery topology as two lanes plus a synchronization rule:

- **work lane**: where feature branches start and where the repository returns after delivery.
- **integration lane**: the branch that receives the pull request merge.

A preset resolves the defaults; every explicit `branching` key overrides the preset value (explicit `null` keeps `null`):

| `strategy` | `workBranch` | `integrationBranch` | `updateWorkBranch` | `syncWorkBranchAfterMerge` |
|:---|:---|:---|:---|:---|
| `trunk` (default) | `null` (checked-out branch) | `null` (auto) | `false` | `false` |
| `github` | mirrors `integrationBranch` | `null` (auto) | `true` | `true` |
| `develop` | `"develop"` | `null` (auto) | `true` | `true` |
| `gitflow` | `"develop"` | `"develop"` | `true` | `true` |
| `gitlab` | mirrors `integrationBranch` | `null` (auto) | `true` | `true` |

`featurePrefix` defaults to `"feature/"` and `pushSyncedWorkBranch` defaults to `false` for every preset. `null` on `integrationBranch` means auto: resolve the repository default branch from `origin/HEAD`. `null` on `workBranch` means the checked-out branch (trunk behavior), and the `github`/`gitlab` presets mirror the resolved `integrationBranch` when `workBranch` is not set.

Any lane name works through overrides. A release run sets `integrationBranch` to `release/1.4`; a maintenance run sets `workBranch` to `maintenance/2.x`; a GitLab promotion reuses the post-merge sequence with `workBranch` = `main` and `integrationBranch` = `staging`.

```json
{
  "branching": {
    "strategy": "gitflow",
    "featurePrefix": "feature/",
    "workBranch": "develop",
    "integrationBranch": "develop",
    "updateWorkBranch": true,
    "syncWorkBranchAfterMerge": true,
    "pushSyncedWorkBranch": false
  }
}
```

`resolveBranching(config)` in [`sdw_config.cjs`](../scripts/sdw_config.cjs) expands the preset and applies the overrides. It returns `{ strategy, source, workBranch, integrationBranch, featurePrefix, updateWorkBranch, syncWorkBranchAfterMerge, pushSyncedWorkBranch }`, where `source` is `"config"` when `branching.strategy` is set in `.sdw/config.json` and `"default"` when the default `trunk` preset applies.

Git sequences:

- Pre-start update (when `updateWorkBranch` is `true`): `git switch <workBranch>`, `git fetch origin`, `git merge --ff-only origin/<workBranch>`.
- Feature creation: `git switch -c <featurePrefix><specSlug> <workBranch>`.
- Post-merge synchronization (when `syncWorkBranchAfterMerge` is `true`): `git switch <workBranch>`; when the work lane equals the integration lane, `git fetch origin` then `git merge --ff-only origin/<integrationBranch>`; otherwise `git fetch origin +refs/heads/<integrationBranch>:refs/remotes/origin/<integrationBranch>` then `git merge --ff-only origin/<integrationBranch>`; then `git push origin <workBranch>` when `pushSyncedWorkBranch` is `true`.

---

## 3. Subcommand Reference

### 3.1 `init`
- **Purpose**: Creates `.sdw/`, `.sdw/specs/`, `.sdw/state/`, `.sdw/config.json`, `.sdw/config.schema.json`, and `.sdw/directory-structure.md` in the target project root.
- **Flags**:
  - `--root <path>`: Explicit project root directory (defaults to current working directory).
  - `--skills-root <path>`: Explicit active skills directory; `SDW_SKILLS_ROOT` is honored when the flag is absent, and both take precedence over `.sdw/config.json` `skillsRoot`.
  - `--force`: Overwrites existing configuration and documentation files.
  - `--json`: Returns structured JSON summary of created and skipped files.
- **Exit Code**: Always `0` on success.

### 3.2 `check`
- **Purpose**: Validates presence of `.sdw/`, validates `config.json` against `config.schema.json` (syntax, required keys, types, value bounds), disk existence of `specsDir`, and presence of `directory-structure.md`.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--skills-root <path>`: Optional explicit active skills directory override (falls back to `SDW_SKILLS_ROOT`, then `.sdw/config.json` `skillsRoot`, then auto-detection).
  - `--json`: Emits `{ "valid": boolean, "root": string, "skillsRoot": string, "skillsMode": string, "checks": [...], "errors": [...] }`.
- **Exit Code**: `0` when all checks pass; `1` if any check fails.

### 3.3 `parse`
- **Purpose**: Reads `.sdw/config.json`, substitutes tokens (e.g. `{projectRoot}`), and outputs the resolved configuration.
- **Flags**:
  - `--root <path>`: Explicit project root directory.
  - `--skills-root <path>`: Optional explicit active skills directory override (precedence: flag, then `SDW_SKILLS_ROOT`, then `.sdw/config.json` `skillsRoot`).
  - `--json`: Emits pure JSON formatted output including the resolved `projectRoot`, `skillsRoot`, and `skillsMode` (`canonical`, `local`, `global`, or `unknown`).
  - `--key <name>`: Extracts a single resolved configuration key.
- **Exit Code**: `0` on success; `1` on missing file, invalid JSON, or missing key.
