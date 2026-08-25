### [2026-08-25] Sanitize MCP error paths too
- **Layer**: Api
- **Module**: tools, safety
- **Severity**: High
- **PathPattern**: src/tools.ts, src/safety.ts
- **Scenario / Context**: Success payloads were sanitized; catch blocks returned raw Error.message with absolute paths
- **DO NOT**: Sanitize only `ok()` data. Safety and promote throws embed filesystem paths in the message
- **INSTEAD DO**: Route every tool error through a `fail()` helper that runs `sanitizeToolOutput` on the message (secrets + absolute paths). Cover sanitizeToolOutput with a unit test
