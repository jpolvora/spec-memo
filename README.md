# spec-memo

**Local working memory for coding agents outside the product repository.** Version **0.11.0**.

[Documentation Website](https://jpolvora.github.io/spec-memo/) · [Architecture & Specs](.agents/specs/index.PRD) · [Changelog](PLAN.md)

Product git repositories should contain product code: source, tests, and shipped documentation. Agent working state—anti-regression traps, architecture decisions, feature specifications, implementation plans, execution state, and changelogs—belongs in a curated vault **outside** the product repository, queried through an MCP server and matching CLI.

---

## ⚡ Simplified Quick Start

### 1. Installation & CLI Setup

`spec-memo` includes both the Model Context Protocol (MCP) server for AI coding environments and the `memo` CLI for interactive terminal usage and agent execution.

#### Quick Install

```bash
# Global install via npm from GitHub (adds `memo` to your npm global bin)
npm install -g github:jpolvora/spec-memo

# Or build from source clone
git clone https://github.com/jpolvora/spec-memo.git
cd spec-memo
npm install
npm run build
npm link
```

---

#### Making `memo` Available Globally on PATH (Windows, Linux, macOS)

The `package.json` declares `"bin": { "memo": "./dist/cli.js" }` and `dist/cli.js` includes the `#!/usr/bin/env node` shebang. Choose the method that best matches your workflow:

##### Option 1: Global Link from Clone (`npm link` — Recommended for Local Development)
When actively developing `spec-memo` or working from a local clone:
```bash
cd /path/to/spec-memo
npm install
npm run build
npm link
```
* **How it works:** npm creates a global symlink/shim (`memo` on Unix; `memo`, `memo.cmd`, `memo.ps1` on Windows) in your global npm prefix directory (e.g., `%AppData%\Roaming\npm` on Windows, `/usr/local/bin` or `~/.nvm/versions/node/<ver>/bin` on Linux/macOS).
* **Live Rebuild Invariant:** The link points directly to `dist/cli.js`. Whenever you compile changes with `npm run build`, your global `memo` command reflects the latest code immediately without needing to re-link or re-install.

##### Option 2: Global Install from Local Path
```bash
# Point npm install directly to your local clone directory
npm install -g "/path/to/spec-memo"
```
* Installs a packaged copy to your npm global directory. Re-run this command after major rebuilds to refresh the global binary.

##### Option 3: Manual Executable Shim (Without `npm link`)
If you prefer not using npm global link or want a standalone wrapper script:

* **Linux / macOS:** Create `~/.local/bin/memo` (or `/usr/local/bin/memo`):
  ```bash
  #!/usr/bin/env bash
  exec node "/path/to/spec-memo/dist/cli.js" "$@"
  ```
  Make it executable: `chmod +x ~/.local/bin/memo`

* **Windows (Command Prompt / PowerShell):** Create `memo.cmd` in a folder that is in your system or user `PATH` (e.g. `C:\bin\memo.cmd` or `%USERPROFILE%\bin\memo.cmd`):
  ```cmd
  @echo off
  node "C:\path\to\spec-memo\dist\cli.js" %*
  ```
  *(Optionally create `memo.ps1` for PowerShell: `& node "C:\path\to\spec-memo\dist\cli.js" @args`)*

---

#### PATH Verification & Troubleshooting

1. **Verify Binary Resolution:**
   ```bash
   # Open a new shell/terminal session and run:
   memo --help
   memo check-version
   ```
2. **If `memo: command not found` persists:**
   * **Restart terminal:** Fresh environment variables (like PATH changes) require a new shell or terminal window.
   * **Check global npm PATH on Windows:** Ensure `%AppData%\Roaming\npm` (or your custom `npm config get prefix`) is in your User or System `PATH` variable.
   * **Check global npm PATH on Linux/macOS:** Ensure `~/.local/bin` or `$(npm config get prefix)/bin` is in your shell profile (`~/.bashrc`, `~/.zshrc`).
3. **IDE MCP vs Terminal CLI:**
   * Your AI editor (Cursor, VS Code, Claude Desktop, Antigravity) configures stdio MCP via `memo setup --write-mcp` or `node /path/to/dist/cli.js serve`.
   * Putting `memo` on your system `PATH` ensures that interactive terminal commands and AI agents executing shell scripts can call `memo bootstrap`, `memo doctor --fix`, `memo search`, etc. anywhere on your machine.


### 2. Deployment Modes & Agent Host Setup

`spec-memo` supports **three operational deployment modes** configured via `memo setup`:

1. **Local Mode (Default):** All memory records, indexing, and queries run directly on the local machine in `~/.spec-memo/`. Zero network dependencies.
2. **Hybrid Mode:** Local vault remains the primary low-latency cache; transparently pulls updates from a shared daemon during `bootstrap` and debounces pushes on mutating operations (`upsert`, `append`, `forget`, `gc`). Works offline seamlessly (fails open).
3. **Remote Mode:** Agent hosts run a local stdio MCP proxy (`memo serve`) that forwards all 11 tools to a central remote daemon. Zero memory records stored on local disk. Fails closed with structured errors when unreachable.

#### Configure with `memo setup`

```bash
# Configure Local mode (default)
memo setup --mode local

# Configure Hybrid mode with a remote SSE daemon
memo setup --mode hybrid --url http://daemon.internal:3000

# Configure Remote mode with a remote SSE daemon
memo setup --mode remote --url http://daemon.internal:3000
```

> **Note on Authentication:** Bearer tokens are read exclusively from environment variables (`SPEC_MEMO_AUTH_TOKEN` or `SPEC_MEMO_SSE_TOKEN`). `memo setup` verifies token presence in your environment without storing secrets in plain text on disk.

#### Generate or Write Host MCP Configuration

All agent hosts (Cursor, VS Code, OpenCode, Antigravity, Claude Desktop) use the same **uniform stdio MCP wiring** (`memo serve`). Mode switching is controlled entirely via `~/.spec-memo/config.json`.

```bash
# Print MCP configuration snippet for your editor
memo setup --host cursor --print-mcp
memo setup --host vscode --print-mcp
memo setup --host claude --print-mcp

# Automatically write/merge MCP configuration directly to your editor's config file
memo setup --host cursor --write-mcp
memo setup --host vscode --write-mcp
```

#### Manual Host Configuration Snippets

#### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "memo",
      "args": ["serve"]
    }
  }
}
```

#### Cursor
Add to `~/.cursor/mcp.json` or open **Cursor Settings > MCP**:
```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "memo",
      "args": ["serve"]
    }
  }
}
```

#### Antigravity / Gemini IDE
Add to `~/.gemini/config/mcp_config.json` or active workspace config:
```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "memo",
      "args": ["serve"]
    }
  }
}
```

#### VS Code / Cline / Roo Code / Windsurf
Add to your extension's MCP configuration settings:
```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "memo",
      "args": ["serve"]
    }
  }
}
```

### Agent skill (`ws-memo`)

Day-to-day vault ops (all **10** MCP tools + CLI extras) are documented as a project skill:

- [`.agents/skills/ws-memo/SKILL.md`](.agents/skills/ws-memo/SKILL.md)

**Preferred install into a consumer repo:**

```bash
memo install-skills --product-root /path/to/consumer
memo install-skills --global --force
# or MCP tool: install_skills { "productRoot": "/path/to/consumer" }
#            install_skills { "global": true, "force": true }
```

Manual copy/symlink of `.agents/skills/ws-memo/` remains a fallback. **Setup** of `specMemo.enabled` in workflow-skills consumers remains [`ws-spec-memo`](https://github.com/jpolvora/workflow-skills) — do not duplicate that bridge here.

---

## 🖥️ Run, serve, status monitor & autoboot

**Audience:** operators and humans. Agents: see [`AGENTS.md`](AGENTS.md).

### Default ports

| Service | Default URL | Start |
|---------|-------------|--------|
| MCP SSE transport | `http://127.0.0.1:3000` (`/sse`, `/message`, `/health`) | `memo serve --sse` |
| Status monitor | `http://127.0.0.1:3001/` | co-starts with `--sse` (disable: `--no-status`; override: `--status-port`) |
| Canvas graph viewer | `http://127.0.0.1:4100` | `memo canvas` |

### How to run (local CLI)

```bash
# After global install or npm link
memo bootstrap
memo search "database lock" --kind trap
memo doctor
```

From a source checkout:

```bash
npm install
npm run build
node dist/cli.js bootstrap
# or: npm link  →  memo …
```

Vault root defaults to `~/.spec-memo/` (`$SPEC_MEMO_ROOT` to override).

### How to serve (MCP)

| Mode | Command | When to use |
|------|---------|-------------|
| **Stdio** (default) | `memo serve` | Cursor / Claude Desktop / Gemini host spawns the process (see MCP configs above) |
| **HTTP / SSE** | `memo serve --sse` | Shared lab daemon, remote MCP URL, or bookmarkable status page |

```bash
# Loopback SSE + status monitor
memo serve --sse
# → MCP SSE:     http://127.0.0.1:3000/sse
# → Health:      http://127.0.0.1:3000/health
# → Status UI:   http://127.0.0.1:3001/

memo serve --sse --port 3000 --status-port 3001
memo serve --sse --no-status          # MCP only
memo serve --sse --json               # machine metadata (includes statusUrl)
```

**Flags:** `--host` (default `127.0.0.1`), `--port`, `--status-port`, `--no-status`, `--auth-token`, `--vaultRoot`.

### Managing Authentication Tokens & Remote Access

`spec-memo` secures non-loopback HTTP/SSE daemon traffic and status monitor access using a single shared Bearer token.

#### 1. Security Principles
* **Zero Secrets on Disk:** Tokens are never stored in vault `config.json`, product files, or Git repositories. They are resolved at runtime from environment variables or command-line flags.
* **Non-Loopback Safety:** Binding beyond loopback (`127.0.0.1`, `localhost`, `::1`) **strictly refuses to start** without a token.
* **Supported Environment Variables:** `SPEC_MEMO_AUTH_TOKEN` (recommended) or `SPEC_MEMO_SSE_TOKEN` (alias).

#### 2. Generate a Secure Token
```bash
# Linux / macOS
openssl rand -hex 32

# Windows (PowerShell)
[guid]::NewGuid().ToString('N')
```

#### 3. Daemon / Server Configuration (Host Machine)

```bash
# Via Environment Variable (recommended)
export SPEC_MEMO_ROOT=/var/lib/spec-memo
export SPEC_MEMO_AUTH_TOKEN="your_generated_token_here"
memo serve --sse --host 0.0.0.0 --port 3000

# Or via CLI flag
memo serve --sse --host 0.0.0.0 --port 3000 --auth-token "your_generated_token_here"
```

For systemd autoboot, configure `Environment=SPEC_MEMO_AUTH_TOKEN=your_generated_token_here` in `/etc/systemd/system/spec-memo.service` (see [systemd setup](#linux--systemd)).

#### 4. Client / Developer Machine Configuration

##### Option A: Stdio Proxy via `memo setup` (Hybrid / Remote Mode)
Export the token in your shell environment (`~/.bashrc`, `~/.zshrc`, or Windows Environment Variables):
```bash
export SPEC_MEMO_AUTH_TOKEN="your_generated_token_here"
memo setup --mode hybrid --url http://daemon.internal:3000 --host cursor --write-mcp
```

##### Option B: Direct SSE MCP Connection
If connecting your IDE (Cursor, VS Code, Claude Desktop, Antigravity) directly to the remote SSE endpoint, provide the `Authorization` header in your MCP configuration:

```json
{
  "mcpServers": {
    "spec-memo": {
      "url": "http://daemon.internal:3000/sse",
      "headers": {
        "Authorization": "Bearer your_generated_token_here"
      }
    }
  }
}
```

#### 5. Status Monitor & API Health Checks

* **Status Monitor Web UI (Port 3001):** Open `http://daemon.internal:3001/` — when a token is configured, the UI redirects to `/login` (password-manager-friendly token field). The session is an HttpOnly cookie; the browser does not put the token in the address bar or API URLs.
* **Health & API Verification:**
  ```bash
  # Check MCP daemon health (port 3000)
  curl -s -H "Authorization: Bearer your_generated_token_here" http://daemon.internal:3000/health

  # Check status monitor API (port 3001)
  curl -s -H "Authorization: Bearer your_generated_token_here" http://daemon.internal:3001/api/status
  ```

#### 6. Diagnose Token Setup
Run `memo doctor` on the client or server to verify whether the deployment mode detects an active token in the environment:
```bash
memo doctor
```

### How to check the SSE status monitor

1. Start `memo serve --sse` (status companion on by default).
2. Open **http://127.0.0.1:3001/** in a browser (favorite that URL).
3. Confirm health cards (MCP host/port, vault count, uptime) and the **live activity log** (tool + HTTP events).
4. Filter by vault/project via the page control or `?project=<projectId>`.

Quick machine checks:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3001/api/status
curl -s http://127.0.0.1:3001/api/vaults
# Live stream (SSE): GET http://127.0.0.1:3001/api/events/stream
```

When a token is set, send `Authorization: Bearer <token>` (or a session cookie from `/login`). All diagnostic status routes remain read-only; only the dedicated backup routes (`POST /api/vaults/export` and `POST /api/vaults/import`) mutate the vault. Canvas (`:4100`) remains a separate graph UI.

### Status monitor backup (UI export & import)

The status monitor on port `:3001` provides a zero-friction UI for routine vault snapshots and disaster recovery:

1. **Export a project vault:**
   - Select a project in the **Vault filter** dropdown.
   - Click **Export vault** in the sidebar.
   - Enter an optional encryption password (AES-256-GCM) or leave blank for plaintext.
   - The browser downloads `spec-memo-vault-{projectId}-{YYYYMMDD-HHmmss}.zip` containing `vault-backup.json`.

2. **Import & restore a project vault:**
   - Click **Choose backup zip…** and select a previously exported `.zip` archive.
   - Click **Run import**.
   - Review the confirmation modal (shows target vault summary and overwrite warning) and enter the password if the archive is encrypted.
   - Click **Confirm & Restore** — records are restored, views and FTS index are rebuilt, and the vault list refreshes immediately without a full page reload.

> [!TIP]
> **Daily backup tip & CLI parity:**
> - Keep regular daily `.zip` exports in your cloud or sync folder for peace of mind.
> - **CLI compatibility:** To restore a UI zip via CLI, extract `vault-backup.json` and run `memo import-vault --archive vault-backup.json`. Conversely, JSON archives created via `memo export-vault --output file.json` can be zipped as `vault-backup.json` and uploaded directly through the UI.
> - **Daemon note:** In hybrid/remote deployments, the status companion operates on the daemon host's `$SPEC_MEMO_ROOT` vault.

### How to diagnose

```bash
memo doctor              # vault + FTS + in-repo pollution scan
memo doctor --json
memo doctor --rebuild    # rebuild SQLite FTS5 from markdown
memo doctor --fix       # delete leftover in-tree workflow residue
```

Also useful: `memo rank` (trap recurrence), `memo gc --dry-run`, and the status page live log while the SSE daemon is up.

### Autoboot: run `memo serve --sse` as a service

Use this so the MCP SSE daemon (and status monitor) start on boot. Prefer a durable vault directory (not a login-user `~/.spec-memo` unless intentional).

#### Linux — systemd

```bash
sudo mkdir -p /var/lib/spec-memo
# Install Node 22 + clone/build to /opt/spec-memo (or npm i -g spec-memo and point ExecStart at `memo`)
```

`/etc/systemd/system/spec-memo.service`:

```ini
[Unit]
Description=spec-memo MCP SSE
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/spec-memo
Environment=SPEC_MEMO_ROOT=/var/lib/spec-memo
# Auth token (SPEC_MEMO_AUTH_TOKEN or SPEC_MEMO_SSE_TOKEN)
Environment=SPEC_MEMO_AUTH_TOKEN=replace-me
ExecStart=/usr/bin/node /opt/spec-memo/dist/cli.js serve --sse --host 0.0.0.0 --port 3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spec-memo.service
sudo systemctl status spec-memo.service
curl -s -H "Authorization: Bearer replace-me" http://127.0.0.1:3000/health
# Status UI: http://<host>:3001/  (also requires the bearer when a token is set)

# Inspect configured environment variables on service:
systemctl show spec-memo.service --property=Environment

# Or inspect live environment variables of the running process:
sudo cat /proc/$(pgrep -f "spec-memo" | head -n 1)/environ | tr '\0' '\n' | grep SPEC_MEMO
```

#### Windows — Task Scheduler (autoboot at logon)

1. Install Node 22 and `npm install -g github:jpolvora/spec-memo` (or build this repo and use the full path to `node` + `dist\cli.js`).
2. Create a vault dir, e.g. `C:\spec-memo-vault`.
3. **Task Scheduler → Create Task**:
   - Trigger: **At log on** (or **At startup** with a service account).
   - Action: Start a program  
     - Program: `node` (full path if needed)  
     - Arguments: `"C:\Users\<you>\AppData\Roaming\npm\node_modules\spec-memo\dist\cli.js" serve --sse --host 127.0.0.1 --port 3000`  
       (or `memo.cmd serve --sse …` if `memo` is on PATH)
   - Start in: vault-friendly working directory.
4. Add environment variables on the task (or a wrapper `.cmd`): `SPEC_MEMO_ROOT=C:\spec-memo-vault`, and `SPEC_MEMO_SSE_TOKEN=…` if binding off loopback.
5. Optional: [NSSM](https://nssm.cc/) / WinSW to wrap the same command as a Windows Service with restart-on-failure.

Verify: open `http://127.0.0.1:3001/` and `curl http://127.0.0.1:3000/health`.

**Shared-lab note:** project identity comes from the git remote of the tool `cwd` / `projectId`. Laptop paths do not exist on the server — pass a stable `projectId` (e.g. `github.com-jpolvora-spec-memo`) or a server-side clone path as `cwd`. One bearer token = shared vault (no per-user ACL).

---

### 3. Enable in Consumer Repositories & Agents

**Zero setup required in product repos.**
`spec-memo` requires **no** configuration files, no `.spec-memo` directory, and no committed pointers in your project.

1. **Automatic Project Identity**: When an agent works in any project directory, `spec-memo` detects the git remote `origin` (e.g. `github.com/org/repo`) and maps all memory to that project's external vault. All clones of the same repository automatically share the exact same working memory.
2. **Prevent Accidental In-Repo Memory Commits**: Install the pre-commit write-block hook in any consumer repository:
   ```bash
   cd /path/to/your-product-repo
   memo hook install
   ```
   *(Blocks accidental commits of `.agents/plans/`, `MEMORY.md`, `memory/*.md`, and `.state.md`)*

---

### 4. Basic Workflow

```
               ┌──────────────────────────────────────────────┐
               │              AI Agent Session                │
               └──────────────────────┬───────────────────────┘
                                      │
           1. Session Start           │ 2. During Work
           ┌──────────────────────────┴──────────────────────────┐
           ▼                                                     ▼
    memo bootstrap                                        memo upsert / append
  (Returns token-budgeted brief:                         (Saves traps, decisions,
   Traps, Decisions, Live Slug, Drift)                   specs, plans, logs to vault)
                                      │
                                      │ 3. Query on Demand
                                      ├──────────────────────────► memo search / get
                                      │
                                      ▼ 4. Session Finish / Housekeeping
                                 memo gc
                        (Purges expired scratch,
                         compacts completed plans)
```

1. **Session Start (`bootstrap`)**:
   At the start of a prompt or task, the agent invokes `bootstrap`:
   ```bash
   memo bootstrap
   ```
   Returns a token-budgeted brief (default 8 KB; raise via `~/.spec-memo/config.json` `bootstrap.maxBytes` or `--maxBytes`) containing top ranked anti-regression traps for relevant files, open architecture decisions, active spec/plan slice, and code drift alerts.

2. **During Work (`upsert` & `append`)**:
   - Record newly discovered bug traps or anti-regression lessons:
     ```bash
     memo upsert --kind trap --title "SQLite WAL Lock on Windows" --severity high --path-patterns "src/db/*.ts" --body "Always close statements before closing connection."
     ```
   - Record an architectural decision:
     ```bash
     memo upsert --kind decision --title "Use SQLite FTS5 for Search" --body "ADR: FTS5 provides fast local indexing with zero external daemons."
     ```
   - Append an audit or task event:
     ```bash
     memo append --event "Refactored vault locking mechanism and passed all 178 tests"
     ```

3. **Query Memory (`search` & `get`)**:
   - Filtered full-text search:
     ```bash
     memo search "database lock" --kind trap
     ```
   - Fetch a specific record by ID or slug:
     ```bash
     memo get --id trap-sqlite-wal-lock-on-windows
     ```

4. **Finishing & Housekeeping (`gc` & `promote`)**:
   - Run garbage collection to apply TTL retention (purges 7-day scratch, 14-day review records, and compacts completed plans):
     ```bash
     memo gc
     ```
   - If a human explicitly wants a decision or spec recorded in product documentation, promote it into the product repository:
     ```bash
     memo promote trap-sqlite-wal-lock-on-windows --to docs/adr/002-sqlite-locking.md
     ```

---

## 🔍 Detailed Architecture & How It Works

### The Vault Outside Git

All memory is stored in `$SPEC_MEMO_ROOT` (defaults to `~/.spec-memo/`):

```
~/.spec-memo/
├── config.json                 # Global vault configuration (TTL, budget, enableTelemetry, git sync)
├── memo.sqlite                 # Disposable SQLite FTS5 search index
├── telemetry/                  # Append-only daily rolling usage logs (telemetry-YYYY-MM-DD.part-N.jsonl)
└── projects/
    └── <projectId>/            # Hash derived from git remote origin
        ├── project.json        # Project metadata, remote URL, display name
        ├── TRAPS.md            # Auto-compiled markdown view of active traps
        ├── DECISIONS.md        # Auto-compiled markdown view of architecture decisions
        ├── INDEX.md            # Auto-compiled markdown view of all project specs & plans
        ├── traps/              # Individual *.md records with YAML frontmatter
        ├── decisions/          # Architecture decisions (ADRs)
        ├── specs/              # Feature specifications
        ├── plans/              # Implementation plans and execution state
        ├── logs/               # Append-only chronological run logs & roll-ups
        ├── reviews/            # Code review and audit notes (14-day TTL)
        └── scratch/            # Temporary scratchpad notes (7-day TTL)
```

### Core Architecture Highlights

- **Markdown Source of Truth**: Every record is a human-readable Markdown file with structured YAML frontmatter.
- **Disposable SQLite FTS5 Index**: `memo.sqlite` provides instant Porter-stemmed search, tag filtering, and path pattern globbing. If deleted or corrupted, it is automatically rebuilt from the Markdown files.
- **Automatic Project Identity**: Repositories are identified by normalized remote URL (`git@github.com:org/repo.git` → `github.com/org/repo`). Multiple clones on the same machine share the same memory without conflicts.
- **Operational Telemetry & Usage Analytics**: Built-in rolling JSONL telemetry records tool latencies, endpoints, duration, and error codes under `~/.spec-memo/telemetry/` (`enableTelemetry: true`). Asynchronously batched with zero disk blockages and secret redaction.
- **Secret Redaction & Safety**: Built-in pattern filters automatically redact API keys, JWTs, private keys, and bearer tokens from memory records before writing. Writes directed to the product repository root are rejected by default.
- **Automatic Trap Deduplication**: When saving a new trap, `spec-memo` checks token overlap against existing traps with matching path patterns. If overlap exceeds 70%, the older trap is automatically marked as `superseded`.
- **Spec Code Drift Detection**: When specifications declare `linkedPaths` and `verifiedAtSha`, `bootstrap` compares git status and file contents against the verified commit SHA, warning the agent if the product code drifted from the specification.

---

## 🛠️ Advanced Workflows & Utility Commands

### 1. Health Diagnostics & Repository Cleaning (`doctor`)

Inspect vault integrity, SQLite FTS index status, and detect leftover in-repo workflow pollution. (Also see [Run, serve, status monitor & autoboot](#️-run-serve-status-monitor--autoboot) for live SSE status checks.)

```bash
# Check vault health and scan product repository for residue
memo doctor

# Check and automatically clean up in-tree workflow pollution files
memo doctor --fix

# Rebuild the SQLite FTS5 index from vault markdown records
memo doctor --rebuild
```

### 2. Import Legacy Workflow Trees (`import`)

One-shot migration of existing `.agents/specs/`, `memory/*.md`, `MEMORY.md`, `.agents/plans/`, and `CHANGELOG.md` files into the external vault:

```bash
memo import --from /path/to/legacy-repo
```

### 3. Encrypted Vault Backup & Restore (`export-vault` / `import-vault`)

Export portable, optionally encrypted JSON archives using AES-256-GCM and PBKDF2 key derivation:

```bash
# Export encrypted vault archive
memo export-vault --password "my-secure-password" -o ~/spec-memo-backup.json

# Restore vault archive on another machine
memo import-vault ~/spec-memo-backup.json --password "my-secure-password"
```

### 4. Optional Private Git Remote Sync (`vault-git`)

Enable automatic private git remote backup on the vault root (`~/.spec-memo/`):

In `~/.spec-memo/config.json`:
```json
{
  "bootstrap": {
    "maxBytes": 8192
  },
  "vaultGit": {
    "enabled": true,
    "remoteUrl": "git@github.com:my-user/my-private-memory-vault.git",
    "branch": "main"
  }
}
```
`bootstrap.maxBytes` is the default UTF-8 session brief budget (8192). Increase it to return a larger `memo bootstrap` payload; per-call `--maxBytes` / MCP `maxBytes` still overrides this value.

`spec-memo` will automatically stage and commit vault record mutations and sync with your private repository when `vaultGit.enabled` is true.

### 5. Promoting Records to Product Documentation (`promote`)

Vault records can be selectively promoted into the product repository with ADR templates:

```bash
memo promote decision-sqlite-fts5 --to docs/adr/001-sqlite-fts5.md --format adr
```

---

## 📋 Command & Tool Reference

| Command / Tool | Role | Key Options |
|---|---|---|
| `setup` | Configure deployment mode & agent host MCP wiring | `--mode`, `--url`, `--host`, `--print-mcp`, `--write-mcp`, `--json` |
| `bootstrap` | Compile token-budgeted session brief | `--maxBytes` (overrides `config.json` `bootstrap.maxBytes`, default 8192), `--query`, `--path`, `--slug` |
| `search` | Filtered FTS5 retrieval across records | `--kind`, `--tags`, `--path`, `--all`, `--sort` |
| `get` | Fetch single record by ID or kind+slug | `--id`, `--kind`, `--slug` |
| `upsert` | Create or update typed memory record | `--kind`, `--title`, `--severity`, `--path-patterns`, `--body` |
| `append` | Append chronological event log | `--event`, `--kind` |
| `forget` | Archive or permanently delete record | `--id`, `--purge` |
| `gc` | Apply TTL retention and compact plans | `--dry-run`, `--project` |
| `promote` | Safe export of record to product repo | `--id`, `--to`, `--format` (`raw`/`adr`/`madr`/`skill`), `--force`, `--limit` |
| `check_version` / `check-version` | Compare running version to npm latest | `--json` |
| `install_skills` / `install-skills` | Install `ws-memo` / `ws-session-tracking` into a consumer repo or global skills roots | `--product-root`, `--global`, `--skill`, `--force`, `--json` |
| `prompt` / `prompts` | Ingest & query prompt history; derive rules; export stories | `record`/`list`/`search`/`show`/`session`/`export`/`derive-rules` |
| `session` | Start/end/inspect work sessions (alias into `prompt`) | `start`/`end`/`show`/`export`, `--summary`, `--pr` |
| `activity` | Timesheet / invoicing activity report | `--since`, `--until`, `--client`, `--json` |
| `rank` | List traps by recurrence (CLI-only) | `--layer`, `--limit`, `--backfill`, `--json` |
| `doctor` | Diagnose health, mode, and fix repo pollution | `--fix`, `--rebuild`, `--json` |
| `sync` | Synchronize vault records (hybrid mode or vault-git) | `--all`, `--dry-run`, `--json` |
| `import` | Import legacy `.agents` tree to vault | `--from`, `--vaultRoot` |
| `export-vault` | Export encrypted portable archive | `--password`, `--output`, `--project` |
| `import-vault` | Restore portable archive into vault | `<file>`, `--password` |
| `hook install` | Install pre-commit write-block hook | `--productRoot` |
| `serve` | Run stdio MCP server for agent hosts | `--sse`, `--port`, `--status-port`, `--no-status`, `--auth-token` *(stdio stream)* |

### Operator Q&A

**How do I check if I am on the latest spec-memo?**

```bash
memo check-version --json
```

Compare `current` to `latest`. When the registry is unreachable, `updateAvailable` is `"unknown"` and `latest` is `null`.

**How do I install the `ws-memo` skill into a consumer project?**

```bash
memo install-skills --product-root /path/to/consumer
# Global (Cursor/agents + Antigravity if ~/.gemini/config exists):
memo install-skills --global --force
```

Use `--force` only when overwriting a diverged destination. MCP hosts can call `install_skills` with the same arguments (`global: true` for global roots).

**How do I make the `memo` command available on my PATH (Windows / Linux / macOS)?**

Run `npm link` inside your `spec-memo` clone directory. This links the package bin (`"memo": "./dist/cli.js"`) to your npm global directory (e.g. `%AppData%\Roaming\npm` on Windows or `/usr/local/bin` on Linux). After running `npm run build`, `memo` is immediately accessible in any new terminal session without re-linking. See [Making `memo` Available Globally on PATH](#making-memo-available-globally-on-path-windows-linux-macos) for manual shim alternatives and PATH troubleshooting.

---



## 📄 License

MIT
