---
id: null
slug: trap-recurrence
title: "Trap recurrence ranking and owner-skill export"
source: local
specDate: 2026-08-25
---

# Specification — Trap recurrence ranking and owner-skill export

## Description

Agents already record anti-regression traps, but a repeated failure still becomes a new file (or a silent supersede) with no memory of how often the same situation hit. This slice turns recurrence into structured vault metadata so a human or agent can list the worst repeating gaps and export them as a project-owned skill.

Architecture touchpoints:

- **Store / upsert (`src/store.ts`)**: extend trap-dedup. A true repeat of an existing active trap increments `occurrences` on that record instead of creating another file. An explicit supersede copies the old count plus one onto the survivor. An in-place edit of the same id or slug never bumps the counter.
- **Schema (`src/schema.ts`, `src/types.ts`)**: optional trap fields `layer`, `module`, `occurrences`, `lastSeen`. `layer` is a closed enum taken from live vault evidence, not a new front/back/security taxonomy.
- **Search (`src/indexer.ts`, `search` tool)**: add `sort` so callers can list traps by recurrence without a ninth MCP tool. The PRD 8-tool surface stays unchanged.
- **CLI (`src/cli.ts`)**: `memo rank` is a convenience view over that sort (same pattern as `memo doctor`: CLI-only, not a new MCP tool).
- **Promote (`src/promote.ts`)**: add `format: skill` to compile ranked traps into one `SKILL.md` in the owner product tree. Default-deny destination rules stay in force.
- **Compiler (`src/compiler.ts`)**: `TRAPS.md` headings include `layer` and `occurrences`.

Greenfield additive slice. It reuses trap-dedup, tags, promote, and the existing Layer/Module body convention from `FEATURES.md` § Trap shape.

## Acceptance Criteria

- AC1: Trap frontmatter accepts optional `layer` with the closed enum `application`, `domain`, `web`, `infrastructure`, `tests`, `devops`, `other`.
- AC2: Schema validation fails when `layer` is present and is not one of those enum values.
- AC3: On trap upsert, omitted `layer` is filled by parsing a `**Layer**:` body line and normalizing it to the closed enum.
- AC4: Alias mapping on write stores `front` and `frontend` as `web`, `back` and `backend` as `application`, and `infra` as `infrastructure`.
- AC5: Values `security` and `segurança` are not stored as `layer`; they are appended to `tags` as `security`.
- AC6: Trap frontmatter accepts optional `module` as a trimmed string; omitted `module` is filled from a `**Module**:` body line when present.
- AC7: New trap records persist `occurrences: 1` and `lastSeen` equal to `created` when those fields are omitted.
- AC8: Schema validation fails when `occurrences` is present and is not an integer greater than or equal to 1.
- AC9: Upserting an existing trap by the same `id` or `slug` updates the record in place without incrementing `occurrences`.
- AC10: When trap-dedup matches an existing active trap (identical `pathPatterns` and body overlap >= 0.7) and `allowDuplicate` is false, the engine increments `occurrences` on the existing record.
- AC11: That recurrence bump sets `lastSeen` to the current timestamp and returns the existing record id.
- AC12: That recurrence bump creates no new trap file.
- AC13: When a new trap sets `supersedes` to an older trap, the new record's `occurrences` equals the superseded record's `occurrences` plus 1.
- AC14: The `search` tool accepts optional `sort` with values `relevance` (default), `occurrences`, and `updated`.
- AC15: Invalid `sort` values fail argument validation with an error, not a silent fallback.
- AC16: When `sort` is `occurrences`, active traps are ordered by `occurrences` descending, then `lastSeen` descending, then severity weight descending.
- AC17: Records missing `occurrences` rank as if `occurrences` were 1 without requiring a file rewrite.
- AC18: CLI `memo rank [--layer <layer>] [--limit N] [--json]` lists active traps using `sort=occurrences` and does not add a ninth MCP tool.
- AC19: `promote` accepts `format: skill` in addition to `raw`, `adr`, and `madr`.
- AC20: When `format` is `skill` and `id` is omitted, promote compiles the top `limit` active traps (default 10) by the rank order into one destination file.
- AC21: When `format` is `skill` and `id` is set, promote compiles only that trap into the destination file.
- AC22: A `format: skill` payload groups each included trap under its `layer` with title, `occurrences`, DO NOT, and INSTEAD DO extracted from the body.
- AC23: Skill export keeps the existing default-deny rule: missing destination, path outside the product tree, or path under `.git/` fails.
- AC24: Compiled `TRAPS.md` active headings include `layer` and `occurrences`.
- AC25: CLI `memo rank --backfill` writes normalized `layer`, `module`, `occurrences`, and `lastSeen` onto existing trap frontmatter without changing trap bodies.

## Original Issue Context

Free-text request (pt-BR, 2026-08-25): create a ranking of the problems / situations that repeat most often. When classifying new traps, categorize them in two levels: (1) generic (front, back, security, etc., using categories that actually recur in `$HOME/.spec-memo`); (2) more specific. On each new memory, store an occurrence counter and increment it when the same situation repeats. Periodically list the most recurrent gaps/traps, then export them as a skill into the owner project so the repeating problem stops recurring. Also improve and simplify the idea.

### Prior Work Sweep

Keyword + `git log` on store, schema, promote, search, bootstrap, trap-dedup. No open PR for this tracker id (local spec, `id: null`).

| Hit | Relation | Action |
|-----|----------|--------|
| [`trap-dedup.spec.md`](trap-dedup.spec.md) / `src/store.ts` Jaccard overlap | Same-situation detection already exists; it supersedes instead of counting | Reuse the matcher; add occurrence bump |
| [`bootstrap-brief.spec.md`](bootstrap-brief.spec.md) / `cf38bf9` | Session brief ranks by severity + path, not recurrence | Leave bootstrap formula unchanged in this slice |
| [`promote-adr.spec.md`](promote-adr.spec.md) / `src/promote.ts` | Product-tree export with `format` enum and default-deny | Extend `format` with `skill` |
| `FEATURES.md` § Trap shape | Body already has Layer / Module | Promote those fields to frontmatter |
| Live vault `~/.spec-memo` (49 traps, 2026-08-25) | Layer frequencies: Application 16, Domain 6, Web 6, Tests 5, missing 5, N/A 4, Infrastructure 3, DevOps 1. Frontmatter `tags` almost unused. Module prefixes are domain names (Acertos, Expedicoes, EntityFrameworkCore) | Closed enum from this evidence; do not invent front/back/security as L1 |
| MCP surface (`TOOL_NAMES`, PRD §6) | Exactly 8 tools; do not grow without PRD amendment | Rank via `search.sort` + CLI alias; export via `promote` |

Related hits recorded; no exact same-issue open PR. Continue.

### Design Intent

Greenfield skip: no prior `occurrences` / `layer` enum / `format: skill` behavior to restore. Adjacent trap-dedup supersede-on-match is an intentional constraint (keep one active trap per situation). Recurrence counting must compose with that matcher, not replace it with a parallel duplicate store.

## Notes

- Simplification versus the raw idea: L1 is the existing Layer vocabulary, L2 is `module`, security is a tag, ranking is a sort on `search`, export is a `promote` format. No ninth MCP tool, no separate taxonomy service, no per-trap skill files.
- Occurrence means "a later upsert matched this situation," not "the agent edited the same file." Same-id writes are edits.
- Rank queries may be scoped with existing `search` filters (`tags`, `path`, `crossProject`, `status`).
- Skill export is documentation in the owner git tree. It does not mutate workflow-skills hub files and does not auto-commit.
- Companion design notes: [`trap-recurrence.context.md`](trap-recurrence.context.md).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Ninth MCP tool (`rank` / `export-skill`) | PRD §6 freezes the 8-tool surface; CLI `memo rank` plus `search.sort` and `promote` cover the jobs |
| Changing bootstrap ranking to prefer high-occurrence traps | Bootstrap stays severity + path + budget; recurrence is an on-demand query |
| LLM / embeddings classifier for layer or "same situation" | Deterministic enum + existing Jaccard matcher; agents still choose module text |
| Time-decay ranking or rolling windows | Raw `occurrences` + `lastSeen` is enough for v1; decay is a later ranking tweak |
| One output skill file per trap | One compiled `SKILL.md` of the top N is the anti-repeat artifact |
| Auto-install into `{skillsRoot}` or Cursor skill dirs | Promote remains default-deny into an explicit product-relative destination |
| Counting non-trap kinds (specs, plans, logs) | Recurrence is a trap/gap signal, not a generic event counter |
| Rewriting consumer `ws-self-learning` templates | Vault schema stays compatible with Layer / Module body lines already imported |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| L1 vocabulary | Closed `layer` enum from live vault Layers (application, domain, web, infrastructure, tests, devops, other) | Matches 49 real traps; user's front/back/security maps via aliases + `security` tag | y |
| L2 vocabulary | Free-string `module` (existing body field) | Module names are project-specific (Acertos, Expedicoes); a global L2 enum would be wrong | y |
| Repeat vs edit | Same id/slug = edit (no bump); new payload matching another active trap = bump | Prevents counter inflation from typo fixes | y |
| Repeat vs evolve | Overlap >= 0.7 + same pathPatterns = bump in place; explicit `supersedes` = new file with count + 1 | Keeps trap-dedup threshold; evolutionary rewrites stay visible | y |
| Query surface | `search.sort=occurrences` + CLI `memo rank`; no new MCP tool | Satisfies "consult from time to time" without amending PRD §6 | y |
| Skill export | `promote format:skill` compiles top N (default 10) into one `SKILL.md` | Reuses default-deny promote; one file agents can actually load | y |
| Backfill | Opt-in `memo rank --backfill`; rank treats missing count as 1 | Avoids surprising vault rewrites on first search | y |
| Implicit dimensions (auth, rate limits, TTL, external deps) | N/A because this slice is local vault metadata, sort, and promote formatting with no network or new retention class | Existing trap retention and vault lock cover lifecycle and concurrency | y |
