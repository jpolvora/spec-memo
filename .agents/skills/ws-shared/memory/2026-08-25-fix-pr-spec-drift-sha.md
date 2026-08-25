### [2026-08-25] Spec drift last-touch SHA vs verifiedAtSha
- **Layer**: Core
- **Module**: bootstrap
- **Severity**: High
- **PathPattern**: src/bootstrap.ts
- **Scenario / Context**: Drift detection compared `git log -n 1` (last-touch commit) to spec-wide `verifiedAtSha`
- **DO NOT**: Compare a file's latest commit SHA to the spec verification SHA. Unrelated later commits make every healthy spec look drifted.
- **INSTEAD DO**: Compare file content at `verifiedAtSha` (`git show SHA:path`) to the working tree, plus porcelain status for uncommitted edits.
