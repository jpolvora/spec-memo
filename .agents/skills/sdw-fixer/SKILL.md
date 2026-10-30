---
name: sdw-fixer
description: Shared findings intake and surgical remediation for SDW review, verification, and ship loops.
version: 0.1.0
invocation_names:
  - sdw-fixer
  - sdw-fixer run
  - sdw-fixer doctor
  - fixer
---
# sdw-fixer

> When this skill is loaded, output "sdw-fixer loaded."

Single remediation authority for Spec-Driven Workflow. Scores one finding batch once, sweeps defect-class siblings, injects memory hints, applies surgical edits, then emits a structured report.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) — simplicity, surgical scope, verification — before any edit. Reviewer and fixer stay separate; never self-approve.

## Subcommands

- `run --findings <path> --report <path> [--markdown <path>] [--dry-run] [--json] [--verify <cmd>] [--no-learn]`: Validate, score, gather context, apply trivial patches, register traps, write the JSON report (and an optional Markdown round report).
- `doctor [--json]`: Validate skill layout, references, script syntax, and zero-dependency guarantee.

## Steps

1. **Validate Intake**
   Parse findings JSON (`[{ file, line, rule, evidence, severityHint }]`); require project-relative `file` (no absolute paths, no `..`), non-empty `rule`, non-empty `evidence`.
   - Run: `node skills/sdw-fixer/scripts/sdw_fixer.cjs run --findings <path> --report <path> [--dry-run]`
   - Done when: Malformed entries halt with exit `1` and zero file mutations.

2. **Score Deterministically**
   Apply the severity rubric once per batch (`critical 100`, `high 75`, `medium 50`, `low 25`, missing `50`) and fix in descending score order.
   - Done when: `[sdw-fixer] Scoring N findings` names every finding with its score.

3. **Gather Context via sdw-memory**
   Grep the repo for defect-class siblings (cap 50 hits) first, then query knowledge per finding through the central `sdw-memory` wrapper (traps table, memory files, ws-memo vault in backend order); record `sourcesConsulted` per finding, `consult-skipped` when a backend is unavailable. Results are cached per defect class within the batch.
   - Done when: Each finding lists sibling hits plus memory hints or explicit skips.

4. **Apply Surgical Edits**
   Apply deterministic trivial patches at finding lines plus verified sibling lines across all files in the batch (run-own artifacts excluded); anything else becomes a `skipped` entry with `path + reason` for agent reasoning. Never close a defect class with an unrecorded surgical sibling.
   - Done when: Diffs touch only finding scope and `--dry-run` mutates nothing.

5. **Report Results & Register Learning via sdw-memory**
   Write `{ batchId, fixed, skipped, covered, comments, amendments, wouldFix, learned, verification, reportPath }` JSON to `--report`, plus a Markdown round report when `--markdown` is given. `comments` carries one resolution comment per fixed thread (the caller posts it and leaves unfixed threads open); `amendments` records each deviation from the scored plan with its reason and evidence. Record one knowledge entry per fixed defect class through `sdw-memory` (deduplicated by slug, skipped under `--dry-run`, `--no-learn`, or failed verification); run the `--verify` command when given, otherwise record verification `skipped`. Caller commits fixer-touched files plus `.sdw/memory/traps.md` when `learned` reports a new row.
   - Done when: Report exists at `--report` and exit is `0` (`1` only on invalid intake or verify failure with the partial report preserved).

## References

- Intake schema, scoring rubric, discovery order, scope gate, report fields: [`references/fixer_protocol.md`](references/fixer_protocol.md)
- Deterministic helper: `scripts/sdw_fixer.cjs`
