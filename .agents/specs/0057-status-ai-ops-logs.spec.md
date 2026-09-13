---
id: null
slug: status-ai-ops-logs
title: "Status monitor AI ops log UI and durable analysis journal"
source: local
specDate: 2026-09-13
---

# Specification — Status monitor AI ops log UI and durable analysis journal

## Description

Spec `0056-vault-ai-assistance` adds optional Cursor SDK refine and rank behind `upsert` / `search` / `bootstrap`. Activity bus events `ai.refine.*` / `ai.rank.*` carry `recordId` and `durationMs` only. They do not persist operation input, output, or metadata. `error.logs` records subsystem failures (including status HTTP) but has no `ai` subsystem and no operator UI to inspect AI calls.

Operators need a **read-only status monitor surface** to inspect AI operations (refine, rank, and later adapter calls): timestamp, operation, ok/fail, duration, redacted input/output, and metadata. Failures from the AI layer and from status-monitor reads of that journal must be written to the existing vault `error.logs` (outside product git) so agents can analyze them later.

This spec adds:

1. **Durable AI ops journal** under the vault root (`$SPEC_MEMO_ROOT/ai-ops/`, never in product git). Append-only JSONL with rolling parts, same fail-open pattern as telemetry (`0028`).
2. **Capture at the `VaultAiAgent` boundary:** one journal row per refine or rank attempt (success and failure), after secret redaction and size caps. Activity bus stays as 0056 (no prompt bodies on SSE).
3. **Status REST** (companion `:3124`, same auth as other `/api/*` routes): list + get one entry. Payloads go through `sanitizeToolOutput` (no absolute vault `path`).
4. **Status UI tab "AI Ops"** listing entries with filters and a detail pane (operation, metadata, truncated input/output).
5. **Error path:** AI journal write failure, adapter throw already logged via 0056 doctor `ai.lastError`, plus `logErrorReport` with new subsystem `'ai'`. Status GET failures for these endpoints use existing `status-server` error logging.

Language: en-us. No 12th MCP tool. Markdown records stay SoT. Journal is diagnostic, not a vault `kind: log` record in FTS.

## Acceptance Criteria

### Journal schema and storage

- AC1: Vault layout includes directory `ai-ops/` under `getVaultRoot()`; files follow `ai-ops-YYYY-MM-DD.part-{N}.jsonl` (UTC date, `N` starting at 1); product git must not contain this directory.
- AC2: Each journal line is one JSON object with required fields `id` (string, unique), `timestamp` (ISO 8601 UTC), `operation` (`refine` | `rank`), `ok` (boolean), `durationMs` (number); optional `recordId`, `projectId`, `provider`, `model`, `error` (string), `input` (object), `output` (object), `metadata` (object).
- AC3: `input` and `output` are redacted via existing `redactSecretsInPayload` / `sanitizeLogContext` before write; UTF-8 length of serialized `input` plus `output` must not exceed `config.ai.opsLogMaxBytes` (default 8192); overflow truncates string fields and sets `metadata.truncated: true`.
- AC4: When `ai.opsLogEnabled` is omitted, journal writes occur if and only if `ai.enabled` is true (Noop / disabled AI writes zero rows); explicit `ai.opsLogEnabled: false` writes zero journal rows even if AI runs.
- AC5: Journal I/O failures never reject MCP/CLI/HTTP tool results (fail-open); the write path uses handled async (`void flush.catch` or queue with `.catch`); floating promises are forbidden.
- AC6: Rotation uses `config.ai.opsLogMaxFileSizeMb` default 10; day change starts `part-1` without process restart.

### Capture at the agent boundary

- AC7: After each `refineForSearch` settlement (ok or fail), the runtime appends one journal row with `operation: "refine"`, `recordId`, redacted title/kind/tags in `input` (not full unredacted body beyond the byte cap), and `output.searchTerms` / `output.summary` / `error` as applicable.
- AC8: After each `rankCandidates` settlement, one row with `operation: "rank"`, `input.query` (redacted, length-capped), `input.candidateIds` (array of ids only, not snippets unless they fit remaining budget), `output.orderedIds`, `ok`.
- AC9: `NoopVaultAiAgent` writes **no** journal rows (zero LLM work, zero disk).
- AC10: Activity bus events remain as 0056 (`ai.refine.ok` / `fail` / `ai.rank.ok` / `fail`) without prompt bodies; journal is the only place for I/O payloads.
- AC11: API keys, `CURSOR_API_KEY` values, and `config.ai` secrets never appear in journal JSON, UI, or `error.logs`.

### Status REST

- AC12: `GET /api/ai-ops` on the status companion returns JSON `{ items: AiOpsListItem[], total: number }` with query params `limit` (default 50, max 200), `offset` (default 0), optional `operation` (`refine`|`rank`), optional `ok` (`true`|`false`), optional `projectId`; Zod or equivalent validation; invalid query yields HTTP 400.
- AC13: `AiOpsListItem` includes `id`, `timestamp`, `operation`, `ok`, `durationMs`, `recordId`, `projectId`, `error` (truncated to 200 chars); it does **not** include full `input`/`output`.
- AC14: `GET /api/ai-ops/{id}` returns one sanitized journal object including truncated `input`/`output`/`metadata`; unknown id yields HTTP 404.
- AC15: Both routes require the same authorization as `/api/status` (header, query, or cookie; any valid candidate). Unauthenticated requests yield 401 and do not list journal ids.
- AC16: List/detail handlers never return raw filesystem paths; `sanitizeToolOutput` (or equivalent) runs before `writeJson`.
- AC17: `TOOL_NAMES.length` remains 11; no MCP tool is added for AI ops.

### Status UI

- AC18: Status HTML includes a tab button `AI Ops` (`data-tab="tab-ai-ops"`) adjacent to existing tabs; default landing tab stays Activity & Status.
- AC19: Tab body shows a filter row (operation, ok/fail, project when a project is selected) and a table of list items (time, operation, ok, duration, record id, error snippet).
- AC20: Clicking a row loads `GET /api/ai-ops/{id}` into a detail pane with metadata plus input/output as collapsible `<pre>` text (escaped HTML; no `innerHTML` of untrusted JSON as HTML).
- AC21: Empty journal renders a non-error empty state string, not a thrown UI exception.
- AC22: Fetch failure (network/401/500) shows an inline error on the tab and does not break other tabs; the failed request is eligible for `logErrorReport` on the server when the handler throws.

### Error.logs for analysis

- AC23: `ErrorLogSubsystem` includes `'ai'`.
- AC24: Adapter/journal failures call `logErrorReport` with `subsystem: 'ai'`, redacted `context` (operation, recordId, durationMs, error message), never raw prompt bodies larger than the journal cap.
- AC25: Status AI-ops handler exceptions call `logErrorReport` with `subsystem: 'status-server'` and `endpoint` `/api/ai-ops` (existing status pattern).
- AC26: `error.logs` remains under vault root (or `SPEC_MEMO_ERROR_LOG`); it is not committed to product git; UI does not render the entire `error.logs` file in this slice (operators/agents read the file for analysis; optional later spec).

### Tests and docs

- AC27: Tests cover journal append + redact + truncate, Noop writes zero rows, REST 401/400/404, list pagination, sanitize of path-like fields, and HTML containing `tab-ai-ops`; live Cursor network tests are not required.
- AC28: `npm run build` and `npm test` stay green.
- AC29: `README.md` and `ws-memo` document the AI Ops tab, `GET /api/ai-ops`, vault path `ai-ops/`, and that payloads are redacted/truncated.

## Original Issue Context

Standalone `/ws-spec-write` after spec 0056: implement UI to visualize AI logs (logs, operations, input/output, metadata) logged into the UI; writing and monitor errors write to log for later analysis.

### Prior Work Sweep

- `0056-vault-ai-assistance.spec.md`: activity events without prompt bodies; doctor `ai.lastError`; no UI tab.
- `0028-operational-telemetry.spec.md`: rolling JSONL under vault, fail-open, sanitize; reuse pattern, do not overload telemetry category with full LLM I/O.
- `0023-mcp-status-monitor.spec.md` / `src/status.ts`: tabs, `/api/events`, auth, `sanitizeToolOutput`.
- `src/error-logger.ts`: structured `error.logs`; subsystems lack `'ai'`.
- Git: `error.logs` redaction commits `8ef5061`, `ead01a8`, `6ffa275`. No `ai-ops` path in `src/` today. Duplicate risk: low vs Activity live log (in-memory, no I/O persist). `providers.scm=github`; no tracker id. No exact open PR for this slug.

### Design Intent

Greenfield UI + journal beside 0056 adapters. Skip `git log -L` on missing `ai-ops` symbol. Preserve: 11 MCP tools, status auth, secret redaction, fail-open on diagnostic I/O, vault-not-product-git.

## Notes

**Recommended vault config extras (under existing `ai` object):**

```json
{
  "ai": {
    "opsLogEnabled": true,
    "opsLogMaxBytes": 8192,
    "opsLogMaxFileSizeMb": 10
  }
}
```

`opsLogEnabled` effective default: `true` only when `ai.enabled` is true.

**List vs detail:** keep list payloads small so the tab stays usable on large journals.

**Concurrency:** single writer queue (same spirit as refine `maxConcurrent`) to avoid interleaved JSONL lines.

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool | Surface stays 11; status REST only |
| Rendering full `error.logs` in the UI | File is for later agent/operator analysis; this slice is AI ops journal + tab |
| Enabling/disabling AI from the UI | Deferred in 0056 context; `config.json` remains SoT |
| Storing unredacted full LLM transcripts | Secret and size risk |
| FTS indexing of journal lines as vault records | Diagnostic stream, not `kind: log` memory |
| Changing 0056 refine/rank semantics | This spec observes the agent boundary |
| Canvas `:3125` AI log view | Status companion only |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| UI placement | New status tab `AI Ops` | Activity tab is live SSE without durable I/O | n (recommended; see companion) |
| Durable store | Vault `ai-ops/*.jsonl`, not `error.logs` for successes | `error.logs` stays failure-oriented; ops include ok rows | n (recommended) |
| I/O fidelity | Redacted + 8 KB cap | Analysis without secret dump | n (recommended) |
| MCP | No new tool | Matches 0056 | y |
| Implicit dims not otherwise ACd | N/A because bounds (limit/offset/max bytes/file size), failure (fail-open journal, 401/400/404), idempotency (append-only unique `id`), auth (status token), concurrency (single writer), lifecycle (vault not git), observability (error.logs + tab), external fail-open are ACs; rate limits on GET are not specified | Collapse remainder | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Journal + status REST + AI Ops tab + `ai` error.logs; no MCP tool; no full error.logs UI | ACs vs diff |
| Atomic criteria | Each AC pass/fail in tests or HTTP status | AC27 named coverage |
| Failure modes | Journal I/O fail-open, 401, 400, 404, XSS via escaped pre | Negative scenarios |
| Stack invariants | No unchecked `any`; no floating promises; Zod on query; path containment for `ai-ops/` under vaultRoot; close streams on shutdown | `typescript-node`; `npm run build` |
| Secrets | Redaction before journal and logs | AC3, AC11, AC24 |
| Observation | Tab + REST + error.logs `subsystem: ai` | AC12–AC26 |
| Open blockers | N/A because 0056 may land first; this spec can stub a writer used by tests until 0056 merges, then wire the agent boundary | Documented |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Files appear under `$SPEC_MEMO_ROOT/ai-ops/ai-ops-YYYY-MM-DD.part-1.jsonl` after a fake-agent refine in tests
- `GET /api/ai-ops` returns `total` matching row count
- `error.logs` contains `[ai]` blocks after a forced adapter failure
- Status UI source contains `data-tab="tab-ai-ops"`
- `npm test` and `npm run build`

### Negative & Failing Test Scenarios

- Unauthenticated `GET /api/ai-ops` returns 401 and empty body without journal ids
- `limit=9999` rejected (400)
- Unknown `GET /api/ai-ops/missing` returns 404
- Journal write throws: MCP upsert still succeeds; `logErrorReport` subsystem `ai`
- Secret string in refine body does not appear in journal file or REST detail
- `innerHTML` assignment of raw JSON in the detail pane must fail the test (must escape or textContent)
- Path-like vault absolute path in metadata is sanitized in REST JSON
- Noop agent: `ai-ops/` missing or empty after upsert
- Sync-over-async: journal flush error must not reject the refine caller Promise
