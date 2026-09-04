---
id: null
slug: embeddings-search
title: "Embeddings as optional search backend"
source: local
specDate: 2026-08-22
---

# Specification — Embeddings as optional search backend

## Description

Optional `search` backend that uses embeddings after record kinds and TTL exist. FTS remains the default. Markdown stays the source of truth. This is a promoted inbox stub for Phase 3; full slice design happens when implementation starts.

Greenfield feature. Design Intent skipped: no existing embeddings path to preserve.

## Acceptance Criteria

- AC1: Disabled or unset embeddings search keeps the FTS search path.
- AC2: Enabling embeddings search before record kinds and TTL exist fails closed.
- AC3: Enabled embeddings search leaves Markdown files as the source of truth.
- AC4: Disabled embeddings search does not load an embedding library.

## Original Issue Context

Inbox item: Embeddings as an optional `search` backend after kinds/TTL exist.

## Notes

- Depends on `record-schema-and-indexes`, `fts-index`, and `curator-gc`.
- `PRODUCT.PRD` / `PLAN.md` forbid an embedding library in Phase 1.
- Do not replace FTS as the default backend.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Embedding library in Phase 1 MVP | Product constraint in PLAN.md and PRODUCT.PRD |
| Required cloud embedding API | Local-first vault; optional backend only |
| Replacing FTS as the default search path | FTS remains the Phase 1 and default Phase 3 path |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Implicit dimensions (auth, concurrency, observability, retries) | N/A because this stub only pins backend optionality and Phase 3 timing | Full AC coverage belongs in the implementation slice | n |
| Embedding model / library | Unchosen until the Phase 3 slice starts | Inbox item did not name a vendor | n |
