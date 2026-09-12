# Bootstrap Brief and Spec Drift

## Feature Overview

`bootstrap` is the session-start tool. It binds `cwd` to a project identity, gathers active traps and decisions plus the active feature slice, and compiles a UTF-8 token-budgeted brief capped at 8,192 bytes by default. The brief is designed to fit an agent context window: relevant, ranked memory in; logs and noise out. It never writes to the consumer product repository.

The same call performs spec-drift detection. Active spec records that declare `linkedPaths` and `verifiedAtSha` are compared against the current git state; diverged paths produce a `drift` alert and a notice in the brief so an agent knows the spec of record may be stale.

`bootstrap` also delivers an eligible cross-session handoff baton (if one fits the budget) and records retrieval hits for the eligible records actually included in the returned payload. Optional `explain: true` returns a `budgetReport` describing how the byte budget was allocated and why candidates were included or truncated.

## Business Rules & Logic

Budget precedence: per-call `maxBytes` (> 0) → `config.bootstrap.maxBytes` (> 0) → `8192`. The brief is serialized as JSON and measured with `Buffer.byteLength(JSON.stringify(brief), 'utf8')`.

Ranking:

- Traps: only `status: active` and non-expired records are eligible. `scoreTrap` starts from a severity weight (`critical 400`, `high 300`, `medium 200`, `low 100`), adds `1000` for a `pathPatterns` match against the focus path, and adds `80` per query term found in the title, `50` in tags, `20` in the body. Ties break on `updated` descending.
- Decisions: only `status: active` or `shipped` and non-expired records; sorted by `updated` descending.
- Active slice: when `slug` is provided, the brief looks up `spec`, `plan`, and `state` records by kind+slug and includes whichever exist.
- Logs are never included in the brief.

Expiration uses kind defaults from `config.ttl` (`scratch` 7 days, `review` 14 days) via `isRecordExpiredAt`/`defaultTtlDaysForKind`; `state` and `plan` follow their own frontmatter `ttl`/`expires_at` when present.

Spec drift (`checkSpecDrift`): for every active `spec` record with a non-empty `linkedPaths` array and a `verifiedAtSha`, each linked path is resolved against the product root:

- Missing path → counted as modified.
- Git repo: first `git status --porcelain -- <path>`; a dirty path is drift. Otherwise the blob at `verifiedAtSha:path` (`git show`) is byte-compared to the current file; any difference (or a missing blob) is drift.
- Non-git root or a git failure → fails gracefully (treated as not-drifted; no crash).
- Any modified paths yield `{ specSlug, modifiedPaths }`; each is appended to `notices` and collected into the brief `drift` array. When every linked file matches, no alert is emitted.

Brief shape (`BootstrapBrief`): `projectId`, `gitRemote`, `lastSeenRoot`, optional `handoff`/`handoffMarkdown`/`sessionObjective`, optional `activeSlice`, `traps[]`, `decisions[]`, `totalTrapsCount`, `totalDecisionsCount`, `byteLength`, `budgetBytes`, `truncated`, optional `drift[]`, `notices[]`, and optional `budgetReport`.

Truncation is fail-closed and ordered from lowest to highest value:

1. Drop traps from the tail of the rank order.
2. Drop decisions from the tail.
3. Trim `activeSlice` in the order `state` → `plan` → `spec`.
4. Drop `drift` entries.
5. Shorten then clear `notices`.
6. Drop `lastSeenRoot` and `gitRemote`.
7. Fall back to a minimal brief holding only `projectId`, counts, and an empty `traps`/`decisions`; if even that exceeds the cap, notices are cleared.

`truncated: true` is set whenever the initial payload exceeds the budget, and the final notice reports how many traps and decisions were dropped. An immutable reserve is subtracted before trimming so an eligible handoff/objective is not squeezed out, with a floor of 512 bytes for the mutable portion. If the handoff still does not fit, it is omitted without claiming the baton.

Hit accounting: after compiling, `collectBootstrapHitIds` gathers ids of hit-eligible records present in `traps`, `decisions`, `spec`, and `plan` (not `state`), and `recordMemoryHits` increments them with source `bootstrap`, honoring `sessionId` de-dupe. Records dropped by the budget receive no hit. As in search, this is fail-open and does not change `occurrences`.

Hybrid mode: when `config.mode === 'hybrid'`, bootstrap performs a best-effort `pullHybridProject` before compiling; a pull failure becomes a notice rather than an error. A handoff is claimed only after the final payload fits the budget, under the vault lock.

`explain: true` adds `budgetReport { budgetBytes, consumedBytes, remainingBytes, includedCount, candidates[] }`, where each candidate carries `id`, `kind`, `title`, `score`, `byteWeight` (UTF-8 JSON size of the record), and `status` (`included`, `excluded_expired`, or `truncated_budget_exhausted`). Trap candidate scores use `scoreTrap`; decision candidate scores use `Date.parse(updated)/1000` (seconds) plus a small order bonus of `(total - index) * 0.001`. The report covers traps and decisions only and is diagnostic metadata outside the byte-counted brief fields.

Zero product-tree writes: bootstrap may scaffold the project vault under `$SPEC_MEMO_ROOT` and claim a handoff, but it never creates or modifies files in the consumer repository.

## Technical Architecture

Modules: `src/bootstrap.ts` (`compileBootstrapBrief`, `scoreTrap`, `checkSpecDrift`, `calculatePayloadSize`, `buildBudgetReport`, `formatBootstrapBudgetTable`), `src/handoff.ts` (`peekEligibleHandoff`, `claimHandoff`, `getSessionObjective`, `renderHandoffMarkdown`), `src/expiration.ts` (TTL defaults and `isRecordExpiredAt`), `src/ranking-explain.ts` (`roundExplain`), and `src/compiler.ts` (`scanProjectRecords`). Types are in `src/types.ts` (`BootstrapOptions`, `BootstrapBrief`, `BootstrapBudgetReport`, `BudgetCandidateReport`, `SearchScoreExplain`).

MCP `bootstrap` contract (`src/tools.ts`): `cwd`, `query`, `slug`, `path`, `maxBytes` (positive integer), `projectId`, `sessionId`, `explain`, plus `vaultRoot` accepted by the Zod schema. The handler calls `compileBootstrapBrief`, then `collectBootstrapHitIds` → `recordMemoryHits({ source: 'bootstrap', sessionId, projectId, cwd, vaultRoot })`, and returns the brief. Errors surface as `BOOTSTRAP_FAILED`.

CLI: `memo bootstrap [--max-bytes N] [--query ...] [--path ...] [--slug ...] [--session-id ...] [--explain] [--json]`. Human output prints header bytes (`byteLength / budgetBytes`), project/remote, handoff/objective, active slice, traps, decisions, and truncation notices. With `--explain`, `formatBootstrapBudgetTable` is printed to **stderr** while the brief summary stays on stdout, so the brief can be piped into an agent prompt stream. `--json` emits the raw brief including `budgetReport`.

Persistence and side effects: identity resolution plus `ensureProjectVault` scaffolding under the vault root; optional handoff claim writing under the project vault; optional hybrid pull; hit-counter writes via `recordMemoryHits`; no consumer-tree writes.

Provenance: `0007-bootstrap-brief.spec.md` (token-budgeted brief, ranking, truncation, zero product-tree writes) and `0013-spec-drift.spec.md` (SHA/path drift detection on bootstrap), with explainability added by `0038-search-ranking-explain.spec.md` and hit accounting by `0034-memory-hit-count.spec.md`.
