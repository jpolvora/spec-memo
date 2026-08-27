---
id: null
slug: operational-telemetry
title: "Operational Telemetry & Structured Rolling Usage Logging"
source: local
specDate: 2026-08-27
status: completed
target_phase: Phase 7
---

# Specification — Operational Telemetry & Structured Rolling Usage Logging

## Description

Today `spec-memo` operates as an external working memory store for coding agents, serving MCP tools (stdio & SSE), CLI subcommands, REST endpoints, and background synchronization tasks. As agentic development workflows grow in complexity, understanding runtime usage patterns, operation durations, ingestion throughput, error frequencies, and unused tool endpoints is critical for continuous optimization.

Currently, operational observability in `spec-memo` is limited to runtime activity events (via `ActivityBus` for the status monitor) and error logs (via `ErrorLogger`). There is no persistent, structured telemetry stream that records complete operational metrics over time without polluting product git repositories.

This specification introduces **Operational Telemetry & Structured Rolling Usage Logging**, providing:
1. **Configuration Switch (`enableTelemetry`):** A top-level setting in `config.json` (default `true` - enabled) with fine-grained rolling limits (`maxFileSizeMb`, `flushIntervalMs`).
2. **Append-Only Structured JSONL Stream:** High-efficiency, non-blocking telemetry emitter capturing detailed event payloads (operation type, tool/endpoint name, duration in ms, success/error status, timestamp, project identifier, and payload size metrics).
3. **Daily Rolling Part Files (`telemetry-YYYY-MM-DD.part-N.jsonl`):** Automatic rolling file partitioning by date and size limit under the external vault directory (`$SPEC_MEMO_ROOT/telemetry/`), strictly outside product git repositories.
4. **Resilient Fail-Safe Execution:** Asynchronous stream buffering with automatic flushes that never block the primary MCP/CLI loop and fail open upon I/O errors.
5. **AI Agent Analytical Optimization Foundation:** Standardized JSONL output designed for AI agent digestion to discover performance bottlenecks, identify unused features for cleanup, and propose architectural enhancements.

## Acceptance Criteria

### Configuration & Default State

- AC1: `VaultConfig` schema in `src/types.ts` and `DEFAULT_VAULT_CONFIG` in `src/vault.ts` include `enableTelemetry: boolean` (defaulting to `true` when unset) and optional `telemetry?: { maxFileSizeMb?: number; flushIntervalMs?: number; maxQueueSize?: number }`.
- AC2: When `enableTelemetry: false` is configured in `config.json` (or overridden via environment variable `SPEC_MEMO_ENABLE_TELEMETRY=0` or `false`), the telemetry engine operates in a no-op mode, discarding events immediately with zero disk I/O and zero memory accumulation.

### Telemetry Event Schema & Capture Surface

- AC3: Telemetry events are formatted as single-line JSON objects with a standard schema:
  - `timestamp`: ISO 8601 UTC string (`YYYY-MM-DDTHH:mm:ss.sssZ`).
  - `eventId`: Unique alphanumeric identifier (e.g. `tel-<uuid>` or `tel-<timestamp>-<seq>`).
  - `category`: String enumeration (`mcp_tool` | `http_endpoint` | `cli_command` | `sync_operation` | `curator_gc` | `importer`).
  - `operation`: String name of the specific tool, subcommand, or route (e.g. `bootstrap`, `upsert`, `search`, `GET /api/status`, `memo gc`).
  - `durationMs`: Number representing total elapsed wall-clock execution time in milliseconds (accurate to at least 1 decimal place).
  - `success`: Boolean indicating whether the operation completed successfully without throwing or returning a tool error.
  - `errorCode`: Optional string error code when `success` is false (e.g. `INVALID_ARGUMENTS`, `RECORD_NOT_FOUND`, `HTTP_500`).
  - `projectId`: Optional normalized project identifier when operation is associated with a repository.
  - `metadata`: Optional sanitized key-value dictionary containing non-sensitive operational metrics (e.g. `itemCount`, `byteLength`, `queryLength`, `dryRun`, `clientMode`).
- AC4: MCP tool invocations in `executeTool` (`src/tools.ts`), HTTP API requests in `src/server.ts` & `src/status.ts`, CLI subcommand executions in `src/cli.ts`, and sync cycles in `src/hybrid-sync.ts` emit structured telemetry events upon completion.

### Append-Only Streaming & Rolling Rotation

- AC5: Telemetry files are written strictly inside the external vault root at `$SPEC_MEMO_ROOT/telemetry/`, never inside the consumer product working directory or repository tree.
- AC6: File names follow the rolling pattern `telemetry-YYYY-MM-DD.part-{N}.jsonl` where `YYYY-MM-DD` is the UTC date and `{N}` starts at `1` (e.g. `telemetry-2026-08-27.part-1.jsonl`).
- AC7: When writing an event would cause the current part file to exceed `maxFileSizeMb` (default `10` MB), the telemetry engine automatically closes the current file stream and creates `telemetry-YYYY-MM-DD.part-{N+1}.jsonl`.
- AC8: When the UTC calendar day advances, the telemetry engine rotates to the new date starting at `part-1` without requiring process restart.

### Fail-Safe Non-Blocking Execution & Error Isolation

- AC9: Telemetry emissions are non-blocking: events are pushed to an in-memory queue and flushed asynchronously via Node.js write streams on a periodic timer (`flushIntervalMs`, default `500` ms) or when queue length exceeds `maxQueueSize` (default `50` events).
- AC10: Disk write errors, permission denials, or filesystem exhaustion in the telemetry engine are caught internally, logged once to stderr (or discarded), and never reject or interrupt MCP tool responses, CLI commands, or HTTP requests.
- AC11: Telemetry records are sanitized through `sanitizeToolOutput` rules to prevent credential leaks, auth tokens, passwords, or absolute host file paths from appearing in telemetry event metadata.
- AC12: Process shutdown hooks (`SIGINT`, `SIGTERM`, `beforeExit`, and MCP server close) trigger a synchronous drain/flush of pending queued telemetry events before process exit.

## Original Issue Context

### User Prompt / Request

> introduce a config switch enableTelemetry: true | false in config.json (default true - enabled). The telemetry will be saved to structured files - append only - efficient writes - stream / flush to file flawlessly - should not interrupt the product in case of error - safe logging. This telemetry will contains usage data (endpoints, ingestion, function calling, duration ms for operations, etc. Filesize with limits / rolling files by day part 1, part 2, part N according to size limit, create next file. The logging results of telemetry goal is to provide to AI agent collected data to improve the product, for example, find optimizations in operations, increase performance, enhance stability overall, reliability, provide ideas for new features / cleanup no used functions/features, etc. If disabled, skip writing.

### Prior Work Sweep

- Prior feature specs:
  - `curator-gc-and-safety.spec.md` (Phase 1): established secret redaction and safety boundaries.
  - `mcp-status-monitor.spec.md` (Phase 6): established the in-memory `ActivityBus` for live SSE event streaming on `:3001/api/events/stream`.
  - `deployment-modes.spec.md` (Phase 7): established config handling and hybrid sync cycles.
  - `status-vault-backup-ui.spec.md` (Phase 7): added error logging subsystem (`ErrorLogger`).
- Existing codebase inspection:
  - `src/activity.ts` maintains a circular buffer of recent events in memory for status monitor UI, but does not persist them to disk.
  - `src/error-logger.ts` writes server error records to memory and status companion.
  - `src/vault.ts` defines `DEFAULT_VAULT_CONFIG` and `ensureVaultStructure`.
  - `src/tools.ts` dispatches all 10 MCP tools and tracks execution success/error.

### Design Intent

Greenfield telemetry subsystem for `spec-memo`. Telemetry log files are placed in the external vault `$SPEC_MEMO_ROOT/telemetry/` to respect the core dogfood invariant ("Product git is not a memory store; no in-repo `telemetry.jsonl`").

## Notes

- **Stream Performance:** Using Node.js `fs.createWriteStream` in append mode (`flags: 'a'`) with backpressure monitoring ensures minimal CPU and memory overhead during high-frequency agent tool execution.
- **Privacy & Safety:** All metadata is scrubbed for tokens, passwords, and sensitive path fragments prior to serialization.
- **Agent Analysis Ready:** Single-line JSON Lines format allows downstream AI analysis tools and CLI inspectors to parse entries with standard streaming JSON readers without loading the entire log into memory.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud-based telemetry upload / SaaS analytics ingest | `spec-memo` is strictly local-first; remote SaaS telemetry is excluded. |
| In-repo telemetry file storage (`telemetry.jsonl`) | Violates the core git boundary invariant; telemetry belongs in external vault only. |
| Real-time distributed tracing spans / OpenTelemetry collectors | Heavyweight dependency overhead; simple structured JSONL meets agentic optimization requirements. |
| Live interactive GUI dashboard for telemetry | Phase 7 focuses on reliable streaming capture; GUI analytics is deferred to future dashboard specs. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Config property name & default | `enableTelemetry: true` in `config.json` | Explicit toggle requested by user; default enabled for continuous improvement | n |
| Storage directory | `$SPEC_MEMO_ROOT/telemetry/` | External vault location shared across project sessions | n |
| Rolling file naming format | `telemetry-YYYY-MM-DD.part-{N}.jsonl` | Human-readable, date-sortable, and cleanly handles part-based rotation | n |
| Default size threshold | `10` MB per part file | Balances file granularity and prevents oversized log files | n |
| Default flush debounce interval | `500` ms | Minimizes disk I/O churn while keeping logs near real-time | n |
| Other implicit dimensions | N/A because auth is handled by MCP transport and indexing is handled by SQLite FTS | Standard local/SSE operation | n |

---

## Architectural Analysis & Suggestions

### Benefits for AI-Driven Product Optimization
1. **Bottleneck Identification:** By collecting `durationMs` across operations (e.g. `bootstrap` compiling large vaults vs. `search` query latency), AI agents reviewing telemetry can pinpoint queries that need SQL index optimization or caching.
2. **Dead Feature Pruning:** Telemetry tracks invocation counts across all 10 MCP tools and CLI subcommands. Operations with 0 hits across weeks of active usage can be safely recommended for deprecation or simplification.
3. **Failure Pattern Recognition:** Aggregating `errorCode` frequencies helps identify recurring agent mistakes or malformed parameters, allowing prompt/skill adjustments before bugs impact workflows.
4. **Token & Budget Tuning:** Tracking `itemCount` and payload sizes in `bootstrap` and `search` helps fine-tune default byte budgets (`bootstrap.maxBytes`).
