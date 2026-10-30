# Product Guarantees

What SDW promises to every consumer, on every harness, and what maintainers must preserve when changing skills or tooling. These are product-level rules referenced by `sdw-rules/SKILL.md`; a repository harness may load them directly.

If a change breaks a guarantee, the change is wrong — or the guarantee must be revised here first, deliberately.

---

## 1. Guarantees

| Guarantee | What it means for consumers | What maintainers must do |
|---|---|---|
| **Zero runtime dependencies** | Installed skills never require `npm install`, a compiler, or a system binary beyond git and Node.js. | Use only the Node.js 22 **standard library** in `scripts/*.cjs`; no runtime `dependencies` in packaged skills. |
| **Node.js 22 CommonJS** | Scripts run on the documented runtime without transpilation. | Author `.cjs` files with `require`; no ESM-only APIs, no TypeScript build step. |
| **Deterministic tool anchors** | Every workflow step exposes an explicit CLI command with pass/fail exit codes, so results are reproducible. | Never hide behavior behind prompts alone; add a `scripts/*.cjs` anchor and document its command. |
| **Harness & agent agnostic** | Nothing depends on a specific vendor, IDE, agent runtime, or proprietary API. | Use files, CLI, stdin/stdout, Markdown/JSON/YAML. No vendor SDKs, no hidden host callbacks. |
| **File-based contracts** | Specs, state, evidence, reports, and configuration are inspectable and diffable. | Store durable information in files with documented schemas; no opaque databases for product state. |
| **Portable paths** | Skills work on Windows and POSIX; artifacts never carry machine-specific absolute paths. | Normalize separators to `/` in generated artifacts, use `{projectRoot}`-style tokens, and keep distributed files free of absolute OS paths. |
| **No in-repo agent memory** | Consumer repositories are not polluted with private agent memory files. | Keep traps/decisions in the external memory vault (`spec-memo`/`ws-memo`), never in `MEMORY.md`, `.agents/plans/`, or similar. |
| **3-Tier skills** | Context cost stays bounded and behavior stays inspectable. | Keep Tier 1 `SKILL.md` compact (≤ ~120 lines; `sdw-rules` ≤ 80), move detail to `references/`, logic to `scripts/`. |
| **Breaking changes may occur** | In the current phase, interfaces can change between versions; consumers should pin and read release notes. | Do not keep compatibility shims or dual paths; remove superseded behavior instead of wrapping it. |

---

## 2. Verification

A guarantee is only real if it is checked:

- **Dependencies:** packaged skills contain no `dependencies`; helper scripts require only Node built-ins.
- **Line budgets:** `sdw-rules doctor` enforces Tier 1 limits and downstream references to `sdw-rules`.
- **Determinism:** every documented workflow step has a runnable `node …` command and an exit code.
- **Agnosticism:** review skills for vendor names, API keys, or host-specific imports; only generic CLI/file primitives are allowed.
- **Paths:** generated reports and commands use `/` separators and project-relative or tokenized paths.

---

## 3. What is not a guarantee

- **No security sandbox.** A clone-based sandbox is filesystem/git isolation, not a process, network, or credential boundary.
- **No vendor parity.** Features are not replicated across harnesses beyond the shared file/CLI contract.
- **No silent compatibility.** Renamed commands, flags, and statuses are removed, not aliased.
- **No autonomous scope expansion.** Skills execute their contract; they do not invent adjacent features.
