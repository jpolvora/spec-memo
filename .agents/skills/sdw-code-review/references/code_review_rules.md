# Code Review Rules, Hygiene Invariants & Report Schema

Tier-2 reference for `sdw-code-review`. Grounds all findings in `sdw-rules`
simplicity first. No multi-stack matrices, no fraud frameworks, no debate
tournaments.

## 1. Simplicity First (YAGNI & Anti-Overengineering)

Derived from `sdw-rules` simplicity and scope directives:

- **YAGNI:** Flag speculative abstractions (single-use factories, registries,
  unrequested configurability). Prefer the 20-line solution over the 50-line one.
- **Surgical scope:** Review only changed files (`base..HEAD` plus working tree).
  Never require reformatting untouched code. Match existing style.
- **Dead code:** Flag unreachable branches, unused imports introduced by the
  diff, and commented-out blocks that the change adds.
- **Speculative generality:** Flag `UNREQUESTED`, `@unrequested`, `@speculative`
  markers and future-proofing hooks with no acceptance criterion.

## 2. Fowler Smell Baseline (Diff-Scoped, Heuristic)

Only smells detectable deterministically on changed lines are reported:

| Smell | Heuristic | Severity |
|---|---|---|
| Abandoned debugger | Standalone `debugger;` statement | `critical` (fixable) |
| Leftover TODO | `// TODO` / `FIXME` comment in changed file | `warning` |
| Oversized diff | Single file adds `> 300` lines vs base | `suggestion` |
| Foreign runtime | `*.py` file under `skills/` | `critical` |

## 3. Syntax Hygiene Invariants (Blocking)

| Invariant | Pattern | Severity |
|---|---|---|
| No active debugger | `^\s*debugger\s*;?\s*$` | `critical` |
| No unresolved TODO | `TODO` / `FIXME` outside specs | `warning` |
| No committed secrets | AWS key, GitHub/Slack token, `sk-` key, private-key block, DB URL with password | `critical` |
| No sensitive filename | `.env`, `credentials.json`, `secrets.yml`, `id_rsa`, `*.pem` in diff | `warning` |
| No speculative marker | `@unrequested`, `@speculative`, `UNREQUESTED` | `warning` |

Secret value bodies are never echoed. Reports cite pattern name and location only.

## 4. Evidence Requirements

Each finding carries:

- `id`: Stable identifier (`CR-001`, zero-padded, sorted by `file:line:rule`).
- `severity`: `critical` | `warning` | `suggestion`.
- `path`: Precise `file:line` (repo-relative, forward slashes).
- `rule`: Machine-readable citation (e.g. `no_debugger_statements`).
- `message`: Failure scenario in one sentence.
- `fix`: Step-by-step prescription executable by an agent without extra context.
- `hunk`: Quoted offending lines (up to 3 lines context, secrets redacted).
- `status`: `open` (unresolved) | `fixed` (auto-fixed this run) | `planned` (dry-run).

## 5. Blocking Model & Exit Contract

- Blocking: `critical` + `warning`. Advisory: `suggestion`.
- `passed = (critical_open === 0 && warning_open === 0)`.
- Exit `0`: passed. Exit `1`: blocking remain, invalid base, invalid target,
  non-git workspace, or scanner failure (fail-closed).

## 6. Markdown Report Schema (Executable Fix Plan)

```markdown
# Code Review Report
- Target branch, base branch (+source), HEAD commit, reviewed files count, status
## Findings Summary
| ID | Severity | Path | Rule | Status |
## Detailed Findings
### CR-001 — <rule> (<severity>) at <file:line> [status]
- Location, Rule citation
- Offending hunk (fenced code, secrets redacted)
- Why it fails / violation
- Fix prescription (numbered steps)
## Fix Plan
- Ordered checklist an agent can execute directly
```

## 7. JSON Report Schema

```json
{
  "passed": true,
  "base": "origin/main",
  "baseSource": "tracking-remote",
  "head": "abc123",
  "targetBranch": "feature/x",
  "reviewedFiles": ["a.cjs"],
  "errorCount": 0,
  "criticalCount": 0,
  "warningCount": 0,
  "suggestionCount": 0,
  "blockingCount": 0,
  "fixedCount": 0,
  "findings": [],
  "fixedFiles": [],
  "reportPath": ".sdw/state/code-review.report.md",
  "dryRun": false
}
```

`errorCount` aliases `criticalCount` for orchestrator compatibility.
