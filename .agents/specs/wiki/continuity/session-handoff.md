# Cross-Agent Session Handoff Baton

## Feature Overview

A handoff baton is a single-use, forward-looking transfer record that lets one agent session pass tactical context (next steps, failed approaches, open questions) to the next session in the same repository, even across different coding harnesses. Batons are owner/branch isolated by default so concurrent sessions or teammates cannot steal each other's context; an explicit `shared` flag makes a baton project-wide.

Primary journeys:

- An agent closes a session with a handoff payload via the `prompt` MCP tool (`action: 'session_end'`, `handoff` object) or CLI `memo session end` flags.
- The baton is written as JSON under the project vault `.sync/handoffs/`.
- A later agent calls `bootstrap` (or `prompt` `action: 'session_start'`).
- The matching baton is peeked, rendered at the top of the brief as `## 🤝 Active Session Handoff`, and claimed exactly once.
- An operator manages batons with CLI `memo session handoff`, `memo session handoff --all`, and `memo session handoff --cancel`.
- An operator inspects and dismisses batons through the status monitor **Active Handoffs** panel.

Scope: this slice adds no MCP tool. It extends the existing `prompt` and `bootstrap` tools, plus CLI extras and status HTTP/UI.

## Business Rules & Logic

### Ingestion

- The `handoff` payload accepts `nextSteps` (array of strings, required when a handoff is present).
- Optional fields: `failedApproaches`, `openQuestions`, `branch`, `owner`, and `shared` (default `false`).
- `createHandoff` filters empty entries and throws `handoff.nextSteps must contain at least one non-empty step.` when no non-empty step remains.
- `writeHandoffOnSessionEnd` returns `undefined` for an empty payload instead of throwing.

### Owner and branch resolution

- `owner` = payload owner, else `git config user.email`, else `git config user.name`, else OS username, else `local`.
- `branch` = payload branch, else `git rev-parse --abbrev-ref HEAD`, else `unknown`.
- Resolution failures fall back silently and do not crash.

### Storage and superseding

- Batons live at `projects/{projectId}/.sync/handoffs/`.
- Non-shared files are `{encodedOwner}__{encodedBranch}.json` (slashes replaced with `_`, percent-encoded, capped at 120 chars).
- Shared batons use the single fixed filename `_shared.json`.
- A new baton for the same owner+branch overwrites that owner+branch file, so the newest baton wins.
- Batons for sibling branches and other owners are untouched.
- Shared batons overwrite each other independently.

### Eligibility matching

- Eligible set: unclaimed, non-shared batons matching the current owner and current branch.
- Among those, the newest `createdAt` is chosen.
- If none match, the newest unclaimed shared baton is chosen.
- Owner/branch match takes strict precedence over shared.
- A shared baton of a different branch is still eligible for any branch.

### Single-use claiming

- `claimHandoff` re-reads the file from disk before writing.
- It rejects already-claimed records.
- It rejects id-mismatched records (superseded).
- On success it writes `claimed: true`, `claimedAt`, and `claimedBySession`.
- Telemetry emits `handoff_claimed`.

### Bootstrap delivery

- `bootstrap` calls `peekEligibleHandoff` before its budget pass.
- It renders the baton and reserves the handoff/objective byte size as immutable before trimming traps and decisions.
- The baton is claimed only after the brief fits inside `maxBytes` (default 8 KB).
- Claiming happens under a vault lock.
- Claim failures degrade to a notice and the standard brief.
- Missing files return `null`; malformed JSON is ignored; a malformed baton never crashes `bootstrap`.

### Cancellation and dismissal

- `cancel_handoff` (and `memo session handoff --cancel`) deletes only the current owner+branch non-shared file.
- When no such baton exists it returns `{ cancelled: false }` and the CLI exits `0`.
- `dismissHandoffById` deletes an unclaimed baton matching the supplied id (used by the status panel).

### Session objective

- `session_start` may record an `objective` string.
- Objectives are stored at `projects/{projectId}/.sync/objectives/{owner__branch}.json` and bound to owner+branch.
- `session_end` clears the objective.
- `session_start` without an objective also clears any stale objective for that owner/branch.
- `getSessionObjective` returns `null` when the referenced session file no longer exists.

### Telemetry and isolation invariants

- `createHandoff` records `operation: 'handoff_created'`.
- `claimHandoff` records `operation: 'handoff_claimed'`.
- Both carry `sessionId`, `branch`, `owner`, `shared`, and `handoffId` metadata.
- A session on a different branch or under a different owner never sees or consumes a private baton.
- Only `shared: true` crosses those boundaries.
- Claiming is single-use: a second attempt on the same baton fails rather than re-delivering.

## Technical Architecture

### Core module `src/handoff.ts`

- `createHandoff`, `listPendingHandoffs`, `matchEligibleHandoff`, `peekEligibleHandoff`.
- `claimHandoff`, `cancelHandoffForContext`, `dismissHandoffById`, `getActiveHandoffForContext`.
- `renderHandoffMarkdown`, `setSessionObjective`, `getSessionObjective`, `clearSessionObjective`.
- `deliverAndClaimHandoff`, `writeHandoffOnSessionEnd`, `resolveGitBranch`, `resolveOwner`.
- Shared baton filename constant `_shared.json`; subdirs `.sync/handoffs` and `.sync/objectives`.

### Types (`src/types.ts`)

- `HandoffPayload`: `nextSteps`, `failedApproaches`, `openQuestions`, `branch`, `owner`, `shared`.
- `HandoffRecord`: adds `id`, `harness`, `createdAt`, `sessionId`, `claimed`, `claimedAt`, `claimedBySession`.
- `SessionObjective`: `owner`, `branch`, `objective`, `sessionId`, `updatedAt`.

### Integration points

- `src/prompt.ts` writes batons on `endSessionRecord` and archives `handoffArchive` into session frontmatter.
- `src/prompt.ts` claims on `startSessionRecord`.
- `cancelHandoffRecord` and `showHandoffRecord` back the CLI.
- `src/bootstrap.ts` peeks, renders, budgets, and claims.

### MCP surface

- `prompt` actions `session_end` (with `handoff`/`shared`), `session_start` (with `objective`), and `cancel_handoff`.
- `bootstrap` returns `handoffMarkdown`, `handoff`, and `sessionObjective` in the brief.
- No new tool is added.

### CLI (`src/cli.ts`)

- `memo session end <id> --handoff-steps "A,B" --handoff-failed "X" --handoff-questions "Q" [--shared]` builds the payload from comma-separated flags.
- `memo session handoff` shows the active baton.
- `memo session handoff --all` lists every pending baton.
- `memo session handoff --cancel` cancels the current one.
- The CLI-only actions `handoff_show` and `handoff_list` route directly to `showHandoffRecord` and are not part of the MCP action enum.

### Status HTTP (status listener `:3124`)

- `GET /api/handoffs?project={id}` → `{ items, total, projectId, lastSeenRoot }`.
- It returns `400` when `project` is missing or `all`.
- `DELETE /api/handoffs/{id}?project={id}` dismisses one unclaimed baton.
- Both pass through `sanitizeToolOutput`.

### UI

- The **Active Handoffs** panel (`id="handoffs-panel"`, `id="handoffs-list"`) appears on the Prompts & Intent Stories tab.
- It groups pending batons and offers per-baton Dismiss buttons.
- The panel is embedded on the Prompts & Intent Stories tab (`data-tab="tab-prompts"`); the current `?tab=` deep-link handler covers `backups`, `wiki`, and `vaults` only, so `?tab=prompts` does not auto-open it.

### Provenance

- `0036-session-handoff-baton.spec.md`.
- Delivered through the `prompt` tool documented in [Prompt History, Sessions & Activity](prompt-history.md).
