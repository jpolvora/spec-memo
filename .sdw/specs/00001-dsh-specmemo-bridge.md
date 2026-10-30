---
id: null
slug: 00001-dsh-specmemo-bridge
title: "DSH spec-memo memory bridge plugin"
source: local
status: draft
specDate: 2026-10-30
---

# Specification — DSH spec-memo memory bridge plugin

## Description

DeepSeek Harness (DSH) stores every session as an event-sourced log and exposes host extension points through Cordis plugins. spec-memo stores agent working memory in a local vault and exposes it through the `memo` CLI and MCP tools. Today the two systems are unaware of each other: DSH sessions leave no trace in the vault, and vault memory is never bound to DSH session identity.

This feature is an out-of-tree DSH plugin, `dsh-plugin-specmemo`, that subscribes to DSH session and tool events and translates them into `memo` CLI invocations through `ctx.subprocess`. It ships as one Cordis row installed with the DSH plugin manager, carries no GUI surface in v1, and never modifies a shipped `@deepseek-ai/dsh-*` package.

In scope:

- The event-to-command mapping: session created, user message, tool result, session flush, session disposed.
- A bounded, serialized, fail-open command runner with per-invocation timeouts.
- A Schemastery configuration schema with per-event toggles.
- Install and uninstall through the standard plugin bundle patch.
- A read-only status tool plus diagnostics.

Boundaries:

- The vault stays the single source of truth for memory; DSH stays the single source of truth for sessions.
- The plugin uses public `memo` commands only and never reads or writes vault files directly.
- All side effects run out of process; no agent turn waits on the vault.

### Design Intent

Keep the bridge thin, ordered, and observable: DSH events in, `memo` commands out. The plugin is a transducer, not a second memory store, so it owns no durable state beyond counters. Fail-open is deliberate: a slow or missing vault must never add latency or errors to an agent turn, and the session transcript remains recoverable from the vault after the fact. A declarative patch keeps install and uninstall additive and reversible.

## Acceptance Criteria

- AC1: The plugin shall ship as an out-of-tree Cordis bundle that inserts exactly one host row into the DSH profile.
- AC2: When a DSH session is created, the plugin shall invoke `memo bootstrap` for the session working directory before invoking `memo prompt session_start`.
- AC3: When a `user/message` event is appended to a session, the plugin shall invoke `memo prompt record` with the message text.
- AC4: When a DSH session is disposed, the plugin shall invoke `memo prompt session_end` followed by `memo sync`.
- AC5: When the `session/flush` event fires, the plugin shall invoke a debounced `memo sync`.
- AC6: The plugin shall bound every memo invocation with a configurable timeout.
- AC7: If a memo invocation times out, then the plugin shall terminate the child process.
- AC8: If a memo invocation fails, then the plugin shall record a diagnostic without failing the agent turn.
- AC9: The plugin shall serialize memo invocations per session in session-event order.
- AC10: Where an event toggle is disabled, the plugin shall skip that event's memo invocation.
- AC11: If the memo executable is missing, then the plugin shall disable the bridge with a diagnostic.
- AC12: The plugin shall expose a read-only status tool reporting queue depth, counters, and the last error.
- AC13: The plugin shall omit prompt bodies and secret-shaped values from harness log entries.
- AC14: When the plugin is uninstalled, the plugin shall leave the vault contents unchanged.
- AC15: Where tool auditing is enabled, the plugin shall append each tool result to the vault with `memo append`.

## Notes

Event mapping:

| DSH signal | Plugin action | Semantics |
|---|---|---|
| `session/created` | `memo bootstrap --cwd <cwd>`, then `memo prompt session_start --session-id dsh:<id>` | Once per live session |
| `user/message` (session event) | `memo prompt record --session-id dsh:<id> --body <text>` | Each accepted user message |
| `tool/result` (session event) | `memo append --event <tool-name> ...` | Only when `events.toolAudit` is true |
| `session/flush` | Debounced `memo sync` | Trailing edge after `debounceMs` |
| `session/disposed` | `memo prompt session_end --session-id dsh:<id>`, then `memo sync` | Once per session |

Configuration (Schemastery, persisted in the plugin row config):

```json
{
  "enabled": true,
  "memoCommand": ["memo"],
  "vaultRoot": null,
  "timeoutMs": 2000,
  "debounceMs": 1500,
  "queueLimit": 64,
  "events": {
    "bootstrap": true,
    "promptRecord": true,
    "toolAudit": false,
    "syncOnFlush": true,
    "sessionEnd": true
  }
}
```

- Session identity: memory records use `dsh:<dshSessionId>` as `--session-id`; `--cwd` comes from `session.header.cwd` so memo resolves the project identity from the git remote.
- Executable discovery order: `memoCommand` config, `SPEC_MEMO_MEMO` env, `memo` on `PATH`, then `node <vaultRoot>/dist/cli.js` when `vaultRoot` is configured. Windows `.cmd` shims are handled by the subprocess layer.
- Injection: `static inject = ['subprocess', 'sessions']`; optional services are read through `ctx.get(name)`.
- Concurrency: one FIFO queue per DSH session; overflow drops the oldest entry and increments `queue_overflow`.
- Retries: none in v1; `session_start`, `session_end`, and `prompt record` are safe to re-run because memo soft-skips duplicate session transitions.
- The bootstrap result is stored as plugin state for diagnostics only; it is not injected into the model context in v1.
- Package layout: `package.json` with `dsh.bundle.patch`, `cordis.patch.yml`, `packages/bridge/src`, committed `lib/`, and node:test suites.

## Out of Scope

| Feature | Reason |
|---|---|
| GUI panel or settings page | Host-only bridge in v1; configuration is file-based |
| Injecting the bootstrap brief into the model context | One-way persistence in v1; context injection requires prompt-assembly work |
| MCP or SSE transport | The `memo` CLI already covers local, hybrid, and remote deployments |
| Modifying a shipped DSH package | The bundle is additive and removable by design |
| Vault schema or record lifecycle changes | Owned by spec-memo, not by the bridge |
| Other harness integrations | Existing `memo install-hooks` hosts already cover them |
| Sync conflict resolution | `memo sync` and `memo reconcile` own that behaviour |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Transport | `memo` CLI through `ctx.subprocess` | Works in every deployment mode without MCP client wiring | No |
| Session identity | `dsh:<sessionId>` prefix | Avoids collisions with other hosts writing to the same vault | No |
| Default enablement | Enabled once the plugin row is installed | Installing the plugin is the opt-in signal | No |
| Tool auditing | Disabled by default | Tool results are noisy; users opt in per profile | No |
| Bootstrap usage | Read-only in v1 | Keeps the first release one-way and deterministic | No |
| Timeout budget | 2000 ms per invocation | Matches existing hook budgets and keeps turns snappy | No |
| Deliverables capture | Prompt text captured at session end | DSH exposes no stable deliverable list to a host plugin in v1 | No |
| Vault root | `SPEC_MEMO_ROOT` or the memo default | Reuses the CLI resolution instead of inventing a second one | No |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Plugin bundle | `dsh-plugin-specmemo` with `cordis.patch.yml` and `dsh.bundle.patch` | Install in a scratch profile and confirm one row |
| Event wiring | Listeners for session created, disposed, flush, session events, and tool results | Fake Cordis context probe that emits each event |
| Command runner | `ctx.subprocess.spawn` wrapper with timeout and kill | Unit test against a stalled child process |
| Configuration schema | Schemastery schema with defaults and per-event toggles | Invalid config rejected; defaults resolve |
| Redaction | No prompt body or secret value in logs | Log-capture test with a token-shaped body |
| Vault fixture | Temporary `SPEC_MEMO_ROOT` plus a stub `memo` binary | Integration test asserts argv, env, and invocation order |
| Documentation | Install, configuration, event map, uninstall | README review and a fresh-profile walkthrough |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Per-session counters: `bootstrap`, `session_start`, `prompt_record`, `tool_audit`, `sync`, `session_end`, `failures`, `timeouts`, `queue_overflow`.
- Structured lines prefixed `[specmemo-bridge]` with command name, session id, duration, and exit code.
- Status tool payload: `{ enabled, queueDepth, counters, lastError, lastInvocationAt }`.
- Vault-side evidence: `memo prompt list --session-id dsh:<id>` lists the ingested turns after a DSH session.

### Negative & Failing Test Scenarios

- Missing `memo` executable: the bridge disables itself, logs one diagnostic, and the agent turn completes unchanged.
- Non-zero exit from `memo prompt record`: the failure counter increments and no exception escapes the listener.
- Stalled child process: the timeout fires, the child is killed, and the next queued invocation still runs.
- Disabled event toggle: no subprocess is spawned for that event.
- Duplicate `session/created`: exactly one `session_start` invocation is made.
- Uninstall: the profile loses the plugin row and the vault keeps every record.
