---
id: null
slug: vault-git-hybrid-sync
title: "Batched vault-git sync with dual-mode hybrid parallel dispatch"
source: local
specDate: 2026-09-01
---

# Specification — Batched vault-git sync with dual-mode hybrid parallel dispatch

## Description

Refine shipped vault-git (`vault-git.spec.md`) and hybrid HTTP sync (`deployment-modes.spec.md` Phase 2) so both transports can run on the same workstation without a commit/push storm and without exclusive ownership of `memo sync`.

**Problem (current code):**

1. When `vaultGit.enabled: true`, every mutating store path (`upsert`, `append`, `forget`, `gc`, import, reset, trap recurrence) calls `commitVaultChange` immediately. Push still happens only on `syncVault`. Operators with an existing vault git remote get one local commit per memory write.
2. `memo sync` in `mode: hybrid` returns after `syncHybrid` and never calls `syncVault`, even when vault-git is enabled. Dual-mode is therefore impossible through the documented sync command.
3. `syncVault` holds the vault lock for the entire `git pull --rebase` + `git push` child-process duration. Git failures are swallowed with empty catch blocks (no `logErrorReport`). `commitVaultChange` returns `false` on any git error without logging.
4. Unused schema field `vaultGit.autoCommit` exists on `VaultConfig` but is never read.

**Target behavior:**

- Add `vaultGit.atomic: boolean` (default `false` when omitted).
  - `atomic: true`: after a successful local mutation, create a structured git commit **and** attempt remote pull/push (fail-open). Hybrid debounce (if `mode: hybrid`) still runs independently.
  - `atomic: false` (default): local markdown writes succeed as today; **do not** auto-commit. Flush (commit if dirty + pull/push when `remoteUrl` is set) only on explicit `memo sync`, MCP/CLI `prompt` `session_end`, and graceful `memo serve` / SSE shutdown.
- When **both** `mode: hybrid` and `vaultGit.enabled: true`, `memo sync` and session-end/shutdown flush **dispatch both transports concurrently**. Either transport may fail; the other still runs. Combined report is returned. The MCP/SSE process never exits because of filesystem or network errors.
- Preserve hybrid debounce, cwd `projectId` scope, vault lock, fail-open, cursor rules, and all existing tests except those that encode the old "commit on every upsert" cadence or "hybrid exclusive memo sync" routing.

Architecture touchpoints:

- **Config:** `src/types.ts` `VaultConfig.vaultGit`, `DEFAULT_VAULT_CONFIG` merge in `src/vault.ts`, `memo status` `OperationalStatus.vaultGit`.
- **Git engine:** `initVaultGit`, `commitVaultChange`, `syncVault` in `src/vault.ts`; new flush/orchestrator (keep git child-process contract).
- **Hybrid:** `src/hybrid-sync.ts` `syncHybrid`, `scheduleHybridPush`, `flushDebouncedPushes` (reuse; do not rewrite cursor logic).
- **Call sites:** `src/store.ts`, `src/curator.ts`, `src/backup.ts`, `src/sync.ts`, `src/tools.ts` (`session_end`), `src/cli.ts` (`memo sync`), `src/mcp.ts` / `src/server.ts` shutdown.
- **Observability:** `src/error-logger.ts` (new subsystem `vault-git`), `src/telemetry.ts`, `.sync/vault-git-state.json` (machine-local, gitignored).
- **Tests:** `src/vault.test.ts`, `src/deployment-modes.test.ts`, `src/trap-recurrence.test.ts`, new `src/vault-git-hybrid-sync.test.ts`.

This is a **modification** of shipped vault-git AC2/AC3 and deployment-modes AC21, not a greenfield store.

## Acceptance Criteria

### Config schema and defaults

- AC1: `VaultConfig.vaultGit` accepts optional `atomic: boolean`. When `vaultGit` is omitted or `atomic` is omitted, effective `atomic` is `false`. When `vaultGit.enabled` is omitted or `false`, vault-git is a no-op regardless of `atomic`.
- AC2: If `vaultGit.autoCommit` is present and `vaultGit.atomic` is omitted, `autoCommit` maps to `atomic` (`true` → atomic, `false` → batched). If both are present, `atomic` wins. `autoCommit` remains accepted JSON (no parse error) but is not required on new writes.
- AC3: `ensureVaultStructure` / config merge does not strip existing `vaultGit.remoteUrl` or `vaultGit.branch` when adding `atomic`. `memo setup` continues to merge without clobbering `vaultGit` (deployment-modes AC7).
- AC4: Invalid `atomic` types (non-boolean) are treated as `false` (fail open at runtime, no crash). `memo status` / doctor report the effective boolean, not the raw invalid value.

### Batched mode (`atomic: false`, default)

- AC5: With `vaultGit.enabled: true` and effective `atomic: false`, a successful `upsert` creates no git commit and does not invoke `git pull` or `git push`.
- AC6: Those mutations still write markdown, update FTS, and (when `mode: hybrid`) still call `scheduleHybridPush` exactly as today (debounce, cwd `projectId`, fail-open).
- AC7: After batched mutations, `git status` in the vault root may show dirty tracked paths under `projects/` (and allowed config paths). The vault remains usable. Doctor/status must not treat dirty git as vault corruption.
- AC8: Flush events are exactly: (a) `memo sync` (CLI, including `--json`); (b) MCP/CLI `prompt` action `session_end` after a successful session close; (c) graceful shutdown of stdio `memo serve` or SSE `memo serve --sse` (including MCP `server.close()` path). No other implicit timer flush is required in v1.
- AC9: A flush with no staged/unstaged vault-git paths (clean tree, or only gitignored dirty files) skips `git commit` (no empty commit) and still attempts `git pull --rebase` + `git push` when `remoteUrl` is set, unless a skip-push flag is documented for dry-run.
- AC10: When a flush does commit, the commit message is `vault-git flush` plus ISO timestamp, and when the trigger is `session_end`, also the `sessionId`. Paths staged remain the existing allow-list (`projects/`, `config.json`, `.gitignore`); never `git add .`.

### Atomic mode (`atomic: true`)

- AC11: With `vaultGit.enabled: true` and `atomic: true`, after a successful mutating store operation listed in AC5, the process creates one structured git commit (existing message shape: `upsert kind:id`, `append …`, `forget …`, `gc …`, etc.) and then attempts remote sync (`pull --rebase` then `push`) when `remoteUrl` is set.
- AC12: Git commit or remote sync failure **must not** fail the mutation result, MCP tool response, or CLI exit of the mutation command. Local markdown + FTS remain committed to disk. The error is logged (AC27) and `.sync/vault-git-state.json` is marked dirty with `lastError`.
- AC13: Rapid atomic mutations single-flight git remote sync per vault root (one in-flight pull/push). Overlapping requests queue exactly one trailing sync after the in-flight job finishes (same shape as hybrid `pushInFlight` / `pushPending`). Local commits may still occur per mutation if the working tree is dirty; they must not start a second concurrent `git` child process against the same vault `.git`.
- AC14: When `mode: hybrid` and `atomic: true`, hybrid `scheduleHybridPush` remains debounced (default 2000 ms) and independent of the git single-flight. Upsert does not wait for hybrid HTTP to finish.

### Dual-mode orchestrator

- AC15: Introduce a single orchestrator function (name in implementation, e.g. `syncDual`) used by `memo sync`, `session_end` flush, and graceful shutdown. Inputs: `vaultRoot`, `projectId?`, `all?`, `dryRun?`, `trigger: 'sync' | 'session_end' | 'shutdown'`.
- AC16: Channel enablement:
  - Hybrid channel runs iff `mode === 'hybrid'` and `remote.url` is set.
  - Vault-git channel runs iff `vaultGit.enabled === true`.
  - Remote mode: vault-git channel is a no-op (no local `projects/` writes). `memo sync` remains unavailable in remote mode (deployment-modes AC29 / current CLI error).
- AC17: When **both** channels are enabled, they start concurrently (`Promise.allSettled` or equivalent). Hybrid must not `await` git, and git must not `await` hybrid, except for brief vault-lock critical sections on local apply/commit (AC20).
- AC18: When only one channel is enabled, behavior matches that channel today (hybrid pull-then-push report, or vault-git pull/push report). When neither is enabled, `memo sync` exits non-zero with the current class of error (`requires hybrid mode or vaultGit.enabled`).
- AC19: `memo sync --json` emits both channel objects when both ran: hybrid pull/push counts and vault-git `{ committed, pulled, pushed, message, ok, error? }`.
- AC20: Vault lock is not held during hybrid HTTP `fetch` or during `git pull` / `git push` network wait.
- AC21: `memo sync --dry-run` reports intended hybrid counts (existing AC21) and vault-git porcelain (`git status --porcelain` / would-commit paths) **without** committing, pulling, or pushing. Hybrid `dryRun` remains honored on daemon apply.
- AC22: `memo sync --all` keeps hybrid all-projects scope. Vault-git flush is always vault-root scoped (one git repo); `--all` does not change git path allow-list.

### Session end and shutdown

- AC23: After a successful `prompt` `session_end` (MCP and CLI), run the dual orchestrator with `trigger: 'session_end'` when vault-git is enabled.
- AC24: Graceful shutdown of stdio MCP and SSE servers awaits the orchestrator with `trigger: 'shutdown'` and a hard timeout (default 8000 ms, overridable via `SPEC_MEMO_SYNC_TIMEOUT_MS` for the network portion). Timeout logs and continues shutdown. Sync errors never cause `process.exit` from the error path; they never prevent `mcpServer.close()`.
- AC25: CLI one-shot mutations (`memo upsert`, `memo gc`, …) with batched vault-git do **not** flush on process exit. Operators flush with `memo sync` or an agent `session_end`. Document this in README / ws-memo. Atomic CLI mutations still commit+sync fail-open before process exit (AC11–AC12).

### Fail-open, timeouts, concurrency

- AC26: Git child processes (`init`, `add`, `commit`, `pull`, `push`, `status`) use `execFile` with `timeout` (default 30000 ms, same `getSyncTimeoutMs()` / `SPEC_MEMO_SYNC_TIMEOUT_MS` as hybrid). On timeout, kill the child, log, mark dirty, and return a failed channel result. Never hang the MCP event loop unbounded.
- AC27: Every caught git, filesystem (`ENOENT`, `EACCES`, `EBUSY`, Windows `EPERM`/`EEXIST`), and network error in vault-git or the orchestrator calls `logErrorReport` with `subsystem: 'vault-git'` (extend `ErrorLogSubsystem`), `mode`, `projectId` when known, and `context.phase` in `{ init, commit, pull, push, flush, orchestrate }`. Hybrid continues to use `subsystem: 'hybrid-sync'`. Empty `catch {}` around git is forbidden.
- AC28: Filesystem and network errors in either channel **must not** crash or stop the MCP stdio server, SSE listener, status companion, or CLI mutation handlers. `logErrorReport` write failure itself is swallowed (existing error-logger contract).
- AC29: Persist machine-local `.sync/vault-git-state.json` with at least `{ dirty: boolean, lastError: string | null, lastSyncAt: string | null }`. Writes go through vault lock. File is gitignored (AC32). Analogous to hybrid-state; do not put this in `config.json`.
- AC30: Preserve hybrid traps: cwd-scoped push, debounce single-flight + trailing push, `writeHybridState` under vault lock, push cursor = `changeset.generatedAt` (not wall clock), per-project dirty flags, pre-pull since cursor for offline records. Dual orchestrator must not reset hybrid cursors on git-only failure.

### Gitignore, identity, remote mode

- AC31: `initVaultGit` ensures `.gitignore` contains at least: `memo.sqlite`, `memo.sqlite-wal`, `memo.sqlite-shm`, `.sync/`, `error.logs`, `telemetry/`. If `.gitignore` already exists, **append missing lines** (do not overwrite operator custom ignores).
- AC32: Hybrid state, vault-git state, SQLite, error logs, and telemetry are never staged by `commitVaultChange` / flush. `identity.ts` continues to ignore the vault root so vault-git is not confused with the consumer product repo.
- AC33: Vault-git remains disabled by default (`enabled` not set / false). Enabling still requires explicit `vaultGit.enabled: true`. Existing enabled installs without `atomic` become batched (AC1); this is an intentional cadence change from vault-git AC2.

### Status, doctor, docs

- AC34: `memo status` Operational Policies line reports vault-git as `Disabled` or `Enabled (atomic|batched) (<remoteUrl|local>)`. JSON `operational.vaultGit` includes `enabled`, `atomic` (effective boolean), `remoteUrl`, and when the state file exists `dirty` / `lastError` / `lastSyncAt`.
- AC35: `memo doctor --json` includes vault-git enabled/atomic/dirty/lastError without printing git credentials from `remoteUrl` userinfo if present (redact `user:pass@`). Hybrid doctor fields unchanged.
- AC36: README, AGENTS.md (sync table), and packaged `ws-memo` / `SURFACE.md` document: `atomic` default false; flush events; dual-mode `memo sync` runs both channels in parallel; fail-open; CLI one-shot needs explicit `memo sync` when batched.

### Tests (TDD)

- AC37: Add `src/vault-git-hybrid-sync.test.ts` and write failing tests before production code (TDD / `node:test`).
- AC38: Retarget tests that assert commit-on-every-upsert or hybrid-exclusive `memo sync`; keep `initVaultGit`, path allow-list, hybrid debounce/single-flight, daemon dryRun, and hybrid fail-open coverage.
- AC39: With batched vault-git, `append`, `forget`, `gc`, prompt `record` / `session_start`, recurrence backfill, import, and reset also create no git commit and do not pull/push.
- AC40: Human `memo sync` stdout prints a section per enabled channel; a failed channel sets `ok: false` and `error` without crashing the CLI process.
- AC41: Git `add`/`commit` and hybrid local apply may take the vault lock; both channels serialize on that lock with no nested acquire while holding it.
- AC42: `session_end` MCP/CLI returns the session payload as success even if both sync channels fail; channel errors go to logs and optional JSON `sync` field.
- AC43: On `session_end`, hybrid `flushDebouncedPushes` runs in parallel with the vault-git flush (no remaining debounce wait).
- AC44: Tests cover: batched upsert no commit; atomic upsert commits; dual `memo sync` runs both channels; git remote failure does not throw from upsert; hybrid failure does not skip git; lock not held during delayed fetch; session_end flush commits dirty batched tree; empty flush skips empty commit; invalid `atomic` does not crash; remote mode skips vault-git; dry-run does not commit.
- AC45: Full `npm test` is green after the slice; obsolete cases are replaced, not deleted without a successor assertion.

## Original Issue Context

Free-text (2026-09-01), after enabling vault-git on a machine whose `~/.spec-memo` is already a git repo (`origin` `http://192.168.0.102:8085/jone/spec-memo-vault.git`, branch `master`) while `mode` is `hybrid` (`remote.url` `http://192.168.0.3:3000`):

> add a spec to refine gitVault synchronization + hybrid mode (proxy) enabled
>
> It is an excellent idea having the gitvault feature but I think there is no need to in every upsert in memory triggering new commit/push to gitvault. add a configuration for gitvault: atomic: true/false (if true, then in every upsert data ingested in memory should trigger a git commit/push/sync to remote repository. False, it should by default commit/push/sync to git remote only in some events (manual sync or session end of agent).
>
> Make carefully works in dual mode: gitVault + hybrid mode (syncing to remote server) works seamlessly. It would be nice if the syncs could dispatch parallel sync if both are enabled. Make sure handling errors/concurrency, sync doesnot shutdowns by filesystem errors or network errors. Log all exceptions, handling gracefully the mcp server/spec-memo vault server.
>
> Preserve all features and tests, remove old and add new tests covering all scenarios. Use TDD.

### Prior Work Sweep

Keyword + `git log` on `src/vault.ts`, `src/hybrid-sync.ts`, `src/cli.ts`, `src/store.ts`, `src/tools.ts`. No open GitHub PR titled for this slug.

| Hit | Relation | Action |
|-----|----------|--------|
| [`vault-git.spec.md`](vault-git.spec.md) | Shipped init + per-mutation commit + `memo sync` → `syncVault` | Cadence AC2 superseded; keep init, isolation, gitignore-sqlite |
| [`deployment-modes.spec.md`](deployment-modes.spec.md) AC21 | `memo sync` hybrid-only | Change: dual dispatch when vault-git also enabled |
| Trap `hybrid-sync-dryrun-scope-lock` | dryRun, cwd projectId, single-flight, hybrid-state lock | Preserve; apply same single-flight to git remote |
| Trap `hybrid-push-cursor-generatedAt` | cursor must be `changeset.generatedAt` | Orchestrator must not set wall-clock cursors |
| Trap `hybrid-sync-must-isolate-per-project-dirty-flags-and-preserve-pre-pull-since-cursor` | per-project dirty + pre-pull since | Git failure must not wipe hybrid dirty/cursors |
| `VaultConfig.vaultGit.autoCommit` | Unused | Alias for `atomic` when `atomic` omitted |
| `commitVaultChange` / `syncVault` empty catch | Failures silent | Replace with `logErrorReport` |
| CLI `memo sync` hybrid-first return | Dual-mode hole | Orchestrator |

### Design Intent

Shipped vault-git **intentionally** micro-committed every upsert (spec assumption "Commit strategy: Micro-commit per record upsert/gc run", confirmed). That was not an accidental gap. This slice **reverses the default cadence** by operator request (`atomic: false`).

Shipped deployment-modes **intentionally** routed `memo sync` exclusively to hybrid HTTP when `mode === 'hybrid'` (AC21: "Works only when mode is hybrid"). That exclusive routing is the dual-mode bug relative to this request, not relative to the original hybrid spec. This slice **extends** AC21: hybrid still runs; vault-git also runs when enabled.

`identity.ts` ignoring vault root remains an intentional constraint (do not treat `~/.spec-memo` as the consumer product). Hybrid-state stays machine-local and gitignored (deployment-modes assumption).

## Notes

- Git repo may already exist (operator case). `initVaultGit` must be idempotent: do not `git init` over an existing repo; do set origin URL only when `remoteUrl` is configured; do not force-rename the current branch.
- Pull rebase conflicts: do not auto-resolve markdown. Mark dirty, log, skip push, leave conflict state for the operator. Hybrid apply continues. Do not `git merge --abort` unless the implementation started the rebase (if aborting, log and leave a clear lastError).
- Auth for git remotes is Git's own credential helper / URL; spec-memo does not persist git tokens in `config.json`.
- Activity bus / status monitor: emit a non-fatal activity event on dual sync start/finish when the bus exists; missing bus is not an error.
- TDD order: write failing tests for AC5, AC11, AC17, AC12, AC23 first; then orchestrator; then call-site wiring; then docs.

## Child Tasks

### Task 1 — Schema + status

- **Status:** todo
- **Description:** `atomic` on `VaultConfig`, merge/default, status JSON/text, doctor redaction.

### Task 2 — Git engine + state file

- **Status:** todo
- **Description:** batched skip-commit; atomic commit+sync; timeouts; logErrorReport; gitignore append; vault-git-state.json; single-flight.

### Task 3 — Dual orchestrator

- **Status:** todo
- **Description:** `memo sync` / session_end / shutdown; parallel channels; dry-run; combined report.

### Task 4 — Tests + docs

- **Status:** todo
- **Description:** new suite, retarget obsolete tests, README/AGENTS/ws-memo, full `npm test`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| CRDT / real-time OT between git and hybrid | Batch sync is the product contract |
| Auto-flush timer besides session_end / sync / shutdown | User named those events; extra timers add surprise commits |
| Git LFS, submodules, signed commits | Operator repo already works with stock git |
| Changing hybrid debounce window or cursor algorithm | Preserve shipped hybrid traps |
| New MCP tool for sync | Keep 11-tool surface; CLI `memo sync` + session_end hooks |
| Remote-mode local vault-git | Remote has zero local records |
| Rewriting `sync-vault` filesystem peer sync | Different command (`memo sync-vault`) |
| UI for resolving git conflicts | Operator uses git CLI; we fail-open and log |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default `atomic` | `false` | User: batched unless opted into per-upsert commit/push | y |
| `atomic: true` includes remote push, not commit-only | commit then pull --rebase then push | User: "git commit/push/sync to remote" | y |
| Batched flush events | `memo sync`, `session_end`, graceful serve shutdown | User named sync + session end; shutdown prevents lost uncommitted files on daemon stop | y |
| CLI one-shot exit | no auto-flush when batched | User did not name process-exit; avoids git from every `memo upsert` | y |
| Parallel dual sync | `Promise.allSettled`; isolate errors | User requested parallel; fail-open per channel | y |
| Lock vs network | lock only for local FS; not during fetch/git network | Prevents MCP stall and hybrid/git deadlock | y |
| Git timeout | `SPEC_MEMO_SYNC_TIMEOUT_MS` or 30000 | Reuse hybrid timeout; no hung `git push` | y |
| Conflict policy | no auto-rebase continue; dirty + lastError | Markdown conflicts need a human | y |
| `autoCommit` alias | maps to `atomic` if `atomic` omitted | Unused field; avoid silent ignore | y |
| Breaking cadence vs vault-git AC2 | yes, default batched | Explicit operator request; document in README | y |
| Auth / rate limits | N/A because git uses existing remote auth; hybrid reuses bearer; no new limiter | Same as parent specs | y |
| Data lifecycle | `.sync/vault-git-state.json` TTL none; gitignored | Machine-local like hybrid-state | y |
| Idempotent flush | skip empty commit; push still attempted if remoteUrl set | Avoid noise; still propagate already-committed history | y |
| Input validation | non-boolean `atomic` → false | Fail open; status shows effective value | y |
| Observability | error.logs + telemetry + state file + status/doctor | User: log all exceptions; do not crash servers | y |
| State-transition | enabled=false ignores atomic; remote mode ignores vault-git | Clear matrix | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Config `atomic`, batched vs atomic cadence, dual orchestrator, fail-open logging, tests/docs. No CRDT, no new MCP tool | Spec Out of Scope table vs planned files |
| Atomic criteria | AC1–AC45 are pass/fail with named commands and file touchpoints | `validate_spec.cjs --mode=authoring`; implementation maps one test per AC cluster |
| Failure modes | Git timeout, push reject, hybrid 5xx, lock contention, ENOENT, rebase conflict, log write fail, shutdown timeout | Negative tests in AC44 |
| Observation telemetry | `logErrorReport` subsystem `vault-git`; `memo status` atomic/dirty; doctor JSON | Named commands below |
| Open blockers | N/A because defaults in Assumptions are sufficient to implement without a further product interview | Review Assumptions Confirmed column |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo status` / `memo status --json`: `operational.vaultGit.atomic` is `false` by default when enabled without the key.
- `memo doctor --json`: vault-git `dirty` / `lastError` after a forced git failure.
- `error.logs` lines with `"subsystem":"vault-git"` after simulated `git push` failure.
- `node --test dist/vault-git-hybrid-sync.test.js` plus `npm test` (full suite).
- `memo sync --json` with hybrid+vaultGit fixtures: both `hybrid` and `vaultGit` keys present; killing the git remote still returns hybrid counts.
- Telemetry events (when `enableTelemetry: true`) for sync duration/error code on both channels.

### Negative & Failing Test Scenarios

- Batched mode: upsert then `git log -1 --oneline` does **not** contain `upsert trap:` (red until AC5).
- Atomic mode: git `push` child killed/timeout; upsert MCP result is still `ok` (red until AC12).
- Dual `memo sync`: hybrid fetch aborted; vault-git commit still happens (red until AC17/AC19).
- Dual `memo sync`: git pull conflict; hybrid push still scheduled/applied (red until AC17).
- `atomic: "yes"` in config.json does not throw on upsert (red until AC4).
- Shutdown with hung `git push` still closes MCP before 8000 ms + buffer (red until AC24/AC26).
- Existing `deployment-modes.test.ts` "CLI sync fails in local mode without vaultGit" remains red if accidentally always succeeding.
