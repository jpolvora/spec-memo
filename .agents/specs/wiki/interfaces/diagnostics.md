# Diagnostics (`memo doctor`)

## Feature Overview

`memo doctor` is the vault and repository health gate. It verifies the vault root, SQLite FTS index, project binding, and scans the consumer working tree for leaked workflow artifacts. It is CLI-only (no MCP tool) and implemented in `src/doctor.ts` (`runDoctor`).

Journeys:

- Health gate in CI or before shipping: `memo doctor` exits 0 when healthy and clean, 1 otherwise.
- Machine consumption: `memo doctor --json` emits the full `DoctorResult`.
- Boundary check for one path: `memo doctor --check-capture <path>` prints `CAPTURED` or `IGNORED (matched line N: <pattern>, source: ...)`.
- Repair: `memo doctor --rebuild` rebuilds FTS; `memo doctor --fix` deletes untracked in-tree residue (skipping git-tracked files unless `--include-tracked`).

## Business Rules & Logic

- Vault structure: warns when the vault root directory does not exist.
- FTS index: opens `memo.sqlite`, counts rows in `records_fts`; a missing database is a warning, an open error is reported as a SQLite warning. `--rebuild` calls `rebuildIndex`, sets `fts.healthy = true`, and marks `fts.rebuilt`.
- Project binding: `resolveProjectIdentity` resolves project id, git remote, root path, `isGit`, and `isFallback`. A fallback path id (no git remote) produces a warning that moving/renaming the repo changes the id.
- Pollution scan (`scanForRepoPollution`): recursively walks the product root (max depth 6) skipping `node_modules`, `.git`, `dist`, `build`, and `.spec-memo`. If the scan root equals the vault root or is inside it, the scan returns empty (the vault is where records belong). Detected types:
  - `plan_residue`: `.agents/plans/` or `agents/plans/`.
  - `memory_residue`: `MEMORY.md`, `*/MEMORY.md`, `memory/`, `.agents/memory/`, `ws-shared/memory/`.
  - `state_residue`: `run.json` matched on a filename boundary via `/(^|\/)run\.json$/` against the lowercased posix relative path (so `Default.abprun.json` is not flagged), plus `.state.md`.
  - `telemetry_residue`: `telemetry.jsonl`, `/telemetry/`, `telemetry/`.
  - `log_residue`: `audit-*.log.md`, `.agents/*.log`.
- Ignore boundary: every candidate is filtered through `evaluatePathIgnore` (the same `loadIgnoreRules` / `isPathIgnored` boundary used by `--check-capture`), honoring the product `.spec-memo-ignore` marker and vault `config.json` `projects.{id}.ignorePaths`. Ignored candidates never appear in `items`; they increment `pollution.excludedByIgnoreCount`. This lets a dual-mode repo with live `.agents/plans/`, `ws-shared/memory/`, and a tracked root `MEMORY.md` reach `healthy: true` once those paths are covered by ignore rules.
- `--fix` deletion safety: untracked residue is unlinked. Files reported by `git ls-files -z` are tracked and skipped by default, collected in `pollution.skippedTracked`, and summarized in a warning. Only `--include-tracked` deletes them (and then they are listed in a warning). If tracked status cannot be determined (non-zero `git ls-files`), every candidate is treated as tracked so nothing is deleted on ambiguity.
- `--fix` also cleans only semantically identical conflict sidecars, then rebuilds FTS and affected compiled views. Divergent sidecars require `memo reconcile --prefer local|remote --clean-sidecars`.
- Agent hooks: `inspectAgentHooks` reports installed hosts and warnings for outdated templates compared to the running package version.
- Additional diagnostics when FTS is healthy: active semantic contradictions and potentially obsolete traps/decisions (salience).
- Healthy definition: `vaultExists && ftsHealthy && pollutionItems.length === 0`. In `remote` mode this definition is **replaced** (not augmented): health requires the remote `/health` probe to be reachable, a token to be configured, and zero pollution; `vaultExists`/`ftsHealthy` are not part of the remote result. The CLI exits `result.healthy ? 0 : 1`.
- Warning-only cases: hybrid/remote mode without a URL, missing bearer token, unreachable remote daemon, invalid `.spec-memo-ignore` lines, and detected conflict sidecars.
- Exit contract: 0 for healthy/clean, 1 for issues (pollution, unhealthy FTS, unreachable remote in remote mode) — standard CI/CD diagnostic convention.
- `--check-capture` formatting: `CAPTURED (no ignore rule matched)` or `IGNORED (matched line N: <pattern>, source: .spec-memo-ignore|config.json|builtin)`; `source: builtin` reflects `DEFAULT_IGNORE_PATTERNS` (e.g. `.git/`, `node_modules/`, `*.sqlite`).
- Negative scenarios handled without crashing or hanging: all daemons stopped (`STOPPED`, no ECONNREFUSED), malformed `config.json` (reported, not thrown), unbound non-git directory (fallback path id reported), and offline remote daemon (UNREACHABLE with message).
- Live probe timeouts: `runDoctor` uses a 10 s default for the remote `/health` probe (`DEFAULT_HEALTH_TIMEOUT_MS`, overridable via `SPEC_MEMO_HEALTH_TIMEOUT_MS` / `SPEC_MEMO_SYNC_TIMEOUT_MS`). The 1500 ms per-local-endpoint `probeHttpService` and 3000 ms remote helper belong to `memo status` (`src/status-cmd.ts`), not `doctor`. `--check-capture` runs no network probes.

## Technical Architecture

`runDoctor(options: DoctorOptions)` accepts `cwd`, `vaultRoot`, `productRoot`, `rebuild`, `fix`, `checkCapture`, and `includeTracked`. It returns `DoctorResult` containing `healthy`, `vaultRoot`, `vaultExists`, `mode`, `remoteUrl`, `tokenConfigured`, `hybridState`, `vaultGit`, `remoteHealth`, `project`, `fts`, `pollution`, `agentHooks`, `exclusionBoundary`, `warnings`, `summary`, `semanticContradictions`, and `potentiallyObsolete`.

`--check-capture` short-circuits all other checks: it calls `checkCapturePath` with the resolved project id and returns an early result where `healthy` means `status === 'CAPTURED'`, includes the serialized `captureCheck`, and formats the summary with `formatCheckCaptureResult`.

Key helpers: `findFilesRecursive`, `listTrackedFiles` (returns an empty set outside git, `null` when git status is indeterminate), `wrapSqliteOpenError`, and `checkRemoteHealth` (10 s default timeout via `SPEC_MEMO_HEALTH_TIMEOUT_MS` / `SPEC_MEMO_SYNC_TIMEOUT_MS`).

CLI surface: `memo doctor` prints a text report with mode, remote origin/health, vault location, project id, product root, FTS count, agent hooks summary, exclusion boundary, pollution list, skipped-tracked list, warnings, contradictions, obsolete records, and summary. `--json` emits `DoctorResult` unchanged.

Provenance: `0005-import-and-doctor.spec.md`, `0009-cli-doctor.spec.md`, `0052-us-54.spec.md`.
