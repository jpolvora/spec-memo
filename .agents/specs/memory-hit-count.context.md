# memory-hit-count — design companion

Gray-area product choices for [`memory-hit-count.spec.md`](memory-hit-count.spec.md). Not a plan artifact.

Interview prompt: agents already query the vault during tasks. When a stored trap or other durable memory is found and used, operators want a **hit count** that shows how useful that entry has been. This is not the same as trap **occurrences** (how often the same failure was re-recorded).

## Feature Boundary

In: a retrieval-usefulness counter (`hits` / `lastHit`) on durable memory records; increment on bootstrap inclusion, successful `get`, and optional `search.hitIds`; session-scoped de-dupe; status-monitor Memory **list column + details drawer**, canvas **detail panel**, JSON/CLI surfaces; keep `occurrences` as recurrence-on-upsert.

Out: a 12th MCP tool; auto-incrementing every search result row; overloading `occurrences`; SQLite-only counters; status-monitor writes; time-decay ranking; per-hit audit log kind; list-only UI without a details view.

## Implementation Decisions

### Counter field: separate `hits` (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. New `hits` + `lastHit`, leave `occurrences` alone (chosen)** | Two honest signals. Recurrence answers "how often did this bite again." Hits answer "how often did agents retrieve this." Operators can see both in one table. |
| B. Reuse `occurrences` for search retrieval | Cheap, but lies. `trap-recurrence` already defined occurrences as upsert/dedup repeats. Mixing the two makes `memo rank` unusable. |
| C. `searchHits` vs `applyHits` as two counters | More accurate in theory, more schema and UI noise for v1. Agents will not reliably distinguish "saw" vs "applied." |

### When to increment: consult-grade events, not every FTS row (chosen)

| Option | Trade-off |
|--------|-----------|
| A. Auto +1 on every `search` / `bootstrap` result | Matches the raw phrase "when something is found." Inflates from exploratory queries, `memo rank`, and 20-row FTS dumps. High-count would mean "often returned," not "useful." |
| **B. Bootstrap inclusion + successful `get` + optional `search.hitIds` (chosen)** | Bootstrap already selected the record into the agent brief (strong usefulness). `get` means the agent opened the body. `hitIds` lets search-only consults ack the rows they actually used, without a 12th tool. Bare `search` stays read-only. |
| C. Explicit ack-only (`hit` tool or required `hitIds`) | Most accurate, but agents skip optional write-backs. Counts stay at zero and the UI looks dead. |
| D. `get` only | Misses the main consult path (`bootstrap` rarely calls `get` per trap). Undercounts the exact workflow the user described. |

### Kinds: durable consult records (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. `trap`, `decision`, `spec`, `plan` (chosen)** | These are what `ws-self-learning` / bootstrap / search consult during tasks. |
| B. Traps only | Too narrow; decisions and live specs are also retrieved as memory. |
| C. Every kind including `log`, `scratch`, `prompt`, `session` | Audit and TTL noise. Prompt explorer already has its own tab. |

### Persistence: markdown frontmatter, fail-open (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Persist `hits` / `lastHit` on the markdown record (chosen)** | Markdown remains source of truth. FTS rebuild and vault-git keep the counter. Follow existing vault-git atomic vs batched flush. Hit I/O must fail open so consults never break. |
| B. SQLite-only counter | Fast, but `doctor --rebuild` and "markdown is SoT" wipe the signal. |
| C. Append a `log` event per hit | Auditable timeline, extra GC, extra FTS junk. Too heavy for a usefulness badge. |

### De-dupe window: per sessionId (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. At most one increment per (`sessionId`, record id) when `sessionId` is passed (chosen)** | One agent session that bootstraps then `get`s the same trap does not count as two useful retrievals. CLI one-shots with no `sessionId` increment per qualifying call. |
| B. Increment every qualifying call with no window | Bootstrap + get in the same turn double-counts. |
| C. Calendar-day unique | Simple, but two distinct tasks the same day undercount usefulness. |

### UI: status-monitor Memory tab + detail drawers (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Memory tab list + details drawer, and canvas detail meta shows Hits (chosen)** | Operators see hit count in every records list row and again in the detail panel (status Memory drawer + canvas node drawer). Reuses Prompts master-detail pattern. Read-only; listing/detail never increment. |
| B. List column only, no detail panel | Easy to miss when inspecting a single entry. |
| C. Canvas node size only | Canvas is a graph, not a sortable list. User asked for list + detail visibility. |
| D. CLI `memo rank` only | Agents can query JSON; humans need the status/canvas UI. |

## Deferred Ideas

- Time-decay / half-life so stale high `hits` fade when `lastHit` is old.
- Distinguishing search-seen vs apply-confirmed as two counters.
- Canvas node radius scaled by `hits`.
- Auto-promoting high-hit traps via `promote format:skill` without a human `memo rank`.
- Cross-project hit rollup ("this trap class is useful in every repo").
- A 12th MCP tool named `hit`.
