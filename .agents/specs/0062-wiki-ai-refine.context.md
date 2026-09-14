# Feature context — wiki-ai-refine

## Feature Boundary

In scope: on-demand vault `WIKI.md` polish when the vault AI assistant is on, using a fresh `collectWikiSources` snapshot for one `projectId`, fail-open, 11 MCP tools, status/CLI regenerate only.

Out of scope: auto-regen on upsert, docs-site wiki, full record bodies in the snapshot (until the spec is revised), extra MCP tools, product README.

## Implementation Decisions

1. **Gate:** `ai.enabled === true` and `VaultAiAgent.isAvailable()`. Legacy `wiki.aiEnabled` / `SPEC_MEMO_WIKI_AI` remain for injected-callback unit tests.
2. **Trigger:** existing regenerate (HTTP + CLI), not a new timer.
3. **Snapshot richness (v1):** ids, kinds, titles, counts — not full bodies. Owner may later allow excerpts.
4. **Polish API:** extend regenerate to pass `{ markdown, snapshot }` into polish (or an optional agent method) rather than markdown-only.

## Deferred Ideas

- Auto wiki refine after the per-record refine queue drains for a project.
- Include `aiSummary` / retrieval-aid text in the snapshot.
- Per-section polish (traps only).
- Unify `wiki.aiEnabled` into `ai.enabled` and delete the env flag.
