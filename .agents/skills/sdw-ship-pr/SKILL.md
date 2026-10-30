---
name: sdw-ship-pr
description: Standalone PR shipping, pre-PR requirement checks, SCM PR creation/reuse, and review convergence.
version: 0.1.0
invocation_names:
  - sdw-ship-pr
  - ship-pr
  - sdw-ship-pr list-threads
  - sdw-ship-pr resolve-thread
  - sdw-ship-pr check-status
---

# sdw-ship-pr

> When this skill is loaded, output "sdw-ship-pr loaded."

Self-contained PR shipping manager for Spec-Driven Workflow (SDW). Orchestrates pre-PR requirement verification gates, remote branch publishing, pull request creation or reuse across configured SCM providers, and automated post-PR review convergence loops.

## Invocation

Standalone CLI:
```bash
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs [options]
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs list-threads --pr <number>
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs resolve-thread --pr <number> --thread <id> --comment "<text>"
node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs check-status --pr <number>
```

`list-threads` prints each thread's resolution status, identifier, `path:line`, and comment count, then every comment in full with its author and timestamp; the default fixer findings carry every comment body verbatim, in chronological order.

Parameters:
- `--run-id <id>`: Active orchestrator run identifier (validates run-state evidence; updates `.sdw/state/{runId}.state.json`).
- `--ack-prepare "<note>"`: Acknowledge discovered prepare obligations and record `prepareAck` in the report.
- `--spec <slug>`: Specification slug (derives default PR title/body).
- `--head <branch>`: PR source head branch (defaults to current active git branch).
- `--base <branch>`: PR target base branch (defaults to `.sdw/config.json` `baseBranch`, then `master`/`main`).
- `--title <string>`: Custom PR title.
- `--body <string>`: Custom PR description body.
- `--push`: Force push active branch to remote origin before PR creation. A dirty working tree is committed first (`chore(delivery): include pending working-tree changes`, override with `dirtyCommitMessage` in config) so the pushed branch carries the delivered work.
- `--poll-pr`: Enable post-PR review polling and convergence loop.
- `--merge` / `--allow-merge`: After review convergence, ask the SCM CLI to merge the pull request (`gh pr merge <n> --merge` or `az repos pr update --id <n> --status completed`). Fire and forget: the outcome is recorded but never fails the delivery, because permissions, pending approvals, and branch rules are outside this skill's contract. Default: off.
- `--max-iterations <n>`: Review convergence ceiling (default `3`).
- `--poll-interval <ms>`: Fallback wait between convergence rounds when native watch is unavailable (default `20000`).
- `--checks-start-timeout <ms>`: How long to wait for the provider to report the first check run after a push before falling back to watch/polling (default `30000`, `0` disables the wait).
- `--checks-start-interval <ms>`: Poll interval while waiting for the first check run (default `5000`).
- `--no-native-watch`: Disable the provider's native run watch (`gh run watch <run-id> --exit-status`) and always use interval polling.
- `--max-preemptions <n>`: Concurrent-push adaptation budget (default `3`).
- `--dry-run`: Simulate pre-PR checks, branch push, PR creation, and review polling without remote mutations or run-state writes.
- `--json`: Output structured JSON execution report.

Detailed protocol: [`references/ship_protocol.md`](references/ship_protocol.md).

## State Machine Steps

### Step 1: Preflight & Options Resolution
1. Read configuration from `.sdw/config.json` (`scmProvider`, `pushDelivery`, `scmCodeReviewEnabled`, `requiredBuild`, `runAllTests`, `prePrCommand`, `prePrInstructions`, `securityChecksEnabled`).
2. Resolve head branch (explicit `--head` or current `git rev-parse --abbrev-ref HEAD`) and base branch (explicit `--base`, config `baseBranch`, or detected repository default).
3. Verify SCM capability (`github` via `gh`, `ado` via `az`, or `none`).
- Done when: Head, base, SCM provider, and quality options resolved; working tree verified.

### Step 2: Pre-PR Verification Gates
1. If `prePrInstructions` is configured, print it; its text also joins the prepare-obligation discovery rows.
2. If `prePrCommand` is set, execute the command (e.g. custom linter or checklist). Halt if it fails.
3. If `requiredBuild: true`, execute `npm run build` or project build command. Halt if it fails.
4. If `runAllTests: true`, execute test suite. Halt if tests fail.
5. If `securityChecksEnabled: true`, inspect the worktree for secret leaks or sensitive patterns.
6. If `--run-id` is supplied, load `.sdw/state/{runId}.state.json`: require steps 4 and 6 `completed`, step 7 too when review runs (`scmCodeReviewEnabled`/`--poll-pr` with an SCM provider), and `score >= scoreMin` (default 8). Missing or unreadable state exits 1 before any push or PR.
7. Discover prepare obligations from repository prepare headings (`prepare`, `before push`, `before publish`, `before deliver`, `before delivery`, `before merge`) and `prePrInstructions`: `prePrDiscovery` `block` (default) refuses unacknowledged rows, `warn` prints and continues, `off` skips; `--ack-prepare "<note>"` records `prepareAck`.
8. Record one `prePrBoard` row per check (`prePrCommand`, `build`, `tests`, `security`, `runState`, `discovery`; `pass`/`fail`/`skipped` with evidence) and print the board as a Markdown table before the push. `--dry-run` reports without mutations.
- Done when: Every configured gate and run-state/discovery check is evaluated, the board is printed, and failures halt with exit code 1.

### Step 3: Dirty Worktree Selection and Remote Branch Push
When the working tree is dirty, the host agent (LLM) selects what belongs to this session before anything is staged. `sdw-ship-pr` never commits unrelated changes on its own.

1. Plan: `node skills/sdw-ship-pr/scripts/sdw_ship_pr.cjs dirty-plan --run-id <runId> [--json]`. It returns `candidates` (every dirty path), `runFiles` (paths recorded by this run's accepted tasks plus the spec), `suggested`, `excluded`, and the resolved `statePath`.
2. Analyze as the host agent: compare each candidate against this session's task evidence, prompts, dependencies, and artifacts. Approve only files this session produced or that its tasks depend on. Leave pre-existing or unrelated work-in-progress out.
3. Approve: write the approved project-relative paths as a JSON array to `.sdw/state/<runId>/dirty-files.json` (or pass a comma-separated `--dirty-files`).
4. Publish: `git status --porcelain -uall` candidates are filtered to the approved list, staged path by path (`git add -A -- <path>`), committed with a pathspec limited to those paths (`chore(delivery): include pending working-tree changes`, override with `dirtyCommitMessage`), and only then pushed. Files already staged outside the approved list stay staged and out of the delivery commit.
5. Without an approved list or run scope, the commit is skipped with a warning and the dirty files stay in place; a selected commit that fails aborts the run before any push, so the branch never publishes without the delivered work.
- Done when: Only approved session files are committed, unrelated dirty files remain untouched, and the branch is synchronized with origin or push is explicitly bypassed.

### Step 4: SCM Pull Request Creation / Reuse
1. When `scmProvider` is `none`: skip remote PR creation, log local delivery readiness, and return exit 0.
2. When `scmProvider` is `github` or `ado`:
   - Assemble PR title and body from specification or CLI parameters.
   - Query open PRs matching `<head>` into `<base>` using the unified SCM provider contract (`findActivePullRequest`).
   - If an open PR exists, reuse its number and URL. Complement the active PR: push commits to the PR branch and update the PR description with the amending delivery details (`### Amending Delivery: {specSlug}`).
   - While amending an active PR undergoing review/approval is not a recommended practice, adapt as a non-blocking operation: continue the delivery process without failing or blocking.
   - Otherwise, create a new pull request via `provider.createPullRequest({ title, body, head, base, dryRun })`.
- Done when: Pull request number and URL are captured or reused, description amended if reused, or SCM creation skipped cleanly.

### Step 5: Post-PR Review Convergence (Cooperative & Proactive Fix Cycle)
1. When `scmCodeReviewEnabled: true` or `--poll-pr` passed (and `scmProvider != "none"`):
   - **Wait for the pipeline to start:** A push or a fresh PR can stay queued before the provider creates any check run. Before each wait, poll `provider.checkPrStatus(prNumber)` until at least one check is reported, bounded by `--checks-start-timeout` (default 30s, `0` disables). A timeout warns and hands the wait to the native watch or the poll interval; it never fails the delivery.
   - **Wait for code-review & CI:** Await remote CI workflows and automated/agentic review runs (`provider.checkPrStatus` / `gh pr checks`) to finish.
   - Loop up to configured iteration ceiling (default 3 rounds):
     a. **Check active threads:** Call `provider.listReviewThreads(prNumber)`. If all checks pass and `activeCount === 0`, mark converged and exit loop.
     b. **Fetch it all:** If active threads exist, retrieve all open threads, file locations, line numbers, and every reviewer comment in full; the default fixer findings carry every comment body verbatim and in chronological order.
     c. **Cooperative & proactive fix:** Analyze feedback critically. Name the underlying defect class (e.g. unhandled error, type mismatch, missing validation). Proactively sweep sibling files and related PR modifications for the same pattern, fixing all occurrences rather than patching only the reported line. Apply minimal surgical fixes (`sdw-rules` simplicity first; no unrequested refactorings).
     d. **Verify:** Run test suite (`npm test`) and project build to ensure fixes pass cleanly without regressions.
     e. **Commit:** Stage only surgical fix paths and commit: `git commit -m "fix(review): address review feedback"`.
     f. **Push:** Push the commit to the remote tracking branch: `git push origin <head>`.
     g. **Close related threads with comment:** **Only after pushing**, call `provider.resolveReviewThread({ prNumber, threadId, comment })` for each addressed thread, posting an informative comment explaining the fix that was implemented (commit SHA, files modified, changes made, and why it resolves the issue).
2. If unresolved issues remain after maximum iterations, record review residual and report status. Never close a thread before pushing, and never close without an explanatory fix comment.
3. **Concurrent-push adaptation:** Cancelled/superseded CI checks (`cancelled`, `cancel`) are waited out, never treated as failures; terminal states (`timed_out`, `startup_failure`) stay on the fixer/blocker path. When a newer run replaces the observed one, the loop resets its round window (up to `--max-preemptions` times) and follows the latest status instead of halting.
- Done when: Active threads resolved with explanatory comments after push and CI checks green, or iteration ceiling reached with status recorded.

### Step 5b: Optional Merge (opt-in, fire and forget)
1. Apply only when `--merge` / `--allow-merge` is passed, the review converged, and a pull request exists.
2. Call `provider.mergePullRequest({ prNumber })` once and record `merge: { requested, attempted, ok, reason, error, durationMs }` in the report and in `steps[8].output.merge` when a run state is used.
3. Never throw, retry, or fail delivery on a merge error: missing permissions, pending approvals, or unmet branch rules are the operator's concern. Skip with a recorded reason when the merge cannot apply (dry-run, no PR, review did not converge, SCM provider disabled).
- Done when: The merge was attempted at most once and its outcome or skip reason is recorded.

### Step 6: Delivery Outcome & State Persistence
1. Record PR URL, PR number, ship status, and review convergence results.
2. If `--run-id` is provided, persist delivery metadata into `.sdw/state/{runId}.state.json` under `steps[8]`.
3. Output markdown summary or structured JSON.
- Done when: State file updated (if runId provided) and execution report emitted to stdout.

