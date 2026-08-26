# live-crdt-collaboration — context

## Feature Boundary

Live, opt-in CRDT rooms for concurrent Markdown **body** editing of `scratch` and `plan` records inside one vault project. Batch `memo sync-vault` and vault-git remain the async paths. No SaaS, no ninth MCP tool, no trap/log CRDT by default.

## Implementation Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Library | Yjs | WS providers + deterministic merge tests |
| Transport | Companion WS on port 3002 | Mirrors status companion pattern; keeps MCP SSE free |
| Persist path | Debounced `upsertRecord` | Preserves schema, secrets scan, FTS |
| Kind allowlist | scratch, plan | Avoid trap dedup / append-only log conflicts |
| Serve coupling | Opt-in `--collab` | Default serve footprint unchanged |

## Deferred Ideas

- Automerge alternative backend
- Trap-safe field-level CRDT (pathPatterns / DO NOT blocks)
- Shared cursor overlays in canvas/status UI
- CRDT snapshot compaction / GC of Y.Doc updates
- Cross-project rooms
