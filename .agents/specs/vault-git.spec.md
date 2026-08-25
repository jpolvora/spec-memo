---
id: null
slug: vault-git
title: "Optional private git remote sync for vault persistence"
source: local
specDate: 2026-08-25
---

# Specification — Optional private git remote sync for vault persistence

## Description

Provide an opt-in configuration option in `config.json` enabling the local filesystem vault (`$SPEC_MEMO_ROOT`) to act as a private Git repository with an optional remote origin. Allows synchronizing curated memory records across multiple developer workstations without introducing complex multi-tenant server infrastructure.

Greenfield feature. Design Intent skipped: Phase 3 curator hardening.

## Acceptance Criteria

- AC1: When `vaultGit.enabled: true` is configured in `config.json`, `spec-memo` initializes a git repository inside `$SPEC_MEMO_ROOT` if not already initialized.
- AC2: Record upserts, deletes, and GC compacting operations create structured git commits with meaningful commit messages.
- AC3: The CLI command `memo sync` pushes local vault commits to the configured private remote and pulls updates.
- AC4: Vault git sync is completely disabled by default and requires explicit configuration.

## Original Issue Context

PRD Phase 3: Optional private git remote on the vault (`vault-git`). Enable optional private git sync for vault persistence.

## Notes

- Git repository in the vault is isolated from consumer product repositories.
- `memo.sqlite` is gitignored inside the vault root.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-tenant SaaS server hosting | Private git remote provides simple, decentralized sync |
| Real-time operational transform (OT) | Asynchronous git push/pull is sufficient |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Commit strategy | Micro-commit per record upsert/gc run | Fine-grained rollback and auditability | y |
| Conflict resolution | Standard git rebase/merge; compiled markdown files are auto-regenerated | RebuildIndex regenerates disposable FTS and views | y |
| Implicit dimensions | N/A because git operations execute locally via standard child process | Standard Git CLI contract | y |
