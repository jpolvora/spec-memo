---
id: null
slug: viewer
title: "Human viewer compatibility and Obsidian vault layout support"
source: local
specDate: 2026-08-25
---

# Specification — Human viewer compatibility and Obsidian vault layout support

## Description

Ensure the `$SPEC_MEMO_ROOT` vault directory layout and Markdown schemas maintain seamless read-only compatibility with human Markdown viewers, such as Obsidian, VS Code Markdown extensions, or local canvas tools, without introducing Obsidian or GUI frameworks as a runtime dependency.

Greenfield feature. Design Intent skipped: Phase 4 human viewer compatibility.

## Acceptance Criteria

- AC1: Markdown record filenames and frontmatter formatting conform to standard Markdown specifications supported by standard Markdown viewers.
- AC2: Compiled `INDEX.md`, `TRAPS.md`, and `DECISIONS.md` contain standard relative wikilinks or Markdown links that resolve correctly in Obsidian and VS Code.
- AC3: The vault directory can be opened directly as an Obsidian vault or VS Code workspace without generating errors.
- AC4: No viewer-specific plugins, runtime binaries, or proprietary dependencies are required by the `spec-memo` core engine.

## Original Issue Context

PRD Phase 4: Optional IDE plugin or Obsidian vault as viewer only (`viewer.spec.md`). Compatible layout for human inspection.

## Notes

- Viewer compatibility is purely passive via standards-compliant Markdown and directory structuring.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Custom Electron application | Markdown viewers already exist; vault layout compatibility is sufficient |
| Modifying vault records directly via viewer UI | Agent contract remains MCP/CLI |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Link format | Standard relative markdown links (`[Title](traps/trap-123.md)`) | Broadest compatibility across editors | y |
| Implicit dimensions | N/A because viewer integration is file-format compatibility | Passive compliance | y |
