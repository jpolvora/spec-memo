---
id: null
slug: vault-dedup-merge-and-local-config
title: "Vault dedup merge, vault rename, and consumer .spec-memo.json local config"
source: local
specDate: 2026-09-08
---

# Specification — Vault dedup merge, vault rename, and consumer .spec-memo.json local config

## Description

In production usage of spec-memo, multiple vaults can inadvertently be created over time for the same product repository (for instance, the `marchanterp` project ended up with split vaults due to folder renames, clone location shifts, or remote URL changes). This fragmentation causes memory entries (traps, decisions, specs, and plans) to be scattered across multiple project IDs, creating duplicate records, degrading retrieval efficiency, and steering agent queries (traps, gaps, bootstraps, and searches) toward the wrong vault partition.

This specification addresses these operational issues across three interconnected capabilities:

1. **Consumer Project Root Configuration (`.spec-memo.json`)**:
   - Consumers can place a `.spec-memo.json` configuration file in their project root.
   - The file explicitly declares `projectId` (string) to bind that repository to a specific vault partition for all read and write operations.
   - The file may also include JSON keys that override global vault `config.json` settings locally (e.g. `bootstrap`, `ports`, `vaultGit`, `telemetry`).
   - `resolveProjectIdentity` and `resolveVaultId` discover `<projectRoot>/.spec-memo.json` upwards from `cwd`, prioritizing it over git remote normalization and path hashing.
   - `ProjectIdentity` records `identitySource` (`file`, `git`, or `path`) and the configuration file path.
   - CLI command `memo init` automates the creation of `.spec-memo.json`, inferring a default `projectId` from git remotes or directory names.
   - `memo status` inspects and reports the active project ID along with its binding source and any active local configuration overrides.

2. **Vault Renaming**:
   - Provides a first-class rename operation for project vaults.
   - `renameVaultProject(from, to, vaultRoot)` renames the project directory on disk, updates `project.json`, migrates all incoming and outgoing aliases in `config.json` `projectAliases`, rebuilds the SQLite FTS5 index, and updates compiled markdown views under vault lock.
   - Exposed via CLI `memo vault rename --from <id> --to <id>`, REST endpoint `POST /api/vaults/rename`, and a dedicated modal in the status monitor Vaults tab.

3. **Smart Deduplicated Vault Merging**:
   - Upgrades vault merge (`mergeVaultProjects` and status monitor UI) to resolve duplicates intelligently rather than performing blind copies.
   - Traps are deduplicated using slug/ID matching and semantic equivalence (matching `pathPatterns` and body token overlap >= 0.7 via `findMatchingTrap`, or matching titles). When matched, occurrences, hits, and timestamps are consolidated into the target trap.
   - Decisions, specs, and plans are deduplicated by slug or normalized title.
   - Merge returns detailed metrics: `{ copied, deduplicated, skipped }`.
   - Supports optional post-merge source deletion (`deleteSources: true`), which removes source project directories while preserving alias redirects.
   - Upgrades the status monitor Vaults tab merge modal with explicit source selection, smart deduplication toggles, post-merge cleanup options, and real-time result reporting.

## Acceptance Criteria

- AC1: `resolveProjectIdentity` and `resolveVaultId` search for `.spec-memo.json` in `cwd` and its ancestor directories up to the git or filesystem root.
- AC2: When `.spec-memo.json` contains a valid `projectId`, `resolveProjectIdentity` uses that identifier as the base project ID before alias resolution.
- AC3: `resolveProjectIdentity` sets `identitySource: "file"` and populates `configFilePath` when resolved from `.spec-memo.json`.
- AC4: `resolveProjectIdentity` follows vault `projectAliases` to a terminal canonical project ID when the ID originates from `.spec-memo.json`.
- AC5: Local configuration keys present in `.spec-memo.json` override corresponding global vault `config.json` settings for operations in that directory.
- AC6: CLI `memo init` detects the project root and writes `.spec-memo.json` containing an auto-inferred `projectId`.
- AC7: CLI `memo init` derives default `projectId` from normalized git remote when inside a git repository or folder basename when outside git.
- AC8: CLI `memo init` with `--project-id <id>` validates filesystem safety and writes the specified ID.
- AC9: CLI `memo init` refuses to overwrite an existing `.spec-memo.json` unless `--force` is specified.
- AC10: CLI `memo init --json` returns structured JSON output containing `ok: true`, `path`, and `projectId`.
- AC11: CLI `memo status` reports the active project ID along with its source: `.spec-memo.json`, `git remote`, or `local path fallback`.
- AC12: CLI `memo status` lists active local configuration overrides when `.spec-memo.json` contains override keys.
- AC13: CLI `memo status --json` includes `project.identitySource`, `project.configFilePath`, and `project.configOverrides`.
- AC14: `renameVaultProject(from, to, vaultRoot)` validates that source project exists and destination ID is filesystem-safe and non-existent.
- AC15: `renameVaultProject` renames `projects/{from}` to `projects/{to}` under vault lock and updates `project.json` inside the directory.
- AC16: `renameVaultProject` updates all entries in `config.json` `projectAliases` that point to `from` or originate from `from`.
- AC17: `renameVaultProject` rebuilds SQLite FTS5 index and target compiled views after directory rename.
- AC18: `POST /api/vaults/rename` accepts `{ from, to }` and returns HTTP 200 with `{ ok: true, from, to }`.
- AC19: `POST /api/vaults/rename` returns HTTP 400 for invalid IDs, HTTP 404 for non-existent source, and HTTP 409 for existing target.
- AC20: CLI `memo vault rename --from <id> --to <id>` executes project rename and exits 0 on success.
- AC21: Status monitor Vaults tab includes a Rename action button that opens a modal form to submit vault rename.
- AC22: `mergeVaultProjects` with `copyRecords: true` detects duplicate traps by matching slug, exact ID, title, or pathPatterns with token overlap >= 0.7.
- AC23: `mergeVaultProjects` merges occurrences, hits, and timestamps into the matching target trap instead of creating duplicate records.
- AC24: `mergeVaultProjects` deduplicates decisions, specs, and plans by matching slug or normalized title.
- AC25: `mergeVaultProjects` returns structured counts for copied, deduplicated, and skipped records.
- AC26: `mergeVaultProjects` with `deleteSources: true` removes source project directories while retaining alias redirects in `projectAliases`.
- AC27: `POST /api/vaults/merge` accepts optional `dedup` and `deleteSources` parameters and returns merge metrics.
- AC28: CLI `memo vault merge` supports `--no-dedup` and `--delete-sources` options.
- AC29: Status monitor Vaults tab merge modal includes controls for smart deduplication and post-merge source deletion.
- AC30: Status monitor Vaults tab displays merge results banner showing copied, deduplicated, and skipped counts.
- AC31: Mutating rename and merge REST responses pass through `sanitizeToolOutput` without exposing absolute host filesystem paths.
- AC32: `memo status` remains strictly read-only and does not create `.spec-memo.json` or `config.json` on disk.

## Original Issue Context

The user reported a concrete production issue where working on a project called `marchanterp` resulted in two distinct vault partitions being created over time in spec-memo. Memory entries (traps, decisions, etc.) became fragmented between both project IDs, with many records duplicated. Consequently, new implementation tasks querying traps, gaps, bootstraps, and searches looked in the wrong vault or retrieved redundant data.

Requirements from user prompt:
- Revise the vault merge feature in the management UI (status monitor).
- Provide a way to configure via a file in the consumer project root (`.spec-memo.json`) containing the project (vault) ID used for read/write.
- Provide a method `resolveVaultId` or similar to identify the local `.spec-memo.json`.
- Provide `memo init` to automatically generate `.spec-memo.json` on start with an auto-detected default value, editable later.
- Ensure `memo status` checks the current project ID and reports its source: git URL or `.spec-memo.json`.
- Allow `.spec-memo.json` to include JSON keys that override vault `config.json` for the local project.
- Provide an efficient vault merge mechanism that resolves duplicates.
- Provide vault renaming functionality.

### Prior Work Sweep

- Identity resolution: `src/identity.ts` implements `normalizeGitRemote`, `generateProjectIdFromRemote`, `generateProjectIdFromPath`, and `resolveProjectIdentity`. Prior to this slice, resolution only examined git remotes and path fallbacks without checking for a local configuration file (`0002-vault-and-identity`).
- Vault manager and aliases: `src/vault-manager.ts` and `0047-vault-merge-alias` introduced `projectAliases`, `mergeVaultProjects`, `setProjectAlias`, `createVaultProject`, `updateVaultProject`, and `deleteVaultProject`. Prior `copyRecordsToTarget` passed `allowDuplicate: true` and only skipped exact matching string IDs, leading to duplicate records when IDs differed.
- Status monitor Vaults tab: `0049-status-vaults-tab-ui` migrated Vaults tab actions from native prompts to modal forms (`#modal-vault-action`).
- Status command: `src/status-cmd.ts` runs `runStatusCheck` and outputs active project binding; trap `memo-status-must-not-call-ensurevaultstructure` requires `memo status` to stay strictly read-only.
- Trap deduplication: `src/store.ts` contains `findMatchingTrap` (pathPatterns check + token overlap >= 0.7) which can be leveraged for deduplication during vault merge.

### Design Intent

This is an intentional capability enhancement rather than a bug revert. `0002` established that identity derives from git remotes or path hashes by default. This slice introduces explicit repository-level control via `.spec-memo.json` so that projects with multiple clones, unstable remotes, or complex setups can bind unambiguously to a chosen vault. Furthermore, vault merge is improved from a shallow copy to a semantic deduplicating merge to clean up previously fractured project memory.

## Notes

- All UI copy, CLI messages, logs, and errors must be in `en-us`.
- Traps to respect: `memo-status-must-not-call-ensurevaultstructure`, `status-loadvaults-array-payload`, `status-rest-sanitize-vault-paths`, `session-end-vault-lock-merge`.
- `.spec-memo.json` files must never store authentication tokens or secrets.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New (12th) MCP tool | Adhere to the core 11 MCP tool contract; identity and config resolution occur transparently |
| Automatic AI semantic vector clustering | Keep deduplication deterministic, fast, and local using token overlap and slug matching |
| Cross-vault-root merge | Operations remain within the active `SPEC_MEMO_ROOT` |
| Cloud synchronization of `.spec-memo.json` | The file is stored in the consumer repository tree |
| Modifying `.gitignore` automatically | Users decide whether to commit `.spec-memo.json` to source control |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| File discovery | Walk upwards from `cwd` to git root or filesystem root | Supports running CLI commands from subdirectories of a consumer project | y |
| Config precedence | `.spec-memo.json` overrides `~/.spec-memo/config.json` | Project-local settings should take precedence over global machine defaults | y |
| Alias precedence | Aliases in `config.json` apply after `.spec-memo.json` | Ensures explicit redirects configured in vault manager remain effective | y |
| Default merge dedup | Enabled (`dedup: true`) when `copyRecords: true` | Prevents trap and record duplication when merging fragmented vaults | y |
| Implicit dimensions | N/A because validation, error status codes, locks, and read-only behavior are explicit ACs | Covered in AC14, AC15, AC18, AC19, AC31, AC32 | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Local config file + init + status source + vault rename + dedup merge; no new MCP tool | Out of Scope + AC table |
| Atomic criteria | AC1–AC32 each have an unambiguous pass/fail condition | `validate_spec.cjs --mode=authoring` |
| Failure modes | Invalid project IDs, existing file overwrite, missing source on rename, cycle handling | Negative scenarios below |
| Observation telemetry | Named tests, CLI exit codes, HTTP status codes, status dashboard output | Validation Notes |
| Open blockers | None | Lookup complete; context companion documents architectural choices |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/identity.test.js` verifying `.spec-memo.json` discovery and precedence.
- `node --test dist/vault-manager.test.js` verifying `renameVaultProject` and deduplicated `mergeVaultProjects`.
- `node --test dist/status-cmd.test.js` verifying source reporting and override summary.
- `node --test dist/status.test.js` verifying Rename modal and enhanced Merge modal.
- `memo init --json` output asserting `ok: true` and generated path.
- `memo status` displaying `Source: .spec-memo.json` and active project ID.

### Negative & Failing Test Scenarios

- `memo init` without `--force` in a directory where `.spec-memo.json` already exists fails with non-zero exit code.
- `POST /api/vaults/rename` with an existing target project ID returns HTTP 409 and does not rename the directory.
- `POST /api/vaults/rename` with a non-existent source project ID returns HTTP 404.
- `mergeVaultProjects` merging two vaults with duplicate traps consolidates occurrences rather than creating duplicate files.
- `memo status` on a repository with `.spec-memo.json` does not modify or re-write the file.
- Unauthorized `POST /api/vaults/rename` returns HTTP 401 when an auth token is configured.
