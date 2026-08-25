---
slug: multi-machine-sync
title: "Multi-Machine Vault Synchronization and Delta Engine"
status: completed
target_phase: Phase 5
created: 2026-08-25
---

# Feature: Multi-Machine Vault Synchronization and Delta Engine

## 1. Context & Goal

Allow developers working across multiple machines or workstations to synchronize their spec-memo vault state directly without requiring central cloud lock-in or manual tarball juggling.

## 2. Acceptance Criteria

- **AC1 — Changeset Generation:**
  - `exportChangeset(vaultRoot, options)` creates a serializable JSON changeset containing record deltas since a given ISO timestamp watermark or last sync cursor.
  - Includes created, updated, and archived/forgotten records across all project namespaces.

- **AC2 — Delta Application & Conflict Resolution:**
  - `applyChangeset(vaultRoot, changeset, options)` imports delta records into the target vault.
  - Conflict resolution policy:
    - **Records (`spec`, `decision`, `plan`, `review`):** Latest `updated` timestamp wins; if timestamps match with different bodies, preserve local copy as backup and write remote copy.
    - **Traps:** Deduplicate against existing traps; supersede when matching rules/paths overlap.
    - **Logs/Events:** Append-only merge ensuring no events are dropped or overwritten.
    - **Deleted/Archived:** Mark local records as archived matching the remote status.

- **AC3 — Direct Two-Way Sync:**
  - `syncVaults(sourceVaultRoot, targetVaultRoot, options)` executes bidirectional delta exchange between two vault locations (e.g. local directory, network share, or secondary disk).
  - Automatically rebuilds the SQLite FTS index (`memo.sqlite`) after synchronization.

- **AC4 — CLI Command:**
  - `memo sync-vault <targetPath> [--two-way] [--dry-run] [--json]` performs vault synchronization from the CLI with summary reporting.
