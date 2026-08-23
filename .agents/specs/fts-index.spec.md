---
id: null
slug: fts-index
title: "SQLite FTS disposable index and search engine"
source: local
specDate: 2026-08-23
---

# Specification — SQLite FTS disposable index and search engine

## Description

Provide a fast, local full-text search capability for `spec-memo` using SQLite FTS5 (`memo.sqlite`). Markdown files in the project vault remain the single source of truth. The SQLite database is purely an indexing cache that can be deleted and transparently rebuilt from disk at any time without data loss.

Greenfield feature. Design Intent skipped: no prior FTS implementation in the codebase.

## Acceptance Criteria

- AC1: When records are upserted or modified via store, their searchable text (title, tags, pathPatterns, body, id, kind, status) is indexed in SQLite FTS5 table.
- AC2: The `search` tool and CLI `memo search <query>` execute FTS5 queries matching words, prefixes, or phrases across title, tags, pathPatterns, and body.
- AC3: Filter parameters (`kind`, `tags`, `path`, `projectId`) restrict search results to matching subsets.
- AC4: Records with `kind: scratch` are excluded from search results by default, unless `includeScratch: true` is explicitly specified.
- AC5: If `memo.sqlite` is missing, corrupted, or deleted, `rebuildIndex()` automatically re-indexes all Markdown records across all projects from the vault filesystem, producing identical search results.
- AC6: CLI command `memo search` supports `--json` output format consistent with MCP tool output.

## Original Issue Context

Plan Slice 4: `fts-index`. Deliver `search` using SQLite FTS; rebuild from vault; default kind filter. Proof: Search finds a trap by keyword and by `pathPatterns`; `scratch` is omitted unless requested; deleting `memo.sqlite` and rebuilding yields the same hits.

## Notes

- Uses `better-sqlite3` with standard FTS5 support.
- Database location: `$SPEC_MEMO_ROOT/memo.sqlite`.
- Schema: Table `records_fts` using `fts5(id, projectId, kind, title, tags, pathPatterns, body, status, UNINDEXED filepath)`.
- Rebuild scans `$SPEC_MEMO_ROOT/projects/*/` for all `*.md` files (excluding compiled `TRAPS.md`, `DECISIONS.md`, `INDEX.md`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Vector embeddings / semantic search | Deferred to Phase 3 (`embeddings-search.spec.md`) |
| Cross-project search by default | Default is current project; cross-project is Phase 3 opt-in |
| External database service / server | SQLite is embedded local-first |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| SQLite driver | `better-sqlite3` | Synchronous, fast, standard Node native binding supported in Node 22 | y |
| DB location | `$SPEC_MEMO_ROOT/memo.sqlite` | Central index at vault root for all local projects | y |
| FTS5 table structure | Dedicated FTS5 virtual table + metadata table | Enables Porter stemming, snippet/highlighting, and metadata filtering | y |
| Implicit dimensions | N/A because local single-user SQLite with write-ahead logging satisfies local concurrency | No remote multi-tenant needs in v1 | y |
