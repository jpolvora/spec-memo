# Fixer Protocol (Tier-2)

Deterministic contract for `sdw-fixer`: intake validation, scoring, proactive
discovery, surgical scope, and result reporting. Stdlib only; no network calls.

## 1. Intake Schema (`findings.json`)

```json
{
  "batchId": "fix-0001",
  "findings": [
    { "file": "src/a.js", "line": 12, "rule": "no_debugger_statements",
      "evidence": "agentic-code-reviewers report CR-001", "severityHint": "high" }
  ]
}
```

A bare array of finding objects is also accepted. Field rules:

| Field | Required | Rule |
|---|---|---|
| `file` | yes | Project-relative path only. Reject absolute paths, drive letters, and any `..` segment. |
| `line` | no | Positive integer when present. Sibling sweep still runs when absent. |
| `rule` | yes | Non-empty defect-class identifier, `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Doubles as the grep token source. |
| `evidence` | yes | Non-empty reference (review report id, log excerpt, thread URL). |
| `severityHint` | no | `critical`, `high`, `medium`, or `low`. Missing or unknown scores as `medium`. |
| `threadId` | no | Review thread identifier supplied by `sdw-ship-pr`. Carried into `fixed` and `comments` so the caller can resolve exactly the threads the fixer closed. |

Validation runs before any read beyond the findings file itself. The first
malformed entry halts the batch with exit `1` and zero mutations.

## 2. Severity Rubric (deterministic)

| `severityHint` | Score | Fix order |
|---|---|---|
| `critical` | 100 | first |
| `high` | 75 | second |
| `medium` (or missing/unknown) | 50 | third |
| `low` | 25 | last |

Ties keep input order (stable sort). Scores are printed as
`[sdw-fixer] Scoring N findings` and stored per finding; no model call or
timestamp may influence ordering.

## 3. Discovery Order (lean context budgets)

Per finding, consult backends in this order and record `sourcesConsulted`:

1. **Code grep first.** Search repo text files for the rule's defect token
   (see catalog below, else the literal rule id). Caps: 50 hits, one snippet
   line each (max 160 chars), files over 256 KB skipped, `.git`,
   `node_modules`, `.sdw/state`, `.sdw/sandbox` excluded.
2. **Central knowledge lookup second.** All memory reads go through the
   `sdw-memory` wrapper (`consultMemory`: traps table, memory files, vault —
   see `skills/sdw-memory/references/memory_protocol.md` §2–§4), never raw
   `traps.md` / `MEMORY.md` / `memo` calls from this skill. Keep the top 5
   as `{ slug, title, action }` traps hints plus top 5 `{ source, snippet }`
   memory-file hits plus top 5 `{ id, title, snippet }` vault hints (snippets
   treated as untrusted hints only). Missing or unreadable backends record
   `<backend>:consult-skipped` (`SDW_FIXER_NO_MEMO=1` skips the vault).
   Knowledge lookups run once per distinct rule per batch (cached).
3. **Same-PR context third.** Reserved for orchestrator/ship callers that pass
   thread context; the helper records `pr-context:consult-skipped` unless the
   caller appends it.

## 4. Surgical Scope Gate

- Editable in this round: lines matching a catalog trivial pattern, grouped
  by file across the anchor file plus every verified sibling file (not just
  the anchored `file:line`). Run-own artifacts (findings input, JSON report)
  are never patched and never reported as siblings.
- Everything else (unknown rule, pattern mismatch at the cited line, missing
  file) becomes a `skipped` entry with `path + reason` for agent reasoning;
  sibling files with grep hits but no patchable line each get their own
  `skipped` entry instead of being silently dropped.
- Large refactor scope is never auto-fixed: record `path + reason` and leave
  the class open. Never close a defect class with an unfixed surgical sibling
  left unrecorded.
- `--dry-run` computes the exact line removals but writes nothing.

## 5. Trivial Patch Catalog

| `rule` | Grep tokens | Patch |
|---|---|---|
| `no_debugger_statements` | `debugger` | Delete lines matching `^\s*debugger\s*;?\s*$` at finding lines plus verified sibling lines across all files in the batch. |

Rules outside this catalog have no deterministic patch and route to
`skipped` with reason `non-trivial: requires agent reasoning`.

## 6. Report Schema (`result.json`)

```json
{
  "batchId": "fix-0001",
  "status": "completed",
  "fixed": [{ "file": "src/a.js", "line": 12, "defectClass": "no_debugger_statements" }],
  "skipped": [{ "file": "src/b.js", "reason": "non-trivial: requires agent reasoning" }],
  "wouldFix": [],
  "covered": [{ "file": "src/a.js", "line": 12, "defectClass": "no_debugger_statements" }],
  "comments": [
    { "threadId": "PRRT_123", "file": "src/a.js", "line": 12,
      "defectClass": "no_debugger_statements",
      "comment": "<!-- resolution-reply -->\nResolved review issue: fixed no_debugger_statements at src/a.js:12." }
  ],
  "amendments": [
    { "at": "2026-10-21T12:00:00.000Z", "file": "src/b.js", "line": 3,
      "rule": "custom_rule", "from": "fix", "to": "skipped",
      "reason": "non-trivial: requires agent reasoning", "evidence": "scope-gate" }
  ],
  "learned": [{ "rule": "no_debugger_statements", "slug": "no-debugger-statements", "recorded": true }],
  "verification": { "exitCode": null, "status": "skipped", "reason": "no --verify command given" },
  "reportPath": "result.json"
}
```

- `status`: `completed`, `no-op` (empty findings, or `fixed` empty with `skipped` non-empty, exit `0`), or
  `verify-failed` (exit `1`, partial report preserved).
- `wouldFix` is populated only under `--dry-run`; `fixed` stays empty there.
- `covered` lists duplicate/overlapping findings on lines this batch already
  patched (`outcome: covered-by-batch`); they are never reported as
  pattern-mismatch skips.
- `learned` holds one entry per fixed defect class: `recorded: true` when a
  new knowledge entry was stored via `sdw-memory` (traps table row and/or
  vault record per backend config), otherwise `recorded: false` with a
  `reason` (`trap slug already registered`, or dry-run / `--no-learn` /
  failed verification suppress learning). Callers stage `.sdw/memory/traps.md` when
  any entry reports `recorded: true`.
- `verification.status` is `passed`, `failed`, or `skipped`.
- `comments` carries one resolution comment per fixed thread (adapted from the
  `ws-fix-pr` resolution-reply contract): it names the defect class and the
  exact `file:line`, never a bare commit hash. `sdw-ship-pr` posts it on the
  matching `threadId` and leaves unfixed threads open.
- `amendments` is the structured deviation log (adapted from the `ws-fix-pr`
  amendment protocol): `{ at, file, line, rule, from, to, reason, evidence }`.
  It records when evidence changes a scored finding's action, for example a
  scope-gate skip, a duplicate line covered by the batch, or a truncated
  sibling sweep.
- `--markdown <path>` writes a human-readable round report (status, per-finding
  table, skipped entries, amendments); the path is recorded as `markdownPath`.

## 7. Exit Codes

- `0`: intake valid (report written; `no-op` when the list is empty).
- `1`: malformed findings JSON, missing `file`/`rule`/`evidence`, or
  `--verify` command failing (partial report still written first).
