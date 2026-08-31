---
id: null
slug: vault-reset-and-proxy-monitor
title: "Vault reset with pre-wipe timestamped backup, full backup restoration, and proxy status monitor with 3-mode topology UI"
source: local
specDate: 2026-08-31
status: done
target_phase: Phase 7
---

# Specification — Vault reset with pre-wipe timestamped backup, full backup restoration, and proxy status monitor with 3-mode topology UI

## Description

Operators and coding agents need a deterministic mechanism to completely reset the spec-memo working memory and SQLite database without risking irreversible data loss, alongside the ability to seamlessly restore full backups from `.zip` (and `.json`) archives via CLI and UI. Simultaneously, when running in distributed configurations (where an intermediary proxy server forwards or synchronizes memory deltas to a central remote master vault), operators running the proxy node need local visibility into MCP traffic, sync telemetry, and an unambiguous dashboard indicator clarifying whether the instance is acting as a **Local Vault**, an **Intermediary Proxy / Hybrid Node**, or the **Final Remote Server**.

This specification introduces three cohesive capabilities:

1. **Complete Database Reset & File Clear with Mandatory Pre-Wipe Backup:**
   - Adds a safe, atomic reset engine that wipes all memory records (`projects/*/records/`), compiled indexes (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`), SQLite search databases (`memo.sqlite*`), and sync cursors/state files while strictly preserving configuration (`config.json`).
   - **Safety Invariant:** Before any deletion or database drop occurs, the engine automatically generates a full, portable ZIP archive formatted as `{yyyy-mm-dd-HH-mm-ss-backup}.zip` (stored safely under `$SPEC_MEMO_ROOT/backups/` and downloadable via UI/CLI).
   - Reinitializes an empty, healthy vault directory layout and clean SQLite FTS5 database immediately following the wipe, allowing seamless restart of memory.
   - Exposed via CLI (`memo reset [--all] [--project <id>] [--force]`), HTTP companion API (`POST /api/vaults/reset`), and a protected modal in the `:3001` Status Monitor UI.

2. **Full Backup Restoration Engine & Management:**
   - Enhances the backup restoration engine (`importVault` / `restoreVault`) to seamlessly support both `.zip` archives (containing `vault-backup.json` or `.json` payloads) and `.json` archive files (plaintext or AES-256-GCM encrypted).
   - Automatically unpacks ZIP archives, decrypts password-protected payloads when provided, restores project metadata (`project.json`), memory records, and vault configuration (`config.json`), rebuilds compiled markdown views (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`), and re-indexes SQLite FTS5.
   - Provides listing of available backups under `$SPEC_MEMO_ROOT/backups/` via CLI (`memo backups`) and REST API (`GET /api/vaults/backups`).
   - Enables CLI restoration via `memo restore [--backup <path> | <path>] [--latest] [--password <pwd>] [--overwrite]` and Status UI one-click restore from local backup archives as well as file upload.

3. **Proxy Instance Status Monitor (:3001) & 3-Mode Architecture Topology UI:**
   - Enables stdio proxy instances (`memo serve` / `memo serve --proxy` or hybrid daemon instances) to optionally start the companion HTTP status server on port `:3001` (`--status-port`), allowing operators on proxy/client workstations to inspect live tool traffic, proxy latency, and sync state in real time.
   - Prominently visualizes the node's architectural role in the `:3001` Status Monitor UI across the 3 supported topology modes:
     - **Mode 1: Local Vault (`local`)** — Self-contained local filesystem store (`~/.spec-memo/`) with local FTS5 indexing and zero network dependencies.
     - **Mode 2: Intermediary Proxy / Hybrid (`hybrid` / `proxy`)** — Intermediary node caching local working memory, forwarding MCP requests, and synchronizing changesets with the remote master daemon (`Proxy → {remoteUrl}`).
     - **Mode 3: Final Remote Server (`remote` daemon)** — The authoritative central master repository and ultimate backup source of memory for all connected agents and proxy instances.
   - Adds a prominent **Topology & Deployment Mode Badge/Card** in the dashboard header, detailing current mode, upstream origin, downstream connected clients, and live sync health.

Architecture touchpoints:

- **Backup & Reset Engine (`src/backup.ts`, `src/status-backup.ts`, `src/types.ts`)**:
  - `resetVault({ vaultRoot, projectId?, password?, backupDir? })`: runs `exportVault()`, packs ZIP with filename `{YYYY-MM-DD-HH-mm-ss-backup}.zip` (ISO-compatible timestamp safe for Windows/Linux/macOS), saves to `$SPEC_MEMO_ROOT/backups/`, locks vault via `withVaultLock`, removes target records/database files, reinitializes vault scaffolding via `ensureVaultStructure()`, and rebuilds empty FTS5 index.
  - `importVault({ vaultRoot, archivePath?, payload?, password?, overwrite? })` / `restoreVault`: handles `.zip` archive paths transparently by unpacking via `unpackVaultZip()`, handles `.json` archive payloads, decrypts AES-256-GCM, upserts records, rebuilds compiled views and FTS index.
  - `listBackups(vaultRoot?)`: returns chronological list of backups under `$SPEC_MEMO_ROOT/backups/`.
- **Proxy Server & Stdio Transport (`src/mcp-proxy.ts`, `src/server.ts`, `src/cli.ts`)**:
  - Extend `startRemoteMcpProxyServer` and CLI `memo serve` in remote/proxy mode to accept `--status`, `--status-port`, `--status-host`, and `--auth-token`, booting an in-process status companion and Activity Bus capturing proxied tool invocations and upstream health.
- **Status Monitor API & Dashboard UI (`src/status.ts`)**:
  - `POST /api/vaults/reset`: authenticated endpoint accepting `{ projectId?: string, password?: string, confirm: boolean }`, triggering pre-wipe backup and clean reset, returning `{ ok: true, backupFilename, backupPath, wipedProjectsCount, wipedRecordsCount }`.
  - `GET /api/vaults/backups`: authenticated endpoint returning list of `{ filename, path, size, createdAt, isZip }`.
  - `POST /api/vaults/restore`: authenticated endpoint accepting JSON `{ backupFilename?: string, password?: string, overwrite?: boolean }` or multipart `.zip`/`.json` file upload.
  - `GET /api/status`: enriched with `mode: 'local' | 'hybrid' | 'remote'`, `role: 'local-vault' | 'intermediary-proxy' | 'final-remote'`, `upstreamRemoteUrl?: string`, `syncState?: { dirty: boolean, lastSyncAt: string | null }`, and `topology`: `{ mode, isProxy, isRemoteDaemon, description }`.
  - UI Header & Dashboard: prominent visual badges and topological relationship indicators (Emerald for Local Vault, Cyan/Amber for Intermediary Proxy with upstream link, Indigo/Purple for Final Remote Server), Backup & Restore management controls, and Reset Vault danger zone modal.
- **Activity Bus (`src/activity.ts`)**:
  - Captures `type: "system"`, `kind: "write"` events for vault reset and restore operations, and `type: "proxy"` events for proxied tool requests.
- **Documentation & Safety (`README.md`, `AGENTS.md`, `src/safety.ts`)**:
  - Document `memo reset`, `memo restore`, `memo backups`, safety backup zip retention, proxy status monitor execution, and 3-mode topology model.

## Acceptance Criteria

### Group 1 — Safe Vault Reset & Timestamped Pre-Wipe Backup

- AC1: Calling the reset engine (`resetVault`) with a valid `vaultRoot` MUST automatically create a complete, valid ZIP backup archive before modifying or deleting any existing records, databases, or indexes.
- AC2: The generated backup ZIP filename MUST adhere to the pattern `{YYYY-MM-DD-HH-mm-ss-backup}.zip` (e.g. `2026-08-31-10-15-30-backup.zip` with 4-digit year, 2-digit month, day, hour, minute, second) using filesystem-safe hyphens on all platforms (Windows, macOS, Linux).
- AC3: The backup ZIP archive MUST be persisted in `$SPEC_MEMO_ROOT/backups/` and contain a valid `vault-backup.json` payload restorable via `importVault` / `memo restore` or the Status UI restore facility.
- AC4: If the pre-wipe backup generation fails (e.g., disk full, write error), the reset operation MUST abort immediately without deleting any records or dropping database tables (fail-safe transaction boundary).
- AC5: When resetting a single project (`projectId` provided), only records under `projects/{projectId}/` and corresponding FTS index entries are wiped; other projects and global config remain untouched.
- AC6: When resetting the entire vault (`projectId` omitted or `--all`), all project directories under `projects/`, the SQLite database (`memo.sqlite*`), and hybrid sync cursors (`.sync/`) are removed, while `config.json` and `$SPEC_MEMO_ROOT/backups/` are strictly preserved.
- AC7: Immediately following deletion, `resetVault` MUST call `ensureVaultStructure()` and `rebuildIndex()` to guarantee a clean, healthy directory tree and initialized SQLite database ready for immediate new writes.
- AC8: CLI provides `memo reset [--all] [--project <id>] [--force] [--password <pwd>]` (and sub-command alias `memo vault reset`). When run in interactive TTY mode without `--force`, it requires explicit user confirmation before proceeding; in non-interactive mode without `--force`, it exits with a non-zero error.
- AC9: On successful CLI reset, the command outputs the absolute path and filename of the created `{YYYY-MM-DD-HH-mm-ss-backup}.zip` archive.
- AC10: `POST /api/vaults/reset` on the `:3001` status monitor accepts authenticated JSON `{ projectId?: string, password?: string, confirm: boolean }`. Missing `confirm: true` returns `400 Bad Request`.
- AC11: Successful `POST /api/vaults/reset` returns `200 OK` JSON `{ ok: true, backupFilename: string, backupPath: string, wipedProjectsCount: number, wipedRecordsCount: number }` and emits a `type: "system"`, `kind: "write"` event on the Activity Bus summarizing the backup archive name and wipe statistics.

### Group 2 — Full Backup Restoration Engine & Management

- AC12: `importVault` / `restoreVault` accepts `archivePath` pointing directly to a `.zip` archive, unpacks the backup JSON payload, and restores all project records, compiled views, and SQLite FTS5 index.
- AC13: When restoring from an encrypted `.zip` or `.json` archive, `password` is used to decrypt the AES-256-GCM payload; incorrect or missing password throws a descriptive error and aborts restore cleanly.
- AC14: `listBackups` inspects `$SPEC_MEMO_ROOT/backups/` and returns an array of backup metadata objects sorted chronologically descending.
- AC15: CLI provides `memo restore [--backup <path> | <path>] [--latest] [--password <pwd>] [--overwrite]` (with `memo import-vault` and `memo restore-vault` as aliases) and `memo backups` (listing available archives in `$SPEC_MEMO_ROOT/backups/`).
- AC16: Status monitor exposes `GET /api/vaults/backups` returning the list of available backups in `$SPEC_MEMO_ROOT/backups/`, and `POST /api/vaults/restore` accepting either a named backup from `$SPEC_MEMO_ROOT/backups/` or a multipart `.zip`/`.json` file upload.
- AC17: Status UI provides a Backup & Restore management section allowing operators to download backups, choose from historical backups to restore with one click, or upload an external backup file.

### Group 3 — Proxy Instance Status Monitor (:3001)

- AC18: In `remote` proxy mode or `hybrid` mode, `memo serve` accepts `--status` (or default companion launch unless `--no-status`) and `--status-port <n>` (default `3001`) to start the companion HTTP status monitor on the proxy host.
- AC19: The proxy status companion instantiates an in-process Activity Bus and hooks into `callRemoteTool` / `createRemoteMcpProxyServer` to capture proxied tool dispatches, execution durations, upstream status, and error states.
- AC20: When the remote daemon is unreachable from the proxy, the proxy status monitor remains alive, serves the `:3001` UI, and marks the upstream daemon connection status as `Disconnected / Unreachable` with clear diagnostic logs.
- AC21: Proxy status monitor enforces the same loopback and authentication rules as the daemon status monitor (refusing non-loopback bindings without an auth token).

### Group 4 — 3-Mode Architecture Topology Indication & UI Emphasis

- AC22: `GET /api/status` returns an explicit `topology` object containing:
  - `mode`: `'local' | 'hybrid' | 'remote'`
  - `role`: `'local-vault' | 'intermediary-proxy' | 'final-remote'`
  - `roleLabel`: Human-readable label (`"Local Vault"`, `"Intermediary Proxy / Sync Node"`, or `"Final Remote Master Vault"`)
  - `upstreamRemoteUrl`: Normalized URL of the remote daemon when `mode` is `'hybrid'` or `'remote'`, else `null`
  - `isProxy`: `true` when running as an intermediary proxy forwarding to remote
  - `isRemoteDaemon`: `true` when running as the central SSE daemon host
  - `syncSummary`: For hybrid mode, status of dirty changes and last sync timestamp; for remote proxy, upstream connectivity state.
  - `description`: Explanatory description of the node's architectural role.
- AC23: The Status Monitor UI (:3001) navigation bar displays a prominent, high-contrast **Topology Mode Badge**:
  - **Local Vault:** Emerald badge with label `LOCAL VAULT (Standalone)`.
  - **Intermediary Proxy / Hybrid:** Cyan/Amber badge with label `INTERMEDIARY PROXY → {upstreamHost}` and a dynamic connectivity pulse indicator.
  - **Final Remote Server:** Indigo/Purple badge with label `FINAL REMOTE MASTER VAULT` and active client counter.
- AC24: The Status Monitor Dashboard features a dedicated **Architecture Topology Card** explaining the 3-tier model, highlighting the current node's active position in the hierarchy:
  - Mode 1: *Only local files vault (`~/.spec-memo/`)*.
  - Mode 2: *Intermediary proxy server caching & syncing to remote*.
  - Mode 3: *Final remote master server being the authoritative memory source & backup*.
- AC25: In Intermediary Proxy mode, the UI displays upstream connection latency, remote daemon origin URL, and quick-action buttons to test upstream health.
- AC26: In the Status UI, the **Reset Vault** action is available in the Danger Zone settings / Vault Management panel, displaying a modal warning that an automated `{YYYY-MM-DD-HH-mm-ss-backup}.zip` snapshot will be created before wiping.

### Group 5 — Quality Gates, Regression Protection & Documentation

- AC27: Automated unit and integration tests verify:
  - `resetVault` produces a restorable `{YYYY-MM-DD-HH-mm-ss-backup}.zip` file before deleting records.
  - Complete wipe restores empty directory structure and empty SQLite FTS index without deleting `config.json` or existing backups.
  - Reset aborts safely without data loss if backup generation fails.
  - `importVault` restores full vaults from `.zip` and `.json` archives.
  - `listBackups` enumerates backup archives in `$SPEC_MEMO_ROOT/backups/`.
  - `POST /api/vaults/reset`, `GET /api/vaults/backups`, and `POST /api/vaults/restore` authentication, payload validation, and activity event emission.
  - Proxy instance boots `:3001` status server and logs proxied tool traffic to the Activity Bus.
  - `GET /api/status` topology payload and UI mode badges for all 3 deployment modes (`local`, `hybrid`, `remote`).
- AC28: Version bump in `package.json` according to semver, with corresponding updates in `README.md`, `AGENTS.md`, and project tracking logs.

## Original Issue Context

User prompt (2026-08-31):
"add a spec that implements: allow reset database/clear files (backup with {yyyy-mm-dd-H:m:s-backup}.zip first). It's a complete reset with backup first, allowing restart database/memory. Also allow "proxy" instance to start the sse : 3001 server allowing the proxy instance also to monitor logs. Show in SSE :3001 instance if it's being used as the proxy (intermediary server) or final remote server, emphazing this with this info in UI. Remembering, there are 3 modes talks to: only local files vault, talking to the intermediary proxy server that syncs to remote, and the remote server being the final source / backup of memory. bump version, add tests (also add/update spec to include restoring full backup)"

### Prior Work Sweep

Keyword + git log sweep across existing codebase and specifications:

| Hit | Relation | Action |
|-----|----------|--------|
| `src/backup.ts` / [`vault-backup.spec.md`](vault-backup.spec.md) | Archive creation and restore engine (`exportVault`, `importVault`, AES-256-GCM) | Reused as the underlying snapshot engine before executing reset, enhanced for ZIP restores |
| `src/status-backup.ts` / [`status-vault-backup-ui.spec.md`](status-vault-backup-ui.spec.md) | Pure Node.js `packVaultZip` / `unpackVaultZip` utilities | Reused to package `{YYYY-MM-DD-HH-mm-ss-backup}.zip` without extra dependencies |
| `src/status.ts` / [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) | Companion `:3001` HTTP server, HTML dashboard, Activity Bus | Extended with `POST /api/vaults/reset`, `POST /api/vaults/restore`, `GET /api/vaults/backups`, topology metadata, and mode badges |
| `src/mcp-proxy.ts` / [`deployment-modes.spec.md`](deployment-modes.spec.md) | 3 deployment modes (`local`, `hybrid`, `remote`) and stdio proxy | Extended to allow proxy instances to host companion status monitor on `:3001` |
| `src/indexer.ts` | SQLite FTS5 index lifecycle (`initDb`, `rebuildIndex`) | Called during reset to reinitialize empty `memo.sqlite` database |

No open duplicate PR found for this feature slice.

### Design Intent

Prior to this specification, database reset required manual file deletion via shell commands, risking unrecoverable data loss if the user did not manually execute `memo export-vault`. Furthermore, restoring backups required separate low-level commands and lacked full ZIP archive support, and proxy instances in `remote` mode operated strictly headless via stdio without status monitor visibility. This slice solves all operational gaps with safety-by-default architecture: automatic timestamped ZIP backups before any wipe, robust full backup restoration from `.zip` and `.json` archives, and local observability with explicit 3-mode topological context on port `:3001`.

## Notes

- **Backup Naming Scheme:** The requested `{yyyy-mm-dd-H:m:s-backup}.zip` pattern is normalized to standard 2-digit zero-padded numbers: `YYYY-MM-DD-HH-mm-ss-backup.zip` (e.g. `2026-08-31-10-15-30-backup.zip`), ensuring consistent alphanumeric chronological sorting and compatibility with Windows NTFS filename constraints (where colons `:` are prohibited).
- **Safety Folder Location:** Backups are placed in `$SPEC_MEMO_ROOT/backups/`, which is excluded from reset wipes and excluded from Git commits by default.
- **Zero Extra Dependencies:** Utilizes built-in Node `zlib` via existing `packVaultZip` and `unpackVaultZip` in `src/status-backup.ts`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| In-place database corruption repair without reset | Handled by existing `memo doctor --rebuild` |
| Automatic periodic cron-based database resets | Reset is strictly an intentional operator-triggered action |
| Multi-tier cascading proxy topologies (Proxy → Proxy → Remote) | Spec-memo supports direct 3-mode topology: Local, Single Proxy / Hybrid, and Final Remote |
| Cloud object storage (S3/GCS) auto-upload of backup zip | Backups are stored locally in `$SPEC_MEMO_ROOT/backups/` and downloadable via HTTP/CLI |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Timestamp formatting in backup filename | `YYYY-MM-DD-HH-mm-ss-backup.zip` (e.g. `2026-08-31-10-15-30-backup.zip`) | Windows filesystems forbid colons (`:`) in filenames; zero-padded hyphens provide universal OS safety and alphanumeric sorting | y |
| Backup storage location | `$SPEC_MEMO_ROOT/backups/` | Dedicated directory segregated from project records, preserved across wipes | y |
| Reset scope options | Full vault reset (`--all`) or project-scoped reset (`--project <id>`) | Provides granular project wiping or full database reinitialization | y |
| Full backup restore formats | Both `.zip` and `.json` files (plaintext & encrypted) | Unifies CLI and UI backup restore workflows across formats | y |
| Config preservation | `config.json` is NEVER deleted during reset | Operator settings (auth tokens, remote URL, mode) must remain intact | y |
| Proxy status port default | Port `3001` (same default as daemon, configurable via `--status-port`) | Consistent developer experience across daemon and proxy environments | y |
| Implicit dimensions (rate limits, failure rollback) | `withVaultLock` transaction guard; abort reset if backup creation fails | Prevents data loss during unexpected disk or permission failures | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural Boundary | Reset engine encapsulated in core with transaction-like backup guard | Code inspection of `src/backup.ts` / `src/reset.ts` |
| Zero Data Loss Guarantee | Backup archive verified before unlink operations execute | Automated test verifying backup file exists before wipe |
| Platform Path Compatibility | Backup filename contains no forbidden characters (`:`, `*`, `?`) | Cross-platform test execution on Windows/Linux |
| Stdio Proxy Compatibility | Proxy status monitor runs alongside stdio transport without stdio pollution | Stdio MCP integration test verifying clean JSON-RPC communication |
| UI Responsiveness & Theme | Mode badges and topology card match existing dark-mode design system | Visual inspection and HTML snapshot tests in `src/status.test.ts` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- CLI output: `memo reset --all --force` prints `[OK] Vault backup created: {path}/{YYYY-MM-DD-HH-mm-ss-backup}.zip` and `[OK] Database and memory records reset successfully.`
- CLI output: `memo restore --backup {path}` prints `[OK] Restored {records} records across {projects} projects.`
- Activity Bus events: `type: "system"`, `kind: "write"`, `summary: "vault reset: created backup {filename}, wiped {n} records"`.
- HTTP Endpoints: `POST /api/vaults/reset`, `GET /api/vaults/backups`, `POST /api/vaults/restore`.
- Dashboard UI: Navigation bar displays Topology Mode Badge (`LOCAL VAULT`, `INTERMEDIARY PROXY`, `FINAL REMOTE MASTER VAULT`).

### Negative & Failing Test Scenarios

- **Failing Backup Halts Reset:** Simulate disk full or read-only filesystem during backup generation; verify that `resetVault` throws an error and no files in `projects/` or `memo.sqlite` are modified or deleted.
- **Corrupt / Invalid Backup Archive Restore:** Supply invalid or damaged ZIP/JSON file to `importVault`; verify error thrown and no existing records overwritten.
- **Unauthorized HTTP Reset / Restore:** Send `POST /api/vaults/reset` or `POST /api/vaults/restore` without valid bearer token when `authToken` is configured; verify `401 Unauthorized`.
- **Unconfirmed Reset Rejection:** Send `POST /api/vaults/reset` with `{ confirm: false }`; verify `400 Bad Request`.
- **Non-TTY CLI Rejection:** Execute `memo reset` without `--force` in non-interactive environment; verify non-zero exit code and zero deletions.
- **Proxy Downstream Reconnection Resilience:** Disconnect remote daemon while proxy status monitor is active; verify `:3001` UI displays disconnected status without crashing the proxy process.
