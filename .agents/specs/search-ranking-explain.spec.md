---
id: null
slug: search-ranking-explain
title: "Retrieval Ranking and Bootstrap Brief Explainability"
source: local
specDate: 2026-09-04
---

# Specification — Retrieval Ranking and Bootstrap Brief Explainability

## Description

Provide complete algorithmic transparency for SQLite FTS5 search ranking and bootstrap session brief compilation. When requested via `explain: true` (or the `--explain` CLI flag), return a detailed scoring breakdown for every hit, itemizing the raw BM25 score, pathPattern affinity boosts, severity multipliers, retrieval hit frequency bonuses, and recurrence weights. In `bootstrap`, detail why specific records were selected into the 8 KB token budget and why lower-scoring candidates were truncated.

### Problem Analysis & Real-World Evidence

1. **Opaque Retrieval Scoring:**
   - In `src/indexer.ts`, `searchIndex()` combines raw SQLite FTS5 BM25 ranks with custom multipliers (severity, path matches, occurrences, hits).
   - Currently, consumers and human operators only see a single composite `score` number or an ordered list. When a search returns unexpected results, diagnosing whether the cause was a keyword mismatch, a pathPattern rule, or hit-count skew requires tedious manual debugging.
2. **Bootstrap Budget Truncation Ambiguity:**
   - `src/bootstrap.ts` strictly enforces `maxBytes` (default 8192 bytes UTF-8). When a project accumulates dozens of active traps, lower-ranked items are silently dropped once the budget is exhausted.
   - Operators and agents have no visibility into which traps were on the bubble, why they were omitted, or how many bytes were consumed by each section.

### Design Intent

Introduce an optional `explain` mode across `search` and `bootstrap`. The breakdown provides structured diagnostics without altering the core ranking algorithm or storage schemas, empowering developers and agent evaluators to inspect and fine-tune memory retrieval behavior.

---

## Acceptance Criteria

### Search Explainability Payload

- AC1: The `search` MCP tool and `memo search` CLI accept an optional `explain: boolean` parameter (CLI flag `--explain`).
- AC2: When `explain: true` is set, each hit item in the search response includes an `explain` object detailing `ftsBm25`, `pathPatternBoost`, `severityMultiplier`, `hitsBoost`, `occurrencesBoost`, and `finalScore`.
- AC3: The CLI command `memo search <query> --explain` renders an indented diagnostic tree beneath each hit detailing the contributing scoring factors.
- AC4: When `--json` is combined with `--explain`, the `explain` object is embedded directly into each hit element in the JSON array without breaking standard response consumers.

### Bootstrap Brief Explainability & Budget Breakdown

- AC5: The `bootstrap` MCP tool and `memo bootstrap` CLI accept an optional `explain: boolean` parameter (CLI flag `--explain`).
- AC6: When `explain: true` is passed to `bootstrap`, the response payload includes a `budgetReport` object detailing `budgetBytes`, `consumedBytes`, `remainingBytes`, and `includedCount`.
- AC7: The `budgetReport` itemizes every candidate evaluated, its computed score, its UTF-8 byte weight, and whether it was `included` or `truncated_budget_exhausted`.
- AC8: The CLI command `memo bootstrap --explain` prints a diagnostic budget allocation table to stderr while outputting the brief markdown to stdout.

### Robustness & Error Isolation

- AC9: Explain calculations never modify the underlying FTS5 ranking logic, search ordering, or database index state.
- AC10: If an explain calculation encounters non-numeric frontmatter values (e.g. malformed hits or occurrences), it falls back to neutral multipliers (1.0x) without failing the search request.

### Observability & Status Monitor Integration

- AC11: The `:3124` Status Monitor Memory explorer includes an "Explain Scoring" toggle in the search drawer that displays a visual score breakdown bar for each retrieved candidate.

---

## Notes

- **Zero MCP Tool Count Impact:** Adds an optional parameter to existing `search` and `bootstrap` tools.
- **Zero Overhead by Default:** When `explain` is false or omitted, the extra calculation and payload generation are bypassed, preserving maximum retrieval speed.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Interactive tuning of scoring weights via GUI | Scoring weights are defined by system heuristics; dynamic custom scoring is deferred. |
| Vector cosine distance explainability | Current scope covers the active SQLite FTS5 lexical index; vector explainability belongs to Phase 3 embeddings. |
| Persistent explain logs on disk | Explain data is calculated ephemerally on request and not stored in vault files. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Explain score precision | 2 decimal places | Sufficient for debugging without visual clutter. | y |
| Bootstrap stderr vs stdout behavior | Stderr for diagnostics, stdout for markdown | Allows piping `memo bootstrap --explain` directly into agent prompt injection streams. | y |
| Default explain state | `false` | Ensures backward compatibility and minimal payload overhead for standard agent turns. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural Alignment | Integrates into `src/indexer.ts`, `src/bootstrap.ts`, and `src/cli.ts` | Codebase inspection and schema verification |
| Tool Ceiling Compliance | Zero new MCP tools created; enhances `search` and `bootstrap` | Tool schema audit |
| Performance Invariant | Zero performance overhead when `explain` is false | Benchmark comparison with existing search suite |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo search "sqlite" --explain`: outputs score tree under each hit.
- `memo search "sqlite" --explain --json`: JSON response objects contain the `explain` property.
- `memo bootstrap --explain`: stderr prints budget allocation and truncation reasons.

### Negative & Failing Test Scenarios

- Requesting explain on a query that yields zero hits returns an empty array with zero errors.
- Passing `--explain` with invalid search query syntax surfaces standard syntax error without crashing explain formatter.
- Search with explain handles missing frontmatter fields cleanly, defaulting to base score without NaN.
