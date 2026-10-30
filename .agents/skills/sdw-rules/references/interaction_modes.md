# Interaction Modes & Planning Protocol

Product-wide rules for deciding **when an agent may act** and **how it asks for permission**. This file is referenced by `sdw-rules/SKILL.md`; a repository harness may load it directly.

The protocol must be understandable by the least capable model in the least capable harness. It relies on plain language, numbered options, and file/CLI evidence — never on a specific vendor tool.

---

## 1. The two failure modes this prevents

| Failure | Symptom | Rule |
|---|---|---|
| **Acting without authorization** | The user asked for an opinion or a spec, and the agent edited files, deleted content, or opened a PR. | Plan and confirm before any unsolicited change. |
| **Asking when the order is explicit** | The user said "do X" and the agent answers with a questionnaire. | Execute clear, explicit, non-destructive instructions directly. |

---

## 2. Mode selection (choose one, in order)

| # | Situation | Default behavior |
|---|---|---|
| 1 | **Read-only inquiry** — question, analysis, opinion, review, explanation, investigation | Read/search freely; **no confirmation**; write nothing. |
| 2 | **Explicit, clear, non-destructive action** — imperative order naming the target and the change | Execute. No plan prompt. |
| 3 | **Destructive or irreversible action** — delete, move, overwrite, bulk edit, publish, force-push, reset | **Confirm first**, unless the user explicitly ordered that exact action. |
| 4 | **Ambiguous, underspecified, or opinion request** — "can you improve…", "what about…", "make it better" | Investigate read-only → present a plan → **wait for explicit confirmation** → execute. |
| 5 | **Invoked skill or command with a clear contract** — `/sdw-spec new`, `sdw-run run`, a documented CLI | Follow the skill's own instructions **unattended**. Do not re-ask what the skill already defines. Stop only on an uncovered destructive step or a decision gap the skill does not resolve. |

If two rows apply, the safer row wins: destructive + explicit → confirm; ambiguous + non-destructive → plan.

---

## 3. Planning loop (rows 4 and 3 of the table)

1. **Investigate first, read-only.** Read files, run searches, inspect git state. Change nothing.
2. **Frame the problem.** State what you found and the constraint that makes it a decision.
3. **Present 2–3 options**, each with its tradeoff (speed, risk, scope, reversibility, maintenance). Not more; not a lecture.
4. **Recommend one option** and say why in one sentence.
5. **Ask for confirmation** using `ask_question` when the harness provides it; otherwise a numbered list in chat.
6. **Execute only the confirmed option.** If the user changes scope, return to step 1 and re-plan; approval does not transfer to a different plan.

### Plan format (keep it under ~15 lines)

```
Goal: <one sentence>
Options:
  A) <name> — <tradeoff>
  B) <name> — <tradeoff>
Recommendation: A, because <reason>
Steps: 1) ... 2) ... (files: <paths>)
Validation: <command or check>
Not doing: <explicit non-goals>
Confirm: A, B, or something else?
```

No plan is needed for a confirmed read-only answer; the answer itself is the deliverable.

---

## 4. What counts as confirmation

- **Yes:** an explicit affirmative that selects an option — "yes", "go", "do A", "approved".
- **No / negotiate:** "not B", "do A but skip step 2", "wait" → narrow the scope and re-confirm.
- **Not confirmation:** silence, an emoji alone, "ok" after an unrelated message, a thumbs-up on a question that offered multiple options, or the user continuing to ask questions.
- **Expiration:** confirmation covers exactly the plan shown. Any new file, target, or destructive step requires a new confirmation.
- **Explicit order beats the plan:** if the user already said "delete X", do not ask again for X; confirm only the parts they did not state.

---

## 5. Read-only actions (no confirmation)

Allowed without asking because they do not mutate the project or external state:

- Reading, listing, searching, `git status`, `git diff`, `git log`, `git show`.
- Running validators, linters, and tests **that do not rewrite tracked files** (writes limited to temp/ignored paths are acceptable).
- Inspecting package metadata, configuration, and specs.

Not read-only: installs, migrations, formatters that rewrite files, generators that write into the repo, network writes, and anything that changes branches, tags, remotes, or published state.

---

## 6. Destructive actions (confirm unless explicitly ordered)

Deleting or moving files; overwriting existing content; `git reset --hard`, `git clean -fd`, force-push, branch/tag deletion; rewriting history; merging or closing PRs; publishing packages; installing/upgrading dependencies; bulk renames or reformats; changing configuration that affects other users; writing outside the workspace.

When in doubt, treat the action as destructive. The cost of one question is lower than the cost of an unwanted change.

---

## 7. Unattended workflows

Some skills are designed to run almost fully unattended (`sdw-run` runs, batch queues, `sdw-ship-pr` convergence, CI workflows).

- The **skill's instructions are the approved plan.** The user authorized the workflow by invoking it; do not re-ask at every step.
- The skill must state its own destructive gates (delivery commits, pushes, PR creation, merges). If it is silent and a step is destructive, **stop and ask**.
- Autonomy never widens scope: no extra files, features, refactors, or "improvements" beyond the skill's contract.
- If the skill reaches a genuine decision gap it does not define, pause and ask rather than inventing a default.

---

## 8. Asking well (harness-agnostic)

- One decision per question; mutually exclusive options; a recommended default first.
- Name the consequence of each option in one clause.
- Prefer concrete artifacts ("rename `--dry-run` to `--plan` in `sdw_run.cjs` and its help") over abstractions.
- If the host lacks a question tool, print numbered options and wait for the reply; never assume the answer.

---

## 9. Anti-patterns

- "It's small and safe" → still not authorized.
- "The spec exists / was approved" → a spec is a document, not an order.
- "The user probably wants…" → ask.
- "I'll do it and mention it afterwards" → no.
- A plan presented **after** the changes is not a plan; it is a report of unauthorized work.
- Re-asking what the user just ordered explicitly is friction, not caution.

---

## 10. Worked examples

**Ambiguous (plan + confirm).** User: "the dry-run feels wrong." → Investigate read-only, find that `--dry-run` executes the pipeline in one path. Plan: A) make it plan-only, B) add `--sandbox` for real isolated execution. Recommend A+B. Ask. Change nothing until approved.

**Explicit (execute).** User: "rename `--dry-run`'s help text to 'Print the execution plan'." → Edit that line, run the tests, report. No plan prompt.

**Destructive (confirm).** User: "clean up the state directory." → Ask which directory and whether ignored/untracked files should be removed; confirm the exact path before deleting.

**Unattended (execute per contract).** User: "ship the PR." → Follow `sdw-ship-pr`: gates, push, PR, convergence. Do not ask at each step; do ask before merging unless `--merge` was requested.
