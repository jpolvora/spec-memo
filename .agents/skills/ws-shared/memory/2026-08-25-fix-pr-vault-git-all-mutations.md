### [2026-08-25] Vault git commit on every mutation
- **Layer**: Core
- **Module**: store, curator
- **Severity**: Medium
- **PathPattern**: src/store.ts, src/curator.ts
- **Scenario / Context**: vaultGit auto-commit ran only from upsertRecord
- **DO NOT**: Call commitVaultChange from upsert only. forget, append, and gc also mutate vault files
- **INSTEAD DO**: Call commitVaultChange after appendEvent, forgetRecord (purge and archive), and live runGc
