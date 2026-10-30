# sdw-run Orchestrator Protocol & Architecture Reference

This reference details the internal lifecycle and contracts of the `sdw-run` orchestrator.

## 1. Run State Lifecycle (`.sdw/state/{runId}.state.json`)

Each execution session is completely isolated within a dedicated JSON state file.

```json
{
  "orchestrator": "sdw-run",
  "runId": "run-1729300000-feature",
  "specSlug": "feature",
  "specPath": ".sdw/specs/feature.spec.md",
  "projectRoot": "L:/source/project",
  "status": "in_progress",
  "currentStep": 1,
  "totalSteps": 8,
  "createdAt": "2026-10-18T23:00:00.000Z",
  "updatedAt": "2026-10-18T23:05:00.000Z",
  "baseCommit": "38a7c1...",
  "deliveryCommit": null,
  "branch": "feature/00040-example",
  "baseBranch": "master",
  "branchReused": false,
  "branching": {
    "strategy": "gitflow",
    "source": "config",
    "featurePrefix": "feature/",
    "featureBranch": "feature/00040-example",
    "workBranch": "develop",
    "integrationBranch": "develop",
    "updateWorkBranch": true,
    "syncWorkBranchAfterMerge": true,
    "pushSyncedWorkBranch": false
  },
  "branchingSync": null,
  "score": 9,
  "scoreIteration": 1,
  "reviewIteration": 1,
  "dagTasks": [],
  "steps": {
    "1": { "name": "derivation", "status": "completed", "output": {} },
    "2": { "name": "grilling", "status": "completed", "output": {} },
    "3": { "name": "dag_generation", "status": "completed", "output": {} },
    "4": {
      "name": "implementation",
      "status": "completed",
      "output": {},
      "dispatch": { "activeTaskId": null, "sequence": 2, "dispatchedAt": null, "baseline": { "dirty": [], "hashes": {} }, "abandonments": [] },
      "tasks": {
        "task-1": { "status": "completed", "filesChanged": ["src/a.ts"], "acIds": ["AC1"], "summary": "...", "commitSha": "9f2c41...", "checkpointTag": "sdw-checkpoint-run-1729300000-feature-task-1" }
      },
      "gates": { "build": { "status": "passed", "exitCode": 0 }, "test": { "status": "passed", "exitCode": 0 } }
    },
    "5": { "name": "scoring", "status": "completed", "output": {} },
    "6": { "name": "delivery_commit", "status": "completed", "output": {} },
    "7": { "name": "code_review", "status": "completed", "output": {} },
    "8": { "name": "pr_preparation", "status": "completed", "output": {} }
  },
  "errors": []
}
```

## 2. 8-Step State Machine

1. **Derivation:** Identifies whether the spec is already agent-ready (EARS ACs, DoR, YAML frontmatter). Skips derivation if ready; otherwise reformulates human stories.
2. **Grilling:** Walks the decision tree covering input bounds, failure scenarios, and concurrency. Auto-resolves known gaps or prompts user via `ask_question` with recommended defaults.
3. **DAG Generation:** Analyzes complexity (file count, touchpoints) and decomposes requirements into 1 or more atomic tasks.
4. **Implementation Dispatch:** Sequentially dispatches one DAG task at a time to a single worker, with a complete brief (criteria, scope fence, prohibitions, evidence contract) instead of the orchestrator's transcript. Every accepted task is checkpointed immediately: one scoped commit of its `filesChanged` plus the tag `sdw-checkpoint-{runId}-{taskId}`.
5. **Conformance Scoring:** An LLM judge fences the criteria plus the generated diff, emits a 0-10 score with per-criterion verdicts. If the score is below threshold (default 8/10), feedback triggers the re-implementation loop.
6. **Delivery Commit:** Creates an atomic, structured git commit for verified code. It remains the delivery commit after the per-task checkpoints and aggregates whatever they did not already commit.
7. **Delegated Code Review via sdw-code-review:** Dispatches subagent or CLI runner for `sdw-code-review`; inspects the generated JSON report (`passed`, `errorCount`, `warningCount`, `suggestionCount`, `findings`) to advance to Step 8, iterate surgical fixes (up to 3 attempts with security gate and scoped fix commits), or pause on residual blocking findings. `sdw-code-review` is the sole review authority.
8. **PR Preparation, Delivery & Code Review Convergence:** Assembles pull request metadata, marks the spec completed, pushes the active branch to remote origin (when `--push` or `pushDelivery` enabled), opens or reuses the pull request via the SCM provider contract, and executes the post-delivery review convergence loop (monitoring CI checks and automated code reviews to fix comments until green).

## 3. Batch Execution Lives in sdw-batch

`sdw-run` executes exactly one specification per run. Specification queues are owned by [`sdw-batch`](../../sdw-batch/SKILL.md), which creates `.sdw/state/batch-{batchId}.json`, invokes `sdw-run run <spec>` for each item, waits for the exit code, and advances. Manifest schema, pause/resume continuity, and failure policy: [`sdw-batch/references/batch_protocol.md`](../../sdw-batch/references/batch_protocol.md).

## 4. Branch & Worktree Strategy Protocol

Configurable feature branch activation and per-task isolated git worktrees:

### Feature Branch Lifecycle (`useFeatureBranches: true`)
- **Activation:** No working-tree cleanliness gate. Execution proceeds independently of git state; dirty trees never block, refuse, or halt a run.
- **Naming:** `branching.featurePrefix` + `specSlug` (default `feature/<specSlug>`).
- **Start Lane:** From `branching.workBranch` when it is a non-empty branch distinct from `branching.integrationBranch`; a null work lane, or one equal to the integration lane, starts from the checked-out branch (trunk behavior). With `branching.updateWorkBranch`, the work lane is fetched and fast-forwarded first.
- **Switch/Reuse:** If the feature branch already exists, switches to it and marks `branchReused: true`. Otherwise, creates and switches to it from the start lane. Resuming on the feature branch reuses it in place without checkout, fetch, or fast-forward.
- **Metadata:** Records `branch`, `baseBranch`, `branchReused`, and `branching` (strategy, source, prefix, feature branch, lanes, flags) in state. The Step 8 PR payload includes `head: branch` and `base` resolved by `sdw-ship-pr` from `branching.integrationBranch` (falling back to the detected base branch).
- **Configuration:** Presets (`trunk`, `github`, `develop`, `gitflow`, `gitlab`) and explicit overrides are documented in [`sdw-config/references/config_spec.md`](../../sdw-config/references/config_spec.md).

### Per-Task Worktree Lifecycle (`useWorktrees: true`)
- **Preconditions:** Verifies git availability, repository initialization, and writability of `.sdw/worktrees/`.
- **Trivial Skip Rule:** If DAG tasks count === 1 and complexity is `low` or `simple`, skips worktree creation (`reason: "single low-complexity task"`).
- **Creation:** For each DAG task, creates an exclusive worktree:
  `git worktree add .sdw/worktrees/{runId}/{taskId} -b task/{runId}/{taskId} HEAD`
- **Execution & Integration:** Subagent implements in the worktree. Changes are committed inside the worktree (`task({specSlug}): {taskId}`) and integrated into the primary working tree via `git cherry-pick <commitSha>`. The integration commit is tagged `sdw-checkpoint-{runId}-{taskId}`; no second checkpoint commit is created.
- **Conflict Handling:** Cherry-pick conflicts halt execution with exit code 1; the conflicted worktree is preserved for operator inspection.
- **Clean Removal:** Once integrated, removes worktree via `git worktree remove` and deletes task branch via `git branch -d`.
- **Overrides:** `--no-worktrees` and `--no-feature-branch` flags override configuration for the current run.

## 5. Step Artifacts Persistence Protocol

Intermediate outputs of human-auditable steps (2, 3, 5) are persisted as human-readable Markdown files:

### Directory Layout & Filename Convention
- **Directory:** `{stateDir}/{slug}/{runId}/` (e.g. `.sdw/state/00014-sdw-run-step-artifacts-persistence/run-1792400000000-00014-sdw-run-step-artifacts-pe/`)
- **Naming:** `{slug}-step-{N}.md` (e.g. `00014-sdw-run-step-artifacts-persistence-step-2.md`, `...-step-3.md`, `...-step-5.md`)
- **State Linkage:** Run state records `state.artifactsDir` and `state.steps[N].artifact` with forward slashes relative to project root.

### Scope & In-Scope Steps
- **Step 2 (Refinement):** `{slug}-step-2.md` contains metadata header, `## Decision Gaps & Resolutions` table, `## Decision Tree Walk` summary, and `## Refined Spec Snapshot`.
- **Step 3 (DAG Generation):** `{slug}-step-3.md` contains metadata header, `## Complexity Analysis`, `## Task Decomposition` table, and `## Task Context Prompts` blocks.
- **Step 5 (Conformance Scoring):** `{slug}-step-5.md` contains metadata header, `## Implementation Summary`, `## Conformance Score` evaluation, `## Verified Acceptance Criteria`, `## Failing Acceptance Criteria`, and `## Feedback`.
- **Step 7 (Delegated Code Review):** `{slug}-step-7.md` is the `sdw-code-review` Markdown fix-plan report (header, findings table, detailed findings, fix plan) written via `--report`.
- **Excluded Steps:** Steps 1, 4, 6, and 8 do not emit step artifacts.

### Resumption & Overwrite Policy
- **Resumed Runs:** Reuses the existing `artifactsDir` from run state.
- **Step Re-execution:** Rewrites the existing step artifact deterministically within the same run.
- **Failure Policy:** Persistence is best-effort. Failures log a warning, record an error prefixed `Artifact persistence warning:` in `state.errors`, and continue workflow execution without changing run status.

## 6. Sequential Subagent Dispatch & Evidence Gate (Spec 028, supersedes Spec 015 handoff)

Step 4 turns each DAG task into a dispatched worker. Exactly one task is in flight at a time; the CLI is the sequencer and never spawns agents itself.

### Modes of Execution
- **Subagent Mode (`implementation.mode: "subagent"`, Default):**
  - `task next` renders `task-{taskId}.prompt.md`, records the dispatch, and returns one envelope.
  - Step 4 sets the run to `paused`, Step 4 to `awaiting_implementation`, and exits with code `4` (normal pause, not an error).
  - The host agent spawns exactly one worker for the envelope, waits for it, and submits `task finish`.
  - `task abandon --reason` releases a lost worker's task back to `pending`.
- **Command Mode (`implementation.mode: "command"`):**
  - Executes configured subprocess `implementation.command` sequentially in topological DAG order.
  - Substitutes tokens: `{taskId}`, `{promptFile}`, `{evidenceFile}`, `{workingDir}`, `{targetRoot}`, `{cwd}`, `{slug}`.
  - Sanitizes environment using allowlist (`PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP`, etc.) and injects `SDW_*` variables.
  - Corroborates task changes and evidence on zero exit status; creates no dispatch state.

### Target-File Resolution (Step 3)
- Resolution order: the Step 2 blueprint `targetFiles`, an explicit `targetFiles` option, the paths the specification names in backticks plus its `New files` declaration, then a known real-file bucket named by the skill it describes (`run`, `config`, `router`, `spec`).
- A bucket is accepted only when every file it names exists in the target repository. A missing bucket file refuses the plan: `DAG plan refused (missing-target-file)` names the rule and the missing paths, Step 3 records `failed`, and no task is dispatched.
- No target path is ever synthesized from the slug. A specification that names no path and declares no new file plans no file fence and records the warning instead.

### Dispatch Commands
- **Dispatch:** `node skills/sdw-run/scripts/sdw_run.cjs task next --run-id <runId> [--json]`
  - Rejects a second dispatch while one is in flight, naming the active task.
  - Rejects dispatch when every pending task is blocked, naming the missing dependency.
  - Reports exhaustion (and prints the `resume` command) once every task is `completed`.
- **Envelope:** `runId`, `specSlug`, `taskId`, `title`, `status`, `sequence`, `promptFile`, `promptBytes`, `evidenceFile`, `specPath`, `workingDir`, `acIds`, `dependencies`, `subagentBrief`, `finishCommand`.
- **Abandon:** `node skills/sdw-run/scripts/sdw_run.cjs task abandon --run-id <runId> --task <taskId> --reason "<why>"`
  - Returns the task to `pending`, appends to `steps["4"].dispatch.abandonments`, clears the active dispatch.

### Task Finish Subcommand
- **Command:** `node skills/sdw-run/scripts/sdw_run.cjs task finish --run-id <runId> --task <taskId> --evidence <evidencePath>`
- **Dispatch Gate:** Only the dispatched task may be finished; anything else is rejected with code 1 naming the active task.
- **Validation Rules:**
  - `taskId`: Must match target DAG task.
  - `status`: Required; `success`, `partial`, `failed`, or `blocked`. Only `success` is accepted.
  - `acIds`: Non-empty subset of specification ACs.
  - `filesChanged`: Non-empty array of project-relative paths (no absolute paths, no `..` traversal, no `.git/`), files must exist on disk or be git-tracked deletions.
  - `tests`: Optional or empty array `[]` for non-testable tasks (e.g. docs, configs).
  - `summary`: Non-empty string.
- **Change Corroboration:** Dispatch records a baseline of the already-dirty paths with a SHA-256 of each. In the primary tree, at least one `filesChanged` path must be dirty now and either clean at dispatch or with different content, so edits inherited from an earlier task never corroborate. Non-git workspaces fall back to existence. Empty worktrees in worktree mode are rejected with code 1.
- **DAG Dependency Gate:** Rejects completion if upstream DAG dependencies are not yet completed.

### Per-Task Checkpoint Save
- After acceptance, the orchestrator immediately saves the task in the primary tree instead of waiting for Step 6: one scoped commit of the corroborated `filesChanged`, message `task({specSlug}): {taskId}`.
- Scope is the Step 6 set: the same `isScopedExcluded` rules apply, so `.sdw/state/`, `.sdw/worktrees/`, `.sdw/sandbox/`, `.git/`, absolute paths, and `..` traversal are never committed. Unrelated dirty files stay uncommitted.
- The commit is tagged `sdw-checkpoint-{runId}-{taskId}` (`git tag -f`). The tag is the crash and reset recovery pointer: `git show <tag>:<path>` recovers accepted file content, and `git tag --list "sdw-checkpoint-*"` matches completed tasks in state.
- `steps[4].tasks[taskId]` records `commitSha` and `checkpointTag`. A task that accepted no file change (second-pass no-change) records `HEAD` and gets no tag.
- Worktree mode tags the cherry-picked integration commit (`HEAD` after integration) rather than creating a second commit, so the tag points into the accepted primary-branch history instead of the pre-integration worktree SHA; that worktree SHA stays recorded under `state.worktrees`.
- **Second pass excluded:** `--second-pass` runs keep a single `refine({slug}): second pass refinement` Step 6 commit, so `deliveryCommitCreated` still describes the refinement save.
- **Opt out:** `--no-task-checkpoint` skips the checkpoint commit and tag; the Step 6 delivery commit then remains the only save and `commitSha` records `HEAD` at acceptance.
- **Fail closed on the commit, warn on the tag:** a git failure creating the checkpoint commit rejects the task (`task finish` exits `1` with the git error) and leaves it dispatched for retry, because the work is still uncommitted and a retry can corroborate it. Once the commit exists (or, in worktree mode, the cherry-pick landed), committed work can never be re-corroborated, so a tag that cannot be written only warns: the task is accepted with its commit SHA recorded and `checkpointTag: null`.
- **Security gate first:** the same pre-commit secret scan as Step 6 runs before worktree integration and before the checkpoint commit when `securityChecksEnabled` is on (and `--skip-security` is absent), scanning the task worktree when worktrees are in use and the primary tree otherwise. A finding rejects the task with the scanner's exit code, creates no commit, cherry-pick, or tag, records `steps[4].securityGate`, and leaves the task dispatched so the worker can remove the secret.
- Worker prompts still forbid git mutation: the orchestrator owns this save, as it owns Step 6.

### Dispatch Prompt Contract
Sections in order: `## Task Context`, `## Description`, `## Assigned Acceptance Criteria`, `## Remaining Acceptance Criteria (do not regress)`, `## Target Files`, `## Scope Fence`, `## Dependency Context`, `## Prior Partial Progress`, `## Implementation Rules (sdw-rules)`, `## Test Discipline`, `## Prohibited Actions`, `## Evidence Schema`, `## Report Contract`, `## Finish Command`. Dependency context and prior progress are omitted when empty.

Every prompt opens its rules section by requiring the worker to load the shared `sdw-rules` skill (installed under `.agents/skills/sdw-rules/` or `skills/sdw-rules/`); the bullets that follow are a summary, never a replacement.

Prohibitions carried by every prompt: no `git commit`/`push`/`branch`/`checkout`/`worktree`/`tag`; no subagent spawning; no edits outside the scope fence; no edits to run state, prompt files, or the specification; no unexecuted test claims; no `status: "success"` while a criterion is unmet.

### Sequential Worktree Integration
- Task worktrees are created in `command` mode only; subagent mode records `worktreeSkipReason` and uses the primary tree.
- In worktree mode, task worktrees branch sequentially from latest primary tree `HEAD`.
- Task changes are committed inside the worktree (`task({specSlug}): {taskId}`).
- The commit is cherry-picked into the primary tree.
- On success, the worktree and branch are removed (`git worktree remove` and `git branch -D`).
- On conflict, execution halts with code 1 and preserves the worktree for inspection.

### Build & Test Verification Gates
- **Focused first, full last:** while iterating, a worker runs only the focused check for the files it touched (the covering test file, a single case, or `node --check` for syntax); it escalates to the full suite only for shared helpers, multi-task areas, or gate fixes outside task scope, recording the run and reason in evidence `tests`, and it runs the full suite once before reporting. The orchestrator runs the full suite once at the gates below.
- Once all DAG tasks complete, verification gates execute:
  - `verification.buildCommand` (default `npm run build`), enabled by `requiredBuild`.
  - `verification.testCommand` (default `npm test`), enabled by `runAllTests`.
- Supports automated surgical fix loop (up to 3 attempts) with pre-commit secret leak scan.
- Gate failures halt execution and record failed gate status in `state.steps[4].gates`.

### LLM-Judge Conformance Scoring (Step 5, Spec 027)
- The static evidence-count formula is gone. Scoring is delegated to an LLM judge invoked with a fenced context: the acceptance criteria plus the generated diff, never transcripts.
- **Judge resolution:** `scoring.judgeCommand` when configured (env `SDW_JUDGE_COMMAND` as fallback); otherwise the current agent model instance judges and submits.
- **Agent path:** Step 5 writes `step-5-judge.prompt.md`, sets `awaiting_judgment`, and exits with code `5`. The host judge writes `step-5-judge.verdict.json` and runs:
  `node skills/sdw-run/scripts/sdw_run.cjs score submit --run-id <runId> --verdict <path>`
- **Verdict contract:** integer `score` 0–10 plus a `verdicts` array covering every criterion exactly once with `verified`/`failed` and non-empty `evidence`. The score is derived from the per-criterion verdicts (`round(verified / total * 10)`); a divergent reported score is recorded as `judge.scoreMismatch`.
- **Criticity:** `scoring.judgeCriticity` = `permissive` | `strict` | `perfectionist` (default `strict`), quoted in the judge prompt with its rubric.
- **Fail closed:** 0 criteria scores 0/10 without invoking the judge; an unavailable judge command, a missing verdict file, or a malformed verdict scores 0/10 with an actionable error and exit code 2.
- Diff context is capped at 120000 bytes with an explicit truncation marker.


### Delivery Commit Guard (Step 6)
- Delivery commit is refused if Step 4 is not `completed`, any DAG task is unaccepted, or any verification gate is not `passed`.
- **Scoped commits only:** never run `git add -A`. Stage exactly the tracked spec files: accepted evidence `filesChanged` plus `index.specs.md`. Unrelated worktree changes are left uncommitted.
- Per-task checkpoint commits already cover accepted `filesChanged`, so Step 6 commits only what remains (for example a registry update) and records the current `HEAD` when nothing is left; the delivery state stays authoritative.
- Fixer, pre-PR, and review-fix commits stage only their own delta (`diffSinceSnapshot`) or fixer-touched files, never the whole tree.

## 7. PR Delivery & Review Convergence Delegation (Step 8)

Step 8 delegates all final PR verification gates, remote publishing, SCM submission, and post-PR review convergence to the dedicated `sdw-ship-pr` skill.

### Delegation Contract
- **Invocation:** Dispatches `sdw-ship-pr` via CLI or programmatic runner:
  `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs --run-id <runId> --spec <slug> --root <targetRoot> [options]`
- **Responsibilities Delegated to `sdw-ship-pr`:**
  - Evaluation of pre-PR instructions and lifecycle commands (`prePrCommand`, `prePrInstructions`).
  - Pre-PR build and test verification gates (`requiredBuild`, `runAllTests`).
  - Remote branch pushing (`pushDelivery` or `--push`).
  - Pull request creation and idempotent reuse across SCM providers (`github`, `ado`, `none`). The PR base is `branching.integrationBranch`; an explicit `--base` and the legacy fallbacks keep lower priority.
  - Post-PR review convergence loop, remote CI polling, cooperative defect class fixing, and thread resolution.
  - Opt-in merge after convergence (`--merge` / `--allow-merge`): one SCM merge command, fire and forget. The outcome is recorded in `steps[8].output.merge` and never changes the delivery result, because permissions, approvals, and branch rules are operator concerns.
  - Post-merge synchronization when the pull request reaches `MERGED` and `branching.syncWorkBranchAfterMerge` is `true`: switch to the work lane, fast-forward it to the integration lane, then push it when `branching.pushSyncedWorkBranch` is `true`. A dirty tree or a non-fast-forward leaves every local branch untouched and records `branchingSync.status: "blocked"` with the reason; the delivery still succeeds.
- **Orchestrator Lifecycle Finalization:**
  - Consumes structured JSON report from `sdw-ship-pr`.
  - Records delivery outcome (`pullRequest`, `shipStatus`, `pushedBranch`, `reviewConvergence`, `branchingSync`) into `.sdw/state/{runId}.state.json`.
  - Transitions specification status to `completed` in `.sdw/specs/index.specs.md`.

## 8. Delegated Code Review via sdw-code-review (Step 7)

Step 7 delegates all working-tree review execution to the standalone `sdw-code-review` skill. The orchestrator holds no duplicated review instructions.

### Delegation Contract
- **Invocation:** `node skills/sdw-code-review/scripts/sdw_code_review.cjs run --target <root> [--base <ref>] --report <artifactsDir>/<slug>-step-7.md [--fix] [--json]`
  (or inline in the host agent with the same CLI contract).
- **Base Resolution:** Explicit `--base` (run `baseCommit`) when available; otherwise `sdw-code-review` resolves `branching.integrationBranch` first, then auto-detects via config `baseBranch`, tracking remotes, local branches, merge-base, or initial commit.
- **Report Consumption:** Parses JSON (`passed`, `errorCount`/`criticalCount`, `warningCount`, `suggestionCount`, `blockingCount`, `findings` with `id`, `severity`, `path`, `rule`, `fix`, `status`).
- **Fix Iteration:** While blocking findings remain and fixable findings exist (up to 3 iterations): run with `--fix`, gate via `sdw-security-checks`, commit only fixer-touched files (`fix(<slug>): apply automated review fixes (iteration N)`), re-verify without `--fix`.
- **Outcome:** `passed` advances to Step 8; residual blocking records `review_failed` and halts; artifact path recorded in `state.steps[7].artifact`.

## 9. Second Pass / Refinement Mode (`--second-pass`, alias `--refine`)

Re-executes an already delivered specification in refinement mode instead of implementing it again.

- **Eligibility:** the registry must record the slug as `completed`/`archived`, or a completed run must carry a `deliveryCommit`. Otherwise the run refuses with exit `1` and writes no state.
- **Mode persistence:** `state.refineMode = true`, so `resume` continues as a second pass; `state.deliveryCommitCreated` records whether the pass produced a commit.
- **Steps 2-3:** decision-gap grilling and complexity DAG generation are replaced by one `task-refine` task whose `coveredAcs` are the specification's criteria, treated as the gap checklist and as must-keep-holding constraints.
- **Step 4:** the dispatch prompt gains a `## Second Pass (Refinement) Mode` section: audit each criterion against the delivered code and tests, implement what is missing, partial, or drifted (including stale docs, config, schema, and tests), then simplify inside the same specification scope. Empty change is allowed only when every criterion already holds and no drift remains; the summary must list gaps, drift, and opportunities considered. `task finish` accepts `filesChanged: []` in this mode.
- **Gap closure:** a second pass is not simplification-only. A delivered feature that does not fully satisfy its specification is repaired here, without adding behavior the specification does not require.
- **No change:** Steps 5-8 are marked `skipped`, the report is written, `status: completed`, exit `0`, and `options._runResult.refineOutcome = "no-change"`.
- **Changed:** Step 5 scoring and Step 7 review run normally against `state.baseCommit` (the prior delivery commit when discoverable, so the judge sees the delivered implementation, not only the delta). Step 6 commits as `refine({slug}): second pass refinement`, never rewrites `index.specs.md`, and Step 8 runs only when `state.deliveryCommitCreated === true`.
- **Report:** `{slug}-refine.md` in the run artifacts directory, always written, with outcome, base commit, files changed, score, summary, and criteria. Path stored in `state.refineReport`.
- **Boundary:** `sdw-batch` never refines; it skips delivered specs and requires a manual single-spec call for a second pass.

## 10. Dry Run & Sandbox Isolation (Spec 029)

`--dry-run` and `--sandbox` answer two different questions and are mutually exclusive.

### Plan-Only Dry Run (`--dry-run`)
- `run <specPath> --dry-run` validates the specification in authoring mode and prints the plan: spec path and slug, target root, scoring/delivery/branch settings, the resolved branch plan, the eight step names, and `No steps executed (--dry-run).`
- The branch plan prints `Strategy: <preset>`, `Start lane: <branch> (update: yes|no)`, `Feature branch: <prefix><slug>`, `Pull request target: <integration branch>`, and `After merge: <actions>`, all resolved from configuration without executing git commands.
- It creates no run state, no artifacts, no branches, no worktrees, and no clones. Exit code `0` when the spec validates, `1` when it does not.

### Sandbox Execution (`--sandbox`)
- **Layout:** `{sandboxDir}/{runId}/repo` (clone), `sandbox.json` (metadata), `report.md` (report). `sandboxDir` comes from `.sdw/config.json` (default `{projectRoot}/.sdw/sandbox`, tokens `{projectRoot}`, `{skillsRoot}`, `{temp}`); a custom value must resolve outside the project root and is validated by `sdw-config check`. The clone contains `.sdw/sandbox/.sandbox-marker.json` pointing back to the source root.
- **Creation:** `git clone --no-local --depth 1 --single-branch --branch <sourceBranch> <sourceRoot> <clone>` from committed `HEAD`, `git switch -c sdw-sandbox/{runId}`, `git remote remove origin`, then an optional `node_modules` junction and a copy of the target specification when it is not committed (`specCopied: true`). `--no-local` is required because git ignores `--depth` for local clones; a shallow single-branch clone is enough because the sandbox only walks forward from `HEAD`. Detached `HEAD` clones without `--branch`, and a mismatch falls back to a full local clone checked out at the exact commit (`clone.fallback: true`).
- **Execution:** every step runs with the clone as project root. Run state and artifacts live in the clone, so the source `.sdw/state` is untouched and `status`/`resume` on the source never see sandbox runs.
- **Delivery isolation:** `pushDelivery` and `scmProvider` are forced off in memory, Step 8 invokes `sdw-ship-pr --dry-run` without `--push`, and the removed `origin` blocks accidental pushes. Real verification comes from the Step 4 gates; `sdw-ship-pr` simulates its own pre-PR command/build/test gates under `--dry-run`.
- **Dirty source:** the clone is cut from the commit, so uncommitted work is excluded; the CLI warns and records `baselineDirty: true`.
- **Paths:** dispatch envelopes and task prompts print absolute sandbox paths, the working directory is the clone root, and `task finish` / `resume` commands carry `--root <clonePath>`.
- **Lifecycle:** `sandbox list`, `sandbox report --run-id`, `sandbox clean --run-id`. The report is refreshed after `run`, `resume`, and `task finish`; cleanup is always proposed, never automatic, and keeps `sandbox.json` plus `report.md`. Creation halts when the resolved target directory already exists, naming the `sandbox clean --run-id` command; `sandbox clean` also removes an orphaned target left by an interrupted creation (no metadata).
- **Limits:** a clone is a filesystem and git boundary, not a security sandbox. Worker commands still run with the host credentials and network.



