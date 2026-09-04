# status-backup-page — design companion

## Feature Boundary

The status monitor companion (`memo serve --sse`, default `:3124`) gains a **dedicated Backups tab** that owns create, list, inspect, restore, download, and delete for archives under `$SPEC_MEMO_ROOT/backups/`. The Activity sidebar no longer hosts the cramped Backup & Restore panel. Archive **contents** expand to every vault record kind, including `prompt` and `session` (the store behind intent stories, activity invoicing, and saved derived-rule traps). No new MCP tools. No new daemon port.

## Implementation Decisions

### Dedicated tab, not a new origin

- Add a fifth nav tab **Backups** beside Activity, Prompts, Invoicing, and Derived Rules.
- The tab occupies the full main content area (filter toolbar + table + details drawer), matching the Prompts explorer layout.
- Deep-link with `?tab=backups` (unknown tab ids fall back to Activity). Hash `#tab-backups` is an acceptable alias.
- Do **not** start a separate HTTP listener or HTML document for backups.

### Create Backup persists first; download is a row action

- **Create Backup** on the Backups tab writes a timestamped zip into `$SPEC_MEMO_ROOT/backups/` and refreshes the inventory. It does not rely on a browser download as the only copy.
- **Download** is a per-row (and details-drawer) action that streams the saved file.
- Existing `POST /api/vaults/export` remains for scripted/browser zip download. The Backups tab create flow uses a persist endpoint so the list is the source of truth.

### Full-backup confirmation

- Vault filter **All vaults** (empty `projectId`) enables Create Backup. Confirm dialog states that **all** project vaults will be included, shows the current project count, and requires an explicit confirm click.
- API requires `confirmFullBackup: true` when `projectId` is omitted. Missing flag returns `400`.
- A selected project creates a single-vault snapshot without the full-backup dialog.

### Archive completeness

- `exportVault` / `importVault` include every `RECORD_SUBDIRS` tree plus `state` records that live under `plans/` (existing `getSubdirForKind('state')`).
- Prompt and session markdown cover intent stories, activity/invoicing inputs, and derived-rule traps already saved as `trap` records. Do not invent a parallel invoicing blob inside the zip.
- Compiled views (`INDEX.md`, `TRAPS.md`, …) and `memo.sqlite*` stay derived: restore rebuilds them. Activity ring buffer, `error.logs`, and telemetry files stay out of the archive.

### Details drawer (common backup-console pattern)

Reuse the existing Prompts slide-out drawer CSS and overlay:

| Region | Content |
|--------|---------|
| Header | Filename + scope badge (`full` or project display name) |
| Metadata card | createdAt, size, entry count, encrypted, format, project ids, records-by-kind |
| Actions | Restore, Download, Delete (same confirmations as the row) |
| Body | Manifest JSON (redacted: no absolute host paths, no record bodies) |

Encrypted archives show `encrypted: true` and withhold kind breakdown until the operator supplies the password in the drawer (inspect with password). Wrong password surfaces the existing decrypt error; the vault is not mutated.

### Inventory filters

Filters apply to the **backup list**, not to what is packed into a new snapshot. New snapshots are always complete for the chosen scope (full vault or one project).

Filter dimensions: filename substring, scope (`all` / `full` / `project`), project id, encrypted, created-at range, size bounds, and multi-select **kinds present** (any selected kind must appear in `recordsByKind`).

### Delete vs restore

- Restore: existing overwrite confirmation + optional password; calls `POST /api/vaults/restore`.
- Delete: removes only the file under `backups/`; never deletes live vault records. Confirm modal requires typing the filename. API requires `{ confirm: true }` and a basename confined to `backups/`.

## Deferred Ideas

- Scheduled / cron snapshots.
- Cloud object-storage upload.
- Partial-kind export (pack only traps, only prompts, …).
- Keep a duplicate Backup panel on the Activity sidebar.
- Separate `:3126` backups-only HTTP server.
