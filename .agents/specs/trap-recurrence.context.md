# trap-recurrence — design companion

Gray-area product choices for [`trap-recurrence.spec.md`](trap-recurrence.spec.md). Not a plan artifact.

## Feature Boundary

In: structured `layer` / `module` / `occurrences` / `lastSeen` on traps; reuse trap-dedup as the "same situation" matcher; list by recurrence through `search.sort` and `memo rank`; compile top N traps into one owner `SKILL.md` via `promote format:skill`.

Out: a ninth MCP tool, a new taxonomy microservice, bootstrap formula changes, embeddings-based classification, per-trap skill files, automatic install into consumer skill hubs.

## Implementation Decisions

### L1 taxonomy: closed Layer enum (chosen)

The request suggested front / back / security. Live vault (`~/.spec-memo`, 49 traps on 2026-08-25) already uses Layer in trap bodies: Application 16, Domain 6, Web 6, Tests 5, Infrastructure 3, DevOps 1, plus N/A and missing. Frontmatter `tags` are almost unused.

| Option | Trade-off |
|--------|-----------|
| **A. Closed Layer enum from vault (chosen)** | Matches imported MEMORY shape and `FEATURES.md` trap template. Security stays a tag (a concern, not a layer). Aliases map the user's front/back words. |
| B. User's front / back / security as L1 | Fights the data. "Back" would collapse Domain + Application + Infrastructure. Security would orphan most traps. |
| C. Tags only, no `layer` field | Queryable today, but agents do not fill tags. Ranking by tag would be empty on the current vault. |

### Repeat semantics: bump in place (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Dedup match increments the surviving trap (chosen)** | One file per situation; the counter is the ranking signal. Same-id edits do not bump. |
| B. Always supersede and copy count + 1 | History of every rewrite, but TRAPS.md churn and extra superseded files for identical repeats. |
| C. Separate occurrence log records | Auditable timeline, extra kind, extra GC rules. Too heavy for "how often does this bite." |

### Query surface: search sort + CLI alias (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. `search.sort` + `memo rank` (chosen)** | No PRD §6 amendment. Agents already know `search`. Humans get a short CLI. |
| B. Ninth MCP tool `rank` | Cleaner name, violates the frozen 8-tool surface. |
| C. CLI-only, no MCP sort | Agents in MCP hosts cannot list recurrence without shelling out. |

### Skill export: one compiled SKILL.md of top N (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. `promote format:skill` of top N (chosen)** | Reuses default-deny destination. One file the owner repo can load as a project skill. |
| B. One skill file per trap | Noisy; agents will not load 10 skills for the same anti-repeat job. |
| C. Compile into consumer `MEMORY.md` | Crosses the git-boundary thesis; MEMORY already imports into the vault. |

## Deferred Ideas

- Time-decay / half-life so old high counts fade when `lastSeen` is stale.
- Bootstrap tertiary sort by `occurrences` after severity and path (would steal budget from path-relevant traps).
- Suggest `layer` from `pathPatterns` (e.g. `angular/**` → `web`) as a hint when body Layer is missing.
- Cross-project recurrence rollup ("this class of trap hits every repo").
- Auto-open a tracker issue when `occurrences` crosses a threshold.
