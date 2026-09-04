---
id: null
slug: write-block-hook
title: "Consumer hook and skill rule blocking in-repo workflow writes"
source: local
specDate: 2026-08-25
---

# Specification — Consumer hook and skill rule blocking in-repo workflow writes

## Description

Implement pre-commit git hooks and agent instruction rules in consumer repositories that actively block attempts to create or commit workflow artifacts (such as `.agents/plans/**`, `.agents/specs/**`, or `**/MEMORY.md`) inside the product working tree once `spec-memo` binding is active.

Greenfield feature. Design Intent skipped: Phase 2 consumer guardrail specification.

## Acceptance Criteria

- AC1: Git pre-commit hook in consumer repository scans staged files and rejects commits containing files under blocked workflow paths (`.agents/plans/**`, `.agents/specs/**`, `**/MEMORY.md`).
- AC2: The hook outputs a helpful error message guiding the agent/developer to use `spec-memo` MCP/CLI tools instead.
- AC3: Legitimate product documentation files (e.g. `README.md`, `PRODUCT.PRD`, `docs/`) are allowed and never blocked.
- AC4: An optional bypass flag (e.g. `--no-verify` or `SKIP_MEMO_HOOK=1`) allows intentional overrides during manual maintenance.

## Original Issue Context

PRD Phase 2: Hook or skill rule blocking in-repo workflow writes. Prevent agents from polluting consumer product git history.

## Notes

- Pairs with `spec-memo` core `refuse-product-write` guard for defense-in-depth.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Server-side git push hook | Client-side pre-commit hook provides immediate developer feedback |
| Blocking files outside the predefined workflow patterns | Only workflow artifacts are restricted |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Hook installation | Automated via consumer setup script or husky/simple-git-hooks | Standard JavaScript/Git tooling ecosystem | y |
| Implicit dimensions | N/A because shell/git hook runs synchronously before commit creation | Standard Git hook contract | y |
