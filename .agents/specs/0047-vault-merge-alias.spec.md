---
id: null
slug: vault-merge-alias
title: "Vault manager: alias redirect, merge, and project CRUD"
source: local
specDate: 2026-09-04
---

# Specification — Vault manager: alias redirect, merge, and project CRUD

## Description

Operators can end up with **two or more project directories under one vault root** that represent the same real product. Identity is derived from a normalized git remote or a path-hash fallback (`0002-vault-and-identity`). A missing remote, a local-path `origin`, a renamed folder, or a different clone root produces a new `projectId`. Bootstrap then scaffolds an empty `projects/{id}/` and prior traps, decisions, and specs stay in the old directory.

This slice adds a **canonical identity plus alias redirects**, plus a **status-monitor Vaults screen** and CLI to manage projects without adding a 12th MCP tool.

**Identity model**

1. Each on-disk folder under `projects/` remains a project id string (filesystem name).
2. Vault config stores an alias map: source id → canonical id. Example: `marchanterp-vault-name-1` and `marchanterp-vault-name-2` both redirect to `marchanterp`.
3. `resolveProjectIdentity` (and every read/write that uses its `projectId`) **follows aliases to a terminal canonical id** before opening `projects/{id}/`. Bootstrap, upsert, search, wiki, hybrid sync, and status project selectors use the canonical id.
4. **Merge** is operator-triggered: choose one or more source ids and a canonical target (existing or newly created). The operation writes aliases, optionally **copies records** into the target using existing store/sync merge rules, rebuilds FTS, and leaves sources as alias stubs (not silent deletes).
5. Operators can **create** a canonical project, **edit** `displayName` / metadata, **remove alias**, **delete** a project directory (explicit confirm, after backup or when empty), and **update** alias rows.

**Surfaces**

- Status monitor **Vaults** tab (`?tab=vaults`): list projects from `GET /api/vaults` (array parse trap), show alias targets, actions create / edit / alias / merge / delete.
- REST under `/api/vaults/*` with the same auth, `sanitizeToolOutput`, loopback, and activity-bus write capture as backup/reset.
- CLI `memo vault` subcommands (list, alias, merge, create, edit, delete). Not MCP.

**Architecture**

- Persist aliases in vault `config.json` (key `projectAliases: Record<string, string>`) plus optional per-project `project.json` field `canonicalOf` for display. Config is the SoT for resolution.
- `resolveCanonicalProjectId(id)` walks the map with a visited-set; cycles and missing targets fail closed.
- Mutations run under `withVaultLock` / `commitVaultChange` like other vault writes.
- GET list endpoints stay read-only: no `ensureVaultStructure`.

Design choices: [`0047-vault-merge-alias.context.md`](0047-vault-merge-alias.context.md).

## Acceptance Criteria

- AC1: Vault `config.json` may contain `projectAliases` as a JSON object of string to string; omitted or empty object means identity behavior matches today (no redirects).
- AC2: `resolveProjectIdentity` returns `projectId` equal to the terminal canonical id after following `projectAliases`; `vaultProjectPath` is `projects/{canonicalId}/`.
- AC3: Alias lookup is case-sensitive on stored ids and rejects cycles (A→B→A) with a thrown error that CLI/HTTP map to a non-zero / 400 response; it does not recurse infinitely.
- AC4: Setting aliases `marchanterp-vault-name-1` → `marchanterp` and `marchanterp-vault-name-2` → `marchanterp` makes bootstrap/upsert from a cwd that would have produced either source id write records under `projects/marchanterp/`.
- AC5: `GET /api/vaults` returns a JSON **array** of objects including at least `id`, `displayName`, `aliasOf` (canonical id or null), and `recordCount` (number); parsers must still accept a raw array first (`status-loadvaults-array-payload`).
- AC6: Status HTML includes a Vaults tab (`data-tab="tab-vaults"`, `id="tab-vaults"`) listing projects from `/api/vaults` with columns for id, display name, alias target, and record count.
- AC7: URL query `?tab=vaults` activates the Vaults tab on load.
- AC8: `POST /api/vaults/alias` with JSON `{ "from": "<sourceId>", "to": "<canonicalId>" }` persists the alias, returns `200` `{ ok: true, from, to }`, and does not leak absolute vault paths.
- AC9: `POST /api/vaults/alias` with missing `from`/`to`, `from` equal to `to`, unknown `from` (no project dir and not already an alias), or a cycle returns `400` and does not write config.
- AC10: `POST /api/vaults/merge` with JSON `{ "sources": ["id-a","id-b"], "target": "canonical", "copyRecords": true }` creates the target directory if missing, copies active records from each source into the target using existing upsert/dedup/supersede rules, writes aliases from each source to target, rebuilds FTS for the target, and returns `200` `{ ok: true, target, sources, copied, skipped }`.
- AC11: `POST /api/vaults/merge` with `copyRecords: false` (default) writes aliases only and does not move or delete source markdown files.
- AC12: `POST /api/vaults/merge` with empty `sources`, missing `target`, `target` inside `sources`, or `vault=all` semantics returns `400` and leaves the filesystem unchanged.
- AC13: Merge and alias writes run inside the vault lock and call `commitVaultChange` when vault-git is enabled (fail-open on git, same as other mutations).
- AC14: `POST /api/vaults/create` with JSON `{ "id": "marchanterp", "displayName": "MarchanteERP" }` scaffolds `projects/marchanterp/` via existing `initVault` rules and returns `201` `{ ok: true, id }`; duplicate id returns `409`.
- AC15: `POST /api/vaults/create` rejects ids that are not filesystem-safe (`[^a-z0-9._-]` after trim/lowercase) or equal to `all` with `400`.
- AC16: `PATCH /api/vaults/{id}` or `POST /api/vaults/update` with `{ "id", "displayName" }` updates `project.json` displayName and returns `200`; unknown id returns `404`.
- AC17: `DELETE /api/vaults/alias` with `{ "from": "<sourceId>" }` removes that alias row and returns `200`; unknown alias returns `404`.
- AC18: `POST /api/vaults/delete` with `{ "id", "confirm": true }` deletes `projects/{id}/` only when the id is not a live alias target used by other aliases, or when `force: true` is also sent; without `confirm: true` returns `400` and does not delete.
- AC19: Delete of a project that still has incoming aliases without `force` returns `409` with a sanitized error naming the alias sources.
- AC20: Status Vaults tab provides controls for create, set alias, merge (multi-select sources + target), edit display name, remove alias, and delete with an explicit confirm dialog (typed id or checkbox).
- AC21: Merge/delete buttons are disabled while the request is in flight.
- AC22: When a status auth token is configured, unauthorized GET `/api/vaults` and all mutating `/api/vaults/*` routes return `401` JSON.
- AC23: Mutating vault-manager responses pass through `sanitizeToolOutput` (no absolute `SPEC_MEMO_ROOT` paths).
- AC24: GET `/api/vaults` does not call `ensureVaultStructure` and does not create `config.json` on a pristine vaultRoot.
- AC25: CLI `memo vault list [--json]` prints the same project list fields as AC5 and exits 0.
- AC26: CLI `memo vault alias --from <id> --to <id>` persists the same map as AC8 and exits 0 on success.
- AC27: CLI `memo vault merge --source <id> --source <id> --target <id> [--copy-records]` matches AC10/AC11 and exits 0 on success.
- AC28: CLI `memo vault create|update|delete` match AC14–AC19 (delete requires `--confirm`).
- AC29: No 12th MCP tool is added; `ws-memo` SURFACE documents CLI extras only.
- AC30: After aliasing, `search`/`get`/`wiki` for the bound cwd use the canonical project directory, not an empty source folder.
- AC31: `generateStatusHtml` tests assert Vaults tab markers and `tab=vaults` deep-link handling.
- AC32: A unit test covering A→B→A alias persist attempt leaves `config.json` unchanged.

## Original Issue Context

Free-text `/ws-spec-write`: sometimes vaults/projects are the same real project but ids were identified differently, so knowledge was lost because the new vault started empty. Create a screen that manages vaults: create, associate/redirect/merge, edit, delete/remove/update. Merge by redirecting with alias, e.g. `marchanterp-vault-name-1` and `marchanterp-vault-name-2` both redirect to `marchanterp`.

### Prior Work Sweep

- Identity SoT: `src/identity.ts` (`generateProjectIdFromRemote`, `generateProjectIdFromPath`, `resolveProjectIdentity`). Path-hash fallback and local-path remotes create distinct ids (`0002-vault-and-identity`, `src/multi-clone.test.ts` shares id only when remotes match).
- Status already lists projects via `GET /api/vaults` → `getVaultProjectList` (`src/canvas.ts` / `src/status.ts`). Mutating vault APIs exist for export/import/reset/restore/backups (`0026`, `0030`, `0032`), not identity merge.
- Record merge across machines is `src/sync.ts` `mergeRecordMetadata` (multi-machine / reconcile), not project-id aliasing.
- Wiki and derive-rules require a specific `projectId` and refuse `all` (`0046`, trap `status-derive-rules-require-project`).
- No open PR titled vault merge/alias (keyword `alias` hits CLI/config aliases only).
- Greenfield for alias map; reuse initVault, upsert, FTS rebuild, status tab patterns.

### Design Intent

Not a bug restore. Path-based and remote-based ids are **intentional** in `0002`. This slice adds an **operator override** when those distinct ids are the same product. Do not change default remote normalization without a separate spec.

## Notes

- Traps: `status-loadvaults-array-payload`, `status-rest-sanitize-vault-paths`, `memo-status-must-not-call-ensurevaultstructure`, `backfill-vault-lock`, `status-derive-rules-require-project`.
- Language: en-us for UI copy, CLI help, and errors.
- Prefer timestamped backup (existing backup helpers) before `copyRecords` merge when the operator confirms delete of sources later; v1 merge does not auto-delete sources.

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool | Keep the 11-tool contract; CLI + status HTTP |
| Changing default git remote normalization | Identity algorithm stays `0002`; aliases are the override |
| Cross-vault-root merge (`~/.spec-memo` vs another `SPEC_MEMO_ROOT`) | One daemon, one vault root |
| Automatic alias inference from similar names | Operator must pick canonical id |
| Canvas graph of alias edges | Status Vaults tab is the human surface |
| Multi-tenant SaaS identity | Local filesystem vault |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Merge mechanism | Alias redirect is required; record copy is optional (`copyRecords`) | User asked to merge by redirecting with alias | y |
| Canonical id | Operator-chosen existing or created id (e.g. `marchanterp`) | Do not invent a third hashed id | y |
| Source directories after merge | Keep on disk until explicit delete | Safer than implicit rm; aliases hide them from writes | y |
| Config SoT | `config.json` `projectAliases` | Single map; `project.json` may mirror for humans | y |
| Implicit dimensions | N/A because validation, cycles, auth, lock, 409, 401, and read-only GET are explicit ACs | Covered in AC3, AC9–AC19, AC22–AC24, AC32 | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Alias map + Vaults tab + CLI; no MCP tool; no identity-algorithm rewrite | Out of Scope + this table |
| Atomic criteria | AC1–AC32 each have a pass/fail check | `validate_spec.cjs --mode=authoring` |
| Failure modes | Cycles, missing ids, unconfirmed delete, unauthorized, empty merge | Negative scenarios below |
| Observation telemetry | Named tests, HTTP codes, CLI exit codes | Validation Notes |
| Open blockers | None | Lookup complete; context companion records gray-area defaults |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/identity.test.js` (or new `vault-alias.test.js`) for resolve + cycle
- `node --test dist/status.test.js` Vaults tab / `/api/vaults/alias` / merge
- `memo vault list --json` stdout array length and `aliasOf`
- Activity bus `kind: "write"` on alias/merge/delete
- `config.json` `projectAliases` after CLI alias

### Negative & Failing Test Scenarios

- POST alias that would create A→B→A returns 400 and leaves `projectAliases` unchanged.
- POST merge with `sources` including `target` returns 400 and does not copy files.
- POST delete without `confirm: true` returns 400 and the project directory still exists.
- GET `/api/vaults` on a pristine empty vaultRoot does not create `config.json`.
- Unauthorized POST `/api/vaults/alias` returns 401 when a token is configured.
