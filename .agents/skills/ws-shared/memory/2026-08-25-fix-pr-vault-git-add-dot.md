### [2026-08-25] Vault git auto-commit must not git add .
- **Layer**: Core
- **Module**: vault
- **Severity**: Medium
- **PathPattern**: src/vault.ts, src/store.ts, src/curator.ts
- **Scenario / Context**: vaultGit auto-commit used `git add .` so unrelated dirty vault files were swept into every mutation commit
- **DO NOT**: Stage the entire vault tree with `git add .` (or an empty/`.` path) inside commitVaultChange
- **INSTEAD DO**: Stage only mutation-scoped paths (`projects/<projectId>` from callers; default `projects` + `config.json`) and reject `.` / parent-relative paths
