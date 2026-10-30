---
id: null
slug: status-details-drawer-errors-aiops
title: "Status Monitor: Right-aligned detail drawers for Error Logs and AI Ops"
source: local
specDate: 2026-09-14
---

# Specification — Status Monitor: Right-aligned detail drawers for Error Logs and AI Ops

## Description

The spec-memo Status Monitor companion (`http://127.0.0.1:3124/`) provides diagnostic and operational views including Memory Records, Prompts, Backups, Error Logs, and AI Ops. In the Memory Records view (`tab-records`), clicking any table row opens a right-aligned sliding drawer (`#memory-drawer`) with a dark backdrop overlay (`#memory-drawer-overlay`), displaying structured metadata in a two-column card and detailed record contents.

Currently, the Error Logs view (`tab-error-logs`, spec `0058`) and AI Ops view (`tab-ai-ops`, spec `0057`) render row details into inline cards (`#errorlog-detail` and `#aiops-detail`) placed below their respective data tables. This inline layout forces operators to scroll down below paginated tables to view error messages or operation inputs/outputs, deviating from the sliding drawer standard used elsewhere in the monitor.

This specification unifies the row-click detail experience across Error Logs and AI Ops by replacing the bottom inline cards with standard right-aligned sliding drawers following the visual pattern of the Memory Records drawer.

When an operator clicks a row in the Error Logs table, an Error Details drawer slides in from the right over an overlay, showing structured error metadata (timestamp, level, subsystem, endpoint/tool, project), the error message, and the full stack trace or context. Similarly, clicking a row in the AI Ops table opens an AI Operation Details drawer presenting execution metadata (operation, result, duration, timestamp, record, model/provider, project) alongside formatted JSON blocks for input, output, and metadata.

Both drawers adopt existing `.drawer` and `.drawer-overlay` CSS rules, support closing via dedicated header buttons, overlay clicks, and Escape key presses, and retain existing DOM element IDs to guarantee backward compatibility with automated test suites.

## Acceptance Criteria

### Error Logs Drawer UI

- AC1: Clicking any data row in the Error logs table (excluding the row selection checkbox) opens a right-aligned sliding drawer with container `id="errorlog-drawer"`.
- AC2: Opening the Error logs drawer displays a backdrop overlay with element `id="errorlog-drawer-overlay"`.
- AC3: The Error logs drawer header includes title element `id="errorlog-drawer-title"` and close button `id="errorlog-drawer-close"`.
- AC4: The Error logs drawer body displays a two-column metadata card containing timestamp, level, subsystem, endpoint, and project fields.
- AC5: The error message is rendered as wrapped text inside preformatted container `id="errorlog-detail-error"`.
- AC6: The stack trace or context object is rendered inside preformatted container `id="errorlog-detail-stack"`.
- AC7: Legacy close button `id="btn-errorlog-detail-close"` is retained and dismisses the drawer when clicked.
- AC8: Clicking the backdrop overlay `errorlog-drawer-overlay` closes the Error logs drawer.
- AC9: Clicking a row selection checkbox updates selection state without opening the Error logs drawer.

### AI Ops Drawer UI

- AC10: Clicking any data row in the AI Ops table opens a right-aligned sliding drawer with container `id="aiops-drawer"`.
- AC11: Opening the AI Ops drawer displays a backdrop overlay with element `id="aiops-drawer-overlay"`.
- AC12: The AI Ops drawer header includes title element `id="aiops-drawer-title"` and close button `id="aiops-drawer-close"`.
- AC13: The AI Ops drawer body displays a two-column metadata card containing operation, result, duration, timestamp, record, model, and project fields.
- AC14: The operation input payload is displayed as formatted JSON within element `id="aiops-detail-input"`.
- AC15: The operation output payload is displayed as formatted JSON within element `id="aiops-detail-output"`.
- AC16: The operation metadata payload is displayed as formatted JSON within element `id="aiops-detail-meta"`.
- AC17: Legacy close button `id="btn-aiops-detail-close"` is retained and dismisses the drawer when clicked.
- AC18: Clicking the backdrop overlay `aiops-drawer-overlay` closes the AI Ops drawer.

### Drawer Interaction and Keyboard Navigation

- AC19: Pressing the Escape key while an Error logs or AI Ops drawer is open dismisses the active drawer.
- AC20: Navigating to another navigation tab automatically closes any open Error logs or AI Ops drawer.
- AC21: Reloading or refreshing table contents closes any currently open drawer in that tab.

### Compatibility and Regression Guards

- AC22: DOM container `id="errorlog-detail"` is preserved inside the Error logs drawer body.
- AC23: DOM container `id="aiops-detail"` is preserved inside the AI Ops drawer body.
- AC24: Error and journal payloads continue to be rendered via `textContent` assignment without `innerHTML` interpolation of untrusted data.
- AC25: Total MCP tools in `TOOL_NAMES` remains exactly 11 with zero added tools.
- AC26: Existing test suites in `src/status.test.ts` and `src/ai-ops.test.ts` continue to pass without modification.

## Original Issue Context

User prompt:

> /ws-spec-write add click row error details in right panel for error logs viewing. Add also AiOps row click details open in right panel .follow the third screenshot which is memory records view row click detail opening right panel "IDE Rule promote must fail closed..." as example implementation of standard panel right aligned to show row details in referenced views (errors, ai ops)

### Prior Work Sweep

- `0023-mcp-status-monitor.spec.md`: introduced initial status companion UI on port `:3124`.
- `0029-prompt-history-and-query.spec.md`: established slide-out side details drawer pattern (`prompt-drawer` with `.drawer` and `.drawer-overlay`).
- `0032-status-backup-page.spec.md`: implemented `backup-drawer` using the identical slide-out panel pattern.
- `0034-memory-hit-count.spec.md` & `0039-memory-feedback-salience.spec.md`: implemented `memory-drawer` with metadata grid and body container (visual reference in Screenshot 3).
- `0057-status-ai-ops-logs.spec.md`: introduced `tab-ai-ops` with inline card `#aiops-detail`.
- `0058-status-monitor-nav-ai-config.spec.md` & `0061-status-error-logs-actions.spec.md`: introduced `tab-error-logs` with inline card `#errorlog-detail`, row selection checkboxes, and action modals.
- Prior commits: `9739c98` (error logs actions), `bbc4985` (AI Ops journal wiring), `7df07b8` (AI Ops test probe). No open PR exists for right-panel error or AI ops drawers.

### Design Intent

The initial implementations of Error Logs (`0058`) and AI Ops (`0057`) used bottom-docked inline cards (`style.display = "grid"`) under the table as an MVP solution. However, this inline pattern created UX inconsistency with Memory Records (`#memory-drawer`), Prompts (`#prompt-drawer`), and Backups (`#backup-drawer`), which all use a 580px right-aligned sliding drawer over a backdrop overlay.

This change is an intentional UI modernization and consistency enhancement. It upgrades the presentation layer while preserving all existing data fetching APIs, payload sanitization, and element IDs so that automated test assertions remain 100% valid.

## Visual References

The implementation follows three user-provided reference screenshots:

1. **Screenshot 1 (`?tab=error-logs`):** Displays the Error Logs table with columns `[checkbox]`, `Time`, `Level`, `Subsystem`, `Error`, and action buttons `Refresh`, `Delete`, `New Issue`. Clicking a row currently shows details inline at the bottom rather than in a side drawer.
2. **Screenshot 2 (`?tab=ai-ops`):** Displays the AI Ops table with columns `Time`, `Operation`, `Ok`, `Duration`, `Record`, `Error`, and controls `Test AI`, `Refresh`. Clicking a row currently opens details inline beneath the table.
3. **Screenshot 3 (`?tab=records`):** Target reference implementation. Clicking a row opens a standard right-aligned sliding panel (`#memory-drawer`, width 580px) displaying a header with title and close button, a two-column `.metadata-card` grid, action buttons, and a structured section with formatted record body.

## Notes

- Relevant files: `src/status.ts`, `src/status.test.ts`, `src/ai-ops.test.ts`.
- CSS classes reused: `.drawer`, `.drawer-overlay`, `.drawer.open`, `.drawer-overlay.open`, `.drawer-header`, `.drawer-close`, `.drawer-body`, `.metadata-card`, `.meta-item`, `.meta-label`, `.meta-val`.
- Z-index hierarchy: overlays at `z-index: 500`, drawers at `z-index: 600`.
- Safe DOM handling: never assign raw unescaped strings to `innerHTML`; assign strings to `.textContent` for error messages, stack traces, and JSON payloads.
- Preserves backward compatibility: retain `#errorlog-detail` and `#aiops-detail` as the metadata cards or inner wrappers inside `#errorlog-drawer` and `#aiops-drawer`.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Modifying table columns or filtering logic | Scope is restricted to row-click detail presentation |
| Adding new MCP tools | Freeze at 11 core tools remains in effect |
| Altering REST endpoints (`/api/error-logs/*`, `/api/ai-ops/*`) | Backend APIs already deliver necessary fields |
| Inline log editing or payload mutation | Both views remain strictly read-only inspectors |
| Changing other tabs (Activity, Wiki, Prompts) | Already use appropriate drawers or inline flows |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Drawer width and animations | 580px width, max 90vw, 0.25s ease-out slide | Matches existing `#memory-drawer` and `#prompt-drawer` styles | y |
| Checkbox click behavior | Row checkbox clicks call `stopPropagation()` | Prevents opening the drawer when merely selecting rows for batch actions | y |
| Keyboard accessibility | Escape key listener dismisses open drawer | Standard UX expectation for drawer dialogs | y |
| Internationalization and locale packs | N/A because status monitor is en-us only | Aligns with project operating rules | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural alignment | Reuse existing `.drawer` styling and event conventions | Inspect `src/status.ts` CSS and drawer implementations |
| Scope boundaries | Limited to Error Logs and AI Ops detail presentation | Verify diff is constrained to `src/status.ts` and UI test files |
| Security invariants | Zero `innerHTML` usage on error text or stack traces | Automated regex assertion in `src/status.test.ts` |
| Zero regression | All existing tests for Error Logs and AI Ops pass | Run `npm test` |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Presence of `#errorlog-drawer` and `#errorlog-drawer-overlay` in rendered status HTML.
- Presence of `#aiops-drawer` and `#aiops-drawer-overlay` in rendered status HTML.
- Drawer open state signified by presence of `.open` CSS class on drawer and overlay elements.
- Verification that `TOOL_NAMES.length === 11`.

### Negative & Failing Test Scenarios

- Clicking a row checkbox in Error Logs must not add `.open` class to `#errorlog-drawer`.
- Attempting to display untrusted log text via `innerHTML` must fail security validation checks.
- Pressing Escape when a drawer is open must remove `.open` class from both drawer and overlay.
- Clicking the backdrop overlay must dismiss the drawer and remove `.open` class.
