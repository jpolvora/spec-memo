# sdw-changelog Entry Contract

Deterministic contract for [`append_changelog.cjs`](../scripts/append_changelog.cjs).

## CLI

```bash
node skills/sdw-changelog/scripts/append_changelog.cjs \
  --prompt "<intent>" --done "<work>" --result "<outcome>" \
  [--agent <id>] [--date "YYYY-MM-DD HH:MM"] [--root <path>] [--json]
```

- `--prompt`, `--done`, `--result`: required delivery record text.
- `--agent`: agent or runtime identifier; defaults to `agent`.
- `--date`: explicit timestamp; defaults to the current local time.
- `--root`: project root; defaults to the nearest ancestor containing `.sdw/` or `.git/`.
- `--json`: prints a structured result instead of a status line.

## Entry format

```markdown
### [YYYY-MM-DD HH:MM] Agent: {agent}
- **Prompt**: …
- **Done**: …
- **Result**: …
```

The new entry is inserted immediately below `# Changelog`. Existing entries below it are preserved unchanged.

## Configuration

Read from `{projectRoot}/.sdw/config.json`:

| Key | Type | Default | Behavior |
|-----|------|---------|----------|
| `changelogEnabled` | boolean | `true` | `false` skips the append and exits `0` without touching files. |
| `changelogFile` | string | `{projectRoot}/CHANGELOG.md` | Target file; the resolved path must stay inside the project root, so absolute and escaping paths exit `1`. |

The changelog is project history. The helper never writes to an external memory vault.

## Output and exit codes

| Situation | Output | Exit |
|-----------|--------|------|
| Append succeeded | `changelog: appended to <resolved path>` | `0` |
| Disabled | `changelog: skipped: disabled` | `0` |
| Identical Prompt/Done/Result block already present | `changelog: skipped: duplicate-block` | `0` |
| Usage error | `ERROR: …` plus the usage line | `1` |

With `--json`, the result is `{"ok":true,"file":"<resolved path>"}` or `{"ok":true,"skipped":"disabled"}` / `{"ok":true,"skipped":"duplicate-block"}`.
