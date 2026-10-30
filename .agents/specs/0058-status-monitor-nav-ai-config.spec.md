---
id: null
slug: status-monitor-nav-ai-config
title: "Status monitor left nav, home dashboard, error logs viewer, and AI config save"
source: local
specDate: 2026-09-13
---

# Specification — Status monitor left nav, home dashboard, error logs viewer, and AI config save

## Description

The `:3124` status monitor (`src/status.ts`) uses a **top tab bar** (`nav.nav-tabs`, `button.tab-btn` + `data-tab`) for eight pages: Activity & Status, Memory, Prompts, Invoicing, Derived Rules, Backups, Wiki, Vaults. Deep links use query params such as `?tab=vaults`. Adding AI Ops (spec `0057`) and operator diagnostics will overflow that bar.

This spec **replaces the top tab strip** with a **left collapsible sidebar**: categories with nested page links, same page bodies (`id="tab-*"`), same `?tab=` / `?project=` URL contract. Default landing is a **Home dashboard** (`tab-home`) with stat cards drawn from the other pages (counts and health, not a second live activity stream). It also adds two pages that `0057` deferred: **Error logs** and **AI assistant configuration** that **persists** `config.json` `ai` without storing `CURSOR_API_KEY`.

Touchpoints: `src/status.ts` (HTML/CSS/JS + routes), vault config merge/write under lock (`src/vault.ts`), `src/error-logger.ts` for parse/list. No 12th MCP tool. Canvas `:3125` unchanged.

Suggested sidebar IA (fixed order):

1. **Overview** — Home (`tab-home`, default); Activity & Status (`tab-activity`)
2. **Memory** — Records (`tab-memory`); Wiki (`tab-wiki`)
3. **Sessions** — Prompts & Stories (`tab-prompts`); Activity & Invoicing (`tab-invoicing`); Derived Rules (`tab-rules`)
4. **Vault** — Vaults (`tab-vaults`); Backups (`tab-backups`)
5. **AI** — Assistant (`tab-ai-config`, this spec); AI Ops (`tab-ai-ops`, body from `0057` when present, otherwise empty state)
6. **Diagnostics** — Error logs (`tab-error-logs`, this spec)

## Acceptance Criteria

### Left navigation shell

- AC1: Status HTML has no `nav.nav-tabs` top strip; primary navigation is a left `<nav>` with `id="status-sidebar"` containing collapsible category groups and nested page buttons.
- AC2: Each existing `id="tab-*"` main panel remains; switching pages still toggles `.tab-content.active` and does not remount via a full document reload.
- AC3: Category groups use the six labels and child order listed in Description; Overview is first (Home then Activity) and Diagnostics is last.
- AC4: A category header click expands or collapses only its children; expanded state persists in `sessionStorage` under key `statusNavOpen`.
- AC5: Sidebar has a collapse control that narrows it to icons or a hamburger; collapsed flag persists in `sessionStorage` key `statusNavCollapsed`.
- AC6: Viewport width `max-width: 900px` defaults the sidebar collapsed; opening it overlays content and does not shrink the activity grid below usability.
- AC7: `?tab=` values `activity`, `memory`, `prompts`, `invoicing`, `rules`, `backups`, `wiki`, `vaults` still open the same panels as today; omitted or unknown `tab` opens Home (`tab-home`).
- AC8: New query values `home`, `error-logs`, and `ai-config` open `tab-home`, `tab-error-logs`, and `tab-ai-config`; `ai-ops` opens `tab-ai-ops` when that panel exists.
- AC9: Selecting a page updates the URL `tab` param via `history.replaceState` without dropping `project`.
- AC10: In-page scripts that click `.tab-btn[data-tab="tab-rules"]` still activate Derived Rules (keep `data-tab` on sidebar leaf buttons).
- AC11: Zero CDN runtime deps remain; CSS for the sidebar lives in the existing inline stylesheet.

### Error logs viewer

- AC12: `GET /api/error-logs` on `:3124` returns `{ items, total, truncated }` after the same auth as `/api/status`; unauthenticated yields 401 and no log bodies.
- AC13: Query `limit` default 50 max 200, `offset` default 0, optional `level` (`ERROR`|`WARN`|`FATAL`), optional `subsystem` string; invalid query yields 400.
- AC14: Each `items[]` entry includes `id`, `timestamp`, `level`, `subsystem`, `error` (truncated 300 chars), optional `endpoint`, `tool`, `projectId`; it does not include raw stack unless `GET /api/error-logs/{id}`.
- AC15: `GET /api/error-logs/{id}` returns one parsed block including truncated stack and context; unknown id yields 404.
- AC16: Parser splits vault `error.logs` on the existing `====` block delimiters from `formatErrorReport`; missing file yields `items: []`, `total: 0`, HTTP 200.
- AC17: List and detail pass `sanitizeToolOutput`; secrets and absolute vault paths do not appear in JSON.
- AC18: Responses cap total scanned bytes at 2 MiB from the **end** of the file (newest blocks first); `truncated: true` when the file is larger.
- AC19: `tab-error-logs` shows filters (level, subsystem) and a table; row click loads detail into a pane using `textContent` or escaped `<pre>`, not `innerHTML` of raw log text.
- AC20: Fetch 401/500 shows an inline error on that page only; handler throws still call `logErrorReport` with `subsystem: 'status-server'` and endpoint `/api/error-logs`.

### AI assistant config UI and save

- AC21: `GET /api/config/ai` returns `{ enabled, provider, model, apiKeyEnv, hasApiKey, available }` with no secret values; auth matches `/api/status`.
- AC22: When `ai.enabled` is false, GET `provider` is the string `noop` for the UI even if disk `ai.provider` is `cursor-sdk`.
- AC23: `PUT /api/config/ai` JSON body allows only `enabled` (boolean), `provider` (`noop` | `cursor-sdk`), `model` (non-empty string max 64 chars); extra keys ignored; `apiKey` or `token` fields yield 400 and do not write.
- AC24: Body `provider: "noop"` persists `ai.enabled: false` and does not require a key; `provider: "cursor-sdk"` persists `enabled: true`, `provider: "cursor-sdk"`, and `model` (default `composer-2.5` if omitted).
- AC25: Persist merges into existing `config.json` under `withVaultLock`, preserves `ttl`, `vaultGit`, `embeddings`, `bootstrap`, `wiki`, `ports`; write uses the same atomic file helper as other vault JSON when one exists, else write+fsync equivalent.
- AC26: `provider` values `opencode`, `freellmapi`, or any other string yield HTTP 400 with message that only `noop` and `cursor-sdk` are implemented.
- AC27: After a successful PUT, later `readVaultConfig` / `GET /api/config/ai` reflect the new values without restarting the process (in-memory config refresh).
- AC28: `tab-ai-config` shows a select for provider (`noop` labeled Disabled / Noop; `cursor-sdk` enabled; `opencode` and `freellmapi` present but `disabled` with hint Coming soon), a model text input defaulting to `composer-2.5`, a Save button, and a note that the API key is env `apiKeyEnv` only.
- AC29: Save calls `PUT /api/config/ai` and shows success or inline error; 401 does not leak config.
- AC30: `hasApiKey` is boolean only; UI never displays the key; GET/PUT JSON never includes `CURSOR_API_KEY` material.
- AC31: `TOOL_NAMES.length` remains 11.

### Home dashboard

- AC32: Status HTML includes `id="tab-home"` as the default `.tab-content.active` on first load when `tab` is omitted.
- AC33: `GET /api/dashboard` (auth as `/api/status`) returns the count fields listed in Notes; `aiOpsCount` is `0` when the 0057 journal is absent.
- AC34: When `?project=` is set, memory, prompts, and wiki counts are scoped to that project; `projectsCount`, `backupCount`, and `errorLogCount` stay global and the UI labels them global.
- AC35: `tab-home` renders one clickable card per Notes dashboard map; click activates the target `data-tab` and updates `?tab=` like the sidebar.
- AC36: Unauthenticated `GET /api/dashboard` yields 401; a failed dashboard fetch shows an inline error on Home and does not break other pages.
- AC37: Cards use `textContent` for numbers; missing optional counts render `0` or an em dash, never uncaught exceptions.
- AC38: `/api/dashboard` reuses existing list/count helpers (no second SQLite schema); payloads pass `sanitizeToolOutput`.

### Tests and docs

- AC39: Tests cover `status-sidebar`, `tab-home`, no `nav-tabs`, `?tab=home` mapping, error-logs 401/400/404/empty file, dashboard 401 and fixture counts, AI GET noop, PUT merge, PUT reject `apiKey` and unknown provider, and path sanitize.
- AC40: `npm run build` and `npm test` stay green.
- AC41: `README.md` documents the sidebar IA, Home dashboard, error-logs routes, and AI config save; `ws-memo` notes that keys stay in the environment.

## Original Issue Context

Standalone `/ws-spec-write`: refactor `:3124` from top tabs to a left collapsible menu; add error logs viewer; add AI assistant config saved to config; follow-up: Home dashboard showing stats from other pages.

### Prior Work Sweep

- `src/status.ts` top `nav.nav-tabs` eight buttons; `?tab=vaults` documented in `0049`.
- `0056-vault-ai-assistance`: `config.ai` defaults; key via `apiKeyEnv`; UI save deferred in companion.
- `0057-status-ai-ops-logs`: AI Ops tab + journal; **out of scope** error.logs UI and enabling AI from UI. This spec takes those deferred items. Nav must host `tab-ai-ops` without rewriting 0057 REST.
- `src/error-logger.ts` block format `====` / `[timestamp] [level] [subsystem]`; vault `error.logs`.
- `src/vault.ts` `DEFAULT_VAULT_CONFIG.ai` already present after 0056. Git: no `/api/error-logs` or `/api/config/ai` in `status.ts`. Duplicate risk: low vs 0057 (different store). `providers.scm=github`; no tracker id.

### Design Intent

Original top tabs were intentional for a small page count (`0023`). Growth (vaults, backups, wiki, AI) makes the strip a poor IA. This is a product navigation change, not a bug restore. Status was specified read-only in `0023`; later slices already mutate vaults/backups. AI config save is a **scoped write** of `config.ai` only, same auth class as other status POST routes.

## Notes

**Dashboard map (card label → JSON field → `data-tab`):**

| Card | Field | Opens |
|------|-------|-------|
| MCP / uptime | `mcpAvailable`, `uptimeMs` | `tab-activity` |
| Live events | `eventsBuffered`, `activeClientsCount` | `tab-activity` |
| Vaults | `projectsCount` | `tab-vaults` |
| Memory records | `memoryRecords` | `tab-memory` |
| Prompts | `promptRecords` | `tab-prompts` |
| Backups | `backupCount` | `tab-backups` |
| Wiki | `wikiPresent` | `tab-wiki` |
| AI | `aiEnabled`, `aiOpsCount` | `tab-ai-config` if disabled else `tab-ai-ops` |
| Error logs | `errorLogCount` | `tab-error-logs` |

`GET /api/dashboard` fields: `projectsCount`, `eventsBuffered`, `activeClientsCount`, `uptimeMs`, `mcpAvailable`, `memoryRecords`, `promptRecords`, `backupCount`, `errorLogCount`, `aiEnabled`, `wikiPresent`, `aiOpsCount`.

**AI Ops panel:** if 0057 HTML is absent, sidebar leaf still exists and shows copy that the ops journal ships with 0057.

**Config write:** merge `ai` keys only; do not stringify-drop unknown future `ai` fields (`opsLogEnabled` from 0057).

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool | Status REST only |
| Implementing opencode / freellmapi adapters | Select shows them disabled; 400 if forced |
| Writing `CURSOR_API_KEY` from the UI | Env only (0056) |
| Rewriting 0057 journal schema or `/api/ai-ops` | This spec only places the nav leaf |
| Canvas `:3125` nav | Status companion only |
| Editing other `config.json` sections (ports, ttl, vaultGit) | AI object only |
| Charts, timeseries, or invoicing dollar totals on Home | Cards are counts/health only; invoicing stays on its page |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Nav IA | Six categories; Home is default landing | Operator asked for a stats dashboard plus categorized nav | y |
| Error log window | Last 2 MiB, newest first | Avoid loading multi-MB `error.logs` into RAM/UI | n (recommended) |
| Config write | PUT merge `ai` only under vault lock | Matches 0056 SoT | y |
| Implicit dims | N/A because bounds (limit, 2 MiB, model max 64), failure (401/400/404), auth, concurrency (lock), observability (status-server logs), external file missing (empty list) are ACs; rate limits not specified | Collapse remainder | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Sidebar + Home dashboard + error-logs REST/UI + AI config GET/PUT; no new MCP tool; no extra providers | ACs vs diff |
| Atomic criteria | Pass/fail per AC in `src/status.test.ts` | AC39 |
| Failure modes | 401, 400 unknown provider, 400 apiKey, missing error.logs | Negative scenarios |
| Stack invariants | No unchecked `any`; Zod on query/body; path of `error.logs` stays under vaultRoot; no floating fetch without `.catch` | `typescript-node`; `npm run build` |
| Secrets | No key in GET/PUT/UI | AC23, AC30 |
| Open blockers | N/A because 0056 config shape exists; 0057 AI Ops body may land in either order | Documented |

## Validation & Observation Notes

### Telemetry & Observable Signals

- HTML source contains `id="status-sidebar"`, `id="tab-home"`, `id="tab-error-logs"`, and `id="tab-ai-config"`
- `GET /api/dashboard` on a fixture vault returns numeric `projectsCount` matching `/api/status`
- `GET /api/error-logs` on a fixture vault with one formatted block returns `total: 1`
- After PUT `{ "provider": "cursor-sdk", "model": "composer-2.5" }`, `config.json` `ai.enabled` is true
- `npm test` and `npm run build`

### Negative & Failing Test Scenarios

- Unauthenticated GET `/api/error-logs`, `/api/config/ai`, and `/api/dashboard` return 401
- PUT `{ "provider": "opencode" }` returns 400
- PUT `{ "apiKey": "secret" }` returns 400 and `config.json` unchanged
- `innerHTML` of raw error.logs text in the detail pane fails the test
- Protocol-relative or open-redirect not introduced by `?tab=` (tab values are an allowlist)
- Missing `error.logs` file: 200 empty list, no throw
- Sync-over-async: PUT handler awaits lock+write; no floating write promise
