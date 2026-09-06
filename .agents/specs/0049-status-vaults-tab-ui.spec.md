---
id: null
slug: status-vaults-tab-ui
title: "Status Vaults tab: modal forms and per-project sync"
source: local
specDate: 2026-09-06
---

# Specification — Status Vaults tab: modal forms and per-project sync

## Description

The status monitor Vaults tab (`:3124`, `?tab=vaults`) already lists projects in a five-column table (id, display name, alias target, records, actions) and calls the `0047` REST surface (`/api/vaults/create|update|alias|merge|delete`). Those actions still collect input with `window.prompt` and `window.confirm` (and create uses two sequential prompts). That is blocking, unstyled, and cannot present multi-field forms (merge source list, copy-records, typed delete, sync direction).

This slice upgrades **only the Vaults tab operator UX** (plus one new status-companion REST route for sync):

1. **Replace all Vaults-tab `window.prompt` / `window.confirm` / `window.alert` with in-page modal forms** that reuse the existing status CSS (`.modal-overlay`, `.modal-card`, `.modal-actions`) already used by Backups (export, full backup, delete-by-filename). Native `prompt`/`confirm`/`alert` must not run for create, edit, alias, merge, unalias, delete, or sync.
2. **Keep a visible side-by-side action row** on every vault: Edit, Alias, Merge, Remove alias (when `aliasOf` is set), Sync, Delete, plus toolbar Create / Refresh. Buttons wrap; they are not hidden behind a kebab/`<select>` menu.
3. **Add Sync up/down** for the selected project. The browser is the client; the status companion is the local vault daemon. **Push (up)** sends this machine’s records toward the configured remote; **Pull (down)** fetches remote records into this vault; **Both** is pull-then-push. The handler reuses `syncDual` / `syncHybrid` / `pushHybridProject` / `pullHybridProject` / `flushVaultGit` (same engines as `memo sync`). No 12th MCP tool. Backup zip export/import stays on the Backups tab.

**Architecture**

- One reusable Vaults modal overlay (`id="modal-vault-action"`) whose title, helper text, fields, and primary button label switch by action. Destructive delete uses the existing error-bordered card pattern (`modal-delete-backup`).
- Merge sources are checkboxes (other project ids), not a comma-separated prompt. Alias target is a `<select>` of known ids plus an optional typed id field.
- `POST /api/vaults/sync` on the **status** listener (`:3124`), not the SSE `/api/sync/*` routes on `:3123`. Auth, `sanitizeToolOutput`, vault lock, and activity-bus write capture match other mutating `/api/vaults/*` handlers.
- Hybrid prefer/strategy stay **this daemon’s** perspective (`prefer: local` keeps the status host’s records). Do not apply `trap-sync-client-push-perspective-inversion` when the status process is already the hybrid client calling `syncHybrid` in-process.

Design choices: [`0049-status-vaults-tab-ui.context.md`](0049-status-vaults-tab-ui.context.md).

## Acceptance Criteria

- AC1: `generateStatusHtml` Vaults tab handlers contain **no** calls to `window.prompt`, `window.confirm`, `window.alert`, or the bare globals `prompt(`, `confirm(`, `alert(` used as user dialogs.
- AC2: Clicking **Create project** opens a modal with fields for filesystem-safe `id` and `displayName`, Cancel and Submit side by side; Submit calls `POST /api/vaults/create` with those values; Cancel / overlay dismiss / Escape closes without a network mutation.
- AC3: Clicking **Edit** on a row opens a modal prefilled with that row’s `displayName`; Submit calls `POST /api/vaults/update` (or `PATCH /api/vaults/{id}`) with `{ id, displayName }`.
- AC4: Clicking **Alias** opens a modal with the source id shown read-only, a `<select>` of other vault ids (plus optional typed target), and Submit calling `POST /api/vaults/alias` `{ from, to }`. Empty target disables Submit.
- AC5: Clicking **Remove alias** opens a confirm modal (not `window.confirm`) naming `from`; Confirm calls `DELETE /api/vaults/alias` `{ from }`.
- AC6: Clicking **Merge** on target row `id` opens a modal listing other vaults as checkboxes (`sources`), a `copyRecords` checkbox (default unchecked), and Submit calling `POST /api/vaults/merge` `{ sources, target: id, copyRecords }`. Submit stays disabled until at least one source is checked.
- AC7: Clicking **Delete** opens a modal that requires typing the exact project `id` (primary button disabled until the input matches), then calls `POST /api/vaults/delete` `{ id, confirm: true }`. Mismatch never sends the request.
- AC8: Each data row’s Actions cell renders **side-by-side** `button[data-vault-action]` controls in a wrapping flex row (`display:flex; flex-wrap:wrap; gap:…`) for Edit, Alias, Merge, Sync, Delete, and Remove alias when `aliasOf` is set. Actions are not collapsed into a single dropdown.
- AC9: Vaults table Actions column is wide enough for the wrapped button row (CSS `min-width` on the Actions `th`/`td`, not a fixed `280px` that clips).
- AC10: Clicking **Sync** opens a modal showing project id, a direction control with three labeled options (Pull (down), Push (up), Both), a `dryRun` checkbox, and `prefer` `local` | `remote` (default `local`). Side-by-side Cancel and Run sync.
- AC11: Sync Submit calls `POST /api/vaults/sync` with JSON `{ "id": "<projectId>", "direction": "pull"|"push"|"both", "dryRun": boolean, "prefer": "local"|"remote" }` and never uses query-string secrets.
- AC12: `POST /api/vaults/sync` with a valid `id` and `direction: "both"` invokes `syncDual({ trigger: "sync", projectId: id, dryRun, prefer })` when hybrid and/or `vaultGit.enabled` apply; returns `200` JSON `{ ok: true, id, direction, hybrid?, vaultGit? }` with **no** absolute vault paths (`sanitizeToolOutput`).
- AC13: `direction: "pull"` runs hybrid pull for that `projectId` when `mode === "hybrid"`; `direction: "push"` runs hybrid push (and vault-git flush when `vaultGit.enabled` and mode is not `remote`). `direction: "both"` is pull-then-push for hybrid plus vault-git flush when enabled, matching `memo sync` dual-mode `Promise.allSettled` fail-open.
- AC14: `POST /api/vaults/sync` without `id`, with `id` equal to `all`, unknown project id, or invalid `direction` returns `400` and does not mutate records or git.
- AC15: When neither hybrid remote nor `vaultGit.enabled` is configured, `POST /api/vaults/sync` returns `400` with a sanitized error that names the missing channel; the modal shows that error in the existing status banner (or an in-modal error region), not `alert()`.
- AC16: When a status auth token is configured, unauthorized `POST /api/vaults/sync` returns `401` JSON (same candidate collection as other status routes).
- AC17: Sync, merge, delete, create, alias, and update buttons stay disabled while `vaultsManagerBusy` is true (including while the modal request is in flight); the modal primary button shows a busy/disabled state until the fetch settles.
- AC18: After a successful create/update/alias/merge/delete/sync, the modal closes, `showBanner` reports success (en-us), and `loadVaultsManager()` refreshes the table (including `recordCount`).
- AC19: Failed API calls leave the modal open (except 401 redirect-to-login already owned by `apiFetch`), surface `data.error` in the banner or modal error region, and do not call `alert()`.
- AC20: Escape and overlay click close the vault modal without submitting; focus moves to the first field when opened.
- AC21: `GET /api/vaults` array parse remains `Array.isArray(data)` first (`status-loadvaults-array-payload`); this slice does not wrap the list in `{ vaults: [...] }`.
- AC22: No 12th MCP tool; CLI `memo sync` behavior is unchanged except that status HTTP reuses the same dual-sync functions.
- AC23: `src/status.test.ts` asserts: (1) Vaults HTML includes `modal-vault-action` (or equivalent id) and `data-vault-action="sync"`; (2) the Vaults click-handler source in `generateStatusHtml` does not include `window.prompt` or `window.confirm`; (3) `POST /api/vaults/sync` happy path, 400 invalid direction, 401 when token set.
- AC24: Activity bus records a write/sync event for `POST /api/vaults/sync` with sanitized `path` `/api/vaults/sync` (no host filesystem paths).
- AC25: Unalias / delete / merge / sync of an alias source uses the row `id` as submitted, not a silently rewritten canonical id, unless the existing `0047` alias resolver already maps that operation (do not change alias semantics).

## Original Issue Context

Free-text `/ws-spec-write` (2026-09-06): enhance UI `:3124` Vaults tab screen, the actions row for each vault (id, display name, alias target, records, actions). Improve the UI: do not use prompt/popup/confirm JavaScript functions; use side-by-side buttons that call modal forms with full-featured nice UI. Add an option to sync up/down from client/server communication.

### Prior Work Sweep

- Vaults tab and REST CRUD shipped in `0047-vault-merge-alias` (`58c86a6`). Implementation still uses `window.prompt` / `window.confirm` in `src/status.ts` `generateStatusHtml` despite AC20 wording (“explicit confirm dialog”).
- Backups tab already has `.modal-overlay` / `.modal-card` / typed-filename delete (`0032-status-backup-page`, `0026-status-vault-backup-ui`). Reuse that pattern; do not add a JS framework.
- Hybrid HTTP lives on SSE `:3123` (`POST /api/sync/pull|push` and `syncHybrid` in `src/hybrid-sync.ts`). Dual orchestration is `syncDual` in `src/dual-sync.ts`. Status `:3124` has no vault sync route today.
- Traps: `status-loadvaults-array-payload`, `status-rest-sanitize-vault-paths`, `trap-sync-client-push-perspective-inversion` (in-process hybrid client: do not invert prefer), `hybrid-sync-dryrun-scope-lock`, `status-secret-in-query`.
- Keyword `git log` / GitHub: no open PR titled Vaults modal/sync; related shipped work is vault manager 0.20.0 and vault-git hybrid sync `0033`.

### Design Intent

Not a restore of lost identity behavior. `0047` intentionally shipped prompt-based dialogs as a thin operator surface. This spec **replaces that UX** and **adds** per-project sync from the status UI. Do not change `projectAliases` resolution or merge copy semantics.

## Notes

- Language: en-us for modal copy, errors, and tests.
- `apiFetch` 401 decrypt vs auth trap is backups-specific; sync errors must not put passwords in the URL.
- Remote deployment mode has no local vault writes; status companion on a remote-mode proxy may 400 sync the same as CLI `memo sync`.
- Widen `.modal-card` for the vault modal only if merge checklists need it (`max-width` ~560px); do not restyle Backups modals unless shared CSS requires a modifier class.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replacing prompt/confirm on Wiki, Prompts, Memory, or Backups tabs | User asked Vaults actions row |
| New MCP tool | 11-tool contract |
| Changing alias/merge/delete REST contracts from `0047` | UX + sync only; reuse existing bodies |
| Teaching Backup export/import as “sync” | Already on Backups tab |
| Canvas / CLI TUI for the same modals | Status HTML is the surface |
| Rewriting hybrid prefer inversion on `/api/sync/push` (SSE) | Different process boundary; trap already covers daemon applyChangeset |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Sync meaning | Hybrid HTTP and/or vault-git via `syncDual`, not zip backup | User said client/server up/down; engines already exist | y |
| Direction labels | Pull = down (remote → this vault); Push = up (this vault → remote) | Matches hybrid pull/push | y |
| Modal implementation | Reuse `.modal-overlay` HTML/CSS, one parameterized vault modal | Matches Backups; zero new deps | y |
| Action layout | Visible wrapping button row, not a menu | User asked side-by-side buttons | y |
| Implicit dimensions | N/A because validation, 400/401, busy, sanitize, dry-run, and focus/dismiss are explicit ACs | Covered in AC1–AC24 | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Vaults tab modals + `POST /api/vaults/sync`; no MCP; no 0047 contract rewrite | Out of Scope + this table |
| Atomic criteria | AC1–AC25 each pass/fail | `validate_spec.cjs --mode=authoring` |
| Failure modes | Empty merge, typed delete mismatch, sync without channel, 401, invalid direction | Negative scenarios |
| Observation telemetry | `status.test.ts`, HTTP codes, activity bus | Validation Notes |
| Open blockers | None | Lookup complete; context companion records remaining product options |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/status.test.js` (HTML fixture + `/api/vaults/sync`)
- `POST /api/vaults/sync` statusCode and sanitized JSON
- Activity bus `path: "/api/vaults/sync"`
- Banner text after success/failure (no `alert(`)
- Optional live: `memo serve --sse` then open `http://127.0.0.1:3124/?tab=vaults`

### Negative & Failing Test Scenarios

- Vaults click handler still containing `window.prompt` or `window.confirm` fails AC1/AC23 (red test).
- `POST /api/vaults/sync` with `direction: "sideways"` or missing `id` returns 400 and does not call `syncHybrid`.
- `POST /api/vaults/sync` with token configured and no Authorization returns 401.
- Delete modal Confirm stays disabled when typed text ≠ project id (no DELETE/POST delete).
- Merge Submit stays disabled with zero sources checked.
- Sync when `mode: local` and `vaultGit.enabled` false returns 400; table unchanged.
