Fixed in this iteration.

**Problem:** Truncation cleared traps/decisions/activeSlice/drift/notices but never dropped lastSeenRoot/gitRemote, so a tiny maxBytes still returned truncated:true with byteLength > budgetBytes.

**Change:** After notices are empty, drop lastSeenRoot and gitRemote; if still over cap, return a minimal brief (empty arrays, optional empty notices). Test: maxBytes 200.

**defectClass:** Bootstrap truncation never fail-closes when skeleton/metadata exceeds budget
**sourcesConsulted:** code, memory (bootstrap-byte-cap), context, patterns (consult-skipped)
**proactiveFixed:** src/bootstrap.ts, src/types.ts (optional lastSeenRoot/gitRemote), src/bootstrap.test.ts
**proactiveSkipped:** truncating projectId if identity id itself exceeds the cap
