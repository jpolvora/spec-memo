### [2026-08-25] Bootstrap truncation must honor byte cap
- **Layer**: Core
- **Module**: bootstrap
- **Severity**: High
- **PathPattern**: src/bootstrap.ts
- **Scenario / Context**: Truncation dropped traps/decisions only, leaving huge activeSlice/drift payloads over the 8 KB budget
- **DO NOT**: Return `truncated: true` while the JSON payload still exceeds `budgetBytes`
- **INSTEAD DO**: After dropping traps and decisions, trim activeSlice (state, plan, spec) then drift until `calculatePayloadSize(brief) <= budgetBytes`
