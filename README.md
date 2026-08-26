# spec-memo

**Local working memory for coding agents outside the product repository.**

Product git repositories should contain product code: source, tests, and shipped documentation. Agent working state—anti-regression traps, architecture decisions, feature specifications, implementation plans, execution state, and changelogs—belongs in a curated vault **outside** the product repository, queried through an MCP server and matching CLI.

---

## ⚡ Simplified Quick Start

### 1. Installation

Install `spec-memo` globally via npm or run directly with `npx`:

```bash
# Global install (gives you the `memo` CLI)
npm install -g spec-memo

# Or build from source
git clone https://github.com/jpolvora/spec-memo.git
cd spec-memo
npm install
npm run build
npm link
```

### 2. Enable in an MCP Server / Agent Host

`spec-memo` runs as a standard Model Context Protocol (MCP) stdio server (`memo serve` or `node dist/mcp.js`). Configure it in your AI coding environment:

#### Claude Desktop
Add to `claude_desktop_config.json` (`%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "spec-memo": {
      "command": "npx",
      "args": ["-y", "spec-memo", "serve"]
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
      "command": "node",
      "args": ["/path/to/spec-memo/dist/mcp.js"]
    }
  }
}
```

*(Optional HTTP / SSE Transport: Run `node dist/server.js` or configure SSE client connecting to `http://127.0.0.1:3000/sse`)*

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
  (Returns <8KB brief:                                  (Saves traps, decisions,
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
   Returns a token-budgeted brief (<8 KB) containing top ranked anti-regression traps for relevant files, open architecture decisions, active spec/plan slice, and code drift alerts.

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
     memo append --event "Refactored vault locking mechanism and passed all 122 tests"
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
├── config.json                 # Global vault configuration (TTL, budget, git sync)
├── memo.sqlite                 # Disposable SQLite FTS5 search index
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
- **Secret Redaction & Safety**: Built-in pattern filters automatically redact API keys, JWTs, private keys, and bearer tokens from memory records before writing. Writes directed to the product repository root are rejected by default.
- **Automatic Trap Deduplication**: When saving a new trap, `spec-memo` checks token overlap against existing traps with matching path patterns. If overlap exceeds 70%, the older trap is automatically marked as `superseded`.
- **Spec Code Drift Detection**: When specifications declare `linkedPaths` and `verifiedAtSha`, `bootstrap` compares git status and file contents against the verified commit SHA, warning the agent if the product code drifted from the specification.

---

## 🛠️ Advanced Workflows & Utility Commands

### 1. Health Diagnostics & Repository Cleaning (`doctor`)

Inspect vault integrity, SQLite FTS index status, and detect leftover in-repo workflow pollution:

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
  "vaultGit": {
    "enabled": true,
    "remoteUrl": "git@github.com:my-user/my-private-memory-vault.git",
    "branch": "main"
  }
}
```
`spec-memo` will automatically stage and commit vault record mutations and sync with your private repository.

### 5. Promoting Records to Product Documentation (`promote`)

Vault records can be selectively promoted into the product repository with ADR templates:

```bash
memo promote decision-sqlite-fts5 --to docs/adr/001-sqlite-fts5.md --format adr
```

---

## 📋 Command & Tool Reference

| Command / Tool | Role | Key Options |
|---|---|---|
| `bootstrap` | Compile token-budgeted session brief | `--maxBytes`, `--query`, `--path`, `--slug` |
| `search` | Filtered FTS5 retrieval across records | `--kind`, `--tags`, `--path`, `--all`, `--sort` |
| `get` | Fetch single record by ID or kind+slug | `--id`, `--kind`, `--slug` |
| `upsert` | Create or update typed memory record | `--kind`, `--title`, `--severity`, `--path-patterns`, `--body` |
| `append` | Append chronological event log | `--event`, `--kind` |
| `forget` | Archive or permanently delete record | `--id`, `--purge` |
| `gc` | Apply TTL retention and compact plans | `--dry-run`, `--project` |
| `promote` | Safe export of record to product repo | `--id`, `--to`, `--format` (`raw`/`adr`/`madr`/`skill`), `--force`, `--limit` |
| `rank` | List traps by recurrence (CLI-only) | `--layer`, `--limit`, `--backfill`, `--json` |
| `doctor` | Diagnose health & fix repo pollution | `--fix`, `--rebuild`, `--json` |
| `import` | Import legacy `.agents` tree to vault | `--from`, `--vaultRoot` |
| `export-vault` | Export encrypted portable archive | `--password`, `--output`, `--project` |
| `import-vault` | Restore portable archive into vault | `<file>`, `--password` |
| `hook install` | Install pre-commit write-block hook | `--productRoot` |
| `serve` | Run stdio MCP server for agent hosts | *(stdio stream)* |

---

## 📄 License

MIT
