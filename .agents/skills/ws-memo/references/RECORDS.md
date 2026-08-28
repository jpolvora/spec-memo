# Vault records and git boundary

## Kinds

| Kind | Retention | Bootstrap | Notes |
|---|---|---|---|
| `trap` | Until superseded | Always (filtered by path/intent) | `pathPatterns` + strict `DO NOT` / `INSTEAD DO` format. Archive on forget. |
| `decision` | Until superseded | High | proposed / accepted / superseded + rationale. |
| `spec` | Until shipped, then archive | By slug / query | Working copy of feature spec. Optional `linkedPaths` + `verifiedAtSha`. |
| `plan` | Active, then compact | Live slug only | Compact to single summary line after shipping. |
| `state` | While workflow active | Never in global search | FSM / runtime state (`run.json` equivalent). |
| `log` | Append-only; monthly compact | Search only | Use `append` tool, not `upsert`. |
| `scratch` | TTL 7 days | Excluded | Scratchpad notes. Purged automatically by `gc`. |
| `review` | TTL 14 days | Excluded | Review findings. Purged automatically by `gc`. |

### Status
`active` | `paused` | `shipped` | `superseded` | `archived`.

### Source
`agent` | `human` | `imported`.

### Frontmatter Schema

All records have YAML frontmatter.

**Standard Frontmatter Fields:**
- `id` (string, required): Unique record identifier (e.g. `trap-windows-sqlite-lock`).
- `kind` (string, required): One of the 8 kinds above.
- `project` (string, required): Project identifier.
- `status` (string, default `active`): Status enum above.
- `created` (ISO timestamp string, required): Creation date.
- `updated` (ISO timestamp string, required): Last modification date.
- `source` (string, default `agent`): `agent` | `human` | `imported`.
- `title` (string, optional): Human-readable title.
- `severity` (string, optional): `low` | `medium` | `high` | `critical`.
- `layer` (string, optional): Closed enum: `application` | `domain` | `web` | `infrastructure` | `tests` | `devops` | `other`.
  - *Aliases:* `front` / `frontend` → `web`; `back` / `backend` → `application`; `infra` → `infrastructure`.
  - *Note:* Values `security` / `segurança` belong in `tags`, not `layer`.
- `module` (string, optional): Subsystem or component name.
- `pathPatterns` (string[], optional): Array of glob patterns (e.g. `["src/db/**/*.ts"]`).
- `tags` (string[], optional): Array of tags (e.g. `["security", "sqlite"]`).
- `occurrences` (number, optional): Integer >= 1.
- `lastSeen` (ISO timestamp string, optional): When this issue was last observed.
- `supersedes` (string, optional): ID of previous record superseded by this one.
- `linkedPaths` (string[], optional): Array of relative file paths.
- `verifiedAtSha` (string, optional): Git commit SHA.

*Serialization Rule:* Never serialize frontmatter keys as YAML `undefined` (omit missing optional keys).

---

## Trap Body Structure (upsert)

Traps must use the structured template for automated classification and recurrence ranking:

```markdown
### [YYYY-MM-DDTHH:mm:ssZ] Short title
- **Layer**: Application
- **Module**: store / sqlite
- **Severity**: High
- **PathPattern**: src/store.ts
- **Scenario / Context**: When X happens under condition Y...
- **DO NOT**: Anti-pattern action to avoid.
- **INSTEAD DO**: Correct pattern / solution.
```

*(Note: `### [YYYY-MM-DD]` is also accepted as shorthand; full ISO datetime `[YYYY-MM-DDTHH:mm:ssZ]` is recommended for precise resolution.)*

**Deduplication & Recurrence:**
- Same `id` or `slug` upsert = in-place edit (no occurrence bump).
- Dedup match (same `pathPatterns` + token overlap >= 0.7) automatically increments `occurrences` and updates `lastSeen`.

---

## Specs vs Product Git

| Location | What belongs |
|---|---|
| Vault `kind=spec` / `plan` / `state` | Working copies during delivery |
| Product `{specsDir}/*.spec.md` + `index.PRD` | Specs of record / roadmap (this repo dogfoods that split) |
| Product `{plansDir}/`, `MEMORY.md`, `memory/*` | **FORBIDDEN** when vault mode is the memory store |

`memo import` maps `{specsDir}/*.spec.md` → vault spec, `{plansDir}/{slug}/` → plan+state, `{sharedDir}/memory/*.md` → trap. Specs of record may remain in git for Spec-to-PR; do not dump `step-00` twins into product git.

---

## Git Boundary & Safety Rules

- **Allowed in product git:** Source code, tests, documentation, `{specsDir}` specs of record, `index.PRD`.
- **Forbidden in product git:** `.agents/plans/`, `MEMORY.md`, `memory/*`, `.state.md`, `run.json`, `telemetry.jsonl`, agent audit logs, vault contents under `$SPEC_MEMO_ROOT` or `~/.spec-memo/`.
- **Pre-commit write block:** Install `memo hook install` to enforce this boundary via Git pre-commit hook (emergency bypass: `SKIP_MEMO_HOOK=1 git commit`).
- **Secret Redaction:** `upsert` strictly rejects payloads with secret patterns (API keys, bearer tokens, private keys) with `SAFETY_VIOLATION`.
