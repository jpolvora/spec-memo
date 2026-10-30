---
id: null
slug: cli-start-shortcuts
title: "CLI start, stop, and restart subcommands and shortcuts for monitor, canvas, mcp, and server"
source: local
specDate: 2026-09-14
---

# Specification — CLI start, stop, and restart subcommands and shortcuts for monitor, canvas, mcp, and server

## Description

Users need quick and intuitive CLI commands to manage the lifecycle of spec-memo services and web dashboards:
- `memo start <service>`: Start background services (`monitor`, `canvas`, `server`, `mcp`). If the instance is already started, print info to the user with running URLs and exit 0 (idempotent).
- `memo stop <service>`: Stop specific services by name (`server`, `monitor`, `canvas`) or `--port`. If called with no service, retains existing `memo shutdown` behavior.
- `memo restart <service>`: Stop any existing instance of the service, wait for port release, and start a fresh instance.
- Direct shortcuts: `memo monitor` (start monitor), `memo server` (start SSE server), `memo mcp` (start stdio MCP), and `memo canvas` (start visual canvas).

## Acceptance Criteria

- [x] AC1: `memo start <service>` supports services: `monitor` (aliases: `status`, `status-monitor`), `canvas`, `server` (alias: `sse`), and `mcp`.
- [x] AC2: Idempotent start: if the target service is already running on the requested port, `memo start <service>` detects the running service via probe, prints status information (URLs and restart hint), and exits `0` without error.
- [x] AC3: `memo start monitor` (and direct alias `memo monitor`) starts `startStatusServer` on default port `3124` (configurable via `config.json` `ports.status` or `--port`), binds to `127.0.0.1` (or `--host`), supports `--vaultRoot`, `--auth-token`, and `--json`, prints user-facing dashboard URLs, and stops gracefully on SIGINT/SIGTERM.
- [x] AC4: `memo start canvas` starts `startCanvasServer` on default port `3125` (configurable via `config.json` `ports.canvas` or `--port`), supporting `--vaultRoot`, `--project`, `--host`, `--auth-token`, and `--json`.
- [x] AC5: `memo start server` (and alias `memo start sse`, direct alias `memo server`) starts `startSseServer` on default port `3123` with status companion on `3124` unless `--no-status` is specified.
- [x] AC6: `memo start mcp` (and direct alias `memo mcp`) starts stdio MCP server (`startMcpServer`) by default, or SSE server when `--sse` is passed.
- [x] AC7: `memo stop <service>` stops specific services: `memo stop server`, `memo stop monitor`, `memo stop canvas`, or by `--port`. Plain `memo stop` (with no service) preserves existing `memo shutdown` behavior.
- [x] AC8: `memo restart <service>` (`server`, `monitor`, `canvas`) stops the running instance if active, confirms port release, and starts the fresh instance.
- [x] AC9: `memo start`, `memo stop`, and `memo restart` without arguments (or with `--help`) print descriptive usage and available services.
- [x] AC10: Automated unit and integration tests cover `memo start`, `memo stop <service>`, `memo restart`, idempotent running check, JSON output, and direct shortcuts.
- [x] AC11: Documentation (`README.md`, `AGENTS.md`, `FEATURES.md`, `PLAN.md`, `PRODUCT.PRD`, `.agents/specs/index.PRD`, and `ws-memo` skill files) updated to reflect the new command surface.
