---
id: null
slug: status-backup-page
title: "Dedicated status-monitor backup page with complete archives and inventory management"
source: local
specDate: 2026-08-31
status: draft
target_phase: Phase 7
---

# Specification — Dedicated status-monitor backup page with complete archives and inventory management

## Description

Operators who run `memo serve --sse` today manage snapshots from a **sidebar panel** on the Activity tab. That panel disables **Export** when the vault filter is **All vaults** (`status-vault-backup-ui` AC1b), lists saved zips with filename and size only, and offers Restore without Delete or a details inspector. Daily backup work therefore fights the activity log layout and cannot take a whole-root snapshot from the UI.

This slice moves backup operations onto a **dedicated Backups tab** in the status monitor (same companion origin, default `:3124`). The tab follows the same master-detail pattern as Prompts & Intent Stories: filter toolbar, data table, row actions, and a slide-out details drawer. Create Backup with **All vaults** selected is a confirmed **full-backup** (every project under `$SPEC_MEMO_ROOT/projects/`). A selected project vault produces a single-project snapshot.

Server-side `exportVault` / `importVault` (and the persist/restore HTTP handlers) must include **all durable vault record kinds**: `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review`, `prompt`, and `session`. Prompt and session files are the store for intent stories, activity/invoicing queries, and derived-rule traps that were saved into `traps/`. Restore of a complete archive therefore reconstitutes those surfaces after FTS rebuild. No new MCP tools. CLI `memo export-vault` / `memo import-vault` / `memo backups` / `memo restore` remain the scripting path.

Architecture touchpoints:

- **Backup engine (`src/backup.ts`)**: `exportVault` already walks `RECORD_SUBDIRS` (includes `prompts/` and `sessions/` after `#27`). Guarantee `state` records under `plans/` are packed; enrich `listBackups` with inspectable manifest fields (`recordCount`, `projectIds`, `recordsByKind`, `encrypted`, `scope`); add `deleteBackup` confined to `backups/`.
- **Zip helpers (`src/status-backup.ts`)**: unchanged pack/unpack contract (`vault-backup.json` member). Inspect may unpack JSON in memory without calling `importVault`.
- **Status companion (`src/status.ts`)**: new Backups tab HTML/JS; persist/list/inspect/download/delete routes; extend `POST /api/vaults/export` to allow omitted `projectId` when `confirmFullBackup: true`; remove the Activity-sidebar Backup & Restore panel.
- **Activity bus (`src/activity.ts`)**: `type: "system"`, `kind: "write"` events for create, restore, and delete (filename, counts, ok/error; never passwords or host paths).
- **Safety (`src/safety.ts`)**: basename-only backup filenames; mutating routes require the configured status token; redact inspect payloads (no absolute `path`, no record bodies).
- **Tests**: `src/backup.test.ts`, `src/status.test.ts` (HTML tab presence, full-backup confirm, complete-kind round-trip, delete, inspect, filter query params).
- **Docs**: `README.md` and `AGENTS.md` status-monitor backup subsection.

Design choices: [`status-backup-page.context.md`](status-backup-page.context.md).

## Acceptance Criteria

### Group 1 — Complete archive payload

- AC1: `exportVault` includes markdown records for kinds `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review`, `prompt`, and `session` from the targeted project(s).
- AC2: A vault that contains at least one `prompt` file and one `session` file round-trips through export then `importVault` so both files are present and FTS search finds them.
- AC3: Derived-rule traps stored as `kind: trap` and session fields used by activity invoicing (`client`, `billable`, `durationMinutes`, `deliverables`) are present in the archive JSON `projects[].records` for those files.
- AC4: `exportVault` without `projectId` packs every directory under `projects/` into one `spec-memo-vault-v1` (or encrypted) payload; `manifest.projects` lists those project ids and `manifest.recordCount` equals the packed record total.
- AC5: Restore via `importVault` / `POST /api/vaults/restore` rebuilds compiled views and SQLite FTS through existing import behavior after writing records.

### Group 2 — Full vs project Create Backup (SSE UI + API)

- AC6: The Backups tab Create Backup control is enabled when the vault filter is **All vaults**.
- AC7: Clicking Create Backup with **All vaults** selected opens a confirmation that states all project vaults will be included, shows the current project count from `GET /api/vaults`, and does not start the backup until the operator confirms.
- AC8: Cancel on the full-backup confirmation leaves `$SPEC_MEMO_ROOT/backups/` unchanged.
- AC9: Confirming a full backup calls the persist API with `projectId` omitted and `confirmFullBackup: true`, then refreshes the inventory so the new zip appears.
- AC10: When a specific project is selected, Create Backup skips the full-backup dialog and persists a snapshot for that `projectId` only.
- AC11: `POST` persist/export with omitted `projectId` and missing `confirmFullBackup: true` returns `400` JSON `{ error: "confirmFullBackup required for full backup" }` and writes no file.
- AC12: `POST` persist/export with unknown `projectId` returns `400` `{ error: "Unknown projectId" }`.
- AC13: A successful persist writes `{YYYY-MM-DD-HH-mm-ss-backup.zip}` under `$SPEC_MEMO_ROOT/backups/` containing `vault-backup.json`, and returns `200` JSON `{ ok: true, filename, size, recordCount, projectIds, encrypted }` with no absolute filesystem path.

### Group 3 — Dedicated Backups page (tab)

- AC14: Status HTML `nav.nav-tabs` includes a **Backups** tab button (`data-tab="tab-backups"`) in addition to Activity, Prompts, Invoicing, and Derived Rules.
- AC15: Selecting the Backups tab shows the exclusive backup workspace (toolbar, table, details drawer) and hides the other tab panels.
- AC16: Query `?tab=backups` on load activates the Backups tab when that tab exists; unknown `tab` values leave Activity active.
- AC17: The Activity tab sidebar no longer contains the Vault Backup & Restore panel, Saved Backups list, or Export selected vault button.
- AC18: Backups tab styling matches the existing dark status-monitor theme (same CSS variables as Prompts explorer).

### Group 4 — Inventory list, filters, and details drawer

- AC19: `GET /api/vaults/backups` returns `{ ok: true, backups: BackupInventoryItem[] }` sorted newest first, where each item includes `filename`, `size`, `createdAt`, `isZip`, `encrypted`, `scope` (`full` or `project`), `projectIds`, `recordCount`, and `recordsByKind` (kind to count).
- AC20: `GET /api/vaults/backups` JSON never includes raw host absolute paths (existing sanitization contract).
- AC21: Encrypted archives that cannot be inspected without a password still appear in the list with `encrypted: true`, `recordCount` null or omitted, and `recordsByKind` empty or omitted.
- AC22: The Backups table shows filename, createdAt, human-readable size, entry count (`recordCount` or em dash when unknown), scope, and encrypted indicator.
- AC23: The toolbar filters the visible rows by filename substring, scope, project id, encrypted, created-at range, size bounds, and multi-select kinds present (AND across selected kinds).
- AC24: `GET /api/vaults/backups` accepts optional query filters `q`, `scope`, `projectId`, `encrypted`, `since`, `until`, `kind` (repeatable) and returns only matching items; invalid `encrypted` that is not `true`/`false`/empty returns `400`.
- AC25: Clicking a table row (not an action button) opens the details drawer with filename, metadata card fields from AC19, records-by-kind breakdown, and redacted manifest JSON (no record bodies, no host paths).
- AC26: `GET /api/vaults/backups/{filename}/inspect` returns that drawer payload; `{filename}` is `path.basename` only and must resolve inside `backups/` or the handler returns `400`.
- AC27: Inspect of an encrypted archive without password returns `200` `{ ok: true, encrypted: true, inspectable: false }` without decrypting; with the correct `password` query or JSON body it returns full metadata; wrong password returns `401` `{ ok: false, error: "..." }` without vault mutation.
- AC28: Empty inventory shows a helper empty state; Refresh reloads `GET /api/vaults/backups`.
- AC29: Closing the drawer (X, overlay click, or Escape) returns focus to the table without resetting filters.

### Group 5 — Row and drawer actions (restore, delete, download)

- AC30: Each row shows Restore, Delete, and Download controls; the details drawer repeats the same three actions.
- AC31: Restore opens the existing restore confirmation (overwrite warning plus optional password) and on confirm calls `POST /api/vaults/restore` with `backupFilename`; success shows a banner with restored record and project counts and refreshes vault lists.
- AC32: Dismissing restore confirmation performs no restore.
- AC33: Delete opens a confirmation that requires the operator to type the exact filename; mismatched input keeps the confirm control disabled.
- AC34: Confirmed delete calls `DELETE /api/vaults/backups/{filename}` with JSON `{ confirm: true }`; success removes the row and closes the drawer if that file was open.
- AC35: `DELETE /api/vaults/backups/{filename}` without `confirm: true` returns `400` and leaves the file on disk.
- AC36: `DELETE` for a missing file returns `404`; a filename that escapes `backups/` returns `400`.
- AC37: Download streams the archive with `Content-Type: application/zip` (or `application/json` for `.json` backups) and `Content-Disposition: attachment; filename="{filename}"` via `GET /api/vaults/backups/{filename}`.
- AC38: Buttons disable and show progress text during in-flight create, restore, or delete; API `error` strings appear in the dismissible banner.

### Group 6 — Auth, lock, activity, CLI, docs

- AC39: When `authToken` is configured, persist, export, restore, delete, inspect-with-password, and download of backups return `401` without mutation or file bytes if the bearer/query/cookie token is missing or wrong.
- AC40: Create, restore, and delete take the vault lock (`withVaultLock`) so they do not overlap with concurrent export/import/reset.
- AC41: Each completed create, restore, and delete emits one activity event `type: "system"`, `kind: "write"`, with `ok`, `summary` including the filename (create/delete) or restore counts, and no secrets or absolute paths.
- AC42: No new MCP tools are added; the 11-tool surface stays unchanged.
- AC43: `listBackups` used by `memo backups` exposes the same inventory fields as AC19 (CLI may still print a subset).
- AC44: Automated tests cover: prompt+session round-trip; full-backup 400 without confirm; persist writes zip; list includes `recordCount`; inspect path traversal 400; delete requires confirm; HTML contains `tab-backups` and does not contain `id="btn-export"` on the Activity sidebar; `?tab=backups` selection helper; mutating backup routes 401 when token missing.
- AC45: `README.md` documents the Backups tab, full-backup confirmation, complete kind coverage, and row restore/delete/download.
- AC46: `AGENTS.md` status-monitor section names the Backups tab and the new backup HTTP routes.

## Original Issue Context

Free-text `/ws-write-spec` (2026-08-31): add a dedicated exclusive page for backups; include all memory kinds plus prompts/intent stories/activity invoicing/derived rules in backup/restore; if no project vault filter is selected, confirm a full-backup of all vaults, else backup only the selected project; list backups with details, size, entry counts, and filters on kinds/metadata; row-level restore/delete with confirmations; listing and details panel like common backup-management UIs.

### Prior Work Sweep

Keyword + `git log` on `src/backup.ts`, `src/status.ts`, `src/status-backup.ts`, `src/types.ts`. `gh pr list --search backup`: related merged PRs `#2` (vault-backup engine), `#27` (reset + list/restore UI; follow-up `0d82812` added `prompts/` and `sessions/` to `RECORD_SUBDIRS`). No open PR for slug `status-backup-page`.

| Hit | Relation | Action |
|-----|----------|--------|
| [`status-vault-backup-ui.spec.md`](status-vault-backup-ui.spec.md) | Sidebar export/import; AC1b disables All-vaults export | Supersede AC1b; move UI to dedicated tab |
| [`status-vault-backup-ui.context.md`](status-vault-backup-ui.context.md) | Deferred: export all projects from All vaults | This slice delivers that deferred idea with confirmation |
| [`vault-backup.spec.md`](vault-backup.spec.md) / `src/backup.ts` | JSON/AES archive engine | Reuse; complete kind coverage + inventory metadata |
| [`vault-reset-and-proxy-monitor.spec.md`](vault-reset-and-proxy-monitor.spec.md) | `listBackups`, `POST /api/vaults/restore`, pre-wipe zips | Extend list shape; add delete/inspect/download; keep restore |
| [`prompt-history-and-query.spec.md`](prompt-history-and-query.spec.md) | Prompts tab master-detail drawer | Copy layout pattern for Backups tab |
| Commit `0d82812` | `RECORD_SUBDIRS` includes prompts/sessions | Preserve; add tests that round-trip those kinds |

Related hits recorded; no exact same-issue open PR. Continue.

### Design Intent

[`status-vault-backup-ui.spec.md`](status-vault-backup-ui.spec.md) AC1b and Notes ("Export is per selected project only in v1") **intentionally** disabled All-vaults export to keep v1 scoped. [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) AC7 made status read-only except later backup exceptions. This slice **supersedes AC1b**: All vaults is a confirmed full-backup, not a disabled control. Mutating backup routes remain the scoped write exception. Zip format and `importVault` overwrite confirmation stay as designed in the prior backup specs.

Greenfield skip does not apply: this modifies shipped status HTML and backup HTTP contracts.

## Notes

- Persist filenames stay `YYYY-MM-DD-HH-mm-ss-backup.zip` so they sort with reset pre-wipe snapshots in the same folder.
- `state` records use subdirectory `plans/` (`getSubdirForKind`); packing `plans/*.md` covers them without a separate `state/` walk if files already live there.
- Activity invoicing and derived-rules **tabs** read live vault data. Completeness means those records are in the zip, not that the zip embeds a rendered timesheet HTML.
- Filter `kind` matches archives whose `recordsByKind` has a positive count for each selected kind.
- Implementation may cache inspect metadata in memory per filename+mtime to avoid unpacking every zip on each list call.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New MCP tools or a 12th tool | Backup stays HTTP/CLI; 11-tool MCP surface unchanged |
| Scheduled or cron snapshots | Operator-triggered create is the requested flow |
| Cloud upload (S3, Drive) | Local `backups/` plus browser download |
| Packing activity ring buffer, `error.logs`, or telemetry files | Ephemeral ops data; not durable memory records |
| Packing `memo.sqlite*` | Disposable index; restore rebuilds FTS |
| Partial-kind create (export only traps) | Snapshots are complete for the chosen vault scope |
| Moving vault reset / Danger Zone onto the Backups tab | Reset stays on Activity; its pre-wipe zip still appears in the inventory |
| New HTTP port dedicated to backups | Same status companion origin |
| Mobile-only backup wizard | Desktop ops monitor posture |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| UI chrome | Fifth status-monitor tab, Prompts-like table + drawer | Matches existing explorer; user asked for page/tab | y |
| Create Backup I/O | Persist into `backups/` then list refresh; download is a row action | Common backup consoles keep server-side inventory | y |
| Full-backup API guard | `confirmFullBackup: true` when `projectId` omitted | Prevents accidental whole-root snapshots from scripts/UI | y |
| Delete confirm | Type exact filename in UI; `{ confirm: true }` on API | Destructive; matches common backup-delete UX | y |
| Encrypted list rows | Show file with `encrypted: true` without kind counts until inspect+password | Avoid storing passwords; still list the file | y |
| Invoicing / derived rules in zip | Covered by `session` + `prompt` + saved `trap` files | Those tabs have no separate blob store | y |
| Implicit dimensions (rate limits, external deps) | N/A because local loopback companion, existing 64 MiB import cap, no third-party backup vendor | Status already caps multipart import; no new SaaS | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | One status tab + backup engine/list/delete/inspect; no MCP expansion; reset UI stays put | Spec Out of Scope table vs implementation file list |
| Atomic criteria | AC1–AC46 each have a pass/fail check | Authoring `validate_spec.cjs --mode=authoring` |
| Failure modes | Missing full-backup confirm, path escape, delete without confirm, bad inspect password, 401 | Named tests in AC44 and Negative scenarios below |
| Observation telemetry | Activity bus events + HTTP status codes for create/restore/delete | `src/status.test.ts` activity capture; banner copy |
| Open blockers | N/A because prior backup engine, zip helpers, restore POST, and Prompts drawer already ship | `git log` on `src/backup.ts` / `src/status.ts` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `GET /api/vaults/backups` `200` with `backups[].recordCount` after a persist.
- Activity bus `summary` matching `backup created {filename} ({n} records, {m} projects)` / `backup deleted {filename}` / existing restore summary.
- `memo backups --json` (or CLI table) shows enriched fields after `listBackups` change.
- Status HTML contains `data-tab="tab-backups"` and `id="tab-backups"`.
- `npm test` (full suite) and targeted `node --test dist/backup.test.js dist/status.test.js`.

### Negative & Failing Test Scenarios

- Persist/export full backup without `confirmFullBackup: true` returns 400 and creates no zip.
- Delete without `{ confirm: true }` returns 400 and the file remains.
- `GET`/`DELETE`/`inspect` with `filename=../config.json` returns 400.
- Inspect encrypted archive with wrong password returns 401 and does not call `importVault`.
- Export unknown `projectId` still returns 400.
- Create Backup UI confirm cancel does not call persist.
- Auth token configured: persist/delete/download without token return 401.
