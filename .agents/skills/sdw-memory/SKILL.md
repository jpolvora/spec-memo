---
name: sdw-memory
description: Central product knowledge wrapper — query, record, consolidate, and classify traps, gaps, patterns, and errors across pluggable store backends.
version: 0.1.0
invocation_names:
  - sdw-memory
  - sdw-memory query
  - sdw-memory record
  - sdw-memory consolidate
  - sdw-memory classify
  - memory
---
# sdw-memory

> When this skill is loaded, output "sdw-memory loaded."

Central source of truth for product knowledge. Wraps every memory read and write behind one contract and delegates to pluggable store backends (native: `ws-memo` vault; fallback: local `.sdw/memory/traps.md` file). No skill writes memory through any other path.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) — surgical scope, verification — before any write. Reviewer and recorder stay separate; never self-approve a learning you just produced.

## Subcommands

- `query "<text>" [--kind trap|gap|pattern|error] [--backend auto|ws-memo|traps] [--limit N] [--json]`: Search backends for related knowledge; merged hints, capped.
- `record --kind <kind> --title "..." --avoid "..." --action "..." [--slug S] [--tags a,b] [--paths f] [--layer L] [--severity S] [--backend ...] [--json]`: Validate and persist one entry; deduplicated.
- `consolidate [--backend traps] [--dry-run] [--json]`: Merge duplicate local rows; vault records are reported, never auto-deleted.
- `classify "<text>" [--json]`: Deterministically suggest `kind`, slug, tags, layer for free text.
- `doctor [--json]`: Validate skill layout, script syntax, zero-dependency guarantee, vault reachability.

## Steps

1. **Classify First**
   Suggest the entry kind before writing: trap (must-not-do), gap (missing coverage), pattern (reusable convention), error (observed failure with fix).
   - Run: `node skills/sdw-memory/scripts/sdw_memory.cjs classify "<text>"`
   - Done when: JSON names one of `trap|gap|pattern|error` with slug and tags.

2. **Query Before Acting**
   Search every enabled backend for related knowledge and apply returned hints; record `consult-skipped` per unavailable backend.
   - Run: `node skills/sdw-memory/scripts/sdw_memory.cjs query "<task>" [--kind <kind>] [--limit 5]`
   - Done when: Merged hints (or explicit skips) are in hand before the edit.

3. **Record After Verifying**
   Persist only verified learnings with `avoid` plus `action`; duplicates by slug are refused, never duplicated.
   - Run: `node skills/sdw-memory/scripts/sdw_memory.cjs record --kind <kind> --title "..." --avoid "..." --action "..."`
   - Done when: Report names the recording backend(s) or states why nothing was recorded.

4. **Consolidate on Schedule**
   Compact the local traps file by merging same-slug rows; vault lifecycle stays with `memo gc` / `forget`.
   - Run: `node skills/sdw-memory/scripts/sdw_memory.cjs consolidate [--dry-run]`
   - Done when: Report states removed vs kept counts.

## Backend Configuration

Default backend is the `ws-memo` vault (requires the `ws-memo` skill plus a
reachable `memo` CLI; `sdw-memory doctor` reports both). Fallback order is
`traps` file, then memory files. Select per user in `.sdw/config.json` with
`memory.backends: { wsMemo, traps, files }` (`true` unless explicitly
`false`); `--backend` pins the target set per call, `SDW_MEMORY_NO_MEMO=1`
disables the vault. When no backend is enabled or reachable, calls succeed
as no-ops: queries return empty hints, records report `noop: true` — callers
never block. See [`references/memory_protocol.md`](references/memory_protocol.md) §2.

## References

- Backend contract, entry model, kind mapping, report schemas: [`references/memory_protocol.md`](references/memory_protocol.md)
- Deterministic helper: `scripts/sdw_memory.cjs`
