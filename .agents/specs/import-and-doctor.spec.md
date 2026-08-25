---
id: import-and-doctor
slug: import-and-doctor
title: "CLI parity, workflow tree importer, promote, and doctor diagnostics"
source: local
specDate: 2026-08-23
status: shipped
---

# Specification — CLI parity, workflow tree importer, promote, and doctor diagnostics

## Description

Finalize Phase 1 with comprehensive CLI parity for all MCP tools, the `memo import` migration tool for importing existing workflow-skills `.agents` trees into the vault, `memo promote` for publishing approved decisions into the product repo, and `memo doctor` for checking vault health and flagging repo pollution.

Greenfield feature. Design Intent skipped: complete Phase 1 CLI toolset and diagnostics.

## Acceptance Criteria

- AC1: All 8 core MCP tools have 1:1 CLI command equivalents supporting both human and `--json` outputs.
- AC2: `memo import --from <path>` maps `.agents/specs/*.spec.md` → `specs/`, `memory/*.md` → `traps/` & `decisions/`, and active plan directories into `plans/`, skipping scratch/telemetry.
- AC3: Running `memo import` repeatedly is idempotent and does not generate duplicate records or mangle existing IDs.
- AC4: `memo doctor` reports vault root location, resolved project identity, SQLite FTS index status, and scans the local repo for in-tree workflow pollution (e.g. leftover `.agents/plans`).
- AC5: `memo promote <recordId> --to <targetPath>` safely exports a vault decision or spec into the product repository working tree.

## Original Issue Context

Plan Slice 8: CLI parity + `memo import` + `memo doctor`. Deliver: Each tool as a CLI command with `--json`. Import mapping per FEATURES.md § Import. `doctor` reports bind + FTS + pollution scan. Proof: Fixture import is idempotent. Doctor lists a planted `.agents/plans/foo.md` under a fixture product root as pollution.

### Design Intent

Greenfield feature. Design Intent skipped: complete Phase 1 CLI toolset, importer, and diagnostics.

## Verification

- Automated test suites: `src/promote.test.ts`, `src/doctor.test.ts`, `src/importer.test.ts`, `src/cli.test.ts`, `src/tools.test.ts`, `src/mcp.test.ts`.
- Phase 1 exit proof verified: clean repository fixture + external vault bootstrap returns traps, clean `git status`, and zero pollution reported by `doctor`.
- Full test suite: 77 tests across 21 suites passing.

## Notes

- Import skips `.runtime`, `telemetry.jsonl`, `*.tmp`.
- Doctor exit code 0 on healthy/clean, 1 if pollution or unindexed records detected.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic git push/pull of vault | Opt-in vault git is Phase 3 |
| GUI / Web dashboard | CLI and MCP stdio are the primary interfaces |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Promote authorization | Explicit confirmation/flag required | Prevents unwanted writes to product repository | y |
| Import mapping rule | File frontmatter parsed or generated from headers if legacy | Normalizes legacy memory into structured records | y |
| Implicit dimensions | N/A because CLI commands run in isolated user terminal context | Standard terminal IO | y |

