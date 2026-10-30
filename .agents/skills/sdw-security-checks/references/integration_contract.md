# SDW Security Checks Integration Contract

Technical contract between `sdw-security-checks` scanner and the `sdw-run` orchestrator lifecycle.

## CLI Invocation Signature

```bash
node skills/sdw-security-checks/scripts/sdw_security_checks.cjs scan [options]
```

### Supported Options

- `--staged`: Restrict detection to added content in git index (`git diff --cached`).
- `--json`: Emit machine-readable JSON structure on stdout.
- `--root <path>`: Project root directory (defaults to auto-detected git or `.sdw` root).
- `--fail-on <high|medium>`: Severity threshold triggering exit code 1 (default: `high`).

## Exit Codes

- `0` (Success): No findings exceeding threshold; only advisory warnings or clean. Commit permitted.
- `1` (Blocked): One or more findings match or exceed the failure threshold (e.g., HIGH severity finding). Commit must be aborted before `git add` or `git commit`.
- `2` (Scanner Execution Failure / Fail-Closed): Scanner failed to execute due to filesystem, git, or process error. Commit must be aborted to avoid false clean status.

## Orchestrator State Integration

When `securityChecksEnabled` is `true` in `.sdw/config.json`, the orchestrator records the gate execution within the run state:

```json
{
  "securityGate": {
    "bypassed": false,
    "exitCode": 0,
    "severityCounts": {
      "high": 0,
      "medium": 0,
      "advisory": 0
    },
    "findings": []
  }
}
```

When bypassed via `--skip-security`:

```json
{
  "securityGate": {
    "bypassed": true,
    "reason": "--skip-security"
  }
}
```
