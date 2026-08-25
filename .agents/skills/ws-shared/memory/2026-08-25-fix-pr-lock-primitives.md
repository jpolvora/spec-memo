### [2026-08-25] Take vault lock at shared primitives
- **Layer**: Core
- **Module**: indexer, vault
- **Severity**: Medium
- **PathPattern**: src/indexer.ts, src/vault.ts, src/doctor.ts, src/importer.ts
- **Scenario / Context**: Locking upsert/append/gc left doctor --rebuild, import FTS rebuild, and syncVault unlocked
- **DO NOT**: Wrap only the first caller of a mutation. Review bots will keep filing sibling entrypoints
- **INSTEAD DO**: Take `.memo.lock` inside `rebuildIndex` and `syncVault` so doctor, import, gc, and git sync share one serialization point
