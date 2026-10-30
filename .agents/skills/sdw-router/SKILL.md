---
name: sdw-router
description: Always-autoloaded router that dispatches user prompts and intents across all SDW skills.
version: 0.1.0
invocation_names:
  - sdw-router
  - sdw-router scan
  - sdw-router route
  - sdw-router doctor
  - router
---
# sdw-router

> When this skill is loaded, output "sdw-router loaded."

Always-autoloaded entrypoint and traffic controller routing agent tasks across all available Spec-Driven Workflow (SDW) skills.

## Subcommands

- `scan`: Discovers all installed SDW skills across canonical, consumer, and global (`$HOME/.agents/skills`) locations.
- `route <prompt>`: Evaluates prompt intent, checks explicit invocations, and routes to the target skill.
- `doctor`: Validates router health, skill directory integrity, and reports missing or broken skill paths.

## Routing Matrix

| Intent / Keywords | Routed Skill | Description |
|---|---|---|
| Project configuration, environment check, `.sdw/config.json`, dry-run | `sdw-config` | Workspace initialization and settings management |
| Spec authoring, grilling, EARS formatting, PRD index, validation, sync, archiving | `sdw-spec` | Specification lifecycle and quality gates |
| Installation health, missing skill, hybrid/global install check, workspace doctor | `sdw-doctor` | Read-only installation and workspace audit |
| Spec implementation, orchestration, DAG tasks, scoring, review, PR | `sdw-run` | End-to-end implementation and delivery pipeline for one specification |
| Multiple specifications, spec queue, batch, sequential delivery | `sdw-batch` | Loops a specification list through single `sdw-run` runs |
| Behavioral rules, simplicity, YAGNI, anti-overengineering, trap log | `sdw-rules` | Shared engineering principles, simplicity, and traps |
| Secret scanning, credentials leak check, pre-commit leak gate | `sdw-security-checks` | Pre-commit secrets and credentials leak scanner |
| Deep working-tree code review, review fix planning, code-review | `sdw-code-review` | Standalone review, executable fix plans, and `sdw-run` Step 7 delegation |
| Unrecognized or general coding / conversation | *(Pass-through)* | Allows standard agent execution without intercepting |

**Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) — planning, authorization, and scope — before routing or dispatching anything.

## Steps

1. **Scan Available Skills**
   Discover skills installed under `{projectRoot}/skills/` (canonical), `{projectRoot}/.agents/skills/` (consumer), and `$HOME/.agents/skills/` (global/hybrid).
   - Run: `node skills/sdw-router/scripts/sdw_router.cjs scan [--json]`
   - Done when: Discovered skills list is returned with presence and readability status.

2. **Evaluate Prompt Intent & Resolve Target Skill**
   Analyze user input against explicit invocations (`/sdw-*`, `@sdw-*`), keyword intents, and tied-confidence ambiguity.
   - Run: `node skills/sdw-router/scripts/sdw_router.cjs route "<prompt>" [--json]`
   - If explicit invocation: Direct execution honored immediately.
   - If tied confidence: Query user via `ask_question` with candidate options and recommended default.
   - If target skill directory missing on disk: Report actionable error naming the missing directory.
   - If no recognized skill intent: Pass through cleanly without hijacking.
   - Done when: Target skill is determined or pass-through signal is returned.

3. **Dispatch Target Skill**
   Load and invoke the selected skill (`sdw-config`, `sdw-spec`, `sdw-run`, or `sdw-code-review`) with the user's intent.
   - Done when: Target skill execution is initiated.

## References

- Detailed intent dispatch table and ambiguity handling: [`references/routing_table.md`](references/routing_table.md)
- Consumer autoload configuration (wiring the router into a repository's agent instructions): [`references/consumer_agents_setup.md`](references/consumer_agents_setup.md)
