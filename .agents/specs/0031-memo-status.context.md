# Context & Gray Area Analysis — CLI Status Query and Unified Configuration Inspector

## Feature Boundary

The `memo status` command is designed exclusively as a **read-only diagnostic, configuration, and runtime status query engine** for `spec-memo`.

### What `memo status` does:
- Reads and displays configuration options from `$SPEC_MEMO_ROOT/config.json` (or default fallback).
- Detects and queries active deployment modes (`local`, `hybrid`, `remote`).
- Checks configured daemon ports (`sse`, `status`, `canvas`) and performs non-blocking live probes to determine if servers are currently running and responsive.
- Inspects active project binding for the current working directory (`cwd`) and tallies record counts across memory kinds.
- Reports global vault storage metrics (total projects, SQLite FTS5 database size, and snapshot backups count/size).
- Provides formatted human-readable terminal output and `--json` machine-readable output.

### What `memo status` does NOT do:
- **No Mutations:** Does not write, modify, or delete `config.json` (mutations remain exclusively in `memo setup`).
- **No In-Tree File Deletion or Fixes:** Does not delete repository pollution or rebuild FTS indices (that remains in `memo doctor --fix --rebuild`).
- **No Stdio Server Spawn:** Does not launch long-running daemon processes (that remains in `memo serve` or `memo canvas`).

---

## Implementation Decisions

### 1. Dedicated Command vs `memo setup --check`
- **Decision:** Provide `memo status` as the primary top-level CLI command, while simultaneously providing backward-compatible aliases `memo info`, `memo state`, and `memo setup --check` / `memo setup --status`.
- **Rationale:** Users instinctively run `memo status` or `git status` to see what is running and what configuration is active. Having `memo status` distinct from `memo setup` keeps read-only inspection separate from configuration mutation.

### 2. Live Probe Strategy (Non-Blocking & Timeout Guarded)
- **Decision:** Probe local endpoints (`http://127.0.0.1:<port>/health`, `/api/status`, `/api/graph`) and remote daemons using `AbortController` with a short default timeout (e.g. 1.5s for local, 3s for remote).
- **Rationale:** A status check must feel instant in the terminal. If a server is down, probing must fail quickly and report `STOPPED` or `UNREACHABLE` without hanging the CLI.

### 3. Separation of Concerns between `memo doctor` and `memo status`
- **`memo doctor`:** Deep diagnostic scan focusing on SQLite FTS5 integrity, file corruptions, and in-repo git boundary pollution (`.agents/plans/`, `MEMORY.md`), with mutating `--fix` and `--rebuild` options.
- **`memo status`:** High-level operational overview focusing on daemon runtime states, active ports, deployment topology, storage metrics, and project binding.

---

## Deferred Ideas

- **Live TUI Watch Mode (`memo status --watch`):** Adding a dynamic ncurses/blessed terminal UI that continuously updates live stats. Deferred to a future release.
- **Remote Vault Deep Metric Sync:** Querying remote daemon database statistics over HTTP in remote mode. Deferred to keep network traffic minimal.
