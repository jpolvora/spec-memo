### [2026-08-25] Vault filesystem paths in MCP/CLI output
- **Layer**: Api
- **Module**: tools
- **Severity**: High
- **PathPattern**: src/tools.ts, src/safety.ts
- **Scenario / Context**: Search hits and upsert/get/promote results exposed absolute vault paths
- **DO NOT**: Serialize `path`, `filepath`, or `targetPath` in caller-facing MCP/CLI JSON
- **INSTEAD DO**: Sanitize tool output (redact secrets, strip vault path keys) at `executeTool`. Keep vaultRoot on internal zod schemas, omit it from advertised MCP inputSchema.
