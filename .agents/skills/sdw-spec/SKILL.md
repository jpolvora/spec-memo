---
name: sdw-spec
description: Specification lifecycle, authoring, synchronization, and formatting manager integrated with sdw-run.
version: 0.1.0
invocation_names:
  - sdw-spec
  - sdw-spec init
  - sdw-spec list
  - sdw-spec new
  - sdw-spec import
  - sdw-spec sync
  - sdw-spec validate
  - sdw-spec archive
---
# sdw-spec

> When this skill is loaded, output "sdw-spec loaded."

Specification lifecycle, authoring, synchronization, and formatting manager integrated directly with the orchestrator.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md); authoring, validating, registering, or archiving a spec never authorizes implementation.

## Subcommands

- `init`: Bootstraps `{specsDir}/index.specs.md` with standard tables and status definitions.
- `list`: Displays registered specifications with statuses and validation health.
- `new <text>`: Synthesizes a canonical specification with autoincremented numerical prefix; header status `draft`.
- `import`: Imports remote tracker items from GitHub issues or Azure DevOps work items using unified SCM contract.
- `sync`: Reconciles `index.specs.md` against on-disk specification files and orchestrator run state files.
- `validate <specPath>`: Enforces validation against YAML frontmatter, section hierarchy, and EARS syntax rules.
- `status <slug> <status>`: Changes the spec header status through the defined transitions.
- `archive <slug>`: Transitions completed specifications to `archived` in `index.specs.md`.

## Imported Item Frontmatter

`import` persists the tracker item in the specification frontmatter. `id` holds the provider item id as a string (`null` when the specification is not tracker-backed); `source` holds the provider (`github` or `azure-devops`, or `local`). Downstream, [`sdw-ship-pr`](../sdw-ship-pr/SKILL.md) reads those keys through `--spec <slug>` and appends the provider closing keyword (`Closes #<id>` for GitHub, `Fixes AB#<id>` for Azure DevOps). `local`, `null`, and any other `source` value emit no keyword. Contract details live in the [`sdw-ship-pr`](../sdw-ship-pr/SKILL.md) protocol, `skills/sdw-ship-pr/references/ship_protocol.md` § 3.

## Spec Status

The header `status:` is the authoring state. The registry `Status` column remains the lifecycle state (`pending`, `completed`, `archived`); `sync` never rewrites the header.

| Status | Meaning |
|---|---|
| `draft` | Needs refinement or grilling. |
| `awaiting-approval` | Grilled and coherent; waiting for the maintainer's sign-off. |
| `ready-to-implement` | Approved; implementation may be ordered explicitly. |
| `implemented` | Delivered and verified. |
| `abandoned` | Dropped but kept for the record. |

Order: `draft` -> `awaiting-approval` -> `ready-to-implement` -> `implemented`. `abandoned` is reachable from any state and can be revived to `draft`. `sdw-spec status` refuses undefined transitions; `--force` overrides. Only the maintainer moves a spec to `ready-to-implement`, and even that status does not authorize implementation; the explicit order remains separate.

## Steps

1. **Bootstrap or Inspect Specification Index**
   Ensure `{specsDir}/index.specs.md` exists and is synchronized.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs init` (or `sync`)
   - Done when: `index.specs.md` exists and lists all current specifications with accurate lifecycle statuses.

2. **Author or Import New Specification**
   Create a new specification with an autoincremented 5-digit prefix (`NNNNN`) from free-text or remote SCM issue. Apply `sdw-rules` for scope enclosure; never infer unprompted features without a user-gate.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs new "<requirements>"` or `node skills/sdw-spec/scripts/sdw_spec.cjs import --provider <github|azure-devops> --id <id>`
   - Done when: Canonical `.sdw/specs/NNNNN-{slug}.md` file exists with `status: draft` and a `pending` registry row.

3. **Grill for Cohesion (optional)**
   Interview the maintainer until the frontier is empty: ask in rounds, never ahead of settled prerequisites, and stop when nothing is left unstated. One feature per spec; if the draft spans multiple domains, areas, or groups of modifications, propose a split by feature before asking behaviour questions. Full protocol: [`references/grilling.md`](references/grilling.md).
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs status <slug> awaiting-approval`
   - Done when: every assumption is confirmed or explicitly parked, every DoR row names a verification method, the focus check passed or the split was approved, and validation passes.

4. **Validate Specification Syntax & Quality Gates**
   Verify YAML frontmatter, status value, required section hierarchy, EARS acceptance criteria conformance, and closure tables.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs validate <specPath> --mode=authoring`
   - Done when: Validation script exits with code `0` and outputs `PASS`.

5. **Synchronize & Reconcile Lifecycle States**
   Reconcile orchestrator run states and delivery evidence with the specification registry.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs sync`
   - Done when: Completed runs are marked `completed`, active runs are marked `pending`, and validation health is updated.

6. **Archive Completed Specification**
   Retire delivered specifications from active execution.
   - Run: `node skills/sdw-spec/scripts/sdw_spec.cjs archive <slug>`
   - Done when: Specification status is updated to `archived` in `index.specs.md`.

## References

- Specification standard, frontmatter, status, EARS syntax: [`references/spec_standard.md`](references/spec_standard.md)
- Round-based grilling and focus/split protocol: [`references/grilling.md`](references/grilling.md)
- Unified SCM provider contract: [`references/scm_contract.md`](references/scm_contract.md)
