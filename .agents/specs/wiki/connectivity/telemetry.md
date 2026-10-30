# Operational Telemetry

## Feature Overview

`spec-memo` optionally records a structured, append-only usage stream to help agents and operators analyze latency, error frequency, and unused endpoints. Telemetry is controlled by `enableTelemetry` (default `true`) in `config.json`, with rolling file limits under the external vault at `$SPEC_MEMO_ROOT/telemetry/` — never inside a product git repository.

Each event is one JSON line:

```json
{"timestamp":"2026-08-27T04:20:00.000Z","eventId":"tel-<uuid>","category":"mcp_tool","operation":"bootstrap","durationMs":18.3,"success":true,"projectId":"github.com-org-repo","metadata":{"itemCount":12}}
```

Capture surfaces: MCP tool executions (`mcp_tool`), HTTP requests in the SSE and status servers (`http_endpoint`), CLI subcommand runs (`cli_command`), sync cycles (`sync_operation`), curator GC (`curator_gc`), the importer (`importer`), and handoffs (`handoff`).

## Business Rules & Logic

- Enable precedence: `SPEC_MEMO_ENABLE_TELEMETRY` env var wins over `config.json` `enableTelemetry`, which defaults to `true` when unset. Env falsy values are `0`, `false`, `off`, `no`; truthy values are `1`, `true`, `on`, `yes`. When disabled, `record` discards immediately with zero disk I/O and zero queue growth.
- Event schema: `timestamp` (ISO-8601 UTC), `eventId` (`tel-<uuid>`), `category` (enum), `operation`, `durationMs` (rounded to 1 decimal, floored at 0), `success` (boolean), optional `errorCode`, optional `projectId`, optional sanitized `metadata` object.
- Rolling files: `telemetry-YYYY-MM-DD.part-N.jsonl` under `$SPEC_MEMO_ROOT/telemetry/`. The date is the event's UTC day; `N` starts at `1`. When appending would push the current part past `maxFileSizeMb` (default `10` MB), the engine advances to `part-{N+1}`; on a new UTC day it starts at `part-1` without a process restart.
- Batching is non-blocking: events queue in memory and flush on a timer (`flushIntervalMs`, default `500` ms) or immediately when the queue reaches `maxQueueSize` (default `50`). Flush writes are wrapped in the vault lock and use `fs.appendFileSync`.
- Fail-safe: any write, permission, or filesystem error is caught internally, stored as `lastError`, and never rejects or interrupts an MCP tool response, CLI command, or HTTP request. `recordTelemetry` itself swallows errors.
- Metadata is scrubbed through `sanitizeToolOutput`; credentials, tokens, and absolute host paths must not appear in telemetry metadata.
- Drain on exit: a `process.on('beforeExit')` handler calls `flushTelemetrySync`, and server `close()` paths call `flushTelemetrySync` plus `await closeTelemetry`. `closeTelemetry` marks the recorder closed, flushes asynchronously and synchronously, and removes the cached recorder and enabled-cache entry.
- `memo doctor` treats in-repo `telemetry.jsonl` as pollution; the vault `telemetry/` directory is in the vault-git ignore list.

## Technical Architecture

- `src/telemetry.ts`: `isTelemetryEnabled`, `getTelemetryDir`, `TelemetryRecorder` class (`record`, `flush`, `flushSync`, `resolveCurrentPartFile`, `applyConfig`, `close`), and module functions `getTelemetryRecorder`, `recordTelemetry`, `flushTelemetry`, `flushTelemetrySync`, `closeTelemetry`, `resetTelemetryRecorderForTest`, `listTelemetryFiles`, `readTelemetryEvents`.
- `DEFAULT_TELEMETRY_CONFIG` = `{ maxFileSizeMb: 10, flushIntervalMs: 500, maxQueueSize: 50 }`; `VaultConfig.telemetry` accepts `maxFileSizeMb`, `flushIntervalMs`, `maxQueueSize`. `applyConfig` clamps `flushIntervalMs` to a 100 ms floor and sizes to at least 1.
- Config reads are cached per vault root keyed by `config.json` mtime, so hot edits take effect without repeated synchronous reads on the tool hot path.
- One recorder instance is kept per vault root in a module-level map; `getTelemetryRecorder` merges file config with per-call options.
- `listTelemetryFiles` returns `telemetry-*.jsonl` sorted; `readTelemetryEvents(vaultRoot, { date?, part? })` parses lines and skips corrupted entries.
- Type contract (`src/types.ts`): `TelemetryCategory`, `TelemetryEvent`, `TelemetryEventInput`, `TelemetryConfig`.
- Provenance: `0028-operational-telemetry.spec.md`. The spec's CLI inspector surface is `readTelemetryEvents`/`listTelemetryFiles` (no new MCP tool or CLI command); telemetry is machine-local and excluded from backups of durable records.
