---
id: null
slug: capture-ignore-marker
title: "Project-Local Capture Exclusions Marker and Safety Boundary"
source: local
specDate: 2026-09-04
---

# Specification — Project-Local Capture Exclusions Marker and Safety Boundary

## Description

Implement a project-local exclusions marker (`.spec-memo-ignore` or configured `ignorePaths`) to establish a strict, lexical safety boundary preventing sensitive files, vendor directories, large binary dumps, or private credentials from being indexed into memory, recorded into prompt turns, or matched against trap `pathPatterns`. Provide an interactive diagnostic command (`memo doctor --check-capture <path>`) so developers can verify exclusion rules before running agent workflows.

### Problem Analysis & Real-World Evidence

1. **Unbounded Path Matching:**
   - In `src/safety.ts`, `spec-memo` actively checks for high-entropy secrets (PEM private keys, AWS tokens, API keys) and enforces root-tree write boundaries.
   - However, repositories frequently contain non-secret yet sensitive or irrelevant code trees (e.g. proprietary vendor SDKs, local `.env.*` configuration files, machine-generated test fixtures, database dumps).
2. **Accidental Memory Pollution:**
   - If an agent logs an event with `memo prompt record` referencing paths under ignored directories, or if an author sets a broad `pathPatterns: ["**/*.ts"]` on a trap, the trap matches on third-party vendor code or test fixtures, inflating hit counts and cluttering session briefs.
3. **No Project-Local Rule Configuration:**
   - There is currently no file-based mechanism inside a consumer repository to declare *"do not index or match records against these paths"*.

### Design Intent

Support an optional `.spec-memo-ignore` marker file located at the consumer repository root, adhering to standard `.gitignore` glob syntax. Augment `src/safety.ts` with `isPathIgnored()` to sanitize incoming `pathPatterns`, drop prompt excerpts from ignored paths, and provide a diagnostic check via `memo doctor`. Crucially, `.spec-memo-ignore` is strictly read-only for `spec-memo`—it is never written or mutated by the daemon.

---

## Acceptance Criteria

### Ignore Marker Discovery & Parsing

- AC1: `spec-memo` detects and parses an optional `.spec-memo-ignore` file located at the bound product repository root using standard `.gitignore` glob syntax (comments `#`, wildcards `*`, directory recursions `**`, negations `!`).
- AC2: `spec-memo` includes built-in baseline ignore patterns (`DEFAULT_IGNORE_PATTERNS` covering `.git/`, `node_modules/`, `dist/`, `build/`, `.venv/`, `.env`, `.env.*`, keys, certs, and binaries) that remain active by default even without a `.spec-memo-ignore` file.
- AC3: Vault project configuration in `~/.spec-memo/config.json` supports an optional `projects.<id>.ignorePaths: string[]` array that is merged with `.spec-memo-ignore` and built-in rules.
- AC4: The parsed ignore rules are cached per project session and refreshed whenever file modification time (`mtime`) on `.spec-memo-ignore` changes.

### Safety Boundary Enforcement

- AC5: `src/safety.ts` exports `isPathIgnored(filePath: string, productRoot: string): boolean` that evaluates a relative or absolute file path against active ignore rules (respecting `!` un-ignore negation rules).
- AC6: When `upsert` processes a record with `pathPatterns`, any pattern that matches an ignored directory or file is automatically stripped; if all patterns are ignored, `upsert` rejects the operation with a safety validation error.
- AC7: When `prompt` `action: 'record'` receives turn bodies, citations, or tool excerpts, references to files matching ignored patterns are redacted with `[PATH_IGNORED]`.
- AC8: In `src/bootstrap.ts`, focus path matching (`path: string`) ignores evaluation if the target path matches an active ignore rule, falling back to clean project-wide brief compilation.
- AC9: In `src/indexer.ts`, targeted searches with `--path <path>` evaluate the path against ignore rules, suppressing irrelevant matches if the target path is strictly ignored.

### Read-Only Git Boundary Guarantee

- AC10: Under no circumstances does `spec-memo` create, edit, or delete `.spec-memo-ignore` within the consumer product repository; the file is strictly authored and controlled by repository owners.
- AC11: If `.spec-memo-ignore` does not exist in the consumer repository root, `spec-memo` continues normal operation using built-in baseline rules without warnings or default-creation side effects.

### Diagnostics & Capture Verification

- AC12: The CLI command `memo doctor --check-capture <relativeOrAbsolutePath>` evaluates the specified path against active ignore rules and prints whether the path is `CAPTURED` or `IGNORED`, displaying the matching pattern, line, and source layer (`builtin`, `.spec-memo-ignore`, or `config.json`).
- AC13: `memo doctor` reports the number of active ignore rules loaded and lists any invalid glob syntax warnings under an "Exclusion Boundary" diagnostic card.
- AC14: Malformed or unparseable lines in `.spec-memo-ignore` emit a warning to stderr but do not cause daemon crash or prevent valid rules from operating.

---

## Notes

- **Zero In-Repo Pollution:** Strictly adheres to the core product thesis (Product git is not a memory store); `.spec-memo-ignore` is an optional consumer-owned configuration file, never written by `spec-memo`.
- **Zero New MCP Tools:** Enhances `src/safety.ts` and `memo doctor`, staying completely within the 11-tool ceiling.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic scanning of git history for past ignored commits | Exclusions apply strictly to active working tree captures and runtime queries. |
| In-memory content full-text DLP regex filtering | Deep content DLP is covered by existing secret redaction (`src/safety.ts`); this feature is a lexical path boundary. |
| Automatic generation of ignore files for users | Authors maintain full ownership of their repository files. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Glob parsing engine | Standard minimatch / picomatch syntax | Matches familiar `.gitignore` patterns used by developers. | y |
| Relative vs absolute path resolution | Resolved relative to repository root | Ensures consistent behavior regardless of shell working directory. | y |
| Precedence between config.json and .spec-memo-ignore | Union of both sets | Allows both team-wide repository rules and workstation-specific overrides. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Architectural Alignment | Integrates into `src/safety.ts`, `src/doctor.ts`, `src/bootstrap.ts`, `src/store.ts` | Codebase inspection and schema verification |
| Tool Ceiling Compliance | Zero new MCP tools created; extends `safety` and `doctor` | Tool schema audit |
| Git Boundary Guarantee | Strictly read-only for repository files | Filesystem immutability assertion test |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo doctor --check-capture src/secrets/key.env`: prints `IGNORED (matched line 2: *.env)`.
- `memo doctor --check-capture src/app.ts`: prints `CAPTURED (no ignore rule matched)`.
- `memo doctor`: diagnostic card displays "Exclusion Boundary: Active (3 rules loaded)".

### Negative & Failing Test Scenarios

- Attempting to upsert a trap whose `pathPatterns` exclusively target ignored paths throws `Safety violation: all pathPatterns match ignored paths`.
- Corrupt `.spec-memo-ignore` with unclosed brackets does not crash `doctor` or `upsert`; continues with valid lines.
- Paths outside the repository root are ignored by default under the existing root-tree write boundary.
