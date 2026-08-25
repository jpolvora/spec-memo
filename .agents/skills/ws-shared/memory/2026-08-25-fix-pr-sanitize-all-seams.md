### [2026-08-25] Sanitize every caller-facing seam, not only executeTool
- **Layer**: Api
- **Module**: adapter, curator, store
- **Severity**: High
- **PathPattern**: src/adapter.ts, src/safety.ts, src/store.ts, src/curator.ts
- **Scenario / Context**: After stripping vault paths in MCP executeTool, MemoryAdapter, GcResult.details arrays, and append/forget/gc still leaked paths or raced without the vault lock
- **DO NOT**: Stop a path-leak or lock fix at one entrypoint (executeTool or upsertRecord) while sibling caller-facing APIs keep the old contract
- **INSTEAD DO**: Apply sanitizeToolOutput to MemoryAdapter returns, omit purgedFiles/compactedPlans from caller output, and take withVaultLock on appendEvent, forgetRecord, and runGc
