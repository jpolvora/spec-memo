---
stackFingerprint: 7ca33af41a5561d28b3c8aa224ce93d4d8665401ace61649f50ce0f760a3fb47
stackFingerprintVersion: 1
---

# Stack Definition

Human-readable companion to `config.json`. Agents read `config.json` for machine-readable values; this doc explains structure and conventions.

> **Source of truth:** `.ws/config.json` — project identity, stack, verification, invariants.

## Project Stack (from config.json)

- **Backend:** Node 22 (TypeScript) — MCP stdio + CLI; layers mcp-cli / store / index / policy under `src/`
- **Frontend:** none (canvas/status are static HTML served from Node)
- **Database:** SQLite via better-sqlite3 (FTS5 disposable index)
- **Domain:** Curated agent working memory outside product git
- **Orchestration:** `npm run build` / `npm test` / `npm start`

## Code Paths

| Layer | Path | Role |
|-------|------|------|
| **mcp-cli** | `src/` | Tool handlers, CLI, bootstrap budget |
| **store** | `src/` | Vault layout, frontmatter, compiled indexes |
| **index** | `src/` | SQLite FTS rebuild and query |
| **policy** | `src/` | Schema, TTL, refuse-in-repo-write, redaction |
| **Tests** | `src/*.test.ts` | node:test suites |

## Validation Commands

| Layer | Command | Notes |
|-------|---------|-------|
| **Build** | `npm run build` | Typecheck + emit `dist/` |
| **Test** | `npm test` | pretest build + full suite |

## Project Invariants

- Product git is not a memory store — vault lives under `$SPEC_MEMO_ROOT` / `~/.spec-memo/`
- Never write `.agents/plans/`, `MEMORY.md`, or session state into product git
- Language: en-us for product surfaces
