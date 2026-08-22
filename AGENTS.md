# AGENTS.md — spec-memo agent contract

**Audience: agents.** Humans: [`README.md`](README.md).

This file is the operating contract for work in **this repository**. Do not treat `README.md` as the router. Session start: apply § [Session start](#session-start).

**Language:** en-us only for product docs, schemas, CLI help, MCP descriptions, tests, and commit messages.

---

## Session start

1. Read [`PRODUCT.PRD`](PRODUCT.PRD) (goal, non-goals, current phase).
2. Read [`FEATURES.md`](FEATURES.md) for the capability that the task touches.
3. Read [`PLAN.md`](PLAN.md) for the slice, exit proof, and what is out of sequence.
4. Do **not** create workflow residue in this repo (see § [Git boundary](#git-boundary-mandatory)).

Skip dumping the full `PLAN.md` into context when the task names a single slice — read that slice and the linked feature.

---

## Doc roles (mandatory)

| File | Audience | Purpose |
|------|----------|---------|
| **`AGENTS.md`** (this file) | Agents | Session contract, layers, forbidden writes, verification |
| **`README.md`** | Humans | Pitch, status, contribute |
| **`PRODUCT.PRD`** | Both | Product requirements, phases, feature map, constraints |
| **`FEATURES.md`** | Both | What the product can do (planned vs shipped) |
| **`PLAN.md`** | Both | Implementation sequencing and proof |

When facts diverge, fix **`PRODUCT.PRD` first**, then align `FEATURES.md` / `PLAN.md` / `README.md`. Do not invent a parallel spec tree.

Lasting agent obligations live here. Human install/UX prose lives in `README.md`. Keep paths and phase numbers aligned without duplicating full feature lists.

---

## Git boundary (mandatory)

This product’s thesis is that **product git is not a memory store**. Dogfood it.

| May live in this git repo | Must not live in this git repo |
|---------------------------|--------------------------------|
| Runtime source, tests, package manifests, CI | Agent plans, step-N copies, `.state.md`, run.json, telemetry |
| `README.md`, `AGENTS.md`, `PRODUCT.PRD`, `FEATURES.md`, `PLAN.md` | `MEMORY.md`, `memory/*`, agent `CHANGELOG.md` dumps |
| Later: shipped ADRs you explicitly promote | `.agents/plans`, `.agents/specs` duplicates, `.agents/codereviews` |
| Later: `*.spec.md` **only** when splitting a scheduled slice from `PRODUCT.PRD` (one of record, no `step-00` twin) | Sidecar vault contents (`~/.spec-memo`) |

Until Phase 1 ships, working notes for *this* product go into `PLAN.md` / `PRODUCT.PRD` — not a new folder of session files.

**Do not** add host-private rule trees as the portable contract (optional thin pointer to this file is allowed if an IDE requires it).

---

## Product shape (do not silently change)

Canonical architecture: [`PRODUCT.PRD`](PRODUCT.PRD) § Architecture.

- **Seam:** MCP stdio server + CLI, same module. Not a host plugin as the agent API.
- **Store:** Markdown records with YAML frontmatter, per project id derived from git remote. SQLite FTS is a **disposable index** rebuilt from files.
- **Identity:** git remote URL. Zero pointer files required in a consumer product repo.
- **Interface cap:** the eight tools in [`FEATURES.md`](FEATURES.md) § MCP tools. Do not add tools without updating `PRODUCT.PRD`. A 20-tool MCP is a failed design.
- **Non-goals:** in-repo vault (even gitignored), embeddings/knowledge-graph as v1, Cursor Memories as the store, “gitignore + cleanup skill” as the product.

If a task needs a new kind, tool, or retention rule: stop, propose the change in `PRODUCT.PRD`, wait for confirmation.

---

## Layers (when code exists)

| Layer | Path (planned) | Role |
|-------|----------------|------|
| MCP + CLI | `src/` | Tool handlers, argument schemas, bootstrap budget |
| Store | `src/store/` | Vault layout, frontmatter, compiled indexes |
| Index | `src/index/` | SQLite FTS rebuild and query |
| Policy | `src/policy/` | Schema, TTL, refuse-in-repo-write, redaction |
| Tests | `test/` | Bind, upsert, bootstrap cap, gc, refuse product-tree write |

Do not leak vault paths into the MCP tool descriptions. Callers learn tools, not folders.

---

## Implementation rules

1. **Current phase only.** Implement the slice in `PLAN.md` that the user named. Do not start Phase 2 adapter work or a plugin during Phase 1.
2. **Smallest diff.** No extra kinds, tools, or config flags beyond `PRODUCT.PRD`.
3. **Stop on ambiguity** that changes behavior (stack, vault git-on-by-default, new MCP tool). Name options; do not pick silently when the PRD is silent.
4. **Reuse.** Prefer the Node stdlib and the planned dependencies in `PLAN.md` § Stack. Do not add a vector library, ORM, or HTTP server unless the PRD says so.
5. **Host-neutral.** MCP tool names, CLI, and schemas must not require a specific IDE. Cursor is one host.

---

## Verification

Until `package.json` exists, verification is documentary: the change matches `PRODUCT.PRD` / `FEATURES.md` / `PLAN.md`, and this repo’s git boundary is intact (`git status` has no `.agents/plans`, no `MEMORY.md`).

When the test script exists, run it and report the exit code. Do not claim Phase 1 done without the exit proofs in `PLAN.md` § Phase 1.

---

## Task router

| User intent | Do |
|-------------|----|
| Change product scope, kinds, tools, non-goals | Edit `PRODUCT.PRD`, then `FEATURES.md` + `PLAN.md` |
| Change a capability description | `FEATURES.md` (must still match `PRODUCT.PRD`) |
| Change sequencing or proof | `PLAN.md` |
| Implement a named Phase 1 slice | Code under planned `src/` + tests; update feature status marks when the slice’s proof passes |
| workflow-skills integration | Not until Phase 2. Record the idea under `PRODUCT.PRD` § Inbox if it is new |
| Plugin, embeddings, Obsidian app | Reject as v1. Point at non-goals |

---

## Subagent contract

- Restate the slice, allowed paths, and named proof from `PLAN.md` before mutating.
- Do not write workflow residue into this repository.
- Do not expand the MCP surface or artifact kinds without a PRD edit the user accepted.
- Return touched paths and, when tests exist, exact exit codes.
