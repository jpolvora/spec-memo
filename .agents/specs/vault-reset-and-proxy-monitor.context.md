# Context — Vault reset and proxy status monitor with 3-mode topology UI

## Feature Boundary

This feature addresses two core operational challenges in spec-memo:
1. **Safety-first memory reset:** Enabling developers and agents to reset the working database and memory files back to a pristine state, guaranteed by an automated pre-wipe ZIP backup named `{yyyy-mm-dd-H:m:s-backup}.zip` (normalized to `YYYY-MM-DD-HH-mm-ss-backup.zip`).
2. **Observability across distributed deployment modes:** Allowing proxy nodes (hybrid or remote MCP clients) to launch the `:3001` status monitor UI and prominently displaying topological role information (Local Vault vs Intermediary Proxy vs Final Remote Master Vault).

## Implementation Decisions

### 1. Timestamp Formatting and File System Safety
- The requirement requests `{yyyy-mm-dd-H:m:s-backup}.zip`. On Windows and certain network file systems, colon characters (`:`) are strictly illegal in file names.
- Decision: Use ISO-adjacent zero-padded hyphen format: `YYYY-MM-DD-HH-mm-ss-backup.zip` (e.g., `2026-08-31-10-15-30-backup.zip`). This satisfies the exact semantic requirement while maintaining cross-platform safety and chronological lexical sortability.
- Backups are stored in `$SPEC_MEMO_ROOT/backups/` so they are never accidentally wiped during subsequent reset operations.

### 2. Atomic Fail-Safe Reset Transaction Boundary
- Reset must never result in an empty or corrupted vault if backup creation fails.
- Flow:
  1. Acquire `withVaultLock`.
  2. Perform full `exportVault()` across target scope (single project or all projects).
  3. Package exported payload into ZIP using `packVaultZip()` from `src/status-backup.ts`.
  4. Write ZIP to `$SPEC_MEMO_ROOT/backups/{timestamp}-backup.zip` and verify file integrity on disk.
  5. Delete records in `projects/*/records/`, drop/recreate `memo.sqlite`, and clear hybrid sync cursors.
  6. Reinitialize clean directory structure via `ensureVaultStructure()` and rebuild clean SQLite FTS5 index.
  7. Release lock and log `type: "system"`, `kind: "write"` activity event.

### 3. Proxy Status Server Integration
- Previously, `memo serve` in remote mode ran only `startRemoteMcpProxyServer` over stdio without spinning up an activity bus or HTTP status server.
- Decision: Introduce `--status` flag (enabled by default unless `--no-status` is specified) to `startRemoteMcpProxyServer` that launches `startStatusServer` on port `:3001`.
- The proxy Activity Bus logs local proxy tool dispatch events, execution latencies, and remote connectivity status.

### 4. 3-Mode Architecture Visualization
- The status monitor at `:3001` clearly articulates the 3 supported memory deployment models:
  - **Local Vault (`local`)**: Standalone local file storage + local SQLite index.
  - **Intermediary Proxy / Hybrid (`hybrid` / `proxy`)**: Intermediary server that caches locally, forwards tools, and syncs deltas upstream.
  - **Final Remote Server (`remote` daemon)**: The central authoritative repository and ultimate backup master vault.
- UI renders a dedicated navigation badge and dashboard topology card visually indicating the active node's place in this 3-tier hierarchy.

## Deferred Ideas

- **Automated S3/GCS Offsite Replication:** Uploading pre-wipe backup ZIPs to cloud storage buckets (deferred to cloud sync plugins).
- **Interactive Time-Machine Rollback UI:** Visual diffing between multiple historical backup ZIPs in the status monitor (deferred to a dedicated history inspection slice).
