---
id: null
slug: cli-doctor
title: "CLI doctor diagnostic and repository health inspection UX"
source: local
specDate: 2026-08-25
---

# Specification — CLI doctor diagnostic and repository health inspection UX

## Description

Provide an interactive and detailed diagnostic command `memo doctor` that performs comprehensive sanity checks on the vault, SQLite FTS index integrity, project binding, and in-repo workflow artifact pollution detection with clear repair recommendations.

Greenfield feature. Design Intent skipped: Phase 4 UX polish and diagnostics.

## Acceptance Criteria

- AC1: `memo doctor` checks and displays vault root availability, permissions, and disk usage statistics.
- AC2: Inspects SQLite FTS database health and verifies consistency between Markdown files on disk and SQLite indexed records.
- AC3: Detects unindexed, corrupted, or invalid frontmatter files and offers automatic rebuild with `memo doctor --rebuild`.
- AC4: Scans the consumer product repository working tree for leaked workflow artifacts (`.agents/plans`, `.agents/specs`, `MEMORY.md`) and outputs actionable cleanup commands.

## Original Issue Context

PRD Phase 4: CLI browse/doctor UX polish. Provide polished CLI doctor diagnostics.

## Notes

- Diagnostic output formats in clean colorized terminal tables or structured JSON (`--json`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic file deletion without consent | Doctor only reports pollution and provides copy-paste commands |
| Web UI dashboard | Terminal CLI UX is the primary interface |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Exit code contract | 0 for healthy/clean, 1 for issues requiring attention | Standard CI/CD diagnostic convention | y |
| Implicit dimensions | N/A because doctor is local read-only inspection | Safe, side-effect-free diagnostic | y |
