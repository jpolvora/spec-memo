---
id: null
slug: record-schema-and-indexes
title: "Record schema validation, upsert engine, and compiled index generation"
source: local
specDate: 2026-08-23
---

# Specification — Record schema validation, upsert engine, and compiled index generation

## Description

Define strict schema validation for Markdown records stored in the vault, implement `upsert` and `get` core engine operations, support superseding relationships between records, and automatically compile aggregated Markdown index views (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`) on record modifications.

Greenfield feature. Design Intent skipped: initial implementation of record schemas and view compilers.

## Acceptance Criteria

- AC1: Every record file contains valid YAML frontmatter with required fields (`id`, `kind`, `project`, `status`, `created`, `updated`, `source`) and valid Markdown body.
- AC2: Upserting records with missing required fields or invalid kind/status fails with validation error and prevents file creation.
- AC3: The store provides typed CRUD handlers for `trap` and `decision` records, persisting them into their respective subdirectories (`traps/`, `decisions/`).
- AC4: When an upserted record specifies `supersedes: <oldId>`, the previous record's status is automatically marked as `superseded` on disk.
- AC5: On every record write or status update, the store automatically recompiles `TRAPS.md` (active traps grouped by severity/layer), `DECISIONS.md` (ADRs grouped by status), and `INDEX.md` (summary inventory of all active records).
- AC6: Compiled index files (`TRAPS.md`, `DECISIONS.md`, `INDEX.md`) are deterministic projections of source files; deleting and recompiling them produces identical contents without data loss.

## Original Issue Context

Plan Slice 3: Records and compiled indexes. Deliver: `upsert`/`get` for `trap` and `decision` (minimum); write Markdown+frontmatter; regenerate `TRAPS.md` / `DECISIONS.md` / `INDEX.md` from sources. Proof: Invalid frontmatter fails; compiled files match sources after upsert; deleting a compiled file and rebuilding restores it.

## Notes

- Uses `gray-matter` for parsing and stringifying YAML frontmatter.
- Compiled markdown files are write-only projections; hand-editing compiled views is forbidden.

## Out of Scope

| Feature | Reason |
|---------|--------|
| SQLite indexing | Implemented in Slice 4 (`fts-index.spec.md`) |
| Secondary record kinds (spec/plan/state/log/scratch/review) | Implemented in Slice 5 (`remaining-kinds-and-events.spec.md`) |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Frontmatter parser | `gray-matter` | Standard, battle-tested Markdown frontmatter engine in Node.js | y |
| Superseding model | Explicit pointer (`supersedes: id`) | Preserves lineage while keeping old record intact as `status: superseded` | y |
| Implicit dimensions | N/A because local file operations and in-memory compilation are deterministic | No external runtime dependencies | y |
