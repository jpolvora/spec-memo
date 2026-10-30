# SDW Specification Standard & Formatting Reference

Canonical specification format and schema rules for Spec-Driven Workflow (SDW).

## 1. YAML Frontmatter

Every specification must begin with YAML frontmatter containing exactly these 6 keys:

```yaml
---
id: null                  # Remote tracker issue/work item ID (string or null)
slug: 00001-feature-name  # Format: NNNNN-<kebab-case-name>
title: "Feature Title"    # Quoted human-readable title
source: local             # One of: 'local' | 'github' | 'azure-devops'
status: draft             # One of the 5 spec statuses (see section 5)
specDate: 2026-10-19      # ISO date (YYYY-MM-DD)
---
```

`status` is the authoring state, not an implementation order. A missing key or an unknown value fails validation.

## 2. Autoincrement Prefix Convention

All specifications are prefixed with a 5-digit zero-padded integer (`00001`, `00002`, ..., `000NN`):
- Scans `{specsDir}` for existing files matching `/^(\d{5})-.*\.md$/`.
- Resolves the highest existing integer and increments by 1.
- Initial prefix defaults to `00001` if no numbered files exist.
- Both the file name (`{specsDir}/NNNNN-{slug}.md`) and frontmatter `slug` incorporate the prefix.

### Spec revisions

- The prefix and base slug are stable for the life of a specification.
- Revisions insert a `vNN` marker after the prefix: `00036-my-feature.md` (v00), then `00036-v01-my-feature.md`, `00036-v02-my-feature.md`.
- The original v00 file stays untouched when a revision is written.
- Older revisions stay on disk as history and remain valid spec files.
- `index.specs.md` points to the latest revision only (one row per prefix+slug group).
- `sdw-spec update` writes a new revision by default and only overwrites the latest file in place with an explicit overwrite flag (`--force`).

## 3. Required Section Hierarchy

A valid specification must contain the following section hierarchy in order:

1. `# Specification — <Title>`
2. `## Description`
   - High-level architectural context, scope, and technical boundaries.
3. `### Design Intent`
   - Architectural motivation, rationale, or greenfield statement.
4. `### Prior Work Sweep` *(Mandatory only when `source` is `github` or `azure-devops`)*
   - Cross-references to existing code, previous PRs, or existing modules.
5. `## Acceptance Criteria`
   - Enumerable bullets formatted strictly as `- AC<number>: <EARS pattern>`.
   - Sequential 1-based indexing (`AC1`, `AC2`, ..., `ACn`).
   - Atomic requirements (no composite requirements joining multiple imperatives with 'and'/'or').
6. `## Notes`
   - Implementation constraints, schema details, interface signatures.
7. `## Out of Scope`
   - Markdown table (`Feature` | `Reason`) with at least one non-placeholder row.
8. `## Assumptions & Open Questions`
   - Markdown table (`Assumption` | `Chosen default` | `Rationale` | `Confirmed`) with non-placeholder rationale.
9. `## Definition of Ready (DoR)`
   - Markdown table (`Readiness Item` | `Requirement` | `Verification Method`).
10. `## Validation & Observation Notes`
    - `### Telemetry & Observable Signals`
    - `### Negative & Failing Test Scenarios` (at least one failing/error test case).

## 4. EARS Syntax Patterns

Acceptance criteria must strictly match one of the 5 Easy Approach to Requirements Syntax (EARS) patterns:

| Pattern | Template | Example |
|---|---|---|
| **Ubiquitous** | `The <system> shall <response>` | `The system shall maintain a centralized specification index at {specsDir}/index.specs.md.` |
| **Event-driven** | `When <trigger>, the <system> shall <response>` | `When the list subcommand is executed, the system shall display all specifications.` |
| **State-driven** | `While <state>, the <system> shall <response>` | `While a specification is marked archived, the system shall prevent execution.` |
| **Optional-feature** | `Where <feature>, the <system> shall <response>` | `Where a status filter is passed via --status, the system shall restrict output.` |
| **Unwanted-behavior** | `If <trigger>, then the <system> shall <response>` | `If the index file already exists, then the system shall preserve existing records.` |

## 5. Spec Status

The header `status:` records where the specification is in its authoring life. It never authorizes implementation.

| Status | Meaning | Registry row |
|---|---|---|
| `draft` | Needs refinement or grilling. | `pending` |
| `awaiting-approval` | Grilled and coherent; waiting for the maintainer's sign-off. | `pending` |
| `ready-to-implement` | Approved; implementation may be ordered explicitly. | `pending` |
| `implemented` | Delivered and verified. | `completed` |
| `abandoned` | Dropped but kept for the record. | `archived` |

Allowed transitions: `draft` -> `awaiting-approval` -> `ready-to-implement` -> `implemented`; `abandoned` is reachable from any state and may be revived to `draft`. `sdw-spec status` refuses undefined transitions unless `--force` is passed.

The registry `Status` column stays the lifecycle value (`pending`, `completed`, `archived`). `sync` reconciles the registry only; it never rewrites the header.

## 6. Focus, Splitting & Grilling

- Default unit: **one feature per spec**.
- If the draft spans multiple domains, areas, or groups of modifications, split it **by feature** before writing behaviour ACs. One spec per independently deliverable area.
- A spec that needs more than roughly 15 ACs is a split signal.
- Grilling is optional. When used, it follows the round-based frontier rule: ask the whole set of questions whose prerequisites are settled, never ahead of them, and stop when the frontier is empty.
- Grilling records answers in `## Assumptions & Open Questions` (`Confirmed: Yes`) and in the ACs; it writes no implementation files.
- After grilling, move the header to `awaiting-approval`. Only maintainer sign-off moves it to `ready-to-implement`.
- Full protocol: [`grilling.md`](grilling.md).
