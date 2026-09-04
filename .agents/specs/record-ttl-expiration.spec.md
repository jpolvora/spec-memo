---
id: null
slug: record-ttl-expiration
title: "Universal Record Time-To-Live and Expiration Engine"
source: local
specDate: 2026-09-04
---

# Specification — Universal Record Time-To-Live and Expiration Engine

## Description

Extend the Time-To-Live (TTL) and expiration mechanism across all vault record kinds (`trap`, `decision`, `review`, `scratch`, `plan`, `state`). Allow any memory record to specify an explicit expiration timestamp (`expires_at`) or a duration string (`ttl`). Automatically filter out expired records from standard `search` queries and `bootstrap` session briefs, and empower `memo gc` to archive or purge expired records vault-wide, preventing stale temporary workarounds and ephemeral notes from permanently consuming token budgets.

### Problem Analysis & Real-World Evidence

1. **Stale Trap Permanence:**
   - In `src/curator.ts`, `isRecordExpired()` is currently invoked only for records located in the `scratch/` (7 days) and `reviews/` (14 days) directories.
   - Traps and decisions currently never expire. Temporary rules (e.g. *"Temporarily bypass linter error on React 19 canary build until upstream patch"*) persist indefinitely in the vault.
2. **Bootstrap Budget Pollution:**
   - Because `bootstrap` compiles a token-budgeted brief capped at 8 KB (`maxBytes`), obsolete temporary traps continually crowd out vital, evergreen domain traps.
3. **Missing Retrieval Filtering:**
   - Neither SQLite FTS5 search (`src/indexer.ts`) nor brief compilation (`src/bootstrap.ts`) checks whether a record has surpassed its expiration timestamp, returning expired records as valid candidates.

### Design Intent

Promote `expires_at` and `ttl` to first-class frontmatter fields across all record kinds. Automatically omit expired records from standard search and brief injection while providing an opt-in flag (`includeExpired: true`) for historical queries. Integrate expiration enforcement into `runGc()`, archiving or purging expired records during scheduled or manual garbage collection cycles.

---

## Acceptance Criteria

### Frontmatter Schema & Expiration Parsing

- AC1: `RecordFrontmatter` and `FrontmatterSchema` in `src/schema.ts` accept optional `expires_at` (RFC3339 timestamp or `YYYY-MM-DD`) and `ttl` (duration string e.g. `7d`, `48h`, `30m`).
- AC2: When `ttl` is supplied on `upsert` without `expires_at`, `spec-memo` computes and writes `expires_at = created + ttl` into frontmatter.
- AC3: The `isRecordExpired()` function in `src/curator.ts` evaluates true if the current timestamp is greater than or equal to the parsed `expires_at` value.

### Search & Bootstrap Brief Filtering

- AC4: The `search` MCP tool and `memo search` CLI exclude expired records from result sets by default.
- AC5: `search` accepts an optional `includeExpired: boolean` parameter (CLI flag `--include-expired`) to include expired records in results.
- AC6: When expired records are returned via `includeExpired: true`, each matching record includes an `expired: true` badge in CLI output and JSON payload.
- AC7: `bootstrap` brief compilation in `src/bootstrap.ts` omits expired traps, decisions, and specs from the session brief, preserving the 8 KB budget for active records.
- AC8: The `get` MCP tool and `memo get` CLI continue to retrieve expired records by explicit ID or slug, annotating them with `expired: true` in the returned frontmatter.

### Garbage Collection & Expiration Sweeps

- AC9: The `runGc()` function in `src/curator.ts` scans all record directories (`traps/`, `decisions/`, `plans/`, `state/`, `scratch/`, `reviews/`) for expired records.
- AC10: By default during GC, expired records of kinds `trap`, `decision`, and `plan` are transitioned to `status: 'archived'` with `archivedReason: 'expired'` rather than deleted.
- AC11: When `memo gc --purge` is executed, expired records across all kinds are permanently unlinked and removed from the SQLite FTS5 index.
- AC12: `memo gc` reports a categorized breakdown of expired records processed (`trapsArchived`, `decisionsArchived`, `scratchPurged`, `reviewsPurged`).

### Observability & Status Monitor Display

- AC13: The `:3124` Status Monitor dashboard displays an "Expired" indicator chip on expired records in the Memory drawer.
- AC14: The Status Monitor Memory table provides a filter toggle ("Hide Expired", enabled by default) allowing operators to inspect expired items.

---

## Notes

- **Zero MCP Tool Count Impact:** Operates entirely within the existing `upsert`, `search`, `get`, `bootstrap`, and `gc` tools.
- **Backward Compatibility:** Existing records without `expires_at` or `ttl` are treated as evergreen and never expire (except for default `scratch` and `review` TTLs).

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| In-kernel asynchronous file timers | Expiration is evaluated deterministically at query, brief compilation, and GC sweep time. |
| Hard deletion of traps by default | Traps and decisions are archived rather than unlinked to preserve institutional memory. |
| Automatic external clock synchronization | Relies on local system time; relative duration strings (`7d`) compute stable ISO timestamps on write. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Expiration time zone | UTC | Standardizes expiration across multi-machine hybrid setups. | y |
| Default GC behavior for expired traps | Archive, not delete | Traps represent historical lessons and should remain discoverable via historical search. | y |
| Treatment of `pinned: true` vs `expires_at` | `expires_at` takes precedence | If an explicit expiration date was set, the author explicitly declared it obsolete after that date. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural Alignment | Integrates with `src/schema.ts`, `src/indexer.ts`, `src/bootstrap.ts`, and `src/curator.ts` | Code inspection and schema audit |
| Backward Compatibility | Existing records remain evergreen without modification | Existing test suite verification |
| Tool Ceiling Compliance | Zero new MCP tools created; enhances existing tools | Schema inspection |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo upsert --kind trap --title "Temp react fix" --ttl 7d --body "..."`: creates record with computed `expires_at`.
- `memo search "Temp react fix"`: returns 0 hits when simulated time advances past `expires_at`.
- `memo search "Temp react fix" --include-expired`: returns the record with `[EXPIRED]` badge.
- `memo gc`: logs count of archived expired records.

### Negative & Failing Test Scenarios

- Invalid duration strings (e.g. `--ttl "invalid"`) fail validation with an informative error rather than writing corrupt dates.
- Expired records do not appear in `memo bootstrap` output even when query keywords match exactly.
- Running `memo gc` with `--dry-run` calculates expired counts without mutating files or SQLite rows.
