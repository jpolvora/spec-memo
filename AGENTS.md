# AGENTS.md — spec-memo agent contract

**Audience: agents.** Humans: [`README.md`](README.md).

This document is the operating contract for coding agents working in and with **spec-memo**. It defines session startup, testing, tool usage, health diagnostics (`doctor`), HTTP/SSE serve + status monitor checks, autoboot service guidance, git boundaries, and task tracking.

**Humans / operators** (install, autoboot systemd/Task Scheduler, favorite status URL): [`README.md`](README.md).

**Language:** `en-us` only for product docs, schemas, CLI help, MCP descriptions, tests, and commit messages.

---

## Precedence (highest first)

1. Explicit user instructions (current turn)
2. This root `AGENTS.md` / [`GEMINI.md`](GEMINI.md) operating contract
3. Design & architecture constraints ([`PRODUCT.PRD`](PRODUCT.PRD), [`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), [`.agents/specs/index.PRD`](.agents/specs/index.PRD), [`.agents/specs/*.spec.md`](.agents/specs/))
4. Autoload (Always-applied) skills ([`.agents/skills/ws-shared/autoload.md`](.agents/skills/ws-shared/autoload.md))

---

## Autoload (Always-applied skills)

Load **every** skill listed in [`.agents/skills/ws-shared/autoload.md`](.agents/skills/ws-shared/autoload.md) § Always-applied skills on every prompt:

| Skill | Path | Trigger | Role |
|---|---|---|---|
| `ws-senior-developer` | `{globalSkillsRoot}/ws-senior-developer/SKILL.md` | Every prompt | Delivery gate, scope control, ambiguity stops, pre-ship proof |
| `ws-self-learning` | `{globalSkillsRoot}/ws-self-learning/SKILL.md` | Every mutating task | Consult MEMORY + anti-regression trap writes |
| `ws-patterns-backend` | `{skillsRoot}/ws-patterns-backend/SKILL.md` | Every prompt | Backend patterns & Node/SQLite best practices |
| `ws-patterns-frontend` | `{skillsRoot}/ws-patterns-frontend/SKILL.md` | Every prompt | Frontend patterns & viewer best practices |
| `ws-changelog` | `{globalSkillsRoot}/ws-changelog/SKILL.md` | Task completion | Append-only history writer |
| `ws-fable-method` | `{globalSkillsRoot}/ws-fable-method/SKILL.md` | Every prompt | 7-step structured investigation & verification loop |
| `ws-tdah` | `{globalSkillsRoot}/ws-tdah/SKILL.md` | Every prompt | Action-first reply shape & operational judgment |
| `ws-task-lifecycle` | `{globalSkillsRoot}/ws-task-lifecycle/SKILL.md` | Every prompt | Task lifecycle management |

---

## Specs Progressive Disclosure & Router

When the user mentions specs / plans / Spec-to-PR / `index.PRD` without naming a skill, load **only** the matching skill:

| When the task means… | Load | Does not do |
|---|---|---|
| Draft a new local spec | `ws-write-spec` | Does not create `{plansDir}`; does not run orch |
| Validate / reshape `*.spec.md` format & ACs | `ws-spec-format` | Does not invent product requirements |
| Register spec of record & workflow copy | `ws-local-spec-provider` | Not for free-text draft |
| Init / sync / promote `index.PRD` feature map | `ws-spec-index` | Does not rewrite AC bodies for code drift |
| Spec text drifted from implemented code | `ws-sync-spec` | Does not update `index.PRD` checkboxes |
| Deliver feature Spec→PR (standard FSM) | `ws-spec-to-pr` | Not for batch; not for format-only edits |
| Deliver feature Spec→PR (fast lite) | `ws-spec-to-pr-lite` | Not for complex multi-phase work |
| Ship next product version (bump + PR) | § [Ship next version](#-ship-next-version-ws-ship-pr) + `ws-ship-pr` | Not a feature-slice orch; does not invent scope |

### Vault / spec-memo runtime

When the task means using the spec-memo **vault** (bootstrap, search, upsert, doctor, canvas, SSE status), load **only** [`ws-memo`](.agents/skills/ws-memo/SKILL.md). Consumer **setup** (`specMemo.enabled`, import, hybrid MEMORY) stays in workflow-skills `ws-spec-memo` — do not duplicate it here.

---

## 🚀 Session Start Protocol

1. **Invoke Bootstrap**: Load [`ws-memo`](.agents/skills/ws-memo/SKILL.md). Call the `bootstrap` MCP tool or run `memo bootstrap` to retrieve active anti-regression traps, open architecture decisions, the active spec/plan slice, and code drift warnings.
2. **Review Product Docs**: Check [`PRODUCT.PRD`](PRODUCT.PRD), [`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), and [`.agents/specs/index.PRD`](.agents/specs/index.PRD) for active phase constraints and slice definitions.
3. **Respect Git Boundaries**: Never create in-repo `.agents/plans/`, `MEMORY.md`, `.state.md`, or session log dumps in the product repository.

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
# Runs full pretest build and all 26 test suites (196 tests)
npm test
```

### 3. Run Targeted Subsystem Test Suites
Execute specific test files directly for faster iteration:

```bash
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

# Canvas Graph Viewer & REST API
node --test dist/canvas.test.js

# HTTP / SSE Server Transport
node --test dist/server.test.js

# MCP status monitor (activity bus + :3001 companion)
node --test dist/activity.test.js
node --test dist/status.test.js
```

### HTTP / SSE transport & status monitor

`memo serve --sse` starts the MCP SSE listener (default `http://127.0.0.1:3000`) and, unless `--no-status` is set, a read-only **status monitor** companion at `http://127.0.0.1:3001/` with vault list, health cards, and a live activity log (tool + HTTP events via SSE `/api/events/stream`). Override the companion port with `--status-port`. Canvas graph UI remains separate on port `4100` (`memo canvas`).

Human-facing ops (autoboot systemd / Windows Task Scheduler, remote MCP URL): [`README.md`](README.md) § Run, serve, status monitor & autoboot.

---

## 🖥️ Agent workflows: run · serve · diagnose · status · autoboot

Prefer MCP tools when the host exposes `spec-memo` / `user-spec-memo`. Else CLI (`memo` or `node dist/cli.js`). Full map: [`ws-memo`](.agents/skills/ws-memo/SKILL.md).

### Run (session & vault ops)

| Intent | Do |
|--------|-----|
| Session start | MCP/`memo` `bootstrap` with `cwd` = product root; apply traps before coding |
| Recall | `search` → `get` |
| Remember | `upsert` (never write `{plansDir}` / `MEMORY.md` into product git) |
| Audit event | `append` |
| Housekeep | `gc` (`dryRun` first when unsure); `forget` (purge only with explicit user confirm) |

### Serve (MCP transport)

| Mode | Command | Notes |
|------|---------|--------|
| Stdio | `memo serve` | Default for Cursor/Claude Desktop host spawn |
| SSE | `memo serve --sse` | Prints SSE URL + status URL; `--json` emits `url` / `statusUrl` |
| Flags | `--host` `--port` `--status-port` `--no-status` `--auth-token` `--vaultRoot` | Non-loopback without token **must fail** (`SPEC_MEMO_SSE_TOKEN` / `SPEC_MEMO_AUTH_TOKEN` / `--auth-token`) |

On status companion bind failure: close SSE listener + activity bus before rejecting (trap `sse-status-bind-rollback`). On SSE transport disconnect: `await mcpServer.close()` (trap `sse-mcp-server-close`).

### Diagnose

```bash
memo doctor              # vault structure, FTS, in-repo pollution
memo doctor --json
memo doctor --rebuild    # rebuild FTS from markdown
memo doctor --fix       # delete leftover in-tree residue (plans/MEMORY/.state…)
memo rank [--json]       # CLI-only trap recurrence
```

### Check SSE status monitor

1. Ensure `memo serve --sse` is running (companion on unless `--no-status`).
2. Operator UI: `http://127.0.0.1:3001/` (optional `?project=<projectId>`).
3. Machine checks:
   - `GET /health` on MCP port (`3000`)
   - `GET /api/status`, `/api/vaults`, `/api/events` on status port (`3001`)
   - Live: `GET /api/events/stream` (SSE)
4. With a token: `Authorization: Bearer <token>` (EventSource may use `?token=`).
5. Status surface is read-only — never treat it as a write path.

### Autoboot service (document / verify; do not invent tokens)

When the user asks to install a boot service for the SSE daemon:

1. Point them at [`README.md`](README.md) § Autoboot (systemd unit or Windows Task Scheduler / NSSM).
2. Require durable `SPEC_MEMO_ROOT` and a bearer token for non-loopback binds.
3. After install, verify with `systemctl status` / Task Scheduler history and `curl` `/health` + open `:3001/`.
4. Shared lab: pass stable `projectId` or server-side `cwd` — do not assume laptop path identity on the daemon host.
5. Never commit tokens, unit files with secrets, or vault contents into product git.

---

## 🛠️ How to Use (MCP Tools & CLI Commands)

`spec-memo` exposes exactly **10** core tools through MCP stdio and matching CLI commands (`memo <command>`):

### 1. `bootstrap`
- **Purpose**: Bind working directory to project identity; return token-budgeted brief (<8 KB).
- **Parameters**: `cwd` (string), `query` (string), `slug` (string), `path` (string), `maxBytes` (number).
- **CLI Example**: `memo bootstrap --slug feature-auth --path src/auth.ts`

### 2. `search`
- **Purpose**: Filtered full-text search across vault records via SQLite FTS5.
- **Parameters**: `query` (string), `kinds` (string[]), `status` (string), `tags` (string[]), `path` (string), `includeScratch` (boolean), `crossProject` (boolean), `limit` (number), `sort` (`relevance` \| `occurrences` \| `updated`).
- **CLI Example**: `memo search "database lock" --kind trap --path src/db/client.ts --sort occurrences`

### 3. `get`
- **Purpose**: Retrieve a single record by ID or kind+slug.
- **Parameters**: `id` (string), `kind` (string), `slug` (string).
- **CLI Example**: `memo get --id trap-sqlite-wal-lock`

### 4. `upsert`
- **Purpose**: Write or update a memory record (trap, decision, spec, plan, state, log, scratch, review).
- **Parameters**: `kind` (required), `body` (required), `slug` (optional), `frontmatter` (optional object).
- **Frontmatter Fields**: `id`, `title`, `severity` (low/medium/high/critical), `pathPatterns` (string[]), `tags` (string[]), `layer`, `module`, `occurrences`, `lastSeen`, `supersedes` (string), `linkedPaths` (string[]), `verifiedAtSha` (string).
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
- **CLI Example**: `memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md`

### 9. `check_version`
- **Purpose**: Compare the running spec-memo package version to the latest npm release (soft-fail offline).
- **Parameters**: none.
- **CLI Example**: `memo check-version --json`

### 10. `install_skills`
- **Purpose**: Install packaged runtime skill(s) (default `ws-memo`) into a consumer product `{skillsRoot}`.
- **Parameters**: `productRoot` (string), `cwd` (string), `skills` (string[]), `skillsRoot` (string), `force` (boolean).
- **CLI Example**: `memo install-skills --product-root /path/to/consumer --force`

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

## Recurring traps (`memo rank`)

CLI-only (not an MCP tool). Lists active traps by `occurrences`.

```bash
memo rank --json
memo rank --layer web --limit 10
memo rank --backfill
memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md
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

## 📋 Task Execution & Spec-to-PR Workflow

Always work in strict synchronization with [`.agents/specs/index.PRD`](.agents/specs/index.PRD) and project tracking documents:

### Phase 1: Intake & Alignment (Pre-execution)
1. Locate the feature slice in `.agents/specs/index.PRD` and `PLAN.md`.
2. Review acceptance criteria in `.agents/specs/<slug>.spec.md`.
3. Mark task as `[~] in progress` in `.agents/specs/index.PRD`.

### Phase 2: Surgical Implementation & Verification
1. Apply minimal, surgical diffs following Karpathy guidelines.
2. Run `npm test` and verify that all 196 tests pass with zero regressions.

### Phase 3: Post-Execution Tracking Updates (Canonical Order)
Once tests pass, update tracking documents in this exact order:
1. **[`FEATURES.md`](FEATURES.md)**: Mark matching capabilities as `[x]`.
2. **[`PLAN.md`](PLAN.md)**: Append to `## Done log` with Date, Slice Slug, and Proof Result.
3. **[`PRODUCT.PRD`](PRODUCT.PRD)**: Append to `## 11. Done log`.
4. **[`.agents/specs/index.PRD`](.agents/specs/index.PRD)**:
   - Mark spec in `## 8. Next specs` as `[x] done`.
   - Append to `## 10. Done log`.
   - Mark slice spec status as complete.
5. **Changelog & Learning**:
   - Log task completion via `ws-changelog`.
   - Record newly discovered traps via `ws-self-learning` (`memo upsert --kind trap ...`).

---

## 🚀 Ship next version (`ws-ship-pr`)

When the user says **ship next version** (or equivalent: bump + ship / release next version via `ws-ship-pr`), follow this checklist **in order**. Do not skip steps or merge early.

| Step | Do | Done when |
|---|---|---|
| 1. Verify | Run tests and verifications (`npm test`; add `npm run build` / targeted suites if the slice touched them). Fix failures before any version bump. | Full suite green |
| 2. Bump | Bump the product version in `package.json` (semver patch/minor/major per shipped scope). Keep lockfile / embedded version strings consistent if the repo mirrors them. | `package.json` `version` matches the release intent |
| 3. README | Update [`README.md`](README.md) with the latest features just implemented (version badge/line, Command & Tool Reference, operator-facing deltas). Align with [`FEATURES.md`](FEATURES.md) — do not claim unfinished work. | README reflects this version’s shipped surface |
| 4. Commit + push | Commit ship-scope changes (version, README, tracking docs, code). Push `shipHead` (`config.project.workingBranch`, default `develop`). Product specs of record may need `SKIP_MEMO_HOOK=1` in this repo. | Branch pushed; no uncommitted ship-scope files |
| 5. `ws-ship-pr` | Load and run [`ws-ship-pr`](https://github.com/jpolvora/workflow-skills/tree/develop/.agents/skills/ws-ship-pr): prepare board → create PR to `config.project.baseBranch`. | PR URL captured |
| 6. `ws-goal-fix-pr` | After PR exists, run [`ws-goal-fix-pr`](https://github.com/jpolvora/workflow-skills/tree/develop/.agents/skills/ws-goal-fix-pr): wait for CI / agentic review, converge threads, merge only when checks green and `activeThreads == 0` (unless user said `no-merge`). | PR merged or explicitly left open per user |

**Rules:** announce each checklist row as you complete it; never bump version on a red test run; never push secrets; never delete `shipHead` after merge.
