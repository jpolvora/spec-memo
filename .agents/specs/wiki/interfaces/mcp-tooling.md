# MCP Version & Skill Installation Tools

## Feature Overview

Two operational MCP tools, `check_version` and `install_skills`, let agents detect stale installs and install the packaged runtime skills into a consumer tree. Both have 1:1 CLI parity (`memo check-version`, `memo install-skills`). They were added by amending the frozen tool surface; the current surface is 11 tools.

Journeys:

- Detect a stale global install or long-lived daemon: MCP `check_version` / `memo check-version --json`.
- Install the runtime skill after cloning a consumer repo: `memo install-skills --product-root /path/to/consumer --scope local --host cursor --conflictPolicy update --yes`.

## Business Rules & Logic

`check_version`:

- Input: none.
- Output (`CheckVersionResult`): `current` (running package version from `package.json`), `latest` (semver string or `null`), `updateAvailable` (`true` | `false` | `"unknown"`), and `source` (`"npm"` | `"offline"`).
- Latest source is the npm registry `https://registry.npmjs.org/spec-memo/latest` with a 3000 ms timeout (`AbortController`).
- Offline soft-fail: if the registry is unreachable, times out, returns non-OK, or omits `version`, the call still succeeds with `latest: null`, `updateAvailable: "unknown"`, `source: "offline"`. It never throws a hard tool error solely for network failure.
- Comparison uses semver core only (major/minor/patch); a leading `v`, prerelease, and build metadata are ignored. `updateAvailable` is `true` iff `latest` is strictly newer than `current`; equal versions yield `false`.

`install_skills`:

- Write permission gate: the tool fails closed unless `confirm: true` and explicit `scope`, `hosts`, and `conflictPolicy` are supplied. The error code is `INSTALL_SKILLS_PERMISSION_REQUIRED` and names the missing fields; no files are written. `hosts: ["all"]` is allowed only with `confirm: true`.
- Defaults: `skills: ["ws-memo", "ws-session-tracking"]`; local `skillsRoot: ".agents/skills"`.
- Allowed skill ids are `ws-memo` and `ws-session-tracking`; an unknown id throws (`Unknown skill id`). The packaged tree is read from `<packageRoot>/.agents/skills/<skill>` and must contain `SKILL.md`.
- `scope: local` copies into `{productRoot}/{skillsRoot}/<skill>`; when hosts are selected it also copies into each selected host's skill root (Cursor `.cursor/skills`, Antigravity `.gemini/config/skills`, Codex `.codex/skills`, OpenCode `.opencode/skills`, Claude `.claude/skills`). `productRoot` or `cwd` is required.
- `scope: global` selects only explicit hosts; the legacy `global: true` path (no host list) writes `$HOME/.agents/skills` and includes `$HOME/.gemini/config/skills` only when the Gemini config tree exists. With an explicit host list alone, Antigravity is not inferred.
- Conflict policy: `skip` leaves a differing destination and reports `skipped`; `update` overwrites identical/missing and packaged (stamped `managedBy: spec-memo`) trees and refuses foreign trees with `refused`; `force` overwrites with tree replacement. Without any policy, a differing destination throws unless `force: true`.
- Safety: the destination must stay inside the product root and must never overlap the vault (dest equal to, inside, or a parent of the vault is denied). `.git` destinations are rejected. `skillsRoot` must be a relative path with no `..` segments.
- Idempotency: an identical destination tree reports `unchanged`; `dryRun` reports `preview` without writing.
- Result (`InstallSkillsResult`): `mode` (`local` | `global`), `productRoot`, `skillsRoot`, `installed` rows (`skill`, `destination`, `identical`, `bytesWritten`, `status`, `target`), `status` (`applied` | `preview`), `scope`, `hosts`, `conflictPolicy`, `preflight`, and global `skippedTargets`.
- `dryRun` is available programmatically; MCP callers that omit `confirm` cannot write.

Package integrity: the packaged `ws-memo`/`ws-session-tracking` skill versions must match `package.json`; a test asserts this. Installing must never write vault records into the product tree — only the skill directory under `{skillsRoot}`.

CLI examples:

```bash
memo check-version --json
memo install-skills --product-root /path/to/consumer \
  --scope local --host cursor --conflictPolicy update --yes
memo install-skills --scope global --host cursor,antigravity --conflictPolicy force --yes
memo install-skills --scope local --host codex --dry-run --json
```

Notes and boundaries: `promote` with `format: skill` exports ranked traps into an owner `SKILL.md` and is a separate path from installing the packaged `ws-memo` skill. Future packaged skills may be added to the allow-list without a new MCP tool; v1 allows only `ws-memo` and `ws-session-tracking`. There is no auto-upgrade/self-update: `check_version` only reports; installing the updated binary stays operator-driven (`npm i -g spec-memo`). Consumer `specMemo.enabled` setup remains the workflow-skills `ws-spec-memo` bridge, not this tool.

## Technical Architecture

- `src/version.ts`: `getPackageRoot`, `getPackageVersion`, `isSemverNewer`, `fetchNpmLatest`, `checkVersion`. `CheckVersionOptions.fetchLatest` and `timeoutMs` are test hooks.
- `src/tools.ts`: `check_version` (no inputs) and `install_skills` definitions with required `scope`, `hosts`, `conflictPolicy`, `confirm`. `executeTool` validates with Zod, then calls `checkVersion` or `installSkills` after `normalizeInstallHosts`.
- `src/skills-install.ts`: `ALLOWED_SKILLS`, `packagedSkillDir`, `listRelativeFiles`, `treesIdentical`, `copyTree`, `removeTree`, `isPackagedSkillTree`, `assertDestDoesNotOverlapVault`, `resolveGlobalSkillTargets`, `resolveSkillInstallTargets`, `installSkills`.
- `src/install-wizard.ts`: `normalizeInstallHosts` (accepts aliases, rejects `all` without permission), `getInstallPreflight`, `resolveMemoCommand`.
- CLI: `memo check-version` maps to `check_version`; `memo install-skills` maps to `install_skills` and adds wizard, `--scope`, `--host`, `--skills`, `--skills-root`, `--conflictPolicy`/`--force`/`--skip-existing`/`--update`, `--yes`/`--confirm`, and `--dry-run`. JSON without confirmation is preview-only.
- Provenance: `0024-mcp-version-and-skill-install.spec.md`; host/permission details evolved in `0048-install-hooks-skills-interactive.spec.md`.
