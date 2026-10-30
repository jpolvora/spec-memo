---
id: null
slug: memory-hit-count
title: "Memory retrieval hit count and status-monitor list"
source: local
specDate: 2026-09-02
---

# Specification — Memory retrieval hit count and status-monitor list

## Description

When agents implement tasks they consult the vault (`bootstrap`, `search`, `get`) to find traps and other durable memory. Today a returned record has no signal that it was **retrieved as useful**. The existing `occurrences` field means a later upsert matched the same trap situation (recurrence-on-write). Operators cannot tell whether a stored entry is actually helping later sessions.

This slice adds a retrieval **hit** counter: increment when a durable memory entry is selected into a bootstrap brief, successfully loaded via `get`, or explicitly acknowledged from a search result list. The counter is visible wherever operators browse memory: the status-monitor Memory **list** (Hits column on every row), the Memory **details drawer**, and the canvas **node detail panel**.

Architecture touchpoints:

- **Schema (`src/schema.ts`, `src/types.ts`)**: optional `hits` (integer >= 0) and `lastHit` (ISO timestamp) on record frontmatter. Missing `hits` ranks as 0. Do not reuse `occurrences` / `lastSeen`.
- **Hit recorder (`src/store.ts` or a focused helper)**: `recordMemoryHits({ ids, sessionId, source })` bumps eligible records, de-dupes by session, persists markdown, indexes, fail-open. Recurrence upserts continue to bump only `occurrences`.
- **Consult tools (`src/bootstrap.ts`, `src/indexer.ts`, get handler, `src/tools.ts`)**: bootstrap increments for records actually included in the returned brief; `get` increments on successful load of hit-eligible kinds; `search` stays read-only unless `hitIds` is provided. Optional `sessionId` on those three tools. `search.sort` gains `hits`.
- **Status monitor (`src/status.ts`)**: new read-only Memory tab listing vault records with `hits` / `occurrences` / `lastHit`. `GET /api/records` feeds the table. Each list row shows Hits; opening a row opens a details drawer that also shows Hits and Last hit in the metadata card (same drawer pattern as Prompts). Listing never increments.
- **Canvas (`src/canvas.ts`)**: graph nodes include `hits`; the existing detail drawer shows Hits (and Occurrences when present) in the meta panel when a node is selected. `GET /api/record/...` responses expose `hits` / `lastHit` in frontmatter.
- **Compiled views (`src/compiler.ts`)**: trap headings include `hits` beside `occurrences`.
- **Docs (`PRODUCT.PRD`, `FEATURES.md`, `ws-memo`)**: document the hit contract; no 12th MCP tool.

Greenfield additive slice beside shipped trap-recurrence. Design notes: [`memory-hit-count.context.md`](memory-hit-count.context.md).

Hit-eligible kinds: `trap`, `decision`, `spec`, `plan`.

## Acceptance Criteria

- AC1: Record frontmatter accepts optional `hits` as an integer greater than or equal to 0.
- AC2: Schema validation fails when `hits` is present and is not an integer greater than or equal to 0.
- AC3: Record frontmatter accepts optional `lastHit` as an ISO-8601 timestamp.
- AC4: New records omit `hits` and `lastHit` until the first recorded hit (do not serialize those keys as YAML `undefined`).
- AC5: Search, get, and list payloads treat a missing `hits` field as 0 without rewriting the file.
- AC6: Recording a hit on an eligible record increments `hits` by 1 and sets `lastHit` to the current timestamp without changing `occurrences` or `lastSeen`.
- AC7: A trap-dedup recurrence bump increments `occurrences` and `lastSeen` without changing `hits` or `lastHit`.
- AC8: Same-id or same-slug `upsert` edits do not increment `hits`.
- AC9: Hit recording is limited to kinds `trap`, `decision`, `spec`, and `plan`; `get` of `scratch`, `log`, `review`, `state`, `prompt`, or `session` does not increment.
- AC10: Successful `bootstrap` increments `hits` once for each hit-eligible record that is present in the returned brief payload.
- AC11: Records dropped from the bootstrap brief by the token budget do not receive a hit.
- AC12: Successful `get` of a hit-eligible record increments `hits` once for that record.
- AC13: Failed `get` (missing id / kind+slug) does not increment any record and still returns the existing not-found error.
- AC14: `search` without `hitIds` does not increment `hits` on any returned row, including when `sort` is `occurrences` or `hits`.
- AC15: `search` accepts optional `hitIds` as an array of record ids; after returning results, it increments `hits` only for ids that both appear in `hitIds` and exist as hit-eligible records.
- AC16: Unknown ids in `hitIds` are ignored and do not fail the search.
- AC17: `search` ids present in the result set but omitted from `hitIds` are not incremented.
- AC18: CLI `memo search` accepts `--hit-ids <id>[,<id>...]` mapped to `hitIds`.
- AC19: `bootstrap`, `search`, and `get` accept optional `sessionId`; when it is a non-empty string, the same record increments at most once per `sessionId`.
- AC20: When `sessionId` is omitted, each qualifying bootstrap inclusion or `get` increments (CLI one-shot behavior).
- AC21: A second `get` of the same record in the same `sessionId` after a bootstrap inclusion of that record does not increment again.
- AC22: Hit persistence failures are fail-open: the originating `bootstrap`, `search`, or `get` still returns success, and the error is logged with subsystem `memory-hits`.
- AC23: Hit writes persist `hits` and `lastHit` on the markdown record (markdown remains source of truth) and update the FTS row; they follow the existing vault-git atomic vs batched policy and do not invent a new git flush trigger.
- AC24: `search` accepts `sort` value `hits` in addition to `relevance`, `occurrences`, and `updated`.
- AC25: When `sort` is `hits`, results are ordered by `hits` descending, then `lastHit` descending, then `updated` descending; missing `hits` ranks as 0.
- AC26: Invalid `sort` values still fail argument validation with an error, not a silent fallback.
- AC27: Search hit objects include `hits` and `lastHit` (omitted or null when unset) alongside existing `occurrences` / `lastSeen`.
- AC28: Status monitor `GET /api/records` returns 200 JSON `{ records: MemoryRecordListItem[] }` where each item includes `id`, `projectId`, `kind`, `status`, `title`, `hits`, `occurrences`, `lastHit`, `lastSeen`, and `updated`.
- AC29: `GET /api/records` accepts query `project`, `kind`, `sort` (`hits` default, `occurrences`, `updated`), and `limit`, and does not increment `hits`.
- AC30: Status monitor HTML includes a Memory tab that renders the `/api/records` table with columns Kind, Title, Hits, Occurrences, Last hit, and Updated, default-sorted by Hits descending; each row's Hits cell shows the numeric hit count (0 when missing).
- AC31: Clicking a Memory table row opens a details drawer (or equivalent side panel) that shows at least title, kind, status, Hits, Occurrences, Last hit, Updated, and the record body/snippet; the Hits value matches the list row.
- AC32: Status Memory tab listing, details drawer reads, and `GET /api/records` remain read-only: they never create, update, archive, or delete vault records and never increment `hits`.
- AC33: When a status auth token is configured, unauthorized `GET /api/records` returns 401 JSON, matching other `/api/*` routes.
- AC34: Compiled `TRAPS.md` active headings include `hits` in addition to existing `layer` and `occurrences`.
- AC35: Canvas `GET /api/project/:projectId/graph` node objects include `hits` (0 when missing) without changing graph layout rules.
- AC36: Canvas detail drawer (node selection) displays the selected record's Hits value in the meta panel (0 when missing).
- AC37: Canvas `GET /api/record/:projectId/:kind/:id` (or equivalent record detail API) returns frontmatter that includes `hits` and `lastHit` when present (and treats missing `hits` as displayable 0 in the UI).
- AC38: This slice does not add a 12th MCP tool; hit recording is implemented by extending `bootstrap`, `search`, and `get`.
- AC39: Packaged `ws-memo` documents that bare `search` does not count as a hit, that bootstrap/`get` auto-count, and that agents pass `hitIds` plus `sessionId` for search rows they actually used.

## Original Issue Context

Free-text request (2026-09-02): create a spec to find and analyze the better way to register and show when a trap got a hit (give options to interview, choose the best).

"Got a hit" means: when implementing tasks/specs/plans, agents query memory to find traps/gaps in project history. When something in memory is found, increment a hit on that searched memory entry so we know how useful the entry was. Visualize the hit count in the UI list of memory entries.

### Prior Work Sweep

Keyword + `git log` on `src/store.ts`, `src/indexer.ts`, `src/bootstrap.ts`, `src/schema.ts`, `src/status.ts`, `src/compiler.ts`, and specs `trap-recurrence`, `fts-index`, `bootstrap-brief`, `mcp-status-monitor`, `prompt-history-and-query`. No open PR for this local slug (`id: null`). `gh` not required for local source.

| Hit | Relation | Action |
|-----|----------|--------|
| [`trap-recurrence.spec.md`](trap-recurrence.spec.md) / `69a85b4` | `occurrences` + `lastSeen` already mean upsert/dedup recurrence; `search.sort=occurrences` + `memo rank` | Keep that meaning; add orthogonal `hits` |
| [`trap-dedup.spec.md`](trap-dedup.spec.md) / `src/store.ts` | Dedup match bumps `occurrences` in place | Hit recorder must not share that bump path |
| [`bootstrap-brief.spec.md`](bootstrap-brief.spec.md) | Brief ranks by severity + path, not recurrence | Increment only records that survive the budget |
| [`fts-index.spec.md`](fts-index.spec.md) / `src/indexer.ts` | `search` is read-only FTS | Keep default search read-only; optional `hitIds` is the write-back |
| [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) AC7 | Status routes are read-only | Memory tab lists hits; listing must not increment |
| [`prompt-history-and-query.spec.md`](prompt-history-and-query.spec.md) | Prompts tab table pattern on `:3124` | Reuse table CSS/pattern for Memory tab; do not mix prompts with traps |
| Vault traps `occurrences-search-full-scan`, `occurrences-search-candidate-cap` | Occurrences sort must full-scan like `memo rank` | `sort=hits` must use the same full-scan universe, not a recency FTS cap |
| PRODUCT.PRD §6 / AGENTS.md 11-tool surface | Frozen MCP tool count (prompt is the 11th) | No 12th tool named `hit` |

Related hits recorded; no exact same-issue open PR. Continue.

### Design Intent

`occurrences` / `lastSeen` were an intentional recurrence-on-upsert design (`trap-recurrence` AC9–AC13), not an accidental gap in retrieval analytics. Restoring or overloading that field as a search-hit counter would break `memo rank` and owner-skill export. Retrieval usefulness is a new counter.

## Notes

- Chosen interview defaults are in [`memory-hit-count.context.md`](memory-hit-count.context.md): separate `hits` field; increment on bootstrap inclusion, `get`, and optional `search.hitIds`; session de-dupe; status Memory list + details drawer; canvas detail meta.
- "Found" in the user request is implemented as consult-grade events, not every FTS row. Bare search remains the discovery query.
- `ws-self-learning` consults already call `bootstrap` / `search`; after this slice, `search` usefulness requires `hitIds` (or a follow-up `get`). Skill text must say so or counts stay at bootstrap/`get` only.
- Remote/hybrid: the daemon that executes the tool writes the hit (same as other vault mutations). Stdio proxy does not keep a second counter.
- Status Memory tab may reuse `#prompts-table` / prompt-drawer CSS (`data-table`, master-row, drawer). Do not add an npm frontend. Hit count must appear in both the list and the opened details panel (never list-only).

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool `hit` | PRD tool surface stays at 11; extend bootstrap/search/get |
| Auto-increment every search result | Inflates exploratory queries and `memo rank`; usefulness would be meaningless |
| Reusing `occurrences` as the retrieval counter | Recurrence ranking and skill export already depend on upsert semantics |
| SQLite-only hit table | Markdown is source of truth; FTS rebuild would drop counts |
| Per-hit `log` records | Extra kind, GC, and FTS noise for a badge |
| Time-decay / half-life ranking | Raw `hits` + `lastHit` is enough for v1 |
| Canvas node radius scaled by hits | Graph JSON includes the field; visual scaling is a later tweak |
| Counting `prompt` / `session` / `log` / `scratch` | Those surfaces already have Prompts/Activity tabs or TTL |
| Status-monitor mutating vault records | Existing read-only invariant (mcp-status-monitor AC7) |
| Changing bootstrap severity/path ranking to prefer high-hit traps | Hit count is an on-demand sort and UI column, not a brief formula change |
| Rewriting consumer `ws-self-learning` hub templates | Packaged `ws-memo` is the runtime contract |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Counter field | New `hits` + `lastHit`; keep `occurrences` / `lastSeen` as recurrence | Two different questions; see context.md option A | n |
| Increment trigger | Bootstrap inclusion + successful eligible `get` + optional `search.hitIds` | Consult-grade usefulness without FTS inflation | n |
| Eligible kinds | `trap`, `decision`, `spec`, `plan` | Durable memory consulted during tasks | n |
| De-dupe | At most one increment per (`sessionId`, record id) when `sessionId` is set | Bootstrap then get in one session is one useful retrieval | n |
| UI | Status Memory list + details drawer show Hits; canvas detail meta shows Hits; `/api/records` + record detail API expose fields | Operators must see hit count when browsing and when inspecting one entry | y |
| MCP surface | No 12th tool; `search.hitIds` + optional `sessionId` | Matches trap-recurrence "sort + CLI, no extra tool" | n |
| Implicit dimensions (auth, rate limits, TTL class, external deps) | N/A because hits ride existing local vault writes, status bearer auth, and record lifetime (archive/purge with the record) | No new network, tenant, or retention class | n |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Hits counter, consult-tool increments, Memory list + details drawer + canvas detail Hits; no 12th tool, no occurrences overload | This spec Out of Scope table plus context.md Feature Boundary |
| Atomic criteria | ACs 1–36 are individually pass/fail with named files and commands | `validate_spec.cjs --mode=authoring` on this file |
| Failure modes | Fail-open hit I/O, invalid sort, unknown hitIds, failed get, status 401 | Negative scenarios below plus targeted tests |
| Observation telemetry | Named npm test files, `/api/records`, `search.sort=hits`, error.logs subsystem `memory-hits` | Validation Notes |
| Open blockers | None; `occurrences` semantics already shipped and documented | Prior Work Sweep |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/store.test.js dist/trap-recurrence.test.js` still pass (recurrence `occurrences` unchanged).
- New suite (for example `node --test dist/memory-hit.test.js`): bootstrap inclusion bumps `hits`; bare search does not; `hitIds` does; session de-dupe holds; recurrence bump does not touch `hits`.
- `node --test dist/status.test.js`: `GET /api/records` read-only; Memory tab table has Hits column; details drawer markup includes Hits; 401 with token.
- Canvas HTML/API tests: graph nodes include `hits`; detail drawer/meta shows Hits; record detail API returns `hits`/`lastHit`.
- `memo search --json` / MCP search payload includes `hits` and `lastHit`.
- Fail-open: injected write error still returns search/get/bootstrap success and writes `subsystem: memory-hits` in vault error logs.
- Compiled `TRAPS.md` heading contains `Hits` (or `hits`) after a recorded hit.

### Negative & Failing Test Scenarios

- Bare `search` of a trap with `hits` omitted leaves frontmatter without `hits` (no silent +1).
- `search.sort=hits` over an FTS recency pre-cap must not hide a stale high-hit record (same class as trap `occurrences-search-full-scan`).
- `hits: -1` on upsert fails schema validation.
- `get` of a missing id returns not-found and increments nothing.
- Status `GET /api/records` called 10 times does not change `hits`.
- Recurrence upsert (`allowDuplicate` false, overlap >= 0.7) increments `occurrences` only.
