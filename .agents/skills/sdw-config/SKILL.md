---
name: sdw-config
description: Manage .sdw project configuration and directory structure. Trigger when initializing .sdw in a project, verifying .sdw structure, or parsing .sdw/config.json.
version: 0.1.0
invocation_names:
  - sdw-config
  - sdw-config init
  - sdw-config check
  - sdw-config parse
---
# sdw-config

> When this skill is loaded, output "sdw-config loaded."

Manages `.sdw/` workspace configuration and directory structure for consumer projects.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before changing configuration or files.

## Subcommands

- `init`: Scaffolds `.sdw/`, `.sdw/specs/`, `config.json`, and `directory-structure.md`.
- `check`: Verifies `.sdw/` existence, JSON validity, required keys, and directory conformance.
- `parse`: Resolves path tokens (such as `{projectRoot}`) in `config.json` and outputs effective configuration.

The active skills directory is resolved from `--skills-root`, then `SDW_SKILLS_ROOT`, then `config.json` `skillsRoot`, then auto-detection (canonical, consumer, global `$HOME/.agents/skills`), and reported as `skillsRoot` + `skillsMode` in `check`/`parse` JSON output.

## Steps

1. **Identify Subcommand and Target Root**
   Determine the target consumer project root (`--root <path>`, default: current working directory) and the required operation:
   - To scaffold a project: select `init`.
   - To audit or validate configuration integrity: select `check`.
   - To read effective resolved paths: select `parse`.
   - Done when: Target project root and subcommand are established.

2. **Execute Deterministic Tool Helper**
   Invoke `sdw_config.cjs` using an explicit `node` launcher:
   - For `init`:
     ```bash
     node skills/sdw-config/scripts/sdw_config.cjs init [--root <path>] [--force] [--json]
     ```
   - For `check`:
     ```bash
     node skills/sdw-config/scripts/sdw_config.cjs check [--root <path>] [--json]
     ```
   - For `parse`:
     ```bash
     node skills/sdw-config/scripts/sdw_config.cjs parse [--root <path>] [--key <keyName>] [--json]
     ```
   - Done when: Helper exits with code 0 on success, or non-zero on failure with reported diagnostics.

3. **Handle Results and Remediation**
   Evaluate output:
   - On `init`: Confirm created paths (`.sdw/specs/`, `.sdw/config.json`, `.sdw/directory-structure.md`).
   - On `check` failure (exit 1): Present failed checks and report remediation (e.g., execute `init` if `.sdw/` is missing, or fix syntax error in `.sdw/config.json`).
   - On `parse`: Provide resolved paths to caller or downstream skills.
   - Done when: Results are displayed and any required remediation step is communicated.

## Reference

- Schema specifications and path token definitions: [`references/config_spec.md`](references/config_spec.md)
