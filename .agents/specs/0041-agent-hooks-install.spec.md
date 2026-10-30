---
id: null
slug: agent-hooks-install
title: "Automatic Agent Lifecycle Hooks Installer (memo install-hooks)"
source: local
specDate: 2026-09-04
---

# Specification — Automatic Agent Lifecycle Hooks Installer (memo install-hooks)

## Description

Implement the `memo install-hooks` CLI command and accompanying host adapter engine to automate the generation, configuration, and installation of non-blocking agent lifecycle hooks. Provide first-class, out-of-the-box support for Antigravity, OpenCode, Cursor, and Claude Code. The installer inspects target host environments, generates deterministic hook bridges (mapping harness events such as session startup, prompt submission, context compaction, and session end to `spec-memo` operations), and writes them safely into global host paths or workspace configuration roots following established `spec-memo` setup patterns.

### Dual Operating Modes: Skill-Only vs. Hook-Automated

`spec-memo` recognizes two equally supported, non-conflicting operating modes:

1. **Skill-Only Mode (Default / Minimalist):**
   - Users who do not wish to install shell wrappers or IDE hook configurations rely entirely on the autoloaded **`ws-memo` runtime skill** (installed via `memo install-skills`).
   - In this mode, the agent host loads `ws-memo` on every prompt turn. The agent autonomously reads the `bootstrap` brief, searches for traps, logs prompt turns, and ends sessions via standard MCP tool calls.
   - Zero IDE-level hooks or filesystem interceptors are installed.
2. **Hook-Automated Mode (Opt-In / Hands-Free):**
   - Users who desire completely hands-free, silent background capture (mirroring `ai-memory` behavior) can opt in via `memo install-hooks`.
   - Lifecycle hooks silently intercept harness events out-of-band and route them to `spec-memo` without relying on model instruction compliance.

### Problem Analysis & Real-World Evidence

1. **Manual Integration Friction:**
   - Currently, developers must manually configure MCP servers (`memo setup --write-mcp`) and manually copy runtime skills (`memo install-skills`).
   - While `ws-memo` autoloading provides high-quality agent-driven memory operations, some workflows benefit from silent lifecycle hooks that fire automatically on harness startup, prompt submission, and process exit.
2. **Harness Event Heterogeneity:**
   - Different agent harnesses expose differing hook architectures:
     - **Antigravity:** Customization roots (`~/.gemini/config/hooks.json` or `.agents/hooks.json`) with `PreInvocation` and session boundaries.
     - **OpenCode:** Global or workspace config (`~/.config/opencode/` or `.opencode/`) with tool execution and prompt listeners.
     - **Cursor:** System rules (`.cursor/rules/spec-memo.mdc`) and agent hooks automating `bootstrap` on startup and `prompt record` on turns.
     - **Claude Code:** Native lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `SessionEnd`).
   - Without an automated installer, developers who want hook automation face steep manual configuration barriers.
3. **Safety & Non-Blocking Invariant:**
   - Hook scripts executed inside agent hot paths must **never** block agent startup, hang on network I/O, or crash the IDE if the `spec-memo` daemon is offline.

### Design Intent

Establish `memo install-hooks` as a strictly **optional, opt-in capability**. Mirror the proven patterns in `src/setup.ts` (`SUPPORTED_HOSTS`, `resolveHostConfigPath`, `--host`, `--apply`, `--dry-run`) and `src/skills-install.ts` (`--global`, `--force`). Introduce `src/hooks-install.ts` to manage hook generation, template emission, and atomic installation across target hosts. Ensure all generated hook scripts execute asynchronously with strict sub-second timeouts and fail-open error suppression.

---

## Acceptance Criteria

### Supported Host Registry & Pattern Alignment

- AC1: `src/hooks-install.ts` defines `SUPPORTED_HOOK_HOSTS = ['antigravity', 'opencode', 'cursor', 'claude', 'all'] as const`, mirroring the host resolution pattern in `src/setup.ts`.
- AC2: `resolveHostHookPaths(host, options)` resolves canonical destination paths for each host across global (`--global`) and workspace-local modes:
  - `antigravity`: `~/.gemini/config/hooks.json` (global) or `.agents/hooks.json` (workspace).
  - `opencode`: `~/.config/opencode/plugins/spec-memo.js` (global) or `.opencode/plugins/spec-memo.js` (workspace).
  - `cursor`: `.cursor/rules/spec-memo.mdc` and `.cursor/hooks.json` (workspace).
  - `claude`: `~/.claude/config.json` (global) or `.claude/hooks/` (workspace).
- AC3: The CLI command `memo install-hooks` accepts options: `--host <host>`, `--global`, `--dry-run`, `--apply`, `--force`, `--json`, and `--remove` (alias `--uninstall`).

### Antigravity Hook Adapter

- AC4: For Antigravity, `install-hooks` emits a valid `hooks.json` mapping `PreInvocation` with `invocationNum == 0` to non-blocking `memo bootstrap` and `prompt session_start`.
- AC5: Antigravity hooks map completion events to `memo prompt session_end` to persist session deliverables and write active handoffs.
- AC6: Existing custom hooks in `hooks.json` are preserved by performing deep JSON object merging rather than destructive file overwriting.

### OpenCode, Claude & Cursor Hook Adapters

- AC7: For OpenCode, `install-hooks` generates an event plugin that triggers `memo bootstrap` on initialization, `memo prompt record` on prompt turns, and `memo sync` on exit.
- AC8: For Claude Code, `install-hooks` generates lifecycle hooks mapping `SessionStart` to `memo bootstrap`, `UserPromptSubmit` to `memo prompt record`, `PreCompact` to `memo prompt record --checkpoint` (saving active working memory turns before LLM context compression), and `SessionEnd` to `memo prompt session_end`.
- AC9: For Cursor, `install-hooks` generates an active rule `.cursor/rules/spec-memo.mdc` configured with `alwaysApply: true` instructing Cursor Agent to invoke `bootstrap` on intake and record session summaries into `spec-memo`.
- AC10: Cursor rule files include file-pattern frontmatter ensuring they apply across all source files in the project.

### Non-Blocking Fail-Open Execution Contract

- AC11: All shell and script hooks generated by `install-hooks` invoke `memo` with strict execution timeouts (maximum 1500ms) and redirect stdout/stderr to avoid hanging agent startup.
- AC12: If `memo` executable is not found or fails with non-zero exit code, generated hooks exit 0 silently (fail-open), ensuring agent workflows never halt due to memory tooling.

### Installation Safety, Removal & CLI UX

- AC13: Running `memo install-hooks` without `--apply` performs a dry-run preview, displaying the exact target paths and content diffs to be written without modifying the filesystem.
- AC14: Passing `--apply` creates necessary parent directories and writes configuration files atomically, creating timestamped `.bak` copies if target files already exist and differ.
- AC15: Passing `--remove` (or `--uninstall`) cleanly removes `spec-memo` hooks from target host configurations (restoring from `.bak` or pruning the `spec-memo` block), returning the environment cleanly to Skill-Only Mode.
- AC16: Passing `--json` emits structured machine-readable results (`{ host, path, status: 'installed' | 'removed' | 'unchanged' | 'preview', diff }`).

### Optional Hook Decoupling & Doctor Diagnostics

- AC17: `spec-memo` functions with 100% operational feature completeness in Skill-Only Mode using only the autoloaded `ws-memo` skill, without requiring `memo install-hooks`.
- AC18: Generated hook templates include a header stamp (`// generated-by: spec-memo@<version>`); `memo doctor` inspects installed hooks and reports `Agent Hooks: Not installed (Skill-only mode active via ws-memo)` when absent, or reports installed status and warns if hook templates are outdated compared to the running package version.

---

## Notes

- **Strictly Optional:** `memo install-hooks` is never required for core `spec-memo` operation. Users relying on `ws-memo` autoloading have full access to all 11 MCP tools, bootstrap briefs, session tracking, and sync.
- **Zero MCP Tool Count Impact:** Operates as a CLI utility (`memo install-hooks`) and `doctor` diagnostic check; requires zero new MCP tools.
- **Strict Git Boundary:** Local workspace hook files (`.agents/hooks.json`, `.cursor/rules/spec-memo.mdc`) are standard configuration files committed or ignored per team convention; no vault database files are touched.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mandatory hook installation on daemon start | Hooks are strictly opt-in; users may prefer purely prompt-driven skill autoloading. |
| Interactive GUI wizard | Terminal CLI flags (`--host`, `--apply`) and dry-run previews provide automated DevOps and agentic compatibility. |
| In-memory interception of closed proprietary agent binaries | Uses documented public extension surfaces (`hooks.json`, `.cursor/rules`, OpenCode plugins). |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Primacy of Skill-Only Mode | Skill-only mode is default and fully supported | Avoids invasive global configuration for users who prefer standard agentic skill routing. | y |
| Default installation target | Workspace-local unless `--global` | Allows project-specific repository tailoring without polluting global developer configs. | y |
| Existing file conflict handling | Safe JSON merge or `.bak` copy | Prevents overwriting preexisting user-defined agent hooks. | y |
| Sub-second timeout budget | 1500 ms maximum | Balances SQLite FTS read latency with instant UI responsiveness. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Dual-Mode Architecture | Verified clean decoupling between Skill-Only and Hook-Automated modes | Documentation and doctor output verification |
| Architectural Alignment | Follows patterns in `src/setup.ts` and `src/skills-install.ts` | Code inspection and design review |
| Fail-Open Safety | Zero blocking or fatal exceptions when `memo` is unavailable | Automated integration test with broken path |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo doctor` with no hooks installed: displays `Agent Hooks: Not installed (Skill-only mode active via ws-memo)`.
- `memo install-hooks --host antigravity`: prints dry-run preview of `hooks.json`.
- `memo install-hooks --host cursor --apply`: writes `.cursor/rules/spec-memo.mdc` and returns exit code 0.
- `memo doctor` with hooks installed: outputs "Agent Hooks: Antigravity (Active), Cursor (Active)".

### Negative & Failing Test Scenarios

- Specifying an unsupported host (e.g. `--host unknown`) errors cleanly with allowed choices.
- Running without installed hooks never causes test failures in standard test suites.
- Hook scripts simulated with an unresponsive daemon timeout within 1500ms and return exit code 0.
