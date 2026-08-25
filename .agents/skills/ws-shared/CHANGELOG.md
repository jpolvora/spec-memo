# Changelog

### [2026-08-25 08:10] Agent: Antigravity
- **Prompt**: Align project plans, update index.PRD, and create all corresponding *.spec.md files with derived implementation statuses
- **Done**: Created all missing canonical specifications across all phases (dogfood-remap, vault-and-identity, record-schema-and-indexes, relocatable-hub, memory-adapter-mcp, write-block-hook, trap-dedup, spec-drift, vault-git, cross-project-search, cli-doctor, viewer); synchronized index.PRD, PRODUCT.PRD, and FEATURES.md; verified schema validation across all 18 specs.
- **Result**: All 18 specifications pass validation (`validate_spec.cjs`). All 66 unit tests pass (`npm test`). Ready for tracking and execution.

### [2026-08-22 22:15] Agent: Cursor Grok 4.6
- **Prompt**: `/ws-spec-index` then promote Inbox embeddings item with a stub spec
- **Done**: Promoted embeddings-search to Phase 3 in index.PRD and PRODUCT.PRD; wrote format-valid stub `.agents/specs/embeddings-search.spec.md`
- **Result**: validate_spec.cjs --mode=authoring PASS (4 ACs). Inbox item removed. No `{plansDir}` artifacts.
