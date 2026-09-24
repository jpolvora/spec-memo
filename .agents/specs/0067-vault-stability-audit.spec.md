---
id: null
slug: vault-stability-audit
title: "Vault stability: truthful diagnostics, reliable multi-vault sync, bounded observability, and release coherence"
source: local
specDate: 2026-09-22
updated: 2026-09-23
status: active
---

# Specification - Vault stability: truthful diagnostics, reliable multi-vault sync, bounded observability, and release coherence

## Description

The hybrid multi-vault environment can report healthy persisted state while the live vault-Git tree is dirty, classify ignored workflow residue without a lifecycle decision, compare only FTS counts rather than record identity sets, mutate malformed or empty vaults during diagnosis, collapse dual-sync failures into incomplete channel truth, advance cursors past skipped records, split cursors and dirty flags across project aliases, expose incomplete telemetry summaries, and retain stale spec or release metadata.

The original Cursor plan at `.cursor/plans/vault_stability_audit_10848123.plan.md` covers six implementation phases plus verification gates: containment and baseline, truthful doctor/status, synchronization reliability, multi-vault identity and alias hygiene, bounded observability, and spec/release coherence.

Delivery status is **partial / in progress**. Commit `5693fea` and the v0.37.3 release provide a useful baseline for live vault-Git fields, sequential dual dispatch, basic telemetry summaries, error-log rotation, vault audit output, and spec-lifecycle checks. Passing tests or the earlier `completed` marker do not waive any acceptance criterion in this full-plan specification.

Language: en-us. The MCP surface remains exactly 11 tools. Vault records and workflow plans are preserved. Diagnosis is read-only. Cleanup, merge, purge, and deletion operations require the explicit gates in this specification.

## In Scope

- Read-only baseline capture and workflow-residue classification.
- Truthful doctor/status reporting for live and persisted vault state, FTS identity sets, hook drift, and version drift.
- Reliable sequential hybrid-then-vault-Git synchronization with bounded work, explicit failure states, and cursor integrity.
- Canonical project identity across search, bootstrap, sync, status, backup, wiki, canvas, and vault management.
- Backup-gated reconciliation of proven WorkflowOS and Marchante aliases while `MarchanteERP` remains quarantined.
- Bounded telemetry summaries, redaction, operational counters, and error-log retention.
- Spec lifecycle, tracking metadata, release versions, documentation, generated site artifacts, and controlled operator verification.

## Acceptance Criteria

### Baseline and containment

- AC1: A read-only baseline captures doctor and status output, live and persisted vault-Git state, project aliases, backup inventory, and bounded telemetry and error-log summaries without changing product or vault data.
- AC2: A read-only residue report classifies each gitignored workflow-plan artifact as `active`, `completed`, or `stale` and explains the evidence used for each classification; diagnosis does not delete or rewrite any plan artifact.
- AC3: Doctor, status, preflight, and audit operations do not run plan cleanup, vault purge, alias reconciliation, project merge, or project deletion as a side effect.
- AC4: Any later cleanup or alias reconciliation is blocked until a fresh backup exists and an operator has reviewed both the residue classification manifest and the relevant record-count and content-comparison manifest.

### Truthful doctor and status

- AC5: Live vault-Git inspection reports author availability through `git var GIT_AUTHOR_IDENT` and live porcelain state for the configured allow-listed tree, including `projects`, `config.json`, and `.gitignore`.
- AC6: Doctor and status keep persisted channel state separate from live state and expose dirty-state disagreement, last successful channel flush, last failure phase, and the current dirty-state transition.
- AC7: Doctor and status report hook-version drift, config-versus-package version drift, and classified ignored-residue counts without mutating records or configuration.
- AC8: FTS consistency compares the complete canonical Markdown record-ID set with the complete `records_fts` ID set, excludes compiled views, project metadata, and conflict sidecars, and reports missing or unexpected IDs rather than treating equal counts as sufficient proof.
- AC9: Malformed-config and empty-vault diagnostic paths return bounded status or errors and perform no filesystem writes, including no vault scaffolding, config replacement, telemetry initialization, or record mutation.

### Hybrid and vault-Git reliability

- AC10: Dual-mode dispatch remains sequential, with hybrid HTTP completing before vault-Git starts, and all affected CLI, README, product, index, spec, and generated-site text describes that ordering rather than parallel dispatch.
- AC11: Every dual-sync result exposes independent hybrid and vault-Git `ok`, error code, phase, duration, dirty-state transition, and cursor impact while retaining one aggregate result and aggregate telemetry event.
- AC12: Pull, local apply, compiled-view rebuild, commit, rebase, and push are timed separately; network and local work are bounded; and single-flight or vault locks are not held across network waits.
- AC13: Missing Git identity, rebase conflict, Windows file lock, timeout, remote HTTP 4xx or 5xx, and partial per-record skip produce explicit fail-open results with durable redacted `lastError` and no false clean transition.
- AC14: `memo sync --all --dry-run` and the controlled real run have parity for channel selection and ordering; cursors advance only for acknowledged records, while skipped or conflicted records preserve dirty state and remain available for a later acknowledged sync.

### Multi-vault identity and aliases

- AC15: The vault audit reports aliases, duplicate normalized remote identities, fallback and tool/runtime roots, orphaned projects, record ownership and counts, last-seen roots, alias leftovers, and quarantine state without mutating projects.
- AC16: Search, bootstrap, sync, status, backup, wiki, canvas, and vault-management operations resolve an explicit alias to the same terminal canonical project ID through one shared canonicalization path.
- AC17: WorkflowOS and Marchante aliases are reconciled only after a fresh backup, record-count and content comparison, an operator-reviewed manifest, and explicit destructive-operation confirmation; non-equivalent content is not merged, and `MarchanteERP` remains quarantined until proven duplicate or intentionally distinct.
- AC18: Alias creation, merge, or rename migrates or conservatively combines per-project cursors and dirty flags, and no operation through an alias can create split cursors, split dirty flags, or split record ownership.

### Bounded observability

- AC19: Read-only CLI, doctor, status API, and dashboard contracts resolve an existing rolling `telemetry-YYYY-MM-DD.part-N.jsonl` file and expose a bounded summary containing failure rate, p50/p95/p99 duration, per-project sync health, and top error codes without loading full history; local CLI output must permit the operator existence check while remote payloads do not expose unrelated absolute host paths.
- AC20: Telemetry remains append-only and classifies expected CLI `EXIT_1`, install-permission prompts, and HTTP 401 events separately from product faults without treating every exit code 1 as expected.
- AC21: Observable counters include status-probe noise, test-originated writes, sync conflicts, skipped records, compiled-view rebuild skips, and vault-Git dirty transitions.
- AC22: Telemetry summaries, diagnostics, error logs, status API output, and dashboard output redact secrets, bearer material, unrelated absolute paths, and prompt bodies.
- AC23: `error.logs` rotates at 8 MiB, retains the eight newest timestamped backups, preserves the existing 2 MiB newest-tail viewer contract, and deletes no operator log outside that documented rotation and retention policy.
- AC24: AI remains disabled by default, and an empty AI Ops journal is reported as expected rather than as an AI outage.

### Spec and release coherence

- AC25: A generic lifecycle scan warns when a shipped Done-log slug remains `[ ] todo`, `issueState: open`, or `status: draft`, unless a machine-readable exception explicitly applies; the scan must not rely on a hard-coded feature-name special case.
- AC26: Tracking metadata is reconciled for `0057-status-ai-ops-logs`, `0029-prompt-history-and-query`, `0051-us-55`, `0052-us-54`, `0060-open-github-issues-batch`, `0063-ai-ops-test-ai-button`, and `0064-ai-timeout-config`; the accepted removal of `0027-virtual-file-system-over-mcp` as wont-implement is consistent across the index, product docs, generated site, and references, and this slice does not recreate or mark that feature shipped.
- AC27: `package.json`, `package-lock.json`, generated skill versions, README, FEATURES, PLAN, CLI help, and docs-site artifacts use one next approved release version and consistently describe sequential dual sync.
- AC28: This specification passes `validate_spec.cjs --mode=authoring`; if the canonical validator is unavailable, the slice cannot be marked complete until the validator is made available and passes.
- AC29: The slice is complete only after the automated, Windows-fixture, site, canonical-validator, operator-smoke, and exit-criteria gates in this specification pass with recorded evidence.

## Original Issue Context

The operator plan `vault_stability_audit_10848123.plan.md` captured a hybrid vault with vault-Git enabled, doctor failures caused by 70 ignored plan artifacts and hook-version drift, persisted-versus-live vault-Git disagreement, repeated dual-sync failures including missing Git identity, alias and fallback-project duplication, incorrect telemetry paths, unbounded error-log growth, and shipped-spec and release metadata drift.

The plan explicitly required data preservation and no destructive cleanup before classification. It also required safe reconciliation of known aliases after backup and content comparison, full synchronization truth, bounded observability, release coherence, and controlled operator verification.

### Prior Work Sweep

- Related specifications: `0005-import-and-doctor`, `0009-cli-doctor`, `0018-vault-git`, `0025-deployment-modes`, `0028-operational-telemetry`, `0031-memo-status`, `0033-vault-git-hybrid-sync`, `0035-sync-conflict-reconciliation`, `0047-vault-merge-alias`, `0051-us-55`, and `0052-us-54`.
- Partial implementation baseline: commit `5693fea`, merged through PR #81 as `1b20b83` for v0.37.3.
- Current branch baseline during the 2026-09-23 review: `c1c457b` and package version 0.37.4, which supersedes the older version recorded by the original completion claim but does not close the broader plan.
- Read-only review evidence: 235 targeted tests passed, `tsc --noEmit` passed, and the site check passed; static and runtime review still found unmet full-plan requirements.
- The concurrent VFS removal decision records `0027-virtual-file-system-over-mcp` as wont-implement. Those files are outside this slice and must not be reverted by this specification update.

### Design Intent

The product must expose operational truth before it attempts cleanup or reconciliation. Persisted state, live state, canonical identity, synchronization acknowledgement, and operator-visible diagnostics are separate concerns and must not be collapsed into a healthy boolean. Destructive work is permitted only after backup, comparison, classification, and explicit confirmation. Existing 11-tool MCP and local/loopback bearer boundaries remain unchanged.

## Notes

- Expected implementation touchpoints include `src/doctor.ts`, `src/status-cmd.ts`, `src/status.ts`, `src/vault.ts`, `src/vault-git-state.ts`, `src/vault-git-inspect.ts`, `src/dual-sync.ts`, `src/hybrid-sync.ts`, `src/hybrid-state.ts`, `src/sync.ts`, `src/server.ts`, `src/prompt.ts`, `src/identity.ts`, `src/vault-manager.ts`, `src/canvas.ts`, `src/telemetry.ts`, `src/error-logger.ts`, and `src/spec-lifecycle.ts`. This list is guidance, not an exhaustive implementation boundary.
- Remote vault-Git I/O must remain asynchronous. Windows tests must close SQLite handles and tolerate bounded `EBUSY` or `EPERM` cleanup failures caused by live Git processes.
- Vault locks and single-flight guards must not span network waits or long local rebuild work.
- Existing compiled views, project metadata, and conflict sidecars are not canonical source records for FTS consistency.
- A passing targeted suite proves only the assertions present in that suite; it does not prove an absent negative scenario or an unrecorded operator smoke gate.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Virtual File System over MCP implementation | The accepted concurrent decision records `0027` as wont-implement and removes it from the active roadmap; this slice only prevents dangling or falsely shipped references. |
| Blind alias merge or fallback-project deletion | Only fresh-backup, content-proven, operator-confirmed reconciliation is in scope. |
| `memo doctor --fix`, plan-directory wiping, or implicit plan cleanup | Product Git boundaries require classification and explicit operator action. |
| Dedicated status Reconcile tab | CLI-first reconcile visibility is sufficient until channel and sidecar data are trustworthy. |
| Enabling AI by default | AI remains disabled under the current product posture. |
| A twelfth MCP tool | The core MCP surface remains exactly 11 tools. |
| New public mutating HTTP endpoints | Diagnostics remain read-only and existing SSE bearer controls remain authoritative. |
| Unbounded full-history telemetry loading | All summaries must use explicit finite byte, file, or event bounds. |
| Selecting the final release number in this specification | The release version is resolved by the shipping workflow after implementation and verification. |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Error-log pruning | Rotate at 8 MiB and retain the eight newest backups; delete nothing outside that documented policy | Bounded retention and a strict no-deletion rule cannot both hold without an explicit approved retention policy. | y |
| Telemetry summary bounds | Use finite surface-specific byte, file, and event caps | The plan requires bounded summaries but does not require one universal event limit. | y |
| Alias reconciliation | Require fresh backup, content comparison, reviewed manifest, and explicit confirmation | This covers the plan while preventing data loss. | y |
| VFS lifecycle | Treat `0027` as wont-implement and removed from the active roadmap | This reflects the accepted concurrent product decision and avoids recreating a deferred draft. | y |
| Authentication and rate limits | Add no new public mutation surface; preserve existing loopback and bearer behavior | This slice adds diagnostics and controlled local reconciliation, not public write APIs. | y |
| Retry and deduplication | Reuse existing sync and reconcile retry semantics unless an AC explicitly changes them | The plan requires truthful acknowledgement and bounded failures, not a new generic retry framework. | y |
| Release version | Resolve to the next approved version at ship time | Current artifacts are newer than the original v0.37.3 completion record. | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Bounded scope | All six plan phases, AC1-AC29, and every explicit exclusion are approved | Spec review and authoring validation |
| Baseline evidence | Read-only doctor, status, Git, alias, backup, telemetry, and error-log evidence is recorded | Operator preflight output |
| Classification evidence | Workflow residue and relevant vault projects have reviewable classification and comparison manifests | Read-only audit output |
| Destructive-work gate | Backup creation, comparison review, and explicit confirmation are implemented before cleanup or merge | Negative and integration tests |
| Failure coverage | Every named failure class and negative scenario has a named automated or operator check | Test-plan review |
| Tooling | Build, full tests, targeted suites, site check, Windows fixtures, and canonical validator are runnable | Command inventory |
| State honesty | Spec 0067 and its index rows remain partial or in progress while any AC or gate is open | Frontmatter and index review |

## Validation & Observation Notes

### Automated Validation Gates

1. Run `npm run build`.
2. Run `npm test`.
3. Run `npm run check:site`.
4. Run the targeted suites:
   - `dist/doctor.test.js`
   - `dist/status-cmd.test.js`
   - `dist/vault-git-hybrid-sync.test.js`
   - `dist/reconcile.test.js`
   - `dist/telemetry.test.js`
   - `dist/error-logger.test.js`
   - `dist/vault.test.js`
   - `dist/status.test.js`
   - `dist/multi-clone.test.js`
   - `dist/vault-stability.test.js`
5. Run Windows fixtures for missing Git identity, dirty-tree rebase, lock contention, timeout, remote 4xx and 5xx, alias comparison, stale cursor, partial changeset skip, malformed config, and read-only doctor or status behavior.
6. Run `node {skillsRoot}/ws-spec-format/scripts/validate_spec.cjs --mode=authoring .agents/specs/0067-vault-stability-audit.spec.md`.
7. Record commands, exit codes, and relevant test counts. A skipped or unrecorded gate is not a pass.

### Operator Smoke Gates

1. Create or verify a fresh backup before any cleanup, merge, or real all-project sync.
2. Run `memo doctor --json` and confirm it reports only intentionally classified residue.
3. Run `memo status --json`, confirm live and persisted vault-Git truth, and verify `operational.telemetry.logFile` identifies an existing rolling part file.
4. Run `memo vault list --audit --json` and review aliases, duplicate identities, fallback roots, orphans, ownership, counts, last-seen roots, and quarantine state.
5. Run `memo sync --all --dry-run --json` and verify channel order, cursor and dirty-state predictions, and absence of commit or remote mutation.
6. After a fresh backup and manifest review, run controlled `memo sync --all --json`.
7. Confirm skipped or conflicted records remain dirty and unacknowledged, per-channel results retain independent truth, and the aggregate result is fail-visible.
8. Confirm error-log size and backup count remain within the approved retention policy.
9. Confirm shipped specs, the VFS wont-implement record, version artifacts, CLI help, README, PLAN, and generated site are coherent.

### Telemetry & Observable Signals

- `memo doctor --json` reports live Git author and porcelain state, persisted-versus-live disagreement, last successful flush, last failure phase, exact FTS consistency, hook drift, version drift, and residue classifications.
- `memo status --json` reports truthful health, rolling telemetry metadata, bounded failure rates and percentiles, per-project sync health, top error codes, and vault audit results.
- `memo sync --all --json` reports aggregate and per-channel status, error code, phase, duration, dirty transition, and cursor impact for hybrid and vault-Git.
- `error.logs` stays below the rotation threshold after a rotation event and no more than eight timestamped backups remain.
- Telemetry and diagnostics contain no secrets, bearer material, unrelated absolute paths, or prompt bodies.

### Negative & Failing Test Scenarios

- Unclassified tracked pollution makes doctor fail.
- Classified gitignored plan residue does not fail doctor and is never deleted by diagnosis.
- Malformed config or an empty vault does not cause diagnostic writes or scaffolding.
- Missing Git identity records `lastError` and never reports a false clean transition.
- Dirty-tree rebase or conflict preserves dirty state and reports the failing phase.
- A Windows lock or timeout identifies the affected phase and does not block unrelated vault access indefinitely.
- Remote HTTP 4xx or 5xx and timeout fail the affected channel without erasing the other channel's result.
- Partial record skips or conflicts do not advance the hybrid cursor, including when a later push succeeds in the same run.
- Dry run performs no commit or remote mutation and has channel parity with the controlled real run.
- Non-equivalent alias content is not merged, and `MarchanteERP` remains quarantined.
- An alias target cannot create a separate cursor, dirty flag, or record-ownership partition.
- A large or malformed telemetry history produces a bounded, redacted summary.
- Secrets, bearer material, unrelated absolute paths, and prompt bodies never appear in observability output.
- Error-log pruning occurs only through the approved 8 MiB and eight-backup rotation policy.
- An empty AI Ops journal with AI disabled is not reported as an outage.
- The lifecycle scan flags a shipped draft or open spec through a generic rule rather than a feature-specific hard-coded condition.
- Parallel-sync wording in any affected user-facing surface fails documentation validation.

## Revision History

### [2026-09-23] Revision: Restore full-plan scope and partial delivery status (Prompt: "improve the spec based on this plan")

- Expanded AC1-AC20 to AC1-AC29 across all original plan phases and verification gates.
- Restored backup-gated alias reconciliation and full canonical multi-vault behavior to scope.
- Reclassified delivery as partial or in progress instead of completed.
- Resolved error-log retention as an explicit 8 MiB rotation and eight-backup policy.
- Accepted the concurrent wont-implement removal of `0027-virtual-file-system-over-mcp` without modifying its files.
