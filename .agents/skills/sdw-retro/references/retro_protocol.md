# Retro Protocol

`sdw-retro` is a review of one `sdw-run` run. It turns the run's own record
and the transcripts the operator explicitly names into deterministic friction
signals and leaves every improvement judgment to an explicit operator decision.
It never changes project code and never writes memory records.

`sdw-run` starts the review automatically when a run reaches `completed` and
`retro.enabled` is `true`. The orchestrator records the outcome in
`state.retro`; a non-zero retro exit or a missing report is recorded and never
turns the completed delivery into a failed run. When `retro.enabled` is `false`
or absent, `sdw-run` prints the advisory retro command and does not run it.

## Invocation

```bash
node skills/sdw-retro/scripts/retro.cjs run [--run-id <runId>] [--root <path>] [--transcript <path>]... [--transcript-mode <host|captured>] [--json]
```

- `--run-id` selects one run. Omit it to select the most recent run whose state
  has `status: "completed"` under `.sdw/state`.
- `--root` selects the project root. Omit it to walk up from the current
  directory to the nearest directory containing `.sdw/`.
- `--transcript` names one transcript file and may repeat. Configured
  `retro.transcripts` entries are added to the same list; duplicates are read
  once.
- `--transcript-mode` labels every transcript input as `host` or `captured`.
  It defaults to `host`; any other value exits `1` with the allowed values.
- `--json` prints the report object on stdout. Selection telemetry moves to
  stderr so stdout stays machine readable.
- Exit `0` means both report files were written, including when a named
  transcript is unreadable. Exit `1` means the subcommand, argument, run, or
  report write failed; the error names the cause.

## Inputs

The only retro inputs are:

1. The selected run state file: `.sdw/state/run-<timestamp>-<slug>.state.json`.
2. Every project-relative path that the state declares as an artifact:
   `steps.<n>.artifact`, `steps.4.tasks.<id>.promptPath`,
   `steps.4.tasks.<id>.evidencePath`, `steps.5.output.judgePromptPath`, and
   `steps.5.output.judgeVerdictPath`.
3. Every transcript path named by `retro.transcripts` in `.sdw/config.json` or
   by a `--transcript` flag, including a path the finder returned and the agent
   passed with that flag. Transcripts are opt-in: empty configuration means the
   analyzer reads no transcript until the finder resolves one.
   [`session_discovery.md`](session_discovery.md) defines the resolution order,
   the environment facts, the search bounds, and the capture fallback.

The analyzer never enumerates host transcript directories, session stores, chat
logs, or agent conversation records. An unconfigured declared path that looks
like a transcript, session log, or chat log is listed under `excludedInputs`
with reason `host-log` and is not read. Declared paths outside the project root
are listed with reason `outside-project-root`.

A configured transcript is always read, even when its path would match a host
log pattern, because the operator named it explicitly. It is listed under
`inputs` and under `transcripts` as `{ path, lines, mode }`, and in the Markdown
report as `- <path> (transcript, <lines> lines, <host|captured>)`. A transcript
that does not exist, cannot be read, or is not decodable text is reported
through the `transcript_unreadable` signal and never fails the command.

## Transcript Inputs

Discovery is agent work, not script work: `retro.cjs` never enumerates a host
directory. The agent resolves the transcript in a fixed order.

1. A path named by `retro.transcripts` or `--transcript` is configured input and
   is used first. Verify that it exists and keep mode `host`.
2. When no transcript is configured, run the finder before any fallback:

   ```bash
   node skills/sdw-retro/scripts/find_session_transcript.cjs --root <projectRoot> --json
   ```

   The finder derives candidates only from environment facts and filesystem
   conventions: file-valued variables, session-identifier variables, and
   existing directories named by home, data, config, or profile variables. It
   searches breadth-first with a depth limit, an entry limit, and a wall-clock
   budget, and prints `found`, `path`, `score`, `source`, `sessionId`,
   `entriesScanned`, `elapsedMs`, and `roots`. When `found` is true, pass
   `path` with `--transcript <path>` and omit `--transcript-mode`; the default
   mode is `host`. The finder never reads transcript bodies into its output and
   never writes a file.
3. When the finder returns `found: false`, write this session's messages to
   `.sdw/state/retro-session-{runId}.md`, one `user:`, `assistant:`, or `tool:`
   line per message, and pass that file with
   `--transcript <file> --transcript-mode captured`. `.sdw/state/` is
   git-ignored, so the capture never enters a delivery commit.

Content decoding:

1. Bytes are decoded as strict UTF-8; invalid UTF-8 fails the decode.
2. When the file starts with the zstd magic `28 b5 2f fd`, every concatenated
   zstd frame is split on that magic and inflated in memory with `zlib` from the
   Node.js standard library. One `zstdDecompressSync` call decodes only the
   first frame, so the whole file is decoded frame by frame; a frame that fails
   to inflate is skipped. The decoded bytes must then pass strict UTF-8.
3. Anything that is neither decodable UTF-8 text nor a decodable zstd frame is
   not a transcript: it is reported as `transcript_unreadable` with reason
   `not-text`, is absent from `inputs` and `transcripts`, and does not change
   the exit code. A missing path uses `not-found`; any other read failure uses
   `read-error`.

## Run Selection

- Candidate state files are the top-level `*.state.json` files under `.sdw/state`.
- Explicit `--run-id` accepts the full run identifier, a bare file name, a short
  timestamp, or a spec slug segment; the newest match wins.
- Without `--run-id`, only `status: "completed"` runs qualify. The newest
  `updatedAt` wins; ties fall back to the run identifier.
- `--run-id` may name a paused or failed run for diagnosis. Default selection
  never picks one.

## Signals

Signals are read from the state object, never invented from prose.

| Signal | Source | Notes |
|---|---|---|
| `timestamps` | `createdAt`, `updatedAt`, `steps.*` | Run timestamps plus per-step start and completion times. |
| `retries` | `scoreIteration`, `reviewIteration`, `steps.8.output.reviewConvergence.rounds`, dispatch abandonments | Numeric iteration and re-dispatch counters. |
| `abandonedDispatches` | `steps.4.dispatch.abandonments[*]` | Task, reason, time, and locator. |
| `scoreIterations` | `steps.5.output` | Score, minimum score, pass flag, judge score, and iteration. |
| `gateRepairs` | `steps.4.gates.*`, `steps.4.output.gates.*` | Gates whose recorded status is not `passed` or whose exit code is not `0`. |
| `reviewFindings` | `steps.7.output.findings[*]` | Counts by severity, open findings, and locators. |
| `unresolvedThreads` | `steps.8.output.reviewConvergence` | Active, resolved, and pending threads with locators. |
| `missingArtifacts` | declared artifact paths | Present only when a declared path is absent. |
| `leftover_run` | sibling `*.state.json` files with the same `specSlug` | Sibling runs that never reached `completed` or `failed`, with run id, status, and age. |
| `repeated_run_invocation` | configured transcripts | Two `sdw-run ... run` invocations for the same `--spec` in one transcript with no `resume` between them. Adjacent lines carrying the same command excerpt count once. Cites the file and both line numbers; never copies line bodies. |
| `transcript_unreadable` | named transcripts | A named transcript path that does not exist, cannot be read, or is not decodable text, with `not-found`, `read-error`, or `not-text`. The command still exits `0`. |

The state stores only the latest gate record, so a repaired gate can appear as
`passed` with no failure history. `gateRepairs` reports what the state records;
it does not infer unrecorded repairs.

Transcript scanning is line-based and format-agnostic: plain text and JSONL
lines match the same command signature. A line counts as an orchestrator
invocation only when the executable (`sdw-run` or the `sdw_run.cjs` script)
is immediately followed by the `run` or `resume` command word. An optional
closing quote, preceded by any run of JSON escape backslashes, may sit between
them, so a tool-call line such as
`"command":"node \".../sdw_run.cjs\" run --spec ..."` matches. A line that
names the executable and uses the word `run` in a separate clause is prose and
is not an invocation. Only a `--spec` that follows the command word is read;
the specification is its basename with the `.md` suffix removed. Surrounding
quotes, backticks, JSON escape backslashes, and trailing punctuation are
stripped from that value before the basename is derived, so a value captured as
`.sdw/specs/00000-x.md` followed by a backtick normalizes to `00000-x`. The
rest of the line is ignored. Nothing is parsed from harness-specific JSON
structure.

A call is often recorded twice: once in the message that issued it and once in
the tool record that echoed it. The two lines differ in their host envelope
while the command is the same, so the scanner compares a normalized command
excerpt, not the whole line: the command word `run` plus `--spec <value>` when
a value follows, using the value that `--spec` normalization produced. The
excerpt therefore contains no envelope text and no quote, backtick, escape, or
trailing-punctuation noise; whitespace between the tokens on the line does not
change it. When two `run` invocations for the same specification have
equal excerpts and their line numbers differ by one, they are one invocation
and produce no signal. Any other line between them, or a different excerpt,
keeps them apart, and the second invocation produces
`repeated_run_invocation` with both line numbers.

## Artifacts And Missing Content

- Expected artifacts come from the run state; nothing else is treated as an
  artifact.
- A missing path is recorded as `{ path, expectedBy, present: false }` under
  `signals.missingArtifacts` and listed in the Markdown report.
- The report never fabricates, summarizes, or back-fills content for a missing
  artifact.

## Report Files

Both files are written inside the run artifact directory, which the state names
as `artifactsDir`:

- `<runId>.retro.md` — human-readable report. Each transcript input is rendered
  next to its line count with its mode.
- `<runId>.retro.json` — machine-readable report with `transcriptMode`,
  `inputs`, `transcripts`, `artifacts`, `excludedInputs`, `signals`,
  `candidates`, and `candidateContract`. `transcriptMode` is the mode in force
  for the run, and every `transcripts[]` entry repeats it as `mode`, so a reader
  can tell a host transcript from an agent-captured one.

Each report has `signals` and `candidates`. An empty `candidates` array is valid
for a smooth run. Candidates are operator- or agent-supplied judgments; the
shape and allowed values are defined in
[`candidate_contract.md`](candidate_contract.md).

`sdw-batch` consumes this report: after a delegated item completes and
`retro.followUp` is not `none`, the batch reads `state.retro.reportJson` and
applies the policy (`queue`, `record`, or `none`) from `.sdw/config.json`.
`queue` creates drafts through `sdw-spec` only for `critical` and `high`
candidates, `record` writes a follow-up report, and `none` reads no report. A
follow-up item (`followUpDepth: 1`) still records its candidate summary but
never queues further specifications. The retro itself never creates a
specification. See
[`../../sdw-batch/references/batch_protocol.md`](../../sdw-batch/references/batch_protocol.md).

Validate candidates before they enter a report:

```bash
node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <path>] [--json]
```

The validator exits `0` only when every candidate is complete and ordered
`critical` -> `low`. Rejections carry a stable reason code; a direct `skills/`
edit is rejected with `skills-requires-spec` and the specification route, and a
`memory` candidate must carry an `sdw-memory` record draft instead of a
repository modification.

## Boundaries

- The run writes only the two report files. It does not edit source, specs, or
  memory, and it does not run git.
- `.sdw/state/` is git-ignored, so a retro run leaves the working tree unchanged.
- `sdw-run` starts one review automatically when `retro.enabled` is `true`;
  otherwise the operator runs the command. A retro failure never changes the
  run status or the orchestrator exit code.
- `sdw-run run` refuses to start a second run while the same specification has
  a run that is neither `completed` nor `failed`; it names the open run id and
  directs the operator to `resume --run-id <runId>`. `--new-run` overrides the
  guard for an intentional restart.
