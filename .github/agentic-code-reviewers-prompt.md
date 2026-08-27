# Specific Recommendations: spec-memo (Curated Agent Working Memory Store)

Focus review on this repository’s real stack: MCP stdio server + CLI (`memo`), Markdown store with YAML frontmatter under `$SPEC_MEMO_ROOT` (`~/.spec-memo/projects/<projectId>/`), SQLite FTS5 index (`memo.sqlite`), and Node.js 22 + TypeScript stdlib. Prefer findings that break storage contracts, security/secret redaction, host neutrality, or git boundary constraints.

## 1. Git boundary & vault location (CRITICAL)

* **Product tree git boundary:** Product repositories MUST NOT store agent session memory, `.agents/plans`, step copies, `.state.md`, `run.json`, `MEMORY.md`, or transient scratch logs in the product git tree. Flag any code change or test that writes vault records into the product tree.
* **Vault storage:** Standard store location is `$SPEC_MEMO_ROOT/projects/<projectId>/`. SQLite FTS5 (`memo.sqlite`) is a disposable index cache rebuilt from markdown source files; it is never the primary source of truth.

## 2. MCP & CLI seam

* **Unified entrypoint:** MCP stdio server and CLI (`memo`) share the same module in a single npm package.
* **Interface cap:** Exactly eight MCP tools / CLI commands: `bootstrap`, `search`, `get`, `upsert`, `append`, `forget`, `gc`, `promote`. Flag any attempts to add new MCP tools or CLI commands without prior PRD approval.
* **Host neutrality:** All MCP tool names, schemas, CLI commands, and error output MUST remain completely host-agnostic (no host-specific SDK dependencies or hardcoded IDE names).
* **Path leakage:** Do not leak internal vault filesystem paths into MCP tool descriptions or caller responses. Callers learn tools, not vault directory structures.

## 3. Storage, schemas, & token budget

* **Typed Markdown records:** All records stored under `$SPEC_MEMO_ROOT` must follow typed YAML frontmatter schemas (`kind`: trap, decision, spec, plan, state, review, scratch).
* **Token-budgeted brief:** `bootstrap` must return a token-capped brief (default 8 KB UTF-8; `config.json` `bootstrap.maxBytes` and per-call `maxBytes` may change the cap). Fail closed (truncate with notice) rather than returning uncapped vault content.
* **Secret redaction:** Ensure secret/PII redaction filter runs before records are saved or output in `bootstrap`/`search`.
* **Language:** Product docs, schemas, CLI help, MCP descriptions, tests, and commit messages must stay strictly **en-us**.

## 4. Code & diff hygiene (Karpathy guidelines)

* **Minimal footprint:** Prefer surgical, minimal diffs. Flag speculative refactoring, unused dependencies, or unrequested helper abstractions.
* **Dependencies:** Rely on Node 22 stdlib, `@modelcontextprotocol/sdk`, `better-sqlite3`, and `gray-matter`. Flag unneeded dependencies or ORMs.
* **Tests:** Automated tests using Node test runner (`node:test`) must cover tool handlers, schema validations, index rebuilding, and GC retention rules.

## 5. Review priorities

High signal:
1. Leaking vault memory files into the product repo tree.
2. Direct SQLite writes without matching Markdown source updates.
3. Breaking the 8-tool interface contract or host-neutral tool signatures.
4. Secret / credential leakage in logs or responses.
5. `bootstrap` exceeding token budget limits without truncation.
6. TypeScript runtime errors, invalid imports, or failing tests.

Low signal (usually skip):
* Pure prose style nits in docs.
* Formatting-only markdown churn without behavioral impact.

## 6. Minimum score threshold (`score_min: 5`)

* **Thread creation rule:** Create review threads ONLY for findings with a severity score **>= 5** (on a 1–10 scale). Filter out low-severity suggestions, style preferences, or minor nits scoring below 5.
