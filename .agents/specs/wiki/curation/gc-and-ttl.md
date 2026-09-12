# Garbage Collection, Record TTL, and Log Compaction

## Feature Overview

Curator GC keeps the vault from silting up. A single run (`gc` MCP tool / `memo gc`) sweeps expired records, compacts shipped plans in place, rolls up historical daily log events into monthly archives, then rebuilds compiled views and the SQLite FTS index. It is triggered manually by agents/operators or at session boundaries; there is no background cron daemon.

Journeys:
- Agent writes a temporary rule (`upsert` with `ttl: 7d`), later runs `memo gc` so the expired record leaves the active set without losing audit history.
- Operator inspects what would change with `memo gc --dry-run --json`, then runs the real pass, optionally `--purge` to physically unlink instead of archive.
- Agent retrospects with `memo search "auth" --as-of 2026-08-01` to see what memory was active on a past date.

Surfaces: MCP `gc`, `search`, `get`, `upsert` (writes `ttl`/`expires_at`), `bootstrap`; CLI `memo gc`, `memo search --include-expired --as-of`, `memo upsert --ttl/--expires-at`, `memo rank`; `:3124` Status Monitor Memory tab (Hide Expired toggle default on, As Of picker).

Core interactions: GC is a maintenance step that reads markdown records, mutates or unlinks files, updates the FTS index, and writes sync tombstones only when it physically removes a file.

## Business Rules & Logic

**Default TTL.** `scratch` = 7 days, `review` = 14 days, from `config.json` `ttl.scratchDays` / `ttl.reviewDays` (defaults written by `ensureVaultStructure`, src/vault.ts). `state` and other kinds have no default TTL.

**Universal expiration.** Any record may carry frontmatter `ttl` (duration string such as `7d`, `48h`, `30m`, `90s`, or a date) and/or `expires_at`. Both are optional Zod fields in `RecordFrontmatterSchema` (src/schema.ts).

**Resolution precedence** (`resolveExpiresAtMs`, src/expiration.ts): explicit `expires_at` > computed `created + ttl` > kind default TTL. Records with none are evergreen and never expire (except scratch/review defaults).

**Parsing.** Durations match `^(\d+(?:\.\d+)?)\s*([dhms]|days?|hours?|mins?|minutes?|secs?|seconds?)?$` (bare number defaults to days). `expires_at` accepts RFC3339 or `YYYY-MM-DD`; a date-only value resolves to end of that UTC day (`T23:59:59.999Z`). All math is UTC. Invalid `ttl`/`expires_at` input fails `upsert` with `Invalid ttl duration or date: "..."`.

**Expiration test.** `isRecordExpiredAt` is true when `now >= resolvedExpiresAt`. Signed: equality already counts as expired.

**GC sweep scope.** `sweepExpiredRecords` walks `traps/`, `decisions/`, `plans/`, `state/`, `scratch/`, `reviews/` (src/curator.ts). It skips `.md` files already `status: archived` or `compacted`, and skips `.conflict.` sidecars.

**Archive vs purge.** `ARCHIVE_ON_EXPIRE_KINDS = { trap, decision, plan }`. On expiry:
- Default (no `--purge`): trap/decision/plan are rewritten with `status: archived`, `archivedReason: expired`, `updated: now`, and reindexed. The markdown content is preserved.
- `--purge`, or any kind outside that set (scratch, review, state, log, spec, prompt, session): file is tombstoned via `recordTombstone`, physically unlinked, and removed from the FTS index.
- A scratch file that fails to parse falls back to mtime-based deletion (`mtime` older than `scratchDays`).

**Shipped-plan compaction.** A `plan` with `status: shipped` and no `compacted` flag is rewritten in place by `compactPlanRecord`: frontmatter gets `compacted: true` and `updated: now`; body becomes a short summary with Status (Shipped), Outcome, Completion Date, optional Verified Commit/SHA (from `verifiedAtSha` or `commit`), and optional Related Slug. The file is not deleted.

**Monthly log roll-up.** `compactMonthlyLogs` scans `logs/`. A `log` file is eligible when its `created` prefixes a month earlier than the current `YYYY-MM`, or when it is at least 30 days old (`minAgeDays`, default 30). Eligible events are grouped by `YYYY-MM`, sorted chronologically, and appended to `log-rollup-YYYY-MM.md`. The roll-up frontmatter is `id: log-rollup-<month>`, `kind: log`, `status: active`, `created` = earliest merged event, `compacted: true`, `tags: [rollup, monthly-log, <month>]`. Each merged event file is tombstoned, unlinked, and removed from FTS. An existing roll-up body is extended, not replaced.

**Dry run.** When `dryRun` is true no file is written or deleted, `rebuiltFts`/`rebuiltViews` stay false, but the result still reports `purgedScratchCount`, `purgedReviewCount`, `trapsArchivedCount`, `decisionsArchivedCount`, `plansArchivedCount`, `compactedPlansCount`, and `compactedLogsCount` as if the pass ran.

**Result contract.** `GcResult` fields: `projectId`, `purgedScratchCount`, `purgedReviewCount`, `trapsArchivedCount?`, `decisionsArchivedCount?`, `plansArchivedCount?`, `compactedPlansCount`, `compactedLogsCount?`, `rebuiltFts`, `rebuiltViews`, `dryRun`, and `details { purgedFiles, compactedPlans, compactedLogs }`. Note current code uses these count names; the older spec shape (`scratchPurged`/`reviewsPurged`) is not emitted.

**Retrieval filtering.**
- `search` excludes expired records by default. `includeExpired: true` (`--include-expired`) includes them and stamps `expired: true` on each hit. `asOf` (`--as-of`) returns records active on that date: `created <= asOf` and (`expires_at == null` or `asOf < expires_at`). A future `asOf` suppresses records that would have expired before it.
- `bootstrap` omits expired traps and decisions from the brief. The active spec/plan/state slice is fetched via `getRecord` and only annotated `expired: true`; it is not omitted.
- `get` still returns an expired record by explicit id/slug, annotated `expired: true`.

**Locks and safety.** The whole `runGc` body runs under `withVaultLock`; non-dry runs `commitVaultChange("gc <projectId>", …)`. Telemetry records `category: curator_gc`, `operation: memo_gc`. GC never writes inside a consumer product tree.

## Technical Architecture

**Persistence.** Markdown + YAML frontmatter remains the source of truth. `parseRecord`/`serializeRecord` (src/schema.ts) are used for every mutation. The FTS index is `memo.sqlite` (`records_fts`, src/indexer.ts), rebuilt with `rebuildIndex`. Compiled views (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`, …) are regenerated by `rebuildCompiledViews` (src/compiler.ts). Tombstones for cross-machine sync are written by `recordTombstone` only on physical unlink (purge / log roll-up).

**Backend workflow** (`runGc`, src/curator.ts): resolve identity/projectId → resolve TTL config and `purge` → `sweepExpiredRecords` → scan `plans/` for shipped-not-compacted → `compactMonthlyLogs` → `rebuildCompiledViews` + `rebuildIndex` + `commitVaultChange`. Entire pass wrapped in `withVaultLock`; telemetry emitted in `finally`.

**Module responsibilities.** `src/expiration.ts` (`parseDurationMs`, `parseExpiresAt`, `validateTtlInput`, `computeExpiresAt`, `defaultTtlDaysForKind`, `resolveExpiresAtMs`, `isRecordExpiredAt`, `isRecordActiveAt`, `annotateExpiredFrontmatter`, `applySearchExpirationFilter`); `src/curator.ts` (`isRecordExpired`, `sweepExpiredRecords`, `compactPlanRecord`, `compactMonthlyLogs`, `runGc`); `src/store.ts` computes `expires_at` on write and annotates expired on retrieval.

**API/CLI contracts.**
- MCP `gc`: `cwd?`, `projectId?`, `dryRun?`, `purge?`.
- MCP `search`: adds `includeExpired?`, `asOf?`; `sort` enum is `relevance|occurrences|updated|hits`.
- MCP `upsert`: frontmatter accepts `ttl` and `expires_at`; the CLI normalizes `--ttl` and `--expires-at` into frontmatter.
- CLI: `memo gc [--dry-run] [--project <id>] [--purge] [--json]`; `memo search … [--include-expired] [--as-of <date>]`; `memo upsert … --ttl <dur> --expires-at <date>`.
- Status Monitor: expired chip in the Memory details drawer; table filter "Hide Expired" (on by default) and an "As Of" date input that forward `includeExpired`/`asOf` to `/api/records`.

**Side effects.** Archive path rewrites the markdown + reindexes (no tombstone). Purge path tombstones + unlinks + deindexes. Log roll-up tombstones + unlinks each merged event. Non-dry runs regenerate compiled views and rebuild FTS, then commit the vault change.

**Provenance.** `0003-curator-gc-and-safety.spec.md` (scratch/review TTL, shipped-plan compaction), `0019-log-compaction.spec.md` (monthly roll-up), `0037-record-ttl-expiration.spec.md` (universal `ttl`/`expires_at`, search `includeExpired`/`asOf`, GC archive-vs-purge). Current code supersedes the older `0037` AC14 count naming and keeps compaction in place rather than deleting.
