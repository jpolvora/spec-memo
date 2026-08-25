# AGENTS.md — spec-memo agent contract

**Audience: agents.** Humans: [`README.md`](README.md).

This document is the operating contract for coding agents working in and with **spec-memo**. It defines session startup, testing, tool usage, health diagnostics (`doctor`), git boundaries, and task tracking.

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

---

## 🚀 Session Start Protocol

1. **Invoke Bootstrap**: Call the `bootstrap` MCP tool or run `memo bootstrap` to retrieve active anti-regression traps, open architecture decisions, the active spec/plan slice, and code drift warnings.
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
# Runs full pretest build and all 21 test suites (122+ tests)
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
```

---

## 🛠️ How to Use (MCP Tools & CLI Commands)

`spec-memo` exposes exactly 8 core tools through MCP stdio and matching CLI commands (`memo <command>`):

### 1. `bootstrap`
- **Purpose**: Bind working directory to project identity; return token-budgeted brief (<8 KB).
- **Parameters**: `cwd` (string), `query` (string), `slug` (string), `path` (string), `maxBytes` (number).
- **CLI Example**: `memo bootstrap --slug feature-auth --path src/auth.ts`

### 2. `search`
- **Purpose**: Filtered full-text search across vault records via SQLite FTS5.
- **Parameters**: `query` (string), `kinds` (string[]), `status` (string), `tags` (string[]), `path` (string), `includeScratch` (boolean), `crossProject` (boolean), `limit` (number).
- **CLI Example**: `memo search "database lock" --kind trap --path src/db/client.ts`

### 3. `get`
- **Purpose**: Retrieve a single record by ID or kind+slug.
- **Parameters**: `id` (string), `kind` (string), `slug` (string).
- **CLI Example**: `memo get --id trap-sqlite-wal-lock`

### 4. `upsert`
- **Purpose**: Write or update a memory record (trap, decision, spec, plan, state, log, scratch, review).
- **Parameters**: `kind` (required), `body` (required), `slug` (optional), `frontmatter` (optional object).
- **Frontmatter Fields**: `id`, `title`, `severity` (low/medium/high/critical), `pathPatterns` (string[]), `tags` (string[]), `supersedes` (string), `linkedPaths` (string[]), `verifiedAtSha` (string).
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
- **Parameters**: `id` (string), `destination` (required string), `format` (optional `adr` or `raw`), `force` (boolean).
- **CLI Example**: `memo promote decision-sqlite-fts5 --to docs/adr/001-sqlite.md --format adr`

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
2. Run `npm test` and verify that all 122+ tests pass with zero regressions.

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
