# spec-memo — Implementation plan

**Audience: humans and agents.** Scope and proof live here. Requirements live in [`PRODUCT.PRD`](PRODUCT.PRD). Capabilities live in [`FEATURES.md`](FEATURES.md).

Status: **shipped** (Phases 0–5 complete; Phase 6 in progress). Runtime on `develop`; 154 tests passing.

---

## Stack (working decision)

| Choice | Default | Why |
|--------|---------|-----|
| Language | TypeScript on Node 22 | MCP SDK is mature; matches workflow-skills Node 22 consumers |
| MCP | Official MCP TypeScript SDK, **stdio only** in Phase 1 | Host-neutral; no HTTP surface to secure |
| CLI | Same package bin `memo` | One module; CLI wraps tool handlers |
| Frontmatter | `gray-matter` or equivalent | Records stay Markdown |
| Index | `better-sqlite3` FTS5 | Local, rebuildable, no service |
| Tests | Node test runner (`node:test`) | No extra runner in v1 |
| Package | Single npm package in this repo | CLI + MCP entrypoints |

Revise this table in `PRODUCT.PRD` § Constraints if the stack changes. Do not add Express, Prisma, or an embedding library in Phase 1.

---

## Open choices (pinned)

| Choice | Pin | Revisit |
|--------|-----|---------|
| Vault git | Off by default; `config.json` may set a remote later (Phase 3) | Phase 3 |
| Obsidian | Compatible filenames; not a dependency | Phase 4 viewer |
| Multi-project | One vault, many `projectId`s; search defaults to current remote | Phase 3 `crossProject` |
| Hook host | Phase 1: refuse via API when `productRoot` is known. Phase 2: skill + pre-commit in the **consumer** | Phase 2 |
| Bootstrap budget | 8 KB UTF-8 | After dogfood |

---

## Phase 0 — Optional consumer remap (not this repo)

**Goal.** Prove “plans outside the product tree” with **zero spec-memo code**.

**Action.** On a throwaway clone of a consumer (workflow-skills or similar), set `plans.dir` and `plans.specsDir` to absolute paths under `~/.spec-memo-test/<project>/`. Do not relocate `{sharedDir}`.

**Proof.** `git status` in the product clone does not list plan/spec dumps; one live workflow can still read/write the remapped dirs.

**Stop.** This will **not** move `MEMORY.md`. Do not treat Phase 0 as Phase 1 done. Do not commit consumer config from that experiment into *this* repository.

---

## Phase 1 — MVP in this repository

Build order is the dependency order. Do not start slice N+1 until slice N’s proof is recorded in § Done log (or the user explicitly parallelizes).

### Slice 1 — Package skeleton

**Deliver.** `package.json`, `src/` layout, `memo` bin stub, MCP stdio stub that lists tools and returns “not implemented” with a stable error shape.

**Proof.** `node --test` (or `npm test`) runs at least one test; `npx memo --help` prints the eight commands; MCP handshake lists the eight tools.

**Out of slice.** Real vault writes.

### Slice 2 — Vault and identity

**Deliver.** Create `$SPEC_MEMO_ROOT` (default `~/.spec-memo`, override in env and tests via temp dir). `projectId` from normalized remote; fallback path id. `project.json` last-seen root.

**Proof.** Two temp git repos with the same `origin` URL share one `projectId`. A repo with no remotes gets a path-based id. Tests never write to the developer’s real `~/.spec-memo`.

### Slice 3 — Records and compiled indexes

**Deliver.** `upsert`/`get` for `trap` and `decision` (minimum); write Markdown+frontmatter; regenerate `TRAPS.md` / `DECISIONS.md` / `INDEX.md` from sources.

**Proof.** Invalid frontmatter fails; compiled files match sources after upsert; deleting a compiled file and rebuilding restores it.

### Slice 4 — FTS index

**Deliver.** `search` using SQLite FTS; rebuild from vault; default kind filter.

**Proof.** Search finds a trap by keyword and by `pathPatterns`; `scratch` is omitted unless requested; deleting `memo.sqlite` and rebuilding yields the same hits.

### Slice 5 — Remaining kinds + `append` + `forget`

**Deliver.** `spec`, `plan`, `state`, `log`, `scratch`, `review`. `append` is write-only. `forget` archives traps (purge requires a flag that tests use explicitly).

**Proof.** Append does not rewrite older events. Forget on a trap sets `archived` and keeps the file until purge.

### Slice 6 — `bootstrap` budget

**Deliver.** Bind cwd → project; rank traps; cap 8 KB; `truncated` flag.

**Proof.** A vault with many traps returns ≤ 8192 bytes of brief payload (JSON). Low-severity traps drop before high. Logs are absent.

### Slice 7 — `gc` + redaction + refuse product write

**Deliver.** TTL for scratch/review; compact shipped plans; reject secret-like bodies; refuse creating record files under `productRoot`.

**Proof.** Expired scratch gone after `gc`. `upsert` with a PEM block fails. Given a temp git repo as `productRoot`, handlers do not create files inside it.

### Slice 8 — CLI parity + `memo import` + `memo doctor`

**Deliver.** Each tool as a CLI command with `--json`. Import mapping per [`FEATURES.md`](FEATURES.md) § Import (fixture tree, not the live workflow-skills clone). `doctor` reports bind + FTS + pollution scan.

**Proof.** Fixture import is idempotent (second run does not duplicate slugs). Doctor lists a planted `.agents/plans/foo.md` under a fixture product root as pollution.

### Phase 1 exit (all slices)

A **clean product fixture** (git repo with only `README.md`) plus a vault populated by import/upsert:

1. `memo bootstrap` (cwd = fixture) returns traps and does not create files in the fixture.
2. `git status` in the fixture is clean.
3. `npm test` exit 0.

---

## Phase 2 — workflow-skills adapter

Tracked in [`PRODUCT.PRD`](PRODUCT.PRD) § Feature map. **Do not implement in this repo as a copy of workflow-skills.** When started: a separate change in workflow-skills that calls this MCP/CLI, relocates hub data, and adds a write hook.

**Proof (then).** `ws-self-learning` / `ws-changelog` write only to the vault; delivery commits in the consumer contain product files only.

---

## Phase 3 — Curator hardening

Trap dedup, spec SHA drift on bootstrap, optional vault git, opt-in cross-project search. See PRD feature map.

---

## Phase 4 — Viewers

CLI polish; optional plugin/Obsidian **viewer**. Not the agent contract.

---

## What not to do in this repo

- Create `.agents/plans`, `.agents/specs`, `MEMORY.md`, or session state files.
- Add a plugin, HTTP server, or embedding dependency during Phase 1.
- Split every PRD row into `*.spec.md` before the slice starts (duplicates the index).
- Vendor workflow-skills skills into this tree.

---

## Suggested first implementation commit after docs

Slice 1 only (skeleton + failing-or-stub tests for the eight tools). Do not bundle Slices 2–8 in one PR.

---

## Done log

| 2026-08-22 | docs-v0 | PRODUCT.PRD, FEATURES.md, PLAN.md, AGENTS.md, README.md written |
| 2026-08-22 | slice-1-skeleton | Package skeleton, 8 MCP tools & CLI stubs, type/schema definitions, test suite |
| 2026-08-22 | slice-2-vault-identity | Vault root ($SPEC_MEMO_ROOT), git remote normalization, project ID binding, project.json, directory scaffolding, test suite |
| 2026-08-23 | slice-3-records-indexes | Record schema validation, upsert/get engine, superseding workflow, TRAPS.md / DECISIONS.md / INDEX.md compiler, test suite |
| 2026-08-23 | slice-4-fts-index | SQLite FTS5 disposable index (memo.sqlite), Porter stemmer, pathPatterns glob filter, rebuildIndex, search CLI & MCP tool, test suite (66771e4) |
| 2026-08-23 | slice-5-remaining-kinds-and-events | Full record kinds matrix (spec, plan, state, log, scratch, review), write-only append log stream, forget soft-archive & purge, test suite (1dbc5ac) |
| 2026-08-23 | slice-6-bootstrap-brief | Bootstrap session brief generation, 8 KB UTF-8 token budget capping, trap severity/path ranking, zero-write proof, test suite (4884172) |
| 2026-08-25 | slice-7-curator-gc-safety | Curator GC (TTL 7d scratch / 14d review), shipped plan compaction, secret redaction, product-tree write guard, test suite |
| 2026-08-25 | slice-8-import-and-doctor | CLI parity, memo import, memo doctor diagnostics, memo promote export, test suite |
| 2026-08-25 | slice-9-relocatable-hub | Relocatable hub storage resolution and vault path resolver, test suite |
| 2026-08-25 | slice-10-memory-adapter-mcp | Consumer memory adapter module for MCP/CLI integration, test suite |
| 2026-08-25 | slice-11-write-block-hook | Pre-commit git hook generator and installer CLI command, test suite |
| 2026-08-25 | slice-12-trap-dedup | Trap deduplication and automatic superseding engine, test suite |
| 2026-08-25 | slice-13-spec-drift | Specification git SHA drift detection during session bootstrap, test suite |
| 2026-08-25 | slice-14-vault-git | Opt-in private git remote sync for vault persistence, test suite |
| 2026-08-25 | slice-15-cross-project-search | Opt-in multi-project cross-vault search engine, test suite |
| 2026-08-25 | slice-16-embeddings-search | Optional vector similarity search backend fallback engine, test suite |
| 2026-08-25 | slice-17-cli-doctor | Interactive CLI doctor health inspector with --rebuild and --fix options, test suite |
| 2026-08-25 | slice-18-viewer | Passive Markdown & Obsidian wikilink viewer compatibility, test suite |
| 2026-08-25 | slice-19-log-compaction | Monthly log roll-up compaction and FTS5 indexing, test suite |
| 2026-08-25 | slice-20-promote-adr | Promote-to-ADR formatting templates and directory destination resolution, test suite |
| 2026-08-25 | slice-21-vault-backup | Encrypted vault backup, export, and restoration engine (AES-256-GCM), test suite |
| 2026-08-25 | slice-22-canvas-viewer | Interactive Canvas UI and Visual Graph Viewer, test suite |
| 2026-08-25 | slice-23-multi-machine-sync | Multi-Machine Vault Synchronization and Delta Engine, test suite |
| 2026-08-25 | slice-24-mcp-sse-transport | HTTP and Server-Sent Events (SSE) MCP Transport, test suite |
| 2026-08-26 | trap-recurrence | Trap recurrence ranking, occurrence counters, memo rank, promote format:skill; npm test 154 pass |

---

### Slice 26 — MCP status monitor (`mcp-status-monitor`)

**Deliver.** Activity Event Bus (`src/activity.ts`); status companion HTTP server on default port `3001` co-hosted with `memo serve --sse`; vault-filtered live activity log UI (`src/status.ts`); tool + HTTP event capture; CLI flags `--status-port`, `--no-status`; README/AGENTS port map.

**Proof.** `npm test` exit 0 including `activity.test.ts` and `status.test.ts`; status page at `http://127.0.0.1:3001/` shows vault list + live stream; read-only (no vault writes from status routes).

**Spec.** [`.agents/specs/mcp-status-monitor.spec.md`](.agents/specs/mcp-status-monitor.spec.md) — 49 ACs.

---

## Phase 7 — Deployment Modes & Portable MCP Wiring

### Slice 27 — Deployment Modes (`deployment-modes`)

**Deliver.** Local, Hybrid, and Remote deployment modes in `config.json`; `memo setup` config and host MCP generation/writing (`--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`); doctor mode and remote health diagnostics; daemon HTTP sync routes (`POST /api/sync/pull`, `POST /api/sync/push`, `POST /api/sync`); hybrid background debounced push scheduler and fail-open bootstrap pull; remote stdio MCP proxy server forwarding 10 tools over SSE; remote mode CLI restrictions.

**Proof.** `npm test` exit 0 (28 suites, 215 tests pass) including comprehensive `deployment-modes.test.ts`.

**Spec.** [`.agents/specs/deployment-modes.spec.md`](.agents/specs/deployment-modes.spec.md) — 32 ACs.

| 2026-08-26 | mcp-status-monitor | MCP status monitor with Activity Event Bus, :3001 companion, live SSE log; npm test 178 pass |
| 2026-08-26 | release-0.2.0 | Package, MCP server, and vault config version bumped to 0.2.0 for Phase 6 |
| 2026-08-26 | mcp-version-and-skill-install | check_version + install_skills MCP/CLI; PRODUCT 10-tool amendment; docs/skill surface; npm test 196 pass |
| 2026-08-26 | release-0.3.1 | Align ws-memo skill + docs to 10-tool surface; bump package/MCP/vault versions to 0.3.1 |
| 2026-08-26 | release-0.3.2 | Fix MCP SSE initial connect with query-token auth & CORS; add documentation website & GitHub Pages deploy workflow; bump version to 0.3.2 |
| 2026-08-26 | deployment-modes | Deployment modes (Local, Hybrid, Remote), memo setup, daemon HTTP sync routes, hybrid debounced push & fail-open pull, remote stdio MCP proxy, 32 ACs; npm test 215 pass |
| 2026-08-26 | release-0.4.0 | Phase 7 deployment modes (Local, Hybrid, Remote), memo setup, stdio MCP proxy; bump version to 0.4.0 |
| 2026-08-26 | hybrid-sync-review-fixes | Honor daemon dryRun, cwd-scoped hybrid push, debounce single-flight, hybrid-state vault lock; npm test 219 pass |
| 2026-08-26 | status-vault-backup-ui | Status monitor vault export & import UI (.zip pack/unpack, POST /api/vaults/export & import, activity bus capture, auth); npm test 236 pass |
| 2026-08-26 | release-0.4.1 | Status monitor vault export and import UI, SSE error logger, ws-memo skill docs update; bump version to 0.4.1 |
| 2026-08-26 | release-0.4.2 | Fix test suite error log leakage and auth token env isolation, classify 401 unauthorized requests as WARN, format descriptive hybrid sync timeout errors; npm test 247 pass; bump version to 0.4.2 |

When a Phase slice lands, append a row and tick the matching boxes in `PRODUCT.PRD` / `FEATURES.md`.



