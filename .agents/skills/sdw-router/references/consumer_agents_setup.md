# Consumer Project Setup — Configuring `sdw-router` in `AGENTS.md`

This guide explains how consumer repositories configure `sdw-router` as an always-autoloaded entrypoint.

---

## 1. Minimal Context Budget Rationale

Modern LLMs provide powerful reasoning and planning capabilities. Traditional monolithic prompt instructions consume thousands of tokens on every interaction, causing context exhaustion and higher latency.

The Spec-Driven Workflow (SDW) architecture adopts a **progressive disclosure** model:
- **Tier 1 (`SKILL.md`)**: A compact dispatch table under 120 lines that activates on session start.
- **Tier 2 (`references/`)**: Deep domain documentation and schemas loaded only when a specialized skill is invoked.
- **Tier 3 (`scripts/`)**: Deterministic Node.js helpers executing discrete commands with empirical exit codes.

By autoloading only `sdw-router`, consumer projects gain intelligent routing across all skills while preserving 95%+ of the agent's context window.

---

## 2. Copy-Paste Setup for Consumer `AGENTS.md`

Add the following section to your repository's root `AGENTS.md` (or `.agents/AGENTS.md`):

```markdown
## Spec-Driven Workflow (SDW) Autoload

This repository uses Spec-Driven Workflow for spec management, configuration, and implementation.

- **Autoload SDW Router:** At the start of every session or when receiving task instructions, inspect and apply `@.agents/skills/sdw-router/SKILL.md` for vendored installs, or `@~/.agents/skills/sdw-router/SKILL.md` for hybrid/global installs. Replace the path with the resolved skills root for your topology.
- **Routing Protocol:**
  - Route configuration and environment inquiries to `sdw-config`.
  - Route specification authoring, formatting, validation, and indexing to `sdw-spec`.
  - Route specification implementation, orchestration, and delivery commits to `sdw-run`.
  - Route deep working-tree code review, fix planning, and slash commands (`/sdw-code-review`) to `sdw-code-review`.
  - Pass through general conversational or non-SDW code editing tasks without interception.
```

### Installation Topology & `{skillsRoot}` Resolution

Configure the autoload instruction in `AGENTS.md` by substituting the path corresponding to your installation topology:
- **Local Mode (Vendored):** Skills live inside `{projectRoot}/.agents/skills/` (or `{projectRoot}/skills/` in SDW development). Autoload target: `@.agents/skills/sdw-router/SKILL.md`.
- **Hybrid Mode (Global):** Skills are installed once globally in `$HOME/.agents/skills/` and shared across multiple projects, while each project retains its own isolated `.sdw/` directory. Autoload target: `@~/.agents/skills/sdw-router/SKILL.md`.

*(Note: Within `.sdw/config.json`, the `{skillsRoot}` token is expanded automatically at runtime by the SDW CLI tools. However, Markdown instruction files like `AGENTS.md` are evaluated directly by agent harnesses, so concrete relative or tilde-prefixed paths must be specified explicitly.)*

---

## 3. Harness Compatibility Guide

Because SDW is strictly agent-agnostic and harness-agnostic, the router operates seamlessly across all major AI agent environments:

| Harness / Tool | Instruction File | Invocation Format |
|---|---|---|
| **Antigravity / Gemini IDE** | `AGENTS.md` or `.agents/skills/` | Automatic autoload / slash commands `/sdw-*` |
| **Claude Code** | `CLAUDE.md` / `AGENTS.md` | Slash commands `/sdw-*` or prompt matching |
| **Cursor** | `.cursorrules` or `.cursor/rules/` | Rule inclusion or `@sdw-router` mention |
| **OpenCode** | `AGENTS.md` or `.opencode/` | Standard markdown autoload |
| **Windsurf** | `.windsurfrules` | Rules inclusion or `@sdw-router` |
| **Generic CLI / Copilot** | Root `AGENTS.md` | Universal markdown prompt parsing |

---

## 4. Verification

To verify that the router is functioning in your consumer project:

1. Run the router health check:
   ```bash
   node .agents/skills/sdw-router/scripts/sdw_router.cjs doctor
   ```
2. Test a sample routing query:
   ```bash
   node .agents/skills/sdw-router/scripts/sdw_router.cjs route "implement spec 001"
   ```
   Expected output:
   ```
   [sdw-router] Matched intent -> sdw-run (confidence: 1.0)
   ```
