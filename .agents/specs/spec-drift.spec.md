---
id: null
slug: spec-drift
title: "Specification git SHA drift detection on bootstrap"
source: local
specDate: 2026-08-25
---

# Specification — Specification git SHA drift detection on bootstrap

## Description

Detect code-specification drift during `bootstrap` calls by comparing the recorded `verifiedAtSha` in active spec records (`linkedPaths`) against the current git commit SHA or file hash of those linked paths in the consumer working tree. When code has changed without updating the spec, flag a drift warning in the bootstrap brief.

Greenfield feature. Design Intent skipped: Phase 3 curator hardening.

## Acceptance Criteria

- AC1: When a spec record defines `linkedPaths` and `verifiedAtSha`, `bootstrap` inspects the current git status / object SHA of those files in the target repository.
- AC2: If any linked file has diverged since `verifiedAtSha`, `bootstrap` attaches a `drift: { specSlug, modifiedPaths }` alert to the returned session brief.
- AC3: If all linked files match `verifiedAtSha`, no drift alert is emitted.
- AC4: Drift detection fails gracefully with a warning if the working tree has uncommitted local edits or missing paths.

## Original Issue Context

PRD Phase 3: Spec SHA drift on bootstrap. Check linked path SHA != verifiedAtSha and flag drift.

## Notes

- Uses local `git log -n 1 --format=%H -- <path>` or git blob SHA comparison.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic rewriting of specs | Drift is a warning flag for the agent, not an automated author |
| Deep AST semantic diffing | Commit SHA and path hash comparison are sufficient |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Verification timing | Executed on demand during bootstrap brief assembly | Ensures freshly checked session state | y |
| Implicit dimensions | N/A because local git CLI execution is synchronous | Standard Git subprocess call | y |
