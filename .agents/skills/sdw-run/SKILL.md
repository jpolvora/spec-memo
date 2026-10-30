---
name: sdw-run
description: End-to-end workflow orchestrator that coordinates spec execution, subagent dispatch, review loops, and delivery.
version: 0.2.0
invocation_names:
  - sdw-run
  - sdw-run run
  - sdw-run implement
  - sdw-run resume
  - sdw-run status
---
# sdw-run

> When this skill is loaded, output "sdw-run loaded."

Orchestrates spec execution from input requirement to delivery commit, automated code review, and pull request.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before running. A specification is a document, not an implementation order.

## Subcommands

- `run <specPath>`: Executes the full 8-step workflow pipeline for one specification.
- `run <specPath> --dry-run`: Validates the specification and prints the execution plan; executes nothing and writes no state.
- `run <specPath> --second-pass` (alias `--refine`): Refines an already implemented specification: audits how it was delivered, fills acceptance criteria that are missing or drifted from the spec, then applies clear simplification or quality gains. Writes a `{slug}-refine.md` report, commits only when the pass changed code, and runs Step 8 only when that commit exists. Producing no change is valid only when every criterion already holds and no drift remains.
- `run <specPath> --sandbox`: Executes the whole pipeline against an isolated local clone of `HEAD`; never pushes or opens a pull request.
- `sandbox list`: Lists isolated sandboxes with status, branch, and age.
- `sandbox report --run-id <runId>`: Regenerates and prints the sandbox report.
- `sandbox clean --run-id <runId>`: Deletes the sandbox clone and keeps its metadata and report.
- `task next [--run-id <runId>] [--json]`: Dispatches the next ready DAG task and emits its dispatch envelope (subagent mode).
- `task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`: Validates the dispatched task's evidence, accepts it, then saves it with one scoped checkpoint commit plus the tag `sdw-checkpoint-{runId}-{taskId}` (opt out: `--no-task-checkpoint`; second-pass runs keep their single `refine(...)` commit).
- `task abandon --run-id <runId> --task <taskId> --reason <text>`: Returns the dispatched task to the queue after a lost or failed worker.
- `score submit --run-id <runId> --verdict <path>`: Submits the Step 5 judge verdict and applies the conformance score.
- `resume`: Resumes an interrupted or paused run from its last recorded step in `.sdw/state/{runId}.state.json`.
- `status`: Displays current execution progress, conformance score, and step status.

## One Specification Per Run

`sdw-run` executes exactly one specification. A queue of specifications belongs to [`sdw-batch`](../sdw-batch/SKILL.md), which delegates each item to `sdw-run run <spec>` and waits for it to finish. `sdw-batch` never refines: it skips specs already recorded as delivered, and refinement is always an explicit single-spec `sdw-run run <spec> --second-pass` call.

## Second Pass (`--second-pass`)

- Requires an already delivered spec (registry `completed`/`archived`, or a completed run with a delivery commit); otherwise it refuses with exit `1`.
- Steps 2 and 3 are skipped in favor of one `task-refine` task, and `task finish` accepts an empty `filesChanged` for it.
- Gap closure is the first mandate: each acceptance criterion is audited against the delivered code, tests, configuration, and docs, and missing, partial, or drifted behavior is implemented. Simplification and quality passes follow, inside the same specification scope.
- No code change: Steps 5-8 are `skipped`, the refinement report is written, and the command exits `0` with `refineOutcome: "no-change"`. This is honest only when every criterion already holds and no drift remains.
- Code change: scoring, review, and shipping run normally. The commit is `refine({slug}): second pass refinement`, and shipping runs only because that commit exists.

## Dry Run vs Sandbox

- `--dry-run` is plan-only on `run`: validate the spec, print the plan, create nothing. Mutually exclusive with `--sandbox`.
- `--sandbox` clones the committed `HEAD` to `{sandboxDir}/{runId}/repo` (default `.sdw/sandbox`) on branch `sdw-sandbox/{runId}` using a shallow single-branch clone (`--depth 1 --single-branch`), removes the clone's `origin`, and runs every step against that clone. Uncommitted changes are excluded and recorded (`baselineDirty`).
- Sandbox delivery is forced off: no push, `scmProvider: none`, and `sdw-ship-pr --dry-run`. The source checkout and `.sdw/state` are never touched.
- Follow-up commands print absolute sandbox paths and `--root <clonePath>`. After every invocation the report at `.sdw/sandbox/{runId}/report.md` is refreshed and the `sandbox clean` command is proposed; nothing is deleted automatically.

## Steps

1. **Spec Ingestion & Derivation**
   Resolve project root and create isolated run state in `.sdw/state/{runId}.state.json`. If `useFeatureBranches: true`, activate feature branch (`feature/{specSlug}`); dirty trees are allowed and never block execution. If the spec is human-friendly, derive an agentic spec; if already formatted, skip derivation.
   - Run: `node skills/sdw-run/scripts/sdw_run.cjs run <specPath> [options]`
   - Done when: Run state exists on disk, branch is active, and derivation status recorded.

2. **Conduct Refinement Round**
   Walk decision tree paths for input bounds, failure recovery, and concurrency, producing a technical blueprint. In single-spec mode, query user via `ask_question` if ambiguous gaps remain. In batch mode, auto-resolve gaps using recommended defaults.
   - Done when: Decision gaps resolved, blueprint generated, and refinement artifact `{slug}-step-2.md` persisted.

3. **Decompose into DAG Tasks**
   Analyze complexity and emit DAG execution units with context prompts and dependency graphs.
   - Done when: DAG tasks generated, and DAG artifact `{slug}-step-3.md` persisted.

4. **Implementation Execution (Sequential Subagent Dispatch)**
   In `subagent` mode (default), dispatch exactly one ready DAG task and pause with exit code 4. Each brief carries the `sdw-rules` simplicity constraints (minimum code, surgical scope, no unrequested features). For each envelope: spawn one subagent that reads the prompt file and executes it as written, wait for its report, then submit `task finish`. If the worker reports a non-`success` status or never returns, run `task abandon --reason` and dispatch again. In `command` mode, execute the configured subprocess in topological DAG order. Worktrees are command-mode only; subagent mode uses the primary tree with dispatch-baseline corroboration. Every accepted `task finish` immediately saves the task as one scoped commit of its `filesChanged` (message `task({specSlug}): {taskId}`) plus the checkpoint tag `sdw-checkpoint-{runId}-{taskId}`, so a crash or reset between tasks loses nothing; `--no-task-checkpoint` opts out and `--second-pass` keeps its single `refine(...)` delivery commit. Once every task is accepted, run build and test verification gates.
   - Run: `node skills/sdw-run/scripts/sdw_run.cjs task next --run-id <runId>`
   - Done when: Every DAG task has accepted evidence, corroborated against its dispatch baseline and saved as a checkpoint commit plus tag, and build/test gates pass.
   - Exit codes: `4` dispatch pause (normal), `1` failure.

5. **Evaluate Conformance Score (LLM judge)**
   Score conformance with an LLM judge fenced to the acceptance criteria plus the generated diff — never transcripts. Per-criterion verdicts drive the score (`round(verified / total * 10)`); `scoring.judgeCriticity` sets strictness. When `scoring.judgeCommand` is unset, the current agent model judges: Step 5 writes `step-5-judge.prompt.md`, pauses with exit code 5, and accepts a verdict through `score submit`. Zero criteria, an unavailable judge, or a malformed verdict fails closed at 0/10. Below `scoreMin` (default 8/10) triggers the re-implementation loop (exit code 2).
   - Run: `node skills/sdw-run/scripts/sdw_run.cjs score submit --run-id <runId> --verdict <path>`
   - Done when: The judge verdict covers every criterion and the derived score meets the threshold, with the scoring artifact `{slug}-step-5.md` persisted.

6. **Delivery Commit & Security Gate**
   Refuse delivery commit if Step 4 is incomplete, any task unaccepted, or any gate failed. Run pre-commit secret leak scan (`sdw-security-checks`) when enabled. Stage and commit only tracked spec files (accepted evidence `filesChanged` + `index.specs.md`); unrelated worktree changes are never staged. Per-task checkpoint commits already cover accepted files, so Step 6 commits what remains and records `HEAD` when nothing is left.
   - Done when: Step 4 quality guards pass, pre-commit security check passes, and scoped delivery commit exists.

7. **Delegated Code Review via sdw-code-review**
   Dispatch subagent or CLI runner for `sdw-code-review`; inspect generated report to advance to Step 8 or trigger fix iteration.
   - Run: `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifact> [--fix] [--json]`
   - `sdw-code-review` is the sole code review authority; no duplicated internal review instructions.
   - When remediation is required, delegate the findings batch to `sdw-fixer` through a subagent brief carrying the findings file and report path (`node skills/sdw-fixer/scripts/sdw_fixer.cjs run --findings <path> --report <path>`); reviewer and fixer stay separate, never self-approve.
   - Done when: Report shows 0 blocking findings (`critical`/`warning`) or fix ceiling reached with residual recorded.

8. **PR Preparation, Delivery & Review Convergence**
   Delegate pull request preparation, pre-PR verification gates, remote publishing, SCM submission, and post-PR review convergence to `sdw-ship-pr`. Pass active run ID, specification slug, and CLI options (`--push`, `--poll-pr`, `--dry-run`).
   - Run: `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <specSlug> [options]`
   - Done when: `sdw-ship-pr` completes with exit code 0, delivery outcome is recorded in `.sdw/state/{runId}.state.json`, and specification is marked completed in index.

## References

- Architecture, batch protocol, and step artifacts persistence: [`references/orchestrator_protocol.md`](references/orchestrator_protocol.md)

