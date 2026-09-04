---
id: null
slug: session-handoff-baton
title: "Cross-Agent Session Handoff Baton via Prompt and Bootstrap"
source: local
specDate: 2026-09-04
---

# Specification — Cross-Agent Session Handoff Baton via Prompt and Bootstrap

## Description

Enable seamless, zero-ceremony task handoffs between different coding agent CLIs (Claude Code, OpenAI Codex, Antigravity, Cursor, OpenCode) operating in the same repository. When an agent concludes an interactive turn or completes a task slice via `prompt` `action: 'session_end'`, it records a structured handoff payload (active objective, next steps, failed dead-ends, open questions). On subsequent agent startup in the same repository via `bootstrap` or `prompt` `action: 'session_start'`, `spec-memo` injects the pending handoff baton into the brief and marks it claimed/delivered exactly once, eliminating repetitive tactical re-explanation across diverse agent harnesses.

### Problem Analysis & Real-World Evidence

1. **Cross-Agent Amnesia:**
   - Developers frequently switch coding harnesses mid-task (e.g. starting architectural design in Claude Code, switching to Antigravity IDE for complex editing, and executing quick fixes via Cursor or Codex).
   - While `spec-memo` successfully persists static domain traps and architectural decisions, the immediate tactical continuity—what approach failed 5 minutes ago, what remaining tests need fixing, and what open question was left unanswered—is lost at session boundary.
2. **Current `session_end` Limitations:**
   - In `src/prompt.ts`, `session_end` records `summary` and `deliverables` (PR URLs, commit SHAs). However, these are historical retrospective records rather than forward-looking transfer batons for the incoming agent.
3. **Redundant Explanation Overhead:**
   - The user or incoming agent spends valuable initial context tokens and human prompting cycles reconstructing the exact state of work that the preceding agent already understood.

### Design Intent

Introduce a first-class, single-use **Handoff Baton** mechanism integrated into `prompt` (`session_end`, `session_start`) and `bootstrap`. The handoff is stored in the project vault, delivered with top priority in the token-budgeted brief, and automatically retired upon receipt so it never clutters future turns.

---

## Acceptance Criteria

### Handoff Ingestion at Session Close

- AC1: The `prompt` MCP tool and `memo session end` CLI accept an optional `handoff` parameter containing `nextSteps` (array of strings, required if handoff present), optional `failedApproaches` (array of strings), and optional `openQuestions` (array of strings).
- AC2: When `handoff` is provided to `session_end`, the session record stores the payload in frontmatter and atomically writes an active baton file `handoff.json` under the project vault root.
- AC3: The project vault maintains at most one active handoff baton at any time; writing a new handoff supersedes and expires any previous unclaimed handoff for that project.
- AC4: The handoff payload includes originating metadata including `sessionId`, `agent` or `ide`, timestamp, and git branch name.

### Single-Use Delivery via Bootstrap Brief

- AC5: When `bootstrap` compiles the token-budgeted session brief for a project with an active unclaimed handoff, it prepends a prominent `## 🤝 Active Session Handoff` section at the top of the brief.
- AC6: The handoff section renders originating agent/IDE, `nextSteps` list, `failedApproaches` list, and `openQuestions` list formatted for direct agent consumption.
- AC7: The handoff section byte size is accounted for within `maxBytes` (default 8 KB) and prioritized above standard traps and decisions so tactical continuity is never truncated.
- AC8: Upon delivery in `bootstrap` (or `prompt` `action: 'session_start'`), the handoff is atomically marked as claimed with timestamp and recipient session ID, removing it from subsequent `bootstrap` briefs.

### Dedicated CLI Management & Inspection

- AC9: The `memo session handoff` CLI command displays the active pending handoff for the current repository, or prints a message indicating no handoff is pending.
- AC10: Running `memo session handoff --cancel` (or `prompt` `action: 'cancel_handoff'`) permits an operator or agent to discard an unwanted handoff before it is claimed.
- AC11: CLI `memo session end --handoff-steps "Step 1,Step 2" --handoff-failed "Approach A" --handoff-questions "Question 1"` supports ergonomic shell-based handoff authoring.

### Observability & Status Monitor Integration

- AC12: The `:3124` Status Monitor dashboard displays an "Active Handoff" status badge and details drawer in the Prompts/Sessions view with a one-click dismiss button.
- AC13: Operational telemetry logs `operation: 'handoff_created'` and `operation: 'handoff_claimed'` events with session and project identifiers.

---

## Notes

- **Zero MCP Tool Count Impact:** Reuses the existing `prompt` (actions: `session_end`, `session_start`, `cancel_handoff`) and `bootstrap` tools, strictly complying with the PRD 11-tool ceiling.
- **Fail-Safe Delivery:** If the handoff file is corrupted or unparseable, `bootstrap` logs a non-fatal warning to stderr, falls open, and generates the standard brief without crashing.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Live bidirectional messaging between concurrent agents | Handoffs are asynchronous next-session transfer batons, not an inter-process IPC bus. |
| Automatic prompt interception without tool calls | Requires platform-specific IDE plugins; MCP and CLI hooks provide universal compatibility. |
| Multi-project handoff transfers | Handoffs are bound to the current project identity and repository working tree. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Single-use vs multi-turn visibility | Single-use on initial brief | Prevents stale tactical instructions from lingering across multi-hour sessions. | y |
| Concurrency conflict resolution | First bootstrap claims baton | The first agent to start working inherits the baton; subsequent concurrent agents see standard brief. | y |
| Retention of claimed handoffs | Archived in session frontmatter | Preserves audit trail and session story without keeping `handoff.json` active. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural Alignment | Integrates into `src/prompt.ts`, `src/bootstrap.ts`, and `src/types.ts` | Source code inspection and data flow verification |
| Tool Ceiling Compliance | Zero new MCP tools created; extends `prompt` and `bootstrap` | Tool schema audit |
| Single-Use Durability | Atomic write and claim transaction in project vault | Node test runner verification with concurrent reads |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo session end s1 --summary "Refactor done" --handoff-steps "Run tests,Fix styling"`: writes `handoff.json` in project vault.
- `memo session handoff`: prints the pending handoff details to stdout.
- `memo bootstrap`: brief output includes `## 🤝 Active Session Handoff` and marks `handoff.json` claimed.
- Second run of `memo bootstrap`: brief output omits the handoff section.

### Negative & Failing Test Scenarios

- Malformed handoff JSON in vault does not crash `bootstrap`; logs warning and outputs standard brief.
- Attempting to claim an already-claimed or expired handoff returns a clean no-op without error.
- Invoking `memo session handoff --cancel` when no handoff exists exits cleanly with exit code 0.
