# spec-memo MCP + CLI surface

**Audience:** agents running `ws-memo`. Product SoT remains [`AGENTS.md`](../../../../AGENTS.md) / [`FEATURES.md`](../../../../FEATURES.md).

Transport: MCP stdio (`memo serve`) or SSE (`memo serve --sse`). Tool names match CLI commands 1:1 for the ten core tools (CLI also accepts kebab aliases `check-version` / `install-skills`).

## Ten MCP tools

Further growth needs a PRODUCT.PRD §6 amendment. Do not invent tools outside this list.

### `bootstrap`

Bind cwd git remote; compile a session brief.

| Arg | Type | Notes |
|-----|------|--------|
| `cwd` | string | Product working directory (default current) |
| `query` | string | Intent filter for traps/decisions |
| `slug` | string | Live spec/plan slice |
| `path` | string | Prioritize traps whose pathPatterns match |
| `maxBytes` | number | UTF-8 budget; defaults to vault `config.bootstrap.maxBytes` (8192) |
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

When `format=skill` and `id` is omitted, ranking uses the same full-project universe as `memo rank`. If zero active traps rank, fail closed (do not write a header-only `SKILL.md`).

### `check_version`

Compare running package version to npm `latest`. Soft-fails offline (`updateAvailable: "unknown"`, `latest: null`).

| Arg | Type | Notes |
|-----|------|--------|
| _(none)_ | | No inputs |

Returns: `current`, `latest`, `updateAvailable` (`true` \| `false` \| `"unknown"`), `source` (`npm` \| `offline`).

CLI: `memo check-version --json`

### `install_skills`

Copy packaged runtime skill(s) into a consumer product tree. Default skill: `ws-memo`. Default-deny outside product root / vault root.

| Arg | Type | Notes |
|-----|------|--------|
| `productRoot` | string | Preferred consumer root |
| `cwd` | string | Resolve product root when `productRoot` omitted |
| `skills` | string[] | Default `["ws-memo"]`; unknown ids fail closed |
| `skillsRoot` | string | Default `.agents/skills` |
| `force` | boolean | Overwrite when destination differs |

CLI: `memo install-skills --product-root <path> [--skill ws-memo] [--force] [--json]`

## CLI-only (not MCP tools)

| Command | Job |
|---------|-----|
| `memo setup` | Configure deployment mode (`local`, `hybrid`, `remote`) and host MCP snippets (`cursor`, `vscode`, `opencode`, `antigravity`, `claude`, `generic`). `--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`, `--json`. |
| `memo serve` | Stdio MCP (default). In remote mode, proxies over stdio to remote daemon. `--sse` HTTP SSE on `--port` (default 3000). `--status-port` (default 3001). `--no-status`. `--host` (default 127.0.0.1). `--auth-token` / `SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_SSE_TOKEN` required off-loopback. |
| `memo canvas` | Graph UI default port 4100. `--project`, `--host`, `--json`. (Not available in remote mode). |
| `memo doctor [productRoot]` | Vault + FTS + pollution + mode + remote health + hybrid state. `--rebuild` FTS. `--fix` delete leftover in-repo residue. `--json`. |
| `memo rank` | Active traps by `occurrences`. `--layer` `--limit` `--backfill` `--json`. Proxies in remote mode. |
| `memo import` | Legacy `.agents` / `memory/` / plans → vault. `--from`. |
| `memo hook install` | Pre-commit write-block. `--productRoot`. Bypass: `SKIP_MEMO_HOOK=1`. (Not available in remote mode). |
| `memo sync` | Hybrid bidirectional HTTP delta sync with remote daemon (`--all`, `--dry-run`), or vault git remote when vaultGit is enabled. |
| `memo sync-vault <target>` | Peer vault delta sync. `--two-way` `--dry-run`. (Not available in remote mode). |
| `memo export-vault` / `memo import-vault` | Portable archive; optional AES-256-GCM. Prefer `SPEC_MEMO_VAULT_PASSWORD`. (Not available in remote mode). |

Global: `--json` on stdout; help/errors on stderr. `--vaultRoot` / `$SPEC_MEMO_ROOT` (default `~/.spec-memo`).

### Deployment Modes

- **`local` (default):** Everything stored and queried directly on the local machine under `~/.spec-memo/`. Zero network requirements.
- **`hybrid`:** Local vault is authoritative; transparently pulls deltas on `bootstrap` and debounces pushes on mutating operations. Manual sync via `memo sync`. Fails open if remote daemon is unreachable.
- **`remote`:** Local agent hosts connect to local `memo serve` stdio proxy, which forwards all 10 tools to a shared remote daemon. Local disk stores no memory records. Fails closed if remote daemon is unreachable.

### Default ports

| Service | Port | Start |
|---------|------|--------|
| MCP SSE | 3000 | `memo serve --sse` |
| Status monitor | 3001 | co-starts with `--sse` unless `--no-status` |
| Canvas | 4100 | `memo canvas` |

Status page: vault list, health, live activity (`GET /api/events/stream`). Read-only.

## Host registration

All host agent environments (Cursor, VS Code, OpenCode, Antigravity, Claude Desktop) run `memo serve` locally over stdio. Generate or write config via:

```bash
memo setup --host cursor --print-mcp
memo setup --host cursor --write-mcp
```

Example Cursor `~/.cursor/mcp.json`:

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

- Extra MCP tool to list vault files (use `search`).
- Auto-rewrite specs on code change (drift is a flag).
- Auto-promote into README.
- Bundling the vault inside the product clone.
