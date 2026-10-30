# SDW Router Dispatch Table & Routing Rules

This document details the intent classification matrix, resolution precedence, and ambiguity handling used by `sdw-router`.

## 1. Resolution Precedence

When evaluating a user turn, the router applies four strict precedence tiers:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Explicit Invocation (/sdw-*, @sdw-*, exact skill name)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if not explicit)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. High-Confidence Keyword & Semantic Intent Match          │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if tied confidence)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. User Clarification Gate (Options + Recommended Default)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (if no match)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Passive Non-Interference Pass-Through                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Intent Dispatch Matrix

### Skill: `sdw-config`
- **Domain**: Workspace initialization, environment verification, and configuration parsing.
- **Explicit Invocations**: `/sdw-config`, `@sdw-config`, `sdw-config`
- **Trigger Keywords**:
  - `config`, `configuration`, `initialize workspace`, `init sdw`, `check config`
  - `parse config`, `environment verification`, `config.json`, `directory-structure.md`
  - `sdw settings`, `verify environment`, `setup sdw`
- **Typical Prompts**:
  - "Check the .sdw workspace configuration"
  - "Initialize SDW in this repository"
  - "Parse config.json to resolve directory tokens"

### Skill: `sdw-doctor`
- **Domain**: Installation and workspace health: skill folders, references, scripts, config keys, registry rows, and specs across upstream, local, global, and hybrid modes.
- **Explicit Invocations**: `/sdw-doctor`, `@sdw-doctor`, `sdw-doctor`
- **Trigger Keywords**:
  - `installation health`, `install check`, `workspace health`, `doctor`
  - `missing skill`, `skill not found`, `hybrid install`, `global install check`
  - `npx reinstall`, `broken install`, `check skills`
- **Typical Prompts**:
  - "Check whether the SDW installation is complete"
  - "Why is sdw-run missing from my global install?"
  - "Verify the workspace configuration and specs before running"

### Skill: `sdw-spec`
- **Domain**: Specification lifecycle, authoring, round-based grilling, EARS validation, header status, index synchronization, and archiving.
- **Explicit Invocations**: `/sdw-spec`, `@sdw-spec`, `sdw-spec`
- **Trigger Keywords**:
  - `spec`, `specification`, `author spec`, `new spec`, `format spec`
  - `ears syntax`, `validate spec`, `list specs`, `sync specs`, `import spec`
  - `archive spec`, `index.specs.md`, `prd index`, `spec lifecycle`
  - `grill spec`, `grill me`, `refine spec`, `spec status`, `awaiting-approval`
- **Typical Prompts**:
  - "Draft a new feature specification for user authentication"
  - "Validate our specs against the EARS acceptance criteria format"
  - "Grill this spec until no assumption is left unstated"
  - "Move spec 031 to awaiting-approval"
  - "Sync index.specs.md with active on-disk specifications"
  - "Archive completed specification 001"

### Skill: `sdw-run`
- **Domain**: End-to-end specification implementation, subagent DAG orchestration, conformance scoring, code review, and delivery push.
- **Explicit Invocations**: `/sdw-run`, `@sdw-run`, `sdw-run`
- **Trigger Keywords**:
  - `orchestrate`, `orchestrator`, `implement spec`, `run spec`, `execute spec`, `workflow execution`
  - `resume run`, `sdw-run status`, `dag tasks`, `conformance score`, `delivery commit`
  - `automated code review`, `review loop`, `remote push`, `pr preparation`
- **Typical Prompts**:
  - "Start workflow to implement spec 00003-sdw-router-skill"
  - "Resume interrupted run run-1792396125490"
  - "Check status of the current orchestrator execution"

### Skill: `sdw-batch`
- **Domain**: Queue multiple specifications and run each one through the full `sdw-run` single-spec pipeline in sequence.
- **Explicit Invocations**: `/sdw-batch`, `@sdw-batch`, `sdw-batch`, `/batch`, `@batch`, `batch`
- **Trigger Keywords**:
  - `multiple specs`, `spec queue`, `implement all specs`, `batch`, `queue specs`, `run specs in sequence`
  - `resume batch`, `batch status`
- **Typical Prompts**:
  - "Implement specs 00036, 00037 and 00038 in sequence"
  - "Resume the paused spec queue"
  - "Batch these specifications to delivery"

### Skill: `sdw-ship-pr`
- **Domain**: Pull request preparation, pre-PR requirement checks, remote branch publishing, SCM PR creation/reuse, and automated review convergence.
- **Explicit Invocations**: `/sdw-ship-pr`, `@sdw-ship-pr`, `sdw-ship-pr`, `/ship-pr`, `@ship-pr`, `ship-pr`
- **Trigger Keywords**:
  - `ship pr`, `ship-pr`, `create pr`, `open pr`, `submit pr`, `deliver pr`
  - `pre-pr`, `poll pr`, `resolve review`, `resolve thread`, `review convergence`, `converge`
- **Typical Prompts**:
  - "Check pre-PR requirements and ship a pull request for develop"
  - "Open a PR on GitHub and resolve reviewer comments"
  - "Run PR review convergence loop on PR #3"

### Skill: `sdw-memory`
- **Domain**: Central product knowledge — query, record, consolidate, and classify traps, gaps, patterns, and errors across pluggable store backends.
- **Explicit Invocations**: `/sdw-memory`, `@sdw-memory`, `sdw-memory`
- **Trigger Keywords**:
  - `memory`, `trap`, `knowledge base`, `project memory`, `record trap`
  - `query memory`, `consolidate memory`, `shareable knowledge`, `gap`, `pattern`
- **Typical Prompts**:
  - "Query memory for known traps before implementing"
  - "Record this fix as a trap in sdw-memory"
  - "Consolidate duplicate memory entries"

### Skill: `sdw-code-review`
- **Domain**: Standalone deep working-tree code review, actionable fix planning, and orchestrator Step 7 delegation.
- **Explicit Invocations**: `/sdw-code-review`, `@sdw-code-review`, `sdw-code-review`, `/code-review`, `@code-review`, `code-review`
- **Trigger Keywords**:
  - `code review`, `code-review`, `review code`, `deep review`, `sdw-code-review`
  - `review findings`, `fix review`, `review fix plan`, `run review`, `blocking findings`, `code review report`
- **Typical Prompts**:
  - "Run a deep code review on current working tree changes"
  - "Review code changes against the base branch and plan fixes"
  - "Check review findings and apply surgical fixes"

---

## 3. Disambiguation on Tied Confidence

When a user prompt exhibits equal confidence across multiple candidate skills (e.g. asking to "review the spec implementation requirements"), the router stops and queries the user for clarification with an explicit recommendation.

- **Host Question Integration**: Uses host-specific question mechanisms (such as `ask_question` in Antigravity/Gemini or an interactive chat prompt in CLI/Cursor).
- **Format**:
  - Candidate options formatted as selectable responses.
  - Recommended default marked with `(Recommended)`.
- **Example Prompt**:
  - Question: "Did you want to manage the specification or orchestrate its implementation?"
  - Options:
    1. "(Recommended) Implement and orchestrate the spec using sdw-run"
    2. "Author or validate the specification using sdw-spec"

---

## 4. Passive Non-Interference (Pass-Through)

The router is designed to be completely unobtrusive:
- When a prompt is unrelated to SDW workflows (e.g., "Fix CSS padding in navbar", "Refactor calculateTotal function", "Write a python script to process CSV"), the router returns `{ matched: false, passThrough: true }`.
- Execution proceeds to the host agent's standard code editing and reasoning capabilities without interception.

---

## 5. Missing Skill Directory Handling

If an intent matches a skill whose directory does not exist or is unreadable on disk:
- The router fails closed with an actionable error.
- Example message: `[sdw-router] Error: Routed skill "sdw-run" directory not found at "skills/sdw-run", ".agents/skills/sdw-run", or "$HOME/.agents/skills/sdw-run". Run packaging installer to restore skills.`
