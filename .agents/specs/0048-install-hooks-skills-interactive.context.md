# Context — install-hooks-skills-interactive

## Feature Boundary

This slice changes **how operators pick destinations** for two existing installers. It does not change vault MCP tools other than adding fail-closed `confirm` / `hosts` / `scope` on `install_skills`. Hook **event mappings** for Antigravity, OpenCode, Cursor, and Claude stay as in `0041-agent-hooks-install.spec.md`. Hook **command path prefixes** are in-scope: local product-tree vs global `./hooks/` (see spec AC26–AC29). Skill file contents stay the packaged `ws-memo` / `ws-session-tracking` trees.

In: TTY wizard, explicit host list, conflict policy enum, Codex host, OS preflight, no write without permission.

Out: GUI, npm postinstall, new MCP hooks tool, setup-time auto wiring.

## Implementation Decisions

1. **TTY gate copies reconcile.** Prompt only when `process.stdin.isTTY && process.stdout.isTTY` and `--yes` / `--json` are absent. Same trap as interactive reconcile.
2. **Wizard confirm equals apply for hooks.** After the user says yes, write the previewed files (equivalent to `--apply`). `--dry-run` skips writes after showing the same plan.
3. **`--host` is repeatable or CSV.** Example: `--host cursor --host claude` or `--host cursor,claude`.
4. **Codex layout (default until vendor docs contradict in tests):** workspace `productRoot/.codex/AGENTS.md` (or a stamped block merge if the file exists and policy allows) and global `$HOME/.codex/AGENTS.md`. If Codex later documents a different path, update tests and `resolveHostHookPaths` only.
5. **Shared agents skills root:** global `--host` values that consume `$HOME/.agents/skills` are `cursor` (when Cursor reads that root) plus any host that documents `~/.agents/skills`. Gemini uses `~/.gemini/config/skills` only when `antigravity` is selected.
6. **MCP agents:** `confirm: true` is the permission bit. Hosts must be explicit. No readline in `src/tools.ts`.
7. **Cursor/Claude hook command cwd:** User-level Cursor runs hooks with cwd `$HOME/.cursor`. Local install keeps `bash .cursor/hooks/spec-memo-*.sh`. Global install emits `bash ./hooks/spec-memo-*.sh` and writes scripts to `$HOME/.cursor/hooks/`. Same split for Claude (` .claude/hooks/` vs `./hooks/` under `$HOME/.claude`). `update` rewrites stamped global JSON that still has the product-tree prefix. Do not add foreign `workspaceOpen` commands.

## Deferred Ideas

- Status monitor "Install" tab.
- Detect running IDE and prompt only that host (still require confirm).
- Symlink vs copy for skills.
- Per-host "hooks only" vs "skills only" in one combined `memo install` command (this slice keeps two commands sharing one wizard).
