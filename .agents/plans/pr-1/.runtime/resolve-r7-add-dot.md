Fixed in this iteration.

**Problem:** `commitVaultChange` ran `git add .`, so unrelated dirty vault files (scratch, half-finished imports) were committed with every upsert/append/forget/gc.

**Change:** Primitive now stages explicit paths only (`git add -- <paths>`). Callers pass `projects/<projectId>`. Default (no paths) is `projects` + `config.json`. `.` and parent-relative paths are rejected. Test asserts a vault-root scratch file is not tracked.

**defectClass:** Vault auto-commit stages the whole tree instead of mutation-touched paths
**sourcesConsulted:** code, memory, context, patterns (consult-skipped)
**proactiveFixed:** src/vault.ts, src/store.ts (upsert/append/forget), src/curator.ts (gc), src/vault.test.ts
**proactiveSkipped:** src/importer.ts — does not call commitVaultChange (missing-commit class, not over-broad add); src/bootstrap.test.ts `git add .` is product-repo test setup; same-project scratch under the mutated project needs a write-set (size gate)
