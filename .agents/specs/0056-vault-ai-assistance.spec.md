---
id: null
slug: vault-ai-assistance
title: "Vault AI assistance: agent interface, Cursor SDK adapter, refine-on-write, semantic retrieve, status"
source: local
specDate: 2026-09-13
---

# Specification — Vault AI assistance: agent interface, Cursor SDK adapter, refine-on-write, semantic retrieve, status

## Description

Add an **optional intelligence layer** on vault write and read without changing the 11 MCP tools, without making Markdown non-authoritative, and without blocking MCP/CLI on network LLM calls.

Today `upsert` persists markdown + FTS only. Wiki already injects optional `polishWikiMarkdown` with timeout and fail-open (`src/wiki.ts`). Search already has lexical FTS plus optional local term-frequency cosine (`config.embeddings`, not an LLM). Bootstrap packs a byte-capped brief from those hits. There is no pluggable agent, no background refine of ingested records, and no LLM rerank on `search` / `bootstrap`.

This spec adds:

1. **`VaultAiAgent` interface** (common contract). Implementers must provide `refineForSearch` and `rankCandidates` (plus `isAvailable`). No other methods are required in this slice.
2. **`NoopVaultAiAgent`** default (identity / passthrough). Unit tests never call the network.
3. **`CursorSdkVaultAiAgent`** using TypeScript `@cursor/sdk` `Agent.prompt` one-shot. Constructed at process start (MCP stdio, `memo serve --sse`, CLI) from the dedicated vault `config.json` **`ai`** section and injected into store/indexer/bootstrap. The feature is **optional**: omit `ai`, or set `ai.enabled` false (the default). Live Cursor calls require `enabled: true` plus an API key from the environment named by `ai.apiKeyEnv` (default `CURSOR_API_KEY`). Model id comes from `ai.model` (default `composer-2.5`).
4. **Write path:** after a successful `upsert` of eligible kinds, enqueue a background refine job. The MCP/CLI response returns as today. Refine **must not replace** the record `body`. It writes a sidecar (or reserved frontmatter fields listed in Notes) used only for retrieval, then rebuilds FTS for that record under the vault lock.
5. **Read path:** `search` and `bootstrap` keep FTS (and existing embeddings filter) as the candidate source. When AI is available, `rankCandidates` may reorder a bounded top-K. Timeout or error keeps the lexical order (fail-open). `get` by id stays a direct store read (no LLM).
6. **Status:** `memo doctor --json` / status monitor health include AI provider, enabled flag, queue depth, last redacted error. Activity bus events `ai.refine.*` / `ai.rank.*`. No 12th MCP tool.

Language: en-us. Markdown remains SoT. SQLite FTS remains disposable. Host-neutral MCP schemas must not require Cursor; Cursor is one runtime adapter.

Eligible kinds (default): `trap`, `decision`, `spec`, `plan`. Default-off kinds: `log`, `scratch`, `review`, `state`, `session`.

## Acceptance Criteria

### Contract and injection

- AC1: A TypeScript interface `VaultAiAgent` exists with methods `isAvailable(): boolean`, `refineForSearch(input: VaultAiRefineInput): Promise<VaultAiRefineResult>`, and `rankCandidates(input: VaultAiRankInput): Promise<VaultAiRankResult>`; implementations must not use unchecked `any` for these payloads.
- AC2: `VaultAiRefineInput` includes at least `id`, `kind`, `title`, `body`, `tags`, and `pathPatterns`; `VaultAiRefineResult` includes `ok: boolean`, optional `searchTerms: string[]`, optional `summary: string`, optional `error: string`.
- AC3: `VaultAiRankInput` includes `query: string` and `candidates: { id: string; kind: string; title: string; snippet: string }[]` with `candidates.length` <= `config.ai.rankTopK` (default 20); `VaultAiRankResult` is an ordered list of the same ids (subset allowed) plus optional `error`.
- AC4: Process startup constructs the agent from `readVaultConfig`: missing `ai` object, `ai.enabled` omitted, or `ai.enabled === false` yields `NoopVaultAiAgent` (no SDK import required on that path); `ai.enabled === true` and `ai.provider === "cursor-sdk"` yields `CursorSdkVaultAiAgent`; unknown provider fails closed at config parse (Zod) and does not start MCP with a half-wired agent.
- AC5: Tests and wiki-style DI may pass an explicit `VaultAiAgent` into `upsertRecord` / `searchRecords` / `compileBootstrapBrief`; when passed, it overrides config construction for that call.
- AC6: `TOOL_NAMES.length` remains 11; no MCP tool named `ai`, `refine`, or `embed` is added.

### Cursor SDK adapter

- AC7: `CursorSdkVaultAiAgent` calls `@cursor/sdk` `Agent.prompt` (one-shot) with a JSON-only instruction and `model: { id: config.ai.model }` where `config.ai.model` defaults to `composer-2.5` when omitted or empty; it does not use `Agent.create` follow-up runs for refine or rank.
- AC8: The adapter must not pass a local `cwd` of the product repo or the vault root in a way that grants filesystem tools; if the SDK requires a runtime, use cloud or a local runtime with tools disabled (empty tool set). A test fixture asserting the create/prompt options omit writable `cwd` at the vault path must pass.
- AC9: API key is read only from `process.env[config.ai.apiKeyEnv]` with `apiKeyEnv` defaulting to `CURSOR_API_KEY`; `config.ai` must not store the raw key (no `apiKey` / `token` field); the secret is never written to markdown, telemetry, activity payloads, doctor JSON, or `config.json`.
- AC10: Prompt and completion are wrapped in the same timeout pattern as wiki polish (`config.ai.timeoutMs` default 15000); on timeout `ok` is false and the caller fail-opens.
- AC11: Non-JSON or schema-invalid model output is treated as failure (`ok: false`); refine does not write a sidecar; rank does not change FTS order.
- AC12: When `CURSOR_API_KEY` is empty and provider is `cursor-sdk`, `isAvailable()` is false; upsert and search behave as Noop (no throw to MCP).

### Refine-on-write (background)

- AC13: Successful `upsert` of an eligible kind enqueues at most one refine job keyed by record `id` (coalesce in-flight duplicates); the upsert HTTP/MCP/CLI result does not await the agent.
- AC14: Floating promises are forbidden: the enqueue path uses `void job.catch(...)` or an equivalent handled queue; unhandled rejection must not crash `memo serve`.
- AC15: Refine never overwrites `body`; after success it persists retrieval aids only via the sidecar/frontmatter contract in Notes, then updates FTS for that id under `withVaultLock`.
- AC16: If `body` UTF-8 hash equals the hash stored with the last successful refine, the job is a no-op (idempotent skip).
- AC17: Agent or I/O failure leaves the original markdown record intact; FTS still contains the pre-refine text; doctor records a redacted `ai.lastError`.
- AC18: Ineligible kinds never enqueue refine.
- AC19: `forget` / purge of a record drops its pending job and sidecar; GC of expired scratch does not call the agent.

### Semantic retrieve (search and bootstrap)

- AC20: With AI disabled or `isAvailable() === false`, `search` hit id order for a frozen fixture matches the current FTS + existing `config.embeddings` path byte-for-byte on id sequence.
- AC21: With AI available, `search` still obtains candidates from FTS (and existing embeddings filter); only then may `rankCandidates` reorder the first `rankTopK` hits; ids not returned by the agent keep their relative lexical tail order after the ranked prefix.
- AC22: Rank timeout or throw does not fail the search tool; the response is the lexical ranking plus an optional non-budget `explain.aiRank: "skipped"` when `explain: true`.
- AC23: `compileBootstrapBrief` uses the same rank helper on trap/decision candidates when `options.query` is non-empty and AI is available; empty query skips rank (no extra LLM call).
- AC24: Ranked bootstrap still respects `maxBytes` / `truncated`; rank cannot expand the brief past budget.
- AC25: `get` by id does not call `rankCandidates` or `refineForSearch`.
- AC26: Existing `config.embeddings` TF cosine remains independent; this spec does not remove it and does not require a neural embedding library.

### Status, config, safety

- AC27: Vault `config.json` may include a dedicated `ai` object; Zod defaults are `enabled: false`, `model: "composer-2.5"`, `apiKeyEnv: "CURSOR_API_KEY"`, `timeoutMs: 15000`, `rankTopK: 20`; omitting `ai` equals disabled.
- AC28: `memo doctor --json` includes `ai: { enabled, provider, available, queueDepth, lastError }` with `lastError` passed through existing sanitizer; secrets stripped.
- AC29: Status monitor health card or `/api/status` includes the same `ai` object (read-only).
- AC30: Activity bus emits `ai.refine.ok` | `ai.refine.fail` | `ai.rank.ok` | `ai.rank.fail` with `recordId` / `durationMs` and no prompt bodies.
- AC31: Text sent to the agent is passed through existing secret redaction before the SDK call; redaction failure skips the call (fail-open).
- AC32: `setup` merge preserves existing `ttl`, `vaultGit`, `embeddings`, `bootstrap`, and `ai`; seeded example config includes the `ai` block from Notes with `enabled: false`.

### Tests and docs

- AC33: Automated tests cover Noop vs fake agent DI (refine sidecar, skip ineligible kinds, upsert not awaiting agent), rank fail-open, cursor adapter option shape without live network, Zod unknown provider, and doctor `ai` field; live `@cursor/sdk` network tests are not required.
- AC34: `npm run build` and `npm test` stay green; `@cursor/sdk` is an optional dependency or is imported only from the adapter module so Noop tests run without a key.
- AC35: `README.md` and `ws-memo` document the optional `config.json` `ai` section (`enabled` default false, `model` default `composer-2.5`, key via env `CURSOR_API_KEY`), fail-open behavior, and that Cursor is not required to run the vault; MCP tool list stays 11.

## Original Issue Context

Standalone `/ws-spec-write` from product owner: add backend AI assistance on vault ingest and retrieval; common agent interface; first implementation via Cursor SDK injected at runtime; refine posts (trap/spec/gap) for search; semantic agent on bootstrap/get/memory. Grill-me on first delivery; owner then chose **full vision in one spec** (interface, write refine, semantic retrieve, embeddings coexistence, queue, status UI), not a contract-only slice.

### Prior Work Sweep

- Wiki AI polish: `src/wiki.ts` `polishWikiMarkdown` inject, `SPEC_MEMO_WIKI_AI`, timeout 15s, fail-open, `no provider` when callback missing. Reuse timeout/fail-open; do not route vault records through wiki regenerate.
- Embeddings: `0001-embeddings-search.spec.md` and `src/indexer.ts` local TF cosine when `config.embeddings.enabled`. Not Cursor; not a vector DB. Keep as independent filter.
- Retrieval lens in flight: `0055-retrieval-lens-resume.spec.md` (lexical intent boost, no embeddings, no extra MCP tool). This spec must not fight that ranking; AI rank runs **after** FTS+lens when both exist, or is specified as post-lexical.
- Adapter: `src/adapter.ts` `MemoryAdapter` wraps bootstrap/upsert; no agent today.
- Git keywords: `Agent.prompt`, `VaultAiAgent`, `refineForSearch` absent in `src/`. Duplicate risk: low vs wiki polish (different payload). `providers.scm=github`; no tracker id.

### Design Intent

Greenfield feature (new `src/ai/` adapter + hooks into existing upsert/search/bootstrap). Skip `git log -L` on a missing symbol. Constraints to preserve: 11 tools, markdown SoT, FTS rebuildable, wiki polish fail-open, local-first vault without a required cloud account (AI remains opt-in).

## Notes

**Sidecar contract (retrieval aids):** preferred file `{recordStem}.ai.md` next to the record **or** reserved frontmatter keys `aiSearchTerms` (string[]) and `aiSummary` (string, max 500 chars). Implement one; do not store model transcripts. FTS document text = title + tags + body + searchTerms + summary.

**Queue:** single-flight per `record id`; global concurrency default 1 (`config.ai.maxConcurrent` optional, default 1) to avoid Cursor stampede and vault-lock races (see dual-sync sequential trap).

**Dedicated `ai` section (vault `config.json`):**

```json
{
  "ai": {
    "enabled": false,
    "provider": "cursor-sdk",
    "model": "composer-2.5",
    "apiKeyEnv": "CURSOR_API_KEY",
    "timeoutMs": 15000,
    "rankTopK": 20
  }
}
```

Operators set `CURSOR_API_KEY` in the process environment (SSE autoboot service included). They never paste the key into `config.json`. `enabled` stays false until the operator opts in.

**Hybrid/remote:** refine runs on the node that wrote the record (local or daemon). Remote-mode stdio proxy does not run a second agent on the laptop.

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool | Surface stays 11; AI is a backend of upsert/search/bootstrap |
| Mutating trap/decision `body` with the LLM | SoT and anti-regression wording stay human/agent authored |
| Neural embedding service / vector DB | Existing TF cosine stays; Cursor SDK is not an embed API |
| `get` LLM expansion or related-record synthesis | `get` remains id lookup |
| Required Cursor/cloud account | `ai.enabled` default false; vault works offline |
| Agent filesystem tools on vault or product `cwd` | Prevents silent vault mutation |
| Replacing FTS as the only search path | Lexical index remains candidate source |
| Wiki regenerate reuse for vault records | Wiki polish is a different document and callback |
| Multi-provider marketplace (OpenAI, Anthropic raw HTTP) | First adapter is Cursor SDK only |
| Changing hybrid/vault-git commit semantics beyond lock-wrapped sidecar writes | Sidecar is another vault mutation; use existing `commitVaultChange` |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| First-delivery packaging | One spec covering contract, Cursor adapter, refine queue, rank, status | Owner selected full vision for the spec of record; implementation may still land in ordered PRs | y (owner) |
| Retrieval aids storage | Sidecar/frontmatter, not body rewrite | Preserves trap DO NOT/INSTEAD DO | n (recommended) |
| Semantic retrieve | LLM rerank of FTS top-K, not a new vector store | Matches Cursor SDK (prompt, not embeddings) | n (recommended) |
| `get` | No AI | Id lookup is already exact | n (recommended) |
| Auth | Env var named by `ai.apiKeyEnv` (default `CURSOR_API_KEY`); dedicated `ai` section; `enabled` default false; `model` default `composer-2.5` | Operator opt-in; secret stays out of config and product git | y |
| Implicit dims not otherwise ACd | N/A because input bounds (`rankTopK`, timeout), failure/timeout, idempotent hash skip, concurrency (queue+lock), observability (doctor/activity), and external-dep fail-open are ACs; rate limits beyond maxConcurrent=1 are not specified | Collapse remainder | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Interface + Cursor adapter + refine queue + post-FTS rank + doctor/status; no 12th tool; no body rewrite | Spec ACs 1–35 vs diff |
| Atomic criteria | Each AC has pass/fail in tests or doctor JSON | `validate_spec` authoring + planned test names in AC33 |
| Failure modes | Timeout, bad JSON, missing key, unknown provider | Negative scenarios below |
| Stack invariants | No unchecked `any`; no floating promises; Zod on `config.ai`; path containment (no vault cwd tools); close SDK resources in `finally` if the SDK opens handles | `typescript-node` checklist; `npm run build` |
| Secrets | Key never logged; redaction before prompt | AC9, AC31 |
| Observation | doctor `ai`, activity events | AC28–AC30 |
| Open blockers | `@cursor/sdk` public beta; adapter isolated so tests mock prompt | Documented; tests do not require network |
| Conflict with 0055 | Rank runs after lexical/intent lens | AC21 Notes |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo doctor --json` → `.ai.enabled`, `.ai.available`, `.ai.queueDepth`, `.ai.lastError`
- Activity: `ai.refine.ok` / `ai.refine.fail` / `ai.rank.ok` / `ai.rank.fail` with `durationMs`
- `upsert` latency remains comparable to pre-AI (no await of `Agent.prompt`)
- `search` `explain.aiRank` is `applied` or `skipped` when `explain: true`
- `npm test` (full suite) and `npm run build`

### Negative & Failing Test Scenarios

- `ai` omitted or `enabled: false`: Noop path; no `@cursor/sdk` network; upsert/search match pre-AI fixtures
- Missing `CURSOR_API_KEY` with `enabled: true` and `provider: cursor-sdk`: upsert succeeds, no sidecar, `isAvailable` false
- Agent throw / timeout during refine: original body unchanged, `ai.refine.fail` emitted
- Agent returns non-JSON: no sidecar write
- Unknown `ai.provider`: config/startup fail closed (Zod)
- Rank throw: search returns lexical order, tool `ok`
- Unauthenticated / invalid key: fail-open on read/write tools (no MCP error for optional AI)
- Fake agent attempting `cwd` equal to vaultRoot in prompt options: adapter test fails (must omit)
- Sync-over-async: test that upsert Promise resolves before fake slow `refineForSearch` (delay 50ms) completes
