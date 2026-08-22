# spec-memo

**Audience: humans.** Agents follow [`AGENTS.md`](AGENTS.md).

Local working memory for coding agents. Product git stays product: source, tests, shipped docs. Traps, decisions, specs, plans, state, and agent logs live in a curated vault **outside** the product repository, queried through a small MCP interface (and a matching CLI).

This repository is the product. It is in design: the documents below are the contract. Runtime (MCP server, CLI, vault) is not shipped yet.

| Doc | Who | What |
|-----|-----|------|
| **`README.md`** (this file) | Humans | Pitch, status, doc map, contribute |
| [`PRODUCT.PRD`](PRODUCT.PRD) | Humans + agents | Goal, problems, use cases, constraints, feature map by phase |
| [`FEATURES.md`](FEATURES.md) | Humans + agents | Capability inventory (planned vs shipped) |
| [`PLAN.md`](PLAN.md) | Humans + agents | Implementation slices, sequencing, exit proof |
| [`AGENTS.md`](AGENTS.md) | Agents | Session contract, layers, forbidden writes, verification |

---

## Why

Agent workflows (specs, plans, state files, changelogs, trap/memory dumps) accumulate inside the product working tree. Gitignore does not fix it: clones do not share memory, `git status` and Glob still see the dump, and files get committed. The useful core (anti-regression traps) is tiny; the residue (plans, scratch, duplicate specs) is not.

**spec-memo** moves that working set out of the product git boundary and replaces dump-read (`Read MEMORY.md`, `Glob **/*.spec.md`) with `bootstrap` / `search`.

## What it is / is not

| Is | Is not |
|----|--------|
| A local vault keyed by git remote | A folder inside the product repo, even if gitignored |
| Structured Markdown records + a disposable FTS index | A vector database or knowledge graph (later, maybe, behind `search`) |
| MCP tools + CLI on one module | A host-specific IDE plugin as the agent contract |
| Kinds, TTL, compiled indexes, GC | “Please don’t pollute” plus a cleanup skill |

Related: [workflow-skills](https://github.com/jpolvora/workflow-skills) is a consumer of this idea (in-repo `{sharedDir}/MEMORY.md`, `{plansDir}`, `{specsDir}`). This product is the store those skills should write to. Skill bodies remain in workflow-skills; consumer hub data should not.

## Status

| Layer | State |
|-------|--------|
| Product docs (this tree) | In progress |
| Vault + SQLite FTS + MCP + CLI | Not started — [`PLAN.md`](PLAN.md) Phase 1 |
| workflow-skills adapter | After Phase 1 — [`PLAN.md`](PLAN.md) Phase 2 |

## Intended use (once Phase 1 exists)

1. Agent opens a product repo, calls `bootstrap` (or `memo bootstrap`).
2. spec-memo binds the git remote → project id, returns a token-capped brief (traps, open decisions, live slug, drift).
3. During work, the agent `upsert`s traps/decisions/specs/plans and `append`s logs — never into the product tree.
4. `gc` applies TTL. `promote` is the only path that may copy a record into the product repo, and only when the human names a destination.

Vault root defaults to `$SPEC_MEMO_ROOT` or `~/.spec-memo`. The product clone has **no** spec-memo files.

## Contribute

1. Read [`PRODUCT.PRD`](PRODUCT.PRD) and [`PLAN.md`](PLAN.md). Stay inside the current phase.
2. Language for product docs and code comments: **en-us**.
3. Do not add `.agents/plans`, in-repo `MEMORY.md`, or duplicate spec copies. This repo dogfoods its own git boundary.
4. Open a PR against the default branch when one exists.

## License

Not chosen yet.
