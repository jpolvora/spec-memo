---
id: null
slug: vault-backup
title: "Encrypted Vault Backup, Export, and Restoration Engine"
source: local
specDate: 2026-08-25
---

# Specification — Encrypted Vault Backup, Export, and Restoration Engine

## Description

Provide standalone vault backup, export, and restoration commands (`exportVault` / `importVault` and `memo export-vault` / `memo import-vault`) with optional AES-256-GCM encryption. Enables developers and operators to package local memory vaults into portable archives for off-site backups, air-gapped machine migrations, and secure cross-workstation transfers without relying on external cloud providers.

Greenfield feature. Design Intent skipped: PRD inbox capability.

## Acceptance Criteria

- AC1: `exportVault` bundles project records, metadata (`project.json`), and configuration into a structured JSON manifest archive.
- AC2: When a `password` is provided, `exportVault` encrypts the payload using AES-256-GCM with key derivation via PBKDF2 (100,000 iterations of SHA-256 with random 16-byte salt and 12-byte IV).
- AC3: `importVault` restores archive files into the target `$SPEC_MEMO_ROOT` directory, re-creating project folders, record files, and metadata.
- AC4: If the archive is encrypted, `importVault` requires the correct password; attempting decryption with an invalid password or tampered ciphertext fails with a descriptive error.
- AC5: `importVault` automatically triggers compiled view regeneration and rebuilds the disposable SQLite FTS5 index upon completion.
- AC6: CLI parity is provided via `memo export-vault [--password <pwd>] [--output <file>]` and `memo import-vault [--password <pwd>] <file>`.

## Original Issue Context

`PRODUCT.PRD` § 10: Inbox: Encrypted vault / git-crypt; multi-machine sync helpers.

## Notes

- Ciphertext format contains `format: "spec-memo-encrypted-vault-v1"` with standard salt, IV, and auth tag fields.
- Plaintext exports contain `format: "spec-memo-vault-v1"` with manifest and project record trees.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud object storage upload | Filesystem archives provide standard UNIX pipe/file flexibility |
| Real-time multi-peer sync protocol | Local file export/import handles air-gapped and backup use cases cleanly |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Encryption algorithm | AES-256-GCM with PBKDF2-SHA256 | Industry standard authenticated encryption | y |
| PBKDF2 iteration count | 100,000 iterations | High resistance against brute-force password guessing | y |
