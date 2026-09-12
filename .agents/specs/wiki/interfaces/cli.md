# CLI Surface (`memo`)

## Feature Overview

`memo` is the command-line front door to the same engine exposed by the MCP server. `src/cli.ts` is published as `dist/cli.js` through `package.json` `bin.memo`, with a `#!/usr/bin/env node` shebang. It gives agents and humans a deterministic, scriptable surface: `--json` for automation and plain/colorized text for terminals.

Representative journeys:

- Session startup: `memo bootstrap --cwd <repo> --slug <slice>` (returns the token-budgeted brief).
- Recall: `memo search "database lock" --kind trap --path src/db/client.ts`.
- Remember: `memo upsert --kind trap --title "..." --path-patterns "src/**/*.ts" --body "..."`.
- Operate/diagnose: `memo status`, `memo doctor`, `memo sync`, `memo install-hooks`, `memo install-skills`.

Every core tool is reachable through a generic 1:1 dispatcher; CLI-only extras add operational commands that have no MCP counterpart.

## Business Rules & Logic

- Command resolution: `resolveCliCommand` maps kebab aliases to MCP tool names: `check-version` to `check_version`, `install-skills` to `install_skills`, and `prompts`, `session`, `activity` all to `prompt`.
- Argument parsing (`parseCliArgs`): supports `--key value` and `--key=value`; the first non-flag token is the command and remaining tokens are positionals; `--help`/`-h` before a command prints general help, after a command prints subcommand help; `--version`/`-v` prints the package version; `--json` selects machine mode. Repeated `--host` values are merged into a CSV string by `setParsedOption`.
- Exit codes: `runCli` returns 0 on success and 1 on failure; the entry point calls `process.exit(exitCode)` only when non-zero. `memo doctor` and `memo status --check` additionally return 1 when issues are detected.
- Output contract: successful human-readable output goes to stdout via `console.log`; with `--json`, `printJson` writes sanitized JSON to stdout (`JSON.stringify(..., null, 2)`). Errors and validation messages go to stderr via `console.error`, except in `--json` mode where an error object `{ isError: true, error, code }` is printed to stdout so scripts can parse it.
- Unknown commands print `Unknown command: <cmd>` to stderr followed by the general help and return 1.
- Read-only commands bypass side effects: `isReadOnlyStatusCommand` covers `status`, `info`, `state`, and `setup`/`config` invoked with `--check`, `--status`, or `--info`. These are dispatched before `ensureVaultStructure` and skip CLI telemetry, guaranteeing no vault mutation.
- `--json` disables interactive prompts (install wizard, reconcile prompt).
- Node runtime gate: `assertSupportedNodeRuntime()` runs before dispatch; an unsupported Node emits `UNSUPPORTED_NODE` (JSON) or a stderr message and returns 1.
- CLI-only extras (not MCP tools): `doctor`, `rank`, `import`, `sync`, `reconcile`, `canvas`, `reset`/`reset-vault`, `restore`, `backups`, `vault`, `wiki`, `session`, `activity`, `install-hooks`, `hook install`, `shutdown`/`stop`, `init`, `export-vault`, `serve`.

## Technical Architecture

Core tool mapping: `TOOL_NAMES` currently holds 11 names (`bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version`, `install_skills`, `prompt`). When `parsed.command` is a tool name, the handler builds a `payload` from `parsed.options` (dropping `help`/`json`), normalizes command-specific flags (for example `--max-bytes` to `maxBytes`, `--kind` to `kinds`), and calls `executeTool(command, payload)`. Human renderers are per-command; `--json` prints `ToolResponse.data` verbatim.

Alias map (`CLI_TOOL_ALIASES`):

```text
check-version  -> check_version
install-skills -> install_skills
prompts        -> prompt
session        -> prompt
activity       -> prompt
```

Purpose-built CLI handlers (selected):

- `status|info|state` to `runStatusCheck` (`src/status-cmd.ts`), rendered by `formatStatusDashboard`. Flags: `--check`, `--cwd`, `--vaultRoot`, `--json`. Strictly read-only; `--check` exits `result.ok ? 0 : 1`; without `--check` it exits 0.
- `doctor [productRoot]` to `runDoctor` (`src/doctor.ts`). Flags: `--cwd`, `--vaultRoot`, `--productRoot`, `--check-capture <path>`, `--fix`, `--include-tracked`, `--rebuild`, `--json`. Exits `result.healthy ? 0 : 1`; `--check-capture` exits `result.healthy ? 0 : 1` where healthy means the path is `CAPTURED`. See [Diagnostics](diagnostics.md).
- `import [productRoot]` to `importWorkflowTree` (`src/importer.ts`). Flags: `--from`, `--cwd`, `--vaultRoot`, `--json`. See [Import](import.md).
- `install-hooks` / `install-skills` to the shared wizard and permission gates (`src/hooks-install.ts`, `src/skills-install.ts`). See [Agent Adapters](agent-adapters.md) and [MCP Tooling](mcp-tooling.md).
- `hook install` to `installPreCommitHook` (`src/hook.ts`): writes `.git/hooks/pre-commit`; an existing foreign hook is copied to `<hook>.spec-memo.bak` first.
- `serve` to `startMcpServer` (stdio) or `startSseServer` (`--sse`); `--status`/`--status-port` opt the stdio companion in, while `--sse` enables it by default and `--no-status` disables it.
- `setup`/`config` to `runSetup` (`src/setup.ts`). Flags: `--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`, `--auth-token`, `--vault-root`, `--vaultRoot`, `--json`. Auth tokens are never written to `config.json`.

US-36 OpenCode snippet shape: `generateHostMcpSnippet` emits, for OpenCode, an `mcp` object with `type: "local"`, `command` as a string array (`["memo","serve"]`), and `enabled: true`; with a non-default vault root it appends `--vaultRoot <root>` to `command` and adds `environment.SPEC_MEMO_ROOT`. No `args` key is emitted (OpenCode `McpLocalConfig` rejects `type: "stdio"` and separate `args`). All other hosts (`cursor`, `vscode`, `antigravity`, `claude`, `generic`) keep `command: "memo"` plus an `args` array. `stripStatusAutostartArgs` removes `--status`, `--no-status`, and `--status-port` from host MCP args so per-editor-window stdio servers never race on port 3124.

CLI binary resolution follows the AGENTS.md contract: prefer `memo` on `PATH`, else `node dist/cli.js` (or an absolute `node <path>/dist/cli.js`). Global symlinks point at `dist/cli.js`, so `npm run build` does not invalidate them.

Help and version: `printGeneralHelp` lists Core Memory Commands, Utility Commands, and Global Options (`--json`, `-h/--help`); `printCommandHelp` prints per-command usage, and for core tools it derives the property list from `TOOL_DEFINITIONS[...].inputSchema`. `memo --version` / `-v` prints `getPackageVersion()` (or `{ "version": ... }` with `--json`). `isCliMainEntry()` guards the entry point so importing `cli.ts` from tests does not run the CLI.

Telemetry: `runCli` records a `cli_command` telemetry event with operation, duration, success, exit code, and `isJson`/`subcommandHelp` metadata, then flushes; read-only status and read-only wiki get are excluded so pure inspection never writes telemetry state.

Error rendering pattern (representative): each handler catches, then either `printJson({ isError: true, error, code: '<COMMAND>_ERROR' })` or `console.error('<Command> failed: ' + msg)`, returning 1. Codes include `DOCTOR_ERROR`, `IMPORT_ERROR`, `INSTALL_HOOKS_FAILED`, `INSTALL_SKILLS_FAILED`, `SETUP_ERROR`, `HOOK_ERROR`, `RANK_ERROR`, and `SSE_ERROR`.

Provenance: `0005-import-and-doctor.spec.md`, `0009-cli-doctor.spec.md`, `0031-memo-status.spec.md`, `0045-us-36.spec.md`.
