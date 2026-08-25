---
id: null
slug: remaining-kinds-and-events
title: "Remaining record kinds, append-only logs, and forget archiving"
source: local
specDate: 2026-08-23
---

# Specification — Remaining record kinds, append-only logs, and forget archiving

## Description

Complete the record kinds matrix (`spec`, `plan`, `state`, `log`, `scratch`, `review`), implement the `append` tool for write-only log streams, and implement the `forget` tool for archiving traps and other records without silent data loss.

Greenfield feature. Design Intent skipped: extends the initial trap/decision store from Slice 3.

## Acceptance Criteria

- AC1: The store supports validation, persistence, and indexing for all six remaining record kinds: `spec`, `plan`, `state`, `log`, `scratch`, and `review`.
- AC2: The `append` MCP tool and `memo append` CLI command append chronological event records under `logs/` without rewriting or corrupting previous events.
- AC3: The `forget` MCP tool and `memo forget` CLI command mark the target record's status as `archived` on disk and update compiled views.
- AC4: Purging is disallowed during standard `forget` calls; physical deletion is only accessible via explicit `--purge` flag.
- AC5: `state` and `scratch` records are prevented from polluting compiled views (`TRAPS.md`, `DECISIONS.md`, `INDEX.md`).

## Original Issue Context

Plan Slice 5: `spec`, `plan`, `state`, `log`, `scratch`, `review`. `append` is write-only. `forget` archives traps (purge requires a flag that tests use explicitly). Proof: Append does not rewrite older events. Forget on a trap sets `archived` and keeps the file until purge.

## Notes

- Kind directories scaffolded under `$SPEC_MEMO_ROOT/projects/<projectId>/`.
- `append` generates deterministic or timestamped IDs (e.g. `log-YYYY-MM-DD-HHmmss-xxxx`).
- `forget` retains the record file on disk with updated frontmatter `status: archived`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic GC / pruning of expired records | Handled in Slice 7 (`curator-gc-and-safety.spec.md`) |
| In-memory log streaming | Stdout/JSON and file-based append are sufficient |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Append format | Daily or timestamped Markdown files under `logs/` | Standardized audit log without giant single file contention | y |
| Forget default behavior | Soft archive (`status: archived`) | Prevents accidental data loss; adheres to anti-silent-delete rule | y |
| Implicit dimensions | N/A because local file system writes provide sufficient durability for single-user CLI/MCP | Standard Node.js fs guarantees | y |
