# Anti-Regression Traps Log Template

This document provides the canonical schema template and initial seed content for the anti-regression trap log. Live project entries are appended to `{projectRoot}/.sdw/memory/traps.md`.

> Writes go through `sdw-memory` (`record --kind trap ...`); never append to the table by hand outside that contract.

---

## Log Schema

| Slug | Title | Layer | Avoid | Action | Date |
|---|---|---|---|---|---|
| no-unrequested-installers | Avoid inferring unrequested native installers | architecture | Adding native installer tooling without user prompt | Clarify via ask_question with minimal scope default | 2026-10-19 |
| single-use-abstractions | Prohibit speculative class factories | implementation | Creating complex registries or factories for single implementations | Use plain functions and CommonJS modules | 2026-10-19 |
| surgical-diff-hygiene | Avoid reformatting adjacent code | quality | Reformatting untouched functions or sorting unrelated imports | Confine diff strictly to lines required by task | 2026-10-19 |
