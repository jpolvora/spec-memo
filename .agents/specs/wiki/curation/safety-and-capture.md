# Safety Boundaries, Secret Redaction, and Capture Exclusions

## Feature Overview

This page covers the two policy layers that keep bad data out of the vault: secret redaction/refusal and the product-tree write guard from `0003-curator-gc-and-safety.spec.md`, plus the lexical capture-exclusion boundary from `0040-capture-ignore-marker.spec.md`.

- Secret redaction refuses writes whose body/frontmatter/details contain recognized credential signatures, and scrubs caller-facing read payloads.
- The write guard refuses creating memory record files inside the detected consumer product repository.
- Capture exclusions (`isPathIgnored`) keep ignored files out of `pathPatterns`/`linkedPaths`, prompt excerpts, bootstrap focus paths, and targeted searches. `memo doctor --check-capture <path>` explains the decision.

Journeys:
- An agent tries `upsert` with a PEM block or `ghp_…` token → the operation throws a safety error; nothing is persisted.
- An author adds a `.spec-memo-ignore` file and runs `memo doctor --check-capture src/secrets/key.env` to confirm it prints `IGNORED` with the matching pattern, line, and source layer.
- A prompt record cites a vendored binary path → the excerpt is stored with `[PATH_IGNORED]` instead of the literal path.

## Business Rules & Logic

**Secret signatures** (`SECRET_PATTERNS`, src/safety.ts). Named detectors, each a regex:
- Private Key (full PEM block) and Private Key Header (`-----BEGIN … PRIVATE KEY-----`).
- AWS Access Key ID (`AKIA`, `ASIA`, `A3T…`, `AGPA`, `AIDA`, `AROA`, `AIPA`, `ANPA`, `ANVA` + 16 uppercase alnum).
- GitHub Personal Access Token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36–255 chars).
- Slack token (`xox[baprs]-…`).
- Generic API key/secret assignment (`api_key|apikey|secret_key|private_key|auth_token|access_token|secret_token|client_secret` `:`/`=` quoted value ≥ 16 chars).
- Stripe/generic secret key (`sk_live`, `sk_test`, `rk_live`, `rk_test`).
- Bearer token header (`Bearer <25+ token chars>`).

**Write-time behavior is fail-closed refusal, not redaction.** `assertNoSecrets` throws `Safety violation: Secret detected in <context> (<names>). …` on `upsert` (`options.body` as `record body`, `options.frontmatter` as `record frontmatter`) and on `append` (`options.event` as `event log body`, `options.details` as `event log details`). Detection is recursive over strings, arrays, and object values (`scanPayloadForSecrets`), and match names are de-duplicated.

**Read-time redaction.** `redactSecretsInPayload` replaces each match in strings with `[REDACTED:<pattern name>]`. `sanitizeToolOutput` composes `stripVaultPaths(redactSecretsInPayload(redactPathsDeep(payload)))`: absolute filesystem paths become `[path]`, and vault path keys (`path`, `filepath`, `targetPath`, `purgedFiles`, `compactedPlans`, `vaultPath`, `vaultRoot`, `dbPath`, `absolutePath`, `backupPath`) are dropped. Allowlisted keys survive: `configFilePath`, `destination`, and a `path` value ending in `.spec-memo.json`.

**Product-tree write guard** (`assertNotInProductRoot`, src/safety.ts). Throws `Safety violation: Attempted to write memory record inside consumer product repository (…)` when the target resolves inside `productRoot`, unless (a) no productRoot is known, (b) productRoot equals/is inside the vault root (it is the vault, not a consumer repo), or (c) the target is inside the vault root. Applied by `upsertRecord`, `appendEvent`, and `forgetRecord`. Path comparison is case-insensitive with separators normalized.

**Capture-ignore sources and precedence.** Merged in this order: built-in `DEFAULT_IGNORE_PATTERNS`, then the project-root `.spec-memo-ignore`, then `config.json` `projects.<id>.ignorePaths`. All three are unioned; later negation (`!pattern`) resets the ignored flag.

**Built-in baseline** (active even with no marker file): `.git/`, `node_modules/`, `dist/`, `build/`, `.venv/`, `.env`, `.env.*`, `*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.bin`, `*.exe`, `*.dll`, `*.so`, `*.dylib`, `*.zip`, `*.tar`, `*.gz`, `*.7z`, `*.rar`, `*.iso`, `*.dmg`, `*.img`, `*.sqlite`, `*.db`.

**Marker parsing.** Blank lines and `#` comments ignored; leading `!` marks a negation; a bare `!` is an invalid line. Each pattern is validated through the same glob matcher used by search (`matchesPathPattern`); invalid syntax is reported to stderr and collected in `invalidLines` while valid lines still apply. Parsing never crashes the daemon.

**Caching.** Rule sets are cached per logical key `<productRoot>|<projectId>|<vaultRoot>`, invalidated when `.spec-memo-ignore` mtime or the vault `config.json` mtime/size/content changes. `clearIgnoreCacheForTests` resets the cache.

**Path resolution.** A relative path is resolved against the product root. Any path outside the product root is treated as ignored (`normalizeRelativePath` returns null → `ignored: true`). Curated-tree matched, directory-only, and `**` patterns are handled by `pathMatchesRule`.

**Enforcement points.**
- `upsert`: `pathPatterns` and `linkedPaths` each pass through `sanitizePathPatterns`. Ignored patterns are stripped; if every pattern is ignored the upsert throws `Safety violation: all <field> match ignored paths.` carrying `code: CAPTURE_IGNORE_AC6` and `field: pathPatterns|linkedPaths`.
- `prompt action:record`: file references in turn bodies/excerpts are rewritten to `[PATH_IGNORED]`.
- `bootstrap`: a focus `path` matching an ignore rule is disregarded and the brief falls back to project-wide compilation.
- `search` with `--path`: if the target path is ignored the search returns no matches.

**Read-only marker guarantee.** `spec-memo` never creates, edits, or deletes `.spec-memo-ignore` in the consumer repo. Missing marker is normal: built-in rules apply with no warning and no side effects.

**Diagnostics.**
- `memo doctor --check-capture <relativeOrAbsolutePath>` prints `CAPTURED (no ignore rule matched)` or `IGNORED (matched line N: <pattern>, source: builtin|.spec-memo-ignore|config.json)`; when the match has no rule it prints `IGNORED (outside repository root or matched ignore boundary)`. Exit code 0 when CAPTURED, 1 when IGNORED.
- Full `memo doctor` reports an `exclusionBoundary` card: `activeRuleCount`, `invalidLineCount`, and per-line invalid details; invalid marker lines become warnings.
- Both features are enforced without adding any MCP tool.

## Technical Architecture

**Modules.** `src/safety.ts` owns secret detection/redaction, path sanitization, and the product-tree guard; it re-exports `isPathIgnored` from `src/capture-ignore.ts`. `src/capture-ignore.ts` owns rule loading, matching, redaction of prompt text, and capture diagnostics, and imports `matchesPathPattern` from `src/indexer.ts` and `isPathInside` from `src/safety.ts`.

**Key API surface.**
- `detectSecrets(text)`, `scanPayloadForSecrets(payload)`, `assertNoSecrets(payload, context)`, `redactSecretsInPayload(payload)`, `stripVaultPaths(payload)`, `sanitizeToolOutput(payload)` (src/safety.ts).
- `isPathInside(target, root)`, `assertNotInProductRoot(target, productRoot, isGit, vaultRoot)`, `assertAllowedIdeRulePromote(...)`, `assertValidProjectId(...)` (src/safety.ts).
- `loadIgnoreRules(productRoot, {projectId, vaultRoot})`, `evaluatePathIgnore(...)`, `isPathIgnored(...)`, `sanitizePathPatterns(patterns, productRoot, options, field)`, `redactIgnoredPathsInText(...)`, `checkCapturePath(...)`, `formatCheckCaptureResult(...)`, `resolveCaptureProductRoot(...)`, `CAPTURE_IGNORE_AC6_CODE` (src/capture-ignore.ts).
- `DEFAULT_IGNORE_PATTERNS` is exported and used as the built-in baseline.

**Diagnostics contract.** `runDoctor` (src/doctor.ts) short-circuits when `checkCapture` is set, returning a result with `captureCheck` (`status`, `path`, `relativePath`, `match { pattern, line, source }`) and `exclusionBoundary`. The CLI maps `--check-capture` (or a second positional) to `DoctorOptions.checkCapture`. `IgnoreRuleSource = 'builtin' | '.spec-memo-ignore' | 'config.json'`.

**Side effects and failure modes.** Refusals throw before any file is written, so no partial record exists. Ignore parsing is advisory on malformed lines (stderr warning + `invalidLines`) and never prevents valid rules from running. All path checks are lexical, not content DLP; deep content scanning is left to the secret detectors above.

**Provenance.** `0003-curator-gc-and-safety.spec.md` (secret patterns, `assertNoSecrets`, `assertNotInProductRoot`) and `0040-capture-ignore-marker.spec.md` (`.spec-memo-ignore`, `DEFAULT_IGNORE_PATTERNS`, `ignorePaths`, `isPathIgnored`, `memo doctor --check-capture`, read-only marker). Current code adds a stable `CAPTURE_IGNORE_AC6` error code so sync-apply can distinguish `pathPatterns` skips from `linkedPaths` aborts.
