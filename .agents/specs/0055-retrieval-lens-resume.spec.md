---
id: null
slug: retrieval-lens-resume
title: "Intent-aware search boost, bootstrap task lens, omittedIds receipt, and memo resume"
source: local
specDate: 2026-09-13
---

# Specification — Intent-aware search boost, bootstrap task lens, omittedIds receipt, and memo resume

## Description

Add a **lexical retrieval lens** and an **opt-in resume continuation** on the existing `search` and `bootstrap` MCP tools plus a CLI extra `memo resume`. This is one feature: operators and agents already have FTS ranking (`src/indexer.ts`, `src/ranking-explain.ts`) and a budgeted bootstrap brief (`src/bootstrap.ts` `scoreTrap` / `compileBootstrapBrief`) plus session handoff batons. They lack (1) deterministic query-intent reweighting of kinds, (2) task-shaped brief ordering from `bootstrap.query`, (3) a compact omitted-id receipt on `--explain`, and (4) a dump-free default with an explicit continuation that injects last session + at most three durable traps.

Architecture touchpoints (no 12th MCP tool, no embeddings, no consumer product files):

- **Search intent lens (`src/indexer.ts`, `src/ranking-explain.ts`):** Infer a closed intent (`decision` | `trap` | `log` | `none`) from query tokens. Apply a multiplicative `intentKindBoost` after existing FTS/path/severity/hits/occurrences/feedback factors. Neutral queries leave scores identical to today’s algorithm.
- **Bootstrap task lens (`src/bootstrap.ts` `scoreTrap` and brief assembly):** Classify `options.query` into `bugfix` | `feature` | `release` | `onboarding` | `refactor` | `docs` | `test` | `general`. Reorder and reweight **existing** brief fields (`traps`, `decisions`, `notices`) only. Do not add CodeGraph suggested files or dump `kind=log` into the ordinary brief.
- **Omitted evidence receipt:** When `explain: true`, `budgetReport` already lists candidates with `included` / `excluded_expired` / `truncated_budget_exhausted`. Add `budgetReport.omittedIds` (dropped trap/decision ids plus reason). Keep the existing pattern: `budgetReport` is **outside** `byteLength` / `maxBytes`.
- **Resume continuation:** CLI extra `memo resume [query]` equals `compileBootstrapBrief({ continuation: true, query })`. MCP `bootstrap` gains optional boolean `continuation` (alias `resume`), default `false`. When true, include latest useful `kind=session` summary, existing eligible handoff (same claim path as spec `0036`), and at most 3 durable traps (prefer high `hits` then high `severity` already in ranking), still under `config.bootstrap.maxBytes` / per-call `maxBytes`. When false, do not add a historical session dump.

Language: en-us. Markdown vault remains SoT; SQLite FTS stays disposable. PRODUCT.PRD non-goal: vector / embedding search.

## Acceptance Criteria

### Search intent lens

- AC1: Search infers intent from the query string using only the closed token tables in Notes (no embeddings, no ML, no extra MCP tool); matching is case-insensitive after splitting on non-alphanumeric characters, with hyphen/space variants listed as equivalent tokens.
- AC2: When inferred intent is `decision`, hits with `kind=decision` receive `intentKindBoost` of `1.5` and other kinds receive `1.0`; relative order among boosted decisions vs unboosted kinds must change versus the no-lens baseline when scores would otherwise tie or sit adjacent.
- AC3: When inferred intent is `trap`, hits with `kind=trap` receive `intentKindBoost` of `1.5` and other kinds receive `1.0`.
- AC4: When inferred intent is `log`, hits with `kind=log` receive `intentKindBoost` of `1.5` and other kinds receive `1.0`; the search must not spawn git subprocesses or inject repository commit history into hits.
- AC5: Mixed tokens resolve with fixed precedence `trap` then `log` then `decision` (first matching table wins); example: query `why did this fail` infers `trap`, not `decision`.
- AC6: Unknown or empty queries (no table token) infer intent `none`; `intentKindBoost` is `1.0` for every kind and the ordered hit ids for a frozen fixture match the pre-lens ranking byte-for-byte on `id` sequence.
- AC7: When `explain: true`, each hit’s `explain` object includes `intentLens` (`decision` | `trap` | `log` | `none`) and numeric `intentKindBoost`; existing explain fields (`ftsBm25`, `pathPatternBoost`, `severityMultiplier`, `hitsBoost`, `occurrencesBoost`, `feedbackMultiplier`, `finalScore`) remain present and `finalScore` reflects the applied boost.
- AC8: When `explain` is omitted or `false`, search payloads omit `intentLens` / `intentKindBoost` on hits and do not change ranking versus AC6 for a neutral query.

### Bootstrap task lens

- AC9: `compileBootstrapBrief` classifies `options.query` into exactly one of `bugfix`, `feature`, `release`, `onboarding`, `refactor`, `docs`, `test`, `general` using the closed task-lens table in Notes; missing or unmatched query yields `general`.
- AC10: Task lens only reshapes ranking and relative section emphasis inside existing brief fields `traps`, `decisions`, and `notices`; the brief JSON must not grow a `suggestedFiles`, `codeGraph`, or equivalent file-list field.
- AC11: `bugfix` raises trap scores relative to decisions for the same query tokens; `feature` raises decision scores relative to traps; `release` prefers recently updated / `shipped` decisions in `decisions` and may add a single notice that logs remain available via `search`, without inserting `kind=log` records into `traps` or `decisions`.
- AC12: Ordinary `bootstrap` with no `query` (and `continuation` false/omitted) produces the same trap id order as current `scoreTrap` severity + path + per-term title/tag/body scoring for a frozen fixture (no silent reorder of existing bootstrap tests).
- AC13: When `explain: true`, `budgetReport` includes `taskLens` equal to the classified lens; when `explain` is false, `taskLens` is omitted and is not counted in `byteLength`.

### Omitted evidence receipt

- AC14: When `bootstrap` `explain: true`, `budgetReport.omittedIds` is an array of `{ id, kind, reason }` for every trap or decision candidate whose selection status is `truncated_budget_exhausted`; `reason` is the string `truncated_budget_exhausted`.
- AC15: Candidates with status `included` do not appear in `omittedIds`; `excluded_expired` candidates are omitted from `omittedIds` (they are not budget drops).
- AC16: `calculatePayloadSize` / returned `byteLength` exclude `budgetReport` (including `omittedIds` and `taskLens`); a brief that is truncated still reports `truncated: true` against `budgetBytes` using the same 8192 / config / per-call precedence as spec `0007`.

### memo resume / continuation

- AC17: CLI `memo resume` is a CLI extra (not in `TOOL_NAMES`); `TOOL_NAMES.length` remains 11 and `TOOL_NAMES` does not include `resume`.
- AC18: `memo resume [query]` invokes the same `compileBootstrapBrief` path as `memo bootstrap` with `continuation: true` and optional `query` from remaining positionals; flags `--json`, `--explain`, `--max-bytes`, `--session-id`, `--path`, `--slug`, `--cwd` behave as on `bootstrap`.
- AC19: MCP `bootstrap` accepts optional boolean `continuation` (JSON Schema + Zod); omitted or `false` is the default; optional alias `resume` is accepted and, if both are set, `continuation` wins.
- AC20: Non-boolean `continuation` or `resume` (string, number, object) fails closed with existing `INVALID_ARGUMENTS` from Zod `safeParse` and does not compile a brief.
- AC21: When `continuation` is true, the brief includes at most one `sessionResume` object taken from the project’s latest `kind=session` record that has a non-empty `summary` or body; if none exists, `sessionResume` is omitted and bootstrap still succeeds.
- AC22: When `continuation` is true, eligible handoff injection stays the existing peek/claim path from spec `0036` (single-use; owner/branch isolation); resume does not invent a second baton store or re-deliver an already-claimed handoff.
- AC23: When `continuation` is true, `traps.length` is at most 3 after budget assembly; selection prefers higher `hits` then higher severity (`critical` > `high` > `medium` > `low`) then existing `scoreTrap` order; `decisions` remain budget-truncated independently.
- AC24: When `continuation` is false or omitted, the brief has no `sessionResume` field and does not inject a historical session dump; trap count is not forced to 3 (current ranking + budget only).
- AC25: Continuation content still respects `maxBytes`; overflow sets `truncated: true` and drops lower-priority resume pieces in order: extra traps first, then `sessionResume`, never dropping an already-claimed-in-this-call handoff that already fit.
- AC26: `continuation` true or false never creates, modifies, or deletes files in the consumer product git working tree (vault writes limited to existing handoff claim under the project vault).

### Tests, docs, stack

- AC27: Automated tests live in existing suites `src/indexer.test.ts` (intent lens + explain fields + neutral baseline), `src/bootstrap.test.ts` (task lens, omittedIds vs byteLength, continuation trap cap and sessionResume, default dump-free), and `src/cli.test.ts` (`memo resume` routing, invalid flag fail-closed); `npm run build` and `npm test` stay green.
- AC28: `README.md` and `ws-memo` document `memo resume` as a CLI extra and `bootstrap.continuation` as an opt-in flag; they state that ordinary bootstrap remains dump-free.

## Original Issue Context

User-approved pairing from a Memorix inspection (local, `id: null`): (1) intent-aware search boost + bootstrap task lens + omittedIds on bootstrap `--explain`; (2) `memo resume` last session + handoff + at most 3 durable anchors via CLI extra / bootstrap continuation flag. Orchestrator Step 0 of `ws-spec-to-pr`; slug `retrieval-lens-resume`.

### Prior Work Sweep

- Related shipped specs (record and continue; not duplicates): `.agents/specs/0007-bootstrap-brief.spec.md` (cwd bind, `scoreTrap`, 8 KB cap, `truncated`, zero product-tree writes, logs out of ordinary brief); `.agents/specs/0038-search-ranking-explain.spec.md` (`explain` on search/bootstrap, `computeSearchExplain` factors, `budgetReport` candidates + statuses, diagnostics outside `byteLength`); `.agents/specs/0036-session-handoff-baton.spec.md` (handoff peek/claim already injected in `compileBootstrapBrief`); `.agents/specs/0034-memory-hit-count.spec.md` (hits/occurrences ranking; session kind not hit-eligible).
- Local git (`develop` HEAD): `scoreTrap` introduced in slice-6 bootstrap (`cf38bf9`); explainability in `102ab73` (v0.24.0); handoff in `593205a` (v0.26.0, #46). Keyword scan of `src/bootstrap.ts` / `src/indexer.ts` / `src/cli.ts`: no `continuation`, no `intentLens`, no `omittedIds`, no `memo resume` command. Duplicate risk: low. No open PR for this slug.
- SCM: `providers.scm=github`; no exact-id tracker issue (source local). Stay-on-integration: implementation later on `develop`.

### Design Intent

Modification of ranking and bootstrap, not greenfield. `git log -S "scoreTrap"` / `computeSearchExplain` show intentional contracts: (1) budgeted lexical brief, not a vector store; (2) explain is opt-in and must not alter default ranking; (3) handoff is single-use and already delivered on ordinary bootstrap. This spec **extends** those contracts with closed keyword tables and an opt-in continuation; it must not reverse dump-free default bootstrap or add a 12th tool.

## Notes

- Reuse `scoreTrap`, `compileBootstrapBrief`, `computeSearchExplain`, `TOOL_DEFINITIONS.bootstrap.zodSchema`, CLI extras pattern (`memo rank`). Do not add `resume` to `TOOL_NAMES`.
- Session records used for `sessionResume` do not increment `hits` (kind `session` is not hit-eligible per `0034`).
- Intent and task classification are pure functions of the query string; they must not read `cwd` into path joins or `exec` git for ranking.

### Closed search-intent token table

| Intent | Tokens (match any; hyphen and space forms equivalent) |
|--------|------------------------------------------------------|
| `decision` | `why`, `rationale`, `tradeoff`, `trade-off`, `decision` |
| `trap` | `fail`, `failed`, `failure`, `gotcha`, `trap`, `do-not`, `donot`, `dont`, `don't`, `regression` |
| `log` | `changed`, `commit`, `commits`, `shipped`, `changelog` plus phrase `what changed` (tokens `what` **and** `changed` together) |
| `none` | no table token |

Phrase `what changed` sets `log` even if `changed` would otherwise be ignored in isolation? Spec: token `changed` alone is enough for `log`. `what` alone is `none`.

### Closed bootstrap task-lens token table

| Lens | Tokens (first match in this row order) |
|------|----------------------------------------|
| `bugfix` | `bug`, `bugfix`, `fix`, `hotfix`, `fail`, `failed`, `failure`, `error`, `regression` |
| `feature` | `feature`, `feat`, `add`, `implement`, `new` |
| `release` | `release`, `ship`, `shipped`, `version`, `changelog` |
| `onboarding` | `onboard`, `onboarding`, `getting-started`, `setup`, `install` |
| `refactor` | `refactor`, `cleanup`, `rename` |
| `docs` | `docs`, `doc`, `readme`, `documentation` |
| `test` | `test`, `tests`, `coverage`, `spec` (as a whole token, not spec-memo) |
| `general` | default |

If multiple tables match, earlier row in this table wins (`bugfix` before `feature`).

Gray-area companion: `.agents/specs/0055-retrieval-lens-resume.context.md` (canonical flag name `continuation` vs alias `resume`; `omittedIds` nested under `budgetReport`).

## Out of Scope

| Feature | Reason |
|---------|--------|
| 12th MCP tool named `resume` | Hard cap of 11 tools; CLI extra + bootstrap flag is the approved surface |
| Vector / embedding / CodeGraph suggested files | PRODUCT.PRD non-goal; FTS + markdown SoT |
| Dumping git log / commit history into search or bootstrap | Intent `log` boosts vault `kind=log` records only |
| Changing default bootstrap to include session dumps | Ordinary bootstrap must stay dump-free |
| Re-delivering claimed handoffs on resume | Spec `0036` single-use claim remains authoritative |
| Consumer product files, in-repo MEMORY, `{plansDir}` writes | Git-boundary thesis |
| Raising default `bootstrap.maxBytes` | Operators already override via config / per-call `maxBytes` |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Canonical MCP/options field | `continuation` boolean; `resume` alias | CLI verb is `resume`; option name matches “continuation flag”; see context.md | y |
| `omittedIds` location | Nested on `budgetReport`, not top-level brief | Keeps diagnostics outside `byteLength` (0038 AC6–AC8) | y |
| Intent boost magnitude | `1.5` multiplicative `intentKindBoost` | Large enough to reorder adjacent kinds; small enough not to swamp BM25 | y |
| Resume trap cap | 3 after ranking, then budget | User-approved “at most 3 durable anchors” | y |
| Implicit dimensions (auth, rate limit, TTL, external deps, concurrency of lens) | N/A because classification is in-process, stateless, and uses existing vault TTL / hybrid pull / handoff lock; no new network or auth surface | Avoid invented ACs | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | Lenses + omittedIds + continuation on existing search/bootstrap/CLI extra only | This spec Out of Scope table; `TOOL_NAMES.length === 11` test |
| Atomic criteria | AC1–AC28 are pass/fail with named fixtures | Authoring validate + later `src/indexer.test.ts`, `src/bootstrap.test.ts`, `src/cli.test.ts` |
| Failure modes | Invalid `continuation` type fails closed; missing session is omit-not-throw; budget still truncates | AC20, AC21, AC25, Negative scenarios |
| Observation telemetry | `explain` payloads expose `intentLens`, `intentKindBoost`, `taskLens`, `omittedIds`; CLI `--explain` stderr table may list omitted ids | AC7, AC13, AC14; `memo search --explain`, `memo bootstrap --explain` |
| Stack invariants (typescript-node) | No unchecked `any`; await all promises in `compileBootstrapBrief`; Zod-validate CLI/MCP flags; never `path.join` untrusted query into filesystem or `exec` git for intent | `npx tsc --noEmit`; schema in `src/tools.ts`; grep for `as any` in new code |
| Zero open blockers | Keyword tables closed; related specs identified; no exact open PR | Prior Work Sweep |

## Validation & Observation Notes

### Telemetry & Observable Signals

- `node --test dist/indexer.test.js` — intent lens, neutral baseline, explain fields.
- `node --test dist/bootstrap.test.js` — task lens, `budgetReport.omittedIds`, `byteLength` excludes report, `continuation` trap cap and dump-free default.
- `node --test dist/cli.test.js` — `memo resume` extra, Zod fail-closed on bad types.
- `memo search "why trade-off" --explain --json` — `intentLens=decision`, `intentKindBoost=1.5` on decision hits.
- `memo bootstrap --explain --json` — `omittedIds` present when truncated; `byteLength` ≤ `budgetBytes`.
- `memo resume --json` — `sessionResume` optional; `traps.length` ≤ 3; `truncated` still honored.
- `npx tsc --noEmit` and `npm test` — TypeScript Node invariants.

### Negative & Failing Test Scenarios

- Neutral query fixture: ranked `id` list **must match** the pre-lens snapshot; a silent reorder fails the suite.
- `continuation: false` (and omitted): asserting `sessionResume` is defined **must fail**; no session dump.
- Tight `maxBytes` with `continuation: true`: brief still truncates (`truncated: true`); must not exceed `budgetBytes` even with session + 3 traps.
- Invalid `continuation: "yes"` (string) on MCP `bootstrap` returns `INVALID_ARGUMENTS` and does not compile (typescript-node boundary validation / fail closed).
- Query `what changed` must **not** run `git log` (spy: zero `execFileSync`/`spawn` git calls on the search path).
