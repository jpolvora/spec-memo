# Server Lifecycle

## Feature Overview

Editors and IDEs do not always stop the `spec-memo` MCP server when they exit, leaving orphaned `memo serve` processes that hold the vault lock and stale in-memory buffers. `memo shutdown` (alias `memo stop`) is a local, network-free recovery command that discovers every running memo serve process on the machine, asks it to exit gracefully so its own handlers run (`close()`, fail-open `flushOnShutdown` with `trigger: 'shutdown'`, telemetry drain, activity-bus close), waits, and only then force-terminates survivors.

Typical flow: `memo shutdown --dry-run` to preview, `memo shutdown` to stop gracefully, verify with `memo status`, then restart the IDE or `memo serve` and resume persistence with `memo sync` when batched vault-git is enabled. After restart, bootstrap pull and `memo sync` resume normal operation.

## Business Rules & Logic

- **Discovery match** (`isMemoServeCommand`): a process qualifies only when its command line contains a spec-memo server marker (`spec-memo` plus `dist/cli.js` or `dist/mcp.js`) **and** the standalone `serve` token. `ng serve`, `yarn dev`, `yarn test`, and other `node` processes never qualify. Canvas processes (`memo canvas` / `serve-canvas`, same marker + case-insensitive `canvas`) classify as `canvas`.
- **Scope:** default stops stdio `memo serve` plus SSE `memo serve --sse` for all vault roots. `memo canvas` is excluded unless `--include-canvas` is passed. `--vaultRoot <path>` narrows to instances whose command line contains that root, matched at a path-segment boundary after slash normalization (so `.../.spec-memo-backup` does not match scope `.../.spec-memo`).
- **Kill path:** default `SIGTERM` to each target PID, then poll for exit up to the effective timeout; exits inside the window report `stopped-graceful`. Survivors are force-terminated (`SIGKILL`) and report `stopped-forced`, or `failed` if they survive force. `--force` skips the graceful wait and force-terminates immediately. `--dry-run` lists matched PIDs with full command lines and takes no kill action.
- **Timeout resolution:** `--timeout-ms <n>` (must be a finite positive number) > `SPEC_MEMO_SYNC_TIMEOUT_MS` > `8000` ms.
- **Safety:** the invoker never kills itself (own PID reported `skipped-self`), never kills PID 0 or 1, and never kills a PID whose command line cannot be read or no longer matches at kill time (unreadable/mismatched entries are `skipped`). Before a lethal signal, the default `verifyTarget` re-lists processes and requires the same PID, command, and scope, guarding against PID reuse between discovery and kill.
- Result vocabulary: `stopped-graceful`, `stopped-forced`, `already-exited`, `skipped-self`, `skipped`, `failed`. PIDs that have already exited are `already-exited`.
- Exit codes: `0` when nothing matched or every matched target ended stopped/already-exited/skipped; non-zero for invalid flags or at least one target still `failed`. A second `memo shutdown` with no serving processes is idempotent: `0` with zero targets.
- Bearer material is redacted from reported command lines: `--auth-token <value>` is replaced with `--auth-token [REDACTED]` before stdout or `--json` output.
- The invoker itself never writes vault records; each target's own shutdown handlers perform the git + hybrid flush fail-open. `memo status` keeps its read-only posture and does not gain start/stop powers.

## Technical Architecture

- `src/shutdown.ts`: `listMemoProcesses` (Windows via PowerShell `Get-CimInstance Win32_Process`; POSIX via `ps -ax -o pid=,args=`), `isMemoServeCommand`, `isCanvasCommand`, `classifyMemoCommand`, `matchesScopeRoot`, `filterShutdownTargets`, `redactCommandForDisplay`, `resolveShutdownTimeoutMs`, `defaultSignalOps` (`kill`/`isAlive`/`sleep`), `runShutdown`. `isAlive` treats `EPERM` as alive.
- `runShutdown` returns `{ report, exitCode }`; `report` is `{ ok, dryRun, timeoutMs, targets, summary }` with per-target `{ pid, command, scope, result, reason? }` and summary counts (`stoppedGraceful`, `stoppedForced`, `alreadyExited`, `skipped`, `failed`). Kill/poll logic is awaited; force confirmation waits up to 1000 ms.
- CLI (`src/cli.ts`): `memo shutdown`/`memo stop` accepts `--vaultRoot`, `--timeout-ms`, `--force`, `--dry-run`, `--include-canvas`, `--json`; unknown flags exit non-zero with usage. Human output lists one line per PID with its result; `--json` emits the full report plus summary counts. Help lives under Utility Commands.
- Graceful shutdown target handlers: SSE `memo serve --sse` `close()` (in `src/server.ts`) runs `flushOnShutdown`, closes the activity bus and status companion, closes transports, and drains telemetry; stdio `memo serve` `close()` (in `src/mcp.ts`) runs `flushOnShutdown` then `server.close()`. `src/dual-sync.ts` `flushOnShutdown` caps the wait and never throws.
- No PID-file registry, no HTTP shutdown endpoint, no auto-restart. Remote-daemon shutdown is out of scope; shutdown is local-process only.
- Provenance: `0053-memo-shutdown.spec.md` (issue #56). Related signal plumbing originated in `0043-mcp-sse-transport.spec.md` and `0033-vault-git-hybrid-sync.spec.md`. See [SSE Transport](sse-transport.md) and [Vault Sync](vault-sync.md).
