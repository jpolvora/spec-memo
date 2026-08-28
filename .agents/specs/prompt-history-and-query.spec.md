---
id: null
slug: prompt-history-and-query
title: "Prompt, Session, Activity Ingestion, Rule Derivation, and Web UI Explorer"
source: local
specDate: 2026-08-28
status: draft
target_phase: Phase 7
---

# Specification — Prompt, Session, Activity Ingestion, Rule Derivation, and Web UI Explorer

## Description

In modern AI-assisted software engineering, software development has shifted from being purely code-centric to conversation-driven. The real design, tradeoff analyses, debugging edge cases, and architectural decisions happen in iterative discussions between human engineers and AI coding assistants across various environments (Cursor, VS Code + Copilot, Claude Code, Codex CLI, Gemini CLI, OpenCode, Pi Agent, Antigravity IDE/CLI, etc.).

When tools or sessions end, these conversations traditionally vanish, leading to lost context, repeated prompts, and zero organizational traceability. While tools like SpecStory preserve chat history by committing markdown files into the product repository (`.specstory/history/`), doing so violates `spec-memo`'s foundational invariant: **"Product git is not a memory store."** In-repo transcripts cause git bloat, merge conflicts, and credential leakage risks.

Furthermore, developers need to turn these transient interactions into **living, actionable intelligence and interactive visual exploration**:
1. **Activity & Invoicing Accounting:** Tracking task start/end times, billable hours, and PR deliverables across projects to support client invoicing.
2. **Automated AI Rule & Trap Derivation:** Analyzing prompt streams to detect developer intent signals (*"always"*, *"never"*, *"must"*, *"don't"*, *"every time"*) and automatically deriving evolving project rules, coding standards, and anti-regression traps.
3. **Interactive Web UI Explorer (Master-Detail, Expandable Rows, Details Side Panel):** A rich visual interface in the status monitor companion (`:3001`) enabling developers to filter by project/vault, search prompt text, expand rows inline, inspect full markdown with syntax highlighting in a slide-out details panel, view full chronological session stories, and trigger rule derivations and exports.
4. **Intent Story Replay & Export:** Merging conversational turns into unified, shareable markdown intent stories without polluting the target repository.
5. **Isolated Project Packaged Skills:** Shipping dedicated runtime skills (`ws-memo` and `ws-session-tracking`) packaged directly within `spec-memo` to instruct agents to proactively use the vault, without modifying or coupling to external global workflow-skills.

This specification introduces the **Prompt, Session, Activity Ingestion, Rule Derivation, and Web UI Explorer** in `spec-memo`:
1. **New Vault Record Kinds (`prompt` & `session`):** External vault storage under `$SPEC_MEMO_ROOT/projects/{projectId}/prompts/` and `sessions/`, capturing verbatim prompt text, intent summaries, timestamps, model identifiers, IDE metadata, session lifecycles, task slugs, PR deliverables, and billable accounting tags.
2. **Zero In-Repo Git Pollution:** All prompt history, session lifecycles, and timesheet telemetry live outside product repositories, keeping git trees pristine and shareable across local clones.
3. **Dedicated 11th MCP Tool (`prompt`):** Expands the core MCP tool surface from 10 to **11** tools, providing actions (`record`, `list`, `get`, `search`, `session`, `session_start`, `session_end`, `activity_report`, `derive_rules`, `export_story`) for autonomous agent workflows.
4. **Rich Master-Detail Web UI Surface:** Status monitor companion (`:3001`) includes an interactive Prompts & Intent Stories tab with project/vault selector, multi-field filter bar (IDE, model, agent, session, date range, client, tags), expandable data table rows, pagination controls, and an interactive slide-out Details Side Panel with full markdown rendering and metadata cards.
5. **AI Rule & Trap Derivation Engine:** Analyzes prompt streams to identify permanent constraints, negative requirements (*"never do X"*), and architectural standards, synthesizing them into candidate `trap`, `decision`, or `rule` records in the vault with optional promotion to IDE formats (`.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `CLAUDE.md`, `GEMINI.md`).
6. **Unified Intent Story Export:** Combines multi-turn conversational sessions into single cohesive Markdown transcripts (`memo prompt export --session <id>`) with redacted secrets and code diff formatting.
7. **Task Lifecycle & Deliverable Correlation:** Ingests task implementation start/end bounds, PR numbers/URLs, commit SHAs, and active work intervals to automate activity reporting and client invoicing across multiple projects and vaults.
8. **Full Multi-Deployment Mode Parity:** Operates identically across `local` (authoritative direct vault), `hybrid` (local cache + debounced push/pull delta sync with remote daemon), and `remote` (zero-local stdio proxy forwarding to remote daemon) modes.
9. **SQLite FTS5 Multi-Dimensional Search & Pagination:** Full-text search integrated with indexed metadata filtering across IDEs, models, agents, date ranges (`since`/`until`), clients, projects, session IDs, and tags, returning structured pagination envelopes (`{ total, limit, offset, hasMore, items }`).
10. **Dedicated CLI Commands (`memo prompt`, `memo session`, `memo activity`):** Rich CLI interface providing listing, FTS search, session reconstruction, rule derivation, and cross-project timesheet/invoice reporting.
11. **Dedicated Packaged Skills (`ws-memo` & `ws-session-tracking`):** Ships self-contained runtime skills within `spec-memo` (`.agents/skills/`) to instruct agents to proactively use `spec-memo` for working memory, session tracking, and prompt ingestion, keeping global workflow-skills completely untouched.

## Acceptance Criteria

### Record Schema & Vault Scaffolding

- AC1: `RecordKind` in `src/types.ts` and `RecordKindSchema` in `src/schema.ts` include `'prompt'` and `'session'` as valid record kinds.
- AC2: Vault scaffolding in `ensureProjectVault` (`src/vault.ts`) creates dedicated subdirectories `prompts/` and `sessions/` under `$SPEC_MEMO_ROOT/projects/{projectId}/`.
- AC3: Prompt records support extended frontmatter fields:
  - `id`: Unique identifier formatted as `prompt-{timestamp}-{hash}` or `prompt-{sessionId}-t{turn}`.
  - `kind`: `'prompt'`.
  - `project`: Normalized project ID.
  - `status`: `'active'` | `'archived'`.
  - `created` / `updated`: ISO 8601 UTC timestamp with millisecond precision.
  - `ide`: String identifying host environment (`cursor` | `vscode` | `claudecode` | `codex` | `gemini` | `opencode` | `pi` | `antigravity` | `terminal` | `generic`).
  - `model`: Optional string identifying the LLM model name (e.g. `gemini-3.7-flash`, `claude-3-7-sonnet`, `gpt-4o`).
  - `agent`: Optional string identifying the subagent, skill, or workflow role (e.g. `ws-write-spec`, `planner`, `reviewer`).
  - `sessionId`: Optional string grouping sequential turns in a single conversation or task session.
  - `turn`: Optional positive integer representing the conversational turn number within the session.
  - `taskSlug`: Optional string referencing the active feature or work item slug (e.g. `us-250`, `prompt-history-and-query`).
  - `client`: Optional string identifier for client / billing account tagging (e.g. `acme-corp`, `internal`).
  - `billable`: Optional boolean flag indicating whether the work turn is billable (default `true`).
  - `branch`: Optional string recording the active git branch name.
  - `gitSha`: Optional string recording the active git commit SHA.
  - `linkedPaths`: Optional array of repository file paths referenced in the prompt.
  - `tags`: Optional array of categorization tags.
- AC4: Session records support extended frontmatter fields:
  - `id`: Unique identifier formatted as `session-{sessionId}` or `session-{timestamp}-{hash}`.
  - `kind`: `'session'`.
  - `project`: Normalized project ID.
  - `status`: `'active'` | `'completed'` | `'archived'`.
  - `sessionId`: Correlation identifier for the entire session.
  - `startTime`: ISO 8601 UTC timestamp of session / task start.
  - `endTime`: Optional ISO 8601 UTC timestamp of session / task completion.
  - `durationMinutes`: Optional number representing total elapsed active work duration in minutes.
  - `humanTotalMinutes`: Optional number representing active human interaction duration.
  - `agentRunningMinutes`: Optional number representing autonomous agent execution duration.
  - `taskSlug`: Optional string identifying the delivered feature slug.
  - `client`: Optional string identifying the client account.
  - `billable`: Boolean flag indicating billable status.
  - `deliverables`: Optional array of deliverable objects (`{ type: 'pr' | 'commit' | 'spec', url?: string, sha?: string, title?: string }`).
  - `summary`: Optional text summary of work performed.
- AC5: All prompt and session files are validated to be strictly outside the consumer product repository tree (`assertNotInProductRoot`) and scrubbed for credentials, passwords, and tokens (`assertNoSecrets`).

### Dedicated 11th MCP Tool (`prompt`)

- AC6: `TOOL_NAMES` and `ToolName` in `src/types.ts` expand from 10 to 11 core tools to include `'prompt'`.
- AC7: The `prompt` MCP tool definition in `src/tools.ts` supports the following actions:
  - `action`: String enum (`record` | `list` | `get` | `search` | `session` | `session_start` | `session_end` | `activity_report` | `derive_rules` | `export_story`).
  - `body`: String prompt text or work summary (required for `record`).
  - `id`: String record identifier (required for `get`).
  - `sessionId`: String session correlation identifier.
  - `turn`: Optional integer turn number.
  - `taskSlug`: Optional string referencing the active work item or spec slug.
  - `client`: Optional client / account name.
  - `billable`: Optional boolean flag.
  - `ide`: Optional host environment name.
  - `model`: Optional LLM model identifier.
  - `agent`: Optional subagent / role name.
  - `deliverables`: Optional array of deliverable objects for `session_end`.
  - `query`: Optional FTS search query string.
  - `since`: Optional ISO timestamp lower bound.
  - `until`: Optional ISO timestamp upper bound.
  - `tags`: Optional array of string tags.
  - `limit`: Optional integer page size (default `20`, max `100`).
  - `offset`: Optional integer offset for pagination (default `0`).
  - `sort`: Optional sort order (`date-desc` | `date-asc` | `relevance`).
  - `cwd`: Optional repository working directory.
  - `projectId`: Optional project ID override.
  - `crossProject`: Optional boolean for multi-vault queries.
- AC8: Invoking `prompt` with `action: 'record'` creates and persists a new prompt record in the project vault, indexes it into SQLite FTS5, updates compiled views, triggers hybrid push if in hybrid mode, and returns `{ id, path, created, turn, sessionId }`.
- AC9: Invoking `prompt` with `action: 'session_start'` creates or updates a session record with `startTime`, `sessionId`, `taskSlug`, `client`, and `billable` flag.
- AC10: Invoking `prompt` with `action: 'session_end'` updates the session record with `endTime`, `durationMinutes`, `deliverables` (PR URLs, commit SHAs), and final summary.
- AC11: Invoking `prompt` with `action: 'list'` or `action: 'search'` returns the paginated envelope `{ total, limit, offset, hasMore, items }`.
- AC12: Invoking `prompt` with `action: 'session'` returns all prompt turns for the specified `sessionId` ordered chronologically by `turn`.
- AC13: Invoking `prompt` with `action: 'activity_report'` returns aggregated timesheet and billing metrics across the specified date range and project/client filters.
- AC14: Invoking `prompt` with `action: 'export_story'` concatenates and formats all prompt turns of a session into a single cohesive Markdown document with metadata headers and sanitized code blocks.
- AC15: Invoking `prompt` with `action: 'derive_rules'` analyzes prompt history for rule signals (*"always"*, *"never"*, *"must"*, *"don't"*, *"every time"*) and returns synthesized rule recommendations.

### AI Rule & Trap Derivation Engine

- AC16: The rule derivation engine scans prompt history across a project or session, extracting explicit constraints, negative instructions (*"never edit X"*, *"always run test Y first"*), and workflow conventions.
- AC17: Extracted rule candidates are returned as structured recommendations (`{ ruleTitle, pattern, category, confidence, sourcePromptIds }`).
- AC18: `memo prompt derive-rules [--session <id>] [--save-traps] [--promote <path>]` can automatically save high-confidence derived rules as `trap` records in the vault or promote them directly to `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `CLAUDE.md`, or `GEMINI.md`.

### Interactive Web UI Explorer (Master-Detail, Expandable Rows, Details Side Panel)

- AC19: Status monitor companion (`memo serve --sse` on port `3001`) provides an interactive **Prompts & Intent Stories** web UI view with:
  - **Vault / Project Selector:** Dropdown to switch between specific project vaults or choose "All Vaults (Cross-Project)" view.
  - **Filter Bar:** Real-time search query box (FTS-powered), IDE filter chips (`cursor`, `vscode`, `claude`, `codex`, `gemini`, `opencode`, `pi`, `antigravity`), Model selector, Subagent selector, Date range pickers (`since` / `until`), and Client tag filters.
  - **Master Table with Expandable Rows:** Interactive table displaying prompt turns with columns for Timestamp, Project/Vault, IDE, Model, Session ID, Turn #, and Intent/Prompt Snippet. Clicking an expand icon toggles an inline preview of the prompt text.
  - **Slide-Out Details Side Panel (Drawer):** Clicking any row opens a side details window showing:
    - Complete rendered Markdown of the prompt text with syntax-highlighted code blocks.
    - Full frontmatter metadata card (Project, Session correlation, Turn #, Branch, Git SHA, Linked Paths, Tags, Client, Billable status).
    - Secret sanitization indicators showing redacted tokens.
    - Quick-action buttons: "View Full Session Story" (loads all turns for that `sessionId`), "Export Markdown Story", and "Derive Rules".
  - **Pagination Controls:** Bottom pagination bar with page selector, page size selector (10, 20, 50, 100), Prev/Next buttons, and total result count badge.
- AC20: Status monitor REST endpoints support the UI explorer:
  - `GET /api/prompts`: Returns paginated prompt hits with filter parameters (`project`, `query`, `ide`, `model`, `agent`, `session`, `since`, `until`, `client`, `tag`, `limit`, `offset`, `sort`).
  - `GET /api/prompts/:id`: Returns full prompt record details, frontmatter, and rendered HTML body.
  - `GET /api/prompts/sessions/:sessionId`: Returns chronological prompt turns for a complete session.
  - `GET /api/prompts/sessions/:sessionId/export`: Generates downloadable standalone Markdown intent story file.
  - `GET /api/sessions`: Returns session lifecycle records with duration and PR deliverables.
  - `GET /api/activity`: Returns aggregated timesheet and invoicing metrics by client and project.

### SQLite FTS5 Indexing & Multi-Dimensional Query Engine

- AC21: The SQLite index (`memo.sqlite`) indexes `prompt` and `session` records in `records_fts`, making prompt bodies, intent summaries, titles, tags, and deliverable references searchable.
- AC22: Multi-field query filtering supports querying prompts and sessions by `ide`, `model`, `agent`, `sessionId`, `taskSlug`, `client`, `billable`, date bounds (`since`/`until`), and `tags`.
- AC23: Cross-project query support (`crossProject: true`) aggregates activity and billing metrics across all registered local vaults in `$SPEC_MEMO_ROOT/projects/`.

### Deployment Modes Parity

- AC24: In `local` mode, prompt, session, UI queries, and rule derivation operations execute directly against the local vault filesystem and `memo.sqlite` database.
- AC25: In `hybrid` mode, local prompt and session mutations trigger a debounced delta push to the remote server daemon (`scheduleHybridPush`), and remote session updates are pulled during `bootstrap` or `sync`.
- AC26: In `remote` mode, prompt and session tool calls are proxied over stdio to the remote daemon via `callRemoteTool('prompt', args)` with zero local disk writes.

### CLI Command Suite (`memo prompt`, `memo session`, `memo activity`)

- AC27: `memo prompt list` (or `memo prompts`) lists prompt entries with pagination and filter flags (`--ide`, `--model`, `--agent`, `--session`, `--slug`, `--client`, `--since`, `--until`, `--tag`, `--limit`, `--offset`, `--json`).
- AC28: `memo prompt search <query>` executes full-text search across prompt and session records with highlighted snippets and metadata.
- AC29: `memo prompt show <id>` displays full markdown body and frontmatter for a specific prompt or session record.
- AC30: `memo prompt session <sessionId>` retrieves and displays all conversational prompt turns for a session in chronological sequence.
- AC31: `memo prompt export --session <id> [--output <file>]` exports a session as a single unified Markdown story file.
- AC32: `memo prompt derive-rules [--session <id>] [--save-traps]` triggers rule derivation on past prompt history.
- AC33: `memo session start --session <id> [--slug <slug>] [--client <client>]` and `memo session end --session <id> [--pr <url>] [--summary <text>]` manage session lifecycle intervals from the command line.
- AC34: `memo activity [--since <date>] [--until <date>] [--client <client>] [--project <id>] [--json]` computes and displays a formatted timesheet summary with total billable hours, session counts, and deliverables for invoicing.

### Compiled Views & Status Monitor Companion

- AC35: `rebuildCompiledViews` generates `projects/{projectId}/PROMPTS.md` and `projects/{projectId}/SESSIONS.md` summarizing recent prompt history, session deliverables, active IDE breakdown, and wikilinks to individual records.
- AC36: Status monitor web UI provides dedicated Prompts (master-detail explorer), Activity / Invoicing (printable billing timesheets), and Derived Rules tabs.

### Packaged Skills & Agent Proactive Guidance (`ws-memo` & `ws-session-tracking`)

- AC37: Packaged skill `ws-memo` (`.agents/skills/ws-memo/SKILL.md`) is updated in-repo to document the expanded 11-tool surface, detailing the `prompt` tool actions, session tracking, rule derivation, activity reporting, and proactive working memory guidance.
- AC38: A new self-contained runtime skill `ws-session-tracking` (`.agents/skills/ws-session-tracking/SKILL.md`) is authored and packaged inside `spec-memo`, instructing agents to proactively record intent, turn prompts, and task start/end deliverables into `spec-memo` during agent sessions.
- AC39: `ALLOWED_SKILLS` in `src/skills-install.ts` is updated to `['ws-memo', 'ws-session-tracking']`, allowing consumer projects to install both packaged skills via `memo install-skills --skills ws-memo,ws-session-tracking`.
- AC40: Global `workflow-skills` (`C:\Users\jpolv\.gemini\config\skills`) remain completely untouched and uncoupled from this repository's build, maintaining strict project isolation.

## Original Issue Context

### User Prompt / Request

> /ws-write-spec add a new feature to be implemented in spec-memo (vault): a special type/kind of entry/ record in vault which is "prompt" to save history of prompts with date/time, content, and model / agent / ide (cursor, codex, claude, gemini, opencode, pi agent, etc). Will save to a file in vault specialized for prompts. Each prompt (like changelog) will save to memo if ws-memo is present and configured to save historical prompts of chats/agents. memo vault will have special tool/command for dealing with only story prompts. Check this idea (intent story if it is better to enhance the spec and grill me) https://docs.specstory.com
> so I can query, filter, list, paginated, searchable, filterable queryes and prompt/intent history/logs
> add also to this spec: the vault an ingest task implementation start/end, along with intent/prompts/session work. So I can later query for activity-report/usage/work so I can track invoices to my clients based on my work accross projects/vaults. This feature is a big impromement: ingest metada/log/intent/prompt/session tracking/work/start-end deliverables. PR, etc. So we can use hooks into agentic sessions/ide to attach to events if would help to produce data ingestion and possibility to analise and query against the vault for work. Add also a new skill that will help to query data (ws-memo is for integration, should be also update with these new tools and explanations, and a new ws-session-tracking). Remember, this spec-memo vault project will now a helpful tool for saving specs/states/traps/memory/changelogs and now we will be adding session track/prompts/intentions and log data of human work for maintaining a database queryable for logging. Same architecture supported: mode direct client (local vault only), a bridge (local+proxy with sync up/down) and the direct remote server connection. Please enhance the spec to cover all these features, rewrite/enhance the spec with /ws-write-spec
> from specStory project: Why SpecStory exists... Software development has shifted from being purely code-centric to conversation-driven... Key capabilities: Auto-save your AI conversations, Manual save and export, Share and annotate conversations, Derive rules for AI automatically (.cursor/rules, copilot-instructions.md)...
> do not mess with ws-* skills (workflow-skills installed globally). Ship skills specific for this project, later I will introduce skills for integration with spec-memo and workflow-skills project briding/adaptative layer. Now I want only ws-memo and ws-session-tracking, to be loaded proactively to instruct the agent to use spec-memo
> update spec to UI surface to support querying historical prompts/intents with rows , filters, details side window/panel, expanding, etc, filtering by project/vault

### Prior Work Sweep

- Prior feature specs:
  - `record-schema-and-indexes.spec.md` (Phase 1): defined core record schemas, frontmatter validation, and compiled view generator.
  - `remaining-kinds-and-events.spec.md` (Phase 1): added `log`, `scratch`, `review`, and `appendEvent`.
  - `fts-index.spec.md` (Phase 1): implemented SQLite FTS5 search index and Porter stemmer.
  - `cross-project-search.spec.md` (Phase 3): multi-project search across local vault repositories.
  - `promote-adr.spec.md` (Phase 4): promotion of records to repo documentation.
  - `canvas-viewer.spec.md` (Phase 5): graph node visualization of memory records.
  - `trap-recurrence.spec.md` (Phase 6): trap recurrence ranking and owner-skill export (`memo promote --format skill`).
  - `mcp-status-monitor.spec.md` (Phase 6): web companion UI on `:3001` with live activity log.
  - `mcp-version-and-skill-install.spec.md` (Phase 6): packaged skills distribution (`install_skills`).
  - `deployment-modes.spec.md` (Phase 7): local, hybrid, and remote deployment modes.
  - `operational-telemetry.spec.md` (Phase 7): structured usage telemetry streams.
- Codebase inspection:
  - `src/types.ts`: `RecordKind` union contains 8 kinds; `TOOL_NAMES` array contains 10 tools.
  - `src/store.ts`: `getSubdirForKind`, `upsertRecord`, `appendEvent`, `getRecord`, `listProjectRecords`.
  - `src/compiler.ts`: `rebuildCompiledViews` builds `TRAPS.md`, `DECISIONS.md`, `INDEX.md`.
  - `src/indexer.ts`: `records_fts` table and `searchIndex`.
  - `src/status.ts`: REST endpoints, master-detail layout components, and HTML web UI.
  - `src/skills-install.ts`: `ALLOWED_SKILLS` array (`['ws-memo']`).

### Design Intent

Comprehensive evolution of `spec-memo` into a visual, conversation-driven intent hub, session lifecycle tracker, timesheet billing engine, and automated AI rule derivation system. Features an interactive master-detail Web UI in the status monitor companion with slide-out side panels, expandable rows, project/vault filters, and self-contained project packaged skills.

## Notes

- **Master-Detail & Side Panel UX:** The Web UI on `:3001` adopts modern master-detail patterns with responsive data tables, inline expansion for rapid scanning, and a dedicated slide-out side drawer for reading full markdown prompts, checking metadata tags, and triggering exports without losing table filter state.
- **SpecStory Synergy & Superiority:** SpecStory pioneered the idea that the real artifact in modern software development is the conversation and reasoning story behind code. However, committing transcript dumps into `.specstory/history/` causes repository bloat and git pollution. `spec-memo` provides the ideal architectural home for intent stories: external vault persistence, SQLite FTS5 search, cross-project aggregation, automated rule derivation, and zero repository residue.
- **Skill Isolation Boundary:** All packaged runtime skills (`ws-memo`, `ws-session-tracking`) are contained strictly inside `.agents/skills/` within `spec-memo`. Global `workflow-skills` (e.g. global `ws-activity-report`, `ws-senior-developer`) are left completely untouched.
- **Rule Derivation Philosophy:** By scanning prompt interactions for linguistic signals (*"never"*, *"always"*, *"don't"*, *"must"*), `spec-memo` can extract institutional knowledge, save them as `trap` records in the vault, and optionally promote them to `.cursor/rules/*.mdc` or `copilot-instructions.md`.
- **Invoicing & Timesheet Telemetry:** By recording exact `startTime`, `endTime`, `durationMinutes`, and deliverable PRs in `session` records, consulting engineers can run `memo activity --client <client> --since <date>` to produce verifiable timesheets backed by actual prompt and commit histories.
- **Secret Redaction:** High-frequency prompt logs frequently contain pasted snippets, API keys, or tokens. Running `assertNoSecrets` and redaction before disk write guarantees that credentials are never stored in plain text.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Modifying global `workflow-skills` or external global `ws-*` skills | Isolation invariant: all runtime skills for this feature are self-contained inside `spec-memo`. |
| In-repo prompt or session file generation (`.specstory/` or `.agents/prompts/`) | Violates core git boundary invariant; all prompt and session records live in external vault. |
| Automatic OS-level terminal screen-scraping daemon / PTY hook | Out of scope for vault store; prompt capture is handled via MCP tools, CLI, or skill integrations. |
| Direct PDF invoice generation and Stripe payment processing | `spec-memo` calculates structured hours, sessions, and deliverables data; PDF rendering / invoicing software integration belongs in external billing tools. |
| Live multi-user prompt chat room | `spec-memo` is a local-first memory vault, not a real-time messaging service. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Subdirectory names in project vault | `prompts/` and `sessions/` under `$SPEC_MEMO_ROOT/projects/{projectId}/` | Consistent with `traps/`, `decisions/`, `specs/`, `plans/`, `logs/` | y |
| MCP tool expansion | Dedicated MCP tool `prompt` (11th core tool) with session, activity, and rule derivation actions | First-class agent access for prompt capture, session lifecycle, rule derivation, and activity reporting | y |
| Web UI master-detail layout | Slide-out side drawer with expandable table rows and project selector on `:3001` | Best UX for dense prompt inspection and filtering without losing table position | y |
| Shipped packaged skills | `ws-memo` and `ws-session-tracking` inside `.agents/skills/` of `spec-memo` | Self-contained project skills only; zero modification of global `workflow-skills` | y |
| Rule derivation trigger | On-demand via `memo prompt derive-rules` / `prompt` action `derive_rules` | Deterministic and low latency; avoids LLM cost on every raw write | y |
| Default pagination limit | `20` items per page (max `100`) | Standard pagination default for CLI, MCP, and web views to avoid memory spikes | y |
| Default sort order | `date-desc` (newest first) | Developers typically search for recent intent or browse recent prompt turns | y |
| Implicit dimensions (auth, concurrency, lifecycle) | N/A because auth is handled by MCP transport, locking is handled by vault file locks, and retention follows standard vault GC | Vault architecture already provides file locking, SQLite WAL mode, and GC compaction | y |
