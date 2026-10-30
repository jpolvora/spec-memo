---
name: sdw-doctor
description: Installation and workspace health checker for SDW skills across upstream, local, global, and hybrid modes.
version: 0.1.0
invocation_names:
  - sdw-doctor
  - sdw-doctor check
  - sdw-doctor test
  - sdw-doctor doctor
---
# sdw-doctor

> When this skill is loaded, output "sdw-doctor loaded."

Checks that the SDW installation is complete and that the consuming workspace is valid: skill folders, `SKILL.md` frontmatter, references, scripts, links, config keys, registry rows, and specifications.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md); report findings, never repair silently.

## Subcommands

- `check`: Runs the installation and workspace audit (default).
- `test`: Runs a fake specification through `sdw-run run --sandbox` and verifies every step completes.
- `doctor`: Alias for `check`.

## Installation Modes

| Mode | Detected when | Audit scope |
|---|---|---|
| `upstream` | `{projectRoot}/skills/` has at least three SDW skills and an upstream marker (`verify_skills.cjs` in the repository scripts folder, or package name `spec-driven-workflow`) | Canonical `skills/` plus the `.sdw/` template |
| `consumer-local` | `{projectRoot}/.agents/skills/` contains SDW skills | Project-local install plus `.sdw/` |
| `consumer-global` | only `$HOME/.agents/skills/` contains SDW skills | Global install plus `.sdw/` |
| `hybrid` | global skills plus a local `.sdw/config.json` | Global install (quick check) plus `.sdw/` |
| `missing` | no skills root found | Fails and prints the reinstall command |

## Steps

1. **Detect the Installation**
   Resolve the project root (`--root` or current directory) and the skills root: canonical, project-local, then global. Report the mode and both paths before any finding.
   - Done when: mode, `skillsRoot`, and `globalRoot` (when relevant) are known.

2. **Run the Audit**
   Run every deterministic check: expected skills present, `SKILL.md` frontmatter (`name`, `description`, `version`, `invocation_names`), load announcement, line budget (`sdw-rules` 80, others 120), `sdw-rules` pointer, resolvable relative links, `node --check` on every script, zero external requires, then workspace config schema, registry rows, and spec validation.
   - Run: `node skills/sdw-doctor/scripts/sdw_doctor.cjs check [--json] [--root <path>] [--home <path>]`
   - Done when: every check produced a finding or passed.

3. **Report Findings**
   Group by level: `ERROR` stops the workflow, `WARN` does not. Include the subject (skill, file, or spec) and the exact path in every line.
   - Done when: the report names the mode, the roots, the skill count, and each finding.

4. **Remediate and Stop on Error**
   Never repair files silently. Print the matching command and halt:
   - Install-level errors (missing skill, unreadable `SKILL.md`, broken global install): `npx skills add jpolvora/spec-driven-workflow -y` then `npx skills update`.
   - Config-level errors (missing or invalid `.sdw/config.json`, missing keys, schema failures): `node skills/sdw-config/scripts/sdw_config.cjs init`, then `node skills/sdw-config/scripts/sdw_config.cjs check`.
   - Spec-level errors (missing file, unregistered row, invalid spec): `node skills/sdw-spec/scripts/sdw_spec.cjs sync`, then `node skills/sdw-spec/scripts/sdw_spec.cjs validate <specPath>`.
   - Upstream mode: fix the canonical source and re-run `verify_skills.cjs` from the repository scripts directory; never suggest `npx` there.
   - Done when: on error, the command is printed and the turn stops; on success, report `PASS`.

## Sandbox Smoke Test (`test`)

Builds a throwaway project in the OS temp directory, copies the resolved skills into `.agents/skills/`, writes a minimal `.sdw/` workspace and a one-AC specification, commits the baseline, then runs the real orchestrator:

```bash
node skills/sdw-doctor/scripts/sdw_doctor.cjs test [--keep] [--timeout <ms>] [--open-issue]
```

- Implementation runs in `implementation.mode: command`; the judge is a local stub; push, SCM, worktrees, and feature branches are disabled.
- `--sandbox` clones the committed baseline, so the test proves planning, dispatch, evidence, gates, scoring, delivery commit, review, and PR preparation in isolation.
- `PASS` requires exit `0`, run state `completed`, and all eight steps `completed` or `skipped`.
- On failure it captures the run-state errors, prints suggested fixes, and stops with exit `1`.
- `--keep` preserves the generated project path for inspection; otherwise it is deleted.
- `--open-issue` is upstream-only: it opens a GitHub issue with the captured errors and suggestions when `gh` is available; otherwise it reports why it could not.

## Exit Codes

- `0`: all checks passed; warnings allowed.
- `1`: at least one error; remediation printed; stop.

## Guardrails

- `check` is read-only; `test` writes only inside its temporary project and never touches the source checkout.
- No `npx` advice in upstream mode.
- A missing skill is always an error, even when the rest of the install is healthy.
- Do not continue into other SDW skills after a `FAIL`.

## References

- Full check catalog, finding codes, and remediation map: [`references/checks.md`](references/checks.md)
