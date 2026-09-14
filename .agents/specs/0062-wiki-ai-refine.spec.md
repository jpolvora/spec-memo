---
id: null
slug: wiki-ai-refine
title: "AI-assisted wiki refine from latest project knowledge snapshot"
source: local
specDate: 2026-09-13
---

# Specification — AI-assisted wiki refine from latest project knowledge snapshot

## Description

When the vault **AI assistant** is enabled (`config.json` `ai.enabled: true` and the injected `VaultAiAgent` is available), wiki regenerate must polish `projects/{projectId}/WIKI.md` from a **fresh knowledge snapshot** of that project’s vault entries, not from a stale on-disk wiki or from record bodies mutated by the LLM.

Today (`0046-project-wiki`): regenerate always collects sources, fills `src/wiki/template.md`, and optionally calls injected `polishWikiMarkdown(deterministicMarkdown)` when `wiki.aiEnabled` or `SPEC_MEMO_WIKI_AI=1`. The polish callback receives only the filled template string. Vault AI (`0056-vault-ai-assistance`) refines **individual** eligible records (`trap` / `decision` / `spec` / `plan`) into retrieval aids; it does **not** drive wiki polish. Operators who turn on the assistant therefore get search-side refine/rank without a wiki pass grounded in the same project snapshot.

This slice (v1 draft; owner will refine later) adds:

1. **Gate:** wiki AI refine runs on the existing on-demand regenerate path (status `POST /api/wiki/regenerate`, CLI `memo wiki --regenerate`) when the vault AI assistant is enabled and available. Deterministic collect → template fill still always runs first (`0046` AC3 / AC11 preserved).
2. **Snapshot:** polish input includes a bounded, sanitized serialization of `collectWikiSources(projectId)` (counts, titles/ids/kinds for active eligible records, compiled-view relative links). The snapshot is taken in the same regenerate call (latest entries), not a previously persisted `WIKI.md`.
3. **Adapter:** default production polish uses the same `VaultAiAgent` construction choke point as `0056` / `0057` (must be wired in runtime, not tests-only — trap `ai-ops-journal-decorator-unwired`). Prefer extending the agent with an optional wiki-polish method **or** a dedicated `polishWikiMarkdown` bound to `Agent.prompt` with the snapshot + deterministic markdown. Tests keep DI (`RegenerateWikiOptions.polishWikiMarkdown` or an explicit agent).
4. **Fail-open:** timeout, throw, empty model output, IO_GUARD refuse, or missing key → persist deterministic `WIKI.md`, `ok: true`, `aiPolished: false`, short sanitized `aiError`. Never leave `WIKI.md` half-written.
5. **Safety:** redact snapshot + prompts before the SDK; scan model output before persist; no product-git writes; no 12th MCP tool; no increment of record `hits`/`occurrences`.

Language: en-us. Markdown `WIKI.md` remains vault-side. Product `README.md` is never the target.

Product gray areas (gate vs legacy `wiki.aiEnabled`, optional polish method vs callback-only) are recorded in [`0062-wiki-ai-refine.context.md`](0062-wiki-ai-refine.context.md). Defaults below are implementation-ready until the owner revises this spec.

## Acceptance Criteria

- AC1: `regenerateWiki` for a known `projectId` still writes UTF-8 `projects/{projectId}/WIKI.md` and does not write under the consumer product git tree (preserves `0046` AC1).
- AC2: When `ai.enabled` is false or omitted and `wiki.aiEnabled` is not true, regenerate persists the deterministic template fill and `aiPolished` is `false` (no LLM call).
- AC3: When `ai.enabled` is true and `VaultAiAgent.isAvailable()` is true, a regenerate call collects `collectWikiSources` **in that same invocation** and passes a snapshot derived from those sources into the polish path (the polish function must not be invoked with only a previously saved `WIKI.md` and no snapshot).
- AC4: The snapshot includes at least `projectId`, inventory counts by kind, and a list of active record `{ id, kind, title }` for kinds already used by the wiki collector (traps, decisions, specs, plans, and session/prompt summaries as collected today). It omits `*.conflict.*` sidecars (preserves `0046` AC23).
- AC5: Snapshot text sent to the model is passed through existing secret redaction (`sanitizeToolOutput` / `inspectAgentIo` as used on other AI prompts). Redaction or IO_GUARD failure skips polish (fail-open, deterministic page kept).
- AC6: Model output used as `WIKI.md` body is scanned the same way as vault-ai refine completions; schema-invalid, empty, or refuse output does not replace the deterministic page.
- AC7: Polish timeout uses `config.ai.timeoutMs` when the assistant path is used (default 15000), otherwise existing `wiki.timeoutMs` for the legacy injected-callback path; timeout persists deterministic markdown, `aiPolished: false`, `aiError` set, `ok: true`.
- AC8: Unhandled polish Promise rejection is forbidden: regenerate `await`s polish inside try/catch (or equivalent); `memo serve` must not crash.
- AC9: `POST /api/wiki/regenerate` and `memo wiki --regenerate` use the same collect-snapshot-polish-persist path; JSON still matches `0046` AC8 shape (`ok`, `projectId`, `lastGenerated`, `aiPolished`, optional `aiError`) with no absolute vault paths.
- AC10: `TOOL_NAMES.length` remains 11; no MCP tool named `wiki` or `refine` is added.
- AC11: Regenerating with AI polish does not increment source record `hits` or `occurrences`.
- AC12: GET wiki routes remain read-only (no snapshot LLM call, no `ensureVaultStructure`).
- AC13: When `ai.enabled` is true but `isAvailable()` is false (missing `CURSOR_API_KEY`), regenerate behaves as Noop polish: deterministic persist, `aiPolished: false`, optional `aiError` such as unavailable; no throw to HTTP/CLI.
- AC14: Production wiki polish is constructed from the same agent resolver used at process start (`resolveVaultAiAgent` or successor). A test or grep-backed assertion must fail if wiki polish is only wired from `*.test.ts`.
- AC15: Activity / AI ops journal: a successful or failed wiki polish emits an ops/activity event distinct from per-record `ai.refine.*` (for example `ai.wiki.ok` / `ai.wiki.fail`) with `projectId` and `durationMs`, no prompt bodies, no secrets.
- AC16: Heading order of the shipped `template.md` sections remains after polish, or polish instructions require preserving `h2` slugs used by `GET /api/wiki/section` (CRLF-safe split `/\r?\n/` — traps `wiki-h2-split-crlf`, `wiki-markdown-crlf-headings`). A unit test with a stub polish that drops an `h2` either restores deterministic markdown or is documented as fail-closed to deterministic.
- AC17: Tests cover: assistant off → no polish; assistant on + fake agent receives snapshot containing a known trap id/title; polish throw → file equals deterministic; IO_GUARD-style refuse → deterministic; unauthorized status POST still 401.
- AC18: `npm run build` and `npm test` stay green; live Cursor network tests are not required.

## Original Issue Context

Standalone `/ws-spec-write` (2026-09-13): add a new feature with AI assistant enabled: run wiki refinements based on latest knowledge snapshot of entries in project — spec will be refined later.

### Prior Work Sweep

- `0046-project-wiki` / `src/wiki.ts`: collect → `renderWikiMarkdown` → optional `polishWikiMarkdown(deterministic)` gated by `wiki.aiEnabled` / `SPEC_MEMO_WIKI_AI`. Status Wiki tab + CLI. No snapshot object in the polish signature today.
- `0056-vault-ai-assistance`: `VaultAiAgent.refineForSearch` / `rankCandidates`; eligible kinds trap/decision/spec/plan; `ai.enabled` default false; explicitly out of scope “Wiki regenerate reuse for vault records”.
- `0057-status-ai-ops-logs`: journal decorator must be wired at `resolveVaultAiAgent` (trap `ai-ops-journal-decorator-unwired`).
- Git: `fda8065` wiki feature; `19ca4cd` vault-ai. No open PR titled wiki-ai-refine / wiki snapshot polish at authoring time (`providers.scm=github`).
- Duplicate risk: medium vs `wiki.aiEnabled` polish — this spec **extends** that path to assistant-gated snapshot polish rather than adding a second wiki file.

### Design Intent

Modification of `regenerateWiki` / polish injection, not a new wiki store. `git log` on `src/wiki.ts` shows polish was intentionally optional, fail-open, and **not** tied to vault `ai.enabled`. The gap is accidental relative to the owner’s new intent (assistant on → wiki refine from latest entries), not an intentional permanent split. Preserve: deterministic first page, fail-open, 11 tools, vault-only `WIKI.md`, no hits bump, CRLF-safe h2 parse.

## Notes

- Snapshot size: cap serialized snapshot (suggested default 32 KiB UTF-8, configurable later). Truncate oldest or lowest-priority kinds first; always keep counts.
- Do not send full trap bodies by default in v1 (titles + ids + counts); owner may later allow body excerpts in a spec revision.
- Hybrid/remote: polish runs on the node that executes regenerate (daemon for SSE status; local CLI for `memo wiki --regenerate`).
- Legacy `wiki.aiEnabled` + injected callback remains for unit tests that do not construct `CursorSdkVaultAiAgent`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-regenerate on every upsert | `0046` deferred; snapshot polish stays on-demand |
| 12th MCP wiki tool | Surface stays 11 |
| LLM overwrite of trap/decision `body` | Vault SoT; wiki only |
| Product README / docs site `docs/wiki` | Different wiki (feature docs), not vault `WIKI.md` |
| Custom per-project template override | Deferred in `0046` context |
| Multi-provider (OpenAI HTTP) | First adapter remains Cursor SDK |
| Regenerating all projects in one call | Still requires a specific `projectId` |
| Changing canvas `:3125` | Unrelated |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Master gate is vault `ai.enabled` + `isAvailable()` | Yes | Owner asked for assistant-enabled wiki refine | n |
| Trigger is existing regenerate only | Yes | Smallest change; owner will refine later | n |
| Snapshot is titles/ids/counts, not full bodies | Yes | Token/safety bound; refine later if needed | n |
| Auth, i18n, TTL, rate limits, concurrency beyond single regenerate | N/A because regenerate is already single-project, token-auth status, en-us, no wiki TTL | Existing 0046/status contracts | y |
| Idempotent retry | Same `projectId` regenerate is safe to repeat | Snapshot is recomputed each call | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | On-demand wiki polish from snapshot when assistant enabled; no MCP/schema explosion | This spec ACs 1–18 vs Out of Scope table |
| Atomic criteria | Each AC is pass/fail in `src/wiki.test.ts` / `src/status.test.ts` / `src/cli.test.ts` | Authoring validate + later orch tests |
| Failure modes | Timeout, unavailable key, IO_GUARD, bad model output, missing polish wiring | AC5–AC8, AC13–AC14 |
| Observation | `aiPolished`, `aiError`, activity `ai.wiki.*`, AI ops journal | AC9, AC15 |
| Stack invariants | No unchecked `any` on snapshot types; await polish; validate HTTP body; path containment on `projectId`; no floating promises | `npx tsc --noEmit`; `npm test` |
| Open blockers | Owner may revise snapshot richness and gate vs `wiki.aiEnabled` | Tracked in context.md; not a code blocker for a first implementation of the defaults |
| Zero secrets in logs | Key stays in env; prompts redacted | AC5, AC15 |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `POST /api/wiki/regenerate` JSON: `aiPolished`, optional `aiError`.
- CLI `memo wiki --regenerate --json` same fields.
- Activity / AI ops: `ai.wiki.ok` / `ai.wiki.fail` (names may be adjusted in implementation if they collide; tests lock the chosen names).
- `memo doctor --json` existing `ai` object unchanged except optional lastError from wiki polish fail-open.

### Negative & Failing Test Scenarios

- Assistant enabled, fake polish throws: `WIKI.md` equals deterministic template output; `aiPolished === false`.
- Assistant enabled, snapshot contains a planted secret-like token: polish is skipped or token does not appear in activity payload (redaction).
- `ai.enabled` true, empty API key: no SDK call, deterministic persist, HTTP 200.
- Unauthenticated `POST /api/wiki/regenerate` with token configured: 401, no wiki write.
- Stub polish that returns markdown missing required `h2` slugs: persist falls back to deterministic (fail-open to template).
- Stack: unauthenticated status write rejected; regenerate does not `exec` unsanitized `projectId` into a shell.
