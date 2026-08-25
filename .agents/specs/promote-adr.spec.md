---
id: null
slug: promote-adr
title: "Promote-to-ADR Formatting and Directory Resolution"
source: local
specDate: 2026-08-25
---

# Specification — Promote-to-ADR Formatting and Directory Resolution

## Description

Enhance the record promotion engine (`promoteRecord` and `memo promote`) with structured Architecture Decision Record (ADR) formatting templates and intelligent directory destination resolution. When promoting architectural decisions (`kind=decision`) from the vault into the product repository, developers and agents can format records according to standard Nygard ADR or MADR (Markdown Architectural Decision Records) conventions, complete with Context, Decision Outcome, Drivers, and Consequences sections.

Greenfield feature. Design Intent skipped: PRD inbox capability.

## Acceptance Criteria

- AC1: `promoteRecord` and `memo promote` accept an optional `format` parameter (`raw`, `adr`, or `madr`).
- AC2: When `format: 'adr'` is specified or when promoting decisions by default, content is rendered with standard ADR structure: Title, Status, Date, Authors, Context & Problem Statement, Decision Outcome, and Consequences.
- AC3: When `format: 'madr'` is specified, content is rendered in Markdown Architectural Decision Records (MADR) format with Technical Story, Decision Drivers, and Considered Options.
- AC4: When destination specifies a directory path (e.g. `docs/adr/`), `promoteRecord` automatically resolves the target filename to `0001-<slug>.md`.
- AC5: All default-deny safety constraints (destination within product tree, refusal of `.git/` targets, force-flag requirement for overwrites) remain strictly enforced.

## Original Issue Context

`PRODUCT.PRD` § 10: Inbox: Promote-to-ADR templates per product language / format.

## Notes

- Promoted files in the product repository stay pure documentation without internal vault metadata.
- Non-decision records promoted with `format: 'raw'` retain YAML frontmatter and verbatim Markdown body.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-language ADR translation | English Markdown ADRs standard for repository docs |
| Automatic git commit on promotion | Promotion writes file; user/agent commits as part of normal PR flow |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Default ADR numbering | `0001-<slug>.md` prefix when promoting into directory | Standard industry practice for ADR catalogs | y |
| Default format for decisions | Standard `adr` format | Produces clean, readable decision logs in product repos | y |
