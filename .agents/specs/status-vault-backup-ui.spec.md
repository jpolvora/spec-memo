---
id: null
slug: status-vault-backup-ui
title: "Status monitor vault export and import UI"
source: local
specDate: 2026-08-26
status: completed
target_phase: Phase 7
---

# Specification — Status monitor vault export and import UI

## Description

Operators who run `memo serve --sse` already have a bookmarkable status monitor on port `:3001` for vault listing, health, and live MCP activity. Daily knowledge backup and disaster recovery today require the CLI (`memo export-vault` / `memo import-vault`). That friction discourages routine snapshots even though the portable archive engine exists in `src/backup.ts` (`exportVault` / `importVault`, `spec-memo-vault-v1` / optional AES-256-GCM).

This slice adds **UI-only** export and import controls to the status monitor page. The operator selects a vault project, clicks **Export**, and the browser downloads a `.zip` archive containing that project's structured memory in a format restorable by **Import**. **Import** accepts a previously exported `.zip`, validates it, and restores records into the local vault via the existing import engine. No new MCP tools and no new CLI subcommands — HTTP handlers on the status companion call the same backup module the CLI uses.

Architecture touchpoints:

- **Backup engine (`src/backup.ts`)**: reuse `exportVault({ projectId, password?, vaultRoot })` and `importVault({ payload | archivePath, password?, overwrite?, vaultRoot })`; do not fork archive semantics.
- **Zip wrapper (new helper in `src/backup.ts` or `src/status-backup.ts`)**: export wraps the JSON archive as a single entry `vault-backup.json` inside `spec-memo-vault-{projectId}-{YYYYMMDD-HHmmss}.zip`; import accepts `.zip`, extracts that entry (or the sole `.json` member), then passes JSON to `importVault`.
- **Status server (`src/status.ts`)**: add mutating routes limited to backup (`POST /api/vaults/export`, `POST /api/vaults/import`); extend embedded HTML/JS with export/import panel tied to the selected vault filter; keep existing read-only routes unchanged.
- **Activity bus (`src/activity.ts`)**: capture `type: "system"`, `kind: "write"` events summarizing export/import outcomes (project id, record counts, ok/error) — never passwords or archive bytes.
- **Safety (`src/safety.ts`)**: auth required on mutating routes when token configured; body size cap; redact errors; refuse path leaks in responses.
- **Auth / bind rules**: same loopback + bearer/`?token=` posture as existing status APIs; mutating routes require auth when `authToken` is set (stricter than read-only GET).
- **Deployment modes**: status companion runs on the daemon host vault in hybrid/remote; UI export/import operates on that host's `$SPEC_MEMO_ROOT` (document in README — not client-side vault).
- **Tests (`src/status.test.ts`, extend `src/backup.test.ts`)**: zip round-trip, HTTP export download headers, multipart import, auth refusal, activity capture, no regression on read-only AC7 routes except the explicit backup endpoints.
- **Docs (`README.md`, `AGENTS.md`)**: document UI backup workflow, zip filename pattern, optional encryption, and CLI parity note.

Greenfield additive slice that **narrows** the prior read-only status-monitor contract: only backup/import HTTP routes may mutate the vault. Design choices: [`status-vault-backup-ui.context.md`](status-vault-backup-ui.context.md).

## Acceptance Criteria

- AC1: When the vault filter selects a specific project, the page shows an enabled Export vault control for that project.
- AC1b: When the vault filter is All vaults, Export vault is disabled and helper text instructs the operator to pick a vault first.
- AC2: Clicking **Export vault** opens an optional password prompt (see context companion); on confirm, the page calls `POST /api/vaults/export` with JSON body `{ projectId, password? }` and triggers a browser file download.
- AC3: `POST /api/vaults/export` validates `projectId` against `getVaultProjectList(vaultRoot)`; unknown ids return `400` JSON `{ error: "Unknown projectId" }`.
- AC4: `POST /api/vaults/export` invokes `exportVault({ vaultRoot, projectId, password })` and returns `200` with `Content-Type: application/zip`, `Content-Disposition: attachment; filename="spec-memo-vault-{projectId}-{timestamp}.zip"`, and a zip body containing exactly one archive member named `vault-backup.json` whose UTF-8 content is the same JSON produced by the CLI export (plaintext `spec-memo-vault-v1` or encrypted `spec-memo-encrypted-vault-v1` when password provided).
- AC5: Export response never includes passwords, raw record bodies in headers, or absolute filesystem paths; errors return JSON with `4xx`/`5xx` and a short `error` string (no stack traces).
- AC6: The status HTML page provides an always-visible Import vault control with a hidden file input accepting zip archives.
- AC6b: After the operator chooses a zip file, the page shows the filename and enables Run import.
- AC7: **Run import** prompts for confirmation summarizing target vault root (display name only — not absolute path) and, when the zip is encrypted, a password field; on confirm, uploads via `POST /api/vaults/import` as `multipart/form-data` with fields `archive` (file) and optional `password`.
- AC8: `POST /api/vaults/import` accepts `multipart/form-data` with one `archive` file; rejects missing file (`400`), non-zip content type or magic (`400`), archives over **64 MiB** (`413`), and empty zips (`400`).
- AC9: Import handler extracts `vault-backup.json` from the zip (or the sole `.json` entry if exactly one exists); passes extracted JSON string to `importVault({ vaultRoot, payload, password, overwrite: true })`; returns `200` JSON `{ ok: true, restoredProjectsCount, restoredRecordsCount, restoredProjects }`.
- AC10: Import failures (bad zip, wrong password, invalid archive format, schema validation errors) return `4xx`/`5xx` JSON `{ ok: false, error: "<short message>" }` without partial silent corruption; vault lock from `withVaultLock` prevents concurrent export/import races.
- AC11: After successful import, compiled views and FTS rebuild occur via existing `importVault` behavior; the vault list on the page refreshes (`GET /api/vaults`) without full document reload.
- AC12: When `authToken` is configured, `POST /api/vaults/export` and `POST /api/vaults/import` return `401` without mutation when `Authorization: Bearer <token>` or form/query token is missing or wrong (same token sources as existing status APIs).
- AC13: Binding the status server to a non-loopback host without an auth token still throws at startup (unchanged); when bound non-loopback **with** token, mutating routes require that token.
- AC14: Each completed export and import captures exactly one activity event via the shared bus: `type: "system"`, `kind: "write"`, `ok` reflecting outcome, `projectId` when scoped to a single project (export always; import when archive contains one project), `summary` like `export vault {projectId} ({n} records)` or `import vault ({n} records, {m} projects)` — no secrets or file paths.
- AC15: Export/import UI uses the same dark-theme styling as the existing status monitor; buttons show inline progress/disabled state during network calls and surface API `error` text in a dismissible banner.
- AC16: No new MCP tools are added; the 10-tool surface remains unchanged.
- AC17: No new CLI commands or flags are added; `memo export-vault` and `memo import-vault` remain the scripting/automation path.
- AC18: Zip archives produced by the UI export can be restored by `memo import-vault` after unzip **or** by extracting `vault-backup.json` and passing it as the CLI archive path when the CLI accepts JSON payloads (document one-line unzip note in README).
- AC19: Zip archives produced by `memo export-vault --output file.json` can be imported through the UI when the operator zips the JSON as `vault-backup.json` manually (documented); UI import accepts standard UI-produced zips as the primary path.
- AC20: Automated tests cover: export zip member shape; import round-trip restores records; `POST /api/vaults/export` unknown project `400`; import oversize `413`; import bad zip `400`; encrypted export/import with password; activity bus capture on success and failure; mutating routes return `401` when token configured and missing.
- AC21: `README.md` adds a **Status monitor backup** subsection: select vault → Export; Import zip; optional password; daily backup tip; hybrid/remote note (backup is server-side vault); CLI parity pointer.
- AC22: `AGENTS.md` HTTP/SSE section mentions status monitor export/import as UI-only backup affordance (no new tools).

## Original Issue Context

Free-text request (2026-08-26): create export/import for vaults in the status monitor UI — select a vault, click export so the backend extracts all structured memory in a restorable format; add import UI to select a backup zip and restore; enables easy daily knowledge backup and later restore. Feature available in UI only (not new MCP/CLI surface).

### Prior Work Sweep

Keyword + `git log` on `src/status.ts`, `src/backup.ts`, `src/cli.ts`, and related specs. No open PR for slug `status-vault-backup-ui`. Related hits:

| Hit | Relation | Action |
|-----|----------|--------|
| [`vault-backup.spec.md`](vault-backup.spec.md) / `src/backup.ts` | JSON export/import engine + optional AES-256-GCM; CLI parity | Reuse engine; add zip wrapper + HTTP glue only |
| [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) / `src/status.ts` | Read-only status page, vault filter, activity stream | Extend UI + narrow write exception for backup routes only |
| [`deployment-modes.spec.md`](deployment-modes.spec.md) | Hybrid/remote daemon hosts vault | Document server-side backup scope in README |
| [`multi-machine-sync.spec.md`](multi-machine-sync.spec.md) | Delta sync between machines | Out of scope — zip export/import is operator-triggered snapshot |
| CLI `memo export-vault` / `memo import-vault` | Scripting path | Keep unchanged; UI calls same module |

Related hits recorded; no exact same-issue open PR. Continue.

### Design Intent

[`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) AC7 intentionally made the status surface read-only so ops watching would not mutate vaults from the browser. This slice **supersedes AC7 only for** `POST /api/vaults/export` and `POST /api/vaults/import` — a deliberate, scoped exception for operator backup/restore. All other status routes remain read-only. Reuses [`vault-backup.spec.md`](vault-backup.spec.md) archive formats rather than inventing a parallel backup schema.

## Notes

- Primary operator story: end-of-day select project → Export → save zip to sync folder; after machine loss or vault corruption → Import zip → verify vault list and MCP search.
- Suggested filename pattern: `spec-memo-vault-{projectId}-{YYYYMMDD-HHmmss}.zip`.
- Implementation may add a minimal zip dependency (e.g. `archiver` + extract library) if no satisfactory Node stdlib path exists; keep dependency count low.
- Import uses `overwrite: true` by default (see context companion for merge UX).
- Export is **per selected project** only in v1 — not whole `$SPEC_MEMO_ROOT` multi-project zip from UI.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New MCP tools or CLI commands | User request: UI-only surface; reuse existing backup engine |
| Scheduled/automatic daily backups | Manual operator click is sufficient for v1 |
| Cloud upload (S3, Drive, etc.) | Operator saves downloaded zip locally |
| Export/import of activity ring buffer | Ephemeral ops data; not structured memory |
| Canvas graph viewer backup UI | Status monitor owns ops backup affordance |
| Whole-vault multi-project UI export | v1 scopes to one selected project; CLI can export all projects |
| Replacing `memo sync` / hybrid delta sync | Different use case — snapshot portability |
| Mobile-optimized backup wizard | Desktop ops monitor posture |
| In-browser encryption key storage | Password used per operation only; never persisted |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Archive format inside zip | Single `vault-backup.json` using existing `spec-memo-vault-v1` / encrypted v1 | Restores via proven `importVault`; CLI-compatible | y |
| Export scope | Selected vault project only | Matches user flow ("select vault then export") | y |
| Optional UI encryption | Password prompt on export; password field on import when needed | Reuses vault-backup crypto; see context companion | y |
| Import merge policy | `overwrite: true` with explicit confirmation dialog | Predictable restore; operator confirms before write | y |
| Upload size cap | 64 MiB max multipart body | Protects local daemon from accidental huge uploads | y |
| Auth on mutating routes | Required when status `authToken` configured | Stricter than read-only GET; non-loopback safety | y |
| Zip dependency | Small npm zip read/write library acceptable | Node has no stdlib zip archive helper | y |
| Implicit dimensions (rate limits, observability) | Activity bus event per operation + HTTP error codes | No external metrics stack; local ops UI | y |
