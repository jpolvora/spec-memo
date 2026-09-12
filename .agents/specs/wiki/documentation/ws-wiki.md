# ws-wiki Skill (Living Wiki Harness)

## Feature Overview

`ws-wiki` is the `workflow-skills` harness skill that maintains this **living feature wiki**. It is not a runtime `spec-memo` feature: it is the authoring and reconciliation tool that turns the repository's point-in-time specifications into a domain-partitioned knowledge base at `.agents/specs/wiki/`, then keeps that base synchronized with shipped code.

The wiki exists because `*.spec.md` files are bounded, point-in-time delivery contracts, while `PRODUCT.PRD`, `FEATURES.md`, and the source tree keep moving. `ws-wiki` produces a durable, human-readable layer that states what the system does **today**, grouped by bounded context rather than by delivery slice.

Publisher surfaces:

- Repository markdown under `.agents/specs/wiki/` (source of truth for the wiki).
- Generated static site under `docs/wiki/`, published with the project website at `https://jpolvora.github.io/spec-memo/wiki/`.
- Deterministic helper scripts for queueing, index synchronization, and validation.

Primary subcommands: `init`, `sweep` (alias `first-time`/`backfill`), `verify` (alias `audit`/`check-code`), `apply` (alias `reconcile`/`phase-3`), `sync [slug]`, `update [target]`, and `validate`.

## Business Rules & Logic

**Document roles.** `CHANGELOG.md` is chronological; `index.PRD` tracks task completion; `*.spec.md` is a bounded delivery contract; the wiki is the living, domain-grouped synthesis. The wiki never replaces any of them.

**Structure.** The root `index.wiki.md` holds the system vision, architectural boundaries, and a domain catalog of relative links. Each feature page lives at `{domain}/{feature}.md` and must contain exactly three level-2 sections: `## Feature Overview`, `## Business Rules & Logic`, `## Technical Architecture`.

**Sweep ordering.** Phase 1 walks top-level `{specsDir}/*.spec.md` deterministically: numbered `NNNN-*.spec.md` ascending, then unprefixed lexicographically. Pages are refined in place so later specs supersede earlier rules. When a spec acceptance criterion contradicts current code, the wiki documents **current code**; the spec text is retained only as provenance.

**Verify classification.** Phase 2 is read-only. Every checkable statement is classified `confirmed`, `differs`, `absent`, or `inconclusive` against the consumer project, each with at least one evidence pointer. Findings are persisted to `{wikiDir}/verify.state.json` (a runtime checkpoint that must not be committed). The walk presents no apply plan and writes no wiki page or spec.

**Apply truth gate.** Phase 3 presents each `differs`/`absent` finding with two truth options. **Update wiki** means code (or its absence) is the source of truth and the statement is rewritten or dropped in place. **Update code** keeps the wiki statement and schedules a standalone `ws-spec-write` spec under `{specsDir}`; the skill never edits product code itself and never starts an orchestrator.

**Validation.** `validate_wiki.cjs` requires the wiki directory and `index.wiki.md` to exist, fails on broken relative links or links that escape the wiki directory, fails on feature pages missing any required section heading, and warns on pages not linked from the index.

**Bounds and safety.** All writes stay under `{wikiDir}`; a path-traversal domain or feature name is rejected. The wiki is English-only (`en-us`). The checkpoint files (`sweep.state.json`, `verify.state.json`) are disposable runtime state and are excluded from product commits.

**CI contract.** `npm run build:site` regenerates `docs/wiki/**` from `.agents/specs/wiki/**` and rewrites `docs/sitemap.xml`. `npm run check:site` fails when generated HTML or the sitemap is stale relative to the markdown, so the deployed website can never drift from the wiki sources.

## Technical Architecture

**Generator.** `scripts/build-wiki-site.js` (adapted from the `workflow-skills` `bin/build-wiki-site.js` generator) is a synchronous, dependency-free ESM module. `resolveWikiDir(repoRoot)` reads `plans.wikiDir` from `.agents/skills/ws-shared/config.json`, defaulting to `.agents/specs/wiki`, and rejects a directory that escapes the repo root. `buildWikiSite({ repoRoot, wikiDir, outDir, check })` collects the root index plus every `{domain}/*.md`, renders a deliberate Markdown subset (headings, lists, code fences, bold/italic, inline code, and intra-wiki links), and writes each page to `docs/wiki/` with cross-linked sidebar, topbar, TOC, infobox, and print/theme controls. In `check` mode it compares expected HTML byte-for-byte and reports `stale` or `extra` files instead of writing. `buildSitemapXml(sitemapLocs)` emits the sitemap entries consumed by `docs/sitemap.xml`.

**Link rewriting.** Markdown `.md` targets are rewritten to `.html`; `index.wiki.md` maps to `index.html`; `http(s)`/`mailto`/`#fragment` targets are preserved; `javascript:`/`data:` are dropped; any target that would resolve outside the wiki directory is neutralized. This keeps the generated site safe and self-contained.

**Assets.** `docs/assets/css/wiki.css` (adapted from the `workflow-skills` site stylesheet) supplies the `.wiki-*` design system. The main marketing page `docs/index.html` continues to use `docs/styles.css`.

**Build wiring.** `scripts/build-site.js` stamps `docs/index.html` and `docs/llms.txt` from `package.json.version` and then invokes `buildWikiSite` for both the normal and `--check` paths, writing `docs/sitemap.xml` from the returned locations and failing the check on any staleness. `.github/workflows/deploy-site.yml` runs `node scripts/build-site.js` (regenerate) followed by `node scripts/build-site.js --check` (verify) before uploading `docs/` to GitHub Pages.

**Deterministic helpers.** Queue and index utilities live beside the skill (`list_wiki_sweep_specs.cjs`, `list_wiki_feature_pages.cjs`, `sync_wiki_index.cjs`, `validate_wiki.cjs`); the compiled `dist/cli.js` and MCP tools are unaffected by wiki generation.

**Provenance.** Harness skill `ws-wiki` (`workflow-skills`); wiki source tree `.agents/specs/wiki/`; generator ported 2026-09-12 from `bin/build-wiki-site.js`.
