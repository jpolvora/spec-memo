# Vault Manager, Aliases & Local Binding

## Feature Overview

A vault can accumulate more than one project partition for the same real product because identity derives from git remote normalization or a path-hash fallback. The vault manager lets operators unify those partitions without deleting data: alias redirects map source ids to a terminal canonical id, a semantic merge copies and deduplicates records, and rename/create/update/delete manage project directories. A consumer-side `.spec-memo.json` file pins a repository to a chosen vault id, and status/CLI surfaces report the active binding.

Primary journeys:

- An operator opens the status monitor **Vaults** tab (`?tab=vaults`), sees id, display name, alias target, record count, and a side-by-side action row, then uses modal forms for Create, Edit, Alias, Merge, Rename, Remove alias, Sync, and Delete.
- A maintainer runs `memo vault list|alias|unalias|merge|rename|create|update|delete` and `memo init`.
- An agent's read/write path silently resolves the canonical id via `resolveProjectIdentity`, so search, upsert, bootstrap, and wiki all target the canonical directory.

No 12th MCP tool is added; these are CLI extras and status HTTP routes.

## Business Rules & Logic

### Identity resolution and local binding

- **File-first discovery.** `resolveProjectIdentity` walks upward from the usable cwd to the git root (inclusive) or filesystem root looking for `.spec-memo.json`, skipping the vault root itself. The closest file wins.
- **Binding.** A valid `.spec-memo.json` `projectId` (trimmed, lowercased, filesystem-safe) becomes the base id; `identitySource` is `file` and `configFilePath` records the file path. Aliases are then applied to reach the canonical id. When the file id is invalid, discovery falls through to git/path resolution.
- **Fallback precedence.** Without a usable file: a non-local git remote produces a remote-derived id (`identitySource: 'git'`); a local-path remote or no remote produces a path-hash id (`identitySource: 'path'`). `normalizedRemote` is null for fallbacks.
- **Local overrides.** `.spec-memo.json` may override global `config.json` for the known keys `bootstrap`, `ports`, `vaultGit`, `telemetry`, `ttl`, and `sync`. Nested objects merge one level deep, scalars replace. Any key whose name matches `token|secret|password|api_?key|auth|private_?key|bearer|credentials`, or whose value scans as a secret, is stripped. `.spec-memo.json` must never contain tokens.
- **Read-only status.** `memo status` reports the active project id and its source (`.spec-memo.json`, `Git Remote`, or `Local Path Fallback`) plus local override keys, and never writes `.spec-memo.json` or `config.json`.

### Alias redirects

- **Source of truth.** `config.json` key `projectAliases: Record<string, string>`. An absent or empty map means no redirects. `project.json` may mirror `canonicalOf` for display only.
- **Resolution.** `resolveCanonicalProjectId` follows the map with a visited set and throws `Alias cycle detected at project id "<id>"` on a cycle. Alias lookup is case-sensitive.
- **Validation (`setProjectAlias`).** `from` and `to` are required and must differ; the target must be filesystem-safe; both source and target must exist as a project directory or an existing alias key; a cycle (A→B→A) is rejected. On success the alias is persisted and `project.json` gains `canonicalOf`.
- **Removal.** `removeProjectAlias` returns `404` when no alias row exists for the id, otherwise deletes the row and the mirrored `canonicalOf`.

### Merge

- **Validation.** `sources` must be non-empty; `target` is required and must be filesystem-safe; the target cannot appear in sources; every source must exist as a directory or alias key; `deleteSources: true` requires `copyRecords: true`. A missing target directory is created via `initVault`.
- **Cycles.** Before writing aliases, each source→target edge is checked with `wouldCreateCycle`; a cycle rejects the whole operation.
- **Copy and dedup.** `dedup` defaults to `true` and only applies when `copyRecords` is true. Exact id matches in the target are skipped. Traps match in order: slug key, exact id, normalized title, then semantic `findMatchingTrap` (matching `pathPatterns` plus token overlap ≥ 0.7). Decisions/specs/plans/other kinds match by slug or normalized title via `findMatchingNonTrapRecord`.
- **Consolidation.** A matched trap keeps the target's canonical `pathPatterns`/body/layer/severity/module and merges `occurrences` and `hits` (summed), `lastSeen`/`updated` (max), and a union of tags. Matched non-traps sum `hits`, take the max `updated`, union tags, and keep the newer body. Copies are written with `project` rewritten to the target and re-indexed.
- **Metrics.** The result is `{ ok: true, target, sources, copied, deduplicated, skipped }`.
- **Post-merge cleanup.** `deleteSources: true` removes each source directory after aliases are retained, then rebuilds FTS and target compiled views. Without `copyRecords`/`deleteSources`, only aliases are written and no source Markdown is moved or deleted.
- **Alias stubs.** Sources remain on disk as alias stubs unless explicitly deleted; `canonicalOf` is written into each source `project.json` and cleared from the target.

### Rename

- **Validation.** Source and target are required and must differ, both must be filesystem-safe, the source must exist, and the target must not exist as a directory or alias key (`409` otherwise; unknown source `404`).
- **Effect.** Under vault lock the directory is renamed, `project.json` gets `projectId = dest` and loses `canonicalOf`, and every alias key/value pointing at the source is remapped to the destination (self-loops dropped). A final cycle check rolls the directory rename back if the resulting map would cycle. FTS is rebuilt, compiled views regenerated, and the change committed.

### Delete

- **Confirmation.** `confirm: true` is required or the request fails `400`. Unknown project → `404`.
- **Alias safety.** Deleting a project that still has incoming aliases returns `409` naming the sources unless `force: true`; deleting a project that is itself an alias returns `409` unless forced.
- **Effect.** The directory is removed, the id and any aliases pointing at it are pruned, and FTS is rebuilt.

### Surfaces

- **REST** on the status listener (`:3124`), all mutating bodies pass through `sanitizeToolOutput`:
  - `GET /api/vaults` → a raw JSON array of `{ id, displayName, aliasOf, recordCount }` (parsers must check `Array.isArray` first; the list is never wrapped).
  - `POST /api/vaults/alias` `{ from, to }` → `200 { ok, from, to }`; invalid/unknown/cycle → `400`.
  - `DELETE /api/vaults/alias` `{ from }` → `200`; unknown alias → `404`.
  - `POST /api/vaults/merge` `{ sources, target, copyRecords, dedup, deleteSources }` → `200` metrics; empty sources/missing target/target-in-sources → `400`.
  - `POST /api/vaults/rename` `{ from, to }` → `200 { ok, from, to }`; invalid `400`, missing source `404`, existing target `409`.
  - `POST /api/vaults/create` `{ id, displayName }` → `201 { ok, id }`; duplicate `409`; unsafe id or `all` `400`.
  - `POST /api/vaults/update` or `PATCH /api/vaults/{id}` `{ id, displayName }` → `200`; unknown `404`.
  - `POST /api/vaults/delete` `{ id, confirm, force }` → `200`; no confirm `400`; incoming aliases `409`.
- **Vaults tab UI.** Every action uses an in-page modal (`id="modal-vault-action"`); `window.prompt`/`confirm`/`alert` must not run. Rows render wrapping side-by-side `button[data-vault-action]` controls (`display:flex; flex-wrap:wrap`), including Remove alias when `aliasOf` is set. Merge uses source checkboxes plus `copyRecords`, `dedup`, and `deleteSources` toggles; delete requires typing the exact project id; Sync offers Pull/Push/Both, a `dryRun` checkbox, and `prefer` defaulting to `local`. Buttons and modal primary actions are disabled while `vaultsManagerBusy`. Errors surface in the banner/modal region, not `alert()`. `?tab=vaults` deep-links to the tab.
- **Per-project sync.** `POST /api/vaults/sync` `{ id, direction: "pull"|"push"|"both", dryRun, prefer }`. Requires a known id (not `all`) and a valid direction (`400` otherwise) and at least one enabled channel — hybrid remote or `vaultGit.enabled` (`400` naming the gap). `both` runs `syncDual` with `trigger: "sync"`; `pull` requires hybrid and calls `pullHybridProject`; `push` calls `pushHybridProject` and flushes vault-git. Success returns `200`; a sync failure returns `502`. The activity bus records a write with `path: "/api/vaults/sync"`.
- **Init.** `memo init [--project-id <id>] [--force] [--json]` resolves the project root (git root or usable cwd) and writes `.spec-memo.json` at `<projectRoot>/.spec-memo.json`. It refuses to overwrite an existing file without `--force`, rejects unsafe ids, refuses paths inside the vault, and infers a default id from a normalized non-local remote, else the sanitized directory basename, else a path hash. JSON output is `{ ok: true, path, projectId }`.
- **Filesystem-safe ids.** `isFilesystemSafeProjectId` requires lowercase `[a-z0-9._-]+`, rejects empty and `all`; create and rename lowercase the id before validation.

## Technical Architecture

- **Modules.** `src/identity.ts` (`LOCAL_SPEC_MEMO_FILENAME`, `findLocalSpecMemoConfig`, `loadLocalSpecMemoConfig`, `getLocalConfigOverrides`, `getLocalConfigOverrideKeys`, `getEffectiveVaultConfig`, `resolveVaultId`, `resolveProjectIdentity`, `findGitRoot`, `normalizeGitRemote`, `generateProjectIdFromRemote`, `generateProjectIdFromPath`) and `src/vault-manager.ts` (`VaultManagerError`, `isFilesystemSafeProjectId`, `readProjectAliases`, `resolveCanonicalProjectId`, `getVaultProjectListEnriched`, `countProjectRecords`, `listIncomingAliases`, `setProjectAlias`, `removeProjectAlias`, `createVaultProject`, `updateVaultProject`, `deleteVaultProject`, `renameVaultProject`, `mergeVaultProjects`, `copyRecordsToTarget`).
- **Persistence.** Aliases in vault `config.json`; per-project `project.json` holds `displayName`, `gitRemote`, `lastSeenRoot`, and `canonicalOf`. Records are Markdown plus SQLite FTS. All mutations use `withVaultLock` and `commitVaultChange` (vault-git, fail-open). GET list endpoints stay read-only and never call `ensureVaultStructure`.
- **Types.** `VaultProjectListEntry`, `MergeMetrics` (`copied`, `deduplicated`, `skipped`), `ProjectIdentity` (`identitySource`, `configFilePath`).
- **CLI** (`src/cli.ts`). `memo vault list [--json]`, `memo vault alias --from <id> --to <id>`, `memo vault unalias --from <id>`, `memo vault merge --source <id> (repeat) --target <id> [--copy-records] [--no-dedup] [--delete-sources]`, `memo vault rename --from <id> --to <id>`, `memo vault create [--id] [--display-name]`, `memo vault update`, `memo vault delete [--confirm] [--force]`. `memo init` and `memo status` report the binding source and overrides.
- **Tests.** `src/identity.test.ts`, `src/vault-manager.test.ts`, `src/vault-rename-merge-status.test.ts`, `src/status.test.ts`, and `src/status-cmd.test.ts`.
- **Provenance:** `0047-vault-merge-alias.spec.md` (aliases, CRUD, Vaults tab), `0049-status-vaults-tab-ui.spec.md` (modal forms and per-project sync), and `0050-vault-dedup-merge-and-local-config.spec.md` (`.spec-memo.json`, rename, dedup merge). Related: [Per-Project Vault Wiki](project-wiki.md).
