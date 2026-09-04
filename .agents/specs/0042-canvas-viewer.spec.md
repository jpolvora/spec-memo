---
slug: canvas-viewer
title: "Interactive Canvas UI and Visual Graph Viewer"
status: completed
target_phase: Phase 5
created: 2026-08-25
---

# Feature: Interactive Canvas UI and Visual Graph Viewer

## 1. Context & Goal

Provide human developers and agents with an embedded, zero-dependency visual graph viewer and HTTP canvas server (`memo canvas` / `memo serve-canvas`) to visually inspect memory, trap networks, decisions, active plans, and spec topologies stored in the vault without requiring third-party cloud tools.

## 2. Acceptance Criteria

- **AC1 — Embedded HTTP Canvas Server:**
  - `startCanvasServer(options)` initializes a local Node `http` server on the configured port (default `4100`).
  - Serves a rich, standalone HTML5/SVG/Canvas visualizer web app with dark mode, zoom/pan controls, force-directed/hierarchical graph layout, and search filtering.
  - No external runtime client dependencies required (uses self-contained HTML/CSS/JS).

- **AC2 — REST Query Endpoints:**
  - `GET /api/projects` returns JSON listing of all available projects in the vault.
  - `GET /api/project/:projectId/graph` returns nodes (records) and relational edges (`supersedes`, `relatedSlug`, `linkedPaths`, `tags`, `kind`).
  - `GET /api/record/:projectId/:kind/:id` returns full markdown body and frontmatter metadata.
  - `GET /api/search?q=...&project=...` queries SQLite FTS index and returns ranked search matches.

- **AC3 — CLI Command:**
  - `memo canvas [--port <p>] [--host <h>] [--project <id>]` boots the canvas server and prints the access URL.
  - Supports `--json` flag to output server metadata programmatically.

- **AC4 — Security & Isolation:**
  - Server is read-only for vault assets.
  - Refuses directory traversal attempts on file paths.
  - Respects redaction and security policies.
