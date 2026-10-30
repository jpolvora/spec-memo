# Native Core Engine Acceleration — Architecture & Language Context

## Feature Boundary

### Native Core Engine (In-Scope for Rewrite)
- **Core Storage Engine (`src/store.ts`, `src/compiler.ts`)**:
  - Vault directory scanning, YAML frontmatter parsing, atomic file writing with OS-native rename APIs on Windows, compiled-view generation (`TRAPS.md`, `DECISIONS.md`, `SPECS.md`).
- **Relational & FTS5 Indexing (`src/indexer.ts`)**:
  - Single SQLite database with both relational table (`records` containing all frontmatter metadata columns: `id`, `project_id`, `kind`, `status`, `title`, `tags`, `path_patterns`, `severity`, `layer`, `hits`, `last_hit`, `occurrences`, `last_seen`, `expires_at`, `updated`) and FTS5 virtual table (`records_fts`).
  - Search execution completes entirely in SQLite with zero subsequent disk I/O.
- **Session Bootstrap Engine (`src/bootstrap.ts`)**:
  - In-process token budgeting, trap scoring, retrieval lenses, session handoff parsing, and in-process git inspection (via `libgit2` or pure-Go git).
- **Safety Engine & MCP I/O Guard (`src/safety.ts`, `src/io-guard.ts`)**:
  - Zero-allocation DFA secret scanning, prompt-intent pattern matching, untrusted fence parsing, SIMD SHA-256 calculation.
- **Daemon & Transports (`src/server.ts`, `src/mcp.ts`, `src/activity.ts`)**:
  - Stdio MCP server, HTTP/SSE transport on `:3123`, Status REST API on `:3124`, concurrency via goroutines or tokio tasks.
  - CLI binary (`memo`) with sub-25ms cold start.

### Retained in TypeScript / Web Layer (Out of Scope for Rewrite)
- **Status Monitor Frontend UI (`src/status.ts` HTML/CSS/JS)**:
  - The rich web dashboard, responsive layouts, error log drawers, backup management modals, and canvas graph UI are client-side browser concerns.
  - The native daemon serves these assets as embedded static files (`//go:embed` or `include_str!`).
- **Agent Skill Contracts & Rules (`.agents/skills/*`)**:
  - Prompt instructions and agent operating guidelines remain in Markdown.
- **Build & CI Documentation Scripts (`scripts/*.js`)**:
  - Documentation generation and website publishing scripts remain lightweight Node.js utilities.

---

## Implementation Decisions

### 1. Language Selection: Why Go is the Most Affordable Choice

| Evaluation Metric | Go | Rust | C# (.NET 9 Native AOT) |
|---|---|---|---|
| **Development Velocity / "Affordability"** | **Highest**: Minimal boilerplate, clean stdlib, easy concurrency | **Lowest**: Strict borrow checker, complex async lifetimes | **Moderate**: Familiar OOP/C#, good tooling, verbose cross-build |
| **CLI Cold Start** | 8 - 18 ms | 1 - 4 ms | 15 - 35 ms |
| **Daemon RSS Memory** | 12 - 28 MB | 8 - 18 MB | 35 - 70 MB |
| **Binary Size** | 12 - 20 MB (single static executable) | 8 - 15 MB (single static executable) | 25 - 50 MB (Native AOT) |
| **Cross-Platform Compilation** | **Trivial**: `GOOS=windows/linux/darwin go build` out of the box | Requires cross-linkers (`cargo-zigbuild` / `cross`) | Complex toolchain per target OS |
| **SQLite Integration** | `modernc.org/sqlite` (pure Go, no CGo) or `mattn/go-sqlite3` | `rusqlite` (bundled C SQLite) | `Microsoft.Data.Sqlite` |
| **MCP Ecosystem** | `mark3labs/mcp-go` (mature, feature-complete) | `rmcp` (community) | `ModelContextProtocol` |

**Decision**: **Go** is selected as the primary target for the rewrite because "affordability" encompasses both runtime efficiency and engineering velocity. Go provides 90% of Rust's speed and memory advantages while requiring roughly 30% of the implementation and maintenance effort. It provides seamless cross-compilation for all major developer platforms without CGo or toolchain headaches.

### 2. Eliminating the Search Disk-Thrashing Flaw

**Current Flaw in TypeScript**:
In `src/indexer.ts`, SQLite `records_fts` only indexes text tokens. Whenever SQLite returns matching IDs, Node.js synchronously reads the Markdown file from disk (`fs.readFileSync`) and parses frontmatter twice to extract `hits`, `occurrences`, `severity`, and `expiresAt`. For `hits` or `occurrences` sorting, FTS is abandoned and every file in the project is read from disk.

**New Relational Schema Decision**:
The native SQLite schema will maintain a normalized table:
```sql
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  tags TEXT,
  path_patterns TEXT,
  severity TEXT,
  layer TEXT,
  hits INTEGER DEFAULT 0,
  last_hit TEXT,
  occurrences INTEGER DEFAULT 1,
  last_seen TEXT,
  expires_at TEXT,
  filepath TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX idx_records_project_kind_status ON records(project_id, kind, status);
CREATE INDEX idx_records_hits ON records(project_id, hits DESC);
CREATE INDEX idx_records_occurrences ON records(project_id, occurrences DESC);
```
Searches with sorting, filtering, and scoring execute in a single SQL query in <1ms without touching disk.

### 3. Windows Atomic File Replacement

**Decision**: On Windows NTFS, file renaming over an existing file can throw `EBUSY`/`EPERM` when concurrent processes or antivirus hold open handles. The Go implementation will use Windows API `SetFileInformationByHandle` with `FILE_RENAME_FLAG_REPLACE_IF_EXISTS` or native transactional replace, completely eliminating `sleepSync` retry loops.

---

## Deferred Ideas

- **In-Process Embedding Inference**: Running local embedding models (e.g., MiniLM via ONNX Runtime or Candle) directly in the daemon for vector search without external Python or API dependencies.
- **Native Desktop Tray Companion**: Compiling a lightweight system tray status app (e.g. using `systray` in Go or `tauri` in Rust) to monitor daemon health and toggle ports.
- **Bidirectional CRDT Sync**: Moving beyond 3-way delta sync to state-based conflict-free replicated data types for real-time collaborative multi-agent vaults.
