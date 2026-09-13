# Feature Boundary

AI ops observability is a **status-monitor + vault diagnostic journal** for 0056 agent calls. It is not a twelfth MCP tool, not FTS memory, and not an unredacted transcript store.

In: append-only JSONL under the vault, status REST list/detail, AI Ops tab, `error.logs` subsystem `ai` for failures.

Out: enabling AI from the UI, dumping entire `error.logs` in the browser, canvas UI, indexing ops as vault records.

# Implementation Decisions

1. **New tab `AI Ops`**, not the live Activity SSE list. Activity stays ephemeral; the journal is durable.
2. **Separate `ai-ops/` JSONL** for success and failure rows. `error.logs` stays the human/machine failure file for later analysis (including journal write failures and status handler throws).
3. **Redact and cap at 8 KB** combined input/output. Operators see enough to debug; secrets stay out.
4. **Wire capture at `VaultAiAgent` settlement**, independent of activity bus payload policy from 0056.

# Deferred Ideas

- UI viewer for raw `error.logs`
- Config toggle on the Wiki-style settings card to set `ai.opsLogEnabled`
- Export/download of `ai-ops` parts from the Backups tab
- MCP `search` over journal lines
