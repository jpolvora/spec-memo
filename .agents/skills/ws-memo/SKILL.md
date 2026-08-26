---
name: ws-memo
version: 0.3.2
description: >-
  Route agent working memory through spec-memo MCP (10 tools) and matching CLI extras.
  Trigger on spec-memo, memo vault, bootstrap brief, upsert trap/decision/spec/plan,
  search vault, promote ADR, check version, install skills, memo doctor, rank traps,
  canvas, serve --sse, status monitor, import/export vault, or sync-vault.
invocation_names:
  - ws-memo
  - memo
  - spec-memo
---

# ws-memo

> When this skill is loaded, output "ws-memo loaded."

**Runtime skill** shipped by [spec-memo](https://github.com/jpolvora/spec-memo). Teaches agents to use the **MCP server + CLI** for vault ops. Does **not** replace [`ws-spec-memo`](https://github.com/jpolvora/workflow-skills/tree/develop/.agents/skills/ws-spec-memo) (consumer setup/bridge in workflow-skills).

Full tool/CLI map → [`references/SURFACE.md`](references/SURFACE.md). Record kinds and git boundary → [`references/RECORDS.md`](references/RECORDS.md). Host snippet → [`references/MCP-TEMPLATE.json`](references/MCP-TEMPLATE.json).

**Not this skill:** `ws-spec-to-pr*` orch; editing spec-memo source; writing `{plansDir}` / `MEMORY.md` into product git. Ops tools `check_version` and `install_skills` are part of the 10-tool MCP surface.

## Transport (prefer MCP)

1. If the host exposes a spec-memo MCP namespace (`spec-memo`, `user-spec-memo`, or `specMemo.mcpServerName`), call those tools. Discover schema before invoke.
2. Else run `{cli}` (default `memo`; or `npx -y spec-memo`) for the same 10 commands plus CLI-only extras in SURFACE.md.
3. If neither is available: print install (`npm install -g spec-memo`) and MCP-TEMPLATE.json. STOP unless the user only asked for docs.
   - Done when: a live MCP namespace or `{cli}` is chosen, or STOP with install text.

## Router

Match intent, then execute the matching step. Load SURFACE.md only for argument names not listed here.

| Intent | Step |
|--------|------|
| Session start / brief / traps for this cwd | **session** |
| Find / read vault records | **recall** |
| Write trap, decision, spec, plan, state, review, scratch | **remember** |
| Task-done / audit event | **log** |
| Archive, TTL, doctor, rank | **maintain** |
| Copy vault record into product tree | **publish** |
| Check running vs latest package version | **version** |
| Install this skill into a consumer repo | **install** |
| Canvas / SSE / status page | **observe** |
| Import, backup, restore, peer sync, vault-git | **move** |
| Write-block hook | **guard** |

## Steps

### session

1. Call MCP `bootstrap` (or `memo bootstrap`) with `cwd` = product root. Add `query`, `path`, `slug` when known. Cap is 8 KB (`maxBytes` default 8192).
2. Apply returned traps (DO NOT / INSTEAD DO) before planning or coding.
   - Done when: a brief is in context (or truncated notice recorded).

### recall

1. `search` with `query` and optional `kinds`, `status`, `tags`, `path`, `sort` (`relevance` \| `occurrences` \| `updated`), `crossProject`, `limit`.
2. `get` by `id` or `kind`+`slug` for the full body.
   - Done when: hits or a not-found error from the tool (not a guessed empty list).

### remember

1. Load [`references/RECORDS.md`](references/RECORDS.md) for kind, trap body, and frontmatter rules.
2. `upsert` with required `kind` + `body`. Never write the same payload under product `.agents/plans`, `.agents/specs`, or `**/MEMORY.md`.
   - Done when: tool returns an id (schema errors fail closed — fix payload, do not write files).

### log

1. `append` with `event` (required). Optional `kind` (default `log`) and `details`.
   - Done when: a new event id is returned. Never rewrite prior log files.

### maintain

1. Health / pollution: CLI `memo doctor [--json] [--rebuild] [--fix] [productRoot]` (not an MCP tool).
2. Recurrence list: CLI `memo rank [--layer] [--limit] [--backfill] [--json]` (or `search` with `sort=occurrences` + `kinds: ["trap"]`).
3. TTL / compact: MCP `gc` (`dryRun` first when unsure).
4. Archive: MCP `forget` (`purge: true` only with explicit user confirm).
   - Done when: the chosen command exits 0 or returns a structured error.

### publish

1. MCP `promote` requires product-relative `destination`. Formats: `raw` \| `adr` \| `madr` \| `skill`.
2. `format=skill` with omitted `id` compiles top `limit` (default 10) ranked traps.
   - Done when: destination path is returned, or default-deny error is shown (missing dest / outside product / under `.git/`).

### version

1. Call MCP `check_version` (or `memo check-version [--json]`).
2. Read `current`, `latest`, `updateAvailable` (`true` \| `false` \| `"unknown"`), and `source` (`npm` \| `offline`).
   - Done when: structured version payload is returned (offline soft-fails with `updateAvailable: "unknown"`).

### install

1. Call MCP `install_skills` with `productRoot` (or `cwd`) targeting the consumer repo. Default skill: `ws-memo`.
2. Pass `force: true` only when overwriting a diverged destination. Do not invent skill ids outside the allow-list.
   - Done when: destination path(s) are returned, or a default-deny / unknown-skill error is shown.

### observe

1. Graph UI: `memo canvas` (default `http://127.0.0.1:4100`).
2. Network MCP: `memo serve --sse` (SSE `http://127.0.0.1:3000`; status `http://127.0.0.1:3001` unless `--no-status`). Flags: `--port`, `--status-port`, `--host`, `--auth-token`.
   - Done when: URLs are printed (or JSON `url` / `statusUrl`). Non-loopback bind without token must fail.

### move

1. Legacy tree → vault: `memo import --from {repoRoot}`.
2. Archive: `memo export-vault` / `memo import-vault` (password via `SPEC_MEMO_VAULT_PASSWORD`, not committed scripts).
3. Peer vaults: `memo sync-vault <target> [--two-way] [--dry-run]`.
4. Vault git remote: `memo sync` when vault-git is enabled in vault `config.json`.
   - Done when: command report is shown. Never embed tokens in helper scripts.

### guard

1. `memo hook install [--productRoot {repo}]` to block committing workflow residue.
   - Done when: hook path is printed or install error is shown.

## Rules

- MCP surface is exactly **10** tools: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version`, `install_skills`. Further growth needs a PRODUCT.PRD amendment.
- CLI extras (`doctor`, `rank`, `canvas`, `serve`, `import`, `hook`, `sync`, `sync-vault`, `export-vault`, `import-vault`) stay CLI-only.
- Prefer MCP when registered; CLI when MCP is absent or the extra is CLI-only.
- `search.sort=occurrences` and `memo rank` share the same ranking universe (full project scan; do not invent a `rank` MCP tool).
- `promote format=skill` with no `id` fails closed when zero active traps rank (do not write a header-only SKILL.md).
- Language for vault bodies, CLI help, and tool args: **en-us**.
- Consumer harness setup (`specMemo.enabled`, hybrid MEMORY fallback) stays in workflow-skills **ws-spec-memo**. After that setup, this skill owns day-to-day vault ops.
