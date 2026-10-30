# Feature context — wiki-ai-refine

## Feature Boundary

In scope:

- On-demand vault `WIKI.md` polish when the vault AI assistant is on, using a fresh `collectWikiSources` snapshot for one `projectId`, fail-open, 11 MCP tools, status/CLI regenerate only.
- **Generation / visual revamp** inspired by `ws-wiki`: index-first page with Topic catalog sublinks, progressive topic disclosure, left topic menu inside the status Wiki tab.

Out of scope: auto-regen on upsert, product `{wikiDir}` / docs-site wiki, porting the `ws-wiki` skill runtime into memo, inventing product domain folders inside the vault, full record bodies in the snapshot (until the spec is revised), extra MCP tools, product README.

## Inspiration map (`ws-wiki` → vault wiki)

| `ws-wiki` pattern | Vault / status equivalent in this slice |
|-------------------|-----------------------------------------|
| `index.wiki.md` root (vision + catalog) | `projects/{projectId}/WIKI.md` index-first template |
| Domain catalog links `[{Title}]({domain}/{feature}.md)` | `## Topic catalog` with `[Title](#slug): blurb` (or `./wiki/{slug}.md` if multi-file on) |
| Feature subpages with Feature / How it works | Topic `h2` bodies; condensed narrative style where applicable |
| Progressive disclosure (index → page) | Left topic menu + main pane; section fetch / split |
| Product `{wikiDir}` tree | **Not** used; vault stays under `projects/{projectId}/` |

## Implementation Decisions

1. **Gate:** `ai.enabled === true` and `VaultAiAgent.isAvailable()`. Legacy `wiki.aiEnabled` / `SPEC_MEMO_WIKI_AI` remain for injected-callback unit tests.
2. **Trigger:** existing regenerate (HTTP + CLI), not a new timer.
3. **Snapshot richness (v1):** ids, kinds, titles, counts — not full bodies. Owner may later allow excerpts.
4. **Polish API:** extend regenerate to pass `{ markdown, snapshot }` into polish (or an optional agent method) rather than markdown-only.
5. **Template:** revamp `src/wiki/template.md` to index-first + Topic catalog + stable topic `h2`s (AC19–AC21).
6. **Status UX:** split Wiki tab — `#wiki-topic-nav` + `#wiki-view`; Index default; `?section=` deep link (AC25–AC30).
7. **Multi-file topic pages:** default off. Single `WIKI.md` with `h2` + existing `GET /api/wiki/section` is enough for progressive disclosure. AC23 remains the optional on-ramp if the owner enables it later.

## Deferred Ideas

- Auto wiki refine after the per-record refine queue drains for a project.
- Include `aiSummary` / retrieval-aid text in the snapshot.
- Per-section polish (traps only).
- Unify `wiki.aiEnabled` into `ai.enabled` and delete the env flag.
- Turn on multi-file `projects/{id}/wiki/{slug}.md` and point catalog at relative files.
- Richer markdown renderer in the Wiki pane (tables, lists) beyond the current zero-dep helper — only if Index/topic readability demands it.
