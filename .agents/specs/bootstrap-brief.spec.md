---
id: null
slug: bootstrap-brief
title: "Bootstrap brief generation with token budget and path filters"
source: local
specDate: 2026-08-23
---

# Specification — Bootstrap brief generation with token budget and path filters

## Description

Implement the `bootstrap` MCP tool and `memo bootstrap` CLI command. When an agent opens a repository session, calling `bootstrap` automatically resolves the current project, evaluates active traps and decisions, filters and ranks them according to relevance and severity, and formats a token-capped brief (default 8 KB UTF-8) with zero product-tree writes.

Greenfield feature. Design Intent skipped: initial implementation of the bootstrap brief engine.

## Acceptance Criteria

- AC1: Calling `bootstrap` resolves the active project ID from the working directory (cwd) without requiring manual project configuration.
- AC2: Traps are ranked by severity (`high` > `medium` > `low`) and path/keyword match against modified or target file patterns.
- AC3: The total brief payload size is strictly capped at the token budget (default 8,192 bytes UTF-8).
- AC4: When the total relevant context exceeds the budget, lower-severity items are dropped and a `truncated: true` notice is attached to the output.
- AC5: Active decisions, active delivery plan/spec slug (if any), and drift warnings are included in the brief structure.
- AC6: Bootstrap never creates, modifies, or writes files in the consumer product repository tree.

## Original Issue Context

Plan Slice 6: `bootstrap` budget. Deliver: Bind cwd → project; rank traps; cap 8 KB; `truncated` flag. Proof: A vault with many traps returns ≤ 8192 bytes of brief payload (JSON). Low-severity traps drop before high. Logs are absent.

## Notes

- Brief structure: JSON object with `{ project, traps: [...], decisions: [...], activeSlice: {...}, truncated: boolean }`.
- Output formatting for CLI supports both human-readable markdown summary and machine-readable `--json`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-project aggregate brief | Bootstrapping is scoped strictly to the current active project |
| Full log dumps | Logs are queryable via search, never included in bootstrap brief |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default byte budget | 8,192 bytes (8 KB) | PRD constraint §6; prevents LLM context window pollution | y |
| Truncation priority | Drop low severity traps first, preserve critical traps & active slice | Ensures mission-critical anti-regression traps remain visible | y |
| Implicit dimensions | N/A because deterministic ranking is pure in-memory transformation | No network or async side effects | y |
