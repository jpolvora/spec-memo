# Candidate Contract

A candidate is one operator- or agent-supplied improvement judgment produced
while reviewing a completed run. Candidates are proposals, not automatic
changes. A retro report may contain no candidates at all.

## Record Shape

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable candidate identifier, unique within the report. |
| `title` | string | One-line statement of the improvement. |
| `severity` | string | One of the values in [Severity](#severity). |
| `category` | string | One of the values in [Category](#category). |
| `evidence` | object | Pointer to the run state or artifact evidence that justifies the candidate. |
| `proposedChange` | object | The follow-up the candidate proposes; see [Proposed Change](#proposed-change). |

All six fields are required and must be non-empty.

## Evidence

`evidence.artifact` and `evidence.ref` are required.

- `evidence.artifact` is the project-relative file that holds the evidence. It
  must resolve to an existing file inside the project root. Absolute paths,
  `..` traversal, and missing files are rejected.
- `evidence.ref` is an exact locator inside that artifact. Two forms are valid:
  - a state path: `#steps.4.dispatch.abandonments[0]`, `#steps.8.output`;
  - a line range: `#L120-L138` or `#L120`, inside the artifact's line count.

The ref may repeat the artifact path before `#`, but it must name the same file:

- `.sdw/state/<runId>.state.json#steps.8.output`
- `.sdw/state/<slug>/<runId>/<slug>-step-7.md#L120-L138`

A ref that is empty, has no `#`, names a different file, is vague prose, or
points past the artifact's last line is rejected with `invalid-evidence-ref`.

## Proposed Change

`proposedChange.target` is required and must name the route the operator takes
next. A direct `skills/` edit is never proposed: it is rejected with
`skills-requires-spec`, and the rejection names the specification route
(`author a specification under .sdw/specs/ with sdw-spec and implement it
through sdw-run`). A target naming a non-`skills/` path such as
`.sdw/specs/<slug>.md` is accepted.

## Severity

Only these four values are accepted, ordered from most to least urgent:

1. `critical`
2. `high`
3. `medium`
4. `low`

Any other value is rejected with `invalid-severity`. A candidate file must list
its candidates in this order; a less urgent candidate after a more urgent one
is rejected with `candidate-order`.

## Category

Only these six values are accepted:

- `memory`
- `harness-directive`
- `reviewer-standard`
- `automated-check`
- `navigation-pointer`
- `no-op-deletion`

Any other value is rejected with `invalid-category`.

## Memory Candidates

A `memory` candidate proposes an `sdw-memory` record draft instead of a
repository modification. It is the only category that uses this shape:

| Field | Type | Meaning |
|---|---|---|
| `proposedChange.target` | string | The literal route `sdw-memory`. |
| `proposedChange.memoryRecord` | object | The draft handed to `sdw-memory record`. |

The draft requires `kind` (`trap`, `gap`, `pattern`, or `error`), `title`,
`avoid`, and `action`; `slug` is optional kebab-case, and `paths` is an
optional list of project-relative paths. The validator emits every accepted
draft under `memoryDrafts`; it never records it and never imports a host-memory
API. A missing draft is rejected with `missing-memory-draft`, an incomplete
draft with `invalid-memory-draft`, and a repository target with
`memory-target-not-route`.

## Validation

```bash
node skills/sdw-retro/scripts/validate_candidates.cjs --input <file> [--root <path>] [--json]
```

`--input` accepts an array of candidates or the `candidates` array of a
`<runId>.retro.json` report. Exit `0` means every candidate was accepted;
exit `1` means at least one was rejected or the input could not be read. The
JSON result reports `accepted`, `rejected`, `memoryDrafts`, `order`,
`reasonCodes`, and `specificationRoute`.

| Reason code | Trigger |
|---|---|
| `missing-field` | A required record field is absent or empty. |
| `missing-evidence-artifact` | `evidence.artifact` is absent. |
| `missing-evidence-ref` | `evidence.ref` is absent. |
| `unresolvable-artifact` | `evidence.artifact` is absolute, escapes the root, or names no file. |
| `invalid-evidence-ref` | The ref is not an exact state path or artifact line range. |
| `missing-proposed-change-target` | `proposedChange.target` is absent. |
| `invalid-severity` | `severity` is not one of the four values. |
| `invalid-category` | `category` is not one of the six values. |
| `duplicate-id` | Two candidates share an `id`. |
| `candidate-order` | A less urgent candidate follows a more urgent one. |
| `skills-requires-spec` | The target names a direct `skills/` edit. |
| `memory-target-not-route` | A memory candidate targets a repository path. |
| `missing-memory-draft` | A memory candidate has no `memoryRecord` draft. |
| `invalid-memory-draft` | The draft misses a required field or uses a bad value. |

## Examples

```json
[
  {
    "id": "RETRO-001",
    "title": "Record the retro command in the completion summary",
    "severity": "high",
    "category": "automated-check",
    "evidence": {
      "artifact": ".sdw/state/run-2000000000000-00099-example.state.json",
      "ref": "#steps.8.output"
    },
    "proposedChange": {
      "target": ".sdw/specs/00100-retro-follow-up.md"
    }
  },
  {
    "id": "RETRO-002",
    "title": "Record the retry trap",
    "severity": "medium",
    "category": "memory",
    "evidence": {
      "artifact": ".sdw/state/00099-example/run-2000000000000-00099-example/00099-example-step-7.md",
      "ref": "#L12-L14"
    },
    "proposedChange": {
      "target": "sdw-memory",
      "memoryRecord": {
        "kind": "trap",
        "slug": "retry-without-abandon",
        "title": "Retry without abandoning the active dispatch",
        "avoid": "Dispatching a second task while one is in flight.",
        "action": "Abandon the active task with a reason before dispatching again."
      }
    }
  }
]
```
