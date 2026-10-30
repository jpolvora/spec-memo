# AGENTS.md — spec-memo agent contract

**Audience: agents.** Humans: [`README.md`](README.md).

This document is the operating contract for coding agents working in and with **spec-memo**. It defines session startup, testing, tool usage, health diagnostics (`doctor`), HTTP/SSE serve + status monitor checks, autoboot service guidance, git boundaries, task tracking, and **ship via `sdw-ship-pr`** (version bump required before every PR).

**Humans / operators** (install, autoboot systemd/Task Scheduler, favorite status URL): [`README.md`](README.md).

**Language:** `en-us` only for product docs, schemas, CLI help, MCP descriptions, tests, and commit messages.

---

## Precedence (highest first)

1. Explicit user instructions (current turn)
2. This root `AGENTS.md` / [`GEMINI.md`](GEMINI.md) operating contract
3. Design & architecture constraints ([`PRODUCT.PRD`](PRODUCT.PRD), [`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), [`.agents/specs/index.PRD`](.agents/specs/index.PRD), [`.agents/specs/*.spec.md`](.agents/specs/))
4. Autoload (Always-applied) skills (§ Autoload below)

---

## Autoload (Always-applied skills)

Load exactly these **two** skills on every prompt, every session — they are the only Always-applied members:

| Skill | Path | Trigger | Role |
|---|---|---|---|
| `sdw-router` | `{skillsRoot}/sdw-router/SKILL.md` | Every prompt | Dispatch intent across SDW skills; pass unrecognized work through untouched |
| `sdw-rules` | `{skillsRoot}/sdw-rules/SKILL.md` | Every prompt | Non-negotiable rules: plan before unsolicited change, explicit authorization, YAGNI, surgical scope, empirical verification |

Every other SDW skill is progressive disclosure: it loads on demand through `sdw-router`, never at session start. Hybrid installs resolve the same ids under `{globalSkillsRoot}` when they are absent locally.

---

## SDW Router & Progressive Disclosure

`sdw-router` is the entry point for workflow intents. When the user mentions specs, plans, implementation, review, or shipping without naming a skill, route the intent and load **only** the matching skill (matrix: `{skillsRoot}/sdw-router/SKILL.md` § Routing Matrix):

| When the task means… | Load | Does not do |
|---|---|---|
| Configuration, `.sdw/config.json`, workspace layout | `sdw-config` | Does not implement product code |
| Author, grill, validate, index, sync, or archive specs | `sdw-spec` | Does not implement specifications |
| Deliver one spec end to end (blueprint → DAG tasks → score → review → PR) | `sdw-run` | One spec per run; does not queue specs |
| Queue several specs sequentially | `sdw-batch` | Delegates each item to `sdw-run`; never refines |
| Deep working-tree code review and executable fix plan | `sdw-code-review` | Does not remediate; findings go to `sdw-fixer` |
| Surgical remediation of review or verification findings | `sdw-fixer` | Never self-approves; reviewer and fixer stay separate |
| Pre-commit secrets / credentials / PII gate | `sdw-security-checks` | Scans and blocks; does not fix |
| Ship / PR, including “ship next version” | `sdw-ship-pr` | Does not invent scope; **always bump version before create-pr** |
| Traps / gaps / patterns / errors knowledge | `sdw-memory` | Single memory path; no direct vault or `traps.md` edits |
| Completed-task history | `sdw-changelog` | Append-only; never rewrites history |
| Installation and workspace health | `sdw-doctor` | Read-only audit |
| Retrospective over a completed run | `sdw-retro` | Reports friction and candidates; changes nothing |

### spec-memo runtime (product)

The memory backend is the spec-memo vault; `sdw-memory` is the only skill that reads or writes it.

- **Knowledge continuity (`sdw-memory`):** queries and records traps/gaps/patterns/errors; the default backend is the vault through the `memo` CLI / MCP (fallback `.sdw/memory/traps.md`). It injects anti-regression traps, architectural decisions, and active specs before planning.
- **Run and session continuity:** MCP/CLI `prompt` (`session_start` / `session_end`) records prompt turns, deliverables (PRs, commits), and handoff batons; `sdw-run` persists run state in `.sdw/state/{runId}.state.json`; `sdw-retro` reports friction after a completed run.
- **Configuration:** `sdw-config` owns `.sdw/config.json` (`specsDir`, `memory.backends`, SCM, verification gates). Do not write `specMemo.*` or harness flags through `sdw-memory`.

---

## 🚀 Session Start & Hook Detection Protocol

Agents must detect whether host lifecycle hooks are installed and adapt their workflow:

1. **Detect Operating Mode:**
   - **Hook-Automated Mode (Hooks Installed):** Harness lifecycle hooks (Antigravity `hooks.json`, OpenCode plugin, Cursor `.cursor/rules/spec-memo.mdc`, or Claude hooks) have already executed `bootstrap` out-of-band and pre-injected the brief into the turn context.
     - *Action:* Do **not** call `memo bootstrap` redundantly on Turn 1 unless changing focus `--path` or `--slug`. Inspect and apply active traps immediately.
   - **Skill-Only Mode (Hooks Not Installed — Default):** No host hooks are installed.
     - *Action:* The agent **MUST** proactively call `bootstrap` MCP tool or `memo bootstrap` on Turn 1 with `cwd = product root` to retrieve traps, decisions, and active spec slice before planning or coding. Skill-only mode is 100% first-class; never fail or warn about missing hooks.
2. **Session Tracking & Handoffs:**
   - On startup: Read and address any active handoff baton passed from previous sessions. In Skill-Only mode, invoke `prompt` `action: 'session_start'`.
   - On completion: Always call `prompt` `action: 'session_end'` (or `memo session end`) with structured `deliverables` (PR URLs, commit SHAs) and tactical `handoff` for the next agent.
3. **Review Product Docs:** Check [`PRODUCT.PRD`](PRODUCT.PRD), [`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), and [`.agents/specs/index.PRD`](.agents/specs/index.PRD) for active phase constraints and slice definitions.
4. **Respect Git Boundaries:** Never create in-repo `.agents/plans/`, `MEMORY.md`, `.state.md`, or session log dumps in the product repository.

---

## 🧪 How to Test & Build

All tests run via the native Node.js test runner (`node:test`).

### 1. Build and Typecheck
```bash
# Typecheck and build TypeScript to dist/
npm run build

# Continuous watch mode during development
npm run watch
```

### 2. Run the Full Test Suite
```bash
# Runs full pretest build and all 34 test suites (357 tests)
npm test
```

### 3. Run Targeted Subsystem Test Suites
Execute specific test files directly for faster iteration:

```bash
# Operational Status, Live Daemon Probes & Config Inspection
node --test dist/status-cmd.test.js

# Doctor & Repository Pollution Diagnostics
node --test dist/doctor.test.js

# Bootstrap Brief Engine & Drift Detection
node --test dist/bootstrap.test.js

# Store Engine (Upsert, Get, Superseding, Deduplication)
node --test dist/store.test.js

# CLI Command Router & Argument Normalization
node --test dist/cli.test.js

# SQLite FTS5 Indexing & Search Engine
node --test dist/indexer.test.js

# Curator GC, TTL Retention & Plan Compaction
node --test dist/curator.test.js

# Safety Engine & Secret Redaction
node --test dist/safety.test.js

# Vault Backup, AES-256-GCM Encryption & Restore
node --test dist/backup.test.js

# Legacy Workflow Tree Importer
node --test dist/importer.test.js

# Write-Block Pre-Commit Hook
node --test dist/hook.test.js

# Multi-Machine Sync & Delta Engine
node --test dist/sync.test.js

# Batched vault-git + dual-mode hybrid sequential dispatch
node --test dist/vault-git-hybrid-sync.test.js

# Vault sync conflict reconciliation, semantic auto-merge & rollback journal
node --test dist/reconcile.test.js

# Canvas Graph Viewer & REST API
node --test dist/canvas.test.js

# HTTP / SSE Server Transport
node --test dist/server.test.js

# MCP status monitor (activity bus + :3124 companion)
node --test dist/activity.test.js
node --test dist/status.test.js
```

### HTTP / SSE transport & status monitor

`memo serve --sse` starts the MCP SSE listener (default `http://127.0.0.1:3123`, configurable via `config.json` `ports.sse`) and, unless `--no-status` is set, a read-only **status monitor** companion at `http://127.0.0.1:3124/` (configurable via `config.json` `ports.status`) with vault list, health cards, and a live activity log (tool + HTTP events via SSE `/api/events/stream`). Override the companion port with `--status-port`. Canvas graph UI remains separate on port `3125` (`memo canvas`, configurable via `config.json` `ports.canvas`).

Human-facing ops (autoboot systemd / Windows Task Scheduler, remote MCP URL): [`README.md`](README.md) § Run, serve, status monitor & autoboot.

---

## 🖥️ Agent workflows: run · serve · diagnose · status · autoboot

Prefer MCP tools when the host exposes `spec-memo` / `user-spec-memo`. Else CLI (`memo` or `node dist/cli.js`). Full map: `sdw-memory` (vault knowledge) and `sdw-router` (intent dispatch).

### Run (session & vault ops)

| Intent | Do |
|--------|-----|
| Configure mode | `memo setup [--mode local|hybrid|remote] [--url <url>] [--host <host>] [--print-mcp|--write-mcp]` |
| Session start | MCP/`memo` `bootstrap` with `cwd` = product root; apply traps before coding (hybrid pulls remote deltas) |
| Recall | `search` → `get` |
| Remember | `upsert` (never write `{plansDir}` / `MEMORY.md` into product git; hybrid schedules debounced push; batched vault-git does not commit until flush) |
| Audit event | `append` |
| Sync | `memo sync [--all] [--dry-run] [--prefer local|remote]` (hybrid HTTP first, then vault-git sequentially when dual-mode) |
| Reconcile conflicts | `memo reconcile [--prefer local|remote] [--strategy smart-merge|local-wins|remote-wins|sidecar] [--clean-sidecars]` |
| Session close flush | MCP/CLI `prompt` `session_end` (batched vault-git + hybrid when enabled; fail-open) |
| Housekeep | `gc` (`dryRun` first when unsure); `forget` (purge only with explicit user confirm) |

### Deployment Modes

- **`local` (default):** Local records, indexing, and tool execution in `~/.spec-memo/`.
- **`hybrid`:** Local vault is authoritative cache; auto-pulls deltas during `bootstrap` and debounces pushes on mutations. Manual sync via `memo sync`. Fails open when daemon is down.
- **`remote`:** Local agent hosts run stdio proxy `memo serve` forwarding the 11 tools to remote daemon. Zero local records. Fails closed when daemon is down.

### Vault-git sync (`vaultGit` in `config.json`)

Optional private git remote backup of the vault root (`~/.spec-memo/`). Orthogonal to deployment mode except remote mode (no local vault writes).

- **`vaultGit.enabled`:** Opt-in. When false or omitted, vault-git is a no-op.
- **`vaultGit.atomic` (default `false`, batched):** Mutations write markdown + FTS only. Git commit + remote pull/push flush on `memo sync`, MCP/CLI `prompt` `session_end`, and graceful `memo serve` / SSE shutdown. CLI one-shot `memo upsert` does **not** flush on process exit—run `memo sync` or end the agent session.
- **`vaultGit.atomic: true`:** Per-mutation structured git commit + remote sync (fail-open; errors logged to `error.logs` with `subsystem: vault-git`).
- **Dual-mode:** When `mode: hybrid` and `vaultGit.enabled`, `memo sync` / `session_end` / shutdown run hybrid HTTP first, then vault-git sequentially in one run. Either channel may fail; the other still runs. Never crashes MCP/SSE.
- **Status/doctor:** `memo status` reports `Enabled (atomic|batched)`; doctor JSON includes `dirty` / `lastError` (credentials redacted).

### CLI Binary & PATH Resolution Contract

Agents executing shell commands or diagnosing environment issues must follow this contract:

1. **Invocation Hierarchy:**
   - **Primary:** `memo <command>` when `memo` is on the environment's `PATH`.
   - **Deterministic Fallback:** `node dist/cli.js <command>` (or absolute `node /path/to/spec-memo/dist/cli.js <command>`) when `memo` is not in `PATH` or during local workspace scripts.
2. **Binary Packaging & Shims:**
   - `package.json` declares `"bin": { "memo": "./dist/cli.js" }` and `dist/cli.js` has `#!/usr/bin/env node`.
   - Running `npm link` creates platform wrappers (`memo` on Linux/macOS; `memo`, `memo.cmd`, `memo.ps1` on Windows) in the global npm prefix (e.g. `%AppData%\Roaming\npm` or `$(npm config get prefix)/bin`).
3. **Rebuild Invariant:**
   - Global symlinks point directly to `dist/cli.js`. Running `npm run build` compiles TypeScript in place without invalidating the link. Agents do not need to re-link after builds.
4. **Agent Handling of `command not found`:**
   - If `memo: command not found` occurs in a subagent or tool execution, immediately fall back to `node dist/cli.js` within the repository, or check if the global npm bin path (`%AppData%\Roaming\npm` / `~/.local/bin`) needs to be added to `PATH`.


### Serve & Service Lifecycle (MCP & Web Companion)

| Mode / Intent | Command / Shortcut | Notes |
|---------------|-------------------|--------|
| Stdio MCP | `memo mcp` (or `memo start mcp`, `memo serve`) | Default for Cursor/Claude Desktop host spawn (proxies in remote mode) |
| SSE Server | `memo server` (or `memo start server`, `memo serve --sse`) | Starts MCP SSE (:3123) + Status monitor companion (:3124) in the background by default; idempotent if running |
| Status Monitor | `memo monitor` (or `memo start monitor`) | Starts read-only companion on :3124 in the background by default; idempotent if running |
| Knowledge Graph | `memo canvas` (or `memo start canvas`) | Starts visual graph UI on :3125 in the background by default; idempotent if running |
| Restart | `memo restart [monitor\|canvas\|server]` | Graceful stop, await port release, and restart service in the background by default |
| Stop Specific | `memo stop [server\|monitor\|canvas] [--port <port>]` | Stop specific service processes or port, then print the result and exit |
| Shutdown All | `memo shutdown` (alias: plain `memo stop`) | Gracefully stop all orphaned serve processes (SIGTERM first, force after timeout) |
| Flags | `--host` `--port` `--status-port` `--no-status` `--auth-token` `--vaultRoot` | Non-loopback without token **must fail** (`SPEC_MEMO_SSE_TOKEN` / `SPEC_MEMO_AUTH_TOKEN` / `--auth-token`) |

`memo start` / `memo restart` print status and return `0` once background HTTP services are reachable. Pass `-f` / `--foreground` for monitor, canvas, or server debugging. `memo start mcp` remains foreground because stdio MCP must stay attached to its host; `memo start mcp --sse` uses the background SSE server path. On status companion bind failure: close SSE listener + activity bus before rejecting (trap `sse-status-bind-rollback`). On SSE transport disconnect: `await mcpServer.close()` (trap `sse-mcp-server-close`).

### Diagnose

```bash
memo doctor              # vault structure, FTS, deployment mode, remote health, in-repo pollution
memo doctor --json
memo doctor --rebuild    # rebuild FTS from markdown
memo doctor --fix       # delete leftover in-tree residue (plans/MEMORY/.state…)
memo rank [--json]       # CLI-only trap recurrence
```

### Check SSE status monitor

1. Ensure `memo serve --sse` is running (companion on unless `--no-status`).
2. Operator UI: `http://127.0.0.1:3124/` (optional `?project=<projectId>`).
3. Machine checks:
   - `GET /health` on MCP port (`3123`)
   - `GET /api/status`, `/api/vaults`, `/api/events` on status port (`3124`)
   - Live: `GET /api/events/stream` (SSE)
4. With a token: `Authorization: Bearer <token>` (EventSource may use `?token=`).
5. Status diagnostic surface is read-only for records; dedicated HTTP endpoints (`POST /api/vaults/export`, `POST /api/vaults/import`, `POST /api/vaults/reset`, `POST /api/vaults/restore`, `GET /api/vaults/backups`, `POST /api/vaults/backups`, `GET /api/vaults/backups/{filename}`, `GET /api/vaults/backups/{filename}/inspect`, `DELETE /api/vaults/backups/{filename}`) power the status monitor **Backups** tab (create, list, inspect, download, restore, delete) plus export/import/reset affordances (no new MCP tools).

### Autoboot service (document / verify; do not invent tokens)

When the user asks to install a boot service for the SSE daemon:

1. Point them at [`README.md`](README.md) § Autoboot (systemd unit or Windows Task Scheduler / NSSM).
2. Require durable `SPEC_MEMO_ROOT` and a bearer token for non-loopback binds.
3. After install, verify with `systemctl status` / Task Scheduler history and `curl` `/health` + open `:3124/`.
4. Shared lab: pass stable `projectId` or server-side `cwd` — do not assume laptop path identity on the daemon host.
5. Never commit tokens, unit files with secrets, or vault contents into product git.

---

## 🛠️ How to Use (MCP Tools & CLI Commands)

`spec-memo` exposes exactly **11** core tools through MCP stdio and matching CLI commands (`memo <command>`):

### 1. `bootstrap`
- **Purpose**: Bind working directory to project identity; return token-budgeted brief (default 8 KB; overridable). Hit-eligible records included in the brief increment `hits`.
- **Parameters**: `cwd` (string), `query` (string), `slug` (string), `path` (string), `maxBytes` (number; defaults to `~/.spec-memo/config.json` `bootstrap.maxBytes`, 8192), `sessionId` (string; optional hit de-dupe).
- **CLI Example**: `memo bootstrap --slug feature-auth --path src/auth.ts --session-id s1`

### 2. `search`
- **Purpose**: Filtered full-text search across vault records via SQLite FTS5. Bare search does **not** increment `hits`; pass `hitIds` for rows actually used.
- **Parameters**: `query` (string), `kinds` (string[]), `status` (string), `tags` (string[]), `path` (string), `includeScratch` (boolean), `crossProject` (boolean), `limit` (number), `sort` (`relevance` \| `occurrences` \| `updated` \| `hits`), `hitIds` (string[]), `sessionId` (string).
- **CLI Example**: `memo search "database lock" --kind trap --path src/db/client.ts --sort hits --hit-ids trap-a,trap-b --session-id s1`

### 3. `get`
- **Purpose**: Retrieve a single record by ID or kind+slug. Successful get of `trap` / `decision` / `spec` / `plan` increments `hits`.
- **Parameters**: `id` (string), `kind` (string), `slug` (string), `sessionId` (string; optional hit de-dupe).
- **CLI Example**: `memo get --id trap-sqlite-wal-lock --session-id s1`

### 4. `upsert`
- **Purpose**: Write or update a memory record (trap, decision, spec, plan, state, log, scratch, review).
- **Parameters**: `kind` (required), `body` (required), `slug` (optional), `frontmatter` (optional object).
- **Frontmatter Fields**: `id`, `title`, `severity` (low/medium/high/critical), `pathPatterns` (string[]), `tags` (string[]), `layer`, `module`, `occurrences`, `lastSeen`, `hits`, `lastHit`, `supersedes` (string), `linkedPaths` (string[]), `verifiedAtSha` (string).
- **CLI Example**:
  ```bash
  memo upsert --kind trap --title "Close SQLite DB before unlink on Windows" --severity critical --path-patterns "src/**/*.ts" --body "Windows holds file lock on open SQLite handles. Call closeIndex() before deleting test directories."
  ```

### 5. `append`
- **Purpose**: Append a write-only execution log or audit event record.
- **Parameters**: `event` (required string), `kind` (optional), `details` (optional object).
- **CLI Example**: `memo append --event "Successfully executed slice-17 tests"`

### 6. `forget`
- **Purpose**: Soft-archive (default) or permanently purge a memory record.
- **Parameters**: `id` (string), `purge` (boolean).
- **CLI Example**: `memo forget --id scratch-temp-notes --purge`

### 7. `gc`
- **Purpose**: Apply TTL retention (7-day scratch, 14-day review), compact completed plans, roll up monthly logs, and rebuild FTS.
- **Parameters**: `dryRun` (boolean), `projectId` (string).
- **CLI Example**: `memo gc --dry-run`

### 8. `promote`
- **Purpose**: Copy a record into the product repository as documentation (default-deny without destination).
- **Parameters**: `id` (string, optional when `format=skill`), `destination` (required string), `format` (optional `raw` \| `adr` \| `madr` \| `skill`), `limit` (number), `force` (boolean).
- **CLI Example**: `memo promote --format skill --to .agents/skills/<skill-name>/SKILL.md`

### 9. `check_version`
- **Purpose**: Compare the running spec-memo package version to the latest npm release (soft-fail offline).
- **Parameters**: none.
- **CLI Example**: `memo check-version --json`

### 10. `install_skills`
- **Purpose**: Install packaged runtime skill(s) into explicitly selected local or global host roots.
- **Parameters**: `productRoot` (string), `cwd` (string), `skills` (string[]), `skillsRoot` (string), `scope` (`local|global`), `hosts` (string[]), `conflictPolicy` (`skip|update|force`), `confirm` (boolean).
- **CLI Example**: `memo install-skills --product-root /path/to/consumer --scope local --host cursor --conflictPolicy update --yes`

### 11. `prompt`
- **Purpose**: Ingest prompt turns, manage session lifecycles, FTS/list query, activity reports, rule derivation, and session story export. Successful `session_end` also triggers dual sync flush (hybrid + batched vault-git when enabled; fail-open).
- **Parameters**: `action` (required intent; default `record`), plus action-specific fields (`body`, `sessionId`, `query`, `ide`, `client`, `since`/`until`, `saveTraps`, `promote`, …).
- **Actions**: `record`, `list`, `get`, `search`, `session`, `session_start`, `session_end`, `activity_report`, `derive_rules`, `export_story`.
- **CLI Example**:
  ```bash
  memo prompt record --body "Always close SQLite before unlink on Windows" --session-id s1 --ide cursor
  memo prompts search "exponential backoff" --json
  memo session end s1 --summary "Shipped auth refresh" --pr https://github.com/org/repo/pull/1
  memo activity --json
  ```

---

## 🩺 How to Check & Diagnose (`memo doctor`)

Run `doctor` whenever diagnosing vault health or checking for repository cleanliness:

```bash
# Standard diagnostic check
memo doctor

# Diagnostic check with JSON output
memo doctor --json

# Rebuild corrupted or missing SQLite FTS5 index
memo doctor --rebuild

# Scan and automatically delete leftover in-repo pollution files
memo doctor --fix
```

### What `doctor` Validates:
1. **Vault Structure**: Confirms `$SPEC_MEMO_ROOT` (or `~/.spec-memo/`) exists and contains `config.json` and `projects/`.
2. **Project Identity**: Verifies whether project is bound to a normalized git remote or using a fallback path ID.
3. **SQLite FTS5 Integrity**: Verifies `memo.sqlite` accessibility and reports the number of indexed records.
4. **Repository Pollution Scan**: Scans the product tree for forbidden workflow residue:
   - `.agents/plans/`
   - `MEMORY.md` or `memory/*.md`
   - `run.json` or `.state.md`
   - `telemetry.jsonl`
   - Agent audit logs (`*.log.md`, `.agents/*.log`)
5. **Vault-git state** (when enabled): Reports effective `atomic` mode, dirty flag, and redacted `lastError` from `.sync/vault-git-state.json`.

## Recurring traps (`memo rank`)

CLI-only (not an MCP tool). Lists active traps by `occurrences`.

```bash
memo rank --json
memo rank --layer web --limit 10
memo rank --backfill
memo promote --format skill --to .agents/skills/<skill-name>/SKILL.md
```

---

## 🛑 Git Boundary & Anti-Pollution Rules (Mandatory)

This product's thesis is that **product git is not a memory store. Dogfood it.**

| May live in this git repo | Must NOT live in this git repo |
|---|---|
| Runtime source (`src/`), manifests (`package.json`), `tsconfig.json`, CI | In-repo agent plans (`.agents/plans/`), step-N copies |
| `README.md`, `AGENTS.md`, `GEMINI.md`, `PRODUCT.PRD`, `FEATURES.md`, `PLAN.md` | In-repo `MEMORY.md`, `memory/*`, agent changelogs |
| Specs of record under `.agents/specs/*.spec.md` and `.agents/specs/index.PRD` | Runtime session state (`.state.md`, `run.json`, `telemetry.jsonl`) |
| Test suites (`src/*.test.ts`) | Sidecar vault contents (`~/.spec-memo/`, `$SPEC_MEMO_ROOT`) |

**Refuse In-Repo Workflow Writes**: When executing tasks in this product repo or consumer repos, never write working memory records or temporary plans into the working tree. Use `memo upsert` or MCP tools instead.

---

## 🚀 Ship via `sdw-ship-pr`

**Every** `/sdw-ship-pr` invocation (including “ship next version”, “bump + ship”, or any standalone ship) must complete this checklist **in order before create-pr**. Do not skip steps or merge early.

| Step | Do | Done when |
|---|---|---|
| 1. Verify | Run tests and verifications (`npm test`; add `npm run build` / targeted suites if the slice touched them). Fix failures before any version bump. | Full suite green |
| 2. Bump | **Required before PR.** Bump the product version in `package.json` (semver patch/minor/major per shipped scope). Keep lockfile / embedded version strings consistent if the repo mirrors them. | `package.json` `version` matches the release intent |
| 3. README | Update [`README.md`](README.md) with the latest features just implemented (version badge/line, Command & Tool Reference, operator-facing deltas). Align with [`FEATURES.md`](FEATURES.md) — do not claim unfinished work. | README reflects this version’s shipped surface |
| 4. Commit + push | Commit ship-scope changes (version, README, tracking docs, code). Push the working branch (`develop`). Product specs of record may need `SKIP_MEMO_HOOK=1` in this repo. | Branch pushed; no uncommitted ship-scope files |
| 5. `sdw-ship-pr` | Load and run `sdw-ship-pr`: prepare board → create PR to the base branch (`master`). Steps 1–4 must already be ✅ — **never create a PR without a version bump on the branch.** | PR URL captured |
| 6. Review convergence | After the PR exists, run `sdw-ship-pr --poll-pr` (add `--merge` when the user allows merging): wait for CI and agentic review, route findings to `sdw-fixer`, resolve threads only after pushing an explanatory fix comment, and merge only when checks are green and `activeThreads == 0` (unless the user said `no-merge`). | PR merged or explicitly left open per user |

**Rules:** announce each checklist row as you complete it; never bump version on a red test run; never create a PR without completing steps 1–4 (version bump is mandatory for every ship); never push secrets; never delete the working branch after merge.
