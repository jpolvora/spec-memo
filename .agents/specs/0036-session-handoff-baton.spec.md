---
id: null
slug: session-handoff-baton
title: "Cross-Agent Session Handoff Baton with Owner and Branch Isolation"
source: local
specDate: 2026-09-04
---

# Specification — Cross-Agent Session Handoff Baton with Owner and Branch Isolation

## Description

Enable seamless, zero-ceremony task handoffs between different coding agent CLIs (Claude Code, OpenAI Codex, Antigravity, Cursor, OpenCode) operating in the same repository. When an agent concludes an interactive turn or completes a task slice via `prompt` `action: 'session_end'`, it records a structured handoff payload (active objective, next steps, failed dead-ends, open questions, working branch, and owner). On subsequent agent startup in the same repository via `bootstrap` or `prompt` `action: 'session_start'`, `spec-memo` matches and injects the pending handoff baton into the brief and marks it claimed/delivered exactly once. Crucially, handoff batons feature strict **owner and branch isolation by default**: an individual developer's or branch's tactical baton cannot be stolen or consumed by concurrent sessions or teammates unless explicitly marked as shared.

### Problem Analysis & Real-World Evidence

1. **Cross-Agent Amnesia:**
   - Developers frequently switch coding harnesses mid-task (e.g. starting architectural design in Claude Code, switching to Antigravity IDE for complex editing, and executing quick fixes via Cursor or Codex).
   - While `spec-memo` successfully persists static domain traps and architectural decisions, the immediate tactical continuity—what approach failed 5 minutes ago, what remaining tests need fixing, and what open question was left unanswered—is lost at session boundary.
2. **Current `session_end` Limitations:**
   - In `src/prompt.ts`, `session_end` records `summary` and `deliverables` (PR URLs, commit SHAs). However, these are historical retrospective records rather than forward-looking transfer batons for the incoming agent.
3. **The Multi-Agent / Multi-Branch Collision Pitfall:**
   - As observed in `ai-memory 2.0`, if a handoff baton is purely global per project without ownership boundaries, severe context leakage occurs:
     - When developer Alice finishes on branch `feat/auth` and leaves a handoff, developer Bob starting a new session on branch `fix/db` in a shared/hybrid vault would have Alice's tactical baton injected and consumed!
     - Even on a single workstation, running two concurrent agent sessions on different branches would cause one agent to inadvertently steal and clear the other agent's handoff baton.

### Design Intent

Introduce a first-class, single-use **Handoff Baton** mechanism with **owner and branch isolation**. The handoff is stored in the project vault, matched against the receiving session's user identity and git branch, delivered with top priority in the token-budgeted brief, and automatically retired upon receipt. A `--shared` flag allows deliberate team-wide or branch-agnostic handoffs when explicitly intended.

---

## Acceptance Criteria

### Handoff Ingestion with Ownership & Branch Binding

- AC1: The `prompt` MCP tool and `memo session end` CLI accept an optional `handoff` parameter containing `nextSteps` (array of strings, required if handoff present), optional `failedApproaches` (array of strings), optional `openQuestions` (array of strings), optional `branch` (string), and optional `shared` (boolean, default `false`).
- AC2: When `branch` is omitted from `handoff`, `spec-memo` automatically resolves the current git branch name via repository detection; when `owner` is omitted, it resolves the current git user identity or system username.
- AC3: The project vault stores active handoffs under `.sync/handoffs/` (or project vault root) partitioned by owner and branch key, ensuring personal working context never collides.
- AC4: Writing a new handoff by the same owner on the same branch supersedes and expires any previous unclaimed handoff for that owner and branch combination, while preserving handoffs on sibling branches and from teammates.
- AC5: Passing `shared: true` (or `--shared` CLI flag) marks the baton as project-wide, allowing any incoming session across any branch or teammate to inherit the handoff.
- AC6: In addition to completed handoffs, `prompt` `action: 'session_start'` and `memo session start` accept an optional `objective: string` recording the session's in-flight focus slot; this slot is bound to the owner and branch, displayed in session listings, and retired on `session_end`, ensuring personal in-progress work never leaks into teammates' briefing context.

### Targeted Single-Use Delivery via Bootstrap Brief

- AC7: When `bootstrap` compiles the session brief, it matches pending handoffs where `(handoff.shared === true || handoff.owner === currentOwner) && (!handoff.branch || handoff.branch === currentBranch)`.
- AC8: If multiple eligible handoffs exist (e.g. an owner-specific handoff and a shared project handoff), the owner-specific branch-matching handoff takes strict precedence.
- AC9: The matched handoff renders a prominent `## 🤝 Active Session Handoff` section at the top of the brief, itemizing originating harness, branch, `nextSteps`, `failedApproaches`, and `openQuestions`.
- AC10: The handoff section byte size is accounted for within `maxBytes` (default 8 KB) and prioritized above standard traps and decisions so tactical continuity is never truncated.
- AC11: Upon delivery in `bootstrap` (or `prompt` `action: 'session_start'`), the matched handoff is atomically marked as claimed (`claimed: true`, `claimedAt`, `claimedBySession`), preventing duplicate delivery in subsequent turns or accidental theft by other sessions.

### Dedicated CLI Management & Inspection

- AC12: The `memo session handoff` CLI command displays the active pending handoff matching the current repository, user, and branch, or prints a message indicating no handoff is pending.
- AC13: Running `memo session handoff --all` displays all pending handoffs across all branches and teammates for project auditability.
- AC14: Running `memo session handoff --cancel` (or `prompt` `action: 'cancel_handoff'`) discards the active handoff for the current owner and branch before it is claimed.
- AC15: CLI `memo session end --handoff-steps "Step 1,Step 2" --handoff-failed "Approach A" --handoff-questions "Question 1" [--shared]` supports ergonomic shell-based handoff authoring.

### Observability & Status Monitor Integration

- AC16: The `:3124` Status Monitor dashboard displays an "Active Handoffs" panel in the Prompts/Sessions view, grouping batons by owner, branch, and shared status with one-click dismiss affordances.
- AC17: Operational telemetry logs `operation: 'handoff_created'` and `operation: 'handoff_claimed'` events containing session, project, branch, and owner identifiers.

---

## Notes

- **Zero MCP Tool Count Impact:** Reuses existing `prompt` (actions: `session_end`, `session_start`, `cancel_handoff`) and `bootstrap` tools, strictly complying with the PRD 11-tool ceiling.
- **Fail-Safe Isolation:** If ownership resolution fails, the baton falls back to machine-local checkout identity without crashing.
- **Team Vault Protection:** Teammates pointing their agents at a central daemon cannot accidentally consume or overwrite each other's pending handoff batons.

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
| Default handoff visibility | Private to owner & branch | Prevents context collisions across teammates and multi-branch workflows. | y |
| Explicit team sharing | `shared: true` | Allows deliberate baton passing to coworkers during shift changes or PR handoffs. | y |
| Retention of claimed handoffs | Archived in session frontmatter | Preserves audit trail and session story without leaving active handoff files open. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Multi-Agent / Branch Isolation | Handoff matching validates owner, branch, and shared flags | Concurrency unit tests with simulated multi-user sessions |
| Architectural Alignment | Integrates into `src/prompt.ts`, `src/bootstrap.ts`, and `src/types.ts` | Source code inspection and data flow verification |
| Tool Ceiling Compliance | Zero new MCP tools created; extends `prompt` and `bootstrap` | Tool schema audit |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo session end s1 --handoff-steps "Fix cookie test" --branch feat/auth`: writes owner/branch-scoped handoff.
- `memo bootstrap` on `feat/auth` under same user: injects handoff and marks it claimed.
- `memo bootstrap` on `fix/db` under same user: does NOT inject the `feat/auth` handoff.
- `memo bootstrap` under different user: does NOT inject Alice's private handoff.
- `memo session end s2 --handoff-steps "Deploy staging" --shared`: injects for any user on any branch.

### Negative & Failing Test Scenarios

- Session attempting to claim a handoff owned by a different user without `shared: true` leaves the handoff untouched.
- Malformed handoff JSON in vault does not crash `bootstrap`; logs warning and outputs standard brief.
- Invoking `memo session handoff --cancel` when no handoff exists exits cleanly with exit code 0.
