### [2026-08-25] Bootstrap fail-closed when skeleton exceeds budget
- **Layer**: Core
- **Module**: bootstrap
- **Severity**: High
- **PathPattern**: src/bootstrap.ts
- **Scenario / Context**: Truncation dropped traps, decisions, activeSlice, drift, and notices but still returned lastSeenRoot/gitRemote so byteLength could exceed budgetBytes
- **DO NOT**: Stop truncation after content arrays; do not return truncated:true while the JSON skeleton is still over budget
- **INSTEAD DO**: After notices are gone, drop lastSeenRoot and gitRemote, then return a minimal brief (empty traps/decisions) so byteLength is always <= budgetBytes
