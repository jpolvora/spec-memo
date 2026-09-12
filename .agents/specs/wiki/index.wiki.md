# Project Living Feature Wiki & Domain Knowledge Base

## System Vision & Overview

`spec-memo` gives coding agents a **curated working memory that lives outside the product git repository**: traps, decisions, specs, plans, state, and logs. Instead of dump-reading hundreds of leftover workflow files, an agent calls `bootstrap` and receives a token-capped session brief; it recalls with `search`/`get` and remembers with `upsert`/`append`. Product clones stay source plus shipped documentation.

The runtime is a **single Node 22 / TypeScript package** exposed through two equal front doors — an MCP stdio server and the `memo` CLI — that share one module. Record content is **Markdown with YAML frontmatter (the source of truth)**; a **SQLite FTS5 database is a disposable index**, rebuildable from the files at any time. The default deployment is **local-first** (a filesystem vault under `$SPEC_MEMO_ROOT`, default `~/.spec-memo`), with optional **hybrid** (local cache + remote daemon delta sync) and **remote** (stdio proxy to a daemon) modes.

Beyond the core store, the product ships human and operational surfaces: a status monitor, an interactive Canvas graph viewer, operational telemetry, encrypted backup/restore, multi-machine vault sync, conflict reconciliation, per-project vault wikis, and a vault manager. The system is host-neutral: no IDE is named in any schema or tool contract.

## Architectural Boundaries

- **Product git is not a memory store.** Working memory never lands in a consumer tree; `upsert`/`promote` default-deny writes under a known product root.
- **Vault root is `$SPEC_MEMO_ROOT`** (default `~/.spec-memo/`): `config.json`, `memo.sqlite`, and `projects/<projectId>/{INDEX.md,TRAPS.md,DECISIONS.md,traps/,decisions/,specs/,plans/,logs/,reviews/,scratch/}` plus prompt/session stores.
- **Project identity = normalized git remote**; fallback is the canonicalized absolute repo root. `<projectId>` is a stable filesystem-safe encoding of that identity.
- **One MCP module, two transports.** Stdio (default) and HTTP/SSE (daemon). Exactly **11 MCP tools**: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version`, `install_skills`, `prompt`. New tools require a `PRODUCT.PRD` amendment.
- **CLI parity.** `memo <command>` maps 1:1 to the MCP surface plus CLI-only extras (`doctor`, `rank`, `import`, `sync`, `reconcile`, `canvas`, `reset`, `restore`, `backups`, `vault`, `wiki`, `session`, `activity`, `install-hooks`, `shutdown`/`stop`).
- **Policy layer** owns schema validation, TTL/expiration, secret redaction, capture exclusions (`.spec-memo-ignore`), and the refuse-in-repo-write guard.
- **Record kinds** with retention: `trap` (until superseded), `decision` (until superseded), `spec` (until shipped → archive), `plan` (active → compact), `state` (workflow-active), `log` (append-only, monthly rollup), `scratch` (TTL 7 days), `review` (TTL 14 days), `prompt` / `session` (continuity).
- **Compiled views** (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`, `PROMPTS.md`, `SESSIONS.md`) are regenerated, never hand-edited.

## Domain Catalog

### foundation

Core vault, project binding, the record store and schema, the disposable FTS index and retrieval, bootstrap brief assembly, record kinds/events, and spec-of-record drift.
- [Vault Root and Project Identity](foundation/vault-and-identity.md): Vault root resolution chain, remote and path normalization, projectId derivation, project.json, aliases, and local .spec-memo.json overrides.
- [Record Store and Kinds](foundation/record-store.md): Markdown plus YAML schema validation, the kind matrix, upsert/get/append/forget behavior, dedup/supersede/TTL rules, and compiled views.
- [Retrieval and Search](foundation/retrieval.md): Disposable SQLite FTS5 index and rebuild, filters and sort modes, optional embeddings filter, opt-in cross-project search, retrieval hits, and explain scoring.
- [Bootstrap Brief and Spec Drift](foundation/bootstrap-and-drift.md): 8 KB token-budgeted brief assembly, trap and decision ranking, ordered truncation, handoff delivery, hit accounting, and verifiedAtSha git drift flags.

### curation

Lifecycle and policy: garbage collection and TTL, log compaction, trap deduplication and recurrence, secret redaction, capture exclusions, memory feedback/salience, and record promotion (ADR / skill export).
- [Garbage Collection, Record TTL, and Log Compaction](curation/gc-and-ttl.md): Curator GC: 7d scratch and 14d review defaults, universal ttl/expires_at, archive-vs-purge sweep, shipped-plan compaction, monthly log roll-up, and search expiration filters.
- [Safety Boundaries, Secret Redaction, and Capture Exclusions](curation/safety-and-capture.md): Fail-closed secret detection on upsert/append, read-path redaction, product-tree write guard, and .spec-memo-ignore plus ignorePaths and baseline enforcement.
- [Trap Lifecycle: Deduplication, Recurrence, Feedback, and Salience](curation/trap-lifecycle.md): Trap shape, overlap-based dedup that bumps occurrences, memo rank --backfill, helpful/stale feedback, salience dampening, and typed record links.
- [Record Promotion and Skill Export](curation/promote-and-export.md): Default-deny promote into the product tree, raw/adr/madr/skill formats, destination resolution, force-overwrite, and top-N ranked-trap skill compilation.

### interfaces

Agent- and human-facing entry points and adapters: the `memo` CLI, `doctor`/`status` diagnostics, the importer, the relocatable consumer hub and memory adapter, the write-block hook, viewers, MCP version/skill installation, and interactive host hooks/skill installers.
- [CLI Surface (memo)](interfaces/cli.md): memo CLI parsing, aliases, 1:1 tool mapping plus extras, stdout/stderr and --json contract, exit codes, read-only status, and the US-36 OpenCode snippet shape.
- [Diagnostics (memo doctor)](interfaces/diagnostics.md): doctor vault/FTS/bind/pollution checks, ignore-aware scan, run.json boundary match, tracked-safe --fix, --rebuild, and --check-capture.
- [Legacy Workflow Tree Import](interfaces/import.md): memo import legacy tree mapping of specs/memory/plans/state/changelog, skip rules, stable-id and content-hash idempotency, and result accounting.
- [Agent Adapters and Installers](interfaces/agent-adapters.md): Relocatable memory adapter, write-block pre-commit hook, install-hooks/install-skills wizard with scope/hosts/conflictPolicy/confirm, and Codex support.
- [Human Viewer Compatibility](interfaces/viewer.md): Passive Markdown and Obsidian compatibility: vault layout, frontmatter, compiled-view relative links and id tokens, with no runtime viewer dependency.
- [MCP Version and Skill Installation Tools](interfaces/mcp-tooling.md): check_version soft-fail semver compare and install_skills permission gate, allow-list, scopes, conflict policies, and vault-overlap deny.
- [Virtual File System over MCP](interfaces/virtual-file-system.md): Draft/unimplemented VFS: documents the absence of originRelPath, MCP resources, and --cleanup plus the planned ACs and open questions.

### connectivity

Network and persistence topology: deployment modes, HTTP/SSE transport, the status monitor, Canvas viewer, operational telemetry, multi-machine sync, vault-git and hybrid batched sync, conflict reconciliation, encrypted backup/restore/reset, and graceful server shutdown.
- [Deployment Modes](connectivity/deployment-modes.md): Local/hybrid/remote modes, memo setup and URL/token rules, stdio proxy, daemon /api/sync routes, and remote CLI restrictions.
- [SSE Transport](connectivity/sse-transport.md): memo serve --sse on :3123, /sse, /message, /health, non-loopback auth refusal, status co-start, and graceful close.
- [Status Monitor](connectivity/status-monitor.md): Companion :3124 activity bus, live SSE log and vault filter, dedicated Backups tab, inventory filters, restore/delete/download/inspect, and auth.
- [Canvas Viewer](connectivity/canvas-viewer.md): memo canvas :3125, SVG graph, node filter and inspection drawer, and /api/projects|graph|record|search.
- [Operational Telemetry](connectivity/telemetry.md): enableTelemetry (default true), JSONL under telemetry/, part-N rolling by maxFileSizeMb, non-blocking queue, and redaction.
- [Vault Sync](connectivity/vault-sync.md): vault-git opt-in with atomic:false batched flush points, dual-mode hybrid-to-git sequential dispatch, deltas, smart-merge/rollback journal, and US-55 hardening.
- [Backup and Restore](connectivity/backup-restore.md): AES-256-GCM/PBKDF2 archive engine, export/import/restore, reset with mandatory pre-wipe backup, listBackups, and 3-mode topology.
- [Server Lifecycle](connectivity/server-lifecycle.md): memo shutdown/stop: cmdline discovery, SIGTERM to force, vaultRoot scoping, dry-run, --include-canvas, JSON, and PID-reuse revalidation.

### continuity

Session and knowledge continuity across agents and time: prompt/session history ingestion, activity reports, rule derivation, cross-agent handoff batons, per-project vault wikis, and the vault alias/merge manager.
- [Prompt History, Sessions and Activity](continuity/prompt-history.md): Vault prompt/session kinds, the 11th MCP tool prompt with all actions, FTS and pagination, rule derivation and IDE-promote allowlist, and activity/invoicing.
- [Cross-Agent Session Handoff Baton](continuity/session-handoff.md): Owner/branch-isolated single-use batons, precedence over shared batons, peek-then-claim in bootstrap, memo session handoff CLI, and status Active Handoffs panel.
- [Per-Project Vault Wiki](continuity/project-wiki.md): Vault projects/{projectId}/WIKI.md, deterministic render, fail-open AI polish, status Wiki tab and /api/wiki routes, and memo wiki CLI.
- [Vault Manager, Aliases and Local Binding](continuity/vault-manager.md): projectAliases redirect/cycle rules, .spec-memo.json file-first identity, dedup merge metrics, rename/delete semantics, and status Vaults tab.
