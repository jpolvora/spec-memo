# Context — mcp-version-and-skill-install

## Feature Boundary

**In:** Two new MCP tools (`check_version`, `install_skills`) with CLI parity; PRODUCT.PRD §6 amendment from 8→10 tools; aligned docs (`AGENTS.md`, `FEATURES.md`, `README.md` tool reference / operator Q&A, `GEMINI.md` if needed); `ws-memo` skill + SURFACE + evals; package ships skill files for install-from-npm; tests for soft-fail version and install default-deny/force.

**Out:** Auto self-update of the binary; installing workflow-skills orch skills; changing `promote format:skill`; CRDT/status features gaining MCP tools; a separate FAQ.md site.

## Implementation Decisions

| Topic | Options | Chosen | Why |
|-------|---------|--------|-----|
| Latest version source | A. npm registry `latest` · B. GitHub Releases API · C. current-only (no compare) | **A** | Matches `npm install -g spec-memo`; no token; soft-fail offline |
| Overwrite policy | A. always overwrite · B. fail if exists unless `force` · C. merge file-by-file | **B** | Matches promote-style caution; agents must opt in to clobber consumer edits |
| Skill source path | A. package-relative `.agents/skills/ws-memo` · B. fetch from GitHub raw · C. require local clone | **A** | Works for global/`npx` installs once files are in the npm tarball |
| Docs “FAQ” | A. new FAQ.md · B. README tool ref + skill section Q&A | **B** | No FAQ file exists; keep one operator entrypoint |

## Deferred Ideas

- `install_skills` dry-run / diff report before write
- Pin install to a specific skill version distinct from package version
- Multi-skill allow-list beyond `ws-memo` when more runtime skills ship
- Background version check notice inside `bootstrap` brief (would touch bootstrap budget)
