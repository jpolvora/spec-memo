---
slug: mcp-sse-transport
title: "HTTP and Server-Sent Events (SSE) MCP Transport"
status: completed
target_phase: Phase 5
created: 2026-08-25
---

# Feature: HTTP and Server-Sent Events (SSE) MCP Transport

## 1. Context & Goal

Extend spec-memo's MCP server capabilities beyond local stdio to support network-accessible Server-Sent Events (SSE) HTTP transport. This enables remote AI agents, web-based tools, containerized runners, and IDE plugins to connect to the spec-memo server over HTTP.

## 2. Acceptance Criteria

- **AC1 — SSE Server Implementation:**
  - `startSseServer(options)` starts an HTTP server utilizing `@modelcontextprotocol/sdk/server/sse.js`.
  - Configurable port (default `3000`) and host (default `127.0.0.1`).
  - Implements `/sse` endpoint for establishing persistent client event stream.
  - Implements `/message` endpoint (POST) for handling inbound JSON-RPC client messages.

- **AC2 — Tool Parity:**
  - Exposes the exact same 8 core MCP tools as stdio: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`.
  - Adheres to all budget caps, secret redaction, and project binding rules.

- **AC3 — Health & Status Endpoint:**
  - `GET /health` returns JSON payload indicating server status, active port, uptime, and vault project count.

- **AC4 — CLI Command:**
  - `memo serve [--port <p>] [--host <h>] [--sse]` boots the HTTP/SSE daemon.
  - Provides graceful shutdown on SIGINT/SIGTERM.
