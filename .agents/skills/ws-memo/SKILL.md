---
name: ws-memo
version: 0.14.0
description: >-
  Route agent working memory through spec-memo MCP (11 tools) and matching CLI extras.
  Trigger on memo vault, bootstrap brief, upsert trap/decision/spec/plan, search vault,
  prompt history, session tracking, promote ADR, check version, install skills,
  memo doctor, rank traps, canvas, serve --sse, status monitor, import/export vault,
  sync-vault, uninstall/teardown, or host MCP wiring / deployment mode (local, hybrid, remote)
  via memo setup. Not for first-time workflow-skills consumer enable or config.json
  (that is ws-spec-memo).
invocation_names:
  - ws-memo
  - memo
---

# ws-memo

> When this skill is loaded, output "ws-memo loaded."

**Runtime skill** shipped by [spec-memo](https://github.com/jpolvora/spec-memo). Guides agents to use the **MCP server (11 tools) + CLI (`memo`)** for out-of-repo working memory, diagnostics, and host deployment across **local**, **hybrid**, and **remote** modes.

Full tool/CLI parameter matrix → [`references/SURFACE.md`](references/SURFACE.md). Record schemas and git boundaries → [`references/RECORDS.md`](references/RECORDS.md). Host snippet → [`references/MCP-TEMPLATE.json`](references/MCP-TEMPLATE.json).

**Core Mission:** Provide high-precision, zero-leak, out-of-repo working memory. Never dump `.agents/plans/`, `MEMORY.md`, `.state.md`, or runtime logs into product git.

### Consumer handoff (workflow-skills)

If the product uses **workflow-skills** (`ws-shared/config.json` or skill `ws-spec-memo` is present):

| Need | Do |
|------|-----|
| First-time enable, `specMemo.*` / harness flags, import MEMORY, write-block hook, disable | **`/ws-spec-memo setup\|check\|import\|disable`** — do **not** write `specMemo.*` from this skill |
| Runtime vault ops after MCP is registered | Stay on **this skill** (`bootstrap`, `search`, `upsert`, …) |

Standalone spec-memo hosts (no workflow-skills) use CLI `memo setup` for **host MCP wiring and deployment mode** only — not as a substitute for `ws-spec-memo` harness config. Companion: [workflow-skills#253](https://github.com/jpolvora/workflow-skills/issues/253).

---

## 🎯 Zero-Shot First-Attempt Success Contract

Agents calling spec-memo MCP tools must follow this strict **Pre-Validation Protocol** to ensure every tool invocation succeeds on the first attempt without errors or model retry loops:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          AGENT PRE-FLIGHT CHECKLIST                             │
│  1. Check Required Arguments: never omit required fields (e.g. upsert.body)     │
│  2. Verify Key Types: pass arrays as arrays (e.g. kinds: ["trap"], not "trap")  │
│  3. Validate Closed Enums: verify kind, status, layer, format, and sort         │
│  4. Enforce Lookup Keys: get/forget require `id` OR (`kind` + `slug`)           │
│  5. Check Product Paths: promote/install_skills destination MUST be relative    │
│  6. Sanitize Secrets: NEVER include API keys, tokens, or PEM certs in payloads  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 The 11 MCP Tools: Pre-Validation & Calling Reference

All 11 MCP tools are available over MCP stdio (`memo serve`) or MCP SSE (`memo serve --sse`). CLI commands match tool names 1:1.

| # | MCP Tool | Purpose | Required Fields | Key Defaults & Enums |
|---|---|---|---|---|
| 1 | `bootstrap` | Session brief & traps | _(none)_ | `maxBytes`: 8192, `cwd`: current dir |
| 2 | `search` | FTS5 memory retrieval | _(none)_ | `sort`: `relevance`\|`occurrences`\|`updated` |
| 3 | `get` | Read single record | `id` **or** (`kind` + `slug`) | `kind`: closed enum of 10 kinds |
| 4 | `upsert` | Write memory record | `kind`, `body` | `kind`: 10 kinds; frontmatter optional |
| 5 | `append` | Write-only audit event | `event` | `kind`: defaults to `"log"` |
| 6 | `forget` | Archive or purge record | `id` **or** (`kind` + `slug`) | `purge`: boolean (default `false`) |
| 7 | `gc` | TTL & compaction | _(none)_ | `dryRun`: boolean (default `false`) |
| 8 | `promote` | Export to product repo | `destination` | `format`: `raw`\|`adr`\|`madr`\|`skill` |
| 9 | `check_version` | Compare package version | _(none)_ | Soft-fails offline |
| 10 | `install_skills` | Install runtime skill | _(none)_ | `skills`: `["ws-memo", "ws-session-tracking"]`, `skillsRoot`: `.agents/skills`, `global`: `$HOME/.agents/skills` (+ Antigravity if present) |
| 11 | `prompt` | Prompt ingestion & sessions | `action` (default: `record`) | 10 actions: `record`, `list`, `get`, `search`, `session`, `session_start`, `session_end`, `activity_report`, `derive_rules`, `export_story` |

---

### 1. `bootstrap`

**Job:** Bind repository identity, check drift, pull remote deltas (hybrid), and compile token-budgeted brief (traps, open decisions, live spec/plan).

#### Parameter Specification
- `cwd` (string, optional): Product working directory. Defaults to host `process.cwd()`.
- `query` (string, optional): Context query or task intent to filter traps/decisions.
- `slug` (string, optional): Active feature spec/plan slug identifier.
- `path` (string, optional): Focus file path (e.g. `src/auth.ts`) to prioritize matching traps by `pathPatterns`.
- `maxBytes` (number, optional): UTF-8 byte budget. Defaults to vault config (`bootstrap.maxBytes`, 8192).
- `projectId` (string, optional): Explicit project ID override.

#### Pre-Flight Checklist
- [ ] Pass `cwd` when calling from subagents or non-root directories.
- [ ] Pass `path` when modifying specific files to pull relevant anti-regression traps.
- [ ] If returned `truncated: true`, re-invoke with higher `maxBytes` (e.g. `16384`) if critical context was dropped.

#### MCP Calling Example
```json
{
  "cwd": "/path/to/repo",
  "path": "src/store/sqlite.ts",
  "slug": "feature-auth",
  "maxBytes": 16384
}
```

#### CLI Equivalent
```bash
memo bootstrap --path src/store/sqlite.ts --slug feature-auth --maxBytes 16384
```

---

### 2. `search`

**Job:** Filtered full-text search across vault records via SQLite FTS5 index. Excludes `scratch`, `logs`, and `review` by default.

#### Parameter Specification
- `query` (string, optional): Full-text search term or query string.
- `kinds` (string[], optional): Filter by record kind. Allowed values: `["trap", "decision", "spec", "plan", "state", "log", "scratch", "review"]`. **Must be an array of strings.**
- `status` (string, optional): Filter by status. Allowed: `"active"`, `"paused"`, `"shipped"`, `"superseded"`, `"archived"`.
- `tags` (string[], optional): Filter by tags. **Must be an array of strings.**
- `path` (string, optional): Match records whose `pathPatterns` cover this path.
- `includeScratch` (boolean, optional): Include `scratch` records (defaults to `false`).
- `sort` (string, optional): `"relevance"` (default), `"occurrences"`, or `"updated"`.
- `limit` (number, optional): Maximum results to return (positive integer).
- `crossProject` (boolean, optional): Search across all projects in the vault.
- `projectId` (string, optional): Target specific project ID.
- `cwd` (string, optional): Working directory for project resolution.

#### Pre-Flight Checklist
- [ ] `kinds` and `tags` MUST be arrays of strings (`["trap"]`), NOT single strings (`"trap"`).
- [ ] `sort` MUST be one of `"relevance"`, `"occurrences"`, or `"updated"`.
- [ ] For trap recurrence ranking, use `sort: "occurrences"` and `kinds: ["trap"]`.

#### MCP Calling Example
```json
{
  "query": "sqlite lock",
  "kinds": ["trap"],
  "sort": "occurrences",
  "path": "src/db/client.ts",
  "limit": 5
}
```

#### CLI Equivalent
```bash
memo search "sqlite lock" --kind trap --sort occurrences --path src/db/client.ts --limit 5
```

---

### 3. `get`

**Job:** Retrieve the complete markdown record, YAML frontmatter, and body of a single vault record.

#### Parameter Specification
- `id` (string, optional): Unique record ID (e.g. `trap-sqlite-wal-lock`).
- `kind` (string, optional): Record kind (`"trap"`, `"decision"`, `"spec"`, `"plan"`, `"state"`, `"log"`, `"scratch"`, `"review"`).
- `slug` (string, optional): Record slug (e.g. `sqlite-wal-lock`).
- `cwd` (string, optional): Product working directory.
- `projectId` (string, optional): Target project ID.

#### Pre-Flight Checklist
- [ ] **Mandatory Rule:** You MUST provide either `id` OR both `kind` and `slug`. Calling `get` without both will return `INVALID_ARGUMENTS`.
- [ ] If record is not found, the tool returns `RECORD_NOT_FOUND`. Do NOT invent placeholder content.

#### MCP Calling Example
```json
{
  "id": "trap-sqlite-wal-lock"
}
```
*Or by kind + slug:*
```json
{
  "kind": "trap",
  "slug": "sqlite-wal-lock"
}
```

#### CLI Equivalent
```bash
memo get --id trap-sqlite-wal-lock
memo get --kind trap --slug sqlite-wal-lock
```

---

### 4. `upsert`

**Job:** Write, update, or supersede a memory record. Automatically updates FTS5 index, re-compiles Markdown views, and schedules hybrid background sync.

#### Parameter Specification
- `kind` (string, **required**): One of `"trap"`, `"decision"`, `"spec"`, `"plan"`, `"state"`, `"log"`, `"scratch"`, `"review"`.
- `body` (string, **required**): Non-empty markdown content.
- `slug` (string, optional): Identifier slug. Auto-derived from title/content if omitted.
- `frontmatter` (object, optional):
  - `title` (string): Human-readable title.
  - `severity` (string): `"low"`, `"medium"`, `"high"`, `"critical"`.
  - `layer` (string): `"application"`, `"domain"`, `"web"`, `"infrastructure"`, `"tests"`, `"devops"`, `"other"`. (Note: `"frontend"` maps to `"web"`, `"backend"` to `"application"`; `"security"` belongs in `tags`).
  - `module` (string): Subsystem or component name.
  - `pathPatterns` (string[]): Glob patterns matching affected files (e.g. `["src/db/**/*.ts"]`).
  - `tags` (string[]): Taxonomy tags (e.g. `["security", "sqlite"]`).
  - `occurrences` (number): Recurrence count (integer >= 1).
  - `supersedes` (string): ID of older record being superseded.
  - `linkedPaths` (string[]): File paths related to this spec/decision.
  - `verifiedAtSha` (string): Git commit SHA validating this spec/record.
- `cwd` (string, optional): Product working directory.
- `projectId` (string, optional): Explicit project ID.

#### Pre-Flight Checklist
- [ ] `kind` and `body` are **mandatory** and non-empty.
- [ ] Never include secrets (tokens, API keys, private keys) in body or frontmatter — payloads matching secret patterns are rejected (`SAFETY_VIOLATION`).
- [ ] For **traps**, follow the standard structured template (use ISO datetime or date in heading; frontmatter created/updated/lastSeen track exact UTC ISO datetime):

```markdown
### [YYYY-MM-DDTHH:mm:ssZ] Short descriptive title
- **Layer**: Application
- **Module**: subsystem / component
- **Severity**: High
- **PathPattern**: src/path/**/*.ts
- **Scenario / Context**: When X occurs under condition Y...
- **DO NOT**: Anti-pattern action to avoid.
- **INSTEAD DO**: Correct implementation / workaround.
```

*(Note: `### [YYYY-MM-DD]` is also accepted as shorthand; full ISO datetime `[YYYY-MM-DDTHH:mm:ssZ]` is recommended for precise resolution.)*

#### MCP Calling Example
```json
{
  "kind": "trap",
  "slug": "windows-sqlite-close-before-unlink",
  "frontmatter": {
    "title": "Close SQLite DB before unlink on Windows",
    "severity": "critical",
    "layer": "infrastructure",
    "module": "sqlite",
    "pathPatterns": ["src/db/**/*.ts", "src/**/*.test.ts"],
    "tags": ["sqlite", "windows", "locks"]
  },
  "body": "### [2026-08-27T19:47:16Z] Close SQLite DB before unlink on Windows\n- **Layer**: Infrastructure\n- **Module**: sqlite\n- **Severity**: Critical\n- **PathPattern**: src/db/**/*.ts\n- **Scenario / Context**: On Windows, deleting a SQLite database file while handles remain open causes EBUSY / EPERM.\n- **DO NOT**: Delete temporary database directories before explicitly closing database handles.\n- **INSTEAD DO**: Always invoke `closeIndex()` or `db.close()` in test `afterEach` hooks before directory cleanup."
}
```

#### CLI Equivalent
```bash
memo upsert --kind trap --slug windows-sqlite-close-before-unlink --title "Close SQLite DB before unlink on Windows" --severity critical --body "..."
```

---

### 5. `append`

**Job:** Append a write-only audit event, task completion marker, or execution log entry. Never rewrites existing history.

#### Parameter Specification
- `event` (string, **required**): Non-empty description of the event or milestone.
- `kind` (string, optional): Record kind. Defaults to `"log"`.
- `details` (object, optional): Structured context or metadata object.
- `cwd` (string, optional): Product working directory.
- `projectId` (string, optional): Target project ID.

#### Pre-Flight Checklist
- [ ] `event` is **mandatory** and must be a non-empty string.
- [ ] Use `append` for audit trails and milestone records; do NOT use `upsert` for logging.

#### MCP Calling Example
```json
{
  "event": "Completed surgical delivery of auth slice and verified all 273 tests pass",
  "details": {
    "slice": "slice-auth-jwt",
    "testCount": 273,
    "pass": true
  }
}
```

#### CLI Equivalent
```bash
memo append --event "Completed surgical delivery of auth slice"
```

---

### 6. `forget`

**Job:** Soft-archive (`status: "archived"`) or permanently purge a memory record.

#### Parameter Specification
- `id` (string, optional): Record ID to archive/purge.
- `kind` (string, optional): Record kind (when using `kind` + `slug`).
- `slug` (string, optional): Record slug (when using `kind` + `slug`).
- `purge` (boolean, optional): Set `true` to permanently delete the markdown file. Defaults to `false` (soft-archive).
- `cwd` (string, optional): Product working directory.
- `projectId` (string, optional): Target project ID.

#### Pre-Flight Checklist
- [ ] Provide `id` OR (`kind` + `slug`).
- [ ] `purge: true` permanently destroys file data. **Never pass `purge: true` without explicit user confirmation.**

#### MCP Calling Example
```json
{
  "id": "scratch-temp-draft-notes"
}
```
*Permanent purge (with confirmation):*
```json
{
  "id": "scratch-temp-draft-notes",
  "purge": true
}
```

#### CLI Equivalent
```bash
memo forget --id scratch-temp-draft-notes
memo forget --id scratch-temp-draft-notes --purge
```

---

### 7. `gc`

**Job:** Clean up expired records (7-day scratch, 14-day review TTL), compact shipped plans into one-line summaries, roll up monthly logs, and rebuild SQLite FTS5 index.

#### Parameter Specification
- `dryRun` (boolean, optional): Set `true` to preview what would be cleaned without modifying files. Defaults to `false`.
- `projectId` (string, optional): Clean specific project (defaults to current project).
- `cwd` (string, optional): Product working directory.

#### Pre-Flight Checklist
- [ ] Recommended: run with `dryRun: true` first to inspect cleanup candidates before applying mutations.

#### MCP Calling Example
```json
{
  "dryRun": true
}
```

#### CLI Equivalent
```bash
memo gc --dry-run
memo gc
```

---

### 8. `promote`

**Job:** Export a vault record (or top ranked traps) into the product repository as durable documentation (ADR, Markdown, or Skill).

#### Parameter Specification
- `destination` (string, **required**): Product-relative destination file path (e.g. `docs/adr/001-auth.md` or `.agents/skills/ws-recurrence/SKILL.md`).
- `id` (string, optional): Record ID to promote. Omit when `format: "skill"` to export top ranked traps.
- `kind` (string, optional): Record kind (when using `kind` + `slug`).
- `slug` (string, optional): Record slug (when using `kind` + `slug`).
- `format` (string, optional): Output format. Allowed values: `"raw"`, `"adr"`, `"madr"`, `"skill"`.
- `force` (boolean, optional): Overwrite existing destination file. Defaults to `false`.
- `limit` (number, optional): Number of top ranked traps to compile when `format: "skill"` and `id` is omitted (default: 10).
- `cwd` (string, optional): Product working directory.

#### Pre-Flight Checklist
- [ ] `destination` is **mandatory** and MUST be product-relative (e.g. `docs/adr/001.md`).
- [ ] **Safety Violation (Default Deny):** Destination cannot be absolute, outside the product root, or under `.git/`.
- [ ] When compiling top ranked traps (`format: "skill"` without `id`), fails closed if 0 active traps rank (does not write empty headers).

#### MCP Calling Example
```json
{
  "format": "skill",
  "destination": ".agents/skills/ws-recurrence/SKILL.md",
  "limit": 10,
  "force": true
}
```
*Promoting an Architecture Decision Record:*
```json
{
  "id": "decision-use-sqlite-fts5",
  "destination": "docs/adr/002-fts5.md",
  "format": "adr",
  "force": true
}
```

#### CLI Equivalent
```bash
memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md
memo promote --id decision-use-sqlite-fts5 --to docs/adr/002-fts5.md --format adr
```

---

### 9. `check_version`

**Job:** Compare the currently running `spec-memo` package version against the latest release on npm.

#### Parameter Specification
- None. Accepts `{}`.

#### Pre-Flight Checklist
- [ ] No arguments required.
- [ ] Soft-fails offline with `updateAvailable: "unknown"` and `source: "offline"`.

#### MCP Calling Example
```json
{}
```

#### CLI Equivalent
```bash
memo check-version --json
```

---

### 10. `install_skills`

**Job:** Install or update packaged runtime skill(s) (`ws-memo`, `ws-session-tracking`) into a consumer product repository (default), or into global skills roots with `global: true`.

#### Parameter Specification
- `productRoot` (string, optional): Consumer product repository root directory (local mode).
- `cwd` (string, optional): Working directory used to resolve product root when `productRoot` is omitted.
- `skills` (string[], optional): Skill IDs to install. Defaults to `["ws-memo", "ws-session-tracking"]`.
- `skillsRoot` (string, optional): Relative destination under product root (default: `".agents/skills"`). Ignored when `global` is true.
- `force` (boolean, optional): Overwrite destination when it differs from the packaged skill (default: `false`).
- `global` (boolean, optional): Install into `$HOME/.agents/skills` (always created) and `$HOME/.gemini/config/skills` when Antigravity/Gemini `~/.gemini/config` exists (skipped otherwise). Default: `false` (local product install).

#### Pre-Flight Checklist
- [ ] Only packaged runtime skills (`"ws-memo"`, `"ws-session-tracking"`) are accepted. Unknown skill IDs fail closed.
- [ ] Local: destination must be inside the product repository and outside `.git/`.
- [ ] Global: `productRoot` not required; Antigravity target is skipped (not created) when missing.

#### MCP Calling Example
```json
{
  "productRoot": "/path/to/consumer-app",
  "skills": ["ws-memo", "ws-session-tracking"],
  "force": true
}
```

```json
{
  "global": true,
  "force": true
}
```

#### CLI Equivalent
```bash
memo install-skills --product-root /path/to/consumer-app --force
memo install-skills --global --force
```

---

### 11. `prompt`

**Job:** Ingest prompt turns, track session lifecycles, query prompts, derive AI rules, export intent stories, and generate activity/invoicing reports.

#### Parameter Specification
- `action` (string, optional): `"record"`, `"list"`, `"get"`, `"search"`, `"session"`, `"session_start"`, `"session_end"`, `"activity_report"`, `"derive_rules"`, `"export_story"` (default: `"record"`).
- `body` (string, optional): Prompt content or work summary.
- `id` (string, optional): Unique record ID.
- `sessionId` (string, optional): Session correlation identifier.
- `turn` (number, optional): Turn number in session.
- `taskSlug` (string, optional): Feature or task slug.
- `client` (string, optional): Client or account identifier.
- `billable` (boolean, optional): Whether session/prompt is billable (default: `true`).
- `ide` (string, optional): Host environment / IDE (`cursor`, `vscode`, `claude`, `gemini`, `antigravity`, etc.).
- `model` (string, optional): Model identifier.
- `agent` (string, optional): Agent role or name.
- `deliverables` (array, optional): Completed deliverables (`[{ type: "pr"|"commit"|"spec", url, sha, title }]`).
- `query` (string, optional): FTS query term.
- `since` / `until` (string, optional): ISO date bounds.
- `saveTraps` (boolean, optional): Save derived rules as traps in vault (for `derive_rules`).
- `promote` (string, optional): Destination file path to export rules or stories to.

#### MCP Calling Example
```json
{
  "action": "record",
  "sessionId": "session-1740000000-a1b2",
  "turn": 1,
  "taskSlug": "feature-oauth-refresh",
  "client": "acme-corp",
  "body": "Add support for OAuth2 token refresh."
}
```

#### CLI Equivalent
```bash
memo prompt record --session-id session-1740000000-a1b2 --turn 1 --body "Add support for OAuth2 token refresh."
memo session start session-1740000000-a1b2 --task-slug feature-oauth-refresh
memo prompt derive-rules --session-id session-1740000000-a1b2 --save-traps
memo activity --client acme-corp
```

---

## 🛠️ CLI-Only Extras Reference

These capabilities are available exclusively via the CLI binary (`memo <command>` or `node dist/cli.js <command>`):

| CLI Command | Description & Flags |
|---|---|
| `memo status` | **Operational status & config inspector:** Read-only dashboard, live daemon probes (SSE `:3123`, Status companion `:3124`, Canvas `:3125`, remote `/health`), active project record breakdown, and storage metrics. Aliases: `info`, `state`, `setup --check`. Flags: `--check`, `--json`, `--cwd`, `--vaultRoot`. |
| `memo setup` | **Host/deployment only:** mode (`local`, `hybrid`, `remote`) & host MCP wiring (`cursor`, `vscode`, `opencode`, `antigravity`, `claude`, `generic`). Does **not** write workflow-skills `{sharedDir}/config.json` / `specMemo.*` — use `ws-spec-memo` for that. Flags: `--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`, `--json`. |
| `memo doctor` | Vault health, project identity, FTS5 integrity, and in-repo pollution scan. Flags: `--rebuild` (re-index FTS), `--fix` (delete forbidden in-repo files), `--json`. |
| `memo rank` | Recurrence-ranked traps report by occurrence count. Flags: `--layer <name>`, `--limit <n>`, `--backfill`, `--json`. |
| `memo canvas` | Launch graph visualizer dashboard (default port `3125`, configurable via `config.json` `ports.canvas`). Flags: `--port`, `--host`, `--project`. |
| `memo serve` | Start MCP transport. Stdio (default) or HTTP/SSE (`--sse` port `3123`, status companion `:3124`, configurable via `config.json` `ports.sse` / `ports.status`). Off-loopback requires `--auth-token` or `SPEC_MEMO_AUTH_TOKEN`. |
| `memo hook install` | Install Git pre-commit write-block hook to block `.agents/plans/`, `MEMORY.md`, `.state.md`. Bypass: `SKIP_MEMO_HOOK=1`. |
| `memo sync` | Hybrid bidirectional HTTP delta sync with remote daemon (`--all`, `--dry-run`), or vault Git push/pull. |
| `memo sync-vault` | Peer-to-peer vault directory delta sync (`memo sync-vault <target> [--two-way] [--dry-run]`). |
| `memo export-vault` | Export encrypted/portable vault archive (`--password`, `--output`, `--project`). |
| `memo import-vault` | Restore vault archive (`--password`, `--archive`, `--overwrite`). |
| `memo import` | Ingest legacy in-tree memory files (`memo import --from <repoRoot>`). |

---

## 🛡️ Error Logging & Server Crash Protection

`spec-memo` implements complete fail-safe crash protection across stdio, SSE, and remote proxy transports:

1. **Crash Guard:** Unhandled exceptions in tool execution or handlers are caught, logged, and formatted into clean `{ isError: true, error: ..., code: "..." }` responses. The MCP connection is NEVER dropped or crashed.
2. **Error Log Location:** All tool execution errors, validation rejections, and server diagnostics are automatically appended to `<vaultRoot>/error.logs` (or path specified by `SPEC_MEMO_ERROR_LOG`).
3. **Secret Redaction:** Passwords, bearer tokens, API keys, and private keys are strictly scrubbed before writing to error logs.
4. **Diagnostics:** Inspect error logs via `readErrorLogs()` or check daemon health with `memo doctor`.

---

## 📋 Session Router: Fast Intent Mapping

Match user intent to the correct action:

| Intent | Action | Command / MCP Tool |
|---|---|---|
| First-time enable / `config.json` / import MEMORY (workflow-skills consumer) | **handoff** | `/ws-spec-memo setup\|check\|import\|disable` — do not write `specMemo.*` here |
| Host MCP wiring / deployment mode (standalone host) | **host-setup** | CLI `memo setup` (`--mode`, `--write-mcp`) — not harness `config.json` |
| Session start / brief / traps | **session** | MCP `bootstrap` (`cwd: "."`) |
| Find / read memory records | **recall** | MCP `search` → MCP `get` |
| Record trap, decision, spec, plan | **remember** | MCP `upsert` (strict trap format) |
| Task-done / audit log | **log** | MCP `append` (`event: "..."`) |
| Operational status & daemon check | **status** | CLI `memo status` (`--check`, `--json`) |
| Vault health & pollution check | **diagnose** | CLI `memo doctor` (`--fix` to clean residue) |
| TTL cleanup & compaction | **maintain** | MCP `gc` (`dryRun: true` first) |
| Export documentation / skill | **publish** | MCP `promote` (`destination: "..."`) |
| Package version check | **version** | MCP `check_version` |
| Install runtime skill in consumer | **install** | MCP `install_skills` (`productRoot: "."`) or `global: true` / CLI `--global` |
| Visual graph UI | **observe** | CLI `memo canvas` |
| Start SSE daemon + status UI | **serve** | CLI `memo serve --sse --status-port 3124` |
| Pre-commit write guard | **guard** | CLI `memo hook install` |
