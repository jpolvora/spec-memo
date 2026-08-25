---
id: null
slug: vault-and-identity
title: "Vault root and project identity from git remote"
source: local
specDate: 2026-08-22
---

# Specification — Vault root and project identity from git remote

## Description

Initialize the local filesystem vault structure under `$SPEC_MEMO_ROOT` (default `~/.spec-memo`) and establish stable project identity resolution. The project identifier (`projectId`) is derived from normalized `git remote get-url origin` (or fallback canonical absolute repository root). Scaffolding generates `projects/<projectId>/project.json` containing remote metadata, display name, and last-seen working tree root without writing any files to the consumer product repository.

Greenfield feature. Design Intent skipped: initial foundational slice for vault layout and identity.

## Acceptance Criteria

- AC1: When no environment override is present, the vault root defaults to `~/.spec-memo` and initializes `config.json` and `projects/` directory if missing.
- AC2: When `$SPEC_MEMO_ROOT` environment variable is defined, all vault read/write operations use the overridden directory path.
- AC3: Resolving project identity for a repository with a git remote normalizes URLs (stripping credentials, protocol variants, trailing `.git`, and lowercase host/org/repo), producing identical `projectId` across distinct local clones.
- AC4: Resolving project identity for a git repository without remotes assigns a deterministic fallback `projectId` derived from the canonical absolute path.
- AC5: Project vault initialization scaffolds standard subdirectories (`traps/`, `decisions/`, `specs/`, `plans/`, `logs/`, `reviews/`, `scratch/`) and writes `project.json` recording `gitRemote`, `displayName`, and `lastSeenRoot`.
- AC6: Project binding and vault operations never create or commit configuration files inside the consumer product repository tree.

## Original Issue Context

Plan Slice 2: Vault and identity. Deliver: Create `$SPEC_MEMO_ROOT` (default `~/.spec-memo`, override in env and tests via temp dir). `projectId` from normalized remote; fallback path id. `project.json` last-seen root. Proof: Two temp git repos with the same `origin` URL share one `projectId`. A repo with no remotes gets a path-based id. Tests never write to the developer's real `~/.spec-memo`.

## Notes

- Uses SHA-256 / hex encoding or URL-safe slug for `projectId` filesystem safety.
- `project.json` tracks last seen product root for subsequent `refuse-product-write` checks.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-tenant cloud backend | Local filesystem vault only in Phase 1 |
| Automatic git sync of vault | Opt-in vault git remote is Phase 3 |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Remote priority | `origin` remote first, fallback to first available remote | Standard Git convention for project identification | y |
| Fallback collision | Path-based hash used if no remotes configured | Allows local-only repos without network remotes to function | y |
| Implicit dimensions | N/A because vault filesystem operations are local and synchronous | Standard Node.js fs guarantees | y |
