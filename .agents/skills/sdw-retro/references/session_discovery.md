# Session Transcript Discovery

`retro.cjs` never discovers host files. The agent resolves this session's
transcript in a fixed order: configured inputs first, then the deterministic
finder, then this session's captured context. A transcript is read-only input;
never copy it into the project, quote its line bodies, or commit it.

## 1. Configured Inputs

A transcript named by `retro.transcripts` in `.sdw/config.json` or by a
`--transcript` flag is already configured. Verify the path exists, then pass it
unchanged with the default mode:

```bash
node skills/sdw-retro/scripts/retro.cjs run --run-id <runId> --transcript <path>
```

Do not run the finder when a usable transcript is configured.

## 2. Finder

When no transcript is configured, run the finder before any capture fallback:

```bash
node skills/sdw-retro/scripts/find_session_transcript.cjs [--root <projectRoot>] [--json]
```

It exits `0` whether it finds a candidate or not and prints one JSON object:

```json
{
  "found": true,
  "path": "relative-or-absolute-path",
  "score": 90,
  "source": "search-root",
  "sessionId": "session-id",
  "entriesScanned": 42,
  "elapsedMs": 18,
  "roots": [{ "variable": "HOME", "path": "..." }]
}
```

- `source` is `env-file` when an environment variable names the file directly,
  and `search-root` when the file was found under a candidate root.
- `path` is relative to `--root` when it is inside that project root; otherwise
  it is absolute.
- When `found` is true, pass `path` with `--transcript <path>` and keep the
  default mode; omit `--transcript-mode` (default `host`). Do not guess a
  different path:

```bash
node skills/sdw-retro/scripts/retro.cjs run --run-id <runId> \
  --transcript <path>
```

- When `found` is false, write this session's messages to
  `.sdw/state/retro-session-{runId}.md` and pass
  `--transcript <file> --transcript-mode captured`; the capture procedure is
  [Captured-Context Fallback](#3-captured-context-fallback). Do not guess a
  different path.

### Facts The Finder Uses

The finder has no product-specific layout. It inspects environment values:

1. **File-valued variables.** A variable whose value is an existing file with a
   transcript-shaped extension is a direct candidate.
2. **Session-identifier variables.** A variable whose name contains `SESSION`,
   `CONVERSATION`, `THREAD`, or `RUN` and whose value is an 8-64 character
   identifier of letters, digits, `_`, or `-` is a session id. When several
   match, the longest value wins.
3. **Candidate roots.** A variable whose value is an existing directory and
   whose name contains `HOME`, `DIR`, `ROOT`, `DATA`, `CONFIG`, or `PROFILE` is
   a candidate root. Operating-system trees are skipped: a root inside the
   directory named by `SystemRoot`, `windir`, `ProgramFiles`, or `ProgramData`,
   a drive root, and a name matching `SYSTEM`, `DRIVERS`, `DOTNET`, `TEMP`, or
   `TMP`. Preferred names (`SESSION`, `HARNESS`, `AGENT`, `DATA`, `CONFIG`,
   `HOME`, `PROFILE`) come first; at most six roots are searched.

Only these facts affect discovery. The finder does not read project
configuration, state, or any transcript body.

### Search Bounds And Filters

A root search is breadth-first and bounded by default to:

- depth `4`;
- `4000` scanned entries across all roots;
- a `2000` ms wall-clock budget.

`--max-entries <n>` and `--timeout-ms <n>` override the last two bounds for
tests or unusually large layouts. `entriesScanned` and `elapsedMs` always report
what happened. The remaining entry and time budgets are split across the
unscanned roots, so one noisy root cannot consume the whole bound, and scanning
stops at a root that yields a session-id match.

The finder skips `node_modules`, `.git`, `dist`, `build`, `.cache`, `tmp`, and
`temp`, and stats only `.jsonl`, `.json`, `.log`, `.txt`, `.md`, `.zst`, and
`.zstd` files. When a session id is known, only a file with the id in a segment
of its path (a directory or the file name) qualifies; recency and extension only
rank it against other matches. When no session id is known, only `.jsonl`,
`.json`, `.log`, `.zst`, and `.zstd` qualify.

Candidates are scored: session id in the path `+60`, transcript extension
`+20`, recent modification `+10`, and a data-like root variable name `+10` (a
name containing `HOME`, `DATA`, `CONFIG`, or `PROFILE`). The highest score wins.

The finder only stats files and opens the first bytes to reject binary content.
Compressed transcript frames are treated as text-like. It prints no transcript
content and creates, modifies, copies, and moves no file.

## 3. Captured-Context Fallback

Use the fallback only when no transcript is configured and the finder returns
`found: false`, or when the configured path cannot be decoded. Write this
session's messages to `.sdw/state/retro-session-{runId}.md`:

- One message per line, no other prose.
- A role prefix on every line: `user: `, `assistant: `, or `tool: `.
- Include only this session's messages. No secrets, tokens, or credentials.
- The state directory is git-ignored, so the file never enters a delivery
  commit.

Example:

```
user: implement spec 00047 task-1
assistant: dispatching task-1 to the implementation worker
tool: node skills/sdw-retro/scripts/retro.cjs run --run-id run-1792614056524
assistant: task-1 reported success
```

Pass the capture with mode `captured`:

```bash
node skills/sdw-retro/scripts/retro.cjs run --run-id <runId> \
  --transcript .sdw/state/retro-session-<runId>.md --transcript-mode captured
```

The report records the mode next to each input, so a later reader can tell a
host transcript (`host`) from an agent-captured one (`captured`).
