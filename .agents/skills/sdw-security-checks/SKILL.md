---
name: sdw-security-checks
description: Configurable pre-commit secrets, credentials, and PII leak gate scanner
version: 0.1.0
invocation_names:
  - sdw-security-checks
  - sdw-security-checks scan
---

# SDW Security Checks Skill

> When this skill is loaded, output "sdw-security-checks loaded."

Deterministic pre-commit secrets, credentials, and PII scanner for Spec-Driven Workflow. Zero external runtime dependencies; uses Node.js 22 standard library regex scanning over git inventories.

> **Rules:** apply [`sdw-rules`](../sdw-rules/SKILL.md) before scanning, committing, or bypassing a gate.

## Workflow & Gate Protocol

### Step 1: Configuration & Scope Resolution
Inspect project configuration (`.sdw/config.json`) for `securityChecksEnabled` (`boolean`, default `false`).
- If `false`, security gate is bypassed during automated workflow execution.
- If `true`, scanner enforces pre-commit inspection prior to delivery commits (Step 6) and review-fix commits (Step 7).
- Manual audits can be executed at any time regardless of the configuration setting.

Done when: Execution mode (`worktree` or `--staged`), root path, and gate configuration are identified.

### Step 2: Scanner Execution
Run deterministic scanner helper via CLI launcher:
```bash
# Scan working tree (ignore-aware, excludes node_modules/.git)
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan

# Scan staged changes only (added lines of git diff --cached)
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan --staged

# Output machine-readable JSON report
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan --staged --json
```

Done when: Scanner script completes with an empirical exit code:
- `0`: Clean or warnings only (commit permitted).
- `1`: Blocking findings detected (commit blocked).
- `2`: Scanner execution failure / fail-closed (commit blocked).

### Step 3: Confidence Model & Triage
Classify detected findings:
- **HIGH Severity (Blocks Commit):** Private keys, AWS access keys, GitHub tokens, Slack tokens, API keys (`sk-...`), database connection strings with passwords, and unencrypted sensitive files (`.env`, `credentials.json`, `id_rsa`).
- **MEDIUM Severity (Advisory Warning):** Bearer tokens, `.pem`/`.key` certificate files. Logged as warnings; does not block commit unless `--fail-on medium` is specified.
- **Gitignore Advisories:** Tracked or untracked repository missing recommended patterns (`.env`, `*.pem`, `credentials.json`).

Done when: Findings are summarized with file path, line number, pattern type, and severity without exposing raw secret values.

### Step 4: Remediation & False-Positive Suppression
- Remove hardcoded secrets and replace with environment variables or configuration references.
- For legitimate false-positives (e.g., test fixtures or example documentation keys), append the suppression pragma at the end of the line:
  ```text
  # pragma: allowlist secret
  ```
- In authorized emergency situations, operators can supply `--skip-security` to bypass the orchestrator gate; the bypass is recorded in run state.

Done when: Working tree / staged diff is clean of unsuppressed HIGH findings.
