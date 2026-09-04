---
name: ws-session-tracking
version: 0.18.0
description: >-
  Session-level deliverable and prompt intent tracking engine. Automatically correlates turn-level
  prompt instructions with git commits, PR deliverables, and task lifecycle boundaries.
invocation_names:
  - ws-session-tracking
  - session-tracking
  - prompt-tracking
---

# ws-session-tracking

> When this skill is loaded, output "ws-session-tracking loaded."

**Runtime skill** shipped by [spec-memo](https://github.com/jpolvora/spec-memo). Guides agents to track session lifecycles, ingest prompt turns, correlate deliverables (PRs, commits, specs), derive anti-regression rules, and generate timesheet/invoicing reports.

---

## 🎯 Core Objectives

1. **Prompt Ingestion & Context Correlation**: Ingest prompt turn history with rich metadata (`ide`, `model`, `agent`, `sessionId`, `turn`, `taskSlug`, `client`, `billable`, `branch`, `gitSha`, `linkedPaths`).
2. **Session Lifecycle Tracking**: Demarcate task boundaries with `session_start` at intake and `session_end` at completion with deliverables.
3. **Intent Stories Export**: Compile turn-level conversational prompts into cohesive Markdown narratives for PR bodies and audit logs.
4. **AI Rule Derivation**: Discover recurring user constraints and operational rules from prompt history and persist them as anti-regression traps.
5. **Activity & Invoicing Reports**: Compute billable hours, session counts, and deliverable summaries aggregated by client and project.

**Memory hit de-dupe:** When consulting the vault during a tracked session, pass the same `sessionId` to `bootstrap` / `search` (`hitIds`) / `get` so retrieval hits increment at most once per record per session. Bare `search` without `hitIds` does not count as a hit.

---

## 🤝 Complementary Architecture: ws-session-tracking vs. ws-memo

`spec-memo` separates memory into two distinct, highly complementary runtime engines:

| Dimension | `ws-session-tracking` (This Skill) | `ws-memo` (Companion Skill) |
|---|---|---|
| **Domain Focus** | **Execution Continuity** (What the agent did) | **Knowledge Continuity** (What the codebase learned) |
| **Primary Records** | `prompt`, `session`, `log` | `trap`, `decision`, `spec`, `plan`, `review`, `scratch` |
| **Tool Surface** | `prompt` (`record`, `session_start`, `session_end`, `activity_report`, `derive_rules`, `export_story`) | `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote` |
| **Lifecycle Touchpoint** | Ingests prompts, correlates PR/git deliverables, manages task handoffs | Injects traps & architecture decisions into brief, validates git boundaries |

---

## 🔍 Hook Detection & Execution Continuity Protocol

Agents must detect the host operating mode at session start and adapt their tracking behavior:

### 1. Detection Check
Inspect if harness lifecycle hooks are active in the environment:
- **Antigravity:** `.agents/hooks.json` or `~/.gemini/config/hooks.json` defines `spec-memo` hooks.
- **OpenCode:** `.opencode/plugins/spec-memo.js` or `~/.config/opencode/plugins/spec-memo.js` exists.
- **Cursor:** `.cursor/rules/spec-memo.mdc` or `.cursor/hooks.json` exists.
- **Claude Code:** `.claude/hooks/` or `~/.claude/config.json` configured.
- *Or prompt context:* If an `## Active Session Handoff` or session brief was already pre-injected into initial context, hooks are active.

### 2. Adaptive Tracking Behavior

- **Hook-Automated Mode (Hooks Installed):**
  - Harness hooks silently intercept raw prompt turns, compaction events, and process boundaries out-of-band.
  - The agent's responsibility shifts entirely to **high-value tactical synthesis**:
    1. **Session Start:** Read and address the pre-injected handoff baton (`failedApproaches`, `nextSteps`, `openQuestions`).
    2. **Session Completion:** Proactively invoke `prompt` `action: 'session_end'` (or `memo session end`) with structured `deliverables` (PR URLs, commit SHAs) and pass forward tactical handoffs for the next agent.
- **Skill-Only Mode (Hooks Not Installed — Default):**
  - The agent takes **explicit responsibility** for session lifecycle management:
    1. **Session Start:** Proactively call `prompt` `action: 'session_start'` at task intake with `--task-slug` and `--client`.
    2. **Turn Recording:** Call `prompt` `action: 'record'` on substantive user requirements and pivotal architectural shifts.
    3. **Session Completion:** Call `prompt` `action: 'session_end'` with deliverables upon task completion.
  - Skill-only mode is 100% first-class; never fail, warn, or halt because hooks are absent.

---

## 🛠️ Tool & CLI Usage

Agents should use the 11th MCP tool `prompt` or the CLI commands `memo prompt`, `memo session`, and `memo activity`.

### 1. Ingest Prompt Turn

```json
{
  "action": "record",
  "body": "Add support for OAuth2 token refresh with automated retry and backoff.",
  "sessionId": "session-1740000000-a1b2",
  "turn": 1,
  "taskSlug": "feature-oauth-refresh",
  "client": "acme-corp",
  "billable": true,
  "ide": "cursor",
  "model": "claude-3-7-sonnet"
}
```

**CLI Equivalent:**
```bash
memo prompt record --session-id session-1740000000-a1b2 --turn 1 --task-slug feature-oauth-refresh --client acme-corp --body "Add support for OAuth2 token refresh..."
```

---

### 2. Demarcate Session Lifecycle

**Start Session:**
```bash
memo session start session-1740000000-a1b2 --task-slug feature-oauth-refresh --client acme-corp
```

**End Session with Deliverables:**

When `vaultGit.enabled` (batched) or `mode: hybrid`, a successful `session_end` also triggers dual sync flush (hybrid HTTP + vault-git in parallel when both are enabled). Sync errors are fail-open and logged; the session payload still returns success.

```json
{
  "action": "session_end",
  "sessionId": "session-1740000000-a1b2",
  "summary": "Implemented OAuth2 token refresh with exponential backoff and comprehensive test coverage.",
  "deliverables": [
    { "type": "pr", "url": "https://github.com/org/repo/pull/42", "title": "feat(auth): token refresh" },
    { "type": "commit", "sha": "a1b2c3d4e5f6", "title": "feat(auth): implement token refresher" }
  ]
}
```

**CLI Equivalent:**
```bash
memo session end session-1740000000-a1b2 --summary "Implemented OAuth2 token refresh" --deliverables '[{"type":"pr","url":"https://github.com/org/repo/pull/42"}]'
```

---

### 3. Export Session Story (Markdown Narrative)

```bash
# Output must be outside the product tree (assertNotInProductRoot). Or omit --output and use stdout/JSON.
memo prompt export-story session-1740000000-a1b2 --output /tmp/oauth-refresh-story.md
# Status monitor: GET /api/prompts/sessions/:id/export?project=<projectId>
```

---

### 4. Derive AI Rules & Anti-Regression Traps

```bash
memo prompt derive-rules --session-id session-1740000000-a1b2 --save-traps
```

---

### 5. Generate Timesheet & Invoicing Activity Report

```bash
memo activity --client acme-corp --since 2026-08-01
```
