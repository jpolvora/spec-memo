# Record Store and Kinds

## Feature Overview

Durable memory is stored as Markdown files with YAML frontmatter. Markdown is the source of truth; the SQLite FTS5 index (see [Retrieval and Search](retrieval.md)) is a disposable cache. Each record kind maps to a subdirectory under `<vaultRoot>/projects/<projectId>/`, and every write regenerates compiled views at the project root (each view embeds a `Last compiled` timestamp, so output is not byte-stable across writes).

The store is the write/read engine behind the `upsert`, `get`, `append`, and `forget` MCP tools and their `memo` CLI equivalents. Agents remember traps and decisions with `upsert`, stream audit events with `append`, retrieve one record with `get`, and retire records with `forget`. `state`, `log`, `scratch`, and `review` complete the kinds matrix; `state`/`scratch` are intentionally kept out of the durable compiled views.

Compiled projections are write-only: `TRAPS.md`, `DECISIONS.md`, `INDEX.md`, `PROMPTS.md`, and `SESSIONS.md` are regenerated on every record mutation and must not be hand-edited.

## Business Rules & Logic

Frontmatter validation (`RecordFrontmatterSchema`, Zod). Required fields: `id` (non-empty string), `kind`, `project` (non-empty string), `created`, `updated`, and with defaults `status: active` and `source: agent`. String enum values are trimmed and lowercased before matching. The schema uses `.passthrough()`, so unknown frontmatter keys survive round-trips.

Kind enum (10): `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review`, `prompt`, `session`. Status enum (6): `active`, `paused`, `shipped`, `superseded`, `archived`, `completed`. Source enum (3): `agent`, `human`, `imported`. Severity enum (4): `low`, `medium`, `high`, `critical`. Layer enum (7): `application`, `domain`, `web`, `infrastructure`, `tests`, `devops`, `other`.

Kind → directory mapping (`getSubdirForKind`): `trap→traps`, `decision→decisions`, `spec→specs`, `plan→plans`, `log→logs`, `review→reviews`, `scratch→scratch`, `state→plans`, `prompt→prompts`, `session→sessions` (the `default` branch yields `<kind>s`).

Optional numeric/date constraints: `occurrences` is a coerced integer `>= 1`; `hits`, `helpfulCount`, and `staleCount` are coerced integers `>= 0`; `turn` is a positive integer; `expires_at`, `lastSeen`, `lastHit`, `lastFeedback`, `startTime`, `endTime`, `created`, and `updated` accept strings or dates (normalized to ISO strings). `links` entries must have a non-empty `target` and `type` of `fixes`, `contradicts`, or `causes`. `deliverables` entries use type `pr`, `commit`, or `spec`.

Upsert (`upsertRecord`) invariants:

- Id/slug derivation: explicit `slug` → `frontmatter.id` → `slugify(title)` → `<kind>-<Date.now()>`. `prompt` without a slug uses `prompt-<sessionId>-t<turn>` when both are present, else `prompt-<timestamp>-<3 random bytes hex>`; `session` uses `session-<sessionId>` or a timestamped fallback.
- The target file is `<subdir>/<slug>.md`. An existing file at that path is read first and its frontmatter is merged underneath the new values; `created` is preserved, `updated` is refreshed to now unless supplied.
- Secret scanning (`assertNoSecrets`) runs on both body and frontmatter; a hit aborts the write.
- TTL: `ttl` accepts durations (`7d`, `48h`, `30m`) or a date; `expires_at` accepts RFC3339 or `YYYY-MM-DD` (end of that UTC day). A computed `expires_at` is derived from `created`. `scratch` defaults to 7 days and `review` to 14 days at read time.
- Path conveniences: a frontmatter `path` is folded into `pathPatterns` and `linkedPaths`; values are sanitized against capture-exclusion rules; `pathPatterns` are used for trap dedup and path filtering.
- Trap classification fills missing `layer`, `module`, and `tags` (including promoting a `security` label into tags). The first write sets `occurrences: 1` and `lastSeen` when absent.
- Trap recurrence/dedup: for a new trap (no existing file, no `supersedes`, and `allowDuplicate` not set), a match requires identical sorted `pathPatterns` and Jaccard token overlap `>= 0.7` between bodies. On match the store bumps `occurrences` and `lastSeen` in place instead of creating a file, and returns `recurrence: true`.
- Superseding: when `supersedes: <oldId>` is set and the older record exists, its on-disk status becomes `superseded`, `updated` is refreshed, and the new record reports `superseded: true`.
- After writing, the record is indexed into FTS5, compiled views are rebuilt, and a vault-git commit is requested (`upsert <kind>:<id>`). File and index failures during indexing are non-blocking.

Get (`getRecord`) lookup order: direct `kind+slug` path → per-subdirectory `<id>.md` filename → frontmatter `id` scan. When no `projectId` is passed it may fall back to sibling projects, excluding `scratch`, `state`, and `review`; exactly one cross-project match is returned, and multiple matches resolve to `null` (fail closed). Retrieved records are annotated with an `expired` flag according to kind TTL.

Append (`appendEvent`): write-only. Defaults `kind: log`; the id is `log-<ISO-with-:.-replaced>-<pid>-<4 random bytes hex>` and the file is written under the kind directory. Prior events are never rewritten. Body and details are secret-scanned, the record is indexed, views rebuild, and a commit is requested.

Forget (`forgetRecord`): soft-archive by default — writes `status: archived` and refreshes `updated`, keeping the file. `purge: true` physically unlinks the file, records a tombstone (for sync), and removes the FTS row. A missing record throws `Record not found`. Both paths rebuild compiled views and request a commit.

Compiled views (`rebuildCompiledViews`):

- `TRAPS.md` — active traps sorted by severity weight (`critical 4 > high 3 > medium 2 > low 1`) then `updated` desc; each heading carries `Layer`, `Occurrences`, and `Hits`; inactive traps are listed separately.
- `DECISIONS.md` — summary table plus Accepted (`active`/`shipped`) and Proposed (`paused`) sections. The summary counts `superseded`/`archived` decisions, but current code emits no separate Superseded section.
- `INDEX.md` — inventory counts and per-kind tables for durable kinds `trap, decision, spec, plan, log, review, prompt, session`.
- `PROMPTS.md` and `SESSIONS.md` — prompt/session inventories.
- `state` and `scratch` records are never projected into these compiled views.

Concurrency: all mutations run under the re-entrant vault file lock via `withVaultLock`; `backfillTrapRecurrence` uses the synchronous variant. Listing (`listProjectRecords`, `scanProjectRecords`) skips files containing `.conflict.` and silently ignores unparseable files.

## Technical Architecture

Modules: `src/schema.ts` (Zod schema, `validateFrontmatter`, `parseRecord`, `serializeRecord`), `src/store.ts` (`upsertRecord`, `getRecord`, `appendEvent`, `forgetRecord`, `listProjectRecords`, dedup helpers), `src/compiler.ts` (`scanProjectRecords`, `generateTrapsView`, `generateDecisionsView`, `generateIndexView`, `generatePromptsView`, `generateSessionsView`, `rebuildCompiledViews`), `src/expiration.ts` (TTL parsing/filtering), `src/recurrence.ts` (trap classification, `occurrences`), and `src/salience.ts` (feedback counts and flagged-stale status). Types live in `src/types.ts`.

Persistence model: one Markdown file per record at `<vaultRoot>/projects/<projectId>/<subdir>/<slug>.md`. YAML frontmatter is parsed/serialized with `gray-matter`; serialization deletes keys whose value is `undefined` so absent optional fields are not emitted. `parseRecord` throws on invalid frontmatter; callers generally catch and skip.

MCP contracts (from `src/tools.ts`):

- `upsert` — required `kind`, `body`; optional `slug`, `frontmatter` (object), `path`, `cwd`, `projectId`, `vaultRoot`. Fails with `INVALID_ARGUMENTS` on empty body.
- `get` — requires `id` OR both `kind` and `slug`; optional `cwd`, `projectId`, `vaultRoot`, `sessionId`. Missing lookup returns `RECORD_NOT_FOUND`.
- `append` — required `event`; optional `kind` (default `log`), `details`, `cwd`, `projectId`, `vaultRoot`.
- `forget` — optional `id` or `kind`+`slug`; optional `purge` (default false), `cwd`, `projectId`, `vaultRoot`.

Side effects per mutation: file write → FTS5 upsert → compiled-view rewrite → vault-git commit request (`commitVaultChange`, honoring `vaultGit.atomic` vs batched) → optional hybrid push scheduling in the tool handler. Writes are guarded by `assertNoSecrets` and `assertNotInProductRoot`.

Provenance: `0008-record-schema-and-indexes.spec.md` (schema, upsert/get, superseding, compiled views) and `0006-remaining-kinds-and-events.spec.md` (remaining kinds, append-only logs, forget archiving). Later slices added TTL (`0037-record-ttl-expiration.spec.md`), recurrence (`0022-trap-recurrence.spec.md`), and feedback salience (`0039-memory-feedback-salience.spec.md`).
