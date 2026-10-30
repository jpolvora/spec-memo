# sdw-batch Protocol Reference

`sdw-batch` is a queue around `sdw-run`. It owns ordering, pause bookkeeping, and reporting; it owns no implementation step.

## 1. Delegation Contract

For each queue item, `sdw-batch` runs one of:

```bash
node skills/sdw-run/scripts/sdw_run.cjs run <specPath> --run-id <runId> --unattended --root <projectRoot>
node skills/sdw-run/scripts/sdw_run.cjs resume --run-id <runId> --root <projectRoot>
```

The child process inherits stdio and is awaited. Its exit code is the queue decision:

| Exit | Meaning | Batch action |
|---|---|---|
| `0` | Single-spec pipeline completed | Mark item completed, record delivery commit, sync index, next item |
| `4` | Dispatch pause (`awaiting_implementation`) | Record item + `runId`, manifest `paused`, exit `4` |
| `5` | Judge pause (`awaiting_judgment`) | Record item + `runId`, manifest `paused`, exit `5` |
| other | Failure | Halt (default) or record and advance (`--continue-on-error`) |

Exit `3` (`--abort-on-gaps` grilling cancellation) is not a batch pause: the queue delegates unattended and never requests that flag, so a `3` is handled as a failure.

The host agent owns the paused single run: `task next`, `task finish`, `score submit`, then `sdw-batch resume`.

## 2. Manifest

Path: `.sdw/state/batch-{batchId}.json` (gitignored run state).

```json
{
  "batchId": "batch-1792580000000",
  "createdAt": "2026-10-21T12:00:00.000Z",
  "updatedAt": "2026-10-21T12:10:00.000Z",
  "status": "paused",
  "policy": { "continueOnError": false, "syncIndex": true },
  "total": 3,
  "currentIndex": 0,
  "queue": [
    {
      "index": 0,
      "spec": ".sdw/specs/00036-example.md",
      "slug": "00036-example",
      "status": "completed",
      "skipReason": null,
      "runId": "run-1792580000000-00036-example",
      "deliveryCommit": "0dc5ce6...",
      "branch": "develop",
      "durationMs": 119400,
      "error": null,
      "retroFollowUp": {
        "status": "queued",
        "candidates": 2,
        "bySeverity": { "high": 1, "low": 1 },
        "reportPath": ".sdw/state/00036-example/run-1792580000000-00036-example/run-1792580000000-00036-example.retro.json",
        "queued": [
          { "candidateId": "RETRO-001", "spec": ".sdw/specs/00047-example-fix.md", "slug": "00047-example-fix" }
        ],
        "failures": []
      }
    },
    {
      "index": 1,
      "spec": ".sdw/specs/00047-example-fix.md",
      "slug": "00047-example-fix",
      "status": "pending",
      "followUpDepth": 1,
      "origin": { "candidateId": "RETRO-001", "runId": "run-1792580000000-00036-example" }
    }
  ]
}
```

Statuses: `pending`, `already_implemented`, `in_progress`, `awaiting_implementation`, `awaiting_judgment`, `completed`, `failed`.
Manifest statuses: `in_progress`, `paused`, `halted`, `completed`, `completed_with_errors`.
Item fields: `retroFollowUp` records the follow-up outcome of a completed item; `followUpDepth: 1` and `origin` mark a queued follow-up item.

### Already-implemented skip

Before an item is delegated, `sdw-batch` reads the specification registry (`{specsDir}/index.specs.md`) and skips every spec recorded as `completed` or `archived`, recording the queue item as `already_implemented` with a `skipReason`. The check runs when the manifest is created and again per item before delegation, so a spec completed since the batch started (or during a resume) is never implemented twice. A registry that cannot be read warns and never blocks the queue.

A batch never refines a delivered specification. Refinement is an explicit single-spec call: `sdw-run run <specPath> --second-pass` (alias `--refine`).

## 3. Retro Follow-Up

After an item completes, `sdw-batch` reads that item's run state and consumes `state.retro`. It never re-derives candidates; the retrospective owns them.

| `retro.followUp` | Action |
|---|---|
| `queue` (default) | For every `critical` or `high` candidate, create one draft specification through `sdw-spec new <text> --title <title> --root <root> --json`, then append `{ index, spec, slug, status: "pending", followUpDepth: 1, origin: { candidateId, runId } }` after the last queue item and update `total`. |
| `record` | Write `.sdw/state/batch-{batchId}.followups.md` listing every candidate (severity, title, evidence, proposedChange) and create no specification. |
| `none` | Read no retro report; record `retroFollowUp: { status: "skipped" }`. |

`retroFollowUp` shape: `{ status, candidates, bySeverity, reportPath, queued, failures }`. `candidates` is the candidate count, `bySeverity` counts the severities present in the report, `queued` lists the created specifications, and `failures` records creation errors. A `skipped` record carries only `status`, because the report is never opened.

| Status | Meaning |
|---|---|
| `queued` / `recorded` | The report was consumed; `queued` appended specs (possibly none), `recorded` wrote the report file. |
| `unavailable` | No run state, no `state.retro`, or no report file. |
| `failed` | The retrospective itself failed; its report is not trusted. |
| `invalid` | The report is not JSON or has no `candidates` array. |
| `skipped` | `retro.followUp` is `none`; the report is never read. |
| `depth-exceeded` | The item is itself a follow-up (`followUpDepth >= 1`) under `queue`; its report is read and summarized, but no specification is queued. |

A follow-up item is still fully summarized: `candidates` and `bySeverity` stay visible, `queued` and `failures` stay empty, and no queue entry is appended. Under `record` a follow-up item records normally (`recorded`) and its candidates enter the follow-up report; only the `queue` policy has something to suppress.

A failed specification creation is recorded as `{ candidateId, error }` in `failures`; the remaining candidates are still processed, the item stays `completed`, and the queue status does not change. Queued specifications and failures appear in the summary. The stage never prompts and never halts the queue; only the delegated run outcome halts or pauses it.

## 4. Resume Rules

- Resume skips items that are `completed` or `already_implemented`; neither is delegated again.
- Resume starts at the first item that is not `completed`.
- If the item records a `runId` whose state is `paused` or `in_progress`, delegate `sdw-run resume` with that exact id (never a new run).
- If the recorded state is already `completed`, reconcile the item (copy delivery commit and branch) and advance without re-executing.
- If the state file is missing, delegate a fresh `run` with a new run id.
- The manifest policy (`continueOnError`, `syncIndex`) is preserved unless the resuming invocation overrides it.

## 5. Failure Policy

- Default: the item is marked `failed`, the manifest becomes `halted`, remaining items stay `pending`, and the command exits `1`.
- `--continue-on-error`: the failure is recorded and the queue advances; the final manifest becomes `completed_with_errors` and the command exits `1`.
- Batch exit codes are `0` (completed), `1` (failure or finished with errors), `4`/`5` (propagated pauses). A delegated failure code is recorded in `error`, never re-emitted, so no caller can mistake a failure for a pause.
- Resuming a batch whose manifest is `completed_with_errors` returns `1` and leaves the manifest unchanged; it never re-labels the batch as `completed`.

## 6. Summary

After completion, halt, or pause, `sdw-batch` prints one table: index, slug, status, duration, delivery commit. A follow-up section below the table lists the queued specifications and every creation failure with its candidate id. `--json` prints the manifest instead. Per-spec artifacts and state remain in the single run's directory.

## 7. Boundaries

- No parallel execution: one delegated run at a time.
- No direct calls to individual `sdw-run` steps; the CLI is the only interface.
- No worker dispatch: the host agent spawns subagents for dispatched tasks.
- No duplicated review, scoring, or commit logic.
- No direct specification authoring: follow-up drafts go through `sdw-spec`, and no follow-up is created from a follow-up item.
