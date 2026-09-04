---
id: null
slug: log-compaction
title: "Monthly Log Compaction & Roll-up Engine"
source: local
specDate: 2026-08-25
---

# Specification — Monthly Log Compaction & Roll-up Engine

## Description

Implement automated monthly log roll-up compaction within the curator GC lifecycle (`memo gc`). Compaction identifies historical log event records from previous calendar months or older than 30 days and aggregates them into chronological monthly archive files (`log-rollup-YYYY-MM.md`). This eliminates filesystem inode exhaustion and directory bloat while ensuring all historical audit logs remain fully indexed and queryable via SQLite FTS5.

Greenfield feature. Design Intent skipped: core curator policy capability.

## Acceptance Criteria

- AC1: When `runGc` or `memo gc` is executed, individual event files under `projects/<projectId>/logs/` belonging to prior calendar months or older than 30 days are consolidated into `log-rollup-YYYY-MM.md`.
- AC2: Consolidated monthly roll-up files contain structured frontmatter with `kind: log`, `status: active`, `compacted: true`, and timestamps.
- AC3: The roll-up body combines all historical events formatted chronologically with timestamps, event IDs, execution sources, and metadata details.
- AC4: Individual historical log event files that have been merged into the monthly roll-up are safely deleted from disk.
- AC5: The newly generated monthly roll-up file is indexed into SQLite FTS5 so all historical log contents remain searchable via keyword and date queries.
- AC6: `runGc` honors `dryRun: true` and accurately reports `compactedLogsCount` without deleting or modifying files on disk.

## Original Issue Context

`FEATURES.md` § 6: Policy and curator: `- [x] Log compact. Monthly roll-up files; events remain searchable via FTS.`
`PRODUCT.PRD` § 7: Record kinds: `log`: Append-only; compact monthly. Search only. Agent work history.

## Notes

- Recent log events from the current active calendar month (<30 days) remain in separate event files for fast concurrent appending.
- The roll-up file format is standard Markdown with YAML frontmatter, preserving human readability in the vault.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Purging historical logs without user consent | Logs are durable audit history; compaction preserves full content |
| Splitting roll-up files across multiple directories | Single monthly file per project is clean and predictable |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Compaction threshold | Prior calendar month or >30 days | Balances active write throughput with storage hygiene | y |
| Roll-up naming convention | `log-rollup-YYYY-MM.md` | Clear temporal ordering and unique identifier | y |
