# Changelog

### [2026-08-28 20:12] Agent: Cursor Grok 4.6
- **Prompt**: /ws-goal-fix-pr PR 21 login next open-redirect
- **Done**: `safeStatusNextPath` rejects `//host`; login + 401 bounce use same rule; tests for protocol-relative next
- **Result**: `npm test` 316 pass. Learning: Status login `next` must reject protocol-relative URLs


### [2026-08-28 19:55] Agent: Cursor Composer
- **Prompt**: Status UI :3001 login page (token only, password-manager friendly)
- **Done**: `/login` + cookie session (`spec_memo_status_token`); unauthenticated `/` redirects; `apiFetch` sends credentials and bounces on 401; tests for redirect/login/cookie
- **Result**: status.test 26/26 pass


### [2026-08-28 19:45] Agent: Cursor Composer
- **Prompt**: Fix #20 status monitor UI SyntaxError (broken /\n+/g in template)
- **Done**: Escaped template regex in `src/status.ts` so browser receives `/\n+/g`; added generateStatusHtml regression assert
- **Result**: status tests 25/25 pass (inline script parse + negative fixture). Learning: N/A (template-literal escape pitfall already diagnosed in issue)

### [2026-08-28 19:20] Agent: Cursor Composer
- **Prompt**: /ws-fable-method fix GitHub #17 ws-memo reverse-handoff + MCP template align
- **Done**: Narrowed ws-memo description; dropped `spec-memo` invocation; added Consumer handoff + Session Router rows; labeled `memo setup` host/deployment; MCP-TEMPLATE primary npx `spec-memo` with git fallback; linked workflow-skills#253
- **Result**: Issue #17 ACs verified locally. Learning: N/A (standard documentation/skill contract fix)

### [2026-08-26 17:16] Agent: Cursor Grok 4.6
- **Prompt**: /ws-goal-fix-pr fix 6 session dry-run hybrid-sync findings (not a GitHub PR)
- **Done**: Daemon `/api/sync/push` and `/api/sync` honor `dryRun`; mutating tools resolve cwd `projectId` before `scheduleHybridPush`; debounce single-flights with one trailing push; `writeHybridState` uses `withVaultLockSync`; added AC21/AC18/AC25 tests
- **Result**: `npm test` exit 0 (219 pass / 0 fail). No PR resolve/push (session-local). Learning: Hybrid sync must honor dryRun, cwd projectId, vault lock, and single-flight debounce


### [2026-08-26 15:25] Agent: Cursor Grok 4.6
- **Prompt**: Fix memo/search SEARCH_FAILED bindings paths from Cursor client to MCP SSE server
- **Done**: Load better-sqlite3 via package-relative nativeBinding (`src/sqlite.ts`); ignore foreign/nonexistent client cwd in identity; tests for binding path, chdir, SSE search with foreign cwd
- **Result**: `npm test` exit 0 (205 pass / 0 fail). Redeploy/restart the SSE daemon on the lab host so search stops returning SEARCH_FAILED.

### [2026-08-26 14:45] Agent: Cursor Grok 4.6
- **Prompt**: Make npx spec-memo docs/references point to GitHub instead of the npm default server
- **Done**: Added package.json homepage/repository/bugs; switched docs, README, MCP-TEMPLATE, and ws-memo skill npx/install snippets to `github:jpolvora/spec-memo`; added prepare build so git npx compiles dist
- **Result**: `npm test` exit 0. `npm docs`/`npx` now resolve to GitHub rather than registry.npmjs.org

### [2026-08-26 12:35] Agent: Cursor Composer
- **Prompt**: Update ws-memo skill for 10-tool surface; update README/AGENTS; bump version; ship next version
- **Done**: Bumped package/MCP/vault/skill to 0.3.1; aligned ws-memo Rules + SURFACE (rank universe, empty skill promote guard); README/FEATURES/AGENTS + tracking Done logs
- **Result**: Preparing verify + ship-pr develop → master

### [2026-08-26 12:35] Agent: Cursor Composer
- **Prompt**: Update ws-memo skill for 10-tool surface; update README/AGENTS; bump version; ship next version
- **Done**: Bumped package/MCP/vault/skill to 0.3.1; aligned ws-memo Rules + SURFACE (rank universe, empty skill promote guard); README/FEATURES/AGENTS + tracking Done logs
- **Result**: Preparing verify + ship-pr develop → master

### [2026-08-26 11:35] Agent: Cursor Composer
- **Prompt**: Implement mcp-version-and-skill-install.spec.md (check_version + install_skills MCP tools + docs)
- **Done**: Added tools/CLI/modules/tests; amended PRODUCT/FEATURES/AGENTS/README/ws-memo to 10-tool surface; package.json files includes skill tree
- **Result**: `npm test` exit 0 (196 pass / 0 fail)

### [2026-08-26 11:20] Agent: Cursor Composer
- **Prompt**: Update README.md (humans) and AGENTS.md (agents) with run/serve/diagnose/status-monitor/autoboot service workflows; commit, push, `/ws-ship-pr`
- **Done**: Expanded README ops section (ports, stdio vs SSE, status UI curls, systemd + Windows Task Scheduler); AGENTS agent workflow table for serve/diagnose/status/autoboot; committed on `develop`
- **Result**: Docs-only ship. Learning: N/A (no new project trap)

### [2026-08-26 00:50] Agent: Cursor Grok 4.6
- **Prompt**: Create ws-memo skill covering full spec-memo MCP/CLI; open workflow-skills issue to improve ws-spec-memo handoff
- **Done**: Added `.agents/skills/ws-memo/` (SKILL.md + SURFACE/RECORDS/MCP-TEMPLATE + evals); pointers in AGENTS.md, FEATURES.md, README.md; opened jpolvora/workflow-skills#243
- **Result**: Runtime skill lives in spec-memo; consumer setup stays in workflow-skills ws-spec-memo

### [2026-08-26 00:41] Agent: Cursor Grok 4.6
- **Prompt**: Increment version, update docs/specs, commit develop, ship PR to master, wait CI/code-review and fix
- **Done**: Bumped package/MCP/vault version to 0.2.0; tracking docs; removed hardcoded auth token from vault-push script
- **Result**: `npm test` exit 0 (178 pass / 0 fail). Preparing PR develop → master

### [2026-08-26 00:00] Agent: Cursor Grok 4.6
- **Prompt**: Implement trap-recurrence ranking (layer/module, occurrence counter, memo rank, promote format:skill)
- **Done**: Schema + upsert bump-in-place, search.sort=occurrences, CLI `memo rank --backfill`, promote `format:skill`, TRAPS.md headings; 15 new tests
- **Result**: `npm test` exit 0 (154 pass / 0 fail). Tracked as Phase 6 done in index.PRD / PRODUCT.PRD / FEATURES.md / PLAN.md

### [2026-08-25 23:40] Agent: Cursor Grok 4.6
- **Prompt**: `/ws-write-spec` trap recurrence ranking (2-level categories, occurrence counter, list, export to owner skill) plus simplify the idea
- **Done**: Wrote `.agents/specs/trap-recurrence.spec.md` (25 ACs) and `trap-recurrence.context.md`; tracked row 24 on `index.PRD` as Phase 6
- **Result**: validate_spec.cjs --mode=authoring PASS. Spec of record only; no `{plansDir}` artifacts.

### [2026-08-25 08:10] Agent: Antigravity
- **Prompt**: Align project plans, update index.PRD, and create all corresponding *.spec.md files with derived implementation statuses
- **Done**: Created all missing canonical specifications across all phases (dogfood-remap, vault-and-identity, record-schema-and-indexes, relocatable-hub, memory-adapter-mcp, write-block-hook, trap-dedup, spec-drift, vault-git, cross-project-search, cli-doctor, viewer); synchronized index.PRD, PRODUCT.PRD, and FEATURES.md; verified schema validation across all 18 specs.
- **Result**: All 18 specifications pass validation (`validate_spec.cjs`). All 66 unit tests pass (`npm test`). Ready for tracking and execution.

### [2026-08-22 22:15] Agent: Cursor Grok 4.6
- **Prompt**: `/ws-spec-index` then promote Inbox embeddings item with a stub spec
- **Done**: Promoted embeddings-search to Phase 3 in index.PRD and PRODUCT.PRD; wrote format-valid stub `.agents/specs/embeddings-search.spec.md`
- **Result**: validate_spec.cjs --mode=authoring PASS (4 ACs). Inbox item removed. No `{plansDir}` artifacts.
