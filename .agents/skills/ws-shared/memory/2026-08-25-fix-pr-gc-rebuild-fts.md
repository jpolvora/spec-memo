### [2026-08-25] gc rebuiltFts must call rebuildIndex
- **Layer**: Core
- **Module**: curator
- **Severity**: Medium
- **PathPattern**: src/curator.ts
- **Scenario / Context**: `GcResult.rebuiltFts` was set true whenever dryRun was false, but `runGc` never called `rebuildIndex`
- **DO NOT**: Advertise FTS rebuild in gc results without invoking `rebuildIndex`
- **INSTEAD DO**: After compacting/purging, `await rebuildIndex(vaultRoot)` and set `rebuiltFts` from that work
