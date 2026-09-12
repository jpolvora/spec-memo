# Deployment Modes

## Feature Overview

`spec-memo` supports three vault-global deployment modes configured in `~/.spec-memo/config.json` (`$SPEC_MEMO_ROOT` when set). Mode lives only in that config: every agent host (Cursor, VS Code, OpenCode, Antigravity, Claude Desktop, generic stdio) runs the same `memo serve`, so switching modes never edits host MCP files.

- **Local (default):** all records, indexing, and tools run against the local filesystem vault. No network required. When `mode` is omitted, effective mode is `local`.
- **Hybrid:** the local vault stays authoritative; `bootstrap` best-effort pulls remote changes for the cwd-bound `projectId`, mutating tools debounce-push changes, and `memo sync` performs an explicit two-way round trip against a remote SSE daemon. Offline is fail-open: local writes succeed and dirty state plus cursor are retained for retry.
- **Remote:** the stdio `memo serve` process is an MCP proxy to the remote daemon `/sse` endpoint. No local `projects/` records are written. Fail-closed: tool calls error with `REMOTE_UNREACHABLE` when the daemon is down.

Operators configure with `memo setup`, inspect with `memo doctor`, and force a sync with `memo sync`. Agents reach the same behavior through the MCP surface; the mode is invisible to tool callers except for the proxy/daemon hop.

## Business Rules & Logic

- Mode enum is `local | hybrid | remote`; an unknown value is rejected by `memo setup`.
- `mode` omitted in an existing or new config resolves to `local` (backward compatible). `memo doctor` does not report a missing `mode` as corruption.
- `hybrid` and `remote` require `remote.url`. Non-interactive setup without `--url` (and no existing valid URL) exits non-zero; interactive TTY setups prompt.
- URL normalization stores the daemon **origin only** (scheme + host + port). Inputs such as `http://host:3000/sse`, `http://host:3000/message?token=abc`, or trailing slashes reduce to `http://host:3000`. Only `http:`/`https:` are accepted.
- Bearer tokens are read only from `SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`. They are never written to `config.json`, `hybrid-state.json`, vault-git commits, or `export-vault` archives. Setup verifies token presence after saving the URL and exits non-zero when absent.
- `local` mode ignores `remote.url` at runtime even when present; doctor may display it as informational.
- In `remote` mode, `memo sync` errors (no local vault to sync) and CLI extras `canvas`, `serve-canvas`, `sync-vault`, `export-vault`, `import-vault`, `hook`, and `wiki` exit non-zero with `not available in remote mode` (`REMOTE_MODE_RESTRICTION` in JSON). `setup`, `doctor`, and `check-version` stay local.
- Hybrid automatic scope is the cwd-bound `projectId`; `memo sync --all` covers every local project. Hybrid debounce window is 2000 ms with in-flight + pending single-flight per `projectId`. Both channels never share the vault lock during HTTP fetch or git network waits.
- Remote proxy exposes the same 11 MCP tools with daemon-side budget caps, redaction, and project binding; errors pass through faithfully.

## Technical Architecture

- Config schema (`src/types.ts`): `VaultConfig.mode?: DeploymentMode`, `VaultConfig.remote?: { url: string }`, and `sync.autoSyncIntervalMinutes`. Merge/default logic lives in `src/vault.ts` (`ensureVaultStructure`, `DEFAULT_VAULT_CONFIG`).
- `memo setup` (`src/setup.ts`): `normalizeRemoteUrl`, `isTokenConfigured`, `getResolvedAuthToken`, `generateHostMcpSnippet`, `writeHostMcpConfig`, `runSetup`. Host snippets are always stdio (`memo serve`); `--print-mcp --host <name>` prints, `--write-mcp --host <name>` merges into the host file, and status-autostart flags are stripped by `stripStatusAutostartArgs`.
- Hybrid client (`src/hybrid-sync.ts`): `pullHybridProject`, `pushHybridProject`, `syncHybrid`, `scheduleHybridPush`, `flushDebouncedPushes`, `clearDebouncedPushes`. State persists to `$SPEC_MEMO_ROOT/.sync/hybrid-state.json` via `src/hybrid-state.ts` (`dirty`, `lastSyncAt`, `lastError`, per-project `cursors`, `dirtyProjects`). Cursors are monotonic; pull cursors advance on `changeset.generatedAt`, push cursors use the export snapshot `generatedAt` (not wall clock), and a dirty project pushes with `since` unset so older offline records are not dropped.
- Daemon routes (`src/server.ts`) on the same origin as `/sse`: `POST /api/sync/pull` (`{ projectId?, since? }` -> `exportChangeset`), `POST /api/sync/push` (`{ changeset, force?, dryRun?, prefer?, strategy?, cleanSidecars? }` -> `applyChangeset`), and `POST /api/sync` (bidirectional `{ push, pull }`). All require the bearer token when configured or bound non-loopback.
- Remote proxy (`src/mcp-proxy.ts`): `createRemoteClient` opens an authenticated `SSEClientTransport` at `{origin}/sse`; `callRemoteTool` wraps a single request; `createRemoteMcpProxyServer` and `startRemoteMcpProxyServer` expose stdio. `src/mcp.ts` `startMcpServer` routes to the proxy when `config.mode === 'remote'`. Errors return `{ isError: true, code: 'REMOTE_UNREACHABLE' | 'REMOTE_TOOL_ERROR' | 'PROXY_INTERNAL_ERROR' }` and log under subsystem `remote-proxy`.
- Doctor (`src/doctor.ts`): reports effective mode, normalized URL, `tokenConfigured` (boolean), hybrid state, and `GET {origin}/health`. Hybrid unreachable is a warning; remote unreachable is a failure.
- Provenance: `0025-deployment-modes.spec.md`; hybrid cadence and daemon routing are refined by `0033-vault-git-hybrid-sync.spec.md`, `0035-sync-conflict-reconciliation.spec.md`, and `0044-multi-machine-sync.spec.md`. See [Vault Sync](vault-sync.md) for dual-channel flush semantics and [SSE Transport](sse-transport.md) for the daemon bind/auth contract.
