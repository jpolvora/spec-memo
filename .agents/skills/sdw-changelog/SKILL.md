---
name: sdw-changelog
description: Record completed task delivery history by appending prompt, work, and result entries to the project changelog.
version: 0.1.0
invocation_names:
  - sdw-changelog
---
# sdw-changelog

> When this skill is loaded, output "sdw-changelog loaded."

Appends an append-only delivery record for a completed task to the project changelog.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before changing project files.

## Behavior

- Resolves `.sdw/config.json` from the project root.
- While `changelogEnabled` is `false`, exits `0` with `skipped: disabled` and does not touch any file.
- `changelogFile` selects the target path; when absent, the target is `{projectRoot}/CHANGELOG.md`.
- Creates the changelog file and any missing parent directory.
- Inserts the new entry directly below `# Changelog`; existing entries stay byte-identical.
- Skips an identical Prompt/Done/Result block and reports `skipped: duplicate-block`.

## Steps

1. **Collect the delivery record**
   Summarize the request (`--prompt`), the work performed (`--done`), and the outcome (`--result`).
   - Done when: all three values are non-empty.

2. **Append the entry**
   ```bash
   node skills/sdw-changelog/scripts/append_changelog.cjs --prompt "<intent>" --done "<work>" --result "<outcome>" [--agent <id>] [--date "YYYY-MM-DD HH:MM"] [--root <path>] [--json]
   ```
   - Done when: the command exits `0` and prints the resolved changelog path.

3. **Report the outcome**
   Name the resolved changelog path. When the command reports `skipped: disabled`, tell the caller that delivery history is disabled.
   - Done when: the caller knows whether an entry was written.

## Reference

- Entry format, configuration keys, and output: [`references/entry_contract.md`](references/entry_contract.md)
- Deterministic writer: [`scripts/append_changelog.cjs`](scripts/append_changelog.cjs)
