### [2026-08-25] Empty pathPatterns must not wildcard trap dedup
- **Layer**: Core
- **Module**: store
- **Severity**: Medium
- **PathPattern**: src/store.ts
- **Scenario / Context**: Dedup used `samePatterns || newPatterns.length === 0`, matching empty new traps against patterned existing traps
- **DO NOT**: Treat an empty `pathPatterns` array as a wildcard for supersession
- **INSTEAD DO**: Require identical pathPatterns (`samePatterns`) before the 70% body-overlap check
