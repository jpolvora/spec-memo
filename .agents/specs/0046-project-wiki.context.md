# Feature context — project-wiki

## Feature Boundary

In scope: one vault-side `WIKI.md` per project, shipped `template.md`, on-demand regenerate (deterministic always, optional AI polish), status Wiki tab with project select and collapsed sections, CLI `memo wiki`.

Out of scope: product README, 12th MCP tool, auto-regen on upsert, all-vaults wiki, canvas integration, custom templates in v1.

## Implementation Decisions

1. **Storage:** `projects/{projectId}/WIKI.md` next to compiled views, not a new record `kind`. Keeps FTS/schema unchanged and stays Obsidian-openable.
2. **Generate pipeline:** collect → fill template (required) → optional AI polish → persist. Offline and CI always get a complete page.
3. **Progressive disclosure:** persist the full Markdown file; the Wiki tab collapses `h2` on view. Optional `GET /api/wiki/section` for tests and large pages.
4. **Open Knowledge Format:** UTF-8 Markdown + relative links / optional wikilinks as in `0015-viewer`. No extra viewer runtime.

## Deferred Ideas

- Vault-local template override (`projects/{id}/wiki-template.md`).
- MCP `wiki` tool if agents cannot invoke CLI extras in remote mode.
- Incremental section regen (only traps) if full collect becomes slow on huge vaults.
