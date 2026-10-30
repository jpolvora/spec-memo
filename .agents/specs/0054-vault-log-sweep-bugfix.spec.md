---
id: null
slug: vault-log-sweep-bugfix
title: "Vault log sweep bugfix: atomic compiled-view writes, log source values, favicon noise, hybrid-offline log level"
source: local
specDate: 2026-09-13
---

# Specification — Vault log sweep bugfix (atomic views, source values, favicon, hybrid-offline level)

## Description

A sweep of the live operator vault (`~/.spec-memo/error.logs`, `error.logs.bak_20260909`, `telemetry/*.jsonl`, `.sync/*.json`) on 2026-09-13 surfaced 291 current blocks (107 WARN, 13 ERROR) plus 1018 backed-up blocks. Each distinct failure was checked against the current `develop` tree: the majority maps to already-shipped fixes (AC6 skip-and-log in `us-55`, sequential dual-sync plus autostash drain in `us-55-followup` / PR #58, stdio status opt-in in `0.14.2`, `remote set-url` handling in `initVaultGitAsync`) or to correct fail-closed behavior (prompt validation, `install_skills` permission gates, conflict `metadata_divergence` records). Four items survive as still-open defects and ship together in this slice:

1. **Non-atomic compiled-view writes (`src/compiler.ts`):** `rebuildCompiledViews` performs five direct `fs.writeFileSync` calls (`TRAPS.md`, `DECISIONS.md`, `PROMPTS.md`, `SESSIONS.md`, `INDEX.md`). Under concurrent hybrid-sync pull plus local upsert on Windows, one write failed with `UNKNOWN: unknown error, open '...TRAPS.md'` (`2026-09-12T16:08:44`, stack `compiler.js:306` via `store.js` `upsertRecord` via `sync.js` `pullHybridProject`), aborting the pull batch. Compiled views are disposable rebuild artifacts; their persistence must be atomic (temp file plus rename) with bounded retries on transient Windows lock errors (`EPERM`, `EBUSY`, `UNKNOWN`), degrading to the existing transient view-rebuild skip-and-log path instead of throwing.
2. **Over-strict log `source` enum (`src/schema.ts`):** `RecordSourceSchema` allows only `agent | human | imported`, so ingesting workflow-skills logs whose frontmatter carries `source: ws-configure-project` (or any skill slug) fails with `Invalid log frontmatter`. Skill names are legitimate provenance; the schema must accept them while keeping the known trio normalized.
3. **Favicon 404 noise (`src/status.ts`):** every browser visit to the status monitor emits `Route not found: GET /favicon.ico` into `error.logs` plus an `HTTP_404` telemetry event (7 plus 3 occurrences). Asset-well-known paths must short-circuit with an empty `204` before routing and must not log or record telemetry.
4. **Hybrid-offline severity (`src/hybrid-sync.ts`, `src/dual-sync.ts`, `src/error-logger.ts`):** unreachable daemon (`fetch failed`, push/pull timeouts to stale ports `:3000`/`:3122`) is logged at `ERROR` and reported as `DUAL_SYNC_FAILED` telemetry even though hybrid mode is specified fail-open when the daemon is down. Transport-unreachable must log at `WARN` with structured `lastError` in hybrid-state; `ERROR` stays reserved for data-risk outcomes (journal restore failure, unrecovered autostash, torn index).

Architecture touchpoints: `src/compiler.ts` (atomic write helper), `src/schema.ts` (source union), `src/status.ts` (well-known short-circuit), `src/hybrid-sync.ts` / `src/dual-sync.ts` (error classification), `src/error-logger.ts` if severity routing lives there. Tests extend `src/compiler.test.ts`, `src/schema.test.ts`, plus status/hybrid suites. Docs: `README.md` operator note only where behavior is user-visible (source values, favicon silence); no new MCP tools, no protocol change, no vault migration.

## Acceptance Criteria

- AC1: `rebuildCompiledViews` writes each compiled view atomically: content goes to a sibling temp file in the same directory followed by `fs.renameSync` onto the target, so a crash or lock mid-write never leaves a truncated `TRAPS.md` / `INDEX.md` behind.
- AC2: Transient Windows write failures (`EPERM`, `EBUSY`, `UNKNOWN`, `EACCES`) during compiled-view persistence are retried up to 3 attempts with a short backoff; a still-failing view write degrades to the existing transient view-rebuild skip path (record persisted, `view-rebuild-skipped` conflict detail, `continue`) instead of aborting the sync batch.
- AC3: Non-transient write failures (e.g. `ENOENT` project dir, permission denied after retries) still throw with the project path in the message; existing `Project vault not found` behavior for missing project dirs is unchanged.
- AC4: `RecordSourceSchema` accepts the known values `agent | human | imported` (case-insensitive, trimmed, normalized to lowercase) plus any other non-empty skill/origin slug string (e.g. `ws-configure-project`); empty or non-string `source` still fails validation and `parseRecord` / `serializeRecord` round-trip preserves the custom value.
- AC5: `GET /favicon.ico` (and `GET /robots.txt`) on the status monitor returns `204` with an empty body before route resolution, writes nothing to `error.logs`, and records no telemetry event; unknown API routes still return `404` with existing logging intact.
- AC6: Hybrid transport-unreachable outcomes (`fetch failed`, connection timeout, `ECONNREFUSED`) log at `WARN` (not `ERROR`), set structured `lastError` plus `lastSyncAt` in hybrid-state, and surface `ok: false` with the unreachable hint in `memo status` without an `ERROR` block in `error.logs`.
- AC7: Data-risk sync outcomes keep `ERROR` severity: rollback-journal restore failure, unrecovered autostash after `rebase --abort` plus ref-drain, and torn-index rebuild failure. A test asserts each classification (unreachable yields WARN, journal-restore failure yields ERROR).
- AC8: New or extended automated tests cover atomic view writes (temp-plus-rename observable, retry on injected `EBUSY`, skip-degrade on persistent failure), source-value acceptance (trio plus custom slug plus empty-reject), favicon silence (no log file growth, no telemetry), and hybrid severity split; `npm run build` is clean and full `npm test` passes with zero regressions.
- AC9: `README.md` documents the relaxed log `source` values and the silent favicon behavior in one short operator note each; no versioned protocol, MCP surface, or config shape changes, so no migration notes are required.

## Original Issue Context

Operator request (verbatim intent): check local vault `~/.spec-memo` logs/errors/telemetry/etc and read it all finding issues to be solved, find bugs, etc. When finding error messages/warnings, before adding new entry to bugfix queue, check if the error still persists in latest version or if it was already fixed. Then add or not to the bugfix queue. In the end, create a plan to fix it all at once (create a spec) to fix then execute in full auto ship mode.

Sweep evidence (this machine, 2026-09-13, vault `C:\Users\jpolv\.spec-memo`):

- `error.logs`: 291 blocks, `WARN: 107`, `ERROR: 13`. Top: `install_skills` permission gates 56x (expected fail-closed test output), `EADDRINUSE :3124` 25x plus 25x companion WARN (expected under competing daemons; stdio opt-in shipped in `0.14.2`, `memo shutdown` shipped in spec `0053`), AC6 `pathPatterns` safety 6x (fixed by `us-55` skip-and-log), vault-git rebase/autostash failures 5x (follow-up drain shipped in PR #58).
- `error.logs.bak_20260909`: 1018 blocks. `git remote add origin` 344x (fixed: current `initVaultGit`/`initVaultGitAsync` check `originExists` then `set-url`), `Unauthorized` 112x (correct 401 posture; local probes now send the resolved token), hybrid timeouts to `:3000`/`:3122`/`:3123` 38x combined (stale remote URLs; fail-open specified but logged ERROR — this spec AC6/AC7), favicon 7x (this spec AC5), `Invalid log frontmatter source ws-configure-project` 1x (this spec AC4).
- `telemetry/`: `doctor`/`bootstrap`/`install-hooks`/`shutdown` `EXIT_1` bursts align with feature-dev days (09-10 through 09-12) and fail-closed gates (permission required, drift found); `DUAL_SYNC_FAILED` 13x aligns with the unreachable-daemon windows above.
- Still-open after code check: `compiler.js:306` direct `writeFileSync` (matches current `src/compiler.ts:350-354`), `RecordSourceSchema` trio-only enum (matches current `src/schema.ts:23`), no favicon route (no `favicon` symbol in `src/`), hybrid unreachable at ERROR severity.

### Prior Work Sweep

- Keyword plus `git log` sweep on `src/compiler.ts`, `src/schema.ts`, `src/status.ts`, `src/hybrid-sync.ts`, `src/dual-sync.ts` for `writeFileSync`, `RecordSourceSchema`, `favicon`, `DUAL_SYNC_FAILED`, `fetch failed`: compiled-view direct writes date to `e1eba2c` (slice-3 records engine); source trio enum dates to the same slice; no favicon handling ever existed; hybrid fail-open plus `lastError` surfacing shipped across `0033-vault-git-hybrid-sync` and `0035-sync-conflict-reconciliation` but severity was never split by outcome class.
- Related specs recorded and continued, none duplicated: `0008-record-schema-and-indexes` (schema ownership), `0015-viewer` (compiled views as passive artifacts), `0023-mcp-status-monitor` (status routes), `0033-vault-git-hybrid-sync` (dual dispatch, fail-open logging), `0035-sync-conflict-reconciliation` (view-rebuild skip-and-log with retry, `isViewRebuildSkip`), `0053-memo-shutdown` (EADDRINUSE recovery affordance).
- No open PR for this exact bugfix bundle; duplicate risk: low. The VFS draft edits on `develop` (`0027`, uncommitted to any PR) are spec-only and untouched by this slice.

### Design Intent

- `git log -S "writeFileSync(path.join(projectDir" -- src/compiler.ts` resolves to slice-3 scaffolding: direct writes were the simplest correct thing for single-writer MVP, not an intentional durability contract. The later `isViewRebuildSkip` transient-skip path (spec `0035` plus `us-55` follow-up) already treats view rebuilds as droppable, confirming views are disposable. Atomic writes plus retry are consistent with that intent, not a reversal.
- `git log -S "RecordSourceSchema" -- src/schema.ts` resolves to slice-3 validation strictness: the trio was a closed-world assumption from the MVP kinds matrix, not a provenance guarantee. Workflow-skills skill slugs as provenance postdate it. Relaxing to an open string with trio normalization preserves all existing validation behavior for known values.
- Greenfield with reason for favicon: no prior symbol, no intentional 404-logging contract; silence is strictly less noise.
- Hybrid severity split narrows, not reverses, the fail-open design: transport-down stays non-fatal, data-risk stays loud.

## Notes

- Touchpoints: `src/compiler.ts` (atomic write helper plus retry), `src/schema.ts` (source union), `src/status.ts` (well-known short-circuit before router), `src/hybrid-sync.ts` / `src/dual-sync.ts` (classify unreachable vs data-risk), tests (`compiler.test.ts`, `schema.test.ts`, status plus hybrid suites), docs (`README.md` two short notes).
- Reuse before invent: view-rebuild skip path (`isViewRebuildSkip`, `view-rebuild-skipped` conflict detail) already exists in `src/sync.ts`; atomic temp-plus-rename follows the same disposable-artifact rationale. Telemetry `sanitizeMetadata` stays untouched; only the `errorCode`/level inputs change for the unreachable class.
- Traps honored: never broaden `RecordSourceSchema` to accept empty strings; never swallow data-risk errors into WARN; favicon short-circuit applies to exactly `/favicon.ico` and `/robots.txt`, never to `/api/*`; atomic rename stays within the same directory (no cross-device move); always `await` retry sleeps; close all handles in `finally`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Vault-git autostash conflict auto-resolution | Opposing dirty-plus-divergent edits cannot merge safely; current abort-plus-drain-plus-error is the correct posture and already shipped (PR #58). |
| AC6 / EADDRINUSE / remote-add / token-probe rework | Verified already-fixed in current tree; rework would churn shipped behavior with no open defect. |
| Prompt validation message rewrite | Fail-closed `sessionId`/`body` gates are intentional; no open defect. |
| Telemetry stderr capture for `EXIT_1` | Observability improvement with no failing test behind it; candidate for a later telemetry slice. |
| New MCP tools, protocol, config, or migration | No surface change in this slice; behavior fixes only. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Atomic write primitive | Sibling temp file plus `renameSync` in the same directory | Same-filesystem rename is atomic on Windows and POSIX; no new dependency | y |
| Retry budget for transient locks | 3 attempts, ~25–50 ms backoff | Matches AV-lock hold times; bounded so sync batches cannot stall | y |
| Source normalization | Trim plus lowercase known trio; preserve custom slugs verbatim except trim | Existing records keep byte-identical values; custom provenance stays searchable | y |
| Favicon scope | Exactly `/favicon.ico` and `/robots.txt`, `204` empty | Smallest silence set browsers request; API 404 posture unchanged | y |
| Severity rule | Unreachable/timeout/refused yields WARN; journal/autostash/index data-risk yields ERROR | Preserves fail-open while keeping data-loss signals loud | y |
| Other implicit dimensions | N/A because no new tools, routes (beyond well-known silence), auth, or persistence shape are introduced | Behavior fixes behind existing surfaces | n |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Four fix groups (atomic views, source values, favicon silence, hybrid severity) plus tests plus two short README notes | `git diff --stat` shows `src/compiler.ts`, `src/schema.ts`, `src/status.ts`, hybrid/dual-sync plus error-logger touchpoints, tests, spec, and README only |
| Atomic criteria | AC1–AC9 each independently testable | Map each AC to a test or manual command in Validation Notes |
| Failure modes covered | Persistent view-write failure degrades, empty source still rejects, API 404s still log, data-risk sync failures still ERROR | Negative scenarios below plus stubbed-transport tests |
| Stack invariants | Zero new `any`, awaited retry sleeps, Zod schema validation on source input, same-directory rename (no cross-device move), clean build | `npm run build`, test suite, invariant scan |
| Zero open blockers | No remote dependency; daemon-down is itself a stubbed test case | Tests stub transport and filesystem errors locally |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `npm run build` clean (typecheck plus emit to `dist/`).
- Targeted suites (`compiler`, `schema`, status, hybrid/dual-sync) green, plus full `npm test` with zero regressions.
- Manual repro: `GET /favicon.ico` against the status companion returns `204` with no `error.logs` growth; `memo status` during stopped daemon shows unreachable hint without an `ERROR` block.

### Negative & Failing Test Scenarios

- Truncated view without fix: a crash between view writes leaves a half-written `TRAPS.md`; after fix the temp-plus-rename leaves either the old or the new full file, never a prefix.
- Persistent `EBUSY` on all 3 view-write attempts yields record-persisted plus `view-rebuild-skipped` (not a throw); without fix the same fixture aborts the sync batch.
- Empty-string `source` and non-string `source` still fail `validateFrontmatter`; without fix custom slugs like `ws-configure-project` fail the same way, after fix they round-trip.
- `GET /api/unknown-route-xyz` still returns `404` and still logs; without fix `/favicon.ico` does the same, after fix only well-known paths go silent.
- Stubbed `ECONNREFUSED` hybrid pull yields WARN-level report with `ok: false`; without fix it yields ERROR. Stubbed journal-restore failure yields ERROR before and after (data-risk stays loud).

## Visual References

None. No UI change except silent favicon (no pixels to review).
