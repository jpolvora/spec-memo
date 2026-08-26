---
id: null
slug: mcp-status-monitor
title: "MCP status monitor page with live activity log"
source: local
specDate: 2026-08-26
status: in_progress
target_phase: Phase 6
---

# Specification — MCP status monitor page with live activity log

## Description

Operators and developers need a simple, bookmarkable local webpage to see whether the spec-memo MCP HTTP/SSE server is healthy, which vault projects exist, and what tool traffic is happening in realtime (searches, gets, upserts, and other writes). Today `memo serve --sse` exposes JSON `/health` on port `3000` and `memo canvas` serves a graph UI on `4100`, but neither is a dedicated ops monitor with a live activity stream or per-vault filtering.

This slice adds a companion **status monitor** HTTP listener (default port `3001`) that starts with the SSE MCP process so it can observe traffic in-memory. It serves a self-contained, visually polished HTML page (zero external CDN runtime deps) plus small JSON/SSE APIs for vault listing, server health, and a rolling activity log. The page is read-only: it never mutates the vault.

Central to the page is an **Activity Event Bus**: producers **capture** API/tool activity, the bus **logs** into a bounded ring buffer and **emits** to live subscribers, and the webpage **consumes** those events in realtime (no polling required for new lines). Operators can **filter the live log by vault/project** so multi-project vaults remain readable during heavy agent traffic.

Architecture touchpoints:

- **Activity bus (`src/activity.ts`)**: `createActivityBus({ capacity })` exposing `capture(event)`, `list(filter?)`, `subscribe(listener, filter?)`, and `close()`. Every capture sanitizes, assigns monotonic `seq` + `id`, optional `projectId`, appends to the ring buffer, then emits to all live subscribers (each subscriber may apply a project filter).
- **SSE server (`src/server.ts`)**: when starting `startSseServer`, also start a companion status listener sharing one bus instance; capture HTTP request lifecycle for `/health`, `/sse`, and `/message` (method, path, statusCode, durationMs) in addition to tool traffic; graceful shutdown on SIGINT/SIGTERM closes both listeners.
- **MCP tools (`src/mcp.ts` / tool dispatch)**: after each successful or failed tool invocation (the existing 8 tools), `capture` a sanitized `tool` event including resolved `projectId` when determinable from tool args / cwd binding — never raw secrets or full bodies.
- **Status UI module (`src/status.ts`)**: `startStatusServer`, `generateStatusHtml`, `GET /`, `GET /api/status`, `GET /api/vaults`, `GET /api/events` (JSON snapshot), `GET /api/events/stream` (SSE push). The embedded page opens `EventSource` on the stream, maintains a vault/project filter control, and appends matching events to the live logger.
- **Vault listing**: reuse `getVaultProjectList` from `src/canvas.ts` — do not duplicate project scan logic.
- **Safety (`src/safety.ts`)**: all activity payloads and API responses pass through existing redaction / sanitize helpers; refuse path leaks.
- **CLI (`src/cli.ts`)**: `memo serve --sse` prints the status URL; flags `--status-port` (default `3001`), `--no-status`, and `--json` (include `statusUrl`). Loopback + auth token rules mirror SSE/canvas.
- **Docs (`README.md`, `AGENTS.md`)**: document the status monitor URL, default ports, and vault filter behavior alongside existing `serve --sse` and `canvas` instructions.
- **Tests (`src/status.test.ts`, `src/activity.test.ts`, extend `src/server.test.ts`)**: capture→buffer→emit path, project filter on list/stream/UI, HTML/API/SSE behavior, ring-buffer bounds, auth refusal, no vault writes from status routes.

Greenfield additive slice. It does not replace canvas or change the 8-tool MCP surface. Design choices: [`mcp-status-monitor.context.md`](mcp-status-monitor.context.md).

## Acceptance Criteria

- AC1: `startStatusServer(options)` starts a Node `http` listener with configurable `port` (default `3001`) and `host` (default `127.0.0.1`).
- AC2: Binding the status server to a non-loopback host without an auth token (`--auth-token` / `SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_STATUS_TOKEN`) throws before listen, matching SSE/canvas refusal semantics.
- AC3: `GET /` and `GET /index.html` return `200` with `Content-Type: text/html; charset=utf-8` and a self-contained HTML document (no required external script/style CDNs at runtime).
- AC4: The status HTML page visually presents at least: product/brand title **spec-memo**, overall server status (up/down or ok/error), active SSE port/host, active status port/host, vault project count, a selectable vault/project list, a vault/project filter control, and a live activity log panel.
- AC5: `GET /api/status` returns JSON including `status` (`ok` when the companion is serving), `service` identifying the status monitor, `host`, `port`, `mcp` summary (`host`, `port`, `activeTransports` when co-hosted with SSE; otherwise an explicit disconnected/unavailable marker), `projectsCount`, `uptimeMs` (or equivalent started-at), and `eventsBuffered`.
- AC6: `GET /api/vaults` returns JSON array of vault projects with at least `id` and `displayName` (same shape semantics as canvas project list).
- AC7: Status routes never create, update, archive, or delete vault records (read-only surface).
- AC8: When `memo serve --sse` starts, the status companion starts by default on port `3001` in the same process unless `--no-status` is set.
- AC9: CLI accepts `--status-port <n>` to override the companion port; help text documents the default `3001`.
- AC10: CLI accepts `--no-status`; when set, no status listener starts and stdout/JSON output omits the status page URL.
- AC11: On successful `memo serve --sse` start (non-JSON mode), stdout prints both the SSE URL (including `/health`) and the status page URL when the companion is enabled.
- AC12: When `memo serve --sse --json` runs with the companion enabled, JSON output includes `statusUrl` alongside existing SSE fields.
- AC13: SIGINT/SIGTERM on `memo serve --sse` gracefully closes the SSE listener, the status companion, and the activity bus before process exit.
- AC14: An in-process Activity Event Bus exposes `capture(partial)`, `list(filter?)`, `subscribe(listener, filter?)`, and `close()`; `capture` is the only write path into the buffer and always runs sanitize → assign ids → append → emit.
- AC15: Every captured event is stored and emitted with at least: `id` (unique string), `seq` (monotonic integer starting at 1 for that bus instance), `ts` (ISO-8601), `type` (`http` \| `tool` \| `system`), `kind` (`read` \| `write` \| `meta`), `ok` (boolean), `durationMs` (number), and `summary` (short string, no full request/response bodies).
- AC16: Captured events include optional `projectId` (string) when the underlying tool invocation resolves to a single vault project; omit `projectId` when not determinable (cross-project `search`, global `gc`, HTTP transport events, startup `system` events).
- AC17: Each invocation of any of the eight MCP tools results in exactly one captured `type: "tool"` event including `tool` (tool name) and a short `summary`; write-oriented tools use `kind: "write"`; read-oriented tools use `kind: "read"`.
- AC18: Each completed HTTP request to the MCP SSE listener paths `/health`, `/sse`, and `/message` results in exactly one captured `type: "http"` event including `method`, `path`, and `statusCode` (no `projectId`).
- AC19: When the status companion successfully binds, exactly one captured `type: "system"` event with `kind: "meta"` and a summary indicating the monitor URL/port is appended before other traffic.
- AC20: Failed tool invocations and HTTP responses with status >= 400 still capture an event with `ok: false` (errors are logged, not swallowed).
- AC21: The ring buffer retains at most a fixed maximum of events (default `200`); when full, the oldest event is dropped (FIFO) while `seq` continues to increase for new captures.
- AC22: `GET /api/events` returns `200` JSON `{ events: ActivityEvent[], nextSeq: number }` as a snapshot of the current ring buffer (newest-last or documented order), suitable for initial page hydrate without opening a stream.
- AC23: `GET /api/events` accepts optional query `project=<projectId>`; when set, `events` includes only entries where `projectId === <projectId>` **or** `projectId` is absent (transport/meta events remain visible while filtering a vault).
- AC24: `GET /api/events/stream` returns Server-Sent Events (`Content-Type: text/event-stream`, no intermediary buffering that blocks live push) and keeps the connection open until the client disconnects.
- AC25: On stream connect, the server first sends a named SSE event `snapshot` whose data is the same JSON array shape as `/api/events`, then sends named SSE event `activity` for each subsequent `capture` with `data` set to one `ActivityEvent` JSON object.
- AC26: `GET /api/events/stream` accepts optional query `project=<projectId>` applying the same inclusion rules as AC23 to snapshot replay and subsequent live `activity` pushes.
- AC27: Optional query `?afterSeq=<n>` on `/api/events/stream` skips snapshot replay of events with `seq <= n` and only pushes later captures (reconnect-friendly; invalid/`NaN` `afterSeq` is treated as `0`).
- AC28: Multiple concurrent `/api/events/stream` clients each receive captures matching their own filter (if any); unsubscribing on client close does not affect other subscribers or the ring buffer.
- AC29: Activity event payloads are sanitized with the existing secret-redaction helpers before buffering or streaming; known secret-shaped strings and absolute filesystem paths do not appear verbatim in `summary` or other string fields.
- AC30: The status HTML page includes a vault/project filter control with an **All vaults** default plus one option per entry from `/api/vaults` (label prefers `displayName`, value is `id`).
- AC31: Clicking a vault row in the project list sets the vault filter to that project (same effect as choosing it in the filter control).
- AC32: Changing the vault/project filter immediately updates the visible live log without a full page reload by applying the AC23 inclusion rules client-side to buffered and newly streamed events.
- AC33: When a specific vault is selected, the vault list visually highlights the active project and the page shows a clear filtered context label (e.g. `Showing: {displayName}` or equivalent).
- AC34: The page accepts optional URL query `?project=<projectId>` on load to pre-select the vault filter when that project exists in `/api/vaults`; unknown ids fall back to **All vaults** without error.
- AC35: Selected vault filter persists in `sessionStorage` under a stable key and is restored on reload when the project still exists; changing the filter updates storage.
- AC36: The status HTML page opens a realtime subscription to `/api/events/stream` (via `EventSource` or equivalent), hydrates from the stream `snapshot`, appends each matching `activity` event as it arrives, and reconnects with `afterSeq` set to the last received `seq` after a disconnect (reconnect uses the current vault filter via `project=` when not **All vaults**).
- AC37: The page shows a stream connection badge with at least Live, Reconnecting, and Offline states derived from the EventSource lifecycle.
- AC38: The live logger UI distinguishes `type`/`kind` (at least read vs write vs http), shows optional `projectId` (or display name when filtered to **All vaults**), and shows `ts`, tool or method+path, `ok`/`error`, `durationMs`, and `summary` for each line.
- AC39: The live logger provides a pause-auto-scroll toggle and a clear-view control; clear removes only rendered lines from the DOM and does not mutate the server ring buffer.
- AC40: The page uses a dark-theme layout consistent with the canvas viewer (dark background, high-contrast text, subtle accent for status badges and write events).
- AC41: The page polls `/api/status` on an interval (default 5s) to refresh uptime, `activeTransports`, and `eventsBuffered` without reloading the document.
- AC42: Unknown status API paths return `404` JSON `{ error: "Not found" }` and do not leak stack traces.
- AC43: When an auth token is configured for the status server, unauthorized requests to `/api/*` (including `/api/events` and `/api/events/stream`) return `401` JSON; API/stream calls require `Authorization: Bearer <token>` or `?token=<token>` on the stream URL for EventSource.
- AC44: Closing the SSE MCP server instance also closes the status companion, calls `bus.close()` (rejecting further captures and ending subscriber streams), and leaves no orphan listeners after `close()`.
- AC45: `README.md` documents the status monitor (default `:3001`), its relationship to `memo serve --sse`, vault filter behavior, and default port map (`3000` SSE, `3001` status, `4100` canvas).
- AC46: `AGENTS.md` mentions the optional status monitor page under the HTTP/SSE transport section with the default URL pattern.
- AC47: Automated tests cover the activity bus: `capture` → `list` → subscriber emit, `projectId` on scoped tool calls, ring-buffer cap with continuing `seq`, and multi-subscriber fan-out with different project filters.
- AC48: Automated tests cover HTTP APIs: `/api/events?project=` filtering, `/api/events/stream` snapshot plus live `activity` after a tool call and after `/health`, stream `project=` and `afterSeq` filtering, non-loopback-without-token refusal, status HTML `200`, `/api/status` and `/api/vaults` shapes, and no vault writes from status routes.
- AC49: The page is usable as a browser favorite: stable path `/` on the configured host/port, optional `?project=` only, and a document `<title>` containing `spec-memo`.

## Original Issue Context

Free-text request (2026-08-26): create a simple webpage showing / listing vaults and server status with a live logger watching (viewing API calls, queries/writes). It can use another port like `:3001` so the operator can check realtime MCP server status. Draft a beautiful page that is simple to favorite and monitor the status of the MCP spec-memo server.

Follow-up (2026-08-26): enhance the spec so API events are explicitly logged, captured, and emitted such that the webpage can log activity in realtime (capture → buffer → emit → stream → UI append).

Follow-up (2026-08-26): add webpage filter by vault/project and complete the spec.

### Prior Work Sweep

Keyword + `git log` on `src/server.ts`, `src/canvas.ts`, `src/cli.ts`, and specs for SSE/canvas/doctor. No open PR for this local slug. Related hits:

| Hit | Relation | Action |
|-----|----------|--------|
| [`mcp-sse-transport.spec.md`](mcp-sse-transport.spec.md) / `src/server.ts` | SSE on `:3000`, JSON `/health`, auth refusal for non-loopback | Co-host status companion; keep MCP transport unchanged |
| [`canvas-viewer.spec.md`](canvas-viewer.spec.md) / `src/canvas.ts` | Self-contained HTML + `/api/projects` on `:4100` | Reuse vault list helper and HTML-in-module pattern; do not fold ops UI into canvas |
| [`cli-doctor.spec.md`](cli-doctor.spec.md) | CLI health diagnostics, not a live webpage | Leave doctor as CLI; status page is complementary |
| [`cross-project-search.spec.md`](cross-project-search.spec.md) | Search may span projects | Events without single `projectId` when cross-project; filter shows global/meta lines |
| `index.PRD` Inbox — "Mobile companion web dashboard" | Broader future idea | Keep out of scope; this slice is local desktop ops monitor only |
| Trap `sse-trap` | Do not drop SSE connections | Status `/api/events/stream` must clean up on client close; MCP `/sse` remains separate |
| Trap `path-leak-trap` | Avoid leaking absolute paths in outputs | Sanitize status API and activity summaries |

Related hits recorded; no exact same-issue open PR. Continue.

### Design Intent

Greenfield skip: no prior status-monitor page or tool-activity ring buffer to restore. Adjacent intentional constraints: canvas stays a graph viewer; SSE `/health` stays machine JSON; the 8-tool MCP surface stays frozen. The status page is an ops companion, not a second canvas or a ninth tool.

## Notes

### Default ports

| Service | Default port | CLI |
|---------|--------------|-----|
| MCP SSE transport | `3000` | `memo serve --sse` |
| Status monitor | `3001` | co-starts with `--sse` (disable with `--no-status`) |
| Canvas graph viewer | `4100` | `memo canvas` |

### ActivityEvent JSON contract

Canonical shape stored in the ring buffer and streamed to clients:

```json
{
  "id": "evt-7f3a2b1c",
  "seq": 42,
  "ts": "2026-08-26T04:20:00.000Z",
  "type": "tool",
  "kind": "read",
  "ok": true,
  "durationMs": 18,
  "summary": "search traps path=src/store.ts (3 hits)",
  "tool": "search",
  "projectId": "github.com-jpolvora-spec-memo",
  "method": null,
  "path": null,
  "statusCode": null
}
```

Field rules:

- `tool`, `method`, `path`, `statusCode`, and `projectId` are omitted (not `null`) when not applicable.
- `type: "http"` events set `method`, `path`, `statusCode`; `type: "tool"` events set `tool`.
- `type: "system"` events use `kind: "meta"` and omit `tool`/`projectId`.

### Filter semantics

- **All vaults**: every captured event is eligible for display.
- **Specific vault**: show events where `projectId === filter` **or** `projectId` is absent (HTTP/system transport lines stay visible).

### UX

- Beauty requirement: calm dark layout (brand → status cards → vault filter → vault list → live log), readable monospace log, subtle motion on new lines, color accent for writes/errors — zero CDN deps (inline CSS/JS like canvas).
- Stdio-only `memo serve` (no `--sse`) does not start the status companion.
- Companion design notes: [`mcp-status-monitor.context.md`](mcp-status-monitor.context.md).

## Out of Scope

| Feature | Reason |
|---------|--------|
| Canvas graph / record detail panels | Owned by `canvas-viewer`; status page is ops-only |
| Mutating vault actions from the browser | Read-only monitor; writes stay MCP/CLI |
| Ninth MCP tool for status | Human HTTP page + existing serve process; PRD §6 stays at 8 tools |
| Mobile companion / remote multi-user dashboard | Explicitly deferred in `index.PRD` Inbox |
| Persisting activity events as vault `log` records | In-memory ring buffer is enough for live watching |
| Replacing or removing `GET /health` on the SSE port | Keep machine health; status page is the human UI |
| Embedding status UI on port `3000` | User asked for a separate favoritable `:3001` surface |
| Per-vault aggregate stats dashboard (counts, charts) | Filter + live log only; analytics deferred |
| Hiding global HTTP/system events when a vault filter is active | Operators need transport health visible while drilling into one project |
| Standalone `memo status` command without `--sse` | v1 co-hosts only; deferred in context companion |
| Export/download of activity log | Clear view is client-side only; no file export in v1 |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Process model | Co-host status listener in the `memo serve --sse` process on default port `3001` | Enables accurate in-process capture without IPC | y |
| Event pipeline | capture → sanitize → ring buffer → emit → `/api/events` + `/api/events/stream` → UI append | Explicit realtime contract for API/tool activity | y |
| Project scoping | Optional `projectId` on tool events when single project is resolved | Enables vault filter without guessing on cross-project calls | y |
| Filter semantics | Selected vault shows matching events + events with no `projectId` | Keeps HTTP/system lines visible during focused monitoring | y |
| Filter UX | Client-side instant filter + server `project=` on APIs + `?project=` URL + sessionStorage | Bookmarkable, fast toggling, reconnect-safe | y |
| Auth | Loopback default; bearer or `?token=` for EventSource | Same posture as SSE/canvas; EventSource cannot set headers | y |
| Ring buffer size | Cap at 200 events, FIFO drop | Enough for a live glance; bounds memory | y |
| Status refresh | Poll `/api/status` every 5s | Keeps uptime/transports current without SSE for metadata | y |
| Stdio-only serve | No status companion | No HTTP MCP surface to monitor | y |
| Implicit dimensions (TTL, idempotency, external deps) | N/A because this slice is an ephemeral in-process read-only ops UI with no new persistence class or third-party service | Existing vault locks and redaction cover data safety | y |

### Revision History

### [2026-08-26] Revision: Index sync — marked in progress for batch Spec→PR delivery (Prompt: "sync specs with index, prepare batch till deploy")
