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

- MCP Resources are a native capability of the Model Context Protocol (MCP specification 2024-11-05). Exposing vault records as resources is idiomatic and does not expand the 10-tool MCP tool budget (it uses protocol-level `resources/list` and `resources/read`).
- The cleanup step is inherently destructive to the local git working tree; strict safety guards, dry-run support, and explicit confirmations are essential.
- Path normalization must be strictly cross-platform (forward slashes `foo/bar.md`, lowercased comparisons where appropriate, relative to project root).

## Out of Scope

| Feature | Reason |
|---------|--------|
| OS-level FUSE / WebDAV / Virtual Drive Mount | Massive OS dependency complexity; MCP protocol-level virtual resources are sufficient for AI agents. |
| Ingesting binary files, images, or compiled artifacts | `spec-memo` is a text/markdown knowledge vault; binary files belong in git LFS or external storage. |
| Automatic background deletion without explicit flag | Working tree deletions must be opt-in, dry-runnable, and confirmed by operator. |
| Two-way real-time filesystem synchronization / watchers | Vault is the authoritative store for ingested memory; live two-way sync introduces race conditions. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| MCP Resource URI scheme | `memo://{projectId}/{originRelPath}` | Standard RFC 3986 URI format compatible with MCP clients (Cursor, Claude, Antigravity) | n |
| Cleanup default safety | `cleanup: false` by default; requires explicit `--cleanup` flag and confirmation | Prevents accidental data loss during initial import runs | n |
| Handling conflicts on ingest | Upsert / overwrite with latest version if content differs; skip if identical | Idempotent import behavior matching existing `memo import` | n |
| Tool count budget impact | No new MCP tools added; utilizes MCP `resources` capability and enhances existing `get`/`search` | Preserves the 10-tool frozen surface while adding VFS functionality | n |
| Other implicit dimensions | N/A because auth is handled by MCP transport and indexing is handled by SQLite FTS | Standard local/SSE operation | n |

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
3. **Provide Dry-Run and Restore Capabilities:**
   - Ensure `memo import --cleanup` always supports `--dry-run` and outputs a clear manifest of files to be removed.
   - Add a reverse command `memo export --to-repo` or `memo promote --restore` allowing operators to write virtual documents back to the working tree if needed.
