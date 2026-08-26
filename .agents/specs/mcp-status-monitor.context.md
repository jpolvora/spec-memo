# mcp-status-monitor — design companion

Gray-area product choices for [`mcp-status-monitor.spec.md`](mcp-status-monitor.spec.md). Not a plan artifact.

## Feature Boundary

In: a bookmarkable local HTML status page that lists vault projects, shows MCP SSE server health, streams a live sanitized activity log (capture → buffer → emit), and filters that log by vault/project.

Out: canvas graph UI, remote multi-user dashboards, mobile companion app, mutating vault actions from the page, a ninth MCP tool, Obsidian/plugin viewers, per-vault analytics charts, standalone `memo status` without `--sse`, activity log file export.

## Implementation Decisions

### Process model: co-host companion on :3001 (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Same Node process as `memo serve --sse`, second listener on default `3001` (chosen)** | Live tool-call log is accurate without IPC; bookmark `http://127.0.0.1:3001/`; SSE MCP stays on `3000`. |
| B. Separate `memo status` process only | Easy to start alone, but cannot observe in-process tool calls unless an event bus is invented. |
| C. Serve status HTML on the SSE port (`/status` on `3000`) | One port to remember, but mixes MCP transport with a human UI and fights the user's explicit `:3001` ask. |
| D. Extend canvas (`4100`) with a status tab | Reuses HTML host, but couples graph UX to ops monitoring and changes canvas scope. |

### Live logger source: Activity Event Bus (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Activity bus: capture tool + HTTP events → ring buffer → SSE `/api/events/stream` (chosen)** | Explicit log/capture/emit pipeline; webpage subscribes and appends in realtime. |
| B. Log only HTTP hits on `/sse` and `/message` | Cheap, but JSON-RPC batches hide tool names and vault side effects. |
| C. Tail vault filesystem mtimes | Misses reads; noisy; not realtime for failed calls. |

### Vault/project filter: client instant + server query (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Dropdown filter; client applies rules instantly; APIs accept `project=`; URL `?project=` + sessionStorage (chosen)** | Fast toggling without reconnect; bookmarkable deep link; stream reconnect can narrow bandwidth. |
| B. Server-only filter (reconnect stream on every change) | Less client logic, sluggish UX when switching vaults often. |
| C. Separate stream per vault | Many connections; harder to fan-out from one bus. |

Filter rule when one vault is selected: show events with matching `projectId` **and** events with no `projectId` (HTTP/system) so transport health stays visible.

### Auth posture: match SSE/canvas loopback rules (chosen)

| Option | Trade-off |
|--------|-----------|
| **A. Default bind `127.0.0.1`; require bearer token for non-loopback (chosen)** | Same refusal pattern as `startSseServer` / `startCanvasServer`. |
| B. Always open without auth | Convenient on LAN, unsafe for vault metadata and activity content. |
| C. Cookie session / OAuth | Overkill for a local ops page. |

## Deferred Ideas

- Attach a standalone `memo status` that reconnects to a running serve process over a unix socket / named pipe.
- Persist activity logs into vault `log` records.
- Mobile companion dashboard (already in `index.PRD` Inbox).
- Embedding the canvas graph inside the status page.
- Per-vault event counters and sparklines in the vault list.
