---
name: ws-memo
version: 0.4.0
description: >-
  Route agent working memory through spec-memo MCP (10 tools) and matching CLI extras.
  Trigger on spec-memo, memo vault, bootstrap brief, upsert trap/decision/spec/plan,
  search vault, promote ADR, check version, install skills, memo doctor, rank traps,
  canvas, serve --sse, status monitor, import/export vault, sync-vault, uninstall/teardown,
  configure deployment mode (local, hybrid, remote), or configure project with spec-memo.
invocation_names:
  - ws-memo
  - memo
  - spec-memo
---

# ws-memo

> When this skill is loaded, output "ws-memo loaded."

**Runtime skill** shipped by [spec-memo](https://github.com/jpolvora/spec-memo). Guides agents to use the **MCP server (10 tools) + CLI (`memo`)** for out-of-repo working memory, diagnostics, and project lifecycle management across **local**, **hybrid**, and **remote** deployment modes. Does **not** replace [`ws-spec-memo`](https://github.com/jpolvora/workflow-skills/tree/develop/.agents/skills/ws-spec-memo) (consumer setup/bridge in workflow-skills).

Full tool/CLI map → [`references/SURFACE.md`](references/SURFACE.md). Record kinds and git boundary → [`references/RECORDS.md`](references/RECORDS.md). Host snippet → [`references/MCP-TEMPLATE.json`](references/MCP-TEMPLATE.json).

**Not this skill:** `ws-spec-to-pr*` orch; editing spec-memo source; writing `{plansDir}` / `MEMORY.md` into product git. Ops tools `check_version` and `install_skills` are part of the 10-tool MCP surface.

---

## Deployment Modes: Local, Hybrid & Remote

`spec-memo` supports 3 deployment architectures configured via `memo setup --mode <mode>`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                              LOCAL MODE                                │
│  Agent Host ──(stdio)──> memo serve ──> ~/.spec-memo/ (Local SQLite)   │
│  • 100% offline, zero network, zero token setup                        │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                             HYBRID MODE                                │
│  Agent Host ──(stdio)──> memo serve ──> ~/.spec-memo/ (Authoritative)  │
│                                              │                         │
│                           (debounced sync /  │ (bootstrap pull)        │
│                            manual memo sync) ▼                         │
│                                  Remote Daemon (:3000)                 │
│  • Offline-first speed + central team sync; fails open if offline      │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                             REMOTE MODE                                │
│  Agent Host ──(stdio)──> memo serve (Proxy) ──(HTTP/SSE)──> Daemon     │
│  • Zero local disk footprint; ideal for ephemeral CI & cloud devboxes   │
└────────────────────────────────────────────────────────────────────────┘
```

| Dimension | `local` (Default) | `hybrid` | `remote` |
|---|---|---|---|
| **Primary Store** | Local disk (`~/.spec-memo/`) | Local disk cache (`~/.spec-memo/`) | Remote daemon |
| **Local Disk Records** | Yes (authoritative) | Yes (authoritative cache) | None (zero local records) |
| **Network Requirement** | None (100% offline) | Periodic sync to daemon | Continuous connection to daemon |
| **Offline Behavior** | Fully operational | Fails open (local cache works) | Fails closed (returns error) |
| **Authentication Token** | Not required | Required (`SPEC_MEMO_AUTH_TOKEN`) | Required (`SPEC_MEMO_AUTH_TOKEN`) |
| **Mutating Operations** | Immediate local write | Local write + background sync | Proxied to remote daemon |
| **Local Disk CLI Tools** | All available | All available | Refuse with exit code 1 |
| **Best For** | Solo development, laptops | Team sync with offline speed | Ephemeral CI/CD, dev containers |

---

## Global vs. Workspace Scope & Portability

`ws-memo` operates identically across different installation locations:

- **Global Skills Directory** (`{globalSkillsRoot}/ws-memo`, e.g. `~/.gemini/config/skills/ws-memo/`):
  - Agent accesses `ws-memo` across all workspaces on the machine without committing skill files into individual repositories.
  - Recommended for global developer setups.
- **Workspace Skills Directory** (`.agents/skills/ws-memo/`):
  - Project-local copy installed via `memo install-skills --product-root .` (or MCP `install_skills`).
  - Scoped to that specific repository.

### Portability Principles
1. **Zero in-repo memory footprint**: Working memory, traps, plans, and session state live strictly in the external vault (`$SPEC_MEMO_ROOT` or `~/.spec-memo/`), never in product git.
2. **Dynamic project binding**: Project identity is auto-resolved from `cwd` (normalized git remote origin or stable fallback path ID). Cloning the repo to a different path resolves to the same project vault.
3. **Encrypted & portable archives**: Move vault records between machines using `memo export-vault` and `memo import-vault` (optional AES-256-GCM encryption via `SPEC_MEMO_VAULT_PASSWORD`).
4. **Peer delta sync**: Synchronize delta changesets directly between two vault directories with `memo sync-vault <target> [--two-way]`.

---

## Project Onboarding & Configuration Guide

Follow these steps to configure `spec-memo` in any project:

### Step 1: Install CLI & MCP Runtime
```bash
npm install -g spec-memo
# Or run without global install via npx:
# npx -y spec-memo <command>
```

### Step 2: Configure Deployment Mode & Host MCP Wiring
Run `memo setup` with your desired mode and target IDE host:

#### Option A: Local Mode (Default)
```bash
memo setup --mode local --host cursor --write-mcp
# Supported hosts: cursor, vscode, opencode, antigravity, claude, generic
```

#### Option B: Hybrid Mode (Local Cache + Central Daemon)
```bash
export SPEC_MEMO_AUTH_TOKEN="your-secure-bearer-token"
memo setup --mode hybrid --url http://daemon-host:3000 --host cursor --write-mcp
```
- Local vault acts as authoritative cache.
- `bootstrap` pulls remote deltas before compiling briefs (fail-open).
- Mutating operations (`upsert`, `append`, `forget`) debounce background pushes.
- Manual sync: `memo sync [--all] [--dry-run]`.

#### Option C: Remote Mode (Zero Local Disk / Thin Client)
```bash
export SPEC_MEMO_AUTH_TOKEN="your-secure-bearer-token"
memo setup --mode remote --url http://daemon-host:3000 --host cursor --write-mcp
```
- Local `memo serve` proxies stdio calls to the remote daemon over HTTP/SSE.
- Zero local records written to disk. Fails closed if daemon is unreachable.

> **Security Rule**: Bearer tokens are NEVER written to `config.json` on disk. Supply them via environment variables (`SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`).

### Step 3: Start Central Daemon (for Hybrid/Remote Server Hosts)
If hosting the central daemon for your team:
```bash
export SPEC_MEMO_AUTH_TOKEN="your-secure-bearer-token"
memo serve --sse --host 0.0.0.0 --port 3000 --status-port 3001
```
- MCP SSE endpoint listens on port `3000`.
- Status monitor dashboard with live activity stream (`/api/events/stream`) runs on port `3001`.
- Non-loopback binds strictly require an auth token.

### Step 4: Install Runtime Skill (Workspace or Global)
- **Workspace-local**:
  ```bash
  memo install-skills --product-root .
  # Or via MCP: call install_skills with { "productRoot": "." }
  ```
- **Global**: Ensure `ws-memo` is installed in `{globalSkillsRoot}/ws-memo/`.

### Step 5: Configure Project Harness (`call configure`)
When using the workflow-skills suite:
1. Run the project configuration wizard (`/ws-configure-project` or `ws-configure-project`).
2. Alternatively, set `"specMemo": { "enabled": true }` in `.agents/skills/ws-shared/config.json`.

### Step 6: Install Pre-Commit Write-Block Guard
```bash
memo hook install
```
Blocks accidental commits of `.agents/plans/`, `MEMORY.md`, `.state.md`, etc. (Emergency bypass: `SKIP_MEMO_HOOK=1 git commit`).

### Step 7: Ingest Legacy In-Tree Memory (if migrating)
```bash
memo import --from .
```
Converts existing `.agents/plans/`, `MEMORY.md`, and specs into vault records.

### Step 8: Verify Setup with Doctor
```bash
memo doctor
```

---

## Transport (prefer MCP)

1. If the host exposes a spec-memo MCP namespace (`spec-memo`, `user-spec-memo`, or `specMemo.mcpServerName`), call those tools. Discover schema before invoke.
2. Else run `{cli}` (default `memo`; or `npx -y spec-memo`) for the same 10 commands plus CLI-only extras in `references/SURFACE.md`.
3. If neither is available: print install (`npm install -g spec-memo`) and `references/MCP-TEMPLATE.json`. STOP unless the user only asked for docs.
   - Done when: a live MCP namespace or `{cli}` is chosen, or STOP with install text.

---

## Router

Match intent, then execute the matching step. Load `references/SURFACE.md` only for argument names not listed here.

| Intent | Step |
|--------|------|
| Configure deployment mode & host MCP wiring | **configure** |
| Session start / brief / traps for this cwd | **session** |
| Find / read vault records | **recall** |
| Write trap, decision, spec, plan, state, review, scratch | **remember** |
| Task-done / audit event | **log** |
| Health, SQLite FTS5 integrity, and in-repo pollution scan | **diagnose** |
| Archive, TTL, plan compaction, trap recurrence | **maintain** |
| Copy vault record into product tree | **publish** |
| Check running vs latest package version | **version** |
| Install this skill into a consumer repo | **install** |
| Canvas / SSE / status monitor page | **observe** |
| Import, backup, restore, peer sync, hybrid sync | **move** |
| Write-block pre-commit hook | **guard** |
| Teardown & uninstall (skill, MCP wiring, hook, vault data) | **uninstall** |

---

## Steps

### configure

1. Configure deployment mode and generate/write host MCP config:
   ```bash
   memo setup [--mode local|hybrid|remote] [--url <remoteUrl>] [--host cursor|vscode|opencode|antigravity|claude|generic] [--print-mcp] [--write-mcp] [--json]
   ```
2. **Uniformity Rule**: All host MCP snippets execute `memo serve` locally over stdio. Mode switching is managed entirely inside vault `config.json`.
3. In `hybrid` and `remote` modes, ensure `SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN` is set in the environment.
   - Done when: setup report or merged host config path is returned.

### session

1. Call MCP `bootstrap` (or `memo bootstrap`) with `cwd` = product root. Add `query`, `path`, `slug` when known. Cap is 8 KB (`maxBytes` default 8192). In hybrid mode, bootstrap pulls remote deltas first (fail open).
2. Apply returned traps (DO NOT / INSTEAD DO) before planning or coding.
   - Done when: a brief is in context (or truncated notice recorded).

### recall

1. `search` with `query` and optional `kinds`, `status`, `tags`, `path`, `sort` (`relevance` \| `occurrences` \| `updated`), `crossProject`, `limit`.
2. `get` by `id` or `kind`+`slug` for the full body.
   - Done when: hits or a not-found error from the tool (not a guessed empty list).

### remember

1. Load [`references/RECORDS.md`](references/RECORDS.md) for kind, trap body, and frontmatter rules.
2. `upsert` with required `kind` + `body`. Never write the same payload under product `.agents/plans`, `.agents/specs`, or `**/MEMORY.md`. In hybrid mode, mutating calls schedule background debounced push.
   - Done when: tool returns an id (schema errors fail closed — fix payload, do not write files).

### log

1. `append` with `event` (required). Optional `kind` (default `log`) and `details`.
   - Done when: a new event id is returned. Never rewrite prior log files.

### diagnose

1. Run CLI `memo doctor [--json] [--rebuild] [--fix] [productRoot]` to perform comprehensive diagnostics:
   - **Vault structure**: Confirms `$SPEC_MEMO_ROOT` (or `~/.spec-memo/`) exists with `config.json` and `projects/`.
   - **Project identity**: Confirms project binding to normalized git remote origin or reports fallback path ID.
   - **SQLite FTS5 integrity**: Verifies `memo.sqlite` accessibility and reports indexed record counts (`--rebuild` reconstructs the FTS index from markdown files).
   - **Repository pollution**: Scans product tree for forbidden workflow files (`.agents/plans/`, `MEMORY.md`, `memory/*.md`, `run.json`, `.state.md`, `telemetry.jsonl`, `*.log.md`). Pass `--fix` to automatically delete detected residue.
   - **Deployment mode & remote health**: Validates local/hybrid/remote mode configuration, tests `/health` endpoint for remote daemons, and checks auth token presence.
   - Done when: diagnostic report is displayed with zero unexpected warnings.

### maintain

1. Recurrence list: CLI `memo rank [--layer] [--limit] [--backfill] [--json]` (or `search` with `sort=occurrences` + `kinds: ["trap"]`).
2. TTL / compact: MCP `gc` (`dryRun` first when unsure). Compacts shipped plans, applies 7-day scratch / 14-day review TTL, rolls up monthly logs, and rebuilds FTS.
3. Archive: MCP `forget` (`purge: true` only with explicit user confirm).
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
   - Status page features: vault list, health diagnostics, UI backup export/import, live activity log (`GET /api/events/stream`).
   - Done when: URLs are printed (or JSON `url` / `statusUrl`). Non-loopback bind without token must fail.

### move

1. Legacy tree → vault: `memo import --from {repoRoot}`.
2. Archive: `memo export-vault` / `memo import-vault` (password via `SPEC_MEMO_VAULT_PASSWORD`, not committed scripts).
3. Peer vaults: `memo sync-vault <target> [--two-way] [--dry-run]`.
4. Hybrid daemon sync: `memo sync [--all] [--dry-run]` (or vault git remote when vaultGit is enabled).
   - Done when: command report is shown. Never embed tokens in helper scripts.

### guard

1. `memo hook install [--productRoot {repo}]` to install the pre-commit write-block hook.
2. Hook blocks commits containing `.agents/plans/`, `MEMORY.md`, or `memory/*.md`.
3. Bypass with `SKIP_MEMO_HOOK=1 git commit` or `git commit --no-verify`.
   - Done when: hook path is printed or install error is shown.

### uninstall

When user requests removing or tearing down `spec-memo` components:

1. **Remove workspace skill**:
   - Delete `.agents/skills/ws-memo/` from the target product repository (`rm -rf .agents/skills/ws-memo`).
2. **Remove global skill (if installed globally)**:
   - Delete `ws-memo` from the global skills directory (`rm -rf ~/.gemini/config/skills/ws-memo` or `{globalSkillsRoot}/ws-memo`).
3. **Remove host MCP registration**:
   - Remove the `"spec-memo"` entry from the host configuration file:
     - Cursor: `~/.cursor/mcp.json`
     - VS Code: `~/.vscode/mcp.json`
     - Antigravity: `~/.gemini/antigravity/mcp_config.json`
     - Claude Desktop: `claude_desktop_config.json` (platform AppData/Application Support)
     - OpenCode: `~/.config/opencode/config.json`
     - Generic: `~/.mcp/mcp_config.json`
4. **Remove pre-commit hook**:
   - Delete `.git/hooks/pre-commit` (or restore `.git/hooks/pre-commit.spec-memo.bak` if a backup exists).
5. **Purge vault data (requires user confirmation)**:
   - Specific project only: `rm -rf ~/.spec-memo/projects/<projectId>` (or under `$SPEC_MEMO_ROOT/projects/<projectId>`).
   - Complete vault purge: `rm -rf ~/.spec-memo` (or `$SPEC_MEMO_ROOT`).
6. **Uninstall CLI package**:
   - `npm uninstall -g spec-memo`
   - Done when: selected components are deleted and verified.

---

## Rules

- MCP surface is exactly **10** tools: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `check_version`, `install_skills`. Further growth needs a PRODUCT.PRD amendment.
- CLI extras (`setup`, `doctor`, `rank`, `canvas`, `serve`, `import`, `hook`, `sync`, `sync-vault`, `export-vault`, `import-vault`) stay CLI-only.
- Remote mode restrictions: CLI extras (`canvas`, `sync-vault`, `export-vault`, `import-vault`, `hook`) refuse with exit code 1. `memo setup`, `memo doctor`, and `memo check-version` execute locally. Tools proxy transparently over stdio to remote daemon.
- Prefer MCP when registered; CLI when MCP is absent or the extra is CLI-only.
- `search.sort=occurrences` and `memo rank` share the same ranking universe (full project scan; do not invent a `rank` MCP tool).
- `promote format=skill` with no `id` fails closed when zero active traps rank (do not write a header-only SKILL.md).
- Language for vault bodies, CLI help, and tool args: **en-us**.
- Consumer harness setup (`specMemo.enabled`, hybrid MEMORY fallback) stays in workflow-skills **ws-spec-memo**. After that setup, this skill owns day-to-day vault ops.
