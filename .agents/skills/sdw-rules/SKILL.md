---
name: sdw-rules
description: Non-negotiable product rules — plan before change, explicit authorization, simplicity, surgical scope, empirical verification, and product guarantees.
version: 0.2.0
invocation_names:
  - sdw-rules
  - sdw-rules doctor
  - sdw-rules audit-spec
  - sdw-rules log-trap
---
# sdw-rules

> When this skill is loaded, output "sdw-rules loaded."

## 🛑 NON-NEGOTIABLE PRODUCT RULES

These rules override convenience. Apply them in every mode, on every harness and model. Detailed protocols are mandatory reading when the situation matches:

- Free-form chat, ambiguity, analysis, or opinions → [`references/interaction_modes.md`](references/interaction_modes.md)
- Changing skills, skills packaging, or tooling → [`references/product_guarantees.md`](references/product_guarantees.md)

## Subcommands

- `doctor`: Audits installed skills for line budgets and `sdw-rules` cross-references.
- `audit-spec <specFile>`: Scans a specification for scope creep or speculative abstractions.
- `log-trap --slug <slug> --title <title> --avoid <avoid> --action <action>`: Records a verified trap via `sdw-memory` (vault first, local traps table as fallback).

## Core Directives

1. **Plan Before Unsolicited Change.** For analysis, opinion, exploration, or any ambiguous request: state assumptions, investigate read-only, then present a short plan with options, tradeoffs, and a recommendation, and wait for explicit confirmation. If multiple interpretations exist, present them instead of choosing silently. Never write files while investigating.
2. **Explicit Authorization & Modes.** Read-only investigation needs no permission. Execute clear, explicit, non-destructive instructions directly. Confirm destructive or irreversible actions unless explicitly ordered. Invoked skills/commands with clear contracts run unattended; stop if a step is destructive and the skill does not cover it.
3. **Think & Ask Before Acting.** Never assume or expand scope silently. When an architectural opportunity or unrequested enhancement appears, halt and present it via `ask_question` (or numbered options in chat), defaulting to the minimal requested scope.
4. **Simplicity First (YAGNI).** Write the minimum code that satisfies the acceptance criteria. No speculative abstractions, single-use helper modules, or unrequested configuration. If 200 lines could be 50, rewrite; ask whether a senior engineer would call it overcomplicated.
5. **Surgical Scope Enclosure.** Touch only what the task requires; match existing style. No adjacent refactors, reformatting, renames, or drive-by fixes. Remove only orphans your change created; mention unrelated dead code instead of deleting it.
6. **Empirical Goal-Driven Verification.** Turn every requirement into a verifiable check, test, or empirical pass/fail signal. State a short plan with a verification step per action and loop until the check passes before declaring completion.
7. **Product Guarantees.** Preserve zero runtime npm dependencies, Node.js 22 standard library, deterministic CLI anchors, harness/agent agnosticism, portable paths, and file-based contracts.

## 🧠 MEMORY-FIRST — MANDATORY FOR EVERY SKILL

Before implementing, fixing, reviewing, or orchestrating: query `sdw-memory`
for related traps/gaps/patterns/errors and apply returned hints.
After any verified fix or newly discovered trap/gap/pattern/error: record it
via `sdw-memory`. Never bypass with direct `traps.md` edits or raw `memo`
calls; `sdw-memory` is the single wrapper over all store backends.
Default backend is the `ws-memo` vault; select per user via
`memory.backends` in `.sdw/config.json`.

## Mode Cheat Sheet

- Read-only question → answer; no confirmation.
- Explicit, clear, non-destructive order → execute.
- Destructive or irreversible → confirm unless explicitly ordered.
- Analysis, opinion, or ambiguous → investigate → plan → confirm.
- Invoked skill/command → follow its contract unattended; stop only on uncovered destructive steps or decision gaps.

## Steps

1. **Audit Rules Compliance**
   Validate skill line budgets (≤ 120 lines; `sdw-rules` ≤ 80) and downstream references.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs doctor [--json]`
   - Done when: All skills pass with exit code `0`.

2. **Audit Specification for Scope Creep**
   Scan a specification for speculative features or unrequested scope expansion.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs audit-spec <specPath> [--json]`
   - Done when: The audit report confirms minimal scope enclosure.

3. **Log Anti-Regression Trap**
   Record friction or an overengineering defect via the central memory wrapper.
   - Run: `node skills/sdw-rules/scripts/sdw_rules.cjs log-trap --slug <slug> --title <title> --avoid <avoid> --action <action>`
   - Done when: The trap entry is stored through `sdw-memory` (vault first, local traps table as fallback).

## References

- Interaction modes & planning protocol: [`references/interaction_modes.md`](references/interaction_modes.md)
- Product guarantees & verification: [`references/product_guarantees.md`](references/product_guarantees.md)
- Shared memory authority (traps/gaps/patterns/errors): [`sdw-memory`](../sdw-memory/SKILL.md)
- LLM anti-patterns & traps catalog: [`references/anti_patterns.md`](references/anti_patterns.md)
- Trap log template: [`references/traps_log.md`](references/traps_log.md)
