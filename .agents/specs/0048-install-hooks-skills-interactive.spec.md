---
id: null
slug: install-hooks-skills-interactive
title: "Interactive install-hooks and install-skills with explicit host permission"
source: local
specDate: 2026-09-06
---

# Specification — Interactive install-hooks and install-skills with explicit host permission

## Description

Upgrade `memo install-hooks` and `memo install-skills` so a human (or an agent acting on explicit flags) must choose **where** files go and **which agent hosts** receive them **before any write**. Today `install-hooks` defaults `--host all` and writes on `--apply` with no host checklist, and `install-skills --global` copies into `$HOME/.agents/skills` plus Antigravity when that tree exists, without asking. Codex/GPT is not a hook host. Windows vs POSIX invocation (PATH `memo`, `node dist/cli.js`, `bash` prefix, `chmod`) is not a preflight. Cursor (and Claude) hook `command` strings today always use **product-tree** prefixes (`.cursor/hooks/…`, `.claude/hooks/…`). That is correct only for workspace-local install. Cursor **user** hooks run with cwd `$HOME/.cursor`, so those same strings miss the scripts under `$HOME/.cursor/hooks/` (observed 2026-09-06 Hooks log: `bash .cursor/hooks/spec-memo-*.sh` from user config). `resolveHostHookPaths('cursor', { global: true })` currently returns `[]`, so `--global` cannot repair this.

Share one **install target wizard** used by both CLIs:

1. **Scope:** local (product / workspace tree) or global (user home host paths).
2. **Existing-file policy:** `skip` (leave differing dests), `update` (overwrite only spec-memo-stamped or identical-tree dests when packaged content is newer or differs), or `force` (overwrite including foreign files, with existing `.bak` / vault-overlap guards).
3. **Host multi-select** (checkboxes conceptually; CLI numbered multi-pick): Cursor, Gemini/Antigravity, Codex (GPT), OpenCode, Claude Code. Empty selection is invalid.
4. **Plan preview:** resolved absolute paths, OS, chosen `memo` invocation, permission notes.
5. **Confirm:** explicit yes. Cancel / empty / non-yes writes nothing.

Smart detection may **pre-check** hosts whose config dirs already exist, but detection never writes and never treats a missing checkbox as selected. Unchecked hosts are never touched.

MCP `install_skills` stays non-interactive (no TTY). It must fail closed unless the caller passes explicit `scope`, `hosts` (or `host: all` only when also `confirm: true`), conflict policy, and `confirm: true`. `install-hooks` remains CLI-only (no new MCP tool).

### Design Intent

Existing design (0041, 0024): opt-in hooks, dry-run default for hooks, `--force` for differing skill trees, vault-overlap deny, chmod best-effort on shell hooks, Windows `bash` prefix for hook commands (commit `a6a9a10`). Those safety invariants stay.

Intentional gap being closed: silent multi-host writes and implicit Antigravity global skill copy. Accidental gap: no Codex adapter, no shared conflict-policy enum (`skip` vs `update` vs `force`), and hook `command` paths not keyed off install **scope cwd**.

Greenfield skip does not apply; this modifies `src/hooks-install.ts`, `src/skills-install.ts`, and `src/cli.ts`.

## Acceptance Criteria

### Shared wizard and permission gate

- AC1: A shared module (for example `src/install-wizard.ts`) exposes host catalog ids `cursor`, `antigravity` (aliases `gemini`, `google`), `codex` (aliases `gpt`, `openai`), `opencode`, `claude` (alias `claude-code`), plus conflict policies `skip` | `update` | `force` and scopes `local` | `global`.
- AC2: On an interactive TTY (`stdin` and `stdout` both TTY) and when required choices are missing, `memo install-hooks` and `memo install-skills` run the wizard in order: scope, conflict policy, host multi-select, path preview, confirm. Dismiss, EOF, or any answer other than an explicit yes (case-insensitive `y` / `yes`) exits 0 with zero filesystem mutations.
- AC3: Non-TTY invocations (pipes, CI, MCP-spawned CLI) never open readline prompts.
- AC4: Non-TTY writes require `--yes` (or `--confirm`), explicit `--scope local|global`, and explicit `--host` (repeatable or CSV; `all` only with `--yes`). Missing any of those exits non-zero, names the missing flags, and writes nothing.
- AC5: `--json` disables the wizard. JSON mode follows the same fail-closed flag contract as non-TTY. Preview without `--apply` / without confirmed skills install still emits JSON with `status: preview` and does not write.
- AC6: Default host is **not** `all`. Omitting `--host` on a TTY opens the wizard; omitting `--host` on non-TTY is an error. `--host all` with `--yes` still installs only catalog hosts, never hosts outside the catalog.
- AC7: Detection may mark hosts as recommended when their known config roots exist, but the confirm step lists checked vs unchecked hosts. Unchecked hosts produce zero writes and zero backups.

### Conflict policy

- AC8: `skip`: if the destination exists and content (hooks file or skill tree) is not byte-identical to the payload, the row status is `skipped` and the file is left unchanged. Identical dests report `unchanged`.
- AC9: `update`: overwrite dests that are missing, identical, or stamped `generated-by: spec-memo@` (hooks) / packaged skill trees that differ from the current package. Refuse (row `refused` or thrown error, no wipe) when an existing dest is foreign (no stamp / not a previous skill install) unless policy is `force`.
- AC10: `force` keeps current overwrite + timestamped `.bak` behavior for hooks and skill-tree replace, including vault-overlap deny (`install-skills-destdir-vault-overlap`). `--force` maps to policy `force`. A new `--skip-existing` maps to `skip`. `--update` maps to `update`. Default interactive policy is `update`. Default non-interactive skills without `--force` remains fail on differing dest (current throw) unless `--skip-existing` or `--update` is passed.

### Host adapters (hooks)

- AC11: Existing Antigravity, OpenCode, Cursor, and Claude adapters from 0041 keep their local dest path map and fail-open timeout contract. Host filter applies so `--host cursor` never writes Claude/OpenCode/Gemini/Codex paths. Hook event names stay 0041. Hook command relative prefixes are **scope-dependent** (AC26–AC29), not a copy of local strings into `$HOME`.
- AC12: Codex (GPT) is a first-class hook host. Local install writes a workspace agent instruction file under the product root (`.codex/` or documented Codex project agents path used in tests). Global install writes the user-level Codex agents path under `$HOME`. Generated content is fail-open, timeout-bounded `memo` invocation consistent with other shell/md adapters, and stamped `generated-by: spec-memo@<version>`.
- AC13: Host aliases `gemini` and `google` resolve to `antigravity`. Aliases `gpt` and `openai` resolve to `codex`. Unknown `--host` values throw listing the catalog (including aliases).

### Skills install host targeting

- AC14: Local `install-skills` still copies `ws-memo` and `ws-session-tracking` into `{productRoot}/.agents/skills` (or `--skills-root`). Host selection additionally copies or links into host-specific skill/rule folders **only for selected hosts** (Cursor rules/skills dir, Gemini/Antigravity skills, Codex agents, OpenCode plugin/skills dir, Claude skills) using the same catalog as hooks. Unselected hosts get no skill files.
- AC15: Global `install-skills` writes Antigravity/Gemini skill dirs only when host `antigravity` is selected (or `--host all` with `--yes`). Existing `~/.gemini/config` alone does not select that host.
- AC16: Vault overlap checks run on every destDir before any `removeTree` (existing trap).

### Platform preflight (Windows / Linux)

- AC17: Before apply, both commands run a preflight object included in human preview and `--json`: `platform` (`win32` | `linux` | `darwin`), `memoCommand` (resolved `memo` on PATH, else `node <absolute dist/cli.js>` per AGENTS.md CLI contract), `shellHookPrefix` (`bash` on win32 for generated shell hooks; none required on POSIX), `chmodAttempted` (POSIX `0o755` on shell artifacts; win32 catch remains non-fatal).
- AC18: If preflight cannot resolve any invocable `memo` or `node dist/cli.js`, apply is refused (exit non-zero) after confirm would have run, unless `--force` is set **and** the user still confirmed; then write files but set `preflight.ok: false` and a warning. Generated hooks still fail-open at runtime.
- AC19: Unit tests cover win32 vs posix path separators in resolved dests (use `homeDir` / `productRoot` overrides), chmod try/catch, that hook command lines on win32 keep the `bash` prefix for `.sh` artifacts, and the two Cursor command prefixes in AC26 (local `.cursor/hooks/` vs global `./hooks/`).

### MCP and agent safety

- AC20: MCP `install_skills` schema adds optional `scope` (`local` | `global`), `hosts` (string array), `conflictPolicy` (`skip` | `update` | `force`), and required-for-write `confirm` (boolean). If `confirm` is not true, the tool returns an error and writes nothing even when `productRoot` / `global` are set. Agents must not treat cwd presence as permission.
- AC21: MCP `install_skills` never opens readline. Host list empty or omitted with `confirm: true` is an error (same as missing `--host` on non-TTY).
- AC22: No new MCP tool for hooks. Agents installing hooks must use CLI with `--yes` and explicit hosts, or instruct the human to run the TTY wizard.

### Docs, doctor, tests

- AC23: `README.md`, `AGENTS.md` Command table, `ws-memo` skill surface, and `--help` for both commands document the wizard, `--yes`, `--scope`, `--host` (multi), `--skip-existing` / `--update` / `--force`, Codex, and the MCP `confirm` requirement.
- AC24: `memo doctor` hook inspection includes `codex` when installed; unselected/uninstalled Codex is not reported as an error.
- AC25: Tests exist for: TTY wizard cancel (no writes); non-TTY missing `--yes` (no writes); `--host cursor` does not touch other hosts; `--skip-existing` leaves differing files; `update` refuses foreign files; MCP `confirm` false; Codex path resolution; Antigravity global skills not written unless host selected; Cursor local vs global hook `command` prefixes (AC26); `update` rewrites stamped `.cursor/hooks/` commands in `$HOME/.cursor/hooks.json` (AC28).

### Cursor / Claude hook command cwd (scope-relative paths)

Cursor user-hook cwd is `$HOME/.cursor` (Hooks log: `Running script in directory: …\.cursor`). Workspace-local hook cwd is the product root. Do not emit one `command` string for both scopes.

- AC26: Cursor hook `command` prefixes are **local `.cursor/hooks/` vs global `./hooks/`**. Local `sessionStart` / `beforeSubmitPrompt` / `sessionEnd` use `bash .cursor/hooks/spec-memo-{bootstrap,record,session-end}.sh` (timeout 1; win32 `bash` per AC17). Global uses `bash ./hooks/spec-memo-{bootstrap,record,session-end}.sh` and must not contain `.cursor/hooks/`.
- AC27: Claude command prefixes are **local `.claude/hooks/` vs global `./hooks/`**. Local keeps `bash .claude/hooks/spec-memo-*.sh`. Global user `config.json` uses `bash ./hooks/spec-memo-*.sh`, never `.claude/hooks/` under `$HOME/.claude`. Unselected Claude writes nothing.
- AC28: Conflict policy `update` (and `force`) on a spec-memo-stamped Cursor **global** `hooks.json` rewrites `command` values that still use `.cursor/hooks/` to `./hooks/` while preserving non-spec-memo entries. Policy `skip` leaves a differing dest unchanged. Installer never adds third-party `workspaceOpen` commands.
- AC29: `--scope global --host cursor --yes --apply` writes `$HOME/.cursor/hooks.json` plus `$HOME/.cursor/hooks/spec-memo-*.sh`. `resolveHostHookPaths` for global Cursor is not an empty list.

## Original Issue Context

Standalone `/ws-spec-write` request: update install-hooks and install-skills to ask install target (local or global), force vs skip existing vs update, then select agent folders (Cursor, Gemini/Antigravity, Codex/GPT, OpenCode, Claude Code), confirm, then install; check Windows/Linux command and permission behavior; remain smart; never install into an agent/IDE without permission.

Follow-up 2026-09-06: Cursor Hooks channel showed user `hooks.json` running `bash .cursor/hooks/spec-memo-*.sh` (and a dead `workspaceOpen` `.cmd`) with cwd `C:\Users\…\.cursor`. Spec 0048 must generate the two prefixes in AC26 and rewrite the global copy on `update`.

### Prior Work Sweep

- Specs: `0041-agent-hooks-install.spec.md`, `0024-mcp-version-and-skill-install.spec.md`.
- Code: `src/hooks-install.ts` (`SUPPORTED_HOOK_HOSTS` without `codex`; default `all`; `generateCursorHooksJson` hardcodes `.cursor/hooks/`; global Cursor `resolveHostHookPaths` returns `[]`), `src/skills-install.ts` (`resolveGlobalSkillTargets` auto-adds Antigravity), `src/cli.ts` TTY-gated reconcile prompts (trap `tty-gated-interactive-reconcile-choice-per-ac9`).
- Commits: `735ff36` hooks CLI; `a6a9a10` Windows bash prefix; `620593c` / `dffd02a` global skills + vault overlap.
- No open tracker id for this slice; keyword search is local-only.

### Design Intent

See Description. Preserve dry-run-default for hooks, fail-open runtime hooks, and vault-overlap deny. Change implicit `all` / implicit Gemini global skill copy to explicit permission. Generate hook `command` strings from install-scope cwd: product-relative `.cursor/hooks/` (local) vs `./hooks/` (global user Cursor), never copy local strings into `$HOME/.cursor/hooks.json`.

## Notes

- Reuse `promptReconcilePreference` TTY gating; do not prompt when `--json`, `--yes`, or non-TTY.
- `install-hooks` without `--apply` remains preview even after wizard confirm unless the confirm question states apply; recommended UX: wizard confirm **is** apply for the listed paths (equivalent to `--apply --yes` after answers). Preview-only: answer no, or pass `--dry-run`.
- Keep 11 MCP tools; only extend `install_skills` inputs.
- Two Cursor `command` prefixes only: local `.cursor/hooks/` vs global `./hooks/`. Do not invent a third (`hooks/spec-memo-…` without `./`, or absolute `$HOME` paths) unless Cursor documents a new cwd.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Status-monitor or GUI installer | CLI + MCP flags only |
| New MCP `install_hooks` tool | Hooks stay CLI-only (0041) |
| Rewriting hook event semantics for existing hosts | 0041 event names stay; command **path prefix** vs cwd is in-scope (AC26–AC29) |
| Auto-install on `npm install` / `memo setup` | Would violate explicit permission |
| Writing into `{plansDir}` or product MEMORY | Git boundary |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| TTY vs flags | Wizard on TTY when flags missing; `--yes` + explicit host/scope on CI | Matches reconcile TTY trap | y |
| Default conflict policy | Interactive `update`; skills non-interactive keep throw-on-diff unless flags | Safest upgrade without surprising CI | y |
| Codex artifact layout | Workspace `.codex/` + user home Codex agents file; exact filenames in tests | Codex is new; details in companion | n |
| Implicit-requirement remainder | N/A because auth/rate-limits, TTL, and multi-tenant concurrency do not apply to a local CLI installer | Local filesystem installer | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Wizard + host filter + Codex + preflight + MCP confirm + scope-relative hook commands; not a hook-event rewrite | Diff limited to install/cli/docs/tests |
| Atomic criteria | Numbered ACs with pass/fail | `validate_spec.cjs --mode=authoring` |
| Failure modes | Non-TTY without `--yes`; foreign `update`; vault overlap; missing memo binary | Named negative tests |
| Observation telemetry | JSON result + doctor Codex row + preflight object | Test asserts fields |
| Blockers | Codex on-disk path confirmed during implement if vendor docs differ | Companion deferred detail; no open product blocker |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/hooks-install.test.js dist/version-skills.test.js dist/cli.test.js` after build.
- `memo install-hooks --json` / `memo install-skills --json` include `preflight` and per-host `status`.
- `memo doctor --json` host list includes `codex` when present.
- MCP `install_skills` error string contains `confirm` when omitted.

### Negative & Failing Test Scenarios

- Non-TTY `memo install-hooks --apply --host cursor` without `--yes` exits non-zero and creates no files.
- Wizard (or simulated stdin) receiving `n` after preview leaves the product tree unchanged.
- `install-skills --global --yes --host cursor` does not create `$HOME/.gemini/config/skills/ws-memo`.
- `conflictPolicy: update` on a hand-edited foreign `.cursor/rules/spec-memo.mdc` without stamp refuses overwrite.
- MCP `install_skills` with `global: true` and `confirm: false` writes nothing.
- `--scope local --host cursor` preview/apply JSON commands include `.cursor/hooks/` and do not include `./hooks/spec-memo-`.
- `--scope global --host cursor` preview/apply JSON commands include `./hooks/spec-memo-` and do not include `.cursor/hooks/`.
- `update` on stamped `$HOME/.cursor/hooks.json` that still has `bash .cursor/hooks/spec-memo-bootstrap.sh` rewrites that command to `bash ./hooks/spec-memo-bootstrap.sh` and leaves unrelated entries.

### Revision History

### [2026-09-06] Revision: scope-relative Cursor/Claude hook command prefixes (Prompt: "add to 0048 spec instructions to also fix this … especially the 2 project-relative paths")
