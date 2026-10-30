---
id: null
slug: status-error-logs-actions
title: "Status Error Logs: row selection, delete with confirm, New Issue copy draft"
source: local
specDate: 2026-09-13
---

# Specification — Status Error Logs: row selection, delete with confirm, New Issue copy draft

## Description

Spec `0058-status-monitor-nav-ai-config` shipped a **read-only** Error logs page (`tab-error-logs`): filters, paginated table, Refresh, detail pane, `GET /api/error-logs` and `GET /api/error-logs/{id}`. Operators cannot remove fixture noise from `error.logs` in the UI (GitHub #67 class of flood) and cannot assemble a GitHub issue from several rows without copy-paste from the detail pane one at a time.

This spec extends **only** the Error logs view and the error-log HTTP surface:

1. **Row selection.** Each table row has a checkbox. Selected ids live in client state. Header checkbox may select/deselect all rows on the **current page**.
2. **Delete.** Next to Refresh: button `Delete` (`id="btn-errorlog-delete"`). Enabled iff selected count > 0. Click opens an existing-pattern `modal-overlay` confirm (count in the copy). Confirm sends a mutating HTTP request with the selected ids. Server removes matching `====` blocks from vault `error.logs` (same 2 MiB tail window as list). Cancel closes the modal with no write. After success, clear selection, refresh the table, close the modal.
3. **New Issue.** Next to Refresh: button `New Issue` (`id="btn-errorlog-new-issue"`). Enabled iff selected count > 0. Click opens a modal with a **textarea** whose value is a concatenated, operator-readable draft of the selected entries (newest-first as listed). The operator copies the text into GitHub. This spec does **not** call `gh`, GitHub REST, or open `github.com/new`.

Auth matches other `/api/error-logs` routes. Payloads pass `sanitizeToolOutput`. `TOOL_NAMES.length` stays 11. Canvas `:3125` unchanged. Do not add checkboxes to other tabs.

Language: en-us.

## Acceptance Criteria

### Selection UI

- AC1: `errorlog-table` thead includes a leading checkbox column (`id="errorlog-select-all"`) and each data row includes `input[type=checkbox].errorlog-row-select` with `data-id` equal to the list item `id`.
- AC2: Empty and loading rows use `colspan` that includes the new column (5 cells, not 4).
- AC3: `btn-errorlog-delete` and `btn-errorlog-new-issue` sit in the filter bar immediately after `btn-errorlog-refresh` (Refresh stays enabled independently of selection).
- AC4: Both action buttons are `disabled` when selected count is 0 (initial load, after successful delete, after Refresh that rebuilds the tbody).
- AC5: Checking one or more row checkboxes sets selected count > 0 and enables both action buttons without a page reload.
- AC6: `errorlog-select-all` checks or unchecks every `.errorlog-row-select` on the current page and updates action-button disabled state.
- AC7: Changing page (Prev/Next) or clicking Refresh clears the selection set and disables the action buttons.
- AC8: Clicking a row checkbox does not open the detail pane; clicking the rest of the row still loads detail as 0058 AC19.

### Delete confirm and API

- AC9: Delete click with selection > 0 opens modal `id="modal-errorlog-delete"` (`modal-overlay` + `modal-card`); copy includes the integer selected count; Cancel (`id="btn-errorlog-delete-cancel"`) closes it and writes nothing.
- AC10: Confirm (`id="btn-errorlog-delete-confirm"`) sends `POST /api/error-logs/delete` with JSON `{ "ids": string[] }` (same ids as selected checkboxes); `Content-Type: application/json`.
- AC11: `POST /api/error-logs/delete` requires the same authorization as `GET /api/error-logs`; unauthenticated yields 401 and does not modify `error.logs`.
- AC12: Request body is validated (Zod or equivalent): `ids` is a non-empty array of strings matching `elog-(?:[0-9a-f]{12}|\\d+)`, length 1..200, unique; invalid body yields 400 and no file write.
- AC13: Matching blocks are removed from the on-disk `error.logs` file (rewrite remaining blocks in original chronological file order); unmatched ids are ignored; response JSON is `{ ok: true, deleted: number, missing: number }` with `deleted + missing === ids.length`.
- AC14: Missing `error.logs` file yields HTTP 200 `{ ok: true, deleted: 0, missing: ids.length }` (not 500).
- AC15: Rewrite uses atomic write (temp + rename or existing vault JSON atomic helper) under `withVaultLock` (or equivalent exclusive lock) so concurrent appends from `logErrorReport` do not truncate the file.
- AC16: List/detail payloads and the delete response pass `sanitizeToolOutput`; absolute vault paths never appear in JSON.
- AC17: After HTTP 200 from delete, the UI closes the modal, clears checkboxes, reloads the current list query, and shows no uncaught exception.
- AC18: Delete HTTP 400/401/500 shows an inline error on the Error logs page (`errorlog-error` or the modal error line) and leaves `error.logs` unchanged on 400/401; 401 does not dump log bodies.

### New Issue draft

- AC19: New Issue click with selection > 0 opens modal `id="modal-errorlog-issue"` containing `<textarea id="errorlog-issue-text" readonly>` (or editable; either is pass) filled with the concatenated draft.
- AC20: Draft includes, for each selected id in current-table order, timestamp, level, subsystem, error text, and optional endpoint/tool/projectId from list and/or detail; entries separated by a blank line and a `----` (or `====`) divider.
- AC21: Draft is built from already-loaded list rows plus `GET /api/error-logs/{id}` for stack/context when needed; if a detail fetch fails, that entry still appears with list fields and a one-line `(detail unavailable)` note.
- AC22: Textarea value is set via `.value` / `textContent` assignment (no `innerHTML` of raw log text).
- AC23: Modal includes a Close control; optional Copy button may call `navigator.clipboard.writeText` and must fail open (show helper text if clipboard is denied).
- AC24: New Issue does not `fetch` GitHub, does not invoke `gh`, and does not navigate the browser to github.com.

### Cross-cutting

- AC25: `TOOL_NAMES.length` remains 11; no MCP tool for error-log delete.
- AC26: `GET /api/error-logs` list/detail behavior from 0058 remains (pagination, filters, silent missing file).
- AC27: Status HTML tests assert `btn-errorlog-delete`, `btn-errorlog-new-issue`, `errorlog-select-all`, and `modal-errorlog-delete` exist; API tests cover 401, 400, delete removes listed ids, unknown ids increment `missing`.
- AC28: `npm run build` and `npm test` stay green.
- AC29: README / `ws-memo` mention Error logs Delete and New Issue as operator UI (copy draft; not auto-filed issues).

## Original Issue Context

Standalone `/ws-spec-write` (not a GitHub issue). User request:

> add two more options in UI Status Monitor: in the Error Logs view, add checkboxes to select rows in grid/list of logs. add near Refresh button more two buttons: Delete which will delete selected log entries/rows with user confirmation modal dialog, and also a button "New Issue" with will concatenate all selected entries into a textarea to allow user to copy in create an github issue based on selected entries. Buttons enabled When selected rows > 0

### Prior Work Sweep

- Keyword / git: Error logs viewer landed in `b163813` (0058, PR #64 merged). Follow-ups: stable ids `b63309d` / `91598a3` (`elog-` sha1), detail caps. No delete or issue-draft UI.
- Open PR #65 is IO_GUARD, not this slice. No open PR titled error-log delete / New Issue.
- `errorLogStableId` is the correct delete key (not volatile positional `elog-N` except legacy GET).

### Design Intent

- **0058 Error logs** were intentionally **read-only** (list + detail). Absence of delete is a product gap the user is now requesting, not an accidental regression.
- **Silent probe / test-noise** issues (#67/#68, spec 0060) reduce new junk; this spec is the operator cleanup path for rows already on disk.
- **New Issue** is copy-assist only: filing on GitHub stays a human action (no OAuth, no `gh` from the status process).

## Notes

- Files: `src/status.ts` (HTML/CSS/JS), `src/error-logger.ts` (delete helper), `src/status.test.ts`, `src/error-logger.test.ts`, README / `ws-memo` as needed.
- Reuse `.modal-overlay` CSS and vault-action confirm patterns; do not add a CDN.
- Prefer `POST /api/error-logs/delete` over `DELETE` with a body (some stacks drop DELETE bodies). Query-string ids are forbidden (length + logging).
- Delete rewrites the **full file** after applying removals on the parsed tail **plus** any unread prefix bytes when `truncated: true`: must not drop the unread older prefix. Implementation: if the file exceeds the 2 MiB tail cap, only rewrite the scanned tail after removing matches in that window **and prepend the untouched prefix bytes** (byte offset from `readErrorLogTail`). Document this in the implementer plan; tests must cover a file larger than the cap with a delete in the tail.
- TypeScript-Node: validate POST body; no unchecked `any`; await lock/write promises.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-create GitHub issues via API/`gh` | User asked for a copyable textarea only |
| Delete-all / wipe entire `error.logs` without selection | Requires selected count > 0 |
| Checkboxes on Activity, AI Ops, or other tables | This slice is Error logs only |
| New MCP tool | 11-tool freeze |
| Editing or redacting a single field in-place | Delete is whole-block removal |
| Closing GitHub #66/#67/#68 | Owned by spec 0060 |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Selection scope | Current page only; cleared on Refresh/page change | Simplest; user did not ask for cross-page cart | y |
| New Issue destination | In-app textarea, human copies to GitHub | Explicit user wording | y |
| Delete HTTP verb | POST JSON `{ ids }` | Avoid DELETE body / query secrets-in-URL | y |
| i18n, tenancy, migrations, frontend locale packs | N/A because status HTML is en-us inline; vault file is not a SQL store | Implicit dimensions absent | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Error logs tab + delete API + issue modal | Diff stays in status + error-logger + tests/docs |
| Atomic ACs | AC1–AC29 pass/fail | Tests + HTML id grep |
| Auth | Same bearer/cookie as GET error-logs | 401 fixture |
| Concurrency | Lock around rewrite; preserve file prefix when truncated | Unit test + review `withVaultLock` |
| Input validation | ids schema 1..200 | 400 tests |
| Failure modes | Confirm cancel; clipboard deny; missing ids | Negative scenarios |
| Stack | No `any`; no innerHTML of logs | Review + tsc |
| Open blockers | None | 0058 viewer and stable ids already shipped |

## Validation & Observation Notes

### Telemetry & Observable Signals

- HTML contains `btn-errorlog-delete`, `btn-errorlog-new-issue`, `modal-errorlog-delete`, `errorlog-issue-text`
- `POST /api/error-logs/delete` 200 `{ deleted, missing }`
- `error.logs` byte size / block count before vs after
- Unauthenticated POST 401
- `TOOL_NAMES.length === 11`

### Negative & Failing Test Scenarios

- Delete with empty `ids` or zero selection must not call the API from the UI (buttons disabled); API empty array yields 400.
- Unknown id: `deleted: 0`, `missing: 1`, file unchanged for that id.
- Confirm cancel: file mtime/size unchanged.
- Unauthenticated delete: 401, file unchanged.
- New Issue must not contain a `github.com/api` or `api.github.com` fetch in `src/status.ts`.
- Setting textarea via `innerHTML` of raw error text is a fail (XSS / 0058 AC19).
- Unchecked `any` on the delete handler is a TypeScript-Node stack fail.
