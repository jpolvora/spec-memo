# Feature list

**Audience: humans and agents** — capability inventory for spec-memo.

Package version: **0.14.3** (`develop`). Status marks: `[ ]` planned · `[~]` in progress · `[x]` shipped (proof in [`PLAN.md`](PLAN.md)).

| Doc | Purpose |
|-----|---------|
| **`FEATURES.md`** (this file) | What the product does, feature by feature |
| [`PRODUCT.PRD`](PRODUCT.PRD) | Why, constraints, phases |
| [`PLAN.md`](PLAN.md) | Build order and proof |
| [`README.md`](README.md) | Human overview |
| [`AGENTS.md`](AGENTS.md) | Agent contract |

---

## 1. Project binding

- [x] **Remote identity.** Normalize `git remote get-url origin` (or configured remote) to a stable project id (strip credentials, trailing `.git`, case rules for github.com). Same remote from two clone paths is one project.
- [x] **Fallback identity.** No remotes → id from canonical absolute repo root. Document the collision risk if the folder is copied.
- [x] **Last-seen root.** Record the product working tree path in `project.json` for refuse-write checks. Not committed to the product.
- [x] **Zero product files.** Binding does not create `.spec-memo.json` or similar in the consumer repo.

---

## 2. Record store

- [x] **Typed Markdown records.** One file per record, YAML frontmatter per [`PRODUCT.PRD`](PRODUCT.PRD) § Frontmatter. Body is Markdown.
- [x] **Kinds.** `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review`, `prompt`, `session` with the retention table in the PRD.
- [x] **Compiled views.** Regenerated, never hand-edited: `INDEX.md`, `TRAPS.md`, `DECISIONS.md`, `PROMPTS.md`, `SESSIONS.md`. Rebuild from sources (no merge of compiled files).
- [x] **Trap shape.** Layer, module, severity, pathPatterns, scenario, DO NOT, INSTEAD DO, plus frontmatter `occurrences` / `lastSeen` — compatible with today’s workflow-skills memory entries so import is mechanical.
- [x] **Decision shape.** Title, status (`proposed` / `accepted` / `superseded`), rationale, alternatives considered (optional).
- [x] **Spec of record.** Single spec per slug in the vault. No `step-00` duplicate. Optional `linkedPaths` + `verifiedAtSha`.

---

## 3. Index

- [x] **SQLite FTS5.** Query by text, kind, status, slug, pathPatterns, severity, tags, project. `search.sort` can order by `relevance`, `occurrences`, or `updated`.
- [x] **Disposable DB.** Delete `memo.sqlite` and rebuild from the vault. The DB is never the source of truth.
- [x] **Default search filter.** Exclude `scratch`, `state`, `log`, `review` unless the caller sets `kinds`.

---

## 4. MCP tools

One stdio MCP server. Tool descriptions are the interface; vault paths are not.

| Tool | Status | Job | Returns |
|------|--------|-----|---------|
| `bootstrap` | [x] | Bind cwd’s git remote; compile a session brief | Traps (medium+, path/keyword match, cap), open accepted decisions that match, live spec/plan slugs, drift flags, notices if truncated |
| `search` | [x] | Filtered retrieval | id, kind, score, snippet, status |
| `get` | [x] | Read one record by id or `kind+slug` | Full markdown + frontmatter |
| `upsert` | [x] | Write/update trap, decision, spec, plan, state, review, scratch | id, whether it superseded another; schema errors fail closed |
| `append` | [x] | Changelog / audit event | New event id; never rewrites prior events |
| `forget` | [x] | Supersede or archive | New status. Traps archive unless the caller passes an explicit purge confirmed by the user |
| `gc` | [x] | Apply TTL, compact shipped plans, rebuild FTS | Counts archived/compacted/deleted (scratch only) |
| `promote` | [x] | Copy one record into the product repo | Product-relative path. **Default deny** without `destination` inside the product root |
| `check_version` | [x] | Compare running package version to npm `latest` | `current`, `latest`, `updateAvailable`, `source` (soft-fail offline) |
| `install_skills` | [x] | Install packaged runtime skill(s) (default `ws-memo` + `ws-session-tracking`) into consumer `{skillsRoot}`, or `--global` / `global: true` into `$HOME/.agents/skills` (+ Antigravity if present) | Destination path(s); default-deny outside product root (local); `force` to overwrite; skill frontmatter version tracks `package.json` |

Do not add an eleventh tool without a [`PRODUCT.PRD`](PRODUCT.PRD) change.

### Bootstrap include / exclude

**Include:** matching traps (cap 10), accepted decisions that constrain the query/cwd paths, the single live spec+plan for a named slug, spec drift (linked path SHA ≠ `verifiedAtSha`).

**Exclude:** log dumps, shipped plan folders, telemetry, other projects (unless `crossProject: true` — Phase 3).

**Budget:** Default 8 KB UTF-8 (`~/.spec-memo/config.json` `bootstrap.maxBytes`, overridable per call via `maxBytes`). Over budget → drop lowest-rank hits, set `truncated: true`.

---

## 5. CLI

- [x] **Same module as MCP.** `memo <command>` maps 1:1 to tools: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version` (`check-version`), `install_skills` (`install-skills`).
- [x] **`memo doctor`.** Vault exists, FTS rebuilds, project binds, reports in-repo pollution under a given product root (does not delete).
- [x] **`memo rank`.** CLI-only list of active traps by `occurrences` (optional `--layer`, `--backfill`). Not an MCP tool.
- [x] **`memo import <productRoot>`.** See § Import.
- [x] **`memo export-vault` / `memo import-vault`.** Backup and restore vault archives with optional AES-256-GCM encryption.
- [x] **Help and errors on stderr; machine-readable JSON on stdout** when `--json` is passed.

---

## 6. Policy and curator

- [x] **Schema gate.** Invalid kind/status/frontmatter → error, no write.
- [x] **TTL.** `scratch` 7 days; `review` 14 days after `relatedSlug` PR merged or 14 days from `updated` if unknown. `gc` applies this.
- [x] **Plan compact.** `status=shipped` plans reduce to a short result record; detail files become `scratch` then expire.
- [x] **Log compact.** Monthly roll-up files; events remain searchable via FTS.
- [x] **ADR promotion templates.** Format decisions into standard Nygard ADR or MADR Markdown on promotion. `format: skill` compiles ranked traps into one owner `SKILL.md`.
- [x] **Redaction.** `upsert` / `append` reject bodies that look like secrets (PEM headers, `api_key=` assignments, known env-file patterns). Caller must omit the secret; spec-memo does not store a redacted copy of the secret value.
- [x] **Refuse product-tree write.** If `cwd` or `productRoot` is a git work tree, API/CLI refuse to write record files *under that tree*. Vault writes stay under `$SPEC_MEMO_ROOT`.
- [x] **Trap dedup (Phase 3).** Same `pathPatterns` + similar DO NOT → bump `occurrences` on the surviving trap (explicit `supersedes` still creates a new file).

---

## 7. Import

- [x] Map `{specsDir}/*.spec.md` → `kind=spec`.
- [x] Map `{sharedDir}/memory/*.md` → `kind=trap` (preserve severity and pathPatterns when present).
- [x] Map compiled `MEMORY.md` as skipped (rebuild from entries).
- [x] Map active `{plansDir}/{slug}/` → `kind=plan` + `kind=state`; skip `telemetry/`, `.runtime/`, `*.jsonl`, `audit-*.log.md`.
- [x] Map agent changelog entries → `kind=log` (split by heading).
- [x] Do not import skill bodies (`SKILL.md`, scripts).
- [x] Idempotent: re-import updates by slug/id, does not duplicate.

---

## 8. Harness adapter (Phase 2 — workflow-skills)

Out of this repo’s Phase 1. Listed so agents do not invent it early.

- [x] Relocatable consumer hub data (`MEMORY`, `memory/*`, changelog) off `{sharedDir}`-fixed layout.
- [x] `read-memory` / `update-memory` call spec-memo MCP (or CLI) instead of `Read`/`Write` in the product tree.
- [x] Skill or git hook blocks new files under product `{plansDir}` / `{specsDir}` / hub memory once the project is bound.
- [x] **`ws-memo` runtime skill** (this repo, [`.agents/skills/ws-memo/SKILL.md`](.agents/skills/ws-memo/SKILL.md)): routes all 11 MCP tools plus CLI extras. Install into consumers via `memo install-skills` / MCP `install_skills`. Consumer enable/setup remains workflow-skills `ws-spec-memo`.
- [x] **`ws-session-tracking` runtime skill** (this repo): session lifecycle, prompt ingestion, deliverable correlation, rule derivation, activity/timesheet reports.

---

## 9. Advanced Ecosystem & Connectivity (Phase 5)

- [x] **Interactive Canvas UI & Visual Graph.** Embedded HTTP visualizer (`memo canvas`) with SVG/Canvas force graph, dark theme, node filter, inspection drawer, and REST API.
- [x] **Multi-Machine Vault Sync.** Delta changeset export, two-way peer vault synchronization (`memo sync-vault`), and conflict-safe resolution.
- [x] **HTTP / SSE MCP Server Transport.** Standalone network daemon (`memo serve --sse`) supporting Server-Sent Events (SSE) for remote agents and IDE plugins.

---

## 10. Recurrence learning & ops visibility (Phase 6)

- [x] **Trap recurrence ranking.** `memo rank` lists active traps by `occurrences`; optional `--layer`, `--backfill`; `memo promote --format skill` exports owner skill from ranked traps.
- [x] **MCP status monitor.** Companion HTTP page (default `:3124`) co-hosted with `memo serve --sse`: vault list, server health, vault-filtered live activity log (capture → ring buffer → SSE stream).
- [x] **Status monitor vault backup UI.** Zero-friction export (.zip with `vault-backup.json`, optional AES-256-GCM) and restore (multipart .zip upload with confirmation and overwrite) from the `:3124` status page.
- [x] **Dedicated Backups tab.** Status monitor **Backups** page with full-vault confirm, complete kind archives (including prompts/sessions), inventory filters, details drawer, and row restore/delete/download.
- [x] **Status monitor client tracking & request visibility.** Real-time tracking of active and recent vault clients (proxy vs direct-remote badges, client IP, client name, bound vault, active status, request count) with rich display of all HTTP endpoints and MCP commands in the live activity log (`GET /api/clients`, `GET /api/status`).
- [x] **Complete Vault Database Reset with Mandatory Pre-Wipe Backup.** Complete database reset and disk clean (`memo reset`, `POST /api/vaults/reset`) with automatic pre-wipe backup snapshots stored as `{YYYY-MM-DD-HH-mm-ss-backup}.zip` in `$SPEC_MEMO_ROOT/backups/`, unlinking records, compiled views, and SQLite databases while strictly preserving `config.json` and `backups/`.
- [x] **Full Backup Restoration Engine & Management.** Seamless restoration from ZIP archives and raw payloads (`memo restore`, `memo backups`, `GET /api/vaults/backups`, `POST /api/vaults/restore`) supporting one-click restoration from saved backups and `--latest` restore flag.
- [x] **Proxy Instance Status Monitor & 3-Mode Architecture Topology.** Stdio `memo serve` starts the `:3124` companion only with `--status` / `--status-port`. `memo serve --sse` co-hosts it by default. Remote proxy mode records on the in-process activity bus and visualizes topology (Local Vault, Intermediary Proxy, Final Remote Master Vault).

---

## 11. Deployment modes & portable MCP wiring (Phase 7)

- [x] **Local, Hybrid, and Remote Deployment Modes.** Configured via `mode` in `config.json` (`memo setup --mode local|hybrid|remote`).
- [x] **Uniform Stdio MCP Wiring.** All agent hosts (Cursor, VS Code, OpenCode, Antigravity, Claude Desktop) spawn `memo serve` locally. Mode switching is managed entirely inside the vault.
- [x] **Configurable Daemon Ports via `config.json`.** Global configurable port assignments (`ports.sse`, `ports.status`, `ports.canvas`, with `mcp`/`ui` aliases) in `config.json` defaulting to `:3123` (SSE), `:3124` (Status monitor), and `:3125` (Canvas viewer), cleanly overridden by CLI arguments.
- [x] **Operational Status & Configuration Inspector (`memo status`).** Dedicated read-only CLI command (`memo status`, aliases: `memo info`, `memo state`, `memo setup --check`) performing live HTTP reachability probes (SSE `:3123`, Status companion `:3124`, Canvas visualizer `:3125`, remote `/health`), active project record breakdown, global vault SQLite FTS5 footprint, and backup snapshot inventory.
- [x] **Setup & Host Wiring Helper (`memo setup`).** Configures mode, remote URL, checks environment bearer tokens without persisting them to disk, and prints/writes editor MCP configs (`--host`, `--print-mcp`, `--write-mcp`).
- [x] **Daemon HTTP Sync Routes.** `/api/sync/pull`, `/api/sync/push`, and `/api/sync` on the SSE daemon origin with bearer token authentication.
- [x] **Hybrid Bidirectional Sync & Debounced Push.** Low-latency local cache with automatic remote delta pulls on `bootstrap` (fail open) and debounced push scheduling after mutating operations (`upsert`, `append`, `forget`, `gc`).
- [x] **Remote Stdio Proxy Server.** In `remote` mode, `memo serve` transparently proxies all 11 MCP tools to the remote daemon over SSE with bearer authentication. Fails closed with structured `REMOTE_UNREACHABLE` errors.
- [x] **Remote Mode CLI Restrictions.** Extras (`canvas`, `sync-vault`, `export-vault`, `import-vault`, `hook`) refuse with exit code 1. `doctor`, `setup`, and `check-version` run locally. `rank` proxies to the daemon.
- [x] **Operational Telemetry & Rolling Usage Logging.** Configurable switch `enableTelemetry` in `config.json` (default `true`); append-only structured JSONL streaming under `$SPEC_MEMO_ROOT/telemetry/`; rolling daily part rotation (`telemetry-YYYY-MM-DD.part-N.jsonl`) by file size limit (`maxFileSizeMb`); non-blocking fail-safe queue with zero-crash error isolation and secret redaction.
- [x] **Prompt, session, activity & rule derivation.** Vault kinds `prompt`/`session`; 11th MCP tool `prompt` (record/list/get/search/session lifecycle/activity/derive/export); FTS search; status monitor Prompts explorer; CLI `memo prompt|session|activity`; IDE rule promote allowlist; packaged `ws-session-tracking`.

---

## 12. Explicitly not features (v1)

| Idea | Why not |
|------|---------|
| MCP tool for sync | Sync is daemon HTTP transport route, not an MCP tool |
| Extra MCP tool for “list files in vault” | Leaks layout; use `search` |
| Auto-rewrite specs when code changes | Drift is a flag, not an author |
| Auto-`promote` into README | Default deny |
| Bundling the vault in the product clone | Violates UC1 |

---

## 13. Shipped in this repository today

| Capability | Status |
|------------|--------|
| Product requirements and phase map | `[x]` [`PRODUCT.PRD`](PRODUCT.PRD) |
| This inventory | `[x]` |
| Implementation plan | `[x]` [`PLAN.md`](PLAN.md) |
| Agent contract | `[x]` [`AGENTS.md`](AGENTS.md) |
| Human README | `[x]` [`README.md`](README.md) |
| Runtime (Phases 1–7 complete) | `[x]` |



