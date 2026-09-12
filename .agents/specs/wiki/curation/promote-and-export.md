# Record Promotion and Skill Export

## Feature Overview

`promote` copies a vault record into the consumer product repository as durable documentation, or compiles ranked traps into one owner `SKILL.md`. It is the deliberate bridge from private working memory to versioned product docs, and it stays inside a strict default-deny boundary so arbitrary in-repo writes are refused.

Journeys:
- Developer promotes an accepted decision: `memo promote decision-old-auth docs/adr/` → the engine resolves a filename, formats a Nygard ADR, and writes it.
- Agent exports the recurring-gap skill: `memo promote --format skill --to .agents/skills/ws-recurrence/SKILL.md` compiles the top ranked active traps into one file.
- Non-decision record promoted with `format: raw` retains its YAML frontmatter and body verbatim.

Surfaces: MCP `promote`; CLI `memo promote` (positional `<id> <destination>` or flags); the `format: skill` path reuses the recurrence ranking from `memo rank`.

## Business Rules & Logic

**Destination is mandatory and default-deny.** `promoteRecord` requires a non-empty `destination`; a missing destination errors. The resolved target must be inside the consumer product root (`isPathInside`), and the relative path must not be `.git` or under `.git/`. If the resolved target is outside the product root the call errors `Safety violation (Default Deny): Promote destination must be inside consumer product repository (…)`. If the identity root is itself the vault root (or inside it) the call errors because a vault path is not a valid product root.

**Overwrite protection.** If the target file exists and `force` is not set, the call errors `Target destination already exists: … Specify force: true to overwrite existing files.` With `force`, the file is overwritten in place. Parent directories are created as needed. Promotion does not commit to git.

**Formats.** `format` is `raw | adr | madr | skill`. Default when omitted: `adr` for a `kind: decision` record, otherwise `raw`.
- `raw`: `serializeRecord` output — YAML frontmatter plus the verbatim Markdown body.
- `adr`: Nygard-style ADR. H1 `# ADR: <title>`, a metadata block (Status uppercased, Date, Author/Deciders, Tags), `## Context and Problem Statement`, `## Decision Outcome`, and `## Consequences` with positive/negative bullets, plus a generated-by comment.
- `madr`: MADR-style. H1 `<title>`, `* Status`, `* Deciders`, `* Date`, a `Technical Story: \`<id>\`` line, `## Context and Problem Statement`, `## Decision Drivers`, `## Considered Options`, `## Decision Outcome`, and positive/negative consequences.
- `skill`: see below. `adr`/`madr` only apply to decision records; for a non-decision record the code falls back to raw serialization.

**Directory destination resolution.** When `destination` ends with `/` or `\`, or resolves to an existing directory, a filename is generated:
- When the format is `adr`/`madr` **or** the record is `kind: decision` → `<slug>.md` prefixed with `0001-`.
- When the format is `skill` → `SKILL.md`.
- Otherwise → `<slug>.md`.
The slug is `frontmatter.slug || frontmatter.id` (or `decision` when absent). Current code always uses the literal prefix `0001-`; it does not scan the directory to auto-increment.

**Skill export.** With `format: skill` and no `id`/`slug`, `promote` ranks active traps via `rankActiveTraps` (ordering: occurrences desc → lastSeen desc → severity weight desc → id asc), honoring an optional `layer` filter and `limit` (default 10). If no active traps exist and no explicit id was given, it errors `No active traps to compile for skill export. …`. With `id`/`slug` set, only that one trap is compiled. The generated file groups traps by layer; each trap heading includes the title, `occurrences`, `DO NOT`, and `INSTEAD DO` (extracted from a bullet line `**DO NOT**: …` / `**INSTEAD DO**: …` or the matching `##` section; missing rules render `(not specified)`). The header is `# Recurring traps` with a generated-by comment and a load-this-skill instruction.

**Default-deny still applies to skill export.** Missing destination, a destination outside the product tree, or one under `.git/` fails exactly as for other formats.

**Promoted content.** `adr`/`madr` output is pure documentation with no vault metadata block. `raw` output does include frontmatter (internal `id`/`project`/status fields), so it is not metadata-free. Cross-machine/IDE derived-rule promotion (a separate path) uses `assertAllowedIdeRulePromote`, which only permits `.cursor/rules/`, `.github/copilot-instructions.md`, `CLAUDE.md`, and `GEMINI.md`.

**Lookup semantics.** A single-record promotion resolves via `getRecord` using whichever of `id`, `kind`, or `slug` was supplied (with `id`/`slug` combined as the lookup key). A miss errors `Record not found for promotion: <id|kind/slug>`. The original record is read-only during promotion; the vault is never modified.

## Technical Architecture

**Module.** `src/promote.ts` exports `formatAsAdr`, `formatAsMadr`, and `promoteRecord`. `formatAsSkill` and `rankActiveTraps` live in `src/recurrence.ts`. `serializeRecord`/`getRecord`/`listProjectRecords` come from `src/schema.ts` and `src/store.ts`; boundary checks use `isPathInside` from `src/safety.ts`.

**Workflow** (`promoteRecord`): resolve identity/projectId → reject vault-as-product-root → require destination → branch on `format === 'skill'` (rank or single lookup) vs `getRecord` for an explicit id/slug → resolve target path (directory filename rule) → `isPathInside` check → `.git` check → existence + `force` check → `mkdirSync` parent → format content → `writeFileSync`.

**Result contract** (`PromoteResult`): `id`, `kind`, `destination` (product-relative POSIX path), `targetPath` (absolute), `bytesWritten`, `format`. For a skill export the primary id is the first ranked trap, or `skill-export` when none.

**MCP contract.** `promote` input: `id?`, `kind?`, `slug?`, `destination` (required), `format?` (`raw|adr|madr|skill`), `force?`, `limit?`, `cwd?`. `PromoteOptions` additionally carries `projectId`, `vaultRoot`, and `layer` (used by skill ranking); `layer` is not currently exposed in the MCP input schema.

**CLI contract.** `memo promote [id] [destination]` with `--to <path>` / `--format <raw|adr|madr|skill>` / `--force` / `--limit <n>` / `--json`. Positional arguments fill `id` and `destination` when the corresponding flags are absent.

**Side effects.** Exactly one file write (and parent directory creation) inside the product repository; no vault mutation, no git commit, no auto-install into skill directories. The destination is product-relative in the response, not an absolute vault path.

**Provenance.** `0020-promote-adr.spec.md` (ADR/MADR templates, default ADR format for decisions, directory → `0001-<slug>.md` resolution, default-deny/`.git`/force rules) and `0022-trap-recurrence.spec.md` (adds `format: skill` top-N compilation). Current code keeps the `0001-` prefix fixed rather than auto-numbering, and `raw` promotions retain frontmatter.
