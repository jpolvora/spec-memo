---
id: null
slug: mcp-version-and-skill-install
title: "MCP tools: check_version and install_skills (+ docs surface)"
source: local
specDate: 2026-08-26
status: completed
target_phase: Phase 6
---

# Specification — MCP tools: check_version and install_skills (+ docs surface)

## Description

Agents and operators need two operational capabilities that are awkward today:

1. **Know whether the running spec-memo binary/MCP server is current** — compare the embedded package version against the latest published version so stale global installs and long-lived SSE daemons are visible.
2. **Install the shipped `ws-memo` runtime skill into a consumer product tree** — today README tells humans to manually copy/symlink [`.agents/skills/ws-memo/`](.agents/skills/ws-memo/); agents have no first-class tool for that.

This slice **amends the frozen 8-tool MCP surface** (PRODUCT.PRD §6 / FEATURES §4) to **10 tools** by adding:

| Tool | Job |
|------|-----|
| `check_version` | Report running version, latest known version, and whether an update is available |
| `install_skills` | Copy packaged spec-memo skill(s) (starting with `ws-memo`) into a consumer `{skillsRoot}` |

Both tools get **CLI 1:1 parity** (`memo check-version`, `memo install-skills`) like the existing eight.

The same delivery **must** update the product documentation and agent surface so nothing still claims “exactly 8 tools” / “do not invent a ninth MCP tool” without the PRD amendment: `PRODUCT.PRD`, `FEATURES.md`, `AGENTS.md`, `README.md` (including Command & Tool Reference / operator Q&A), `GEMINI.md` if it mirrors tool counts, `ws-memo` skill + `references/SURFACE.md` + evals, MCP tool descriptions in `src/tools.ts` / handshake tests, and tracking docs (`PLAN.md` Done log when shipped).

Design gray areas: [`mcp-version-and-skill-install.context.md`](mcp-version-and-skill-install.context.md).

### Layer: mcp-cli / policy / docs

- Tool schemas + handlers + CLI (`src/tools.ts`, `src/types.ts`, `src/mcp.ts`, `src/cli.ts`, new small modules as needed)
- Skill packaging for npm consumers (ensure `.agents/skills/ws-memo/**` is published with the package)
- Docs and skill text aligned to the 10-tool surface

### Design Intent

Greenfield tools (not restoring a prior behavior). Skip `git log -L` restoration analysis: no previous `check_version` / `install_skills` symbols. Prior “frozen at 8” wording was an intentional PRD constraint; this slice **explicitly amends** that constraint rather than bypassing it.

## Acceptance Criteria

### Product — `check_version`

- AC1: MCP tool `check_version` is registered in `TOOL_NAMES` / `TOOL_DEFINITIONS` and listed by the MCP handshake alongside the existing eight tools (total **10** tools).
- AC2: `check_version` returns structured JSON including at least: `current` (semver string from the running package), `latest` (semver string or `null`), `updateAvailable` (`true` \| `false` \| `"unknown"`), and `source` describing how `latest` was obtained (`npm` \| `offline` \| equivalent).
- AC3: When the npm registry (or chosen latest-source) is unreachable or times out, `check_version` still succeeds with `current` populated, `latest: null`, and `updateAvailable: "unknown"` (fail soft on network; never throw a hard tool error solely for offline/registry failure).
- AC4: When `latest` is available, `updateAvailable` is `true` iff `latest` is strictly newer than `current` by semver precedence; equal versions yield `false`.
- AC5: CLI `memo check-version` maps 1:1 to the tool; `--json` prints the structured payload on stdout.

### Product — `install_skills`

- AC6: MCP tool `install_skills` is registered and callable with required `productRoot` (or `cwd` that resolves to a product root) and optional `skills` (string array; default `["ws-memo"]`), optional `force` (boolean, default `false`), and optional `skillsRoot` relative segment (default `.agents/skills`).
- AC7: For skill id `ws-memo`, the tool copies the **packaged** skill tree (SKILL.md + `references/` + `evals/` as shipped) from the installed spec-memo package into `{productRoot}/{skillsRoot}/ws-memo/`, creating parent directories as needed.
- AC8: Without `force: true`, if the destination skill directory already exists and differs from the packaged content, the tool fails closed with a clear error and does not partially overwrite; with `force: true`, it replaces the destination skill tree.
- AC9: `install_skills` refuses destinations outside the resolved product root (same default-deny spirit as `promote`) and refuses to treat the vault root as a product destination.
- AC10: Idempotent happy path: installing into an empty target (or identical existing tree) succeeds and returns the destination path(s) written.
- AC11: CLI `memo install-skills --product-root <path> [--skill ws-memo] [--force] [--json]` maps 1:1 to the tool.
- AC12: The published npm package includes the `ws-memo` skill files so a global/`npx` install can run `install_skills` without a git checkout of spec-memo.

### Docs, tools descriptions, FAQ, skills (same slice)

- AC13: `PRODUCT.PRD` § MCP tools is amended to list all **10** tools (`bootstrap` … `promote`, plus `check_version`, `install_skills`) and the “do not grow without §6 amendment” note reflects this approved growth.
- AC14: `FEATURES.md` § MCP tools table adds both tools as shipped capabilities; any “ninth tool” / “exactly 8” status language is updated to the 10-tool surface.
- AC15: `AGENTS.md` “exactly 8 core tools” section documents both new tools (purpose, parameters, CLI examples) and updates the tool count / router text accordingly.
- AC16: `README.md` Agent skill section prefers `memo install-skills` / MCP `install_skills`; manual copy/symlink may remain only as a fallback note.
- AC17: `README.md` Command & Tool Reference lists `check_version` and `install_skills` with purpose and primary flags/args.
- AC18: `README.md` includes operator Q&A (FAQ surface) covering: how to check latest version, and how to install `ws-memo` into a consumer (no new `FAQ.md` required).
- AC19: `.agents/skills/ws-memo/SKILL.md`, `references/SURFACE.md`, and `evals/evals.json` document the **10**-tool surface and both new tools (router intents + args).
- AC20: `ws-memo` skill text removes or rewrites “frozen at 8” / “does not invent a ninth MCP tool” assertions that contradict the amended PRD.
- AC21: New tools’ MCP `description` strings state version-compare and consumer skill-install purpose clearly for agents.
- AC22: Handshake / listTools tests that hard-code “8 tools” are updated to expect **10**.
- AC23: `GEMINI.md`, when it states MCP tool count or lists tools, matches the 10-tool surface in `AGENTS.md`.
- AC24: Automated tests cover version payload + offline soft-fail; install into temp product root; refuse outside product root; refuse overwrite without `force`; force overwrite; listTools length 10.

## Original Issue Context

### Prior Work Sweep

- Keyword / git: no existing `check_version` or `install_skills` MCP tools. Closest surfaces:
  - README manual “Copy or symlink … `{skillsRoot}/ws-memo/`” (human install).
  - `promote` `format:skill` — exports **ranked traps** into an owner `SKILL.md`; **not** installing packaged `ws-memo`.
  - Package version `0.2.0` in `package.json` / `src/mcp.ts` / vault config — no registry compare tool.
- Related commits: `28b44a7` (introduce ws-memo skill), `0d36f15` (bump 0.2.0), `30f22f3` (8 MCP tools skeleton).
- GitHub issue/PR search for “version check” / “install skill” on `jpolvora/spec-memo`: no exact open duplicate found at authoring time.
- Historical specs (`trap-recurrence`, `mcp-status-monitor`) intentionally avoided a ninth MCP tool; this slice **amends** that constraint via PRODUCT.PRD.

### Design Intent

Intentional prior constraint: keep MCP surface at 8 tools unless PRODUCT.PRD §6 is amended. This feature is that amendment plus two ops tools and full docs/skill alignment — not an accidental bypass of the freeze.

## Notes

- `install_skills` writes **into the consumer product tree by design** (like `promote`). It must not write vault records under the product tree; only the skill directory tree under `{skillsRoot}`.
- Consumer **setup** (`specMemo.enabled`, hybrid MEMORY) remains workflow-skills `ws-spec-memo`; this tool only installs the **runtime** `ws-memo` skill package.
- Future packaged skills may be added to the default/allow-list without a new MCP tool; out of scope to invent additional skill ids in v1 beyond `ws-memo`.
- Status-monitor (and similar) specs that say “not a ninth MCP tool” for **their** features remain valid for those features; implementers should not rewrite those historical non-goals except where global “exactly 8” docs must change.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Auto-upgrade / self-update of the running binary | Version check only; install remains operator-driven (`npm i -g spec-memo`) |
| Installing workflow-skills hub (`ws-spec-memo`, orch skills) | Different package; consumer setup stays in workflow-skills |
| `promote format:skill` changes | Trap-export path stays separate from packaged skill install |
| SaaS license server or signed skill marketplace | Local filesystem copy from the installed npm package |
| Rewriting historical feature specs’ “no ninth tool” non-goals for unrelated slices | Only amend global product docs + this PRD surface |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Latest-version source | Query npm registry package `spec-memo` `latest` dist-tag; on failure soft-fail per AC3 | Matches publish channel; no GitHub API token required | n |
| Tool names | `check_version` and `install_skills` (CLI: `check-version`, `install-skills`) | Clear agent intent; CLI kebab matches existing style | n |
| Default skill set | Only `ws-memo` in v1 allow-list; unknown skill ids fail closed | Single shipped skill today | n |
| FAQ artifact | Update README Command & Tool Reference + agent-skill / troubleshooting prose; no new `FAQ.md` unless one already exists | Repo has no FAQ file today | n |
| Auth / rate limits | Same as other local tools: no extra MCP auth; npm fetch uses short timeout, no retry storm | Local-first; offline soft-fail | n |
| Other implicit dimensions | N/A because concurrency, TTL, and state-machine concerns do not apply beyond idempotent filesystem install and one-shot version fetch | Scoped ops tools | n |
