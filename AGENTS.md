# AGENTS.md — spec-memo agent contract

**Audience: agents.** Humans: [`README.md`](README.md).

This file is the operating contract for work in **this repository**. Do not treat `README.md` as the router. Session start: apply § [Session start](#session-start).

**Language:** `en-us` only for product docs, schemas, CLI help, MCP descriptions, tests, and commit messages.

---

## Precedence (highest first)

1. Explicit user instructions (current turn)
2. This root `AGENTS.md` / [`GEMINI.md`](GEMINI.md) operating contract
3. Design & architecture constraints ([`PRODUCT.PRD`](PRODUCT.PRD), [`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), [`.agents/specs/index.PRD`](.agents/specs/index.PRD), [`.agents/specs/*.spec.md`](.agents/specs/))
4. Autoload (Always-applied) skills ([`.agents/skills/ws-shared/autoload.md`](.agents/skills/ws-shared/autoload.md))

---

## Autoload (Always-applied skills)

Load **every** skill listed in [`.agents/skills/ws-shared/autoload.md`](.agents/skills/ws-shared/autoload.md) § Always-applied skills on every prompt (unless the user opted out for that skill).

| Skill | Path | Trigger | Role |
|-------|------|---------|------|
| `ws-senior-developer` | `{globalSkillsRoot}/ws-senior-developer/SKILL.md` | Every prompt | Delivery gate, scope control, Code review proof, ambiguity stops |
| `ws-self-learning` | `{globalSkillsRoot}/ws-self-learning/SKILL.md` | Every mutating task | Consult MEMORY + anti-regression trap writes |
| `ws-patterns-backend` | `{globalSkillsRoot}/ws-patterns-backend/SKILL.md` | Every prompt | Load SKILL.md; consult `{sharedDir}/backend.md` on backend tasks |
| `ws-patterns-frontend` | `{globalSkillsRoot}/ws-patterns-frontend/SKILL.md` | Every prompt | Load SKILL.md; consult `{sharedDir}/frontend.md` on frontend tasks |
| `ws-changelog` | `{globalSkillsRoot}/ws-changelog/SKILL.md` | Every task completion | Append-only history writer |
| `ws-fable-method` | `{globalSkillsRoot}/ws-fable-method/SKILL.md` | Every prompt | Structured 7-step investigate / act / verify loop |
| `ws-tdah` | `{globalSkillsRoot}/ws-tdah/SKILL.md` | Every prompt | Action-first reply shape & operational judgment |
| `ws-karpathy-guidelines` | `{globalSkillsRoot}/ws-karpathy-guidelines/SKILL.md` | Every coding task | Surgical changes, minimal diff footprints, surface assumptions |

---

## Specs progressive disclosure & skill router

When the user mentions specs / plans / Spec-to-PR / `index.PRD` without naming a skill, load **only** the matching skill from the router below:

| When the user / task means… | Load | Does **not** do |
|-----------------------------|------|-----------------|
| Draft a new local spec or reformulate tracker issue | `ws-write-spec` | Does not create `{plansDir}` / `step-00`; does not run orch |
| Validate / reshape / review `*.spec.md` format & ACs | `ws-spec-format` | Does not invent product requirements |
| Register spec of record & workflow copy | `ws-local-spec-provider` | Not for free-text draft (use `ws-write-spec`) |
| List / pick / manage specs vs plan workflows | `ws-spec-list` | Does not edit `index.PRD` content |
| Init / sync / promote `index.PRD` feature map | `ws-spec-index` | Does not rewrite AC bodies for code drift |
| Spec text drifted from implemented code after prompts | `ws-sync-spec` | Does not update `index.PRD` checkboxes |
| Deliver **one** feature Spec→PR (full FSM 0–9) | `ws-spec-to-pr` | Not for batch; not for format-only edits |
| Deliver **one** feature Spec→PR (fast lite 0–5) | `ws-spec-to-pr-lite` | Not for complex multi-phase work |
| Pick lite vs standard for a ready spec | `ws-classify-complexity` | Complexity analysis against DAG thresholds |
| Deliver **many** specs sequentially | `ws-multi-spec` | Master orch only |
| Explain status / what a spec delivered | `ws-spec-explain` | Read-only panorama; does not edit code/specs |

---

## Session start

1. Read [`PRODUCT.PRD`](PRODUCT.PRD) (goal, non-goals, architecture, constraints, current phase).
2. Read [`FEATURES.md`](FEATURES.md) for the capability that the task touches.
3. Read [`PLAN.md`](PLAN.md) for the implementation slice, exit proof, and sequencing.
4. Read [`.agents/specs/index.PRD`](.agents/specs/index.PRD) and any dedicated slice spec (`.agents/specs/<slug>.spec.md`).
5. Do **not** create workflow residue in this repository (see § [Git boundary](#git-boundary-mandatory)).

Skip dumping the full `PLAN.md` into context when the task names a single slice — read that slice and the linked feature/spec.

---

## Doc roles (Single sources of truth)

| File | Audience | Purpose |
|------|----------|---------|
| **`AGENTS.md`** / **`GEMINI.md`** | Agents | Session contract, layers, git boundaries, rules, verification |
| **`README.md`** | Humans | Pitch, status, install, contribute |
| **`PRODUCT.PRD`** | Both | Product requirements, phases, feature map, constraints, architecture |
| **`FEATURES.md`** | Both | Capability inventory (what the product can do: planned vs shipped) |
| **`PLAN.md`** | Both | Implementation sequencing, exit proofs, and Done log |
| **`.agents/specs/index.PRD`** | Both | Feature spec index, canonical roadmap, next specs, archive |
| **`.agents/specs/<slug>.spec.md`** | Both | Dedicated slice specification and acceptance criteria of record |

When facts diverge, fix **`PRODUCT.PRD` first**, then align `FEATURES.md` / `PLAN.md` / `.agents/specs/index.PRD` / `README.md`. Do not invent a parallel spec tree.

---

## Git boundary (mandatory)

This product’s thesis is that **product git is not a memory store. Dogfood it.**

| May live in this git repo | Must not live in this git repo |
|---------------------------|--------------------------------|
| Runtime source (`src/`), package manifests, `tsconfig.json`, CI | Agent plans (`.agents/plans`), step-N copies, `.state.md`, `run.json`, telemetry |
| `README.md`, `AGENTS.md`, `GEMINI.md`, `PRODUCT.PRD`, `FEATURES.md`, `PLAN.md` | `MEMORY.md`, `memory/*`, agent `CHANGELOG.md` dumps |
| Specs of record under `.agents/specs/*.spec.md` and `.agents/specs/index.PRD` | Sidecar vault contents (`~/.spec-memo`, `$SPEC_MEMO_ROOT`) |
| Test suites (`src/*.test.ts`) | Scratch files, session logs, prompt dumps |

**Refuse in-repo workflow writes:** When executing tasks in this product repo, never write working memory records, session state, or vault files into the product tree.

---

## Product shape (do not silently change)

Canonical architecture: [`PRODUCT.PRD`](PRODUCT.PRD) § Architecture.

- **Seam:** MCP stdio server + CLI (`memo`), same module in a single npm package.
- **Store:** Markdown records with YAML frontmatter under `$SPEC_MEMO_ROOT` (default `~/.spec-memo/projects/<projectId>/`).
- **Disposable index:** SQLite FTS5 (`memo.sqlite`) is a disposable cache rebuilt from markdown files; never the source of truth.
- **Identity:** Normalized git remote URL (fallback: canonical absolute repo path). Zero required pointer files in consumer repos.
- **Interface cap:** Exactly eight MCP tools / CLI commands:
  1. `bootstrap` — Bind cwd git remote; compile token-budgeted brief (8 KB UTF-8 cap).
  2. `search` — Filtered retrieval across vault records via SQLite FTS5.
  3. `get` — Retrieve a single record by id or `kind+slug`.
  4. `upsert` — Store/update typed record (trap, decision, spec, plan, state, review, scratch).
  5. `append` — Write-only changelog / audit event log stream.
  6. `forget` — Soft-archive or purge records.
  7. `gc` — Apply TTL retention (7d scratch / 14d review), compact shipped plans, rebuild FTS.
  8. `promote` — Copy a record into the product repository (default deny without product root target).
- **Non-goals (Phase 1):** In-repo vault dumps, vector search/embeddings, host-specific plugins, Obsidian runtime dependency, multi-tenant cloud SaaS.

If a task needs a new kind, tool, or retention rule: stop, propose the change in `PRODUCT.PRD`, and wait for confirmation.

---

## Code layers & layout

| Layer | Path | Role |
|-------|------|------|
| **MCP & CLI** | `src/mcp.ts`, `src/cli.ts`, `src/tools.ts`, `src/index.ts` | MCP stdio server, tool dispatch, CLI command router, arg schemas |
| **Store & Compiler** | `src/store.ts`, `src/compiler.ts`, `src/schema.ts`, `src/types.ts` | Markdown vault file I/O, frontmatter validation, compiled views (`TRAPS.md`, `DECISIONS.md`, `INDEX.md`) |
| **Identity & Vault** | `src/identity.ts`, `src/vault.ts` | Remote normalization, project ID derivation, vault scaffolding |
| **Index** | `src/indexer.ts` | SQLite FTS5 table lifecycle, query compilation, full vault rebuild |
| **Curator & Safety** | `src/safety.ts`, `src/curator.ts`, `src/bootstrap.ts` | Secret redaction, product-tree write guard, TTL GC, plan compaction, bootstrap brief |
| **Tests** | `src/*.test.ts` | Automated test suites using Node test runner (`node:test`) |

Do not leak vault filesystem paths into MCP tool descriptions. Callers learn tools, not folders.

---

## Implementation rules

1. **Current phase only.** Implement the slice in `PLAN.md` that the user named. Do not start Phase 2 adapter work or Phase 3 hardening out of sequence.
2. **Smallest diff (Karpathy guidelines).** Apply surgical, minimal changes. No speculative features, extra tools, or unrequested refactoring.
3. **Stop on ambiguity.** If a change alters behavior, schemas, tool signatures, or stack choices, stop and present explicit options to the user.
4. **Reuse stdlib & pinned dependencies.** Rely on Node 22 stdlib, `@modelcontextprotocol/sdk`, `better-sqlite3`, `gray-matter`. Do not add ORMs, web servers, or external search daemons.
5. **Host-neutral.** All MCP tool names, CLI commands, and schemas must remain completely agnostic to the host IDE (Cursor, VS Code, Antigravity, Claude Desktop, etc.).

---

## Task execution & tracking workflow

Always work in strict synchronization with [`.agents/specs/index.PRD`](.agents/specs/index.PRD) and the project's tracking documents ([`FEATURES.md`](FEATURES.md), [`PLAN.md`](PLAN.md), [`PRODUCT.PRD`](PRODUCT.PRD)).

### Phase 1: Intake & spec alignment (pre-execution)

1. **Locate matching slice/spec:**
   - Locate the relevant feature or slice in [`.agents/specs/index.PRD`](.agents/specs/index.PRD) and [`PLAN.md`](PLAN.md).
   - Check if a dedicated slice spec exists (`.agents/specs/<slug>.spec.md`).
2. **Evaluate or create spec:**
   - **Found:** Review and align the task instructions with the spec requirements.
   - **Not found:** Determine if the task warrants its own spec. If yes, create `.agents/specs/<slug>.spec.md` and register the slug in `.agents/specs/index.PRD` § `## 8. Next specs`.
3. **Mark in execution:**
   - Before executing changes, mark the task / spec as `[~] in progress` in [`.agents/specs/index.PRD`](.agents/specs/index.PRD) (and the slice spec if applicable).

### Phase 2: Surgical implementation & verification

1. **Implement surgically:**
   - Apply minimal, precise edits adhering to Karpathy guidelines and project constraints in [`PRODUCT.PRD`](PRODUCT.PRD).
2. **Verify proofs:**
   - Run tests (`npm test`) and confirm exit proofs defined in [`PLAN.md`](PLAN.md).

### Phase 3: Completion, canonical tracking & state update (post-execution)

As soon as an implementation slice or feature lands and its verification proof passes, update the tracking documents immediately in this **canonical order**:

1. **[`FEATURES.md`](FEATURES.md)**: Mark matching capability checkboxes as `[x]`.
2. **[`PLAN.md`](PLAN.md)**: Append an entry to `## Done log` with `Date`, `Slice Slug`, and `Proof Result`.
3. **[`PRODUCT.PRD`](PRODUCT.PRD)**: Append an entry to `## 11. Done log` with `Date`, `Slug`, `Title`, and `PR / Commit`.
4. **[`.agents/specs/index.PRD`](.agents/specs/index.PRD)**:
   - Mark matching spec in `## 8. Next specs` as `[x] done`.
   - Append an entry to `## 10. Done log` with `Date`, `Slug`, `Title`, and `PR / Commit`.
   - Mark the slice spec status (`.agents/specs/<slug>.spec.md`) as complete if present.
5. **Changelog & Learning:**
   - Log task completion via `ws-changelog` and record any newly discovered anti-regression traps via `ws-self-learning`.

---

## Subagent contract

- Restate the slice, allowed paths, and named proof from `PLAN.md` before mutating.
- Do not write workflow residue or session files into this repository.
- Do not expand the MCP surface or artifact kinds without a PRD edit approved by the user.
- Always execute `npm test` and return touched paths with exact exit codes.
