---
id: null
slug: memo-status
title: "CLI status query and unified configuration inspector"
source: local
specDate: 2026-08-31
---

# Specification — CLI status query and unified configuration inspector

## Description

Provide a dedicated, read-only CLI command `memo status` (with aliases `memo info`, `memo state`, and `memo setup --check`/`memo setup --status`) that queries and displays the complete operational state of `spec-memo`.

The command provides developers and agentic workflows with immediate visibility into:
1. **Deployment Mode & Remote Topology**: Active mode (`local`, `hybrid`, `remote`), configured remote URL, authentication token presence (`SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`), and remote daemon health probe.
2. **Configured Daemon Ports & Live Service Reachability**: Configured and active ports for the MCP SSE transport server (`ports.sse` / `ports.mcp`, default `3123`), the Status Monitor companion (`ports.status` / `ports.ui`, default `3124`), and the Canvas visualizer (`ports.canvas`, default `3125`), along with live reachability status (`RUNNING` / `STOPPED`) determined by lightweight HTTP/TCP probes.
3. **Active Project & Vault Identity**: Current working directory (`cwd`) project binding, Project ID, normalized git remote URL, fallback path detection, and vault storage paths.
4. **Storage & Records Inventory**: Breakdown of memory records in the active project by kind (`trap`, `decision`, `spec`, `plan`, `prompt`, `session`, `log`, `review`, `scratch`), total project count across the entire vault, SQLite FTS5 database size and indexed document count, and snapshot backups count and storage footprint in `$SPEC_MEMO_ROOT/backups/`.
5. **Operational Configuration**: Telemetry settings, retention policies (TTL for scratch/review records and log compaction), and private Vault Git synchronization status.
6. **Machine-Readable & Health Check Flags**: Support for `--json` output for automated tooling/dashboards, and an optional `--check` flag that exits with code 0 if all configured services and vault integrity checks pass, or exit code 1 if remote daemons are unreachable or configuration errors exist.

The command is strictly read-only: it does not modify `config.json`, unlink files, or mutate records. All configuration modifications remain explicitly encapsulated within `memo setup`.

---

## Acceptance Criteria

- AC1: **Command Invocations & Aliases:** Running `memo status`, `memo info`, `memo state`, `memo setup --check`, or `memo setup --status` invokes the status inspector without triggering interactive setup or modifying configuration.
- AC2: **Deployment Mode & Topology Inspection:** The status output identifies active mode (`local`, `hybrid`, or `remote`), configured remote URL, and bearer authentication token presence in the environment.
- AC3: **Remote Daemon Live Probe:** When in `hybrid` or `remote` mode, the command probes the remote daemon `/health` endpoint and reports live reachability status (`REACHABLE`, `UNREACHABLE`, or HTTP error code).
- AC4: **Daemon Ports & Service Reachability Probes:** Resolves configured ports from `config.json` (defaults `3123` SSE, `3124` Status, `3125` Canvas) and runs fast probes to report if each daemon is `RUNNING` or `STOPPED`.
- AC5: **Active Project & Vault Binding:** Displays the active vault root, configuration file path, and resolves current working directory (`cwd`) to bound `projectId`, git remote origin, and relative vault project folder.
- AC6: **Record Counts by Kind:** The status report tallies and presents active records in the current project categorized by kind (`traps`, `decisions`, `specs`, `plans`, `prompts`, `sessions`, `logs`, `reviews`, `scratch`).
- AC7: **Global Vault & Backup Storage Metrics:** Reports the total count of registered projects in the vault, SQLite FTS5 database status and size, and snapshot backups count and disk footprint.
- AC8: **Operational & Telemetry Summary:** Reports operational settings from `config.json` including telemetry status (`enabled`/`disabled`, log file path, rotation limit), TTL retention policies, and Vault Git sync status.
- AC9: **Machine-Readable JSON Output:** Running `memo status --json` emits a structured JSON object to `stdout` conforming to typed `StatusResult`, without ANSI escape codes, suitable for machine parsing.
- AC10: **Strict Read-Only Guarantee:** Executing `memo status` (with or without flags) never creates, edits, or deletes any files in the vault root, project folders, or product working tree.
- AC11: **Negative & Failure Handling:** When `config.json` contains malformed JSON or invalid types, `memo status` does not crash; it reports the error clearly with `CONFIG_ERROR` status and exits cleanly.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Modifying configuration options via `memo status` | Configuration changes are strictly owned by `memo setup`. |
| Starting or stopping daemon processes | Daemon lifecycle is owned by `memo serve` and process managers (e.g. systemd/Task Scheduler). |
| Repository pollution cleanup or FTS rebuilds | Deleting in-tree pollution and rebuilding SQLite FTS5 is owned by `memo doctor --fix --rebuild`. |
| Interactive TUI / continuous live streaming | `memo status` is a single-shot query command; live activity streaming is provided by the SSE status monitor (`:3124`). |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Command naming and entrypoint | `memo status` with alias `memo info` | Matches standard CLI developer conventions (e.g. `git status`). | Yes |
| Probe timeout for local daemons | 1500ms timeout per local endpoint probe | Keeps CLI execution snappy and prevents terminal hangs when ports are inactive. | Yes |
| Probe timeout for remote daemons | 3000ms timeout with AbortController | Prevents prolonged CLI blocking when remote network daemon is slow or offline. | Yes |
| Support for `memo setup --check` | Alias to `memo status` | Preserves intuition for users querying configuration via `memo setup`. | Yes |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded Scope | Read-only inspection of config, daemons, projects, and storage | Verified non-mutating via filesystem checks |
| Atomic Criteria | Explicit ACs covering CLI options, probes, formatting, and JSON output | Verified by automated unit and CLI integration tests |
| Failure Modes | Malformed config, unreachable daemons, and unbound directories handled gracefully | Negative test suite with simulated network drops and invalid configs |
| Observation Telemetry | Exit codes, structured JSON output, and CLI summary lines | Test assertions on stdout/json schema and exit codes |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- CLI Execution: `memo status` displays ANSI colorized dashboard.
- JSON Query: `memo status --json` outputs structured JSON conforming to `StatusResult`.
- Verification Test Suite: `node --test dist/status-cmd.test.js` or `npm test`.

### Negative & Failing Test Scenarios

- **Unreachable Services:** When all daemons are stopped, `memo status` reports `STOPPED` for each local service and does not throw ECONNREFUSED or hang.
- **Malformed Configuration:** When `config.json` has invalid JSON syntax, `memo status` outputs a clean error message without crashing.
- **Unbound Working Directory:** When executed in a directory outside git or without remote, reports fallback path ID correctly.
- **Offline Remote Daemon:** When in `remote` or `hybrid` mode with an invalid/unreachable URL, reports `UNREACHABLE` with diagnostic error message within 3 seconds.

---

## Notes

### Design Intent

Adding `memo status` introduces a dedicated, read-only operational query command that provides clear visibility into active configuration, running daemon processes, port allocations, and vault storage health. This cleanly separates inspection from mutation (`memo setup`) and deep repository pollution scanning (`memo doctor`).

### Technical Considerations

- The status module should be implemented in `src/status-cmd.ts` and exported cleanly to `src/cli.ts`.
- The live probe should use Node.js native `fetch` (with `signal: AbortSignal.timeout(ms)`) or `net.createConnection` to probe service reachability non-invasively.
- The `memo setup` CLI router should support `--check` and `--status` flags to forward directly to the status inspector.
