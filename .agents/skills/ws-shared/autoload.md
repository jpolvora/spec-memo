# Autoload & progressive disclosure

**Audience: agents.** Load this file when the project root `AGENTS.md` references it, or whenever the user mentions specs / plans / Spec-to-PR / SCM intents / verify score without naming a skill.

Path tokens: expand via [`tools.md`](tools.md) before tool calls (`{skillsRoot}`, `{sharedDir}`, `{specsDir}`, `{plansDir}`).

---

## Always-applied skills

When root `AGENTS.md` points here, load each listed `SKILL.md` every prompt (unless the user opted out for that skill). Paths are project-local defaults; hybrid installs may resolve the same id under `{globalSkillsRoot}` when missing locally.

**Complement (not duplicated here):** `ws-karpathy-guidelines` stays in the shared-hub **Skill loading (mandatory)** table — it is intentionally **not** part of this Always-applied promotion set (`shared-autoload-md` non-goal). Root override that loads this table still keeps karpathy via `{sharedDir}/AGENTS.md` mandatory load.

| Skill | Path | Trigger |
|-------|------|---------|
| `ws-senior-developer` | `{skillsRoot}/ws-senior-developer/SKILL.md` | Every prompt — delivery gate / Code review proof |
| `ws-self-learning` | `{skillsRoot}/ws-self-learning/SKILL.md` | Every mutating task — MEMORY consult + trap write; after each `ws-goal-fix-pr` / `ws-fix-pr` round, record reviewer/CI mistakes |
| `ws-changelog` | `{skillsRoot}/ws-changelog/SKILL.md` | Every task completion — append-only history |
| `ws-fable-method` | `{skillsRoot}/ws-fable-method/SKILL.md` | Every prompt — structured investigate/act/verify when non-trivial |
| `ws-tdah` | `{skillsRoot}/ws-tdah/SKILL.md` | Every prompt — action-first shape + judgment |
| `ws-megabrain` | `{skillsRoot}/ws-megabrain/SKILL.md` | Every prompt — vibe-coding implementer (no spec required); defer when orch owns the session |
| `ws-memo` | `{skillsRoot}/ws-memo/SKILL.md` | Session start / working memory — off-repo vault memory via spec-memo MCP |
| `ws-session-tracking` | `{skillsRoot}/ws-session-tracking/SKILL.md` | Every session — prompt turns, task boundaries & deliverable tracking |
| `ws-spec-memo` | `{skillsRoot}/ws-spec-memo/SKILL.md` | Config preflight & bridge — wire config.json memory backends & hybrid fallback |

Precedence when both root and `{sharedDir}/AGENTS.md` load: root / this file win for **membership of the Always-applied set above**; shared-hub mandatory skills (including `ws-karpathy-guidelines`) still load. See [`AGENTS.md`](AGENTS.md) § Consumer root override.

### Precedence among Always-applied (highest first)

1. Explicit user instructions (current turn)
2. Design / spec / architecture constraints
3. `ws-karpathy-guidelines` (shared-hub mandatory; surgical scope — not listed in the table above)
4. `ws-senior-developer` (delivery gate + Code review proof; opt out `stop ws-senior-developer`)
5. `ws-fable-method` (investigate loop; **defer** when orch owns the session or senior already confirmed a plan — see fable Gates)
6. `ws-tdah` (reply shape; does not override senior proof depth)
7. `ws-megabrain` (vibe implementer; **consumes** fable — do not duplicate the loop; **defer** when orch owns the session; opt out `stop ws-megabrain`)
8. `ws-self-learning` / `ws-changelog` (completion gates: Learning then Changelog)

**Fable vs senior (single rule):** Orch or confirmed senior plan → no fable Plan-First / competing plan ceremony. Fable Verify does not replace senior Code review proof.

---

## Specs vocabulary (dictionary)

Use these terms exactly. Do not treat a **plan** as a **spec**.

| Term | Meaning |
|------|---------|
| **Spec** | Human-facing feature specification `*.spec.md` under `{specsDir}` (`config.json` → `plans.specsDir`, default `.agents/specs`) |
| **`{specsDir}`** | Specs root only — drafts, mirrors, `index.PRD`. Not workflow state |
| **Plan / workflow run** | Artifacts under `{us-dir}` = `{plansDir}/{slug}/` (`plans.dir`, default `.agents/plans`) |
| **`step-00-{slug}.spec.md`** | Workflow copy of the spec inside `{us-dir}` after register/provider fetch — **plan artifact**, not a Spec-board row |
| **`index.PRD`** | Project feature index at `{specsDir}/index.PRD` (phases, next-specs, inbox) — owned by `ws-spec-index` |
| **Register** | Two-phase promotion via `ws-spec-provider-local`: write/normalize the spec of record `{specsDir}/{slug}.spec.md`, then the workflow copy `{us-dir}/step-00-*.spec.md` |
| **Spec of record** | The `{specsDir}` copy every entry path produces first (path resolved via `ws-spec-organizer`; `{slug}.spec.md` or `NNNN-{slug}.spec.md` when `plans.enforceSpecPrefixOrdering` is true) — providers never write `step-00` without it |
| **`{specsDir}/{slug}.context.md`** | Optional spec companion from `ws-spec-write` when a user-facing gray area has ≥2 valid product options (Feature Boundary, Implementation Decisions, Deferred Ideas). Not a `{us-dir}` plan artifact |
| **Classify** | Recommend `lite` vs `standard` orch (`ws-classify-complexity`) after a workflow spec exists |
| **Drift sync** | Update existing `*.spec.md` bodies to match code (`ws-spec-update`) — not the same as `ws-spec-index sync` (index status) |
| **Batch** | Sequential multi-spec delivery (`ws-spec-multi`) |

### Path rules (mandatory)

1. Standalone `/write-spec` / brainstorm → write **only** `{specsDir}/{slug}.spec.md` (or `NNNN-{slug}.spec.md` when `plans.enforceSpecPrefixOrdering` is true via `ws-spec-organizer`). Never mkdir `{plansDir}/{slug}/` for that ask.
2. Every provider (`local`, `github`, `azure-devops`) writes the spec of record under `{specsDir}` **before** any `{plansDir}` artifact.
3. Workflow planning and later steps read **`{us-dir}/step-00-{slug}.spec.md`** (after register or tracker fetch).
4. Spec board (`ws-spec-list --specs`) lists `{specsDir}` only. Plan board lists `{plansDir}` state — never merge the two inventories.
5. `{specsDir}/{slug}.context.md` is an optional spec companion, never a plan artifact.

---

## Specs skill router (progressive disclosure)

Load **only** the skill that matches the user intent. Do not load the whole family.

| When the user / task means… | Load | Does **not** do |
|-----------------------------|------|-----------------|
| Manage / route / index / handle all spec operations (unified front door) | [`ws-spec-manager`](../ws-spec-manager/SKILL.md) | Central router and interactive menu; delegates to specialized `ws-spec-*` skills |
| Draft a new local spec or reformulate tracker issue | [`ws-spec-write`](../ws-spec-write/SKILL.md) | Does not create `{plansDir}` / `step-00`; does not run orch. Standalone: `user-gate` then `ws-spec-index` `track` |
| Validate / reshape / review `*.spec.md` format & ACs | [`ws-spec-format`](../ws-spec-format/SKILL.md) | Does not invent product requirements; format SoT is [`FORMAT.md`](../ws-spec-format/FORMAT.md) |
| Register any `*.spec.md` → `{specsDir}` spec of record + workflow `step-00`; configure `{specsDir}`; local `fetch-to-spec` | [`ws-spec-provider-local`](../ws-spec-provider-local/SKILL.md) | Not for free-text draft (use spec-write first); PR ops delegate to `providers.scm` |
| List / pick / manage specs vs plan workflows (two boards) | [`ws-spec-list`](../ws-spec-list/SKILL.md) | Does not edit `index.PRD` content (that is spec-index); does not implement pipeline steps |
| Init / sync / promote / track `index.PRD` feature map | [`ws-spec-index`](../ws-spec-index/SKILL.md) | Does not rewrite AC bodies for code drift (that is sync-spec); `sync` = index status vs delivery evidence; `track` = add existing spec row; does not harvest `{plansDir}` history (`ws-spec-archive`) |
| Harvest plan-folder facts into `index.PRD` Archive, then propose shipped-plan cleanup | [`ws-spec-archive`](../ws-spec-archive/SKILL.md) | Does not delete untracked scratch (that is `ws-cleanup`); does not rewrite AC bodies |
| Resolve spec-of-record path or organize/prefix existing specs chronologically | [`ws-spec-organizer`](../ws-spec-organizer/SKILL.md) | Does not reformulate requirements (that is spec-write); does not edit index.PRD status |
| Spec text drifted from implemented code after prompts | [`ws-spec-update`](../ws-spec-update/SKILL.md) | Does not update `index.PRD` checkboxes (use spec-index `sync`); does not start orch |
| Prompt-driven product work (not Spec-to-PR) | [`ws-task-lifecycle`](../ws-task-lifecycle/SKILL.md) | Does not mkdir `{plansDir}` or write `step-00`; does not invoke spec-to-pr / lite |
| Vibe-coding implement / what-next / plan or research without a spec | [`ws-megabrain`](../ws-megabrain/SKILL.md) | Does not replace spec-to-pr; defers when orch owns the session |
| Deliver **one** feature Spec→PR (full FSM 0–9) | [`ws-spec-to-pr`](../ws-spec-to-pr/SKILL.md) | Not for batch; not for format-only edits |
| Deliver **one** feature Spec→PR (fast lite 0–5) | [`ws-spec-to-pr-lite`](../ws-spec-to-pr-lite/SKILL.md) | Not for complex multi-phase work; never cross-resume with standard |
| Pick lite vs standard for a ready spec | [`ws-classify-complexity`](../ws-classify-complexity/SKILL.md) | Orthogonal to gates.md simple/standard/complex skip axis |
| Deliver **many** specs sequentially (auto lite/standard workers) | [`ws-spec-multi`](../ws-spec-multi/SKILL.md) | Master orch only — does not edit product code itself |
| Explain status / what a spec delivered (read-only panorama) | [`ws-spec-explain`](../ws-spec-explain/SKILL.md) | Does not implement, ship, or edit specs |
| Bulk-import open GH issues / ADO User Stories → local specs + register | [`ws-spec-from-provider`](../ws-spec-from-provider/SKILL.md) | Not single-id fetch (use provider `fetch-to-spec`); not orch delivery |

### Keyword → skill (quick map)

| Keywords / phrases | Invoke |
|--------------------|--------|
| manage specs, spec manager, /spec, /specs, /spec-manager, spec lifecycle, spec menu | `ws-spec-manager` |
| write a spec, draft spec, brainstorm feature spec, reformulate issue | `ws-spec-write` |
| format spec, validate AC, spec-format, missing acceptance criteria | `ws-spec-format` |
| register spec, fetch-to-spec (file), promote spec into a workflow run | `ws-spec-provider-local` |
| import issues, import user stories, bulk specs from github/ado, spec-from-provider | `ws-spec-from-provider` |
| list specs, list plans, dual board, unlinked specs, manage workflows | `ws-spec-list` |
| index.PRD, promote inbox, sync index status, init PRD, track spec | `ws-spec-index` |
| archive plans, archive index.PRD, harvest plan history | `ws-spec-archive` |
| resolve spec path, organize specs, prefix specs NNNN, spec-organizer, enforceSpecPrefixOrdering | `ws-spec-organizer` |
| sync spec to code, spec drift, update AC after code change | `ws-spec-update` |
| prompt-driven task, task lifecycle, cowork without spec-to-pr | `ws-task-lifecycle` |
| vibe coding, megabrain, implement without spec, what next | `ws-megabrain` |
| spec to pr, full pipeline, standard orch | `ws-spec-to-pr` |
| lite / fast spec to pr | `ws-spec-to-pr-lite` |
| classify complexity, lite or standard? | `ws-classify-complexity` |
| multi-spec, batch specs, run all specs | `ws-spec-multi` |
| explain spec, spec status, what did US deliver, /explain | `ws-spec-explain` |
| cleanup workflow, clean plan leftovers, delete telemetry/.runtime | `ws-cleanup` |
| spec-memo-setup, /ws-spec-memo, external vault setup, off-repo memory, configure vault, import/migrate MEMORY, vault preflight check, hybrid fallback bootstrap | `ws-spec-memo` |
| spec-memo search/get/upsert/bootstrap (runtime), /ws-memo, memo vault ops, canvas, doctor | `ws-memo` |
| prompt tracking, session_start/end, vault activity report, /ws-session-tracking, derive_rules from prompts | `ws-session-tracking` |
| Spec-to-PR plan-folder timesheet / activity-report {date} | `ws-activity-report` |

---

## Hub contracts (progressive disclosure)

Load the named hub file or one skill. Do not load both SCM provider bodies to compare intents.

| When the user / task means… | Load | Does **not** do |
|-----------------------------|------|-----------------|
| SCM parity / GitHub vs Azure intents / `scm-provider-contract` | [`scm-provider-contract.md`](scm-provider-contract.md) then **one** provider | Do not load both provider `SKILL.md` bodies to compare intents |
| Check-implementation / verify score / `scoreAndRefine` | Orch Step 5; standalone [`ws-plan-verify`](../ws-plan-verify/SKILL.md); gates in [`gates.md`](gates.md) | Do not auto-approve below `defaults.minVerifyScore` (default 9); do not load `ws-implement-tasks` until scoreAndRefine says to |

| Keywords / phrases | Invoke |
|--------------------|--------|
| SCM parity, github vs azure intents, provider contract | `{sharedDir}/scm-provider-contract.md` then one provider |
| verify score, check-implementation, scoreAndRefine | orch Step 5 / `ws-plan-verify` |

---

## How the family fits together

```text
ideas / free text
    → ws-spec-write          → {specsDir}/{slug}.spec.md
    → ws-spec-format         → validate / reshape same file
    → ws-spec-index promote  → optional index.PRD row + stub

tracker issue / work item
    → ws-spec-provider-github / ws-spec-provider-azure-devops fetch
                             → raw snapshot JSON
                             → ws-spec-write reformulate & enhance
                                                       → {specsDir}/us-{id}.spec.md   (spec of record)
                             → ws-spec-provider-local register --source {origin}
                                                       → {us-dir}/step-00-us-{id}.spec.md

open backlog (batch)
    → ws-spec-from-provider  → list (GH open issues | ADO US @Me)
                             → per id: spec-write enhance + register (skip existing {specsDir})

{specsDir}/*.spec.md
    → ws-spec-list           → browse / start orch / remove
    → ws-spec-provider-local → {us-dir}/step-00-{slug}.spec.md
    → ws-classify-complexity → lite | standard
    → ws-spec-to-pr-lite  or  ws-spec-to-pr  → PR
    → ws-spec-multi          → loop classify + worker orch per spec

after code changes outside orch
    → ws-spec-update         → surgical updates to {specsDir} (and/or step-00 if still linked)

after ship / delivery evidence
    → ws-spec-index sync     → index.PRD checkboxes / Done log

harvest {plansDir} history (manual)
    → ws-spec-archive        → index.PRD Archive + optional plan-dir cleanup
```

**Complement rules**

1. `ws-spec-write` owns **creation & agentic reformulation** under `{specsDir}`; `ws-spec-provider-local` owns **promotion** into `{us-dir}` — for local *and* tracker specs.
2. `ws-spec-format` is the only format SoT; spec-write / providers / spec-update **follow** it — they do not redefine frontmatter.
3. `ws-spec-list` is the UX board; `ws-spec-index` is the PRD index; `ws-spec-archive` harvests `{plansDir}` history into that index so plan folders can go. Do not use one for the other's job.
4. `ws-spec-update` (body ↔ code) ≠ `ws-spec-index sync` (index ↔ delivery evidence).
5. `ws-spec-multi` dispatches `ws-spec-to-pr` / `ws-spec-to-pr-lite` workers; it does not replace `ws-spec-list` for interactive pick-one.
6. Tracker issues/WIs enter via `ws-spec-provider-github` / `ws-spec-provider-azure-devops` fetch → `ws-spec-write` agentic reformulation → `{specsDir}` spec of record, then spec-provider-local register → `step-00` with `--source {github|azure-devops}`. No provider writes `step-00` directly. Batch backlog import: `ws-spec-from-provider`.
8. `ws-spec-archive` (manual) harvests `{plansDir}` into `index.PRD` Archive then proposes plan-dir cleanup. `ws-cleanup` deletes untracked scratch only. Archive first when history must survive.

---

## Seed note

Shipped by install/update as hub template. Prefer keeping the Specs vocabulary, router, and Hub contracts sections aligned with upstream. Customize the Always-applied table per project when needed (or via `ws-configure-project --section autoload`).
