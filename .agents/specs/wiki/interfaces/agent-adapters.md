# Agent Adapters & Installers

## Feature Overview

This page covers the interfaces that connect consumer repositories and agent hosts to spec-memo without putting memory in product git:

- The relocatable consumer hub and memory adapter that route read/write memory to the vault or MCP.
- The write-block pre-commit hook that refuses staged workflow artifacts.
- The `install-hooks` and `install-skills` CLIs that write host lifecycle adapters and packaged skills, with a shared interactive wizard and explicit permission gates.
- The Codex (GPT) hook adapter.

Skill-only mode remains first-class: an agent using only the autoloaded `ws-memo` skill gets all 11 MCP tools; hooks are strictly opt-in.

## Business Rules & Logic

Memory adapter (`src/adapter.ts`, `MemoryAdapter`):

- `readMemoryBootstrap(cwd, query)` compiles the bootstrap brief through `compileBootstrapBrief` within the configured byte budget (default 8192 bytes) and sanitizes output.
- `updateMemoryTrap(cwd, trap)` slugs `trap-<scenario>`, builds a `## Scenario / ## DO NOT / ## INSTEAD DO` body, and upserts kind `trap` with severity default `medium`.
- `updateMemoryLog(cwd, message, details)` appends a write-only event via `appendEvent`.
- The adapter delegates storage to the vault/MCP core; when the MCP server is unreachable the deployment layer is fail-open (hybrid) or fail-closed (remote) rather than the adapter caching results in-repo.

Write-block hook (`src/hook.ts`):

- Blocked patterns: `.agents/plans/`, `MEMORY.md`, `memory/*.md`. Allowed product docs that are never blocked: `README.md`, `PRODUCT.PRD`, `FEATURES.md`, `PLAN.md`, `AGENTS.md`, `GEMINI.md`, `.agents/specs/index.PRD`.
- The generated `pre-commit` script scans `git diff --cached --name-only`; on a match it prints guidance to use `spec-memo` MCP/CLI and exits 1.
- Bypass: `SKIP_MEMO_HOOK=1` or `git commit --no-verify`.
- `installPreCommitHook` writes `.git/hooks/pre-commit` (mode `0o755`) and backs up a foreign existing hook to `<hook>.spec-memo.bak`. No server-side push hook exists.
- Note: current code blocks plans and in-repo memory only; it does not block `.agents/specs/**` at large (only `.agents/specs/index.PRD` is explicitly allowed).

`install-hooks` (`src/hooks-install.ts`):

- Supported hook hosts: `antigravity`, `opencode`, `cursor`, `claude`, `codex`, plus `all`.
- Default is preview: `apply` false (or `--apply` without confirmation) yields `status: 'preview'` and writes nothing. `--apply` requires explicit confirmation (`--yes`/`--confirm`) for permission-gated calls.
- All generated shell bridges are fail-open: `timeout 1.5 <memo> ... >/dev/null 2>&1 || true` with a 1500 ms ceiling (`HOOK_TIMEOUT_MS`), and exit 0 even if `memo` is missing.
- Event mapping: Antigravity `PreInvocation` (invocationNum 0) and `PostInvocation`; Cursor `sessionStart`/`beforeSubmitPrompt`/`sessionEnd` (timeout 1); Claude `SessionStart`/`UserPromptSubmit`/`PreCompact`/`SessionEnd`; OpenCode plugin `onInit`/`onPrompt`/`onExit`; Codex managed instruction block.
- Templates are stamped `// generated-by: spec-memo@<version>` or a `generatedBy` JSON field. `--remove` restores the newest timestamped `.bak` or prunes the spec-memo block/entry. `--force` overwrites with a timestamped `.bak`.
- `--json` emits rows `{ host, path, status: installed|removed|unchanged|preview|skipped|refused, diff }` plus `scope`, `hosts`, `conflictPolicy`, `status`, `productRoot`, and `preflight`.

Interactive install targets (`src/install-wizard.ts`):

- Catalog ids: `cursor`, `antigravity` (aliases `gemini`, `google`), `codex` (aliases `gpt`, `openai`), `opencode`, `claude` (alias `claude-code`). Conflict policies: `skip` | `update` | `force`. Scopes: `local` | `global`.
- On a TTY with missing choices, both installers run the wizard in order: scope, conflict policy, host multi-select (detected hosts pre-checked, never auto-selected), path preview, confirm. Dismiss/EOF/any answer other than `y`/`yes` writes nothing.
- Non-TTY writes require explicit `--yes` (or `--confirm`), `--scope`, and `--host`; `all` is valid only with confirmation. Missing flags exit non-zero with a named-flag message and no writes. `--json` disables the wizard and follows the same fail-closed contract.
- `skip`: leave differing destinations, report `skipped`; identical destinations report `unchanged`. `update`: overwrite missing/identical destinations and destinations stamped as spec-memo; refuse foreign files (`refused`) unless policy is `force`. `force`: overwrite with `.bak` behavior, subject to the vault-overlap deny.
- Scope-relative hook commands: local Cursor/Claude use `.cursor/hooks/` or `.claude/hooks/`; global user hooks use `./hooks/` (never `.cursor/hooks/` under `$HOME`). On win32 shell hooks are prefixed with `bash`.
- Preflight object: `platform`, resolved `memoCommand` (PATH `memo` else `node <dist/cli.js>`), `shellHookPrefix`, `chmodAttempted`, `ok`, and optional `warning`. Apply is refused when no invocable `memo`/node is found unless `--force` after confirmation.
- Codex: local `.codex/AGENTS.md`, global `$HOME/.codex/AGENTS.md`, wrapped in `<!-- spec-memo:start -->` / `<!-- spec-memo:end -->` so re-install replaces the managed block only.

`install-skills`:

- Allowed skills: `ws-memo`, `ws-session-tracking`. Local target default `.agents/skills`; global writes `$HOME/.agents/skills` plus host-specific roots only for selected hosts (no implicit Antigravity copy).
- Conflict policy semantics mirror hooks (`isPackagedSkillTree` checks `name: <skill>`, a `version:` line, and `managedBy: spec-memo`). Vault overlap is denied before any tree removal.

## Technical Architecture

- `src/adapter.ts`: `MemoryAdapter` (bootstrap/upsert/append wrappers).
- `src/hook.ts`: `BLOCKED_WORKFLOW_PATTERNS`, `ALLOWED_PRODUCT_DOCS`, `isBlockedWorkflowPath`, `generatePreCommitHookScript`, `installPreCommitHook`.
- `src/hooks-install.ts`: `SUPPORTED_HOOK_HOSTS`, `resolveHostHookPaths(host, { global, productRoot, homeDir })`, per-host generators (`generateAntigravityHooksJson`, `generateCursorHooksJson`, `generateClaudeHooksConfig`, `generateCodexAgents`, `generateOpenCodePlugin`, `generateCursorRule`), `deepMergeJson`/`stripSpecMemoFromHookConfig`, `installHooks`, and `inspectAgentHooks`.
- `src/install-wizard.ts`: `INSTALL_HOSTS`, `HOST_ALIASES`, `canonicalInstallHost`, `normalizeInstallHosts`, `normalizeConflictPolicy`, `getInstallPreflight`, `resolveMemoCommand`, `runInstallWizard`.
- `src/skills-install.ts`: `ALLOWED_SKILLS`, `resolveGlobalSkillTargets`, `resolveSkillInstallTargets`, `installSkills`, vault-overlap default-deny.
- MCP: `install_skills` is the only write-capable installer tool; it requires `scope`, `hosts`, `conflictPolicy`, and `confirm: true`. There is no MCP hooks tool. See [MCP Tooling](mcp-tooling.md).
- Doctor integration: `inspectAgentHooks` reports installed hosts and outdated templates (`Agent Hooks: Not installed (Skill-only mode active via ws-memo)` when absent).

Provenance: `0012-relocatable-hub.spec.md`, `0016-write-block-hook.spec.md`, `0017-memory-adapter-mcp.spec.md`, `0041-agent-hooks-install.spec.md`, `0048-install-hooks-skills-interactive.spec.md`.
