# Vault Root and Project Identity

## Feature Overview

The vault is the local working-memory store that lives outside any product repository. Its root is resolved with a fixed priority chain and defaults to `~/.spec-memo`; the `$SPEC_MEMO_ROOT` environment variable overrides it. Every record operation first binds a working directory (`cwd`) to a stable `projectId`, then reads or writes under `<vaultRoot>/projects/<projectId>/`.

Project identity exists so two distinct clones (or worktrees) of the same repository share one memory partition, while a remote-less local repo still gets a deterministic partition. Identity is derived from the normalized git remote URL; when no remote exists, a hash of the canonical absolute path is used. A per-directory `.spec-memo.json` file can override the bound id without touching vault code.

Agent journeys: an agent starts a session by calling `bootstrap` with `cwd = product root`; the runtime resolves identity and scaffolds the project vault. Operators inspect the same binding through `memo doctor`, `memo status`, and `memo vault list`. All MCP tool handlers (`bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`, `prompt`) resolve identity from the `cwd`/`projectId` arguments; no dedicated identity tool exists (the MCP surface stays at 11 tools).

Operator surfaces that expose identity: `memo doctor` reports project binding (normalized remote vs path fallback) and vault structure; `memo status` reports the resolved vault root and per-project metadata; `memo vault list` prints `id`, `displayName`, and record count per project; `memo setup [--mode local|hybrid|remote]` writes deployment configuration. `bootstrap` with no `projectId` is the canonical binding path used by all other tools.

A typical vault layout after a bind:

```text
$SPEC_MEMO_ROOT/                 # default ~/.spec-memo
├── config.json                  # VaultConfig (ports, ttl, bootstrap, vaultGit, mode)
├── memo.sqlite                  # disposable FTS5 index
└── projects/<projectId>/
    ├── project.json             # ProjectMetadata
    ├── INDEX.md TRAPS.md DECISIONS.md PROMPTS.md SESSIONS.md
    └── traps/ decisions/ specs/ plans/ logs/ reviews/ scratch/ prompts/ sessions/
```

The `0011-dogfood-remap` proof is a consumer-side configuration exercise: setting `plans.dir` and `plans.specsDir` to absolute paths under a `~/.spec-memo-test/<project>/` directory keeps plan/spec artifacts outside the product git tree with zero `spec-memo` code changes. It demonstrated that tree isolation is achievable through configuration redirection alone and flagged that runtime relocation of `{sharedDir}` and `MEMORY.md` was the Phase 1/2 work.

## Business Rules & Logic

Vault root resolution (`getVaultRoot`) tries candidates in order and picks the first *usable* one:

1. Explicit override argument (`--vaultRoot` / options.vaultRoot).
2. `$SPEC_MEMO_ROOT` environment variable.
3. `vaultRoot` pointer in bootstrap `~/.spec-memo/config.json`.
4. Current directory when it contains both `config.json` and `projects/`.
5. Fallback `~/.spec-memo/` (always returned even if currently inaccessible).

A candidate is usable when it exists as a writable directory, or when its nearest existing ancestor is a writable directory. Empty, non-directory, or non-writable candidates are skipped.

Vault scaffolding (`ensureVaultStructure`) creates `<root>/`, `<root>/projects/`, `<root>/telemetry/`, and writes default `<root>/config.json` only when missing. `DEFAULT_VAULT_CONFIG` establishes concrete defaults: `defaultRemote: origin`, `enableTelemetry: true`, `ttl.scratchDays: 7`, `ttl.reviewDays: 14`, `bootstrap.maxBytes: 8192`, `bootstrap.maxTraps: 10`, and `ports` `sse: 3123`, `status: 3124`, `canvas: 3125`.

Project vault scaffolding (`ensureProjectVault`) creates the record subdirectories `RECORD_SUBDIRS = traps, decisions, specs, plans, logs, reviews, scratch, prompts, sessions` and writes `project.json` with `projectId`, `gitRemote`, `displayName`, `lastSeenRoot`, `knownRoots`, `createdAt`, `updatedAt`. `knownRoots` is the union of all previously seen roots plus the current one; `displayName` defaults to the basename of the first-seen root and is never blanked once set.

Git remote normalization (`normalizeGitRemote`) strips credentials/userinfo, protocol variants (`git+`, `ssh://`, `https://`, `git://`), a trailing `.git`, and trailing slashes, then lowercases host and path. Special cases: `ssh.github.com` folds to `github.com`, `altssh.bitbucket.org` folds to `bitbucket.org`, Azure DevOps forms collapse to `dev.azure.com/<org>/<project>/<repo>` (handling `v1/`, `_git`, `defaultcollection`, and `*.visualstudio.com` orgs), and AWS CodeCommit URLs normalize to `<host>/<repo>` with the `v1/` prefix removed. `projectId` from a remote (`generateProjectIdFromRemote`) lowercases and replaces every character outside `[a-z0-9._-]` with `-`, collapsing runs and trimming edge dashes.

Fallback identity (`generateProjectIdFromPath`) is `local-<sanitized-basename>-<sha256(canonical-lowercase-path)[0..8]>`. Remote selection prefers `origin`, then `upstream`, then the first configured remote; it reads `.git/config` first and falls back to `git remote get-url`. If the resolved remote URL points at a local directory that is itself a git repo, the resolver recurses to that repo's upstream (up to 3 hops) so clones-of-clones share identity; a pure local repo with no upstream yields a path-based id and `isFallback: true`.

File-first override: `findLocalSpecMemoConfig` walks upward from the usable `cwd` to the enclosing git root (or filesystem root), checking `.spec-memo.json` at each level. Malformed or unreadable files are ignored and the walk continues. `projectId` in that file is honored only when filesystem-safe; it is then passed through alias resolution. The config file may carry only the known override keys `bootstrap`, `ports`, `vaultGit`, `telemetry`, `ttl`, and `sync`; any key matching `token|secret|password|api_?key|auth|private_?key|bearer|credentials` is stripped and the whole override is dropped if a payload secret scan still flags it. Discovery never reads a config from inside the vault root itself.

Project aliases live in `config.json` under `projectAliases` (source id → canonical id). `resolveCanonicalProjectId` follows the chain and throws `VaultManagerError` on a detected cycle. `isFilesystemSafeProjectId` accepts only `^[a-z0-9._-]+$` and rejects the reserved token `all`.

Safety invariants: `findGitRoot` never returns the vault root or any directory inside it, so the vault is never mistaken for a consumer repo. `assertNotInProductRoot` blocks record writes into the consumer product tree. The entire vault is protected by a re-entrant file lock (`<vaultRoot>/.memo.lock`): an exclusive lock has an 8 s acquisition deadline and steals a lock whose mtime is older than 10 s; mutations and scaffolding run under it.

## Technical Architecture

Primary modules: `src/vault.ts` (`getVaultRoot`, `ensureVaultStructure`, `ensureProjectVault`, `initVault`, lock helpers), `src/identity.ts` (`normalizeGitRemote`, `generateProjectIdFromRemote`, `generateProjectIdFromPath`, `getGitRemoteUrl`, `resolveProjectIdentity`, `findLocalSpecMemoConfig`, `getEffectiveVaultConfig`), and `src/vault-manager.ts` (`resolveCanonicalProjectId`, `isFilesystemSafeProjectId`). Types are in `src/types.ts` (`ProjectIdentity`, `ProjectMetadata`, `VaultConfig`).

`ProjectIdentity` is the binding contract: `projectId`, `normalizedRemote` (null for fallback), `rootPath` (product working tree), `isGit`, `isFallback`, `vaultProjectPath` (`<vaultRoot>/projects/<projectId>`), optional `identitySource` (`file` | `git` | `path`), and optional `configFilePath`. The resolution order inside `resolveProjectIdentity` is `.spec-memo.json` (source `file`) → git remote (`git`) → path hash (`path`). Alias resolution is applied to the base id before the vault path is formed.

`getEffectiveVaultConfig(cwd, vaultRoot)` merges global `config.json` with allowed local `.spec-memo.json` overrides one level deep for nested objects and by replacement for scalars. Only identity binding and status reporting consume overrides today.

Persistence side effects: `ensureVaultStructure` may create directories and `config.json`; `ensureProjectVault` creates subdirectories and rewrites `project.json` with `updatedAt = now` on every bind. Both stay entirely under `<vaultRoot>`. `vaultGit` is opt-in and orthogonal to identity: `initVaultGit` runs only when `config.vaultGit.enabled` is true and mode is not `remote`, and writes a `.gitignore` containing `memo.sqlite`, `memo.sqlite-wal`, `memo.sqlite-shm`, `.sync/`, `error.logs`, `telemetry/`, and `backups/`.

Provenance: `0002-vault-and-identity.spec.md` (vault layout, remote normalization, fallback id, `project.json`), refined by dogfood isolation evidence in `0011-dogfood-remap.spec.md`; `0047-vault-merge-alias.spec.md` and `0050-vault-dedup-merge-and-local-config.spec.md` added alias resolution and local override handling.
