# Vault records and git boundary

## Kinds

| Kind | Retention | Bootstrap | Notes |
|------|-----------|-----------|--------|
| `trap` | Until superseded | Always (filtered) | pathPatterns + DO NOT / INSTEAD DO. Archive on forget. |
| `decision` | Until superseded | High | proposed / accepted / superseded + rationale. |
| `spec` | Until shipped, then archive | By slug / query | One of record. Optional `linkedPaths` + `verifiedAtSha`. |
| `plan` | Active, then compact | Live slug only | Compact after ship. |
| `state` | While workflow active | Never in global search | run.json equivalents. |
| `log` | Append-only; monthly compact | Search only | Use `append`, not `upsert`. |
| `scratch` | TTL 7 days | Excluded | |
| `review` | TTL 14 days | Excluded | |

Status: `active` \| `paused` \| `shipped` \| `superseded` \| `archived`.

Source: `agent` \| `human` \| `imported`.

Required frontmatter: `id`, `kind`, `project`, `status`, `created`, `updated`, `source`.

Trap `layer` closed enum: `application` `domain` `web` `infrastructure` `tests` `devops` `other`. Aliases: front/frontend → `web`; back/backend → `application`; infra → `infrastructure`. Values `security` / `segurança` go to `tags`, not `layer`.

Never serialize frontmatter keys as YAML `undefined` (omit missing optional keys).

## Trap body (upsert)

```markdown
### [YYYY-MM-DD] Short title
- **Layer**: Application
- **Module**: store / sqlite
- **Severity**: High
- **PathPattern**: src/store.ts
- **Scenario / Context**: …
- **DO NOT**: …
- **INSTEAD DO**: …
```

Same-id/slug upsert = edit (no occurrence bump). Dedup match (same pathPatterns + body overlap ≥ 0.7) increments `occurrences` and `lastSeen`.

## Specs vs product git

| Location | What belongs |
|----------|----------------|
| Vault `kind=spec` / `plan` / `state` | Working copies during delivery |
| Product `{specsDir}/*.spec.md` + `index.PRD` | Specs of record / roadmap (this repo dogsfoods that split) |
| Product `{plansDir}/`, `MEMORY.md`, `memory/*` | Forbidden when vault mode is the memory store |

`memo import` maps `{specsDir}/*.spec.md` → vault spec, `{plansDir}/{slug}/` → plan+state, `{sharedDir}/memory/*.md` → trap. Specs of record may remain in git for Spec-to-PR; do not also dump `step-00` twins into product git.

## Git boundary

May live in product git: source, tests, shipped docs, `{specsDir}` specs of record, `index.PRD`.

Must not: `.agents/plans/`, `MEMORY.md`, `memory/*`, `.state.md`, `run.json`, `telemetry.jsonl`, agent audit logs, vault contents under `$SPEC_MEMO_ROOT`.

Refuse: `upsert` will not write record files under a known product working tree. Use the vault. Install `memo hook install` to block accidental commits.
