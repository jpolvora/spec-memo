---
id: null
slug: memory-adapter-mcp
title: "Consumer memory adapter for spec-memo MCP tools"
source: local
specDate: 2026-08-25
---

# Specification — Consumer memory adapter for spec-memo MCP tools

## Description

Provide client adapters in consumer workflows (e.g. `workflow-skills`) that route `read-memory` and `update-memory` operations to the `spec-memo` MCP server or `memo` CLI instead of performing raw file reads/writes inside the product tree.

Greenfield feature. Design Intent skipped: Phase 2 consumer MCP integration.

## Acceptance Criteria

- AC1: Consumer memory routines call `bootstrap` at workflow session start to load path-relevant traps and decisions within the configured byte budget (default 8 KB).
- AC2: Anti-regression trap recording invokes `upsert` with `kind: "trap"` via MCP/CLI instead of directly writing to `memory/*.md`.
- AC3: Task completion changelog events invoke `append` with `kind: "log"` via MCP/CLI.
- AC4: The consumer adapter gracefully falls back or reports actionable diagnostics if `spec-memo` MCP server is unreachable.

## Original Issue Context

PRD Phase 2: `{memoRoot}` / MCP as `read-memory` / `update-memory`. Connect consumer agent skills to spec-memo MCP server.

## Notes

- Uses stdio transport for local agent interaction.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Custom proprietary IDE plugins | Standard MCP stdio interface is host-neutral |
| In-repo caching of memory results | Bootstrap brief is requested per session |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Transport protocol | MCP stdio JSON-RPC | Official standard protocol supported across IDEs and harnesses | y |
| Fallback behavior | Warn and skip instead of failing hard if memo server is not installed | Enables standalone consumer operation | y |
| Implicit dimensions | N/A because MCP handles JSON-RPC framing and timeout | Standard MCP SDK behavior | y |
