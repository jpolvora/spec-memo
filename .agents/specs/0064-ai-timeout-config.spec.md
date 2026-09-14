---
id: 70
slug: ai-timeout-config
title: 'AI cursor-sdk timeout: configurable timeoutMs, 30s default, honored everywhere'
source: github
specDate: 2026-09-14
issueState: open
labels:
---

# Specification — AI cursor-sdk timeout: configurable timeoutMs, 30s default, honored everywhere

## Description

The AI connectivity probe (`POST /api/ai-ops/test`, issue #69) fails with `cursor refine timed out after 15000ms` while a direct SDK probe shows `Agent.prompt` resolving in ~15224ms — just over the hardcoded 15s budget, so the server-side `withTimeout` aborts a call that would otherwise succeed.

This slice makes `config.json` `ai.timeoutMs` the single source of truth: documented, configurable (1000..120000), defaulting to 30000ms, and honored by every agent/SDK call path with no hardcoded `15000` fallbacks.

Workstreams:

1. **Default to 30s.** `VAULT_AI_DEFAULT_TIMEOUT_MS` becomes `30000`; the vault default config seed (`DEFAULT_VAULT_CONFIG.ai.timeoutMs`) and README example follow.
2. **Kill hardcoded fallbacks.** `enqueueRefineJob` (`refine-queue.ts`), `rankRecordsWithAgent` (`rank.ts`), `resolveUpsertAiLimits` (`store.ts`), and `resolveToolAi` (`tools.ts`) fall back to the shared default constant instead of literal `15000`.
3. **Probe inherits config.** `POST /api/ai-ops/test` builds its raw agent from `resolveAiConfig`, so the configured `timeoutMs` applies there too.

Language: en-us. No 12th MCP tool. The `wiki.timeoutMs` polish fallback is a separate subsystem and stays untouched.

## Acceptance Criteria

- AC1: A fresh vault (no `ai` section) resolves `timeoutMs: 30000` via `resolveAiConfig` / `defaultAiConfig` / `DEFAULT_VAULT_CONFIG.ai`.
- AC2: Setting `ai.timeoutMs` (e.g. `45000`) in `config.json` changes the effective SDK timeout: the adapter timeout error reads `cursor refine|rank timed out after 45000ms` for a hanging call.
- AC3: `rg '[^0-9]15000[^0-9]' src --glob '!*.test.ts'` shows no AI-agent fallbacks (wiki polish fallback excluded by design).
- AC4: README documents `timeoutMs` default `30000`, range 1000..120000, as the single source of truth.
- AC5: `npm run build` and `npm test` stay green.

## Original Issue Context

- Title: AI cursor-sdk timeout too tight: make timeoutMs configurable, default 30s, honor everywhere
- URL: https://github.com/jpolvora/spec-memo/issues/70
- Labels: none

## Notes

- Primary files: `src/ai/config.ts`, `src/ai/refine-queue.ts`, `src/ai/rank.ts`, `src/store.ts`, `src/tools.ts`, `src/vault.ts`, `README.md`, `src/ai.test.ts`.
- `CursorSdkVaultAiAgent` already reads `this.config.timeoutMs`; the defect is the default value and the fallback literals, not the adapter plumbing.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Changing `wiki.timeoutMs` polish default | Separate subsystem with its own config key |
| Per-operation timeout overrides | One global `timeoutMs` is the requested contract |
| Live-provider network tests | Deterministic hanging-`promptFn` fixtures prove the configured value |
