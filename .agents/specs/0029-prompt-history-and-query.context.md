# Context — Prompt, Session, Activity Ingestion, Rule Derivation, and Web UI Explorer

## Feature Boundary

The prompt, session, and rule derivation subsystem provides durable, externalized storage, visual exploration, and intelligence for user prompts, conversation turns, developer intent, task implementation lifecycles (start/end), work deliverables, and automated AI rule synthesis across various AI coding tools (Cursor, VS Code + Copilot, Claude Code, Codex CLI, Gemini CLI, OpenCode, Pi Agent, Antigravity IDE/CLI).

### In-Scope Boundaries:
- External vault record kinds `prompt` and `session` in `$SPEC_MEMO_ROOT/projects/{projectId}/prompts/` and `sessions/`.
- Extended frontmatter schemas for IDE identification, model names, subagent roles, session IDs, turn numbers, task slugs, clients, billable flags, deliverables (PRs/commits), start/end times, and tags.
- Dedicated 11th MCP tool `prompt` (`record`, `list`, `get`, `search`, `session`, `session_start`, `session_end`, `activity_report`, `derive_rules`, `export_story`).
- **Master-Detail Web UI Explorer:** Interactive status monitor tab on `:3001` with project/vault selector, multi-field filter bar (IDE, model, agent, session, date range, client, tags), expandable data rows, and a slide-out Details Side Panel (drawer) with full markdown rendering, syntax highlighting, and action triggers.
- AI rule & anti-regression trap derivation engine analyzing prompt streams for permanent rules (*"always"*, *"never"*, *"must"*, *"don't"*) with optional promotion to `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `CLAUDE.md`, or `GEMINI.md`.
- Unified intent story export (`memo prompt export --session <id>`).
- Full compatibility with all three deployment modes (`local`, `hybrid`, `remote`).
- Multi-project, cross-vault timesheet and billing calculation for client invoicing.
- SQLite FTS5 full-text search indexing across prompt bodies, intent summaries, tags, and deliverable metadata.
- Multi-dimensional query engine with pagination (`limit`, `offset`), sorting, and date/field filters.
- Dedicated CLI subcommands (`memo prompt`, `memo session`, `memo activity`).
- REST endpoints and UI tabs in the status monitor companion (`:3001`).
- Compiled project views `PROMPTS.md` and `SESSIONS.md`.
- **Packaged Skills Isolation Boundary:** Project-specific runtime skills `ws-memo` (updated for 11 tools) and `ws-session-tracking` (new skill) packaged directly inside `.agents/skills/` of `spec-memo`, instructing agents to proactively use the vault.
- Strict secret redaction and clean git boundary enforcement.

### Out-of-Scope Boundaries:
- **Global `workflow-skills`:** Global `ws-*` skills (`C:\Users\jpolv\.gemini\config\skills`) are strictly untouched and uncoupled from this slice.
- In-repo file commits (e.g. `.specstory/history/` or in-tree transcripts/timesheets).
- Direct PDF generation and Stripe/payment gateway integrations.
- Mandatory background OS daemon terminal screen scrapers.

---

## Implementation Decisions

### 1. Master-Detail Web UI with Slide-Out Details Drawer
- **Decision:** Implement a split master-detail view on `:3001` with expandable rows for quick inline scanning and a slide-out side panel (drawer) for deep markdown reading.
- **Rationale:** Prevents context loss when browsing through dozens of prompt turns. Developers can filter by project/vault, expand a row to check the snippet, or click to open the full drawer to read code diffs and metadata without resetting pagination or filters.

### 2. Unified Session Lifecycle & Prompt Granularity
- **Decision:** Separate prompt turns (`kind: 'prompt'`) from session containers (`kind: 'session'`), linked by `sessionId`.
- **Rationale:** Prompts are granular, high-frequency, and content-heavy (ideal for FTS search and intent review). Sessions represent cohesive units of work with discrete `startTime`, `endTime`, `taskSlug`, `client`, `billable` flag, and `deliverables` (PR URLs, commit SHAs), making them optimal for timesheet computation and client invoicing.

### 3. Dedicated 11th MCP Tool Surface
- **Decision:** Expand the core MCP tool set from 10 to 11 tools by adding `prompt`.
- **Actions:**
  - `record`: Ingest a single prompt turn with intent and metadata.
  - `list` / `search`: Paginated retrieval and FTS search.
  - `get`: Retrieve an individual prompt or session record.
  - `session`: Retrieve all prompt turns in chronological order for a session.
  - `session_start` / `session_end`: Record task lifecycle boundaries, duration, and PR deliverables.
  - `activity_report`: Aggregate billable hours, session counts, and deliverables by client/project over a date range.
  - `derive_rules`: Extract permanent rules and traps from prompt streams.
  - `export_story`: Combine session turns into a unified markdown transcript.

### 4. Packaged Runtime Skills (`ws-memo` & `ws-session-tracking`)
- **Decision:** Package and ship `ws-memo` and `ws-session-tracking` directly in this repository (`.agents/skills/`).
- **Rationale:** Keeps `spec-memo` self-contained and allows agents in consumer projects to be instructed proactively to use `spec-memo` (via `install_skills` / `memo install-skills`) without touching or depending on global `workflow-skills`.

### 5. Multi-Deployment Mode Parity
- **Local Mode:** Reads/writes local `~/.spec-memo/` markdown files and `memo.sqlite`.
- **Hybrid Mode:** Writes locally, triggers debounced HTTP sync push to remote daemon, pulls remote updates on `bootstrap`/`sync`.
- **Remote Mode:** Stdio MCP proxy forwards `prompt` tool calls directly to remote daemon with zero local files.

---

## Deferred Ideas

1. **Automated Invoice PDF Exporter:** A plugin or helper script to convert `memo activity --json` output into PDF invoice templates.
2. **Token Cost Accounting:** Ingesting token consumption metrics from supported IDEs/APIs to compute dollar cost per feature delivery.
3. **Cross-Project Intent Graph:** Visualizing interconnected prompt patterns, derived rules, and task lifecycles across repositories in the Canvas viewer.
