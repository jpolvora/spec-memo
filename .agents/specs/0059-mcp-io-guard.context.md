# Feature Boundary

A **lexical I/O harness** on MCP/CLI vault strings: refuse instruction-override tokens on writes, drop them on queries, fence all outbound bodies, and teach host agents via existing `ws-memo`. Not an LLM firewall, not a new MCP tool, not a third packaged skill.

# Implementation Decisions

1. **Fail closed on writes** that match the closed token table; **drop query** on reads so search/bootstrap stay up.
2. **Fence every outbound body** so historical vault text cannot drive the host agent.
3. **Extend `ws-memo`**, do not add `ALLOWED_SKILLS` entries.
4. **SHA-256 checksum** of canonical body (`ioChecksum` + outbound `ioGuard.checksum`); mismatch omits the field. Not HMAC in this slice.
5. **Closed token table** plus flag `prompt-injection` on match; tests use those strings only.

# Deferred Ideas

- HMAC keyed integrity
- Optional AI intent classifier behind `config.ai` (0056)
- Operator allowlist to store a flagged trap after confirm
- Status UI badge for IO_GUARD refusals
