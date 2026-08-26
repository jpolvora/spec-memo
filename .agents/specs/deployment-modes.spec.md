---
id: null
slug: deployment-modes
title: "Local, hybrid, and remote deployment modes with portable MCP wiring"
source: local
specDate: 2026-08-26
status: draft
target_phase: Phase 7
---

# Specification — Local, hybrid, and remote deployment modes with portable MCP wiring

## Description

Operators and agents need spec-memo to work in three deployment modes without rewriting IDE or agent host MCP configuration when switching modes:

1. **Local** — MCP stdio (`memo serve`) reads and writes the vault at `~/.spec-memo` (or `$SPEC_MEMO_ROOT`). Current default behavior; no network required.
2. **Hybrid** — Same local stdio MCP and local vault, plus authenticated HTTP changeset sync with a remote SSE daemon (`memo serve --sse` on a lab machine or VPS). Automatic pull on `bootstrap` for the cwd-bound `projectId`; debounced push after mutating tool calls. Explicit `memo sync`. Fail open when the remote is unreachable (local writes succeed; dirty flag + retry).
3. **Remote** — No local project records. The same stdio `memo serve` process acts as an MCP proxy to the remote daemon's `/sse` endpoint. Config and diagnostics live on the laptop; vault data lives on the daemon host.

**Single host command everywhere:** every supported agent host (Cursor, VS Code Copilot, OpenCode, Antigravity, Claude Desktop, generic stdio hosts) runs `memo serve` (stdio). Mode is stored only in `~/.spec-memo/config.json`. Switching modes does not require editing host MCP files. `memo setup --print-mcp --host <name>` prints host-specific snippets; writing host files is opt-in via `--write-mcp --host <name>`.

**Remote server identity:** the remote is the same product running `memo serve --sse` (not a separate hub or SaaS). Hybrid sync reuses the shipped delta engine (`exportChangeset` / `applyChangeset` from `multi-machine-sync`). New authenticated HTTP routes on the **same origin** as SSE (e.g. `/api/sync`); no 11th MCP tool.

**Credentials:** `config.json` stores mode and daemon origin URL only. Bearer token comes from environment (`SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`), matching existing non-loopback SSE auth. Never persist tokens in config, vault-git, or backup exports.

**Setup surface:** `memo setup` / `memo config` is the configuration SoT (flags + interactive prompts). The packaged `ws-memo` skill checks config, interviews when incomplete, and delegates to the CLI. `memo doctor` reports mode, URL, token presence, sync state, and remote health.

**Phased delivery:**

| Phase | Scope |
|-------|--------|
| **1** | Config schema, `memo setup`, extended `memo doctor`, `ws-memo` configure step, portable MCP print helpers |
| **2** | Daemon HTTP changeset API, hybrid pull/push/debounce, `memo sync`, hybrid state file, bootstrap notices |
| **3** | Remote stdio MCP proxy, remote CLI rules for the 10 tools + selected extras |

Architecture touchpoints:

- **Config (`src/types.ts`, `src/vault.ts`)** — extend `VaultConfig` with `mode?: 'local' \| 'hybrid' \| 'remote'` (default `local` when omitted) and `remote?: { url: string }` (daemon origin, no path). Merge on setup; do not clobber `ttl`, `vaultGit`, `embeddings`, `bootstrap`.
- **Hybrid state (`~/.spec-memo/.sync/hybrid-state.json`)** — machine-local sync metadata (`dirty`, `lastError`, `lastSyncAt`, per-`projectId` cursors). Not in human-edited `config.json`; excluded from vault-git when enabled.
- **Setup CLI (`src/cli.ts`, new `src/setup.ts`)** — `memo setup [--mode] [--url] [--json] [--print-mcp --host] [--write-mcp --host]`. URL normalization strips `/sse`, `/message`, trailing slashes. Hybrid/remote without URL or without token in env exits non-zero after writing what it can.
- **Doctor (`src/doctor.ts`)** — report mode, origin, token present/absent (never print value), hybrid state, `GET {origin}/health`. Hybrid unreachable = warning; remote unreachable = failure.
- **Hybrid sync (`src/hybrid-sync.ts`, extend `src/sync.ts`, `src/server.ts`)** — HTTP client + daemon routes; scope = cwd `projectId` by default; `memo sync --all` for full vault. Conflict policy = existing multi-machine-sync rules.
- **Remote proxy (`src/mcp-proxy.ts`, `src/mcp.ts`)** — when `mode === 'remote'`, stdio MCP forwards the 10 tools to remote SSE/JSON-RPC. No local `projects/` writes.
- **ws-memo (`.agents/skills/ws-memo/SKILL.md`)** — new **configure** router step; session start runs doctor before bootstrap; documents three modes and env token requirement.

Greenfield additive slice on shipped SSE transport, multi-machine sync, and 10-tool MCP surface. Does not add Streamable HTTP, CRDT, multi-tenant SaaS, or auto-write host MCP files by default.

## Acceptance Criteria

### Phase 1 — Config, setup, doctor, ws-memo

- AC1: `VaultConfig` accepts optional `mode` with values `local`, `hybrid`, or `remote`. When `mode` is omitted from an existing or new config file, effective mode is `local` (backward compatible).
- AC2: `VaultConfig` accepts optional `remote.url` (string). Setup and doctor treat it as the daemon **origin** only (scheme + host + port, no path). Inputs like `http://host:3000/sse` or trailing slashes are normalized to `http://host:3000` before persist.
- AC3: Bearer auth tokens are never written to `config.json`, `hybrid-state.json`, vault-git commits, or `export-vault` archives. Setup prints instructions to set `SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN` in the environment.
- AC4: When effective mode is `hybrid` or `remote`, `remote.url` is required. `memo setup` without `--url` (and without an existing valid URL) exits non-zero in non-interactive mode; in interactive TTY mode prompts for URL.
- AC5: When effective mode is `hybrid` or `remote`, setup verifies a bearer token is present in `SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`. Missing token after URL is saved exits non-zero with a clear message (does not write the token).
- AC6: In `local` mode, `remote.url` is ignored for runtime behavior even if present. Doctor may still display it as informational.
- AC7: `memo setup` merges into existing `~/.spec-memo/config.json` without resetting `ttl`, `vaultGit`, `embeddings`, or `bootstrap` blocks.
- AC8: `memo setup --json` emits structured output including `mode`, `remote.url` (when applicable), `tokenConfigured` (boolean), and `hostSnippet` when `--print-mcp --host <name>` is set.
- AC9: `memo setup --print-mcp --host cursor|vscode|opencode|antigravity|claude|generic` prints a **stdio** snippet whose command is `memo serve` (or documented `npx` equivalent). Snippets differ only by host config shape (`mcpServers` vs `servers` vs OpenCode `mcp`, etc.); transport is always local stdio spawn, not a remote URL.
- AC10: `memo setup --write-mcp --host <name>` writes or merges the stdio snippet only when explicitly passed. Default setup does not modify `~/.cursor/mcp.json`, `.vscode/mcp.json`, OpenCode config, or Antigravity `mcp_config.json`.
- AC11: `memo doctor` (and `memo doctor --json`) reports: effective `mode`, normalized `remote.url` when set, `tokenConfigured` (boolean, never the token value), and for hybrid mode the contents of hybrid state (`dirty`, `lastSyncAt`, `lastError` when present).
- AC12: When mode is `hybrid` or `remote`, doctor performs `GET {origin}/health` with `Authorization: Bearer` when token is configured.
- AC12a: When mode is `hybrid` and the health check fails, doctor reports a warning (local vault may still be used).
- AC12b: When mode is `remote` and the health check fails, doctor reports a failure (cannot proxy).
- AC13: Missing or omitted `mode` in config is not reported as corruption by doctor.
- AC14: Packaged `ws-memo` skill adds a configure intent: if `~/.spec-memo/config.json` is missing mode, URL, or token requirements for the chosen mode, run an interview (mode, then URL, then token env reminder) and invoke `memo setup`.
- AC14a: The ws-memo session step runs doctor (or equivalent JSON check) before bootstrap.
- AC15: Automated tests cover: config merge/default mode, URL normalization, setup exit codes for missing URL/token, doctor JSON shape, and local-mode ignore of remote URL.

### Phase 2 — Hybrid HTTP changeset sync

- AC16: The SSE daemon exposes authenticated HTTP changeset routes on the same origin as `/sse` (e.g. `POST /api/sync/pull`, `POST /api/sync/push`, or a documented two-way `POST /api/sync`). Requests require the same bearer token as SSE when the daemon binds non-loopback or when `--auth-token` is configured.
- AC17: Daemon sync routes reuse `exportChangeset` and `applyChangeset` from `src/sync.ts`. Conflict resolution matches `multi-machine-sync.spec.md` (latest `updated` wins; trap dedupe/supersede; logs append-only; archived/deleted propagate).
- AC18: Hybrid automatic sync scope is the **cwd-bound `projectId`** only (from `resolveProjectIdentity`). `memo sync --all` syncs all projects in the local vault against the remote daemon vault.
- AC19: On `bootstrap` in hybrid mode, the client pulls remote changes for the bound `projectId` before compiling the brief (best effort). Pull failure sets hybrid state `dirty`/`lastError` and adds a notice to the bootstrap payload; bootstrap still returns local data (fail open).
- AC20: In hybrid mode, after successful local mutating operations (`upsert`, `append`, `forget`, `gc`), a debounced push schedules export/application of changes for the affected `projectId`(s). Debounce coalesces rapid tool bursts (default window documented in code, e.g. 2–5 seconds). Push failure sets `dirty` and `lastError` without rolling back the local write.
- AC21: `memo sync [--all] [--dry-run] [--json]` performs explicit hybrid two-way sync (pull then push, or documented single round-trip). `--dry-run` reports counts without applying. Works only when mode is `hybrid`; otherwise exits non-zero with a clear error.
- AC22: Hybrid machine state persists in `~/.spec-memo/.sync/hybrid-state.json` (or under `$SPEC_MEMO_ROOT/.sync/`), including at minimum: `dirty` (boolean), `lastSyncAt` (ISO string or null), `lastError` (string or null), and per-`projectId` sync cursors compatible with existing `.sync/cursors/` semantics where applicable.
- AC23: Hybrid sync uses vault lock (`withVaultLock` / `commitVaultChange`) for local apply paths. No second unguarded vault write path.
- AC24: After hybrid apply, SQLite FTS index is rebuilt when records changed (same as `sync-vault`).
- AC25: Automated tests cover: daemon auth on sync routes, project-scoped pull/push, debounced push scheduling, fail-open local write when remote is down, conflict sidecar behavior, and bootstrap notice on sync failure.

### Phase 3 — Remote stdio MCP proxy and CLI extras

- AC26: When effective mode is `remote`, `memo serve` (stdio) does not read or write local `projects/` record files. Tool handlers forward to the remote daemon MCP transport (`/sse` + `/message` on the configured origin) with bearer auth from env.
- AC27: Remote proxy exposes the same **10** MCP tools with parity to local mode: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version`, `install_skills`. Budget caps, secret redaction, and project binding rules apply on the daemon side; proxy passes through errors faithfully.
- AC28: When mode is `remote`, the 10 CLI commands (`memo bootstrap`, `memo search`, …) proxy to the daemon equivalent. `memo doctor` remains **local** (config + `GET /health` only). `memo rank` proxies (via remote search/rank semantics or documented HTTP helper).
- AC29: When mode is `remote`, CLI extras `memo canvas`, `memo sync-vault`, `memo export-vault`, `memo import-vault`, and `memo hook install` exit non-zero with message `not available in remote mode` (or equivalent). `memo setup`, `memo doctor`, and `memo check-version` remain available locally.
- AC30: When mode is `remote` and the daemon is unreachable at process start or on a tool call, mutating tools return a structured error (fail closed for remote; no silent local fallback vault).
- AC31: `memo serve --sse` on the daemon host is unchanged for operators running the vault server; remote/hybrid clients connect to that process's origin. Daemon-side sync routes from Phase 2 are available when `--sse` is active.
- AC32: Automated tests cover: remote proxy tool parity (at least bootstrap + upsert + search against a test SSE server), doctor failure when remote down in remote mode, and CLI extra refusal in remote mode.

### Cross-cutting

- AC33: `README.md` documents the three modes, env token requirement, `memo setup`, hybrid sync behavior, and that all hosts use stdio `memo serve`. Port map unchanged (`3000` SSE, `3001` status, `4100` canvas on daemon host).
- AC34: `AGENTS.md` and packaged `ws-memo` / `SURFACE.md` document configure step, three modes, and hybrid fail-open vs remote fail-closed semantics.
- AC35: No new MCP tool is added; the 10-tool surface remains the agent contract unless `PRODUCT.PRD` is amended separately.
- AC36: `npm test` passes with zero regressions after each phase lands.

## Original Issue Context

Free-text request (2026-08-26): make spec-memo work in three workflow types:

1. **Local mode** — MCP server runs locally via scripts; vault at `~/.spec-memo` (resolving to `C:\Users\jpolv\.spec-memo\` on Windows).
2. **Hybrid mode** — MCP runs locally like local mode but interacts with a configured remote server; dual sync (store locally, sync up and down).
3. **Remote mode** — connect directly to a configured remote MCP server.

Configuration in `~/.spec-memo/config.json`: `mode: local | hybrid` (extended to include `remote` during design interview). Hybrid requires remote URL and credentials at setup. Adapt `ws-memo` to install/configure spec-memo, check config, ask for mode, URL, and credentials.

Design interview decisions (2026-08-26):

| Decision | Choice |
|----------|--------|
| Remote server | Same product: `memo serve --sse` daemon |
| Hybrid transport | Authenticated HTTP changeset API on same origin (not 11th MCP tool) |
| Sync trigger | Pull on bootstrap; debounced push after mutations; explicit `memo sync` |
| Offline policy | Fail open in hybrid (local writes succeed; dirty + retry) |
| Token storage | Env only (`SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_SSE_TOKEN`); URL in config |
| Remote in config | `mode: remote` in same `config.json` |
| Setup SoT | `memo setup` CLI + ws-memo interview |
| Sync scope | Automatic: cwd `projectId` only; `memo sync --all` for full vault |
| Host wiring | Universal stdio `memo serve` for all hosts; print snippets, no default write |
| Remote CLI extras | 10 tools proxy; doctor local; rank proxy; canvas/sync-vault/export/hook refuse |
| URL shape | Store origin only; strip `/sse` on input |
| Spec packaging | One spec, three ordered phases |

### Prior Work Sweep

Keyword + codebase search on `sync`, `serve --sse`, `config.json`, `ws-memo`, `multi-machine-sync`, `mcp-sse-transport`. No open PR for slug `deployment-modes`.

| Hit | Relation | Action |
|-----|----------|--------|
| [`multi-machine-sync.spec.md`](multi-machine-sync.spec.md) | Shipped delta engine (`exportChangeset`, `applyChangeset`, `syncVaults`) | Reuse for hybrid HTTP sync (Phase 2) |
| [`mcp-sse-transport.spec.md`](mcp-sse-transport.spec.md) | Shipped SSE daemon on `:3000` | Remote target + extend with `/api/sync` |
| [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md) | Companion `:3001` on daemon host | Unchanged; ops on server machine |
| [`memory-adapter-mcp.spec.md`](memory-adapter-mcp.spec.md) | Consumer harness in workflow-skills | Out of scope; ws-memo stays runtime skill |
| `src/identity.ts` | Remote SSE must not treat laptop cwd as vault root | Apply in remote proxy + daemon (existing trap) |
| Trap `hardcoded-script-auth-token` | No tokens in committed scripts | Setup/doctor env-only token policy |

### Design Intent

Greenfield extension. Existing `memo sync-vault` remains filesystem peer sync (local/hybrid only). Hybrid HTTP sync is additive and does not replace `sync-vault` or vault-git. Default omitted `mode` preserves today’s local-only behavior for all existing installs.

## Notes

- Phase 1 can ship independently (setup + doctor + docs) without Phase 2/3 network sync or proxy.
- Phase 2 depends on Phase 1 config schema and doctor reporting.
- Phase 3 depends on Phase 1 remote URL + token resolution; does not require Phase 2 for basic remote proxy, but hybrid mode requires Phase 2.
- Consumer product `specMemo.mode` in workflow-skills `config.json` (`vault` today) is a separate concern; this spec owns **vault-global** `~/.spec-memo/config.json` mode. Document the distinction in README; do not conflate the two keys in code without an explicit mapping table.
- Windows path `C:\Users\<user>\.spec-memo\` is the default when `SPEC_MEMO_ROOT` is unset; all paths respect `$SPEC_MEMO_ROOT` override in tests.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Streamable HTTP transport on daemon | Separate transport upgrade; SSE sufficient for v1 of this slice |
| CRDT / live collaborative vault editing | PRD rejected shape; keep batch sync |
| Multi-tenant SaaS or hosted spec-memo cloud | PRD non-goal |
| Auto-writing IDE MCP config files on every setup | User chose print/check; `--write-mcp` opt-in only |
| 11th MCP tool for sync | HTTP `/api/sync` keeps agent contract stable |
| Token persistence in config or credential files | User chose env-only; avoids vault-git leak |
| Replacing workflow-skills `ws-spec-memo` consumer setup | Stays in workflow-skills; ws-memo documents runtime configure only |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Remote daemon is operated by the same user or trusted lab | No multi-user ACL on sync routes beyond bearer token | Matches personal/lab VPS use case | y |
| Hybrid debounce window | 2–5 s coalesce (implementation picks within range) | Balances agent burst traffic vs sync latency | y |
| Sync HTTP path prefix | `/api/sync` under daemon origin | Consistent with status monitor `/api/*` pattern | y |
| Auth boundaries / rate limits | Reuse existing SSE bearer; no new rate limiter in v1 | Minimal scope; daemon already requires token off loopback | y |
| Observability | Doctor + bootstrap notices; no new metrics dashboard | Status monitor already on daemon host | y |
| External dependency failure (daemon down) | Hybrid fail open; remote fail closed | User decision in interview | y |
| Concurrency / ordering | Vault lock on local apply; debounced push single-flights per projectId | Matches existing vault-lock traps | y |
| Idempotency / retry | Hybrid retries on next bootstrap/debounce; cursor in hybrid-state | Avoid duplicate push storms | y |
| Data lifecycle / expiry | hybrid-state is machine-local; not synced | Avoid git noise | y |
| Input validation | Setup rejects invalid URLs and unknown mode enum | Fail closed at configure time | y |
