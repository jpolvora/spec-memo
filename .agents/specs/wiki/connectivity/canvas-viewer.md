# Canvas Viewer

## Feature Overview

`memo canvas` (alias `memo serve-canvas`) starts an embedded, zero-dependency HTTP server and SVG graph visualizer for inspecting vault memory. Default bind is `http://127.0.0.1:3125` (config `ports.canvas`), loopback only unless an auth token is supplied. The page is a dark-mode single document with a sidebar (project selector, search filter, relation/legend controls) and an SVG viewport that lays out records as a force/hierarchical graph with zoom and pan.

Journeys:

- An operator lists projects, picks one, and sees its nodes (traps, decisions, specs, plans, reviews) colored by kind, with edges for `supersedes` and `related` relations.
- Typing in the search box filters/highlights nodes live.
- Clicking a node opens the details drawer, which fetches the full markdown body and frontmatter.
- `GET /api/search` returns ranked SQLite FTS matches for a query scoped to a project.

The Canvas server is read-only for vault assets and is separate from the [Status Monitor](status-monitor.md) (which owns ops backup, not the graph).

## Business Rules & Logic

- Bind refusal: a non-loopback `--host` without an auth token throws before `listen` (`--auth-token`/`SPEC_MEMO_AUTH_TOKEN`).
- When a token is configured, only `/api/*` paths require `Authorization: Bearer <token>`; the HTML page is served without auth so the browser can load it, and the embedded JS forwards `?token=` from the page URL as a bearer header on API calls. Unauthorized API calls return `401 { error: "Unauthorized" }`.
- Project ids are resolved inside `projects/` with `isPathInside`; a traversal-like id returns an empty graph rather than reading outside the vault.
- Record listing excludes conflict sidecars (`*.conflict.*.md`) and malformed records (silently skipped).
- Log records and records carrying the tags `activity`, `monitor`, or `mcp-activity` are hidden from the graph by default (they are status-monitor traffic, not topology); pass `?includeLogs=1` to include them.
- Graph edges are derived from `supersedes` (resolved against existing node ids) and `relatedSlug` (resolved via the slug map, self-links dropped). Edges for `linkedPaths`, `tags`, and `kind` are part of the spec's intended relation model but the shipped `generateProjectGraph` emits `supersedes` and `related` only.
- Node titles fall back in order: `title` frontmatter, first `# ` heading, `slug`, then `id`.
- Record and search API responses pass through `sanitizeToolOutput` so record bodies and metadata are redaction-checked before leaving the server (`/api/projects` and `/api/project/{id}/graph` do not).

## Technical Architecture

- `src/canvas.ts` `startCanvasServer(options)` accepts `{ vaultRoot?, port?, host?, project?, authToken? }` and returns `{ server, port, host, url, close }`. `close()` resolves when `server.close()` completes.
- REST contract:
  - `GET /` / `GET /index.html` -> `generateCanvasHtml()` self-contained HTML.
  - `GET /api/projects` -> `getVaultProjectList(vaultRoot)` array (enriched with `displayName`, `aliasOf`, `recordCount`).
  - `GET /api/project/{projectId}/graph` -> `ProjectGraph` (`{ projectId, nodes, edges }`); optional `?includeLogs=1|true`.
  - `GET /api/record/{projectId}/{kind}/{id}` -> `sanitizeToolOutput({ record })` with full body and frontmatter.
  - `GET /api/search?q=...&project=...` -> `searchIndex({ query, projectId, vaultRoot })` ranked matches.
  - Unknown paths fall through to `404 { error: "Not found" }`.
- `GraphNode` fields: `id`, `kind`, `slug?`, `title`, `status`, `severity?`, `updated`, `project`, `pathPatterns?`, `tags?`, `hits` (from `hitCountOf`), `occurrences?` (from `occurrenceOf`). `GraphEdge` is `{ source, target, relation: supersedes | related | links | shares-tag }`.
- `listProjectRecordsInternal` walks `RECORD_SUBDIRS` and parses each `.md` via `parseRecord`; `generateProjectGraph` builds nodes then edges.
- CLI (`src/cli.ts`): `memo canvas [--port <p>] [--host <h>] [--project <id>] [--auth-token] [--json] [--vaultRoot]` boots the server and prints the URL; `--json` emits `{ url, port, host }`. `memo canvas` / `serve-canvas` are refused in remote mode (`REMOTE_MODE_RESTRICTION`).
- Provenance: `0042-canvas-viewer.spec.md` (spec default `:4100`; current shipped default `3125`). The viewer deliberately does not consume the status activity bus and does not write vault records.
