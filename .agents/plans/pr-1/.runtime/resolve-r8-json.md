Fixed in this iteration.

**Problem:** CLI `--json` printed raw doctor/import (and hook/sync) objects. sanitizeToolOutput did not strip vaultPath, vaultRoot, dbPath, or absolutePath, so host vault locations leaked on those seams.

**Change:** Extended VAULT_PATH_KEYS; all CLI JSON branches now go through printJson -> sanitizeToolOutput (doctor, import, hook, sync, errors, executeTool JSON). Text mode still prints vault location for local diagnostics.

**defectClass:** Caller-facing CLI JSON leaks vault filesystem paths
**sourcesConsulted:** code, memory (sanitize-all-seams), context (6 sibling threads), patterns (consult-skipped)
**proactiveFixed:** src/safety.ts, src/cli.ts (all --json prints), src/cli.test.ts, src/safety.test.ts
**proactiveSkipped:** src/mcp.ts stringify — executeTool already sanitizes; import sourcePath (product-relative, acceptable)
