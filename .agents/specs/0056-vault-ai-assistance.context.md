# Feature Boundary

Vault AI assistance is a **backend intelligence layer** behind existing `upsert`, `search`, and `bootstrap`. It is not a 12th MCP tool, not a replacement for Markdown + FTS, and not a required cloud account.

In: pluggable `VaultAiAgent`, Cursor SDK adapter injected at process start, background refine-for-search, optional LLM rerank of FTS top-K, doctor/status visibility.

Out: rewriting trap bodies, vector databases, `get` synthesis, wiki regenerate, raw OpenAI HTTP providers.

# Implementation Decisions

1. **Sidecar / reserved frontmatter for retrieval aids**, never overwrite `body`. Owner can later allow body polish as a separate spec.
2. **Semantic retrieve = rerank**, not neural embeddings. Keep `config.embeddings` TF cosine as today.
3. **`get` stays dumb.** Semantic work is on `search` and `bootstrap` when `query` is present.
4. **Fail-open** on the hot path (same as wiki AI polish). Fail-closed only on unknown provider at config parse.
5. **Optional via dedicated `config.ai`:** `enabled` default false; `model` default `composer-2.5`; API key only from env `CURSOR_API_KEY` (`apiKeyEnv`). No raw key in `config.json`.
6. **One spec, possibly multiple PRs.** Owner asked for full vision in the spec of record; implementers should still land contract+queue before live Cursor if tests demand it, without splitting this file.

# Deferred Ideas

- Additional providers (OpenAI, Anthropic) behind the same interface
- True embedding vectors stored beside FTS
- LLM-authored body polish with human confirm
- `get` related-records expansion
- Status UI controls to enable AI (config.json remains SoT; UI can later patch config like wiki `aiEnabled`)
