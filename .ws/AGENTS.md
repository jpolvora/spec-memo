# Shared - Workflow Config & Consumer Data Hub (local pointer)

This project-local pointer keeps the consumer hub stable (.ws/). Managed hub runtime and templates resolve from the project skills install (`{skillsRoot}/ws-shared/`) when present, otherwise from `{globalSkillsRoot}/ws-shared/`; the consumer hub never carries `runtime/` or `templates/` copies. Project consumer data lives in this folder (`STACK.md`, `installed-skills.json`); the bootstrap `config.json` stays fixed at `.ws/config.json` (hub discovery point). MEMORY/changelog live at their configured locations (defaults: repo-root `MEMORY.md` + `memory/`, repo-root `CHANGELOG.md`).

- Full hub contract: `{skillsRoot}/ws-shared/runtime/AGENTS.md` (global fallback `{globalSkillsRoot}/ws-shared/runtime/AGENTS.md`).
- Config always resolves project-local first: `$PWD/.ws/config.json` overrides the global hub.
- `rules.harness` default (`.ws/AGENTS.md`) resolves to this file; follow the canonical runtime link above.
