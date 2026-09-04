---
id: null
slug: project-wiki
title: "Per-project wiki page with status Wiki tab and on-demand regenerate"
source: local
specDate: 2026-09-04
---

# Specification — Per-project wiki page with status Wiki tab and on-demand regenerate

## Description

Operators need one narrative page per vault project that reads like a project README, built from collected vault memory (traps, decisions, specs, plans, prompts/sessions summaries, compiled INDEX/TRAPS/DECISIONS links), not from product git. Today compiled views (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`, `PROMPTS.md`, `SESSIONS.md`) are inventory tables. They do not synthesize a progressive, templated wiki.

This slice adds:

1. **Persisted wiki Markdown** at `projects/{projectId}/WIKI.md` inside the vault (Obsidian-compatible / Open Knowledge Format: UTF-8 Markdown, relative links, optional `[[wikilinks]]` matching `0015-viewer`). Never write the consumer product `README.md`.
2. **Shipped `template.md`** that defines heading order, required sections, and placeholders for structured links. Regeneration fills the template from collected records.
3. **On-demand regenerate**: collect eligible records for one `projectId`, fill the template, optionally run an AI polish pass when configured, then persist `WIKI.md`. Not automatic on every upsert.
4. **Status monitor Wiki tab**: operator selects a project, views the wiki (Markdown on open is OK; render with the existing zero-dep HTML helper plus collapsible `h2` sections). **Regenerate** button posts to a dedicated write API. Deep link `?tab=wiki&project={id}`.
5. **CLI** `memo wiki` (get) and `memo wiki --regenerate` (write). No 12th MCP tool; the 11-tool surface stays unchanged. Agents use CLI or status HTTP.

Architecture touchpoints:

- **Template (`src/wiki/template.md`)**: packaged with the CLI; sections at least Overview, Architecture & decisions, Active traps, Specs & plans, Sessions, Structured links. Placeholders are named (e.g. `{{projectTitle}}`, `{{decisionLinks}}`). Custom vault override path may be documented later; v1 uses the shipped template only.
- **Collector (`src/wiki.ts`)**: `collectWikiSources(projectId, vaultRoot)` lists active records by kind, compiled-view relative paths, and inventory counts. Does not increment memory `hits`. Skips `*.conflict.*` sidecars. Does not call `ensureVaultStructure` on get.
- **Renderer**: `renderWikiMarkdown(sources, template)` always produces a deterministic page. `polishWikiMarkdown(markdown)` is optional AI (config `wiki.aiEnabled` or env documented in README). AI failure must persist the deterministic page and return a non-fatal `aiError` (fail-open).
- **Persist**: write only `WIKI.md` under the bound project directory. HTML comment or YAML-less header line records `lastGenerated` ISO. Vault-git / hybrid dirty flags follow existing mutation helpers (same as other vault file writes), fail-open.
- **Status (`src/status.ts`)**: Wiki tab, `GET /api/wiki?project=`, `GET /api/wiki/section?project=&id=`, `POST /api/wiki/regenerate` with JSON `{ projectId }`. Auth, sanitize, loopback rules match existing status writes. `vault=all` / missing `projectId` returns `400`.
- **CLI (`src/cli.ts`)**: `memo wiki [--project <id>] [--json]` prints or writes stdout Markdown; `--regenerate` runs collect+render+persist.
- **Tests (`src/wiki.test.ts`, extend `src/status.test.ts`, `src/cli.test.ts`)**: template fill, missing wiki empty state, 400 without projectId, regenerate persist, AI fail-open, HTML tab/deep-link, path sanitization.
- **Docs**: README Command & Tool Reference, FEATURES, PRODUCT.PRD, ws-memo SURFACE (CLI extra, not MCP).

Design choices: [`0046-project-wiki.context.md`](0046-project-wiki.context.md).

## Acceptance Criteria

- AC1: Regenerating a wiki for a known `projectId` writes UTF-8 Markdown to `projects/{projectId}/WIKI.md` and does not create or modify any file under the consumer product git working tree.
- AC2: A shipped `src/wiki/template.md` exists in the package and defines ordered sections Overview, Architecture & decisions, Active traps, Specs & plans, Sessions, and Structured links.
- AC3: Deterministic render replaces every `{{placeholder}}` in the shipped template with collected data or an explicit empty-state sentence for that section; no raw `{{` placeholders remain in persisted `WIKI.md`.
- AC4: Structured links in `WIKI.md` use repo-relative Markdown links into `./traps/`, `./decisions/`, `./specs/`, `./plans/`, `./INDEX.md`, `./TRAPS.md`, and `./DECISIONS.md` in the same style as compiled views (viewer-compatible).
- AC5: `GET /api/wiki?project={projectId}` returns `200` JSON `{ projectId, markdown, lastGenerated, exists }` with `markdown` sanitized through `sanitizeToolOutput`; `exists` is false and `markdown` is empty when `WIKI.md` is missing.
- AC6: `GET /api/wiki` without `project` (or with `project` equal to `all`) returns `400` JSON with an error that requires a specific `projectId`.
- AC7: `GET /api/wiki/section?project={projectId}&id={sectionId}` returns `200` JSON `{ id, title, markdown }` for a heading whose slug matches `sectionId`; unknown `id` returns `404` JSON `{ error: "Not found" }`.
- AC8: `POST /api/wiki/regenerate` with JSON `{ "projectId": "<id>" }` collects records for that project, renders from `template.md`, persists `WIKI.md`, and returns `200` JSON `{ ok: true, projectId, lastGenerated, aiPolished: boolean }` without leaking absolute vault paths.
- AC9: `POST /api/wiki/regenerate` without `projectId`, with empty `projectId`, or with `projectId` `all` returns `400` and does not write any file.
- AC10: `POST /api/wiki/regenerate` for an unknown project id returns `404` JSON `{ error: "Not found" }` and does not create a new project directory.
- AC11: When wiki AI polish is disabled or unset, regenerate still persists a complete deterministic `WIKI.md` and `aiPolished` is `false`.
- AC12: When wiki AI polish is enabled and the polish function throws or times out, regenerate still persists the deterministic page, `ok` remains `true`, `aiPolished` is `false`, and `aiError` is a short sanitized string.
- AC13: Status HTML includes a Wiki tab (`data-tab="tab-wiki"`, `id="tab-wiki"`) with a project selector populated from `/api/vaults`, a markdown view region, and a Regenerate button.
- AC14: Opening the Wiki tab with a selected project fetches `GET /api/wiki?project=` and renders the markdown with `renderPromptMarkdownHtml` (or the same zero-dep helper); missing wiki shows an empty-state message and still shows Regenerate.
- AC15: Wiki tab `h2` sections are collapsed by default (`details`/`summary` or equivalent); expanding a section reveals that section body (client collapse of already-fetched markdown satisfies this; optional `GET /api/wiki/section` may be used).
- AC16: Clicking Regenerate with a selected project calls `POST /api/wiki/regenerate` and refreshes the view from the response or a follow-up GET; the button is disabled while the request is in flight.
- AC17: URL query `?tab=wiki` activates the Wiki tab on load; `?tab=wiki&project={id}` also selects that project when it exists in `/api/vaults`.
- AC18: Wiki tab project selector uses the same vault list parse rules as other tabs (`Array.isArray` first; do not assume `{ vaults: [] }` wrapping).
- AC19: CLI `memo wiki --project <id>` prints the current `WIKI.md` body to stdout (empty stdout plus a stderr notice when missing) and exits 0 when the project exists.
- AC20: CLI `memo wiki --project <id> --regenerate` performs the same collect-render-persist path as AC8 and exits 0 on success.
- AC21: CLI `memo wiki` without a resolvable project (no `--project` and no cwd-bound identity) exits non-zero with a message requiring `--project` or a bound cwd; it does not regenerate all projects.
- AC22: Regenerating does not increment record `hits` or `occurrences`.
- AC23: Regenerating skips `*.conflict.*` markdown sidecars when collecting sources.
- AC24: GET wiki routes do not call `ensureVaultStructure` and do not create `config.json`, `projects/`, or telemetry files.
- AC25: When a status auth token is configured, unauthorized GET/POST wiki routes return `401` JSON, matching other `/api/*` routes.
- AC26: Regenerated `WIKI.md` includes an auto-generated marker (HTML comment or equivalent) so humans can tell it is machine-produced, plus a `lastGenerated` ISO timestamp.
- AC27: `generateStatusHtml` tests assert Wiki tab markers and `tab=wiki` deep-link handling analogous to the Backups tab tests.
- AC28: A unit test covering AI polish throw still writes `WIKI.md` and reports `aiPolished: false`.

## Original Issue Context

Free-text orch request: consolidate a wiki page per project with progressive disclosure on demand; Wiki tab to select a project and view a markdown file (Open Knowledge / Obsidian-compatible format OK on open); Regenerate button to collect memory entries and format a page from `template.md` with structured links and progressive disclosure; similar to a README but based on collected vault data; may use AI to think, render, update, and persist.

### Prior Work Sweep

- No existing `WIKI.md` compiler or status Wiki tab.
- Related: compiled views in `src/compiler.ts` (`INDEX.md`, `TRAPS.md`, `DECISIONS.md`, `PROMPTS.md`, `SESSIONS.md`); status tabs in `src/status.ts` (Activity, Memory, Prompts, Invoicing, Derived Rules, Backups); `renderPromptMarkdownHtml`; viewer wikilinks (`0015-viewer`, commit `8eedf84`).
- Status originally read-only (0023 AC7); later slices added backup/reset/derive-rules writes. Wiki regenerate is the same class of explicit operator write, scoped to one project.
- Product `index.PRD` non-goal: shipping product README through the vault. Wiki stays vault-side.
- No open GitHub PR titled for a project wiki (keyword search empty at authoring time).

### Design Intent

Greenfield additive slice. Skip `git log -L` restore analysis: there is no prior wiki generator to restore.

## Notes

- Traps in force: `status-derive-rules-require-project`, `status-loadvaults-array-payload`, `status-rest-sanitize-vault-paths`, `memo-status-must-not-call-ensurevaultstructure`.
- Do not add a 12th MCP tool. CLI extras already include `doctor`, `rank`, `status`.
- Language: en-us for template headings, CLI help, and UI copy.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Writing consumer product `README.md` | Product git is not a memory store; PRD non-goal |
| 12th MCP tool | Keep the 11-tool contract; CLI + status HTTP suffice |
| Auto-regenerate on every upsert | Operator asked for on-demand; avoid write storms |
| Combined wiki for All vaults | Project binding required; same as derive-rules |
| Canvas graph wiki node | Status tab is the human surface |
| Custom per-vault template override in v1 | Shipped `template.md` only |
| Live CRDT collaborative editing | Previously rejected inbox idea |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Persist path | `projects/{projectId}/WIKI.md` | Sibling of compiled views; Obsidian-openable | y |
| AI | Optional polish after deterministic fill; fail-open | User asked for AI without blocking offline vaults | y |
| Progressive disclosure | Collapsed `h2` in the Wiki tab; full file still on disk | On-demand UI without splitting the source of truth | y |
| MCP | No new tool | Surface freeze; CLI `memo wiki` | y |
| Implicit dimensions | N/A because auth, sanitization, missing-project, AI timeout, and all-vaults refusal are explicit ACs | Covered in AC6–AC12, AC21, AC24–AC25 | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Vault `WIKI.md` + status Wiki tab + CLI; no product README; no 12th MCP tool | Spec Out of Scope + this table |
| Atomic criteria | AC1–AC28 each have a pass/fail check | `validate_spec.cjs --mode=authoring` |
| Failure modes | Missing wiki, missing projectId, unknown project, AI throw, unauthorized | Negative scenarios below |
| Observation telemetry | Named test files and CLI/HTTP status codes | Validation Notes |
| Open blockers | None | Lookup complete; defaults recorded |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/wiki.test.js` (or `src/wiki.test.ts` via `npm test`)
- `node --test dist/status.test.js` Wiki tab / `/api/wiki` cases
- `memo wiki --project <id> --json` stdout `exists` / `lastGenerated`
- Status `POST /api/wiki/regenerate` JSON `ok`, `aiPolished`, `aiError`
- Activity bus: regenerate captured as `kind: "write"` with `projectId` (if status write capture is already the pattern for backup POSTs; if not, document skip in implementation notes without inventing a new bus type)

### Negative & Failing Test Scenarios

- GET `/api/wiki` with no project returns 400 (red until handler exists).
- POST regenerate with `projectId: "all"` returns 400 and leaves the filesystem unchanged.
- POST regenerate when polish throws still writes deterministic `WIKI.md` (`aiPolished: false`).
- GET wiki on a pristine empty vaultRoot does not create `config.json` (read-only inspector invariant).
