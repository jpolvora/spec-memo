---
id: null
slug: cross-project-search
title: "Opt-in cross-project search across local vault repositories"
source: local
specDate: 2026-08-25
---

# Specification — Opt-in cross-project search across local vault repositories

## Description

Enable agents to query traps, decisions, and architectural patterns across all projects stored within the local `$SPEC_MEMO_ROOT` vault when `crossProject: true` or `--all-projects` is explicitly requested in search parameters. By default, queries remain isolated to the active repository.

Greenfield feature. Design Intent skipped: Phase 3 curator hardening.

## Acceptance Criteria

- AC1: When `crossProject: true` is passed to the `search` MCP tool or `--all-projects` to `memo search`, the FTS query runs across all project directories in the vault.
- AC2: Search result items include the originating `projectId` and project display name for cross-project hits.
- AC3: Default searches without the cross-project flag remain strictly scoped to the active project ID.
- AC4: Ephemeral records (`scratch`, `state`, `review`) remain excluded from cross-project search results.

## Original Issue Context

PRD Phase 3: Cross-project search opt-in. Allow searching across multiple bound projects in the local vault.

## Notes

- Uses existing SQLite `records_fts` table, which already indexes `projectId`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Public or shared remote index query | Scoped to local vault `$SPEC_MEMO_ROOT` |
| Automatic cross-project trap mutation | Cross-project access is read-only |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Search ranking | Grouped by project relevance score | High relevance traps from other repos surface cleanly | y |
| Implicit dimensions | N/A because query filtering is in-memory SQLite FTS5 | Zero network overhead | y |
