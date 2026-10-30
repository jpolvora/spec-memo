---
id: null
slug: memo-shutdown
title: "memo shutdown command for stopping orphaned MCP servers"
source: local
specDate: 2026-09-12
---

# Specification — memo shutdown command for stopping orphaned MCP servers

## Description

Editors and IDEs do not always stop the spec-memo MCP server when they exit. Observed case: Cursor updates or exits while a previous `memo serve --vaultRoot C:\Users\jpolv\.spec-memo` (stdio) run keeps running, holding the vault lock and stale in-memory buffers. The operator needs a single local command, `memo shutdown`, that finds every running memo serve instance on the machine, asks it to exit gracefully (so existing `SIGINT`/`SIGTERM` handlers run: `close()`, `flushOnShutdown` with `trigger: 'shutdown'`, telemetry drain, activity-bus close), waits briefly, and only then force-terminates survivors. After restart, normal `bootstrap` pull and `memo sync` resume persistence; shutdown itself never requires network access.

Architecture touchpoints:

- **CLI (`src/cli.ts`):** new `shutdown` command (alias `stop`) with flags `--vaultRoot`, `--timeout-ms`, `--force`, `--dry-run`, `--include-canvas`, `--json`. Input parsed through the existing CLI schema path; help text documents orphaned-IDE recovery.
- **Discovery (`src/shutdown.ts` new):** cross-platform process enumeration by command line. Match only memo serve family: command lines containing `spec-memo` plus `dist/cli.js` (or `dist/mcp.js`) plus the `serve` token. Never match unrelated `node` work (`ng serve`, `yarn dev`, `yarn test`). Exclude the invoking process PID itself. On Windows use CIM/`tasklist`-equivalent via Node; on POSIX use `ps`. No PID file in v1.
- **Signal path (`src/shutdown.ts`, reuse `src/dual-sync.ts`, `src/mcp.ts`, `src/server.ts`):** default graceful `SIGTERM` through `process.kill(pid, 'SIGTERM')`, poll for exit up to the timeout (default 8000 ms, same cap as `getShutdownFlushMs()` / `SPEC_MEMO_SYNC_TIMEOUT_MS`), then force kill (`SIGKILL` / `taskkill /F` equivalent) only for survivors or immediately when `--force` is set. Each target's own shutdown handlers perform the vault-git plus hybrid flush fail-open; the shutdown invoker does not write vault records itself.
- **Scope (`src/cli.ts`, `src/shutdown.ts`):** default stops stdio `memo serve` plus SSE `memo serve --sse` for all vault roots. `--vaultRoot <path>` narrows to instances whose command line contains that root. `memo canvas` is excluded by default and included only with `--include-canvas`.
- **Reporting (`src/cli.ts`, `src/status-cmd.ts` reuse):** human stdout lists each PID with matched command and per-PID result (`stopped-graceful`, `stopped-forced`, `already-exited`, `skipped-self`, `failed`); `--json` emits the same array plus summary counts. Exit `0` when nothing was running or every target stopped or exited; non-zero only for invalid flags or when at least one targeted PID survives after the force path.
- **Docs (`README.md`, `AGENTS.md`, packaged `ws-memo` `SKILL.md` / `SURFACE.md`):** document `memo shutdown` as the orphaned-server recovery step before IDE update or restart, with `--dry-run` preview and the note that post-restart persistence resumes via `bootstrap` / `memo sync`.

## Acceptance Criteria

- AC1: `memo shutdown` exists as a CLI command with alias `memo stop`, appears in `memo --help` under Utility Commands, and accepts `--vaultRoot <path>`, `--timeout-ms <n>`, `--force`, `--dry-run`, `--include-canvas`, `--json`; unknown flags exit non-zero with usage text.
- AC2: Discovery matches only the memo serve family: a process qualifies only when its command line contains both a spec-memo server marker (`spec-memo` with `dist/cli.js` or `dist/mcp.js`) and the `serve` token; `ng serve`, `yarn dev`, `yarn test`, and other `node` processes never qualify even when they contain the substring `serve`.
- AC3: Default run stops stdio `memo serve` and SSE `memo serve --sse` for every vault root; `memo canvas` / `serve-canvas` processes are left running unless `--include-canvas` is passed.
- AC4: Default kill path sends `SIGTERM` to each target PID and polls up to the effective timeout, reporting `stopped-graceful` for PIDs that exit inside the window.
- AC5: Survivors after the graceful window are force-terminated as `stopped-forced`; PIDs that exit alone are `already-exited`; effective timeout is `--timeout-ms`, else `SPEC_MEMO_SYNC_TIMEOUT_MS`, else 8000 ms.
- AC6: `--force` skips the graceful wait and force-terminates matched PIDs immediately; `--dry-run` lists matched PIDs with full command lines and takes no kill action with exit `0`.
- AC7: `--vaultRoot <path>` narrows targets to instances whose command line contains that vault-root string (normalized for path separators); instances for other roots are left running and omitted from the kill set but noted in verbose output.
- AC8: The invoker never kills itself (own PID is reported as `skipped-self`), never kills PID 1 or PID 0, and never kills a PID whose command line cannot be read or no longer matches at kill time; unreadable entries are reported as skipped with a reason.
- AC9: `--json` emits `{ ok, dryRun, timeoutMs, targets, summary }` with per-PID `result` values and summary counts; `ok` is true when every matched target ended stopped, already-exited, or skipped.
- AC10: Shutdown is idempotent: a second `memo shutdown` with no memo serve processes running exits `0` and reports zero matched targets in both human and `--json` modes.
- AC11: New automated tests cover discovery filtering (memo serve matched, `ng serve` / `yarn` excluded, self-PID excluded), `--dry-run` no-kill behavior, `--vaultRoot` scoping, graceful-then-force transition with a stubbed signal layer, `--json` shape, and idempotent empty run; `npm run build` is clean and full `npm test` passes with zero regressions.
- AC12: `README.md`, `AGENTS.md`, and packaged `ws-memo` command reference document `memo shutdown` with the orphaned Cursor IDE recovery flow (`memo shutdown --dry-run`, then `memo shutdown`, verify with `memo status`, restart IDE or `memo serve`, resume with `memo sync` when batched vault-git is enabled).

## Original Issue Context

Operator request (verbatim intent): create a `memo shutdown` command for stopping all instances of memo process because sometimes editors/IDEs do not stop the MCP server in local or hybrid mode. Concrete trigger: updating Cursor IDE while a previous MCP run keeps running after exiting the IDE. Expected flow: call `memo shutdown` to gracefully shut down, save local buffers, and sync later after restarting MCP.

Manual evidence from this machine (2026-09-12): orphaned stdio server `node G:\packages\npm\node_modules\spec-memo\dist\cli.js serve --vaultRoot C:\Users\jpolv\.spec-memo` (PID 14208, parent `cmd.exe` PID 37200 wrapping `memo serve`) survived IDE exit and had to be removed with `Stop-Process -Id 14208`. Hard kill bypasses the graceful `close()` plus `flushOnShutdown` path, so a purpose-built graceful command is needed.

### Prior Work Sweep

- Keyword plus `git log` sweep on `src/cli.ts`, `src/mcp.ts`, `src/server.ts`, `src/dual-sync.ts` for `shutdown`, `SIGINT`, `SIGTERM`, `flushOnShutdown`, `serve stop`: graceful signal handling exists (`process.once SIGINT/SIGTERM` closing SSE/canvas instances since `abc126f` at `v0.1.0`; `flushOnShutdown` with `trigger: 'shutdown'` plus 8s cap shipped in `4d62c82` at `v0.16.0` and wired into `src/mcp.ts close()` and `src/server.ts close()`); no `parsed.command === 'stop' | 'shutdown' | 'kill'` exists and `memo --help` lists no stop-family command.
- Related specs recorded and continued: `0043-mcp-sse-transport` AC4 (graceful shutdown on signals), `0023-mcp-status-monitor` AC13/AC44 (SSE plus companion plus bus close), `0028-operational-telemetry` AC12 (telemetry drain on shutdown hooks), `0033-vault-git-hybrid-sync` AC8/AC15/AC24 (dual flush on shutdown trigger), `0035-sync-conflict-reconciliation` AC25 (background worker shutdown without orphaned journals), `0031-memo-status` Out of Scope (daemon lifecycle owned by `memo serve` plus process managers; `status` only reports `STOPPED`).
- Provider PR search (`gh pr list --repo jpolvora/spec-memo --search shutdown/stop daemon serve`): no open PR for a shutdown command. No exact same-issue open PR; no stop or reuse gate triggered. Duplicate risk: low.
- `0052-us-54` and `0051-us-55` note status-monitor shutdown behavior as owned by issue 56; no `us-56` spec file exists yet. This spec does not claim that follow-up.

### Design Intent

Greenfield skip with reason: there is no prior `memo shutdown` symbol to restore (`git log -S shutdown` shows only signal-handler and flush Plumbing, never a CLI stop command). `0031-memo-status` intentionally left daemon start and stop to `memo serve` plus systemd or Task Scheduler. The gap is a missing operator affordance for orphaned local processes, not a regression of an intentional constraint. This spec adds the affordance without changing the refusal posture of `status` or the read-only status monitor.

## Notes

- Touchpoints: new `src/shutdown.ts` (discovery plus signal plus wait plus report), `src/cli.ts` (command routing, flag schema, human and `--json` output), `src/cli.test.ts` and new `src/shutdown.test.ts` (filtering, scoping, dry-run, signal-layer stub, JSON shape), docs (`README.md`, `AGENTS.md`, `.agents/skills/ws-memo/SKILL.md`, `.agents/skills/ws-memo/references/SURFACE.md`).
- Reuse before invent: effective timeout resolution follows `getShutdownFlushMs()` precedence (`--timeout-ms` wins, then `SPEC_MEMO_SYNC_TIMEOUT_MS`, then 8000 ms default); result vocabulary mirrors existing sync and status reporting (`ok`, per-target `error` strings without stack leaks).
- Traps honored: never broaden the process match beyond the serve family; quote and normalize Windows paths before substring comparison; always `await` signal, poll, and kill promises; close all handles in `finally`; redact vault-root userinfo if ever echoed.
- Stack (`typescript-node`): no unchecked `any` in new code, zero floating promises on kill plus poll paths, Zod or equivalent schema validation on `--timeout-ms` and `--vaultRoot` inputs, `path.resolve` containment when normalizing the scope root, `npm run build` plus invariant scan clean.

## Out of Scope

| Feature | Reason |
|---------|--------|
| PID-file daemon registry or new HTTP shutdown endpoint | Adds state and auth surface; v1 uses command-line discovery plus OS signals only |
| Remote-daemon shutdown over HTTP | Shutdown is local-process only; remote mode has no local serve process to stop |
| Auto-restart of `memo serve` after shutdown | Restart stays with the IDE host, systemd, or Task Scheduler per `0031` lifecycle ownership |
| Killing `memo canvas` by default | Graph UI is a separate interactive session; opt-in via `--include-canvas` only |
| Forced `memo sync` inside shutdown | Flush stays fail-open inside each target's own handlers; post-restart sync is explicit via `memo sync` or `session_end` |
| `memo status` gaining start or stop powers | `status` stays read-only per `0031`; this spec adds a separate command |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Match rule is command-line substring on the serve family | Qualify only on spec-memo server marker plus `serve` token | Precise enough to catch global installs and `node dist/cli.js` fallbacks without a registry | y |
| Graceful wait default | 8000 ms from `--timeout-ms`, else `SPEC_MEMO_SYNC_TIMEOUT_MS`, else 8000 | Matches the existing shutdown-flush cap so handlers finish before force | y |
| Vault-root scope comparison | Normalized case-aware substring on the raw command line | Avoids resolving PIDs to config files that may already be closing | y |
| Canvas excluded by default | `--include-canvas` opts in | Prevents surprise loss of an interactive graph session | y |
| Exit-code contract | `0` on empty set or all targets settled; non-zero on invalid flags or surviving targets | Keeps scripts simple while surfacing real failures | y |
| N/A because dimensions absent | Auth boundaries, rate limits, TTL and expiry, and state-transition guards collapse here | Local single-user process signal path with no network auth, no throttling, no record lifecycle, and no transition machine beyond running versus exited | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Only `memo shutdown` (`stop` alias), discovery plus graceful-then-force plus scoped reporting, docs, and tests | `git diff --stat` shows `src/shutdown.ts`, `src/cli.ts`, shutdown tests, spec, and docs only |
| Atomic criteria | AC1–AC12 each independently testable | Map each AC to a test or manual command in Validation Notes |
| Failure modes covered | Orphaned stdio plus SSE, unrelated `node` exclusion, self-PID exclusion, survivor after graceful window, invalid timeout, empty second run | Stubbed-signal tests plus manual orphan repro below |
| Stack invariants | Zero new `any`, awaited kill and poll promises, validated CLI inputs, contained scope paths, clean build | `npm run build`, `node .agents/skills/ws-shared/runtime/scripts/scan_stack_invariants.cjs --stack typescript-node` or global fallback, test suite |
| Zero open blockers | Local-only repro with no IDE or network dependency | Manual repro uses a directly spawned `memo serve` background process |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `npm run build` clean (typecheck plus emit to `dist/`).
- `node --test dist/shutdown.test.js dist/cli.test.js` green, plus full `npm test` with zero regressions.
- Manual orphan repro: start `node dist/cli.js serve --vaultRoot <temp-vault>` in the background, run `memo shutdown --dry-run` to preview the PID, run `memo shutdown` to stop it gracefully, confirm `memo status` reports `STOPPED` for local services and a second `memo shutdown --json` reports zero matched targets with `ok: true`.
- Manual scope repro: two background serves with distinct `--vaultRoot` values, `memo shutdown --vaultRoot <one>` stops only that PID while the other keeps running.

### Negative & Failing Test Scenarios

- Unrelated `node` survivor without fix: `ng serve` plus `yarn dev` PIDs match a naive `serve` substring and get killed; after fix the same fixture leaves them running while memo serve PIDs stop.
- Hard-kill-only without fix: targets die via force path and skip `flushOnShutdown`; after fix the default path sends `SIGTERM` first and reports `stopped-graceful` with the vault tree clean.
- Self-kill without fix: the invoker matches its own `memo shutdown` command line and terminates itself; after fix its own PID is reported as `skipped-self` and the process completes.
- Invalid timeout without fix: `--timeout-ms abc` is accepted and hangs the wait loop; after fix schema validation rejects it with usage text and a non-zero exit.
- Survivor without fix: a stubbed target that ignores `SIGTERM` is reported as stopped although still alive; after fix it is force-terminated and reported as `stopped-forced`, or as `failed` with non-zero exit when it survives even the force path.
