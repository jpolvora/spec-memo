# Prompt History, Sessions & Activity

## Feature Overview

spec-memo persists agent conversational turns and work intervals outside the product repository. Two vault record kinds back this: `prompt` (one conversational turn) and `session` (a work interval with lifecycle and deliverables). Together they power full-text retrieval, automated rule derivation, intent-story export, and timesheet/invoicing activity reports while keeping product git free of transcripts.

Primary journeys:

- An agent records a turn through the 11th MCP tool `prompt` (`action: 'record'`).
- An agent opens and closes work sessions with `session_start` / `session_end`.
- An agent recalls history with `list`, `search`, `session`, and `get`.
- An operator browses the status monitor **Prompts & Intent Stories** tab, filters by vault/IDE/model/agent/session/date/client, expands rows, and opens the details drawer.
- An operator uses the **Activity & Invoicing** tab for printable billing timesheets and the **Derived Rules** tab for candidate rules.
- A maintainer runs CLI `memo prompt …`, `memo prompts …`, `memo session …`, and `memo activity …` for listing, search, session reconstruction, export, and cross-project invoicing.

Core interactions:

- Prompt/session mutations write Markdown plus SQLite FTS.
- Compiled views `PROMPTS.md` and `SESSIONS.md` are regenerated.
- A debounced hybrid push is scheduled on mutations.
- `session_end` also flushes dual sync (hybrid plus vault-git) when enabled, fail-open.

## Business Rules & Logic

### Record kinds and storage

- `prompt` and `session` are valid `RecordKind` values.
- They map to subdirectories `prompts/` and `sessions/` under `projects/{projectId}/` (`getSubdirForKind` in `src/store.ts`).
- All files live in the vault, never in the product tree.

### Identity and frontmatter

- Prompt id with both `sessionId` and `turn`: `prompt-{sessionId}-t{turn}`.
- Prompt id otherwise: `prompt-{Date.now()}-{6 hex}`.
- Session record id: `session-{sessionId}`.
- `session_start` without a `sessionId` generates `{timestamp}-{6 hex}`.
- Prompt frontmatter: `id`, `kind`, `project`, `status`, `created`, `updated`, `source`, `ide`, `model`, `agent`, `sessionId`, `turn`, `taskSlug`, `client`, `billable`, `branch`, `gitSha`, `linkedPaths`, `tags`.
- Session frontmatter adds `startTime`, `endTime`, `durationMinutes`, `deliverables`, `summary`, and `handoffArchive`.
- `ide` defaults to `generic`; `billable` defaults to `true`.

### Turn allocation and write safety

- When `sessionId` is present and `turn` is omitted, the next turn is `max(existing turn) + 1`.
- Turn allocation and write occur under one vault lock, reentrant with `upsertRecord`, so concurrent turns cannot collide on deterministic ids.
- `record` requires a non-empty `body`.
- The body is first passed through capture-ignore path redaction, then `redactSecretsInPayload`, before persistence.

### Session lifecycle

- `session_start` refuses to restart a session whose record is already `completed`.
- It preserves an existing `startTime`, `created`, `taskSlug`, `client`, `billable`, and `summary`.
- On start it delivers/claims an eligible handoff and sets or clears the owner/branch session objective.
- `session_end` requires `sessionId` and an existing session record; otherwise it errors with "Call session_start first".
- `endTime` defaults to now (or `until`).
- `durationMinutes` is computed from `endTime - startTime`, rounded to whole minutes, and is never taken from pagination `limit`.
- Re-ending a completed session preserves the existing duration.
- New deliverables merge into existing ones, de-duplicated by the `(url, sha, type)` triple.
- The session is marked `completed`, `handoffArchive` is recorded when a handoff was written, and the objective is cleared.
- After a successful `session_end`, `syncDual` runs with `trigger: 'session_end'` when hybrid has a remote URL or `vaultGit.enabled` (and mode is not `remote`); sync errors are logged, never fatal.

### Query, pagination, and search

- `list`, `search`, and session listing clamp `limit` to 1–100 (default 20) and `offset` to ≥ 0.
- They return the envelope `{ total, limit, offset, hasMore, items }`.
- Default sort is `date-desc`.
- `search` is FTS5-only over `prompt` records in `records_fts`; there is no substring fallback.
- An empty query returns an empty page.
- Metadata filters are AND-combined: `ide` exact (case-insensitive), `model`/`agent` substring (case-insensitive), `sessionId`/`taskSlug`/`client` exact, `billable` boolean exact, `tags` all-must-match, and `created` bounds via `since`/`until`.
- Unparseable dates throw `Invalid since date` / `Invalid until date`.
- `get` resolves the id first as a `prompt` record, then as a `session` record, and fails otherwise.

### Rule derivation and promotion

- Signal groups and base confidence: `always`/`every time` (process, 0.85); `never`/`do not`/`don't`/`under no circumstances` (constraint, 0.9); `must not`/`cannot`/`should never` (constraint, 0.9); `must`/`strictly required`/`mandatory` (architecture, 0.85); `refuse`/`reject`/`prohibit` (security, 0.9).
- Extracted text must be at least 15 characters.
- Repeated identical instructions are grouped by a normalized key; each occurrence adds 0.05 confidence up to 0.99.
- `saveTraps` persists only candidates with confidence ≥ 0.8.
- Derived trap id: `trap-derived-{slug32}-{suffix8}`, severity `high`, tags `['derived-rule', category]`.
- `promote` destinations must resolve inside the product root and match the IDE allowlist: `.cursor/rules/*`, `.github/copilot-instructions.md`, `CLAUDE.md`, `GEMINI.md`.
- Promotion requires a `cwd` or a project with `lastSeenRoot`; otherwise the call is rejected.

### Export and activity reporting

- `export_story` merges all turns of a session into one Markdown document with metadata, deliverables, and a chronological turn log.
- When an output path is given, the cwd must be a consumer product repository, not the vault root or a path inside it.
- The destination must be outside the product root.
- `activity_report` aggregates sessions and prompts across the selected project(s) or all vaults (`crossProject`).
- Only billable sessions contribute to `totalDurationMinutes`, `totalBillableHours`, `byClient`, and `byProject`.
- Missing clients default to `internal`; client matching is case-insensitive; hours round to two decimals.
- `totalPrompts` counts prompt records within the date bounds and client filter.

## Technical Architecture

### MCP tool `prompt` (`src/tools.ts`, schema in `src/types.ts`)

- Actions: `record`, `list`, `get`, `search`, `session`, `session_start`, `session_end`, `cancel_handoff`, `activity_report`, `derive_rules`, `export_story`.
- The Zod schema additionally accepts `feedback` (submits memory feedback).
- Context fields include `branch`, `gitSha`, `linkedPaths`, `handoff`, `objective`, `shared`, `crossProject`, `cwd`, `projectId`, and `vaultRoot`.
- `handoff` carries `nextSteps` (required if present), `failedApproaches`, `openQuestions`, `branch`, `owner`, and `shared`.

### Core modules

- `src/prompt.ts`: `recordPromptTurn`, `startSessionRecord`, `endSessionRecord`, `getSessionTurns`, `exportSessionStory`, `listPrompts`, `searchPrompts`, `listSessions`, `deriveRulesFromPrompts`, `generateActivityReport`, `cancelHandoffRecord`, `showHandoffRecord`, `generatePromptId`, `generateSessionId`.
- `src/rules-engine.ts`: `extractRulesFromPrompts`, `formatDerivedRulesForExport` (formats `cursor`, `copilot`, `claude`, `gemini`, `markdown`).

### Persistence

- Markdown records with YAML frontmatter (fields listed under Business Rules).
- FTS rows land in `records_fts` via `src/indexer.ts`.
- `rebuildCompiledViews` emits `PROMPTS.md` and `SESSIONS.md` alongside `INDEX.md` / `TRAPS.md` / `DECISIONS.md`.

### CLI (`src/cli.ts`)

- `memo prompt <action>` with alias `memo prompts`.
- `memo session start|end|handoff|show|export [sessionId]`.
- `memo activity`.
- Key flags: `--body`, `--session-id`, `--turn`, `--task-slug`/`--slug`, `--client`, `--billable`, `--ide`, `--model`, `--agent`, `--since`, `--until`, `--query`, `--limit`, `--offset`, `--cross-project`/`--all`, `--output`/`-o`, `--summary`, `--pr`, `--deliverables`, `--save-traps`, `--promote`, `--format`.
- `--pr` appends a `{ type: 'pr', url, title }` deliverable.

### Status HTTP (status listener `:3124`, config `ports.status`)

- `GET /api/prompts` filters `project`, `query`, `ide`, `model`, `agent`, `session`/`sessionId`, `taskSlug`/`slug`, `client`, `billable`, `since`, `until`, `tag`, `limit`, `offset`, `sort`, `crossProject`.
- `GET /api/prompts/sessions/{sessionId}` returns turns and requires `project`.
- `GET /api/prompts/sessions/{sessionId}/export` returns a Markdown download.
- `GET /api/prompts/{id}` returns the record plus `renderedHtml` via `renderPromptMarkdownHtml` and `secretsRedacted`.
- `GET /api/sessions` and `GET /api/activity` return session lists and aggregates.
- `POST /api/prompts/derive-rules` derives rules and optionally saves traps.
- Record and listing responses pass through `sanitizeToolOutput`; the shared `winJson` helper does not sanitize, and `POST /api/prompts/derive-rules` error responses plus the session Markdown export emit raw content.

### UI (`src/status.ts` `generateStatusHtml`)

- `tab-prompts`: master table with IDE chips, vault selector, search/model/agent/client fields, date pickers, page size (10/20/50/100), pagination, and a details drawer.
- `tab-invoicing`: billing timesheet view.
- `tab-rules`: derived-rule candidates.

### Deployment parity

- `local` runs against the local vault.
- `hybrid` schedules debounced pushes (`scheduleHybridPush`).
- `remote` proxies tool calls to the remote daemon with zero local writes.

### Provenance

- `0029-prompt-history-and-query.spec.md` (primary).
- Extended by `0036-session-handoff-baton.spec.md` (session objective, cancel_handoff).
- `0034-memory-hit-count.spec.md` (feedback action).
