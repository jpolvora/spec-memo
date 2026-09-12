# Backup & Restore

## Feature Overview

`spec-memo` ships a portable vault archive engine for off-site backups, air-gapped migrations, and disaster recovery, plus a safe reset that always snapshots first.

- **Export:** `exportVault` serializes project metadata (`project.json`), all durable markdown records, and vault `config.json` into a JSON manifest archive. With a password, the payload is encrypted.
- **Import / restore:** `importVault` (aliased `restoreVault`) restores records and metadata from a `.json` or `.zip` archive, rewrites compiled views, and rebuilds the SQLite FTS index.
- **Reset:** `resetVault` writes a mandatory timestamped zip backup, then wipes records/database (all projects or one project) and reinitializes a clean structure.
- **Inventory:** `listBackups` enumerates `$SPEC_MEMO_ROOT/backups/` with manifest metadata.

Surfaces: CLI `memo export-vault`, `memo import-vault`/`memo restore`, `memo backups`, `memo reset`; the [Status Monitor](status-monitor.md) Backups tab and `POST /api/vaults/export|import|backups|restore|reset` endpoints.

## Business Rules & Logic

- Archive formats: plaintext `spec-memo-vault-v1` (manifest + `vaultConfig` + `projects[]` with raw `relativePath`/`content` records) or encrypted `spec-memo-encrypted-vault-v1`.
- Encryption: AES-256-GCM with PBKDF2-SHA256 key derivation, **100,000 iterations**, random 16-byte salt, 12-byte IV, 32-byte key, and a GCM auth tag. A wrong password or tampered ciphertext fails with `Decryption failed: Incorrect password or corrupted backup archive.` and aborts cleanly.
- `exportVault` walks `RECORD_SUBDIRS` = `traps`, `decisions`, `specs`, `plans`, `logs`, `reviews`, `scratch`, `prompts`, `sessions`; `state` records live under `plans/`. Conflict sidecars (`*.conflict.*.md`) are excluded. Each record passes the secret assertion before packing; a `Safety violation` aborts the export. `manifest.scope` is `project` (one project) or `full` (all projects), and `manifest.recordsByKind` counts packed kinds.
- `importVault` accepts `archivePath` (`.zip` magic or extension is unpacked) or `payload`. It preserves or overwrites (`overwrite`, default true) config and record files, validates frontmatter and path containment, and refuses unrecognized formats. Compiled views and FTS are rebuilt afterward.
- Reset safety invariant: a full backup is written **before** any deletion. If backup generation fails (empty payload, disk/write error), reset aborts with no records or databases touched.
- Pre-wipe backup filename is `YYYY-MM-DD-HH-mm-ss-backup.zip` (no colons; Windows-safe and chronologically sortable) under `$SPEC_MEMO_ROOT/backups/`, using an atomic write (`.partial` rename) plus a `.meta.json` sidecar.
- Full reset removes all `projects/`, `memo.sqlite*`, `.sync/` sync state, and a stray root `hybrid-state.json`; it never removes `config.json` or the `backups/` directory. A project reset removes only that project. After deletion `ensureVaultStructure` and `rebuildIndex` run so the vault is immediately writable.
- `memo reset [--all] [--project <id>] [--force] [--password <pwd>]` requires `--force` in non-interactive environments; otherwise it prompts on a TTY. Output prints the backup path and wipe counts.
- `POST /api/vaults/reset` requires `{ confirm: true }` (else `400`) and returns `{ ok, projectId?, backupFilename, backupPath, wipedProjectsCount, wipedRecordsCount, rebuiltFts }`. It emits one `type: "system"`, `kind: "write"` activity event.
- `listBackups` returns items sorted newest first with `filename`, `size`, `createdAt`, `isZip`, `encrypted`, `scope`, `projectIds`, `recordCount`, and `recordsByKind`. Encrypted archives that cannot be inspected appear with `encrypted: true` and null/empty counts. Filters: `q`, `scope`, `projectId`, `encrypted`, `since`, `until`, kind (repeatable), size bounds.
- `resolveBackupPath` is `path.basename` only, rejects `/`, `\`, and `..`, requires `.zip`/`.json`, and confirms containment under `backups/`. Restore accepts `backupFilename` (resolved under `backups/`), `archivePath` (must be inside the vault or `backups/`), or a multipart file; the restore multipart cap is 50 MiB and the import multipart cap is 64 MiB.
- Reset/restore/backup mutations take the vault lock, so they serialize with sync and other writers.

## Technical Architecture

- `src/backup.ts`: types `ExportVaultOptions`/`ExportVaultResult`, `ImportVaultOptions`/`ImportVaultResult`, `ResetVaultOptions`/`ResetVaultResult`, `PersistBackupOptions`/`PersistBackupResult`, `InspectBackupResult`; functions `exportVault`, `importVault`, `restoreVault`, `resetVault`, `listBackups`, `filterBackupList`, `persistVaultBackup`, `deleteBackup`, `inspectBackup`, `resolveBackupPath`, `formatBackupFilename`; internals `encryptPayload`, `decryptPayload`, `writeBackupArchiveAtomic`, `readBackupSidecarMeta`.
- `src/status-backup.ts`: zero-dependency `packVaultZip(jsonPayload, entryName='vault-backup.json')`, `unpackVaultZip(buffer)`, and `parseMultipartFormData` (uses Node `zlib`).
- `src/status.ts` routes: `POST /api/vaults/export` (browser zip download; full backup needs `confirmFullBackup: true`), `POST /api/vaults/import` (multipart `archive` + optional `password`; 64 MiB cap; ZIP magic check), `GET /api/vaults/backups` (filters), `POST /api/vaults/backups` (persist; `confirmFullBackup` guard), `GET /api/vaults/backups/{filename}` (download), `GET`/`POST /api/vaults/backups/{filename}/inspect`, `DELETE /api/vaults/backups/{filename}` (`confirm: true`), `POST /api/vaults/reset`, `POST /api/vaults/restore`.
- 3-mode topology (`0030-vault-reset-and-proxy-monitor.spec.md`): the status monitor reports `topology` (`local-vault`, `intermediary-proxy`, `final-remote`) via the enriched `GET /api/status`, and a proxy/hybrid instance can start its own companion with `--status`/`--status-port` while keeping its UI alive when the upstream daemon is unreachable. See [Status Monitor](status-monitor.md).
- CLI extras: `memo export-vault [--password] [-o <file>]`, `memo import-vault`/`restore [<archive>|--backup <path>|--latest] [--password] [--overwrite]`, `memo backups`, `memo reset`. `export-vault` and `import-vault` are refused in remote mode; `restore`, `backups`, and `reset` are not in `REMOTE_MODE_RESTRICTION` and run unchecked there.
- Provenance: `0021-vault-backup.spec.md` (archive + AES-256-GCM/PBKDF2), `0026-status-vault-backup-ui.spec.md` (UI export/import), `0030-vault-reset-and-proxy-monitor.spec.md` (reset with pre-wipe backup, restore/list, topology), `0032-status-backup-page.spec.md` (complete kinds, dedicated Backups tab, inventory filters, delete/inspect). See [Status Monitor](status-monitor.md) and [Vault Sync](vault-sync.md).
