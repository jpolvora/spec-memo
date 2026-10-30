---
id: null
slug: sync-conflict-reconciliation
title: "Vault Sync Conflict Reconciliation, Atomic Changesets, and Automated Background Resilience"
source: local
specDate: 2026-09-04
---

# Specification — Vault Sync Conflict Reconciliation, Atomic Changesets, and Automated Background Resilience

## Description

Refine the spec-memo synchronization subsystem across local workstations and remote daemons to eliminate spurious conflicts, introduce deterministic conflict resolution with configurable source-of-truth preferences, guarantee all-or-nothing atomic changeset application, clean up legacy conflict sidecar files, and establish automated background synchronization resilience.

### Problem Analysis & Real-World Evidence

A diagnostic probe against the central daemon at `http://192.168.0.3:3123` and local vault inspection in `~/.spec-memo/` revealed the following defects:

1. **Spurious Conflicts via Retrieval Metadata Mutations:**
   - In `src/hits.ts`, `recordMemoryHits` updates `hits: hits + 1` and `lastHit: now` in frontmatter without bumping `updated` or `created`.
   - In `src/sync.ts`, `applyChangeset` performs raw string comparison `existingContent === serializeRecord(item)`. When frontmatter fields or line endings (`\r\n` vs `\n`) differ, string equality fails.
   - Because `updated` was unchanged, `remoteTime === localTime`, causing `applyChangeset` to increment `conflicts++` and write `${slug}.conflict.${Date.now()}.md`.
   - Over 276 `.conflict.*.md` files accumulated locally in `~/.spec-memo/` and 477 false conflicts occurred during push to `192.168.0.3`.
2. **Dual Sync False `(ok)` Status:**
   - In `src/dual-sync.ts`, `enabledResults.some(Boolean)` marks dual sync as `(ok)` when vault-git succeeds, even if hybrid HTTP sync has 477 conflicts and 0 applied records.
3. **Missing Source of Truth & Conflict Reconciliation Strategy:**
   - No mechanism exists to designate local or remote as the source of truth (`--prefer local|remote`, `strategy: 'local-wins'`).
4. **Lack of Changeset Atomicity:**
   - `applyChangeset` writes files directly in place. If an error or abort occurs midway, the vault is left in a partially applied state with mismatched timestamps.

### Design Intent

The original design assumed timestamp comparison plus raw string comparison was sufficient for delta synchronization. However, volatile retrieval metadata (`hits`, `lastHit`) and multi-platform line endings violate raw string equality while preserving identical markdown bodies. This specification establishes semantic body comparison, metadata auto-merging, configurable source of truth (`local-wins` vs `remote-wins`), journaled atomic rollback, and automated background resilience while maintaining compatibility with deployed `v0.17.0` daemons.

---

## Acceptance Criteria

### Semantic Equality & Metadata Auto-Merging

- AC1: applyChangeset replaces raw string comparison with semantic body normalization ignoring line endings and trailing whitespace.
- AC2: Incoming records with identical bodies automatically merge metadata without incrementing conflicts or creating sidecar files.
- AC3: Metadata merge calculates maximum hits, maximum occurrences, latest lastHit, latest lastSeen, and unions unique tags and linkedPaths.
- AC4: Conflicting body records write a single deterministic slug.conflict.md sidecar replacing prior unreviewed sidecars for that record.

### Configurable Source of Truth & Conflict Resolution Strategies

- AC5: VaultConfig accepts optional sync.conflictStrategy configured as smart-merge, local-wins, remote-wins, or sidecar.
- AC6: memo sync and memo reconcile accept CLI flags --prefer local or --prefer remote to select the effective source of truth.
- AC7: On local-wins execution, local records overwrite remote records during push by sending force true to the remote daemon.
- AC8: On remote-wins execution, remote records overwrite local records on pull regardless of local modification timestamp.
- AC9: Interactive reconciliation mode displays concise record diffs and prompts the operator to choose local, remote, or merge.

### Transactional Atomicity (All-or-Nothing Changesets)

- AC10: applyChangeset validates all incoming records against schemas, paths, and secret rules before mutating any files on disk.
- AC11: applyChangeset writes a pre-apply rollback journal to staging containing original copies of all records targeted for mutation.
- AC12: Any filesystem, indexing, or parsing failure during applyChangeset triggers complete rollback restoring all original files.
- AC13: Successful changeset transactions remove the rollback journal and update SQLite FTS index and sync cursors atomically.

### Dedicated Reconciliation Command & Sidecar Cleanup

- AC14: The memo reconcile command scans targeted projects for conflict state and executes bidirectional delta reconciliation.
- AC15: Running memo reconcile with --clean-sidecars deletes all conflict sidecars whose markdown body matches the base record.
- AC16: Running memo reconcile with --prefer local and --clean-sidecars removes all conflict sidecars and retains primary local files.
- AC17: Successful reconciliation with zero remaining conflicts clears dirty flags and resets lastError in hybrid-state.json.

### Dual Sync Status Accuracy & Observability

- AC18: DualSyncReport ok evaluates to true only when every enabled sync channel succeeds without errors or conflicts.
- AC19: Dual sync CLI output and JSON report display partial failure when hybrid encounters conflicts even if vault-git succeeds.
- AC20: Reconcile operations log structured conflict records to error.logs under subsystem sync-reconcile with exact record diff types.
- AC21: Operational telemetry records sync_reconcile events including conflict count, auto-merged count, and applied resolution strategy.
- AC22: CLI memo status and status monitor display active conflict count, dirty projects, and configured conflict strategy.

### Background Synchronization & Automated Resolution

- AC23: Daemon serve mode starts a non-blocking background sync worker when autoSyncIntervalMinutes is configured greater than zero.
- AC24: Background worker applies non-interactive smart-merge synchronization under vault lock without blocking active MCP requests.
- AC25: Background worker handles graceful process shutdown signals and terminates active cycles without leaving orphaned journal files.

---

## Notes

- **Existing Vault Residue:** Currently, the local vault contains 276 legacy `.conflict.*.md` files; AC15 and AC16 provide automated safe cleanup.
- **Daemon Protocol Compatibility:** Pushing with `prefer: 'local'` transmits `force: true` to `/api/sync/push`, ensuring compatibility with remote master daemons running `v0.17.0`.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-master CRDT real-time text collaboration | Markdown files on disk remain authoritative; deterministic source-of-truth and smart-merge solve agent vault needs. |
| In-memory database rollbacks for disk files | Transactional staging directory with copy-on-write journal provides crash-safety on the file system. |
| Automatic remote daemon software upgrades | Daemon updates are handled via host package management and autoboot services. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default conflict strategy when unspecified | `smart-merge` | Preserves local edits while incorporating remote updates and merging metadata safely. | y |
| Operator preference for identical-body sidecars | Automatic cleanup | Nearly all accumulated sidecars stem from hit count increments or CRLF differences. | y |
| Default background sync interval | 15 minutes | Provides continuous synchronization without excessive CPU or network overhead. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Issue & Bug Evidence | Documented 477 push conflicts and 276 local sidecar files on 192.168.0.3 | Live CLI probe and filesystem analysis scripts |
| Codebase Architecture | Verified touchpoints in `sync.ts`, `hybrid-sync.ts`, `dual-sync.ts`, `hits.ts`, `cli.ts` | Source code inspection and unit test baseline |
| Daemon Compatibility | Verified `/api/sync/push` accepts `force: true` on `v0.17.0` | HTTP probe on `http://192.168.0.3:3123` |
| Zero Open Blockers | Bounded scope and testable criteria defined | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node dist/cli.js sync`: reports `pushed applied > 0, conflicts = 0` when pushing to remote.
- `node dist/cli.js reconcile --prefer local --clean-sidecars`: cleans up all 276 local conflict files and resets hybrid dirty flag to false.
- Telemetry log files in `~/.spec-memo/telemetry/` record `operation: 'sync_reconcile'` with `success: true`.

### Negative & Failing Test Scenarios

- Invalid frontmatter or path traversal in an incoming changeset triggers pre-validation abort with zero files modified on disk.
- Write error injected during changeset application initiates immediate journal restore, leaving zero partially written records.
- True body divergence with sidecar strategy writes a single `.conflict.md` file rather than multiple timestamped files.
- Dual sync with hybrid conflicts reports exit code 1 and partial failure status even when vault-git succeeds.
