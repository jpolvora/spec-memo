# Context Companion — Vault dedup merge, vault rename, and consumer .spec-memo.json local config

This document records architectural decisions, trade-offs, and boundary definitions for slice `0050-vault-dedup-merge-and-local-config`.

## Feature Boundary

### In Scope
1. **Consumer `.spec-memo.json`**:
   - Discoverable at the consumer project root (via git root or directory walk upwards from `cwd`).
   - Declares `projectId` (string) as the authoritative project identifier for reading/writing vault memory.
   - Declares optional local config override keys (e.g. `bootstrap`, `vaultGit`, `telemetry`, `ports`) that merge over the global vault `config.json`.
   - `resolveProjectIdentity` / `resolveVaultId` prioritizes `.spec-memo.json` over git remote normalization and path hashing.
   - `ProjectIdentity` records `identitySource: 'file' | 'git' | 'path'` and `configFilePath`.
2. **`memo init` CLI command**:
   - Scaffolds `.spec-memo.json` in the consumer project root.
   - Infers a sensible default `projectId` (from normalized git remote slug or directory name).
   - Validates filesystem-safe project ID; supports `--project-id <id>` and `--force`.
3. **`memo status` Source & Override Reporting**:
   - Reports the active `projectId` along with its source: `.spec-memo.json (<path>)`, `Git Remote (<remote>)`, or `Local Path Fallback`.
   - Summarizes active local config overrides if present.
4. **Vault Renaming**:
   - `renameVaultProject(oldId, newId, vaultRoot)`: renames the on-disk directory `projects/{oldId}` to `projects/{newId}`, updates `project.json`, migrates incoming and outgoing aliases in `config.json` `projectAliases`, rebuilds FTS5 index and compiled markdown views under vault lock.
   - REST endpoint `POST /api/vaults/rename`.
   - CLI command `memo vault rename --from <oldId> --to <newId>`.
   - Status Monitor UI: "Rename" button in Vaults tab action row opening a validated modal.
5. **Smart Deduplicated Vault Merging**:
   - Revision of `mergeVaultProjects` and `copyRecordsToTarget`:
     - Traps: detects duplicates via exact ID/slug match or semantic match (`findMatchingTrap` with identical `pathPatterns` and text overlap >= 0.7, or matching title). Merges occurrences, hits, and timestamps into the canonical target trap rather than blind copy.
     - Decisions: deduplicates matching slugs/titles and merges hits.
     - Specs / Plans: updates or deduplicates based on slug and revision timestamp.
     - Returns structured merge metrics: `{ copied, deduplicated, skipped }`.
     - Supports optional `deleteSources: boolean` to safely remove source directories after merge while keeping alias redirects.
   - Revised Status Monitor Vaults tab merge modal:
     - Clear source-to-target selection.
     - Checkbox for smart deduplication (default enabled).
     - Checkbox for deleting source vaults post-merge.
     - Status banner reporting copied, deduplicated, and skipped record counts.

### Out of Scope
- Automatic AI-based fuzzy vector clustering across unlinked kinds.
- Replacing the global `~/.spec-memo/config.json` file as the system defaults repository.
- Adding a 12th MCP tool (identity and config resolution happen transparently in existing tools; management operations remain CLI and status HTTP).

## Implementation Decisions

1. **Config Precedence**:
   - When `.spec-memo.json` is present in the consumer root, its config keys take precedence over `~/.spec-memo/config.json` for that repository session.
   - Vault aliases in `~/.spec-memo/config.json` still apply as the final canonicalization step: if `.spec-memo.json` specifies `projectId: marchanterp-old` and `marchanterp-old` has an alias to `marchanterp`, `resolveProjectIdentity` follows the alias to `marchanterp`.

2. **Deduplication Strategy**:
   - Blind record copying with `allowDuplicate: true` was the root cause of record fragmentation and duplicate trap creation during previous merges.
   - By running semantic trap detection during merge, identical traps consolidate their occurrence count (`occurrences = max(target, source) + 1` or sum) and hits, preventing duplicate trap brief pollution.

3. **Vault Rename Invariants**:
   - A rename must atomically rename the directory and update all referencing alias rows in `projectAliases`.
   - Rebuilding FTS5 ensures that searches immediately resolve records under the new project ID.

4. **Security & Git Boundary**:
   - `.spec-memo.json` in the consumer project root is lightweight and can be safely committed to source control by the user to pin the project ID across team members or clones.
   - `.spec-memo.json` must NOT contain sensitive credentials or auth tokens.

## Deferred Ideas
- Cross-vault backup synchronization directly via `.spec-memo.json` remote pointer.
- Automatic git hook invocation of `memo init` on repository clone.
