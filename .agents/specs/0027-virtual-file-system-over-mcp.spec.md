---
id: null
slug: virtual-file-system-over-mcp
title: "Virtual File System over MCP (Repo Ingest, Cleanup & Path-Mapped Memory)"
source: local
specDate: 2026-08-26
status: draft
target_phase: Phase 6
---

# Specification — Virtual File System over MCP (Repo Ingest, Cleanup & Path-Mapped Memory)

## Description

Today `spec-memo` operates with an external sidecar vault (`~/.spec-memo/projects/{projectId}/`) to enforce the core invariant: **Product git is not a memory store**.

While `memo import` migrates legacy `.agents/specs`, `memory/`, and `.agents/plans` into standard vault kinds (`spec`, `trap`, `decision`, `plan`, `log`), existing repositories often contain diverse artifacts across multiple directories (e.g. `docs/`, `reports/`, design documents, run transcripts, review logs). Once imported or relocated to the external vault to keep Git clean:
1. Historical repo-relative file paths are lost unless explicitly tracked in record frontmatter.
2. Agents searching or querying for files by their traditional relative paths in the repo fail unless those paths are indexed and searchable.
3. Standard LLM / MCP clients lose direct visibility into purged repository documents unless `spec-memo` exposes them as virtual files or MCP resources.

This specification proposes **Virtual File System (VFS) over MCP**, comprising:
1. **Generalized Repository Ingestion & Relative Path Metadata (`originRelPath` / `sourcePath`):** Extend the importer and upsert pipeline to ingest arbitrary repository documentation, reports, specifications, and plans, storing `originRelPath` (e.g. `docs/architecture.md`, `reports/perf-benchmark.md`, `.agents/plans/slice-01/plan.md`) in record frontmatter and the FTS index.
2. **Optional Working Tree Cleanup (`--cleanup` / `--delete-source`):** An optional, interactive/confirmed cleanup flag to safely remove ingested files and empty parent directories from the product git tree after successful vault persistence and index verification.
3. **MCP Virtual File System & Resource Provider (`memo://` & Virtual Paths):** Expose vault records via standard MCP Resources (`resources/list`, `resources/read`) mapped to virtual URI schemes (e.g. `memo://{projectId}/{originRelPath}`) and enable path-based resolution in existing tools (e.g. `get(path="docs/architecture.md")`).

Design reference: **OpenViking (`viking://`)** — see § OpenViking VFS Analysis below. `spec-memo` adopts its URI/scoping, `ls`/`tree`/`stat` semantics, hidden directory summaries, and read-then-tool duality, scaled down to a local-first SQLite-FTS vault with no embedding/VLM dependency and no new MCP tool budget.

## Acceptance Criteria

### Ingestion & Path Metadata

- AC1: `memo import` and `upsertRecord` support recording an `originRelPath` field in `RecordFrontmatter` (string representing the relative path from the repository root, normalized with forward slashes).
- AC2: The SQLite FTS5 schema and indexer index `originRelPath` so records are retrievable by exact path match, directory prefix, or glob pattern via `search(path=...)` and `get(path=...)`.
- AC3: `memo import` accepts flexible source candidate patterns (including `docs/**/*.md`, `reports/**/*.md`, `.agents/specs/**/*.md`, `.agents/plans/**`, `specs/**/*.md`, and custom glob patterns via `--include <glob>`).
- AC4: Ingested documents default to appropriate kinds (`spec`, `plan`, `review`, `log`, `scratch`, or generic `doc`/`decision`) based on file header metadata, directory origin, or frontmatter `kind` tag.

### Optional Working Tree Cleanup

- AC5: `memo import` supports an optional `--cleanup` (CLI) / `cleanup: true` (programmatic) flag that deletes the ingested source files from the working tree only after successful vault storage and indexing.
- AC6: Working tree cleanup refuses to delete files if any secret is detected, if indexing fails, if git status indicates uncommitted untracked conflicts, or without explicit human confirmation in interactive mode.
- AC7: Cleanup safely removes empty parent directories left behind after ingesting legacy `.agents/` or `memory/` directories without affecting un-ingested files.

### MCP Virtual File System & Resource Provider

- AC8: The MCP server registers standard MCP Resource capabilities (`resources/list`, `resources/read`, `resources/templates/list`) in `createMcpServer`.
- AC9: `resources/list` returns all active project records formatted as MCP resources with URIs of the form `memo://{projectId}/{originRelPath}` (or `memo://{projectId}/{kind}/{slug}.md` when `originRelPath` is undefined), including MIME type `text/markdown` and human-readable names.
- AC10: `resources/read` resolves the resource URI, retrieves the record body and serialized frontmatter from the vault, and returns the contents to the MCP client without touching the local workspace filesystem.
- AC11: MCP tool `get` accepts an optional `path` parameter (e.g. `get({ path: "docs/architecture.md" })`) to resolve records directly by their original relative path.
- AC12: MCP tool `search` allows filtering or boosting by `path` matching against `originRelPath`.
- AC13 (URI canonicalization): `memo://{projectId}/` root lists kinds as virtual directories; trailing `/` denotes a directory, bare path denotes a file (OpenViking convention). `originRelPath` is normalized to forward-slashes, no leading `./` or `/`, no `..` escape; Windows backslashes converted on ingest. Canonical record URI is `memo://{projectId}/{kind}/{slug}.md`; `memo://{projectId}/{originRelPath}` is a stable alias recorded in frontmatter. Both resolve in `resources/read` and `get(path=...)`.
- AC14 (directory summaries): every virtual directory synthesizes a read-only overview from its direct children (titles + first ~200 chars, max ~4 KB) — the local-FTS analogue of OpenViking L0/L1 `.abstract.md`/`.overview.md`, computed on demand, never persisted as records. `resources/list` on a directory prefix returns children + this summary; normal record listing hides the synthetic summary (same hidden-sidecar rule as OpenViking `ls`).
- AC15 (scoped search): `search(path=...)` supports exact match, directory-prefix match (`docs/` matches `docs/**`), and glob (`docs/**/*.md`, `reports/*.md`). Directory-scoped search constrains FTS to that subtree before ranking (OpenViking `target_uri` semantics). `bootstrap --path` uses the same resolver.
- AC16 (FS consistency): `rm`/`mv` equivalents (`forget`, `upsert` with new `originRelPath`) keep FTS in sync: delete removes the URI prefix index entries (idempotent — missing URI still succeeds); move re-keys the URI (OpenViking VikingFS `rm`/`mv` sync rule). `stat`-equivalent metadata (`size`, `updated`, `kind`, `originRelPath`, vault `id`) is returned by `get` alongside body.
- AC17 (project isolation): `memo://{projectId}/...` never leaks across projects; `resources/list` defaults to the `cwd`-bound project. `crossProject: true` must be explicit to list other projects (mirrors OpenViking `resources` vs `user/{id}` ACL boundary, minus auth server).

### Enablement, Install & Uninstall Lifecycle (Optional, Default Off)

- AC18 (optional, default disabled): VFS ships **disabled**. `config.json` gains `vfs.enabled: boolean` (absent key ≡ `false`, backward compatible; optional per-project override `projects.{id}.vfs.enabled`). When disabled: `createMcpServer` advertises `{ capabilities: { tools: {} } }` only (no `resources/*`); `get`/`search`/`bootstrap` with `path` matching an `originRelPath` fail closed with `VFS_DISABLED` + "run `memo vfs enable`" hint (existing `pathPatterns` matching keeps working); generalized doc `--include` ingest + `--cleanup` of VFS globs refuse with the same hint. Existing import/bootstrap/search/get behavior is otherwise unchanged — upgrade is a no-op until the operator opts in.
- AC19 (enable / install / setup): `memo vfs enable [--yes] [--include <glob>...] [--dry-run]` performs the install procedure, idempotent on re-run: (1) persist `vfs.enabled=true` to vault `config.json`; (2) migrate + `rebuildIndex` so `originRelPath` is indexed (verify indexed-count > 0 or clean zero-state); (3) print a `--dry-run`-style import manifest preview (`sourcePath → memo://{projectId}/{originRelPath}`) without deleting anything; (4) report that `resources/list`+`resources/read` activate on next `memo serve` (re)start — no hot-patch of a running daemon; (5) exit non-zero with the exact failed step on migration/index failure, leaving `vfs.enabled=false`. `--dry-run` runs steps (2-precheck)+(3) only and writes nothing. Without `--yes`, prompt for confirmation before persisting.
- AC20 (disable / uninstall / clean with save-back + sync): `memo vfs disable [--restore] [--sync] [--yes]` performs the uninstall procedure, idempotent on re-run: (1) **save back**: flush pending vault state — `rebuildCompiledViews` + `rebuildIndex`, then sync (`memo sync` semantics: hybrid HTTP first, then batched vault-git flush; `--sync` forces it even when clean, default = sync only when dirty); abort disable on sync failure with the sync error (no silent skip); (2) **optional restore**: with `--restore`, write back every vault record carrying `originRelPath` that is missing on disk via the `promote --restore` / `export --to-repo` path — never overwrite a dirty/newer working-tree file without `--force` + confirmation; print `restored / skipped-dirty / skipped-identical` counts; without `--restore`, leave the working tree untouched; (3) persist `vfs.enabled=false` so the next `memo serve` (re)start drops the `resources/*` capability; (4) print post-disable state (VFS off, vault records **retained** — disable never deletes vault data; purge only via explicit `forget`/`gc`). `doctor`/`status` confirm the off state (see AC21).
- AC21 (visibility): `memo vfs status`, `memo status`, and `memo doctor` report `vfs.enabled`, whether the running server advertises `resources/*`, count of records indexed by `originRelPath`, and pending-restore count (vault records with `originRelPath` missing on disk). `doctor --fix` never flips the flag; it only reports drift.

## Original Issue Context

### User Prompt / Request

> /ws-write-spec add a new feature: offer to import specs, plans, reports, docs from repo, ingest into memory and cleanup repo (optional step). each entry should have metadata attached for the original file path relative to repo root. Then a kind of virtual files system via mcp can be created by converting paths to virtual paths accessible through mcp spec-memo. Draft this spec, later I will refine and define what will really be implemented and shipped. Write your suggestions on top of it (append). Be critical and analytic to this feature, checking if worst or not.
> Title: "virtual file system over mcp"

### Prior Work Sweep

- Prior feature specs:
  - `import-and-doctor.spec.md` (shipped in Phase 1): introduced `memo import` for `.agents/specs`, `memory/`, `.agents/plans`, `CHANGELOG.md` with idempotency.
  - `record-schema-and-indexes.spec.md`: defined `RecordFrontmatter` with `pathPatterns`, `linkedPaths`, `tags`, etc.
  - `mcp-sse-transport.spec.md`: added SSE daemon and transport.
  - `mcp-version-and-skill-install.spec.md`: amended MCP tools surface to 10 tools.
- Existing codebase inspection:
  - `src/importer.ts` maps legacy files to vault records but does not persist `originRelPath` in frontmatter.
  - `src/mcp.ts` currently registers `{ capabilities: { tools: {} } }` and handles `ListToolsRequestSchema` / `CallToolRequestSchema`. It does not yet register MCP `resources`.
  - `src/store.ts` supports `getRecord` by `id` or `kind`+`slug`, but not by `path` / `originRelPath`.

### Design Intent

Greenfield extension to the import pipeline and MCP server. Skip `git log -L` bug restoration analysis: no prior VFS or MCP resource implementation existed in `spec-memo`.

## Notes

- MCP Resources are a native capability of the Model Context Protocol (MCP specification 2024-11-05). Exposing vault records as resources is idiomatic and does not expand the 11-tool MCP tool budget (it uses protocol-level `resources/list` and `resources/read`). OpenViking validates this duality at scale: 15 MCP tools *plus* URI-addressable reads, with `find`/`search` scoped by `target_uri` — agents that ignore resources still succeed via tools.
- The cleanup step is inherently destructive to the local git working tree; strict safety guards, dry-run support, and explicit confirmations are essential. Follow OpenViking `cp`/`mv`/`rm` contract language: document non-atomicity, idempotent delete, exact-destination move, parent-must-exist.
- Path normalization must be strictly cross-platform (forward slashes `foo/bar.md`, lowercased comparisons where appropriate, relative to project root).
- Enablement is capability-gated, not hot-patched: flipping `vfs.enabled` takes effect on next `memo serve` (re)start; `vfs status`/`status`/`doctor` show flag vs live-capability skew when a restart is pending.

## Out of Scope

| Feature | Reason |
|---------|--------|
| OS-level FUSE / WebDAV / Virtual Drive Mount | Massive OS dependency complexity; MCP protocol-level virtual resources are sufficient for AI agents. OpenViking ships a minimal WebDAV subset (Phase 1: `resources` only, UTF-8 text `PUT`, no parent auto-create, hidden sidecars) — reconsider only if a non-MCP file-protocol consumer appears. |
| Ingesting binary files, images, or compiled artifacts | `spec-memo` is a text/markdown knowledge vault; binary files belong in git LFS or external storage. (OpenViking handles multimodal via text summaries folded into parent L1 — no per-file sidecar — same principle applies if ever needed.) |
| Automatic background deletion without explicit flag | Working tree deletions must be opt-in, dry-runnable, and confirmed by operator. |
| Two-way real-time filesystem synchronization / watchers | Vault is the authoritative store for ingested memory; live two-way sync introduces race conditions. OpenViking `watch_interval` auto-refresh and `cp` merge-with-rollback semantics are an explicit non-goal for v1. |
| Vector embeddings / VLM-generated L0/L1 summaries / rerankers | OpenViking's semantic layer (VLM abstracts, hybrid vector index, TrieHI directory-aware retrieval) is out of budget for a local-first zero-dependency vault. Directory overviews here are cheap deterministic syntheses, not model outputs. FTS + path-boost + `hits`/`occurrences` ranking stays. |
| New MCP tools for `ls`/`tree`/`write`/`edit`/`grep`/`glob` | OpenViking exposes 15 MCP tools (`find`, `search`, `read`, `list`, `tree`, `write`, `edit`, `grep`, `glob`, `forget`, …). `spec-memo` freezes its 11-tool surface: VFS is `resources/list`+`resources/read` (protocol capability, not a tool) plus `path` params on existing `get`/`search`/`bootstrap`. Full read-write FS tools are a possible Phase 2, not this slice. |
| Multi-tenant ACLs / per-directory permissions | OpenViking has account/user scopes, `~` home alias, and per-file ACLs with discoverable-name `ls`. `spec-memo` v1 needs only `projectId` isolation + explicit `crossProject` opt-in. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| MCP Resource URI scheme | `memo://{projectId}/{originRelPath}`, canonical fallback `memo://{projectId}/{kind}/{slug}.md` | Standard RFC 3986 URI format compatible with MCP clients (Cursor, Claude, Antigravity); mirrors OpenViking `viking://{scope}/{path}` with `{scope} := {projectId}`. Trailing `/` = directory (OpenViking rule). | n |
| Cleanup default safety | `cleanup: false` by default; requires explicit `--cleanup` flag and confirmation | Prevents accidental data loss during initial import runs | n |
| Handling conflicts on ingest | Upsert / overwrite with latest version if content differs; skip if identical | Idempotent import behavior matching existing `memo import` | n |
| Tool count budget impact | No new MCP tools added; utilizes MCP `resources` capability and enhances existing `get`/`search` | Preserves the 10-tool frozen surface while adding VFS functionality | n |
| Enablement default | `vfs.enabled=false` (absent ≡ false); per-project override allowed | Upgrade-safe: existing vaults/daemons see zero behavior change until operator runs `memo vfs enable` | n |
| Enable command | `memo vfs enable [--yes] [--include <glob>...] [--dry-run]`; idempotent; capability live after serve restart | Explicit install step migrates + verifies the `originRelPath` index before advertising `resources/*` | n |
| Disable command | `memo vfs disable [--restore] [--sync] [--yes]`; idempotent; vault records retained | Uninstall = save-back (rebuild + sync) + optional `--restore` to disk + flag off; never deletes vault data | n |
| Directory summaries | On-demand synthesized overview (titles + snippets, ≤4 KB), never persisted | OpenViking L0 (256-char abstract) / L1 (4K overview) sidecars require VLM + vector index; deterministic synthesis gives 80% of navigation value at zero dependency cost | n |
| Path-variable templates (`{calendar:today}` etc.) | Deferred | OpenViking resolves `{calendar:*}` server-side for time-series organization; no demand in `spec-memo` yet | n |
| Other implicit dimensions | N/A because auth is handled by MCP transport and indexing is handled by SQLite FTS | Standard local/SSE operation | n |

---

## OpenViking VFS Analysis — How `viking://` Works and What to Steal

Source: `volcengine/OpenViking` (36.9k★, AGPLv3), docs `concepts/02–05,07`, `api/01,03,20`, `guides/06-mcp-integration`, verified 2026-09-13.

### 1. Core model in one paragraph

OpenViking is a **context database fronted as a virtual filesystem**. Every piece of context (doc, memory, skill, session) lives at a `viking://{scope}/{path}` URI. A dual-layer store separates **content (AGFS/RAGFS, POSIX-like, pluggable localfs/s3fs/memory backends, optional multi-write replicas)** from **index (VikingDB vector index holding URI + vectors + metadata, no file content)**. A `VikingFS` abstraction maps URIs to storage paths (`viking://resources/docs → /local/{account}/{...}`), auto-syncs the index on `rm`/`mv`, and serves hierarchical retrieval on top.

### 2. URI & namespace design (directly reusable)

- Format `viking://{scope}/{path}`; public scopes `resources` (shared objective knowledge), `user/{user_id}` (private memories/sessions), `agent/` (global skills/endpoints/tools/payments); internal `temp`/`queue`/`upload` not addressable. `~` home alias expands server-side to the caller's `user/{id}`; responses echo canonical form. Trailing `/` = directory, bare = file. Path variables (`{calendar:today}` → `2026/05/07`) resolved server-side at execution time.
- Every file gets a stable vector-record `id = md5(account:uri)`; moving re-keys. Directories have no single id (they span L0/L1/L2 records).
- **Takeaway for `spec-memo`:** our `{projectId}` *is* the scope. Adopt `memo://{projectId}/{originRelPath}` + canonical `memo://{projectId}/{kind}/{slug}.md` dual, trailing-slash rule, `..`/backslash rejection, and alias→canonical echo. Skip `~`, path variables, and content/index split — single SQLite-FTS vault is the point.

### 3. L0/L1/L2 layered loading (adapt, don't copy)

- **L0 abstract** (`.abstract.md`, ~256 chars, default body limit) for vector retrieval/quick relevance; **L1 overview** (`.overview.md`, ~4K chars, nav + usage) for rerank/planning; **L2 detail** (original files) loaded on demand. L0/L1 are *directory-level* OKF-Markdown sidecars (frontmatter: `directory`, `source`, `generated_by`, `freshness{total,sampled,unsampled,pending}` + body), hidden from normal `ls`, readable via `abstract()`/`overview()` (body only) vs direct `read` (raw). `SemanticProcessor` builds them bottom-up (file summaries → leaf L1 → L0 → parents to namespace root) with stable sampling (32-child cap) and write-protection (body editable, metadata protected, `append` body-only).
- **Takeaway:** no VLM/embeddings budget here, but the *hidden synthetic directory overview* pattern is cheap and high-value — AC14. Bootstrap brief already plays the L0/L1 role at session start; per-directory overviews extend it to navigation.

### 4. Filesystem + retrieval API (the shape to mirror)

- FS verbs: `ls` (offset/limit, `agent` vs `original` output, `abs_limit`, tag AND-filter, denied-child placeholders in shared scope), `tree` (level/node limits), `stat` (file `id`+`size`, dir `count`, `isLocked`), `attrs`/`set_tags` (`k=v` retrieval tags), `mkdir` (optional `description` seeds L0), `rm` (idempotent, recursive returns `estimated_deleted_count`), `cp`/`mv` (exact destination, merge dirs, parent must exist, lock both paths, vector copy/re-key, explicitly *not* atomic — partial-destination + best-effort rollback documented).
- Retrieval is two-stage: `find()` (single query, no session, low latency) vs `search()` (LLM intent → 0–5 typed queries by MEMORY/RESOURCE/SKILL, hierarchical priority-queue recursion from vector-located starting dirs with score propagation, rerank in THINKING mode). Scoped by `target_uri`. Plus `grep` (regex) / `glob` (filename pattern) as separate verbs.
- **Takeaway:** map to what we have — `search(path)` = scoped `find`, `get(path)` = `read`, `resources/list` = `ls`/`tree` (read-only), `promote --restore` = `write`-back, `forget` = `rm`. Defer `grep`/`glob` verbs; AC15's glob-in-`path` covers the 80% case without new tools.

### 5. MCP + WebDAV transports (validates this spec's approach)

- MCP endpoint (`/mcp`, same port as REST) exposes **15 tools**: `find`, `search`, `read` (multimodal-aware), `list`, `tree`, `remember`, `write` (replace/append/create + auto-mkdir), `edit` (exact-string + `replace_all`), `add_resource` (URL single-trip; local file via one-shot `temp_upload` token POST, `processing_mode: semantic_and_vectors|vectors_only`, `watch_interval`, `to` target URI), `list_watches`/`cancel_watch` (minimal closure), `grep`, `glob`, `forget`, `health`. Home alias works on every control plane.
- WebDAV Phase 1 is deliberately narrow: `resources` only, UTF-8 `PUT` (no parent auto-create), `OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL/MOVE`, sidecars (`.abstract.md`, `.overview.md`, `.redirect.json`, locks) hidden. Proves file-protocol access is separable from the MCP surface.
- **Takeaway:** OpenViking confirms the two critical choices in this spec — (a) **resources + tools duality**: MCP *Resources* give IDE-native context, but agents that ignore resources need *tool* path params (`get`/`search` `path`), so ship both; (b) **no new tools for v1**: `resources/list`+`resources/read` ride the protocol, exactly as AC8–AC10 specify. `add_resource`'s one-shot upload and `watch_interval` are non-goals (local files are already local).

### 6. What `spec-memo` should NOT borrow

Single-backend local vault (no S3/multi-write `.redirect.json` routing), no account/user ACL engine (project isolation suffices), no session-commit→memory-extraction pipeline, no snapshots/OVPack packaging, no locks/consistency checker. Revisit only on demonstrated demand.

---

## Architectural Analysis & Critical Evaluation ("Is it worth it or not?")

### 1. The Value Proposition (Pros)

1. **True Dogfooding & Repository Hygiene:**
   - Enforces the core philosophy that Git repositories should only contain executable code and permanent product documentation.
   - Drastically cleans up repository clutter, eliminating hundreds of ephemeral plan files, `.state.md`, old prompt run logs, and duplicate scratch notes.
2. **First-Class MCP Resources Integration:**
   - MCP Resources (`resources/list`, `resources/read`) are designed specifically for this use case: providing context and virtual files to LLMs without cluttering the local file workspace.
   - Compatible with IDEs that natively support MCP resources (Cursor, Claude Desktop, Antigravity).
3. **No Tool Budget Expansion:**
   - Implementing this via MCP Resources and enhancing existing `get({ path })` avoids adding an 11th tool to the MCP surface, preserving the lean 10-tool interface contract.

---

### 2. Critical Risks, Drawbacks & Pitfalls (Cons / "The Worst Parts")

1. **Human & Traditional Tooling Disconnect (The "Invisible Docs" Problem):**
   - **Risk:** If team documentation or specifications are imported into `~/.spec-memo/` and deleted from Git, human engineers browsing GitHub, GitLab, or VS Code won't see them.
   - **Impact:** While agent-only plans and temporary logs *should* be hidden from git, architectural docs and specs of record often need to remain visible to human stakeholders in PRs.
   - **Verdict:** Purging *everything* creates friction. The cleanup must distinguish between **ephemeral agent residue** (plans, run states, prompt logs) and **canonical product documentation** (which should stay in git or use `memo promote`).
2. **Agent Tool Confusion & Read Asymmetry:**
   - **Risk:** Coding agents have built-in workspace tools (`view_file`, `grep_search`, `list_dir`). If an agent is told "read `docs/architecture.md`" and the file has been purged from disk into the VFS, `view_file` will return `ENOENT` (file not found).
   - **Impact:** Unless the agent is explicitly instructed or knows to use MCP `resources` or `memo get`, it will get stuck in tool retry loops.
3. **Multi-Developer & CI Synchronization Gap:**
   - **Risk:** If Developer A runs `memo import --cleanup` on a repository and deletes files from Git, Developer B (or CI) cloning the repository will not have access to those files unless they also run `spec-memo` in hybrid/remote sync mode.
   - **Impact:** Risk of broken references in code or missing setup guides for team members without `spec-memo` installed.

---

### 3. Suggestions & Strategic Recommendations

1. **Adopt a Tiered Ingestion Policy:**
   - **Tier 1 (Always Cleanup / Ephemeral):** `.agents/plans/`, `.state.md`, `run.json`, `*.log.md`, `telemetry.jsonl`, `scratch/`. These are purely agentic residue and should always be cleaned up.
   - **Tier 2 (Ingest with Read-Only Cache / Retain in Git):** `docs/`, `specs/`, `README.md`. Ingest into `spec-memo` for fast semantic search and MCP resource mapping, but **do not delete from Git** by default.
2. **Implement MCP Resources alongside `get(path)`:**
   - Expose all vault records through standard MCP Resources (`resources/list` and `resources/read`).
   - Allow `get` to accept `path: "relative/path.md"` so agents can retrieve records using both their record ID and original file path.
   - OpenViking lesson: most agents never call `resources/read` unprompted — the tool path (`get`/`search` with `path`, directory overviews) is the path that actually gets used. Ship both, document the tool path in `ws-memo`/`ws-spec-memo` skill text so `view_file ENOENT → memo get(path)` becomes reflex.
3. **Provide Dry-Run and Restore Capabilities:**
   - Ensure `memo import --cleanup` always supports `--dry-run` and outputs a clear manifest of files to be removed.
   - Add a reverse command `memo export --to-repo` or `memo promote --restore` allowing operators to write virtual documents back to the working tree if needed.
4. **Ship in two phases (OpenViking-shaped, spec-memo-sized):**
   - **Phase A (this slice):** `vfs.enabled` flag + `memo vfs enable|disable|status` + `originRelPath` frontmatter + FTS index + `--include` globs + `--dry-run` manifest + read-only `resources/list`+`resources/read` + `get`/`search`/`bootstrap` `path` + synthetic directory overviews + `doctor` pollution parity. No new tools. Everything gated behind the flag (AC18–AC21).
   - **Phase B (deferred):** write-back verbs (`write`/`edit` via `upsert`/`promote --restore`), `grep`-style content search inside VFS, snapshots/OVPack-style export bundles, `watch_interval`-style re-import. Revisit only after Phase A proves agents actually consume `memo://` URIs.
5. **Safety contract for `--cleanup` (borrow OpenViking wording):** idempotent delete (missing file = success), refuse on secret hit / failed index verify / dirty git (`untracked`+`modified` conflicts) / missing confirmation; empty-dir prune only when dir contains zero un-ingested files; manifest records `sourcePath → memo://…` so every deletion is reversible via restore.
