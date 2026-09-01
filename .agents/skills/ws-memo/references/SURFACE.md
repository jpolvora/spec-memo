# spec-memo MCP + CLI surface

**Audience:** agents running `ws-memo`. Product SoT remains [`AGENTS.md`](../../../../AGENTS.md) / [`FEATURES.md`](../../../../FEATURES.md).

Transport: MCP stdio (`memo serve`) or SSE (`memo serve --sse`). Tool names match CLI commands 1:1 for the ten core tools (CLI also accepts kebab aliases `check-version` / `install-skills`).

## Ten MCP Tools

Further growth needs a PRODUCT.PRD §6 amendment. Do not invent tools outside this list.

### 1. `bootstrap`

Bind cwd git remote; check code drift; compile a token-budgeted session brief.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `cwd` | string | Optional | Product working directory (defaults to current dir) |
| `query` | string | Optional | Intent filter for traps/decisions |
| `slug` | string | Optional | Active feature spec/plan slice identifier |
| `path` | string | Optional | Prioritize traps whose `pathPatterns` match this file |
| `maxBytes` | number | Optional | UTF-8 byte budget for the entire brief payload (positive integer) |
| `projectId` | string | Optional | Override bound project |

**Budget precedence** (first match wins): per-call `maxBytes` → vault `config.json` `bootstrap.maxBytes` (8192 default) → hard fallback 8192.

Over budget → drop lowest-rank hits, set `truncated: true`. Retry with a higher `maxBytes` (e.g. 16384) when critical context was dropped.

Returns: traps (medium+, path/keyword, cap 10), matching accepted decisions, live spec/plan for slug, drift flags, `truncated` notice.

CLI:
```bash
memo bootstrap --slug feature-auth --path src/auth.ts
memo bootstrap --maxBytes 16384 --path src/auth.ts
```

---

### 2. `search`

Filtered SQLite FTS5 full-text retrieval. Default excludes `scratch`, `state`, `log`, `review` unless specified in `kinds` or `includeScratch: true`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `query` | string | Optional | Search term or FTS query |
| `kinds` | string[] | Optional | Array of: `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review` |
| `status` | string | Optional | Enum: `active`, `paused`, `shipped`, `superseded`, `archived` |
| `tags` | string[] | Optional | Array of tags to filter |
| `path` | string | Optional | `pathPatterns` glob match (e.g. `src/db/client.ts`) |
| `includeScratch` | boolean | Optional | Include scratch records (defaults to `false`) |
| `crossProject` | boolean | Optional | Search across all bound projects in vault |
| `projectId` | string | Optional | Target specific project ID |
| `limit` | number | Optional | Max results to return (positive integer) |
| `sort` | string | Optional | Enum: `relevance` (default), `occurrences`, `updated` |
| `cwd` | string | Optional | Product working directory |

CLI:
```bash
memo search "database lock" --kind trap --path src/db/client.ts --sort occurrences
```

---

### 3. `get`

Read one record by unique `id` **or** `kind` + `slug`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | string | Conditional | Unique record ID (e.g. `trap-sqlite-wal-lock`). Required if `kind`+`slug` omitted. |
| `kind` | string | Conditional | Record kind enum. Required if `slug` provided without `id`. |
| `slug` | string | Conditional | Record slug identifier. Required if `kind` provided without `id`. |
| `cwd` | string | Optional | Product working directory |
| `projectId` | string | Optional | Specific project ID |

*Pre-validation rule:* Either `id` OR (`kind` AND `slug`) must be provided, or `INVALID_ARGUMENTS` is returned.

CLI:
```bash
memo get --id trap-sqlite-wal-lock
memo get --kind trap --slug sqlite-wal-lock
```

---

### 4. `upsert`

Write or update a memory record (trap, decision, spec, plan, state, review, scratch). Updates FTS5 and compiled views; schedules hybrid debounced push when `mode: hybrid`. With `vaultGit.enabled`, batched mode (default `atomic: false`) defers git commit until flush; `atomic: true` commits+syncs fail-open per mutation.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | **Required** | Enum: `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review` |
| `body` | string | **Required** | Non-empty Markdown content (use `DO NOT` / `INSTEAD DO` for traps) |
| `slug` | string | Optional | Identifier slug (auto-derived if omitted) |
| `frontmatter` | object | Optional | Metadata (see [`RECORDS.md`](RECORDS.md) for full schema) |
| `cwd` | string | Optional | Product working directory |
| `projectId` | string | Optional | Specific project ID |

Frontmatter fields: `title`, `severity` (`low`/`medium`/`high`/`critical`), `layer` (`application`/`domain`/`web`/`infrastructure`/`tests`/`devops`/`other`), `module`, `pathPatterns` (string[]), `tags` (string[]), `occurrences` (integer >= 1), `supersedes` (string), `linkedPaths` (string[]), `verifiedAtSha` (string).

Secret-shaped bodies are rejected with `SAFETY_VIOLATION` (PEM, `api_key=`, tokens).

CLI:
```bash
memo upsert --kind trap --title "Close SQLite DB before unlink on Windows" --severity critical --path-patterns "src/**/*.ts" --body "..."
```

---

### 5. `append`

Write-only event or log entry.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `event` | string | **Required** | Non-empty event description or log text |
| `kind` | string | Optional | Log kind (defaults to `log`) |
| `details` | object | Optional | Structured JSON event context |
| `cwd` | string | Optional | Product working directory |
| `projectId` | string | Optional | Specific project ID |

CLI:
```bash
memo append --event "Successfully executed slice-17 tests"
```

---

### 6. `forget`

Soft-archive by default (`status: "archived"`). Permanent deletion (`purge: true`) requires explicit user confirmation.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | string | Conditional | Unique record ID. Required if `kind`+`slug` omitted. |
| `kind` | string | Conditional | Record kind enum. Required if `slug` provided without `id`. |
| `slug` | string | Conditional | Record slug identifier. Required if `kind` provided without `id`. |
| `purge` | boolean | Optional | `true` for permanent delete; `false` for soft-archive (default `false`) |
| `cwd` | string | Optional | Product working directory |
| `projectId` | string | Optional | Specific project ID |

*Pre-validation rule:* Either `id` OR (`kind` AND `slug`) must be provided.

CLI:
```bash
memo forget --id scratch-temp-notes --purge
```

---

### 7. `gc`

Apply TTL retention (7d scratch, 14d review), compact shipped plans, roll up monthly logs, and rebuild FTS5 index.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `dryRun` | boolean | Optional | Set `true` to preview without modifying files (defaults to `false`) |
| `projectId` | string | Optional | Specific project ID |
| `cwd` | string | Optional | Product working directory |

CLI:
```bash
memo gc --dry-run
memo gc
```

---

### 8. `promote`

Copy a vault record or top ranked traps into the **product** tree. **Default deny** without a valid product-relative `destination`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `destination` | string | **Required** | Product-relative destination path (e.g. `docs/adr/001.md` or `.agents/skills/ws-recurrence/SKILL.md`) |
| `id` | string | Optional | Record ID to promote. Omit when `format: "skill"` to export ranked traps. |
| `kind` | string | Optional | Record kind (when using `kind`+`slug`) |
| `slug` | string | Optional | Record slug (when using `kind`+`slug`) |
| `format` | string | Optional | Enum: `raw`, `adr`, `madr`, `skill` |
| `force` | boolean | Optional | Overwrite existing destination file |
| `limit` | number | Optional | Top N traps when `format: "skill"` and `id` omitted (default 10) |
| `cwd` | string | Optional | Product working directory |

*Safety rule:* Destination must NOT be absolute, outside the product root, or under `.git/`.

CLI:
```bash
memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md
```

---

### 9. `check_version`

Compare running package version to npm `latest`. Soft-fails offline (`updateAvailable: "unknown"`, `latest: null`, `source: "offline"`).

| Arg | Type | Required | Notes |
|---|---|---|---|
| _(none)_ | | | No arguments |

Returns: `current`, `latest`, `updateAvailable` (`true` \| `false` \| `"unknown"`), `source` (`npm` \| `offline`).

CLI:
```bash
memo check-version --json
```

---

### 10. `install_skills`

Install packaged runtime skills (`ws-memo`, `ws-session-tracking`) into a consumer product tree, or into global skills roots with `global: true`.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `productRoot` | string | Optional | Preferred consumer product repository root (local mode) |
| `cwd` | string | Optional | Working directory to resolve product root when omitted |
| `skills` | string[] | Optional | Skill IDs (default `["ws-memo", "ws-session-tracking"]`) |
| `skillsRoot` | string | Optional | Relative skills directory (default `.agents/skills`); ignored when `global` |
| `force` | boolean | Optional | Overwrite destination when it differs |
| `global` | boolean | Optional | Install to `$HOME/.agents/skills` (always) and `$HOME/.gemini/config/skills` when Antigravity/Gemini config exists |

CLI:
```bash
memo install-skills --product-root <path> [--skills ws-memo,ws-session-tracking] [--force] [--json]
memo install-skills --global [--force] [--json]
```

---

## CLI-only Extras (Not MCP Tools)

| Command | Job |
|---|---|
| `memo status` | Query read-only operational dashboard, daemon reachability probes, configuration, and storage statistics (aliases: `info`, `state`, `setup --check`). `--json`, `--check`. |
| `memo setup` | Configure deployment mode (`local`, `hybrid`, `remote`) and host MCP snippets (`cursor`, `vscode`, `opencode`, `antigravity`, `claude`, `generic`). `--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`, `--json`. |
| `memo serve` | Stdio MCP (default). In remote mode, proxies over stdio to remote daemon. `--sse` HTTP SSE on `--port` (default 3123, configurable via `config.json` `ports.sse`). Status companion co-starts with `--sse` unless `--no-status`; stdio opt-in via `--status` / `--status-port` (default 3124, configurable via `config.json` `ports.status`). `--host` (default 127.0.0.1). `--auth-token` / `SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_SSE_TOKEN` required off-loopback. |
| `memo canvas` | Graph UI default port 3125 (configurable via `config.json` `ports.canvas`). `--project`, `--host`, `--json`. (Not available in remote mode). |
| `memo doctor [productRoot]` | Vault + FTS + pollution + mode + remote health + hybrid state. `--rebuild` FTS. `--fix` delete leftover in-repo residue. `--json`. |
| `memo rank` | Active traps by `occurrences`. `--layer` `--limit` `--backfill` `--json`. Proxies in remote mode. |
| `memo import` | Legacy `.agents` / `memory/` / plans → vault. `--from`. |
| `memo hook install` | Pre-commit write-block. `--productRoot`. Bypass: `SKIP_MEMO_HOOK=1`. (Not available in remote mode). |
| `memo sync` | Hybrid HTTP and/or vault-git. Dual-mode runs both in parallel. Batched vault-git (`atomic: false`, default) flushes on sync, session_end, and serve shutdown. |
| `memo sync-vault <target>` | Peer vault delta sync. `--two-way` `--dry-run`. (Not available in remote mode). |
| `memo export-vault` / `memo import-vault` | Portable archive; optional AES-256-GCM. Prefer `SPEC_MEMO_VAULT_PASSWORD`. (Not available in remote mode). |

---

## Deployment Modes

- **`local` (default):** Everything stored and queried directly on the local machine under `~/.spec-memo/`. Zero network requirements.
- **`hybrid`:** Local vault is authoritative; transparently pulls deltas on `bootstrap` and debounces pushes on mutating operations. Manual sync via `memo sync`. Fails open if remote daemon is unreachable. When `vaultGit.enabled` is also set, `memo sync` / `session_end` / serve shutdown run hybrid HTTP and vault-git in parallel.
- **`remote`:** Local agent hosts connect to local `memo serve` stdio proxy, which forwards all 11 tools to a shared remote daemon. Local disk stores no memory records. Fails closed if remote daemon is unreachable.

### Vault-git (`config.json` → `vaultGit`)

Private git remote backup of the vault root. `atomic` defaults `false` (batched): flush events are `memo sync`, MCP/CLI `prompt` `session_end`, and graceful `memo serve` shutdown. `atomic: true` = per-mutation commit + remote sync (fail-open). Legacy `autoCommit` aliases `atomic` when `atomic` is omitted. Status: `memo status` → `Enabled (atomic|batched)`; doctor JSON includes redacted `dirty` / `lastError`.

### Default Ports & Configurable Values

All ports can be customized in `~/.spec-memo/config.json` under `"ports"` (`sse`, `status`, `canvas`, with aliases `mcp`, `ui`):

| Service | Port | Start |
|---|---|---|
| MCP SSE | 3123 | `memo serve --sse` |
| Status monitor | 3124 | co-starts with `--sse` unless `--no-status` |
| Canvas | 3125 | `memo canvas` |

---

## Error Logs & Protection

Unexpected errors, invalid argument rejections, and server diagnostics are logged to `<vaultRoot>/error.logs` (or `SPEC_MEMO_ERROR_LOG`).
MCP server connections are crash-proof: unhandled tool exceptions return `{ isError: true, error: ..., code: "..." }` and do not drop the MCP connection.
