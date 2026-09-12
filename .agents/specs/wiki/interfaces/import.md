# Legacy Workflow Tree Import

## Feature Overview

`memo import` migrates a legacy workflow tree (docs produced by earlier `ws-*` harnesses) from a consumer repository into the external vault so product git stays clean. The engine is `importWorkflowTree` in `src/importer.ts`; the CLI is `memo import [productRoot] [--from <path>] [--cwd <path>] [--vaultRoot <path>] [--json]`.

The importer maps legacy artifacts into standard vault record kinds (`spec`, `trap`, `decision`, `plan`, `state`, `log`) and is safe to re-run: an unchanged tree becomes a per-record no-op instead of duplicating records.

## Business Rules & Logic

Source discovery (each candidate is only used when it exists):

- Specs: `.agents/specs`, `specs`, `.spec-memo/specs`.
- Memory: `memory`, `.agents/memory`, `ws-shared/memory`.
- Plans: `.agents/plans`, `plans`.
- Changelog: `CHANGELOG.md`, `.agents/CHANGELOG.md`, `ws-shared/CHANGELOG.md`.

Mapping rules:

- Specs (`*.spec.md`, or `*.md` except files whose lowercased name contains `index.prd`): slug from frontmatter `slug`/`id` else the filename; title from frontmatter `title` else the first `# ` heading (the `Specification — ` prefix is stripped) else the slug. Emitted as kind `spec`. Original frontmatter is merged and `source: 'imported'` is stamped.
- Memory (`*.md`): `MEMORY.md` (the compiled view) is skipped. A file is a `decision` when frontmatter `kind === 'decision'`, or the slug starts with `adr-`/`decision-`, or the body matches `ADR`/`Architecture Decision`; otherwise it is a `trap`.
- Plans (directories under the plans candidates): the primary plan file is `plan.md`, else `implementation_plan.md`, else the first `.md` that is not hidden and does not contain `state` or `log`. Emitted as kind `plan` with the directory name slugified.
- Plan state: a file named `.state.md`, `state.md`, `run.json`, or `state.json` in the plan folder is emitted as kind `state` with slug `<planSlug>-state`, title `State: <slug>`, and `relatedSlug` set to the plan slug.
- Changelog: content is split on `^## ` headings; each non-empty section becomes a `log` record with slug `log-<first-30-chars-slugified>-<index>` and body prefixed with `## `.
- Status normalization (`normalizeRecordStatus`): `accepted`/`proposed` become `active` and additionally store `decisionStatus`; `active`/`paused`/`shipped`/`superseded`/`archived` pass through; anything else defaults to `active`.
- Skipped files: within plan folders, `.jsonl`, `.tmp`, names containing `telemetry`, `audit-*`, and `.runtime` are counted as skipped (not imported). `MEMORY.md` is likewise skipped. Files that throw during parse are counted in `skippedFilesCount` with their path in `skippedPaths`.
- Idempotency: before upserting, `findIdenticalVaultRecord` looks up the existing record by stable id (`getRecord` by kind + slug) and compares a SHA-256 hash of `title`, `status`, extra (`decisionStatus`), a stable frontmatter subset, and the trimmed body. Identical content is reported as `skipped-identical` (`skippedIdenticalCount` increments) and no file is written. Changed content (body or source-stable frontmatter such as `severity`, `pathPatterns`, `linkedPaths`) re-imports and overwrites. Lookup errors fail open to the normal upsert path.
- After import, compiled views (`rebuildCompiledViews`) and the SQLite FTS index (`rebuildIndex`) are rebuilt for the project.
- Every imported record is stamped `source: 'imported'` so provenance is visible in frontmatter. `id` and `slug` are the slugified stable key; re-running never mangles existing ids.
- Re-import semantics verified by tests: a second run on an unchanged tree reports `totalImported: 0`, `skippedIdenticalCount` equal to the first run's `totalImported`, all rows `skipped-identical`, and no new vault files; FTS returns exactly one hit per record. Editing source content (body or a stable frontmatter key) re-imports only that record.
- `--from` accepts either a product repository root or a direct `.agents` directory; when omitted, `productRoot`, the first positional, or `cwd` is used in that order.
- Human CLI output prints per-kind counts plus `Total: <n> (skipped files: <n>, identical: <n>)`. `--json` prints the full `ImportResult`.
- Failures during a single file parse are non-fatal: the file is counted as skipped and the run continues. A fatal error aborts the run and records a failed telemetry event.

## Technical Architecture

`importWorkflowTree(options)` resolves the vault root (`options.vaultRoot` else `getVaultRoot()`), the source root (`options.from` else `productRoot` else `cwd` else `process.cwd()`), and the project identity (`resolveProjectIdentity`), calling `ensureProjectVault` before any writes. It wraps `importWorkflowTreeDirect` and records `importer`/`memo_import` telemetry with duration, success, and counts (`totalImported`, `skippedFilesCount`, `skippedIdenticalCount`) on both success and failure.

Result shape (`ImportResult`): `projectId`, `vaultRoot`, `importedSpecsCount`, `importedTrapsCount`, `importedDecisionsCount`, `importedPlansCount`, `importedLogsCount`, `importedStateCount`, `skippedFilesCount`, `skippedIdenticalCount`, `totalImported`, `records` (imported `ImportItem[]` with status `imported`), `skippedRecords` (status `skipped-identical`), and `skippedPaths`.

Hash inputs are constrained by `IMPORT_HASH_FM_KEYS = ['severity', 'decisionStatus', 'pathPatterns', 'linkedPaths']`; vault-managed keys (id, tags, occurrences, hits, timestamps) are deliberately excluded so a vault round-trip does not look like a content change.

The importer writes through `upsertRecord({ cwd, projectId, vaultRoot, kind, slug, frontmatter, body, source: 'imported' })`. It does not persist an `originRelPath`; the original repository-relative path is not recorded on the record (see [Virtual File System](virtual-file-system.md)).

Provenance: `0005-import-and-doctor.spec.md`, `0052-us-54.spec.md`.
