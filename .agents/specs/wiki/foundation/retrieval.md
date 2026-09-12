# Retrieval and Search

## Feature Overview

Retrieval is executed by the `search` MCP tool and `memo search` CLI command. It queries a local SQLite FTS5 index (`<vaultRoot>/memo.sqlite`) that is a pure, disposable projection of the Markdown vault. Deleting or corrupting the database is safe: `rebuildIndex()` reconstructs it from `projects/*/<subdir>/*.md`.

Markdown remains the source of truth and the index is rebuildable at any time, so search results are reproducible from disk. Three optional layers sit on top of lexical FTS: an embeddings-style similarity filter (`config.embeddings`), opt-in cross-project search, and retrieval hit accounting. `explain` adds an ephemeral per-hit scoring breakdown without changing ranking or stored state.

Agent journeys: a session calls `search` to discover relevant traps/decisions, optionally passes `hitIds` to acknowledge rows it actually used, and may read a specific record with `get`. Operators browse the same corpus through the `:3124` status monitor Memory tab (`GET /api/records`, `GET /api/records/search`) and the Canvas graph, both read-only with respect to hit counters.

## Business Rules & Logic

Index schema (`openIndex`): virtual FTS5 table `records_fts(id, projectId UNINDEXED, kind UNINDEXED, status UNINDEXED, title, tags, pathPatterns, body, filepath UNINDEXED, updated UNINDEXED, tokenize='porter ascii')`, plus a `record_links(source_id, target_id, link_type, source_project)` table. The database runs in WAL mode with `synchronous = NORMAL` and is pooled per vault root. `indexRecord` deletes the existing `(id, projectId)` row before inserting, so upserts are idempotent.

Indexing surfaces: `id`, `projectId`, `kind`, `status`, `title`, space-joined `tags`, space-joined `pathPatterns`, `body`, `filepath`, and `updated`. `rebuildIndex` scans every project subdirectory and re-indexes each `*.md`; compiled views live at the project root (not in a subdirectory), so they are not indexed.

Search defaults and filters (`searchIndex`):

- When neither `projectId` nor `crossProject` is supplied, the active project is resolved from `cwd`.
- `kind` filter is inclusive when provided; tags must all match; `path` matches against the record's `pathPatterns` using the glob matcher `matchesAnyPattern` (`*`, `**`, `?` supported).
- Without an explicit `kinds` list, the FTS path excludes only `scratch` unless `includeScratch: true`. `crossProject` without `kinds` excludes `scratch`, `state`, and `review`. (The MCP description mentions scratch/log/review defaults, but current code filters only `scratch` on the default project-scoped path.)
- `status` filters exactly when provided.
- Query sanitization (`sanitizeFtsQuery`): a fully quoted phrase is preserved; otherwise tokens are split, `AND`/`OR`/`NOT` preserved as operators, FTS-special characters stripped, and remaining tokens wrapped as prefix terms (`"term"*`).
- `limit` defaults to 50; relevance-mode rows are fetched in batches of `max(limit * 4, 100)` until the limit is reached.
- If `path` is inside a capture-ignored product area, search returns `[]` immediately.
- Expiration: expired `scratch`/`review` records are dropped unless `includeExpired: true`; `asOf` enables point-in-time filtering.

Sort modes (`sort`):

- `relevance` (default) — FTS `rank` ascending; without a query, `updated` descending.
- `updated` — `updated` descending.
- `occurrences` — full-scan ranking over the active set (same universe as `memo rank`), default kinds `['trap']`, default status `active`; ordered by `occurrences` desc, then `lastSeen`, then severity, then id.
- `hits` — full-scan ranking, default kinds `trap, decision, spec, plan`, default status `active`; ordered by `hits` desc, then `lastHit` desc, then `updated` desc.

Invalid `sort` values fail tool argument validation (Zod enum), not a silent fallback.

Embeddings (`0001-embeddings-search.spec.md`): when `config.json` has `embeddings.enabled`, the FTS path additionally computes a local term-frequency cosine similarity (`calculateVectorSimilarity`) between the query and `title + tags + body`, dropping hits below `embeddings.minSimilarity ?? 0.3`. This is a local lexical approximation, not an external embedding library; when disabled, no embedding code path runs and FTS remains the default backend. It applies only to the FTS path, not the `occurrences`/`hits` full-scan paths.

Cross-project (`0010-cross-project-search.spec.md`): `crossProject: true` (CLI `--all` / `--cross-project`) removes the project clause so all vault projects are queried; each hit carries its originating `projectId`. Default searches stay scoped to the active project. Ephemeral kinds (`scratch`, `state`, `review`) remain excluded when no explicit `kinds` is given. Current hit objects expose `projectId` but do not embed a project display name; operators see display names in the vault list.

Retrieval hits (`0034-memory-hit-count.spec.md`): orthogonal to `occurrences` (which is recurrence-on-upsert). `hits` (integer `>= 0`) and `lastHit` (ISO timestamp) live in record frontmatter and default to `0`/absent when missing — read paths never rewrite the file just to report zero. Hit-eligible kinds are exactly `trap`, `decision`, `spec`, `plan`. Increments happen when: a record is present in a returned `bootstrap` brief payload; a hit-eligible `get` succeeds; or a record id is listed in `search.hitIds` and appears in the result set. Bare `search` never increments, even when sorted by `hits` or `occurrences`. Unknown ids in `hitIds` are ignored. `occurrences`/`lastSeen` are never touched by hit recording.

Session de-dupe: when `sessionId` is a non-empty string, the same record increments at most once per session. Seen ids are kept in `<vaultRoot>/.sync/memory-hit-sessions.json` with a 7-day TTL and a 500-entry in-memory hot cache; the disk file retains all non-expired sessions. Without `sessionId`, every qualifying bootstrap inclusion or `get` increments (CLI one-shot behavior). Hit persistence is fail-open: a write error still returns success for the originating tool and is logged with subsystem `memory-hits`. A bump rewrites frontmatter (`hits + 1`, `lastHit = now`), updates the FTS row, rebuilds compiled views, and requests a vault-git commit following the existing atomic/batched policy.

Explain (`0038-search-ranking-explain.spec.md`): `explain: true` (CLI `--explain`) attaches a per-hit `SearchScoreExplain`: `ftsBm25`, `pathPatternBoost`, `severityMultiplier`, `hitsBoost`, `occurrencesBoost`, `feedbackMultiplier`, and `finalScore`. Multipliers: path match `1.25` else `1`; severity `critical 1.4`, `high 1.3`, `medium 1`, `low 0.9`; hits `1 + min(hits, 20) * 0.02`; occurrences `1 + min(max(occ - 1, 0), 20) * 0.03`; feedback uses the salience multiplier. Values are rounded to 2 decimals and any non-finite input falls back to `1` (neutral). Explain is computed ephemerally and never alters ranking, ordering, or index state. For `sort: hits`/`occurrences` the raw rank is synthesized from the counter when FTS rank is absent.

Status monitor: `GET /api/records/search` accepts `project`, `kind`, `sort`, `limit`, `q`, `explain`, `crossProject`, `includeExpired`, and `asOf` and returns `{ hits }`. `GET /api/records` is the read-only Memory listing (`{ records }`) fed by `listMemoryRecords`: it excludes `prompt`, `session`, `log`, and `scratch` unless `includeEphemeral`; hides expired by default; sorts by `hits` (default), `occurrences`, or `updated`; and never increments hits. Both routes enforce the same bearer auth as the rest of `/api/*` (401 when unauthorized).

## Technical Architecture

Modules: `src/indexer.ts` (`openIndex`, `closeIndex`, `indexRecord`, `removeRecord`, `searchIndex`, `rebuildIndex`, `matchesPathPattern`, `matchesAnyPattern`, `sanitizeFtsQuery`, `calculateVectorSimilarity`), `src/sqlite.ts` (Node >= 22 guard, native-binding resolution, ABI-mismatch error wrapping), `src/ranking-explain.ts` (`computeSearchExplain`, `formatSearchExplainTree`, multiplier helpers), `src/hits.ts` (`recordMemoryHits`, `collectBootstrapHitIds`, `listMemoryRecords`, `isHitEligibleKind`), `src/recurrence.ts` (`occurrenceOf`, `compareSearchHits`, `compareHitsSearch`), `src/salience.ts` (feedback multiplier), and `src/expiration.ts`.

MCP `search` contract (`src/tools.ts`): `query`, `kinds[]`, `status`, `tags[]`, `path`, `includeScratch`, `projectId`, `crossProject`, `limit`, `sort` (`relevance|occurrences|updated|hits`), `hitIds[]`, `sessionId`, `explain`, `includeExpired`, `asOf`, `cwd`, `vaultRoot`. Hit recording happens in the tool handler after results are returned: result `projectId` values become per-id hints, ids that map to conflicting projects are treated as ambiguous and excluded, and `recordMemoryHits` resolves each remaining id across the vault (fail-closed on multiple matching files).

CLI mapping (`src/cli.ts`): positionals become `query`; `--kind`, `--tag(s)`, `--path`, `--scratch`, `--all` (→ `crossProject`), `--limit`, `--sort`, `--hit-ids a,b` (→ `hitIds`), `--session-id`, `--include-expired`, `--as-of`, `--explain`, `--json`. Non-JSON output renders one line per hit plus an indented explain tree when present. `memo doctor --rebuild` triggers the same full re-index.

Native dependency guard (`src/sqlite.ts`): the runtime requires Node.js major >= 22; a native ABI mismatch (for example after a Node upgrade) is wrapped with an actionable rebuild hint referencing `npm rebuild better-sqlite3` and `memo doctor --rebuild`, and the binding path is resolved relative to the installed package rather than the process `cwd` (important when an SSE daemon serves remote clients).

Side effects: search is read-only except when `hitIds` (or a `get`/`bootstrap` inclusion) triggers a hit bump. `rebuildIndex` rebuilds both `records_fts` and `record_links` inside a transaction and returns `{ indexed }`. `memo doctor --rebuild` invokes the same rebuild.

Provenance: `0004-fts-index.spec.md` (FTS5 disposable index and filters), `0001-embeddings-search.spec.md` (optional embeddings backend), `0010-cross-project-search.spec.md` (opt-in cross-project), `0034-memory-hit-count.spec.md` (`hits`/`lastHit`), and `0038-search-ranking-explain.spec.md` (`explain`).
