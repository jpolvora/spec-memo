---
id: null
slug: trap-dedup
title: "Anti-regression trap deduplication and automatic superseding"
source: local
specDate: 2026-08-25
---

# Specification — Anti-regression trap deduplication and automatic superseding

## Description

Enhance the `upsert` engine to detect existing traps covering the same `pathPatterns` with semantically equivalent or overlapping `DO NOT` / `INSTEAD DO` rules. When a duplicate or evolutionary trap is upserted, automatically link and supersede the older trap record instead of proliferating redundant entries in `TRAPS.md`.

Greenfield feature. Design Intent skipped: Phase 3 curator hardening.

## Acceptance Criteria

- AC1: When a new trap is upserted with identical `pathPatterns` and matching scenario/rule keywords, the engine identifies the existing trap as a candidate.
- AC2: If similarity threshold is met, the engine sets `supersedes: <oldTrapId>` on the new record and transitions the old record status to `superseded`.
- AC3: The compiled `TRAPS.md` retains only the active superseding trap, preventing duplicate entries for the same anti-pattern.
- AC4: Dedup behavior can be bypassed by passing an explicit `allowDuplicate: true` parameter if distinct co-existing traps are required.

## Original Issue Context

PRD Phase 3: Trap dedup on upsert. Same pathPatterns + similar DO NOT -> supersede instead of a third entry.

## Notes

- Uses text normalization and jaccard / token overlap or Levenshtein distance on rule strings.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-tenant cross-org trap merge | Deduplication is scoped to the current project vault |
| LLM-based dedup arbitration in core | Uses deterministic heuristic matching in local engine |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Overlap threshold | Exact pathPatterns match + >70% token overlap in rule text | Prevents false-positive superseding of unrelated traps | y |
| Implicit dimensions | N/A because dedup runs synchronously during upsertRecord | Standard in-memory matching | y |
