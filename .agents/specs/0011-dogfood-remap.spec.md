---
id: null
slug: dogfood-remap
title: "Phase 0 dogfood consumer remap verification"
source: local
specDate: 2026-08-25
---

# Specification — Phase 0 dogfood consumer remap verification

## Description

Verify the feasibility of isolating workflow plans and specs outside the product repository tree using consumer configuration redirection without modifying `spec-memo` source code. In a consumer test repository (e.g. `workflow-skills`), configure `plans.dir` and `plans.specsDir` to point to a test directory under `~/.spec-memo-test/<project>/`.

Greenfield feature. Design Intent skipped: experimental configuration proof for zero-code tree isolation.

## Acceptance Criteria

- AC1: On a consumer throwaway repository clone, configuring `plans.dir` and `plans.specsDir` to `~/.spec-memo-test/<project>` directs new plan folders outside the product git working tree.
- AC2: Executing workflow runs creates and updates artifacts inside `~/.spec-memo-test/<project>` successfully.
- AC3: Running `git status` in the consumer product repository clone remains clean, with zero unstaged plan or spec dump files.
- AC4: No consumer-specific path configurations or test remaps are committed to the `spec-memo` product repository.

## Original Issue Context

Plan Phase 0: Optional consumer remap. Goal: Prove "plans outside the product tree" with zero spec-memo code. Action: On a throwaway clone of a consumer, set `plans.dir` and `plans.specsDir` to absolute paths under `~/.spec-memo-test/<project>/`. Proof: `git status` in the product clone does not list plan/spec dumps; one live workflow can still read/write the remapped dirs.

## Verification Status

- Verified: Experimental throwaway consumer remap demonstrated plan directory isolation outside product git working tree (`~/.spec-memo-test/<project>`).
- Proved that zero spec-memo code changes are needed for directory redirection, while highlighting the need for Phase 1/2 MCP runtime to relocate `{sharedDir}` and `MEMORY.md`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Moving `MEMORY.md` or `{sharedDir}` | Requires Phase 1/2 MCP runtime |
| Changes to `spec-memo` runtime code | Phase 0 is purely consumer configuration validation |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Verification environment | Isolated throwaway clone | Prevents dirtying active working clones | y |
| Implicit dimensions | N/A because manual configuration test involves no code deliverables in this repo | Proof documented in task report | y |
