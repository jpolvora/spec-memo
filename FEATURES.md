# Feature list

**Audience: humans and agents** — capability inventory for spec-memo.

Package version: **not shipped**. Status marks: `[ ]` planned · `[~]` in design · `[x]` shipped (proof in [`PLAN.md`](PLAN.md)).

| Doc | Purpose |
|-----|---------|
| **`FEATURES.md`** (this file) | What the product does, feature by feature |
| [`PRODUCT.PRD`](PRODUCT.PRD) | Why, constraints, phases |
| [`PLAN.md`](PLAN.md) | Build order and proof |
| [`README.md`](README.md) | Human overview |
| [`AGENTS.md`](AGENTS.md) | Agent contract |

---

## 1. Project binding

- [x] **Remote identity.** Normalize `git remote get-url origin` (or configured remote) to a stable project id (strip credentials, trailing `.git`, case rules for github.com). Same remote from two clone paths is one project.
- [x] **Fallback identity.** No remotes → id from canonical absolute repo root. Document the collision risk if the folder is copied.
- [x] **Last-seen root.** Record the product working tree path in `project.json` for refuse-write checks. Not committed to the product.
- [x] **Zero product files.** Binding does not create `.spec-memo.json` or similar in the consumer repo.

---

## 2. Record store

- [x] **Typed Markdown records.** One file per record, YAML frontmatter per [`PRODUCT.PRD`](PRODUCT.PRD) § Frontmatter. Body is Markdown.
- [x] **Kinds.** `trap`, `decision`, `spec`, `plan`, `state`, `log`, `scratch`, `review` with the retention table in the PRD.
- [x] **Compiled views.** Regenerated, never hand-edited: `INDEX.md`, `TRAPS.md`, `DECISIONS.md`. Rebuild from sources (no merge of compiled files).
- [x] **Trap shape.** Layer, module, severity, pathPatterns, scenario, DO NOT, INSTEAD DO — compatible with today’s workflow-skills memory entries so import is mechanical.
- [x] **Decision shape.** Title, status (`proposed` / `accepted` / `superseded`), rationale, alternatives considered (optional).
- [x] **Spec of record.** Single spec per slug in the vault. No `step-00` duplicate. Optional `linkedPaths` + `verifiedAtSha`.

---

## 3. Index

- [x] **SQLite FTS5.** Query by text, kind, status, slug, pathPatterns, severity, tags, project.
- [x] **Disposable DB.** Delete `memo.sqlite` and rebuild from the vault. The DB is never the source of truth.
- [x] **Default search filter.** Exclude `scratch`, `state`, `log`, `review` unless the caller sets `kinds`.

---

## 4. MCP tools

One stdio MCP server. Tool descriptions are the interface; vault paths are not.

| Tool | Status | Job | Returns |
|------|--------|-----|---------|
| `bootstrap` | [x] | Bind cwd’s git remote; compile a session brief | Traps (medium+, path/keyword match, cap), open accepted decisions that match, live spec/plan slugs, drift flags, notices if truncated |
| `search` | [x] | Filtered retrieval | id, kind, score, snippet, status |
| `get` | [x] | Read one record by id or `kind+slug` | Full markdown + frontmatter |
| `upsert` | [x] | Write/update trap, decision, spec, plan, state, review, scratch | id, whether it superseded another; schema errors fail closed |
| `append` | [x] | Changelog / audit event | New event id; never rewrites prior events |
| `forget` | [x] | Supersede or archive | New status. Traps archive unless the caller passes an explicit purge confirmed by the user |
| `gc` | [ ] | Apply TTL, compact shipped plans, rebuild FTS | Counts archived/compacted/deleted (scratch only) |
| `promote` | [ ] | Copy one record into the product repo | Product-relative path. **Default deny** without `destination` inside the product root |

Do not add a ninth tool without a [`PRODUCT.PRD`](PRODUCT.PRD) change.

### Bootstrap include / exclude

**Include:** matching traps (cap 10), accepted decisions that constrain the query/cwd paths, the single live spec+plan for a named slug, spec drift (linked path SHA ≠ `verifiedAtSha`).

**Exclude:** log dumps, shipped plan folders, telemetry, other projects (unless `crossProject: true` — Phase 3).

**Budget:** 8 KB UTF-8. Over budget → drop lowest-rank hits, set `truncated: true`.

---

## 5. CLI

- [ ] **Same module as MCP.** `memo <command>` maps 1:1 to tools: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`.
- [ ] **`memo doctor`.** Vault exists, FTS rebuilds, project binds, reports in-repo pollution under a given product root (does not delete).
- [ ] **`memo import <productRoot>`.** See § Import.
- [ ] **Help and errors on stderr; machine-readable JSON on stdout** when `--json` is passed.

---

## 6. Policy and curator

- [ ] **Schema gate.** Invalid kind/status/frontmatter → error, no write.
- [ ] **TTL.** `scratch` 7 days; `review` 14 days after `relatedSlug` PR merged or 14 days from `updated` if unknown. `gc` applies this.
- [ ] **Plan compact.** `status=shipped` plans reduce to a short result record; detail files become `scratch` then expire.
- [ ] **Log compact.** Monthly roll-up files; events remain searchable via FTS.
- [ ] **Redaction.** `upsert` / `append` reject bodies that look like secrets (PEM headers, `api_key=` assignments, known env-file patterns). Caller must omit the secret; spec-memo does not store a redacted copy of the secret value.
- [ ] **Refuse product-tree write.** If `cwd` or `productRoot` is a git work tree, API/CLI refuse to write record files *under that tree*. Vault writes stay under `$SPEC_MEMO_ROOT`.
- [ ] **Trap dedup (Phase 3).** Same `pathPatterns` + similar DO NOT → supersede instead of a third entry. Phase 1 may no-op with a documented skip.

---

## 7. Import

- [ ] Map `{specsDir}/*.spec.md` → `kind=spec`.
- [ ] Map `{sharedDir}/memory/*.md` → `kind=trap` (preserve severity and pathPatterns when present).
- [ ] Map compiled `MEMORY.md` as skipped (rebuild from entries).
- [ ] Map active `{plansDir}/{slug}/` → `kind=plan` + `kind=state`; skip `telemetry/`, `.runtime/`, `*.jsonl`, `audit-*.log.md`.
- [ ] Map agent changelog entries → `kind=log` (split by heading).
- [ ] Do not import skill bodies (`SKILL.md`, scripts).
- [ ] Idempotent: re-import updates by slug/id, does not duplicate.

---

## 8. Harness adapter (Phase 2 — workflow-skills)

Out of this repo’s Phase 1. Listed so agents do not invent it early.

- [ ] Relocatable consumer hub data (`MEMORY`, `memory/*`, changelog) off `{sharedDir}`-fixed layout.
- [ ] `read-memory` / `update-memory` call spec-memo MCP (or CLI) instead of `Read`/`Write` in the product tree.
- [ ] Skill or git hook blocks new files under product `{plansDir}` / `{specsDir}` / hub memory once the project is bound.

---

## 9. Explicitly not features (v1)

| Idea | Why not |
|------|---------|
| Ninth MCP tool for “list files in vault” | Leaks layout; use `search` |
| Auto-rewrite specs when code changes | Drift is a flag, not an author |
| Auto-`promote` into README | Default deny |
| HTTP/SSE MCP as the only transport | stdio first; extra transports later |
| Bundling the vault in the product clone | Violates UC1 |

---

## 10. Shipped in this repository today

| Capability | Status |
|------------|--------|
| Product requirements and phase map | `[x]` [`PRODUCT.PRD`](PRODUCT.PRD) |
| This inventory | `[x]` |
| Implementation plan | `[x]` [`PLAN.md`](PLAN.md) |
| Agent contract | `[x]` [`AGENTS.md`](AGENTS.md) |
| Human README | `[x]` [`README.md`](README.md) |
| Runtime | `[ ]` |
