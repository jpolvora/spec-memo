---
id: 69
slug: ai-ops-test-ai-button
title: 'AI Ops "Test AI" connectivity probe'
source: github
specDate: 2026-09-14
issueState: closed
labels:
---

# Specification — AI Ops "Test AI" connectivity probe

## Description

The status monitor **AI Ops** tab (`data-tab="tab-ai-ops"`) lists durable journal rows for AI `refine`/`rank` settlements but offers no way to verify that the configured provider/model can actually answer. This slice adds a **Test AI** connectivity button and its backing endpoint so operators can probe the live agent on demand and read the result as a first-class journal row.

Workstreams:

1. **Operation vocabulary.** Extend the AI Ops journal operation union and list-query validator with `test` so probe rows parse, list, and filter alongside `refine`/`rank`.
2. **Status monitor UI.** Add a **Test AI** button (`#btn-aiops-test`) left of Refresh and an `operation` filter option `test`; on click POST the probe, disable the button with a `Testing…` label, reload the list, and restore the button in `finally`.
3. **REST endpoint.** `POST /api/ai-ops/test` runs a `hello` refine probe through the configured provider/model using a **raw, unjournaled** agent (so the journal decorator does not emit a duplicate `refine` row), force-logs the `test` settlement even when AI is disabled (`opsLogEnabled: true` override), and returns a sanitized summary.

Language: en-us. No 12th MCP tool. Do not rewrite the AI Ops journal schema; only add the `test` operation.

## Acceptance Criteria

- AC1: `AiOpsOperation` includes `'test'`; `AiOpsListQuerySchema` accepts `operation=test`; `parseAiOpsLine` returns rows whose `operation` is `test`.
- AC2: `generateStatusHtml` contains `id="btn-aiops-test"`, an `<option value="test">test</option>`, and places the button left of `id="btn-aiops-refresh"`.
- AC3: `POST /api/ai-ops/test` requires the same `/api/*` auth as the read endpoints (401 unauthenticated).
- AC4: With AI enabled and a key present, the probe calls `refineForSearch({ id: 'hello', kind: 'trap', title: 'hello', body: 'hello', tags: [], pathPatterns: [] })` against the configured provider/model and journals `operation: 'test'`, `recordId: 'hello'`, `input: { message: 'hello' }`, `metadata: { provider, model, test: 'connectivity' }`.
- AC5: On success the journal `output` carries `{ response }` (response ≤ 2000 chars, whitespace collapsed); on failure the row carries `error` (≤ 500 chars) and the response payload returns that `error`.
- AC6: The probe uses a raw `NoopVaultAiAgent` / `CursorSdkVaultAiAgent` (never the `withAiOpsJournal`-wrapped `resolveVaultAiAgent`) so exactly one `test` row is written and no duplicate `refine` row appears.
- AC7: The `test` row is force-logged (`opsLogEnabled: true` override) even when `ai.enabled` is `false`, and appears in `GET /api/ai-ops?operation=test`.
- AC8: The endpoint returns `{ ok, entryId, operation: 'test', recordId: 'hello', provider, model, response?, error?, durationMs }`, sanitized via `sanitizeToolOutput`.
- AC9: CLI/MCP tool surface stays at 11 (`TOOL_NAMES.length === 11`).
- AC10: `npm run build` and `npm test` stay green; HTML/IA check `aiopsOperationSelect` still lists refine/rank/test.

## Original Issue Context

- Title: pec: AI Ops "Test AI" connectivity button
- URL: https://github.com/jpolvora/spec-memo/issues/69
- Labels: none

```
Add a Test AI button to the status monitor AI Ops view (tab-ai-ops), next to Refresh. On click it sends a hello probe through the configured AI provider/model and journals the result as a test/hello row.
```

## Notes

- Primary files: `src/ai/ops-log.ts`, `src/status.ts`, `src/ai-ops.test.ts`.
- Build the probe agent from `readVaultConfig(vaultRoot)` / `resolveAiConfig`; do not use `resolveVaultAiAgent` (journal-wrapped).
- Handler exceptions log to `error.logs` under subsystem `status-server` with endpoint `/api/ai-ops/test`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| New MCP tools or AI Ops write APIs beyond the status POST | 11-tool surface frozen |
| Network live-provider integration tests | Deterministic fixtures probe the disabled/missing-key paths |
| Rewriting the `refine`/`rank` journal schema or UI | Already shipped; this slice only adds `test` |
