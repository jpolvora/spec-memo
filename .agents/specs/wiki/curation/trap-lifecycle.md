# Trap Lifecycle: Deduplication, Recurrence, Feedback, and Salience

## Feature Overview

Traps are the anti-regression rules an agent records after a mistake. This page covers the full lifecycle: the trap record shape, automatic dedup/supersede, occurrence counting, layer/module classification, retrieval hits, explicit memory feedback, typed relationship links, salience dampening, and zero-LLM contradiction detection.

Journeys:
- Agent records a trap with `pathPatterns`; a later `upsert` of the same situation does not create a second file — it bumps `occurrences` on the surviving trap.
- Agent/operator runs `memo rank --layer application` to see the worst repeating gaps, then `memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md` to export them.
- Operator marks a stale trap with `memo feedback <id> --stale`; its retrieval score is dampened and, once it crosses the threshold, `bootstrap` prepends a stale warning and `memo doctor` flags it.
- `memo doctor` finds two active records where one `contradicts` the other and surfaces the pair.

Surfaces: MCP `upsert`, `search` (`sort`), `get`, `prompt action:feedback`, `promote`; CLI `memo rank`, `memo feedback`, `memo promote --format skill`, `memo doctor`; `:3124` Status Monitor Memory drawer (Mark Helpful / Flag Stale, typed-link graph).

## Business Rules & Logic

**Trap frontmatter shape** (src/schema.ts): `title`, `severity` (low|medium|high|critical), `layer` (closed enum), `module`, `pathPatterns`, `tags`, `occurrences` (int ≥ 1), `lastSeen`, `hits` (int ≥ 0), `lastHit`, `helpfulCount` (int ≥ 0), `staleCount` (int ≥ 0), `lastFeedback`, `links [{ target, type }]`, `supersedes`. Trap bodies use `DO NOT` / `INSTEAD DO` and may carry `**Layer**:` / `**Module**:` classification lines.

**Deduplication / recurrence bump.** On an `upsert` of a new trap (`kind: trap`, `allowDuplicate` not set, no `supersedes`, no existing file at the same slug), the engine calls `findMatchingTrap`. A candidate must be `status: active`, a different id/slug, have an identical sorted `pathPatterns` set, and reach a body overlap of `>= 0.7` (Jaccard-style: shared tokens / smaller token-set size, lowercased `\W+` split; `calculateTextOverlap`). On a match, the existing file is rewritten with `occurrences + 1`, `lastSeen = now`, `updated = now`, reindexed, and the result returns the existing id with `recurrence: true`. No new trap file is created.

**Bypasses.** `allowDuplicate: true` skips the matcher entirely. Supplying `supersedes` also skips the matcher and instead creates a new file whose `occurrences` is the superseded record's `occurrences + 1` (when `occurrences` was not supplied).

**Edit vs repeat.** Upserting the same `id` or `slug` (`existingRecord`) updates in place and never bumps `occurrences`. Only a distinct, matching payload counts as a repeat.

**Layer classification.** Closed enum: `application`, `domain`, `web`, `infrastructure`, `tests`, `devops`, `other`. Aliases: `front`/`frontend` → `web`; `back`/`backend` → `application`; `infra` → `infrastructure`; `na`/`n/a`/`none` → `other`. `security`, `segurança`, `seguranca` are **not** stored as a layer: they append `security` to `tags` and the layer falls back to the `**Layer**:` body alias or `other`. An omitted layer is filled from the `**Layer**:` body line; an omitted `module` from the `**Module**:` body line (trimmed free string). An explicit frontmatter layer that is a security label behaves the same as the body case.

**Defaults and validation.** New traps persist `occurrences: 1` and `lastSeen = created` when omitted. `occurrences` must be an integer ≥ 1; `layer` must be one of the enum values; `helpfulCount`/`staleCount` ≥ 0. `occurrenceOf` treats missing/malformed counts as 1; `helpfulCountOf`/`staleCountOf` treat missing/malformed as 0.

**Ranking.** `compareTrapRank` orders by `occurrences` desc, then `lastSeen` desc, then severity weight desc (critical 4, high 3, medium 2, low 1), then id asc. `search` with `sort: occurrences` uses the same tuple via `compareSearchHits` (falling back `lastSeen` to `updated`), scanning the full active trap set rather than an FTS pre-cap. `sort` accepts `relevance` (default), `occurrences`, `updated`, `hits`; an invalid value fails argument validation rather than silently falling back. `search` default for `sort: occurrences` is `kind: trap`, `status: active`.

**CLI `memo rank`** is CLI-only (not an MCP tool): `memo rank [--layer <layer>] [--limit N] [--json] [--backfill]`. It lists active traps ordered as above (default limit 10) and applies layer aliases to `--layer`. `--backfill` calls `backfillTrapRecurrence`, which writes normalized `layer`, `module`, `occurrences`, and `lastSeen` onto existing trap frontmatter without touching bodies. `--backfill` is refused in remote mode.

**Retrieval hits vs occurrences.** `hits`/`lastHit` are orthogonal (feature `0034-memory-hit-count.spec.md`): incremented when a trap/decision/spec/plan is included in a `bootstrap` brief or successfully fetched via `get` (bare `search` does not count; `search` with `hitIds` does). `occurrences` counts matched situations and is not changed by retrieval.

**Feedback.** `prompt action:feedback` (MCP) and `memo feedback <id> --helpful|--not-helpful|--stale|--wrong [--comment "…"]` (CLI) submit one of `helpful`, `not_helpful`, `stale`, `wrong`. Rules:
- `helpful` → `helpfulCount += 1` and `lastHit = now`.
- `stale` and `wrong` → `staleCount += 1`.
- `not_helpful` increments neither counter (only `lastFeedback` moves).
- Every accepted submission sets `lastFeedback = now`. Corrupt count fields are repaired to numeric 0 before incrementing.
- Missing `id` or an invalid type errors with the allowed list; an unknown record id errors `Record not found: <id>` (fail-open, no mutation). The body is never rewritten.

**Salience dampening.** `salienceMultiplier` is `1` while `staleCount <= helpfulCount`, otherwise `1 / (1 + staleCount - helpfulCount)`. `searchIndex` multiplies a hit's `rank` by this multiplier when the rank is defined, and stamps `helpfulCount`/`staleCount` on every hit.

**Stale flag.** `isFlaggedStale` is true when `staleCount >= 3` and `staleCount > helpfulCount`. Search hits get `flaggedStale: true`; `bootstrap` prepends the badge `⚠️ [POSSIBLY STALE]` to the record title; `memo doctor` lists such records under its potentially-obsolete scan.

**Typed links and contradictions.** `links` entries are `{ target, type }` with `type` in `fixes | contradicts | causes`. Invalid entries are dropped on parse. `memo doctor` performs a deterministic SQL check: a link of type `contradicts` where both source and target are `status: active` is reported as an active semantic contradiction, with a recommendation to archive or supersede. No LLM or network call is involved.

**Retention.** Traps are evergreen unless they carry `ttl`/`expires_at`; `gc` archives (never deletes by default) an expired trap. Dedup only ever considers active traps; superseded/archived traps are skipped.

## Technical Architecture

**Modules.**
- `src/store.ts`: `upsertRecord`, `findMatchingTrap`, `calculateTextOverlap`, `backfillTrapRecurrence`. Write order: resolve slug/id → secret check → recurrence match (traps) → merge frontmatter → expiration compute → capture-ignore sanitize of `pathPatterns`/`linkedPaths` → `applyTrapClassification` → validate → product-tree guard → supersede older record → write + FTS index + compiled views + vault commit.
- `src/recurrence.ts`: `TRAP_LAYERS`, `aliasLayer`, `isSecurityLabel`, `parseBodyField`, `applyTrapClassification`, `occurrenceOf`, `lastSeenOf`, `hitCountOf`, `lastHitOf`, `compareTrapRank`, `compareSearchHits`, `compareHitsSearch`, `rankActiveTraps`, `formatAsSkill`, `enrichHitFromFile`.
- `src/salience.ts`: `RECORD_LINK_TYPES`, `STALE_BADGE`, `helpfulCountOf`, `staleCountOf`, `parseRecordLinks`, `isFlaggedStale`, `salienceMultiplier`, `applyStaleBadgeToTitle`, `cloneRecordWithStaleBadge`.
- `src/feedback.ts`: `FEEDBACK_TYPES`, `submitMemoryFeedback`.
- `src/indexer.ts`: `syncRecordLinks` (writes `record_links`), `findActiveSemanticContradictions`, `getRecordLinkGraph`, `enrichHitSalience`.
- `src/compiler.ts`: `TRAPS.md` active headings render `Severity | Layer | Occurrences | Hits | Source | Updated` and a `Supersedes` wikilink.
- `src/doctor.ts`: `scanPotentiallyObsoleteRecords`, `findActiveSemanticContradictions` wiring.

**Persistence.** Trap markdown under `projects/<projectId>/traps/`; FTS row in `records_fts`; a lightweight relational table `record_links(source_id, target_id, link_type, source_project)` with PK `(source_id, target_id, link_type)`. `indexRecord` deletes existing links for the source then re-inserts the parsed set, so links stay synchronized with frontmatter. `rebuildIndex` clears `record_links` before repopulating.

**Contracts.**
- MCP `upsert` frontmatter accepts `layer`, `module`, `occurrences`, `lastSeen`, `supersedes`, `tags`, `pathPatterns`, etc.; `allowDuplicate` is an internal/store option (not exposed in the MCP `upsert` input schema).
- MCP `search` `sort` enum includes `occurrences`; hits include `occurrences`, `lastSeen`, `hits`, `lastHit`, `layer`, `severity`, `helpfulCount`, `staleCount`, `flaggedStale`. Search hits do not expose `links`; only the status-monitor Memory listing does.
- MCP `prompt` `action: feedback` requires `id` and `feedback` (plus optional `comment`).
- CLI `memo feedback <id> --helpful|--not-helpful|--stale|--wrong [--comment]`; `memo rank [--layer] [--limit] [--backfill] [--json]`.
- `memo promote --format skill` is documented in the promotion page; `formatAsSkill` groups records by layer and emits title, `occurrences`, DO NOT, and INSTEAD DO per trap.

**Side effects.** Recurrence bump writes the existing trap file and reindexes it (no tombstone, no new file). Feedback rewrites only frontmatter, reindexes, rebuilds compiled views, commits the vault change, records telemetry `operation: memory_feedback`, and schedules a hybrid push. Doctor is read-only.

**Provenance.** `0014-trap-dedup.spec.md` (dedup + `supersedes`; current code bumps occurrences instead of always superseding), `0022-trap-recurrence.spec.md` (`layer` enum, `module`, `occurrences`/`lastSeen`, `search.sort`, `memo rank --backfill`, `format: skill`), `0039-memory-feedback-salience.spec.md` (`helpfulCount`/`staleCount`, typed `links`, salience dampening, `flaggedStale`, doctor contradiction/obsolete scans). `0039` AC7 groups `stale`/`wrong` as the stale increment; `not_helpful` intentionally has no counter.
