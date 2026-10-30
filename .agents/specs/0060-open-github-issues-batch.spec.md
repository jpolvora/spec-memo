---
id: null
slug: open-github-issues-batch
title: "Fix open GitHub bugs: AI Ops journal wiring, test vault isolation, silent Chrome probes"
source: github
specDate: 2026-09-13
issueState: closed
labels: 
---

# Specification — Fix open GitHub bugs: AI Ops journal wiring, test vault isolation, silent Chrome probes

## Description

This spec of record batches the three **open** GitHub issues on `jpolvora/spec-memo` (2026-09-13 list) into one delivery slice. All three are operator-diagnostic defects: they do not add MCP tools or change the 11-tool surface. They share files around vault config, status HTTP, and `executeTool` telemetry.

Workstreams:

1. **#66 AI Ops journal wiring.** Spec `0057-status-ai-ops-logs` already implemented `withAiOpsJournal` / `AiOpsJournaledAgent` and tests that wrap the agent **manually**. Runtime `resolveVaultAiAgent` (`src/ai/index.ts`) still returns a raw `CursorSdkVaultAiAgent` or `NoopVaultAiAgent`. Live `ai.enabled: true` refine/rank therefore leave `~/.spec-memo/ai-ops/` empty and `GET /api/ai-ops` at `total: 0`. Fix: wrap the constructed agent once at `resolveVaultAiAgent` with `withAiOpsJournal(agent, { vaultRoot, config, projectId? })` so every `resolveToolAi` / `resolveUpsertAiAgent` path inherits journaling. Honor existing `opsLogEnabled` (omitted follows `ai.enabled`; explicit `false` writes zero rows). Keep journal I/O fail-open (no floating promises without `void`/`.catch`). Trap `ai-ops-journal-decorator-unwired` already records this.

2. **#67 Test suite must not write the operator vault.** `executeTool` always calls `recordTelemetry` and, on error, `logErrorReport` with optional `{ vaultRoot }`. When tests omit `vaultRoot`, both fall back to `getVaultRoot()` (`~/.spec-memo`). `src/version-skills.test.ts` `install_skills` fixtures (no confirm / empty host) therefore append `mcp-tool` WARN rows and `success:false` telemetry into the real vault. Fix: isolate the suite (set `SPEC_MEMO_ROOT` / pass explicit temp `vaultRoot` on `executeTool` calls that can fail) so default-home vault files are not created or appended. Add a regression that fails if the operator vault receives `mcp-tool` writes from those fixtures.

3. **#68 Silent Chrome / favicon probes.** Status companion already returns silent 204 for `GET /favicon.ico` and `GET /robots.txt` (`src/status.ts`). Chrome DevTools also probes `GET /json/version` and `GET /.well-known/appspecific/com.chrome.devtools.json`. Those 404s log `Route not found` at WARN to `error.logs` and emit `HTTP_404` telemetry. SSE (`src/server.ts`) does not silence favicon/robots. Extend the silent-probe allowlist on both listeners: no `error.logs` line and no `success:false` telemetry for those GET paths; response may stay 204 or empty 404 without WARN.

Language: en-us. Do not add a 12th MCP tool. Do not rewrite 0057 journal schema. Do not delete existing operator `error.logs` as part of this slice.

## Acceptance Criteria

### Issue #66 — wire AI Ops journal

- AC1: `resolveVaultAiAgent` returns `withAiOpsJournal(...)` around the live `CursorSdkVaultAiAgent` when `ai.enabled === true` and `opsLogEnabled` is not explicit `false`.
- AC2: `NoopVaultAiAgent` (disabled AI) still writes **zero** journal rows after wrapping (existing Noop pass-through).
- AC3: With `ai.enabled: true` and a temp vault, a `search` or `bootstrap` that runs rank, and an eligible-kind `upsert` that runs refine, each produce at least one JSONL row under `{vaultRoot}/ai-ops/ai-ops-<UTC>.part-1.jsonl` without wrapping the agent in the test itself.
- AC4: `GET /api/ai-ops` against a status companion bound to that temp vault reports `total > 0` after AC3.
- AC5: Explicit `ai.opsLogEnabled: false` writes zero rows even if the SDK agent runs.
- AC6: `rg withAiOpsJournal src --glob '!*.test.ts'` includes `src/ai/index.ts` (or the single agent-construction choke point), not tests only.
- AC7: `TOOL_NAMES.length` remains 11.

### Issue #67 — isolate test diagnostics from `~/.spec-memo`

- AC8: `src/version-skills.test.ts` `install_skills` expected-fail fixtures pass an isolated `vaultRoot` (or run with `SPEC_MEMO_ROOT` pointing at the test temp dir) so `logErrorReport` / `recordTelemetry` never append to the operator vault.
- AC9: A regression test (new or extended) asserts that after those fixtures, the default `getVaultRoot()` `error.logs` file is unchanged in length/mtime relative to a snapshot taken before the fixtures **or** that writes went only to the temp vault.
- AC10: Other `executeTool(...)` tests that omit `vaultRoot` and can return `isError: true` must not use the operator vault (audit at least `version-skills.test.ts`; fix additional suites found by the same pattern in this slice).
- AC11: Production `executeTool` behavior for real MCP/CLI (operator vault when `vaultRoot` omitted) is unchanged outside tests.

### Issue #68 — silent probe routes

- AC12: Status companion `GET /json/version` and `GET /.well-known/appspecific/com.chrome.devtools.json` do not append `Route not found` to `error.logs` and do not record `success:false` HTTP telemetry.
- AC13: Status companion `GET /favicon.ico` and `GET /robots.txt` remain silent (existing 204 behavior preserved).
- AC14: SSE listener (`src/server.ts`) treats `GET /favicon.ico` and `GET /robots.txt` the same as the status companion (no WARN 404 telemetry for those paths).
- AC15: Real unknown routes (example `GET /definitely-not-a-probe`) still log and still emit HTTP_404 telemetry.
- AC16: Probe paths are not added as documented operator APIs; they must not appear in README as features.

### Cross-cutting

- AC17: `npm run build` and `npm test` stay green.
- AC18: No unchecked `any` in new code; journal wrap Promise failures stay fail-open with `void` or `.catch`.
- AC19: Closing this spec is intended to close GitHub issues #66, #67, and #68 (comment + close after ship, not in this write).

## Original Issue Context

Batch import via `/ws-spec-from-provider` with explicit user request: one spec covering all open issues (not one `us-{id}` spec per issue). Open set at fetch: **#66, #67, #68**. Skipped existing `us-66` / `us-67` / `us-68` / `NNNN-us-*`: none.

### Issue #66

- Title: AI Ops journal is never written: withAiOpsJournal is not wired into the runtime agent path (spec 0057)
- URL: https://github.com/jpolvora/spec-memo/issues/66
- Labels: bug

```
## Summary

With `ai.enabled: true` and a valid key, live AI refine/rank calls execute, but **no AI Ops journal rows are ever written**. The status monitor **AI Ops** page and `GET /api/ai-ops` are permanently empty, contradicting spec 0057 (one journal row per refine/rank settlement when `ai.enabled` is true).

## Evidence (local vault, v0.33.0)

- Vault `config.json`: `ai.enabled: true`, `provider: "cursor-sdk"`, key present via `CURSOR_API_KEY` env.
- Live AI call succeeds: `memo search "sqlite" --explain` → hits report `explain.aiRank: "applied"`.
- Journal absent: `~/.spec-memo/ai-ops/` directory does not exist.
- `GET http://127.0.0.1:3124/api/ai-ops` → `{"items":[],"total":0}`
- `GET http://127.0.0.1:3124/api/dashboard` → `"aiOpsCount":0`
- `GET http://127.0.0.1:3124/api/status` → `ai: { enabled: true, provider: "cursor-sdk", available: true, queueDepth: 0, lastError: null }`

## Root cause

`withAiOpsJournal()` (`src/ai/ops-log.ts:711`) / `AiOpsJournaledAgent` is never wired into the runtime agent path:

- `resolveVaultAiAgent` (`src/ai/index.ts:70`) returns `new CursorSdkVaultAiAgent(config)` directly.
- `resolveToolAi` (`src/tools.ts:96-111`) and `resolveUpsertAiAgent` (`src/store.ts:624-634`) return the raw agent.
- The only references to `withAiOpsJournal` are in `src/ai-ops.test.ts:23,266` — the tests wrap the agent manually, so the journal suite passes while the runtime path writes nothing.

## Expected

Wrap the resolved agent (in `resolveVaultAiAgent` or each call site) with `withAiOpsJournal(agent, { vaultRoot, config, projectId })` so refine/rank settlements append rows, honoring `opsLogEnabled` (omitted ⇒ follows `ai.enabled`; explicit `false` ⇒ zero rows).

## Acceptance

- With `ai.enabled: true`, a `search`/`bootstrap` with a query and an eligible-kind `upsert` produce rows in `~/.spec-memo/ai-ops/ai-ops-<UTC>.part-1.jsonl`, and `GET /api/ai-ops` returns non-zero `total`.
- With `ai.enabled: false` (Noop), zero rows.
- MCP tool surface stays at 11.
```

Comments: none.

### Issue #67

- Title: Test suite writes mcp-tool errors and telemetry into the operator's real vault (~/.spec-memo)
- URL: https://github.com/jpolvora/spec-memo/issues/67
- Labels: bug

```
## Summary

Running the test suite (`npm test`) appends `mcp-tool` WARN/ERROR entries and telemetry records into the operator's **real** vault (`~/.spec-memo/`). Some tests call `executeTool(...)` without a `vaultRoot`, so `logErrorReport` / `recordTelemetry` fall back to `getVaultRoot()` (the real vault) instead of a temp vault. This floods `error.logs` and `GET /api/error-logs` with fixture noise, obscuring real incidents and growing the log unboundedly.

## Evidence

`~/.spec-memo/error.logs` contains **58× each** of:

- `[WARN] [mcp-tool] install_skills writes require explicit confirm: true. No files were written.` with `productRoot: C:\Users\jpolv\AppData\Local\Temp\spec-memo-no-write`
- `[WARN] [mcp-tool] install_skills writes require at least one non-empty host. No files were written.` with `productRoot: ...\spec-memo-skills-empty-host-*`

Source: `src/version-skills.test.ts:395-424` calls `executeTool('install_skills', {...})` with **no `vaultRoot`**. `src/tools.ts:796-809` then logs to the default vault. `GET /api/error-logs` reports `total=212`, dominated by this `install_skills` fixture noise. Corresponding `success:false` rows also appear in `~/.spec-memo/telemetry/telemetry-YYYY-MM-DD.part-1.jsonl`.

## Impact

- Real vault diagnostics polluted by test runs (error-log HTTP viewer + telemetry + on-disk `error.logs`).
- Unbounded growth of `error.logs` with test noise; real production errors become hard to find.
- Cross-contamination on shared/lab machines.

## Proposed fix

- In `executeTool`, resolve to a temp vault when no `vaultRoot` is supplied under test, or require tests to pass an explicit temp `vaultRoot`.
- Add a global test setup that sets `SPEC_MEMO_ROOT` to a temp dir (only 12 of the test files set it today; `version-skills.test.ts` does not).
- Add a regression test asserting no writes land in the default vault during the suite.
```

Comments: none.

### Issue #68

- Title: Status monitor logs 'Route not found: GET /json/version' (and SSE favicon) as errors/telemetry
- URL: https://github.com/jpolvora/spec-memo/issues/68
- Labels: bug

```
## Summary

Chrome DevTools probes `GET /json/version` against the status monitor. The request is not in the silent-probe list, so the server logs `Route not found` at WARN to `error.logs` and records a `success:false` `HTTP_404` telemetry event. `/favicon.ico` and `/robots.txt` are already suppressed (`src/status.ts:5219-5220`), but `/json/version` is not.

## Evidence

- `~/.spec-memo/error.logs`: `[2026-09-14T00:09:55.750Z] [WARN] [status-server] (Port: 3124, Host: 127.0.0.1) ... Route not found: GET /json/version`
- `GET /api/error-logs` → `14/09/2026 00:09:55 | status-server | Route not found: GET [path]`
- Telemetry `telemetry-2026-09-14.part-1.jsonl` → `http_endpoint | GET /json/version | HTTP_404`

## Proposed fix

- Extend the silent-probe list in `src/status.ts` with `/json/version` (and Chrome DevTools's `/.well-known/appspecific/com.chrome.devtools.json`).
- Also suppress `/favicon.ico` / `/robots.txt` 404 logging in the SSE server (`src/server.ts:583`) for parity.

Low severity: diagnostics-only noise, no functional impact.
```

Comments: none.

### Prior Work Sweep

- No open PR targeting issue #66, #67, or #68.
- #66 related merged work: `1a253e8` feat 0057 journal; `37d1226` bound ai-ops reads; decorator still test-only. Sweep PRs #1/#33/#2 are `#66` substring noise, not this bug.
- #67 related: `executeTool` error logging added around install_skills / MCP tooling; no isolation commit found. Keyword PR hits (#51, #44, …) are false positives on `#67`.
- #68 related: `de75734` silent favicon/robots on status companion; SSE parity and `/json/version` still missing.

### Design Intent

- **#66:** Accidental gap. 0057 designed capture at the `VaultAiAgent` boundary; implementation left the wrapper off the production constructor. Restore the specified wiring; do not invent a second journal writer.
- **#67:** Accidental gap. Production `executeTool` should keep logging to the bound/default vault. Tests must not use that default. Prefer explicit temp `vaultRoot` / `SPEC_MEMO_ROOT` in tests over changing production fallback unless a test-only env flag already exists.
- **#68:** Intentional silent list in `de75734` was favicon + robots only. Chrome DevTools probes are the same class of noise; extend the list, do not treat `/json/version` as a real CDP API on the status server.

## Child Tasks

### Task #66 — Wire `withAiOpsJournal`

- **Status:** open
- **Description:** Wrap runtime agent at `resolveVaultAiAgent`; prove journal + `/api/ai-ops` without test-only wrapping.

### Task #67 — Isolate test `executeTool` diagnostics

- **Status:** open
- **Description:** Stop `version-skills` (and similar) fixtures from appending to `~/.spec-memo/error.logs` and telemetry.

### Task #68 — Silent probe GETs

- **Status:** open
- **Description:** Status + SSE ignore Chrome/favicon/robots probes in logs and telemetry; keep real 404s loud.

## Notes

- Primary files: `src/ai/index.ts`, `src/ai/ops-log.ts`, `src/ai-ops.test.ts`, `src/tools.ts`, `src/version-skills.test.ts`, `src/status.ts`, `src/server.ts`, matching `*.test.ts`.
- Prefer one production wrap site (`resolveVaultAiAgent`) over wrapping at every `resolveToolAi` call.
- For #67, do not globally redirect `getVaultRoot()` in production based on `NODE_ENV=test` unless tests already rely on that; isolated `vaultRoot` is the smaller change.
- TypeScript-Node stack: no unchecked `any`; handle journal flush promises.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New MCP tools or AI Ops write APIs | 11-tool surface frozen; journal is a side effect of existing refine/rank |
| Rewriting 0057 schema / AI Ops UI | Already shipped; this slice only wires capture and operator noise |
| Deleting or rotating existing operator `error.logs` | Operator data; tests must stop appending, not wipe history |
| Implementing Chrome DevTools Protocol on :3124 | Probes must be silent 404/204, not a real `/json/version` service |
| Per-issue `us-66` / `us-67` / `us-68` specs | User asked for a single batch spec |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Batch vs per-issue specs | One spec `open-github-issues-batch` | User override of ws-spec-from-provider 1:1 import | y |
| #67 production fallback | Keep `getVaultRoot()` when `vaultRoot` omitted in production | Issue is test isolation, not MCP contract change | y |
| i18n, tenancy, migrations, frontend locales | N/A because CLI/MCP Node status HTML only; no new user-facing copy locales or DB migrations | Stack dimensions absent for this bugfix batch | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Only #66 wiring, #67 test isolation, #68 silent probes | Diff limited to listed files plus tests/docs if needed |
| Atomic ACs | AC1–AC19 have pass/fail | Reviewer maps each AC to a test or command |
| Stack invariants | No `any`; promises handled; no path concat of untrusted probe URLs into files | `npm run build`; review wrap site |
| Authz | Probe GETs stay unauthenticated noise paths; `/api/ai-ops` auth unchanged | Existing status auth tests still pass |
| Failure modes | Journal fail-open; tests fail if operator vault is written; unknown routes still log | Negative scenarios below |
| Open blockers | None | Issues open; code and 0057 helper already in tree |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `rg withAiOpsJournal src --glob '!*.test.ts'`
- Temp-vault `ai-ops/*.jsonl` line count after search/upsert
- `GET /api/ai-ops` `total`
- Operator `error.logs` mtime/size around `npm test` vs temp vault logs
- Status/SSE request to `/json/version` leaves `error.logs` unchanged; `GET /no-such-route` still WARN

### Negative & Failing Test Scenarios

- Before wrap: live enabled agent + search produces **zero** journal files (current red).
- `opsLogEnabled: false` must stay at zero rows (must not start logging).
- `install_skills` without `confirm` must still return the WARN payload to the test, but must **not** grow operator `error.logs`.
- `GET /json/version` must **not** create a new `status-server` WARN line; `GET /no-such-route-xyz` must still create one.
- Unchecked `any` on the journal wrapper is a stack-invariant fail.
