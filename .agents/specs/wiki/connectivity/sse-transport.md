# SSE Transport

## Feature Overview

`memo serve --sse` starts a network-accessible MCP server using the `@modelcontextprotocol/sdk/server/sse.js` transport, letting remote agents, container runners, and IDE plugins reach the same 11 MCP tools over HTTP. The SSE listener defaults to `http://127.0.0.1:3123` unless `config.json` `ports.sse` overrides it (legacy `ports.mcp` is also honored). Regular `memo serve` (stdio) remains the default host-spawn transport and does not open a network port.

Endpoints:

- `GET /sse` (and `GET /`) opens a persistent Server-Sent Events stream and registers an MCP session.
- `POST /message?sessionId=<id>` delivers inbound JSON-RPC for an open session.
- `GET /health` returns machine JSON (status, service, bound port/host, project count, active transports).
- Authenticated HTTP changeset routes (`/api/sync/pull`, `/api/sync/push`, `/api/sync`) share the same origin for hybrid/remote sync.

Unless `--no-status` is passed, the SSE daemon also co-starts the human [Status Monitor](status-monitor.md) companion on the status port (default `3124`).

## Business Rules & Logic

- Default bind is loopback `127.0.0.1`. Binding a non-loopback `--host` without an auth token throws before `listen`, with the message naming `--auth-token`/`SPEC_MEMO_SSE_TOKEN`; the same refusal applies to the co-hosted status server.
- Auth token precedence: `--auth-token`, then `SPEC_MEMO_AUTH_TOKEN`, then `SPEC_MEMO_SSE_TOKEN`. A request is authorized by `Authorization: Bearer <token>` (bare header match also accepted) or `?token=`/`?authToken=`; unauthorized requests receive `401 { error: "Unauthorized" }`.
- Every request captures exactly one `type: "http"` activity event (method, path, status, duration) into the shared bus; failed responses with status >= 400 record `ok: false`.
- Tool parity: the SSE server exposes the exact same tools as stdio with the same budget caps, redaction, and project binding.
- Graceful shutdown on `SIGINT`/`SIGTERM` runs the fail-open shutdown flush (`flushOnShutdown`) first, then closes the activity bus, the status companion, the MCP transports/listener, and drains telemetry. If the status companion fails to bind, the SSE listener, transports, and bus are rolled back before rejecting.
- Per-connection `cleanup` removes the transport and disconnects the client exactly once, and closes the per-session MCP server; SSE disconnect does not leak sessions or drop other clients.
- `/message` requires a valid open `sessionId`; missing or unknown ids return `400 { error: "Valid sessionId required" }`.

## Technical Architecture

- `src/server.ts` `startSseServer(options)` accepts `port`, `host`, `vaultRoot`, `authToken`, `statusPort`, `statusHost`, `statusAuthToken`, `enableStatus`, `activityBus`, `errorLogPath` and resolves the port from `resolveConfiguredPorts`. It returns `{ server, port, host, url, statusUrl?, statusPort?, activityBus, close }`.
- Port resolution (`src/vault.ts` `resolveConfiguredPorts`) reads `ports.sse` (fallback `ports.mcp`) with `DEFAULT_VAULT_CONFIG.ports.sse = 3123`.
- `/health` body: `{ status: "ok", service: "spec-memo-mcp-sse", port, host, projectsCount, activeTransports }`.
- The status companion starts in the same process after the SSE listener binds, sharing one `ActivityBus` (capacity 200); `getMcp()` reports `{ host, port, activeTransports, available }` to the status API.
- When `sync.autoSyncIntervalMinutes > 0` and mode is `hybrid`, the daemon starts a non-blocking background sync worker (interval timer, `unref`'d). Each tick tries the vault lock (`tryAcquireVaultLockSync`) and skips if busy, then runs `syncDual` per project with `conflictStrategy` from config (default `smart-merge`). Shutdown clears and awaits the timer.
- CLI mapping (`src/cli.ts`): `memo serve --sse` accepts `--port`, `--host`, `--status-port`, `--no-status`, `--auth-token`, `--json`, `--vaultRoot`. Non-JSON stdout prints the SSE URL, `/sse`, `/message`, `/health`, and the status URL when enabled; `--json` emits `{ status, service, url, port, host, statusUrl?, statusPort? }`.
- The `close` handler awaits the in-flight background sync, runs `flushOnShutdown`, closes the bus, closes the status instance, closes and clears transports, calls `closeAllConnections()`, closes the listener, then `flushTelemetrySync`/`closeTelemetry`.
- Provenance: `0043-mcp-sse-transport.spec.md` (original `:3000` default), `0023-mcp-status-monitor.spec.md` (companion + bus), `0025-deployment-modes.spec.md` (sync routes), `0035-sync-conflict-reconciliation.spec.md` (background worker). Current shipped default is `3123`, not the spec's `3000`. See [Status Monitor](status-monitor.md) and [Vault Sync](vault-sync.md).
