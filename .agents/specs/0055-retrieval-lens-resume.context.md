# Context — retrieval-lens-resume

## Feature Boundary

This slice changes **how** existing `search` and `bootstrap` rank and explain lexical memory, plus an opt-in continuation surface. It does not add a 12th MCP tool, embeddings, CodeGraph file suggestions, or a default session dump on ordinary bootstrap.

In scope: closed keyword intent/task tables, `intentKindBoost`, `budgetReport.omittedIds` / `taskLens`, CLI `memo resume`, MCP `continuation` (alias `resume`).

Out of scope: vector search, git-history injection, re-claiming delivered handoffs, raising the default 8 KB budget.

## Implementation Decisions

1. **Canonical flag name is `continuation`.** Product language is “resume,” so the CLI verb is `memo resume`. The boolean on `BootstrapOptions` / MCP `bootstrap` is `continuation` (default `false`) because it is a continuation of an existing session, not a new tool. Accept MCP alias `resume` mapped onto the same field; if both are present, `continuation` wins. Alternative (canonical `resume` only) is deferred to avoid colliding with the CLI command name in docs and help text.

2. **`omittedIds` lives on `budgetReport`, not the top-level brief.** Spec `0038` already keeps diagnostics outside `byteLength`. A top-level `omittedIds` would either count against the 8 KB cap or require a second “exclude these keys” special case. Nesting reuses `budgetReport` exclusion.

3. **Mixed search-intent precedence is trap > log > decision.** “Why did this fail” is a bugfix/trap query, not an ADR hunt. Alternative (union boost both kinds) would silently reorder more of the index and break the neutral-query guarantee harder.

4. **Resume trap cap is 3 after ranking, then budget.** Durable anchors are high-`hits` then high-severity traps already in `scoreTrap` order. Decisions stay on the existing budget path so resume cannot starve ADRs entirely.

## Deferred Ideas

- Operator-configurable keyword tables in `config.json` (would need a schema migration and tests for malformed tables).
- Status-monitor UI toggle for intent lens (0038 already has explain scoring; visual lens chips can follow).
- Soft-reopen of claimed handoffs via an explicit `prompt` action (conflicts with 0036 single-use).
- Allowing `kind=log` into the resume brief for `release` lens (rejected: 0007 keeps logs out of ordinary bootstrap; search remains the log surface).
