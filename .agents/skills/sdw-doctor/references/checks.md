# sdw-doctor Checks and Remediation

Deterministic reference for the audit run by `sdw_doctor.cjs`. Every check is read-only and yields a finding with a stable code.

## Installation detection

| Order | Path | Mode |
|---|---|---|
| 1 | `{projectRoot}/skills` with at least three SDW skill folders **and** an upstream marker (`scripts/verify_skills.cjs` or `package.json` name `spec-driven-workflow`) | `upstream` |
| 2 | `{projectRoot}/.agents/skills` with at least one SDW skill | `consumer-local` |
| 3 | `$HOME/.agents/skills` with at least one SDW skill, `.sdw/config.json` present | `hybrid` |
| 4 | `$HOME/.agents/skills` only | `consumer-global` |
| 5 | none | `missing` |

`upstream` wins even when a global install exists, because the canonical checkout is the source of truth for this repository.

## Skill checks

| Code | Level | Check |
|---|---|---|
| `skill-missing` | error | Every expected skill folder exists (`sdw-batch`, `sdw-changelog`, `sdw-code-review`, `sdw-config`, `sdw-doctor`, `sdw-fixer`, `sdw-memory`, `sdw-run`, `sdw-retro`, `sdw-router`, `sdw-rules`, `sdw-security-checks`, `sdw-ship-pr`, `sdw-spec`). |
| `skill-entry-missing` | error | `SKILL.md` exists in the skill folder. |
| `skill-frontmatter` | error | YAML frontmatter parses. |
| `skill-frontmatter-key` | error | `name`, `description`, `version`, and `invocation_names` are present. |
| `skill-name-mismatch` | error | Frontmatter `name` equals the folder name. |
| `skill-announcement` | error | Load line `> When this skill is loaded, output "… loaded."` exists. |
| `skill-line-budget` | error | `sdw-rules` ≤ 80 lines; every other `SKILL.md` ≤ 120 lines. |
| `skill-rules-reference` | error | Every skill except `sdw-rules` references `sdw-rules`. |
| `skill-link-missing` | error | Every relative Markdown link resolves on disk. |
| `skill-script-syntax` | error | `node --check` passes for every `scripts/*.cjs`. |
| `skill-script-dependency` | error | No `require` of an external module (Node built-ins only). |
| `global-root-missing` | error | The global skills root exists when it is the resolved root. |
| `global-skills-missing` | error | At least one SDW skill exists globally. |
| `global-skill-missing` | error | Core skills present globally (`sdw-config`, `sdw-run`, `sdw-router`, `sdw-rules`, `sdw-spec`). |
| `global-skill-unreadable` | error | Every global skill has a readable `SKILL.md`. |
| `global-skill-frontmatter` | warning | Global `SKILL.md` frontmatter contains `name` and `version`. |

## Workspace checks

| Code | Level | Check |
|---|---|---|
| `workspace-missing` | warning | `.sdw/` exists; when absent, workspace checks are skipped. |
| `workspace-config-missing` | error | `.sdw/config.json` exists. |
| `workspace-config-json` | error | `.sdw/config.json` parses as JSON. |
| `workspace-config-schema` | error | `validateConfigSchema` accepts the file (required keys, types, enums). |
| `workspace-config-validator` | warning | `sdw-config` was unavailable, so schema validation was skipped. |
| `workspace-file-missing` | error | `.sdw/config.schema.json`, `.sdw/directory-structure.md`, and `.sdw/specs/index.specs.md` exist. |
| `workspace-specs-missing` | error | `.sdw/specs/` exists. |
| `spec-file-missing` | error | Every registry row has a specification file. |
| `spec-unregistered` | warning | Every specification file has a registry row. |
| `spec-invalid` | error | `validate_spec.cjs --mode=authoring` passes for every spec. |
| `spec-unreadable` | error | The specification file can be read. |
| `spec-validator-missing` | warning | `sdw-spec` was unavailable, so spec validation was skipped. |

## Remediation map

| Finding family | Command |
|---|---|
| Installation (`skill-*`, `installation-*`, `global-*`) | `npx skills add jpolvora/spec-driven-workflow -y` then `npx skills update` |
| Configuration (`workspace-config-*`) | `node skills/sdw-config/scripts/sdw_config.cjs init` then `node skills/sdw-config/scripts/sdw_config.cjs check` |
| Specifications (`spec-*`) | `node skills/sdw-spec/scripts/sdw_spec.cjs sync` then `node skills/sdw-spec/scripts/sdw_spec.cjs validate <specPath>` |
| Upstream source | Fix `skills/`, then `node scripts/verify_skills.cjs verify` |

On any `ERROR`, the doctor prints the applicable lines, adds a stop notice, and exits `1`. Warnings never block. The doctor never installs, updates, or edits anything.

## Smoke test (`test`)

The smoke test proves the installation can execute the real pipeline:

1. Resolve the skills root with the same detection order as `check`.
2. Create a temp project, copy the skills into `.agents/skills/`, and write a minimal `.sdw/` workspace plus `00001-doctor-smoke.md` (one AC).
3. Configure `implementation.mode: command` with a worker that writes `status: success` evidence and a changed file, a local judge stub that verifies every AC, a trivial verification command, and push/SCM/worktrees/feature branches disabled.
4. `git init`, commit the baseline, then run `sdw-run run .sdw/specs/00001-doctor-smoke.md --sandbox`.
5. Read the sandbox run state and require exit `0`, `status: completed`, and steps 1-8 `completed` or `skipped`.

Failure capture:

| Symptom | Suggested fix |
|---|---|
| Missing skills or module resolution errors | `npx skills add jpolvora/spec-driven-workflow -y` |
| Specification not found | Fix `specsDir`; run `sdw-spec sync` |
| Evidence validation failed | Check the worker evidence contract (`status`, `acIds`, changed `filesChanged`) |
| Gate or test failure | Run the configured verification command manually |
| Score below threshold | Inspect `step-5-judge.verdict.json` |
| Clone failure | Verify git and a committed baseline |

`--open-issue` runs only in upstream mode and only when `gh` is available; the issue body contains the captured errors, the suggested fixes, and the output tail. A failed issue creation is reported but never masks the smoke result.

## Output contract

`--json` prints one object:

```json
{
  "ok": true,
  "mode": "hybrid",
  "root": "/project",
  "skillsRoot": "/home/user/.agents/skills",
  "globalRoot": "/home/user/.agents/skills",
  "presentSkills": ["sdw-config", "..."],
  "expectedSkills": ["sdw-code-review", "..."],
  "findings": [{ "level": "error", "code": "skill-missing", "subject": "sdw-run", "message": "..." }],
  "errors": 0,
  "warnings": 0,
  "remediation": []
}
```

## Non-goals

- No repair, install, or update.
- No network calls.
- No security audit; use `sdw-security-checks` for secrets.
- No SCM, PR, or delivery validation; use `sdw-run status` or `sdw-ship-pr`.
