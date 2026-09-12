# Virtual File System over MCP

## Feature Overview

The Virtual File System (VFS) is a **draft, not-yet-implemented** proposal (`0027-virtual-file-system-over-mcp.spec.md`, status `draft`; `index.PRD` marks it `[ ] todo`). Its goal is to ingest arbitrary repository documentation (specs, plans, reports, design docs) into the vault while recording the original repository-relative path, then expose vault records through MCP Resources and path-based lookups so agents can retrieve purged files without touching the working tree.

This page documents both the specification's intent and the current shipped reality: none of the VFS surface exists in the code today. The original path is not preserved, there is no working-tree cleanup, and the MCP server exposes no resources. Treat the acceptance criteria below as planned work, not behavior.

## Business Rules & Logic

Current behavior (verified against `src/*.ts`):

- No `originRelPath` / `sourcePath` field exists on `RecordFrontmatter`; `memo import` records the vault path but not the file's repo-relative origin. `rg originRelPath src` returns nothing.
- `search(path=...)` matches records whose `pathPatterns` cover the given file path (the MCP `search` description says "Match records whose pathPatterns cover this file path"); there is no match against an original path.
- `get` accepts `id` or `kind` + `slug` only. It has no `path` parameter, and `getRecord` performs lookup by id or kind+slug.
- The MCP server advertises only `capabilities: { tools: {} }` in `createMcpServer`; there are no `resources/list`, `resources/read`, or `resources/templates/list` handlers.
- `memo import` has no `--cleanup` / `--delete-source` flag and deletes nothing from the working tree; its flags are `--from`, `--cwd`, `--vaultRoot`, and `--json`.
- Importer ingestion is bounded to legacy candidates (`.agents/specs`, `specs`, `.spec-memo/specs`, `memory` variants, plans, changelog) — not arbitrary `docs/**` / `reports/**` globs. See [Import](import.md).

Planned rules (from `0027-virtual-file-system-over-mcp.spec.md`):

- Record `originRelPath` in `RecordFrontmatter` (relative to repo root, normalized with forward slashes) and index it in SQLite FTS5 so `search(path=...)` and `get(path=...)` resolve exact path, directory prefix, or glob.
- Accept flexible ingestion patterns (`docs/**/*.md`, `reports/**/*.md`, `.agents/specs/**/*.md`, `.agents/plans/**`, `specs/**/*.md`, plus `--include <glob>`), defaulting ingested files to kinds (`spec`, `plan`, `review`, `log`, `scratch`, or a generic doc/decision).
- Optional `--cleanup` / `cleanup: true` deletes ingested source files only after successful vault storage and indexing, refusing on detected secrets, indexing failure, untracked-conflict git status, or absent interactive confirmation; it removes empty parent directories without touching un-ingested files.
- Register MCP Resources (`resources/list`, `resources/read`, `resources/templates/list`) with URIs `memo://{projectId}/{originRelPath}` (or `memo://{projectId}/{kind}/{slug}.md`), MIME `text/markdown`; resource reads must never touch the local workspace filesystem.
- Tool budget: no new MCP tools; VFS rides on MCP Resources plus `get(path=...)` and `search(path=...)`.

Spec-noted risks (provenance only): "invisible docs" for humans when canonical docs are purged, agent tool confusion (`view_file` returns `ENOENT` for purged paths), and multi-developer/CI gaps when one developer cleans the tree without others running spec-memo. The spec recommends a tiered policy (ephemeral agent residue vs canonical docs) and a reverse `memo export --to-repo` / `promote` restore path; none is implemented.

## Technical Architecture

Current code touchpoints that a future VFS slice would extend:

- `src/types.ts`: `RecordFrontmatter` (would gain `originRelPath`); `SearchOptions.path`; `ImportOptions` (no cleanup/include today). `GetOptions` (no path today) lives in `src/store.ts:36-45`.
- `src/store.ts`: `getRecord({ id, kind, slug, ... })` and `upsertRecord` are the only get/put paths; no path-keyed lookup or origin-path persistence.
- `src/indexer.ts`: `searchIndex` matches `path` against `pathPatterns` via `matchesPathPattern`; FTS schema would need an `originRelPath` column/term.
- `src/importer.ts`: `importWorkflowTree` maps legacy files to vault kinds but does not capture or upsert an original path.
- `src/mcp.ts`: `createMcpServer` registers only `ListToolsRequestSchema` and `CallToolRequestSchema`; no resource request handlers.
- `src/cli.ts`: `memo import` exposes `--from`, `--cwd`, `--vaultRoot`, `--json` only.

Status summary: all VFS acceptance criteria (AC1–AC12 in the spec) are unmet in the current build. The spec is retained as planned provenance; acceptance is tracked in `.agents/specs/index.PRD` as `[ ] todo` (Phase 7).

Open questions carried by the spec (unconfirmed defaults):

- MCP Resource URI scheme `memo://{projectId}/{originRelPath}` vs the `kind/slug` fallback.
- Cleanup safety default: `cleanup: false`, explicit `--cleanup` plus confirmation required.
- Conflict handling on ingest: upsert/overwrite changed content, skip identical (matching current `memo import` idempotency).
- Cleanup ordering: only after successful vault storage and indexing, refusing on secret detection, indexing failure, or untracked-conflict git status.

Out of scope (per the spec): OS-level FUSE/WebDAV/virtual-drive mounts, ingesting binary/image/compiled artifacts, automatic background deletion, and two-way real-time filesystem watchers. No new MCP tools are to be added; VFS rides on resources plus `get`/`search`.

Provenance: `0027-virtual-file-system-over-mcp.spec.md`.
