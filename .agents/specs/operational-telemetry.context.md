# Operational Telemetry & Structured Rolling Usage Logging — Context & Decisions

## Feature Boundary

Operational telemetry in `spec-memo` captures real-time usage data across MCP tool calls, HTTP server endpoints, CLI invocations, and sync operations to enable AI agents and system maintainers to diagnose performance bottlenecks, optimize common workflows, and safely deprecate unused functionality.

### In-Scope Boundaries
- Configuration toggle `enableTelemetry` in `~/.spec-memo/config.json` (defaults to `true`).
- Structured JSON Lines (`.jsonl`) append-only logging stored exclusively in the external vault under `$SPEC_MEMO_ROOT/telemetry/`.
- Daily rolling rotation partitioned into parts when file size exceeds `maxFileSizeMb` (e.g., `YYYY-MM-DD.part-1.jsonl`, `YYYY-MM-DD.part-2.jsonl`).
- Low-latency asynchronous stream buffering with batched non-blocking disk flushes.
- Resilient fail-open design: disk I/O errors or full disks will never interrupt or fail the primary MCP/CLI tool execution.
- Sensitive data sanitization matching `sanitizeToolOutput` (stripping auth tokens, passwords, vault paths).

### Out-of-Scope Boundaries
- Writing telemetry logs inside the product git repository (strictly violates the core `spec-memo` invariant).
- Real-time cloud telemetry streaming or third-party analytical SaaS ingestion (remains local-first).
- Heavyweight distributed telemetry standards (e.g. OpenTelemetry collector daemons) in Phase 7.

---

## Implementation Decisions

### 1. File Location & Namespace
- **Decision:** Store telemetry files in `$SPEC_MEMO_ROOT/telemetry/` at the root vault level with optional `projectId` tagging per event rather than scattering across project directories.
- **Rationale:** Tool executions (like `check_version`, `doctor`, global search) often run across projects or without an active project context. A centralized rolling telemetry log enables holistic system profiling while allowing simple filtering by `projectId`.

### 2. Rolling File Naming Scheme
- **Decision:** Format rolling file names as `telemetry-YYYY-MM-DD.part-{N}.jsonl` (e.g. `telemetry-2026-08-27.part-1.jsonl`).
- **Rationale:** ISO date prefix enables trivial chronological sorting and cleanup; `part-{N}` suffix cleanly handles daily size rollover when volume spikes.

### 3. Asynchronous Batching & Safe Flush
- **Decision:** Telemetry events are captured into an in-memory queue and flushed asynchronously via Node.js write streams with `fs.createWriteStream({ flags: 'a' })` on a debounced interval (default 500ms) or when buffer reaches 50 events.
- **Rationale:** Synchronous disk writes on every MCP call introduce measurable latency into agent tool loops. Asynchronous batching eliminates blocking overhead.

### 4. Zero-Crash Error Handling
- **Decision:** Stream error listeners catch and silently handle write failures (or log to stderr once per debounce cycle) without throwing into caller promises.
- **Rationale:** Telemetry is auxiliary observability; it must never degrade user tool execution.

---

## Deferred Ideas

- **Agentic Telemetry Digest Tool:** An offline CLI diagnostic (`memo telemetry --summary`) to analyze event frequency, latency percentiles (p50, p95), and error rates.
- **Automated GC for Telemetry:** Adding a `telemetryRetentionDays` (e.g., 30 days) to `memo gc` to prune stale `.part-*.jsonl` files.
