---
id: null
slug: vault-stability-audit
title: "Vault stability: truthful doctor/status, dual-sync observability, telemetry and error-log lifecycle"
source: local
specDate: 2026-09-22
status: completed
---

# Specification — Vault stability: truthful doctor/status, dual-sync observability, telemetry and error-log lifecycle

## Description

spec-memo hybrid vaults with batched vault-Git can report a healthy persisted `.sync/vault-git-state.json` while the live Git tree is dirty, treat gitignored `.agents/plans` residue as doctor failures, hide FTS source/index mismatch, point `memo status` at a non-existent `telemetry/usage.jsonl` path, grow unbounded `error.logs`, and collapse dual-sync failures into a single opaque code. Spec index and shipped-issue frontmatter can also drift (`todo` / `draft` / `issueState: open` after delivery).

This slice makes doctor and status report live Git (via `git var GIT_AUTHOR_IDENT` and porcelain on allow-listed paths), classify gitignored plan residue without deleting it, compare Markdown record IDs to FTS rows, expose rolling telemetry summaries, rotate `error.logs` at 8 MiB keeping eight `.bak` files, keep hybrid-then-vault-Git sequential dispatch with per-channel error codes, advance hybrid cursors only on full ack, and add a spec-lifecycle drift scan that must not mark `0027-virtual-file-system-over-mcp` as shipped.

Language: en-us. MCP `TOOL_NAMES` remains exactly 11. Vault data is preserved: no `doctor --fix` plan-dir wipe and no blind alias merge. `MarchanteERP` (and similar distinct fallback projects) stay quarantined in audit reports only.

## Acceptance Criteria

### Containment and live Git truth

- AC1: Doctor and status never delete `.agents/plans` or merge vault aliases as a side effect of diagnosis.
- AC2: Gitignored workflow residue under `.agents/plans` is counted as classified (`gitignoredCount` / `classifiedResidue`) and does not fail doctor when that is the only pollution class.
- AC3: `inspectVaultGitLive` reports whether an author is available via `git var GIT_AUTHOR_IDENT`, whether the allow-listed tree (`projects`, `config.json`, `.gitignore`) is dirty, and whether persisted `dirty` disagrees with live porcelain.
- AC4: Vault-Git flush preflight fails open with a durable `lastError` when author identity is missing; it does not report a false clean transition.

### Doctor and status surfaces

- AC5: Doctor JSON includes FTS consistency: canonical Markdown record IDs versus `records_fts` rows, excluding compiled views, project metadata, and conflict sidecars.
- AC6: Doctor reports hook version drift, config `version` versus package version, ignored residue counts, and spec-lifecycle warnings without mutating records.
- AC7: `memo status --json` `operational.telemetry.logFile` resolves an existing rolling `telemetry-YYYY-MM-DD.part-N.jsonl` file (not a static `telemetry/usage.jsonl` path that the writer does not create).
- AC8: Status includes a bounded `telemetrySummary` (failure rates, duration percentiles, top error codes) without loading the entire telemetry history into the dashboard.
- AC9: `memo vault list --audit` (or equivalent JSON) reports aliases, duplicate identities, fallback roots, record counts, and last-seen roots without merging projects.

### Dual-sync and hybrid cursor

- AC10: Dual-mode dispatch remains sequential: hybrid HTTP first, then vault-Git; user-facing docs and CLI help must not claim the channels run in parallel.
- AC11: Dual-sync results expose independent hybrid and vault-Git `ok`, error code, phase, and duration; telemetry retains an aggregate result plus per-channel fields.
- AC12: Hybrid cursor advances only when applied records are fully acknowledged; skipped or conflicted records leave the cursor unadvanced and dirty state preserved.
- AC13: Missing Git identity, rebase conflict, Windows lock, timeout, remote 4xx/5xx, and partial per-record skip are fail-open states with durable `lastError`.

### Observability lifecycle

- AC14: `error.logs` rotates at 8 MiB (`ERROR_LOG_MAX_BYTES`); at most eight `error.logs.*.bak` files are kept; the 2 MiB newest-tail viewer contract is unchanged.
- AC15: Telemetry remains append-only and redacted; expected CLI `EXIT_1`, install permission prompts, and HTTP 401s are classifiable separately from product faults in the summary.
- AC16: AI stays disabled by default; an empty AI Ops journal is not treated as an AI outage.

### Spec-release coherence

- AC17: `scanSpecLifecycleDrift` warns when a Done-log shipped slug still has `[ ] todo`, `issueState: open`, or `status: draft`, unless an explicit exception applies.
- AC18: `virtual-file-system-over-mcp` (`0027`) remains draft/todo and is not treated as lifecycle drift or marked shipped.
- AC19: Shipped issue specs `0029`, `0051`, `0052`, `0060`, `0063`, and `0064` are closed/completed in frontmatter and index; `0057-status-ai-ops-logs` is `[x] done`.
- AC20: Automated tests cover gitignored residue classification, live Git inspect, telemetry summary, error-log rotation, vault project audit, and spec-lifecycle exception for 0027.

## Original Issue Context

Operator plan `vault_stability_audit_10848123.plan.md` (Cursor plan, not product git). Evidence snapshot: hybrid + vaultGit enabled; doctor failed on 70 in-repo plan files plus hook stamp drift; status telemetry path mismatch; `sync_dual` failures including `Author identity unknown`; persisted `dirty: false` versus live dirty tree; alias/fallback projects; index/frontmatter drift; 0027 VFS still unimplemented.

### Prior Work Sweep

- Related specs: `0005-import-and-doctor`, `0009-cli-doctor`, `0018-vault-git`, `0025-deployment-modes`, `0028-operational-telemetry`, `0031-memo-status`, `0033-vault-git-hybrid-sync`, `0035-sync-conflict-reconciliation`, `0047-vault-merge-alias`, `0051-us-55`, `0052-us-54`.
- Shipped implementation: `5693fea` on `develop`, PR https://github.com/jpolvora/spec-memo/pull/81 merged as `1b20b83` (v0.37.3).
- No open PR for converting this plan into a spec of record.

### Design Intent

Doctor `--fix` and plan-directory deletion remain operator-explicit because `AGENTS.md` forbids wiping `{plansDir}`. Sequential hybrid-then-vault-Git was already the US-55 contract; this slice only restores truthful reporting and per-channel errors. Alias merge stays out of scope until backup-backed content comparison.

## Notes

- Implementation files: `src/doctor.ts`, `src/vault-git-inspect.ts`, `src/spec-lifecycle.ts`, `src/status-cmd.ts`, `src/telemetry.ts`, `src/error-logger.ts`, `src/dual-sync.ts`, `src/hybrid-sync.ts`, `src/vault.ts`, `src/vault-manager.ts`, `src/cli.ts`, `src/vault-stability.test.ts`.
- Windows: close SQLite before unlink in tests (`trap-sqlite-wal-lock`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Virtual File System over MCP (`0027`) | Genuinely unscheduled; must stay draft/todo |
| Blind vault alias merge / delete fallback projects | Requires backup + record-content comparison; `MarchanteERP` stays quarantined |
| `memo doctor --fix` or `{plansDir}` wipe | Product git boundary; classify residue only |
| Dedicated status Reconcile tab | CLI-first reconcile remains sufficient |
| Enabling AI by default | Empty AI Ops journal is expected when AI is off |
| 12th MCP tool | Core surface stays 11 tools |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Auth for status/doctor | N/A because these are local CLI/loopback read-only diagnostics; existing SSE bearer rules unchanged | No new public bind | y |
| Rate limits | N/A because no new public HTTP mutation surface | Observability reads only | y |
| Dual-sync ordering | Sequential hybrid then vault-Git | US-55 proven Windows-safe order | y |
| Error-log retention | 8 MiB rotate, keep 8 backups | Bounds disk without deleting the live tail viewer contract | y |
| Telemetry summary window | Cap events (5000 in doctor path) | Avoid loading full JSONL into status | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Truth + observability + lifecycle scan; no VFS; no alias merge | Spec Out of Scope table vs diff |
| Atomic criteria | Enumerable AC1–AC20 with pass/fail | `validate_spec.cjs --mode=authoring` |
| Failure modes | Fail-open sync, missing author, FTS mismatch as diagnostic | Dual-sync + doctor tests |
| Observation telemetry | Rolling telemetry path, summary, error rotation | `memo status --json`, `memo doctor --json` |
| TypeScript/Node invariants | No sync-over-async deadlock; vault lock not held across network waits | `src/dual-sync.ts` review + tests |
| Open blockers | None for retroactive spec of shipped v0.37.3 | PR #81 merged |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo doctor --json` exit 0 when only classified gitignored plans remain; warnings include spec-lifecycle and version drift.
- `memo status --json` `operational.telemetry.logFile` exists on disk; `telemetrySummary` present.
- Dual-sync telemetry: per-channel error fields plus aggregate.
- `error.logs` size after rotate < 8 MiB; `.bak` count ≤ 8.

### Negative & Failing Test Scenarios

- Doctor fails (exit 1) on unclassified tracked pollution that is not gitignored.
- Hybrid pull with skipped records does not advance cursor (`Hybrid sync pull skipped N record(s); cursor not advanced`).
- Vault-Git flush without `GIT_AUTHOR_IDENT` records `lastError` and does not claim clean.
- Unauthenticated non-loopback SSE bind still fails (existing bearer invariant; no regression).
- Spec-lifecycle scan does **not** flag `0027-virtual-file-system-over-mcp` as drift (`src/vault-stability.test.ts`).
