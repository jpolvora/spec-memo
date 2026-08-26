# spec-memo MCP + CLI surface

**Audience:** agents running `ws-memo`. Product SoT remains [`AGENTS.md`](../../../../AGENTS.md) / [`FEATURES.md`](../../../../FEATURES.md).

Transport: MCP stdio (`memo serve`) or SSE (`memo serve --sse`). Tool names match CLI commands 1:1 for the eight core tools.

## Eight MCP tools (frozen)

Do not add a ninth tool without a PRODUCT.PRD §6 amendment.

### `bootstrap`

Bind cwd git remote; compile a session brief.

| Arg | Type | Notes |
|-----|------|--------|
| `cwd` | string | Product working directory (default current) |
| `query` | string | Intent filter for traps/decisions |
| `slug` | string | Live spec/plan slice |
| `path` | string | Prioritize traps whose pathPatterns match |
| `maxBytes` | number | UTF-8 budget, default 8192 |
| `projectId` | string | Override bound project |

Returns: traps (medium+, path/keyword, cap 10), matching accepted decisions, live spec/plan for slug, drift flags, `truncated` notice.

CLI: `memo bootstrap --slug feature-auth --path src/auth.ts`

### `search`

FTS5 retrieval. Default excludes `scratch`, `state`, `log`, `review` unless `kinds` or `includeScratch`.

| Arg | Type | Notes |
|-----|------|--------|
| `query` | string | FTS query |
| `kinds` | string[] | `trap` `decision` `spec` `plan` `state` `log` `scratch` `review` |
| `status` | string | `active` `paused` `shipped` `superseded` `archived` |
| `tags` | string[] | |
| `path` | string | pathPatterns glob match |
| `includeScratch` | boolean | |
| `crossProject` | boolean | All bound projects |
| `projectId` | string | |
| `limit` | number | |
| `sort` | enum | `relevance` (default) \| `occurrences` \| `updated` |
| `cwd` | string | |

CLI: `memo search "database lock" --kind trap --path src/db/client.ts --sort occurrences`

### `get`

One record by `id` **or** `kind`+`slug`.

CLI: `memo get --id trap-sqlite-wal-lock`

### `upsert`

Write/update. Required: `kind`, `body`. Optional: `slug`, `frontmatter` object.

Frontmatter commonly used: `id`, `title`, `severity` (`low`/`medium`/`high`/`critical`), `pathPatterns`, `tags`, `layer`, `module`, `occurrences`, `lastSeen`, `supersedes`, `linkedPaths`, `verifiedAtSha`, `status`, `source`.

Schema failure → error, no write. Secret-shaped bodies are rejected (PEM, `api_key=`, env-file patterns). Omit secrets; spec-memo does not store a redacted copy.

CLI:

```bash
memo upsert --kind trap --title "Close SQLite DB before unlink on Windows" --severity critical --path-patterns "src/**/*.ts" --body "..."
```

### `append`

Write-only event. Required: `event`. Optional: `kind` (default `log`), `details`.

CLI: `memo append --event "Successfully executed slice-17 tests"`

### `forget`

Soft-archive by default. `purge: true` permanently deletes — only with explicit user confirm. Traps archive unless purge is confirmed.

CLI: `memo forget --id scratch-temp-notes --purge`

### `gc`

TTL (scratch 7d, review 14d), compact `status=shipped` plans, monthly log roll-up, rebuild FTS.

| Arg | Type | Notes |
|-----|------|--------|
| `dryRun` | boolean | Report only |
| `projectId` | string | Scope |
| `cwd` | string | |

CLI: `memo gc --dry-run`

### `promote`

Copy into the **product** tree. **Default deny** without `destination` inside the product root (not under `.git/`).

| Arg | Type | Notes |
|-----|------|--------|
| `destination` | string | Required, product-relative |
| `id` / `kind`+`slug` | | Record to copy; omit `id` when `format=skill` |
| `format` | enum | `raw` \| `adr` \| `madr` \| `skill` |
| `force` | boolean | Overwrite existing dest |
| `limit` | number | Top N traps for `format=skill` (default 10) |

CLI: `memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md`

## CLI-only (not MCP tools)

| Command | Job |
|---------|-----|
| `memo serve` | Stdio MCP (default). `--sse` HTTP SSE on `--port` (default 3000). `--status-port` (default 3001). `--no-status`. `--host` (default 127.0.0.1). `--auth-token` / `SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_SSE_TOKEN` required off-loopback. |
| `memo canvas` | Graph UI default port 4100. `--project`, `--host`, `--json`. |
| `memo doctor [productRoot]` | Vault + FTS + pollution. `--rebuild` FTS. `--fix` delete leftover in-repo residue. `--json`. |
| `memo rank` | Active traps by `occurrences`. `--layer` `--limit` `--backfill` `--json`. Same ranking as `search.sort=occurrences`. |
| `memo import` | Legacy `.agents` / `memory/` / plans → vault. `--from`. |
| `memo hook install` | Pre-commit write-block. `--productRoot`. Bypass: `SKIP_MEMO_HOOK=1`. |
| `memo sync` | Push vault git remote when vault-git enabled. |
| `memo sync-vault <target>` | Peer vault delta sync. `--two-way` `--dry-run`. |
| `memo export-vault` / `memo import-vault` | Portable archive; optional AES-256-GCM. Prefer `SPEC_MEMO_VAULT_PASSWORD`. |

Global: `--json` on stdout; help/errors on stderr. `--vaultRoot` / `$SPEC_MEMO_ROOT` (default `~/.spec-memo`).

### Default ports

| Service | Port | Start |
|---------|------|--------|
| MCP SSE | 3000 | `memo serve --sse` |
| Status monitor | 3001 | co-starts with `--sse` unless `--no-status` |
| Canvas | 4100 | `memo canvas` |

Status page: vault list, health, live activity (`GET /api/events/stream`). Read-only.

## Host registration

See [`MCP-TEMPLATE.json`](MCP-TEMPLATE.json). Typical Cursor `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "memo",
      "args": ["serve"]
    }
  }
}
```

## Explicit non-goals

- Ninth MCP tool to list vault files (use `search`).
- Auto-rewrite specs on code change (drift is a flag).
- Auto-promote into README.
- Bundling the vault inside the product clone.
