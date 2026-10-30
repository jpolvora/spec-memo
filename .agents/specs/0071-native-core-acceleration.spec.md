---
id: null
slug: native-core-acceleration
title: "Native Core Engine Acceleration: Compiled Daemon, Relational Indexing, and Fast I/O"
source: local
specDate: 2026-10-03
issueState: open
---

# Specification — Native Core Engine Acceleration: Compiled Daemon, Relational Indexing, and Fast I/O

**State:** draft

## Description

The `spec-memo` runtime provides local working memory for coding agents outside target repositories through 11 MCP tools, an SSE transport daemon, and a CLI (`memo`). Today, the implementation runs entirely on Node.js/TypeScript, using `better-sqlite3` native C++ bindings, `gray-matter` for YAML parsing, and synchronous filesystem APIs.

While effective, the Node.js architecture introduces performance bottlenecks and operational fragility under heavy multi-agent workloads:
1. **Cold-Start Overhead**: CLI turns (`memo bootstrap`, `memo get`, `memo search`, `memo upsert`) incur a 150ms-300ms Node.js runtime boot and module initialization cost per turn.
2. **I/O Amplification in Storage & Compiler**: `listProjectRecords` and `scanProjectRecords` scan directory trees and parse every Markdown record off disk synchronously on every bootstrap turn and compiled-view rebuild.
3. **Search Disk Thrashing**: SQLite FTS5 stores only lexical text; frontmatter fields (`hits`, `occurrences`, `severity`, `expiresAt`, `salience`) are omitted from relational columns. Consequently, every search hit triggers synchronous disk reads and frontmatter parsing from Markdown files, while `occurrences` and `hits` sorting bypasses FTS entirely to read every file in the project.
4. **Windows File-Lock Instability**: Atomic file replacement and SQLite WAL file locks under Windows NTFS trigger `EBUSY`/`EPERM` collisions during concurrent writes.
5. **Native Addon Fragility**: `better-sqlite3` requires Node ABI compatibility, breaks across Node version upgrades, and suffers from client-working-directory module resolution traps.

This specification defines a compiled native acceleration architecture (with Go as the primary affordable implementation language, or Rust as the systems alternative) to extract the core storage, relational indexing, bootstrap brief synthesis, safety I/O scanning, and MCP/SSE daemon into a single self-contained binary while maintaining 100% backward compatibility with the filesystem Markdown vault format.

## Acceptance Criteria

- AC1: The native core engine shall maintain 100% bidirectional Markdown vault compatibility with existing `~/.spec-memo/` directory and record structures.
- AC2: When indexing records into SQLite, the native engine shall persist all frontmatter metadata fields into indexed relational table columns alongside the FTS5 virtual table.
- AC3: When executing search queries across all sort modes, the native engine shall satisfy query filters and ranking from SQLite tables without performing post-query filesystem reads.
- AC4: When generating the session bootstrap brief, the native engine shall enforce token budgeting, trap scoring, and session handoff extraction in under 15 milliseconds for a 1,000-record vault.
- AC5: When checking for specification git drift, the native engine shall inspect git status and tree objects via in-process library bindings without spawning external git subprocesses.
- AC6: When performing atomic file writes on Windows, the native engine shall utilize native filesystem replacement APIs to eliminate file-lock collision retries.
- AC7: When running the background SSE and status daemon, the native service shall consume less than 30 megabytes of resident set memory under idle multi-client operation.
- AC8: When launched as a CLI command, the native binary shall complete cold-start invocation within 25 milliseconds on host platforms.
- AC9: When scanning record bodies for secrets and untrusted prompt injection patterns, the native safety engine shall execute deterministic DFA pattern matching with zero heap string allocations.
- AC10: If an unknown or corrupted markdown record is encountered during vault scanning, then the native engine shall record a diagnostic warning and continue batch processing without crashing.

## Out of Scope

| Item | Reason |
|---|---|
| Modifying the on-disk Markdown and YAML frontmatter vault format | Preserves human readability, Obsidian compatibility, and git portability |
| Rewriting the browser-rendered HTML/CSS/JS UI in WebAssembly | Browser engine handles UI presentation efficiently; serving static assets via native HTTP is sufficient |
| Deprecating existing MCP tool contracts or parameter schemas | All 11 MCP tools must remain 100% interface-compatible with host coding agents |
| Requiring a cloud account or remote coordination service | Local-first filesystem and single-binary principles remain non-negotiable |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|---|---|---|---|
| Implementation Language | Go (primary recommendation) | Highest affordability, fastest build velocity, seamless cross-compilation, and trivial goroutine concurrency | y |
| SQLite Driver in Go | Pure Go (`modernc.org/sqlite`) with optional CGo build flag | Eliminates C compiler requirements for consumers while retaining single-binary portability | y |
| Migration Strategy | Dual-engine phased transition | Allows incremental benchmarking of native core while running against full Node test suite | y |
| CLI Distribution | Single self-contained static executable | Eliminates Node.js runtime and npm installation dependency for end-users | y |
| Internationalization | N/A because MCP contracts and CLI output are standardized on English | Follows repository product rules | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|---|---|---|
| Scope Boundaries | Core vault storage, SQLite indexing, bootstrap brief synthesis, and SSE/HTTP daemon | Architecture review |
| Vault Compatibility | Zero change to markdown frontmatter or directory hierarchy | Round-trip format test |
| Concurrency Safety | Multi-writer file-lock protection and atomic replacements | Parallel stress test harness |
| Binary Portability | Statically linked binaries for Windows (x64), Linux (x64/ARM64), and macOS (ARM64/x64) | CI cross-compilation matrix |
| Blocker Status | Zero open blockers; existing TypeScript test suite acts as specification oracle | `npm test` baseline comparison |

## Validation & Observation Notes

### Telemetry

- Cold-start invocation latency measured via high-resolution timer (`time memo bootstrap`).
- Process resident set size (RSS) monitored via process inspection telemetry during active SSE sessions.
- Search execution duration reported via `explain.timings` in search hit payloads.
- Zero `EBUSY` / `EPERM` file-lock retry errors recorded in `error.logs` under Windows stress testing.

### Negative & Failing Test Scenarios

- Concurrent write collision test: Multiple parallel native processes attempting simultaneous upserts on the same record slug must succeed via atomic swap without file corruption or partial truncation.
- Corrupted frontmatter handling: Malformed YAML blocks must fail closed with structured validation errors rather than panicking or crashing the native daemon.
- Unhandled SQLite ABI mismatch: Elimination of external `.node` native binary loading prevents `NODE_MODULE_VERSION` incompatibilities entirely.
- Stack invariant: Non-loopback SSE transport binds must refuse connection establishment if an authorization token is not configured.

## Notes

This specification addresses the architectural scalability of the spec-memo runtime as knowledge repositories grow past thousands of records across active multi-agent pairing sessions.
