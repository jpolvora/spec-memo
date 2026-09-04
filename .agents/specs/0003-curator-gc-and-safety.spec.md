---
id: null
slug: curator-gc-and-safety
title: "Curator GC, secret redaction, and product-tree write guard"
source: local
specDate: 2026-08-23
---

# Specification — Curator GC, secret redaction, and product-tree write guard

## Description

Implement vault maintenance and guardrails:
1. `gc` tool to purge expired `scratch` records (TTL 7 days) and `review` artifacts (TTL 14 days), and compact shipped plans into concise result summaries.
2. Secret redaction engine that blocks or redacts private keys (PEM blocks), AWS tokens, and sensitive credentials from record payloads.
3. Product-tree write guard that denies writing workflow artifacts into a known consumer product repository.

Greenfield feature. Design Intent skipped: initial implementation of curator lifecycle and safety policies.

## Acceptance Criteria

- AC1: The `gc` MCP tool and `memo gc` CLI command purge `scratch` records older than their TTL (default 7 days) and stale review records.
- AC2: Shipped plans with status `shipped` are compacted into a single summary result artifact, freeing verbose step-by-step scratch.
- AC3: Attempting to `upsert` or `append` records containing high-entropy credentials, private keys (PEM header `-----BEGIN ... PRIVATE KEY-----`), or known token signatures fails validation or redacts values.
- AC4: If a record write targets a directory within the detected consumer repository (`productRoot`), the store operation fails with an explicit safety error.
- AC5: Running `gc` updates the SQLite FTS index and compiled markdown views (`INDEX.md`).

## Original Issue Context

Plan Slice 7: `gc` + redaction + refuse product write. Deliver: TTL for scratch/review; compact shipped plans; reject secret-like bodies; refuse creating record files under `productRoot`. Proof: Expired scratch gone after `gc`. `upsert` with a PEM block fails. Given a temp git repo as `productRoot`, handlers do not create files inside it.

## Notes

- Redaction rules match standard regex patterns for private keys, GitHub tokens (`ghp_`), and generic bearer secrets.
- Product root detection uses `resolveProjectIdentity(cwd)`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Enterprise DLP scanning | Basic secret/key detection is sufficient for local agent safety |
| Automatic background cron daemon | GC is triggered via MCP/CLI commands or during session boundaries |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Scratch default TTL | 7 days (604,800 seconds) | Balances short-term context retention with long-term zero-pollution | y |
| Compacted plan format | Replaced by single result markdown with date, outcome, and commit SHA | Minimizes storage while preserving durable history | y |
| Implicit dimensions | N/A because local safety checks are synchronous and self-contained | No external API dependencies | y |
