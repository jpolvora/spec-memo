---
id: null
slug: memory-feedback-salience
title: "Memory Feedback, Typed Graph Links, and Zero-LLM Contradiction Detection"
source: local
specDate: 2026-09-04
---

# Specification — Memory Feedback, Typed Graph Links, and Zero-LLM Contradiction Detection

## Description

Establish an explicit qualitative feedback and semantic link mechanism for memory records in `spec-memo`. Enable agents and human operators to mark retrieved records as `helpful`, `not_helpful`, `stale`, or `wrong`. Expand record frontmatter with typed relationship links (`fixes`, `contradicts`, `causes`). Track feedback counts in frontmatter, dynamically penalize the retrieval score of records flagged as stale, surface warning badges in `bootstrap` for obsolete rules, and empower `memo doctor` to detect conflicting active decisions or traps via pure SQLite graph traversal without requiring external LLM API calls.

### Problem Analysis & Real-World Evidence

1. **Hit Count Blind Spot:**
   - In `src/hits.ts`, `recordMemoryHits()` increments `hits` and updates `lastHit` whenever a record is returned in a brief or fetched via `get`.
   - However, retrieval frequency does not indicate accuracy. A trap written for an obsolete framework version (e.g. before an architectural rewrite) will continue accumulating hits whenever matching file paths are touched, giving it an artificially inflated ranking score.
2. **High Friction for Stale Annotations:**
   - Currently, if an agent discovers a trap is no longer valid, it must either invoke `memo forget` (which archives or purges the record entirely) or write a full replacement via `memo upsert`. There is no lightweight affordance to signal *"this trap was misleading or stale"* without rewriting the file.
3. **Undetected Semantic Contradictions:**
   - As documented in `ai-memory 2.0`, as codebases evolve, newer architectural decisions frequently contradict older decisions. If both remain `status: 'active'`, agents receive conflicting instructions in the `bootstrap` brief.
   - Using LLMs to continuously review memory for contradictions is expensive, slow, and non-deterministic. A structural, typed link system (`contradicts`, `fixes`) allows SQLite to detect contradictions deterministically at zero token cost.

### Design Intent

Introduce atomic feedback tracking (`helpfulCount`, `staleCount`) and typed semantic links (`links: [{ target: string, type: 'fixes' | 'contradicts' | 'causes' }]`) in frontmatter. Integrate feedback reporting into `prompt` (`action: 'feedback'`) and `memo feedback`. Adjust retrieval ranking to penalize stale records, surface visual stale warnings in session briefs, and run zero-LLM contradiction checks in `memo doctor`.

---

## Acceptance Criteria

### Frontmatter Schema, Feedback & Semantic Links

- AC1: `RecordFrontmatter` and `FrontmatterSchema` accept optional numeric fields `helpfulCount?: number` and `staleCount?: number` (both defaulting to 0) and an optional `links?: Array<{ target: string; type: 'fixes' | 'contradicts' | 'causes' }>`.
- AC2: Feedback mutations update frontmatter fields atomically in place without rewriting or altering the markdown body.
- AC3: The `lastFeedback` ISO timestamp is updated on the record whenever feedback is submitted.

### Feedback Submission Affordances

- AC4: The `prompt` MCP tool accepts `action: 'feedback'` with required `id` (record ID), required `feedback` (`'helpful' | 'not_helpful' | 'stale' | 'wrong'`), and optional `comment` (string).
- AC5: The CLI command `memo feedback <id> --helpful|--stale|--wrong [--comment "reason"]` records feedback directly from the terminal.
- AC6: When `feedback: 'helpful'` is received, `helpfulCount` increments by 1 and `lastHit` is refreshed.
- AC7: When `feedback: 'stale'` or `'wrong'` is received, `staleCount` increments by 1.

### Ranking Salience & Bootstrap Integration

- AC8: In `src/indexer.ts`, `searchIndex()` applies a salience dampening multiplier to candidates where `staleCount > helpfulCount`, reducing their composite score proportionally.
- AC9: When `staleCount >= 3` and `staleCount > helpfulCount`, the record is marked with `flaggedStale: true` in search result objects.
- AC10: When a record with `staleCount >= 3` and `staleCount > helpfulCount` is included in the `bootstrap` brief, `src/bootstrap.ts` prepends a warning badge `⚠️ [POSSIBLY STALE]` to its title heading.

### Zero-LLM Contradiction Detection & Diagnostics

- AC11: In `src/indexer.ts`, typed links (`fixes`, `contradicts`, `causes`) are indexed into a lightweight SQLite table `record_links (source_id, target_id, link_type)` auto-synchronized during record indexing.
- AC12: `memo doctor` executes a deterministic SQL graph query to detect active contradictions: records where Record A has `type: 'contradicts'` targeting Record B, while both Record A and Record B maintain `status: 'active'`.
- AC13: When active contradictions are discovered, `memo doctor` outputs an "Active Semantic Contradictions" section listing the conflicting record pairs and recommending archival or supersession.
- AC14: `memo doctor` scans the vault for records where `staleCount >= 3` and `staleCount > helpfulCount`, listing them under "Potentially Obsolete Traps & Decisions".
- AC15: The `:3124` Status Monitor Memory explorer details drawer provides "Mark Helpful" and "Flag Stale" buttons and visualizes incoming/outgoing typed relationship links (`fixes`, `contradicts`).
- AC16: Operational telemetry logs `operation: 'memory_feedback'` containing record ID, feedback type, and updated counts.

---

## Notes

- **Zero LLM Token Cost:** Contradiction checks run entirely in SQLite using relational integrity queries, eliminating external API calls and latency.
- **Zero MCP Tool Count Impact:** Reuses the existing `prompt` tool with `action: 'feedback'`, strictly complying with the 11-tool ceiling.
- **Fail-Open Resilience:** If feedback is submitted for a non-existent record ID, the command returns an informative error without mutating vault state.

---

## Out of Scope

| Feature | Reason |
|---------|--------|
| Automatic deletion of records based on feedback | Feedback dampens ranking and warns agents; permanent deletion or archival requires explicit human or GC confirmation. |
| Per-user authentication for feedback scoring | `spec-memo` operates primarily in single-workspace or shared-token team modes; aggregate counts are stored directly in record frontmatter. |
| Natural language sentiment parsing of chat logs | Feedback is explicitly triggered via tool action or CLI rather than guessed from chat prose. |

---

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Threshold for `[POSSIBLY STALE]` badge | 3 stale marks exceeding helpful marks | Prevents a single accidental click from degrading visibility while catching genuinely obsolete records. | y |
| Score penalty formula | Score multiplied by `1 / (1 + staleCount - helpfulCount)` | Provides smooth, proportional demotion without binary drop-off. | y |
| Contradiction severity | Warning in doctor and status monitor | Does not hard-block queries; alerts developers to conflicting policies. | y |

---

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Zero-LLM Contradiction Engine | Relational link table in SQLite indexed from markdown frontmatter | SQLite query test with conflicting records |
| Architectural Alignment | Integrates into `src/schema.ts`, `src/hits.ts`, `src/indexer.ts`, `src/prompt.ts`, `src/doctor.ts` | Codebase inspection and schema verification |
| Tool Ceiling Compliance | Zero new MCP tools created; extends `prompt` tool actions | Tool schema audit |
| Validation Pass | Complies with canonical specification schema | Passes `validate_spec.cjs --mode=authoring` |

---

## Validation & Observation Notes

### Telemetry & Observable Signals

- `memo feedback trap-test --stale`: frontmatter updates to `staleCount: 1`.
- `memo upsert --kind decision --title "New auth" --body "..." --links '[{"target":"decision-old-auth","type":"contradicts"}]'`: stores relationship in frontmatter and SQLite links table.
- `memo doctor`: outputs "Active Semantic Contradictions: decision-new-auth contradicts decision-old-auth (both active)".

### Negative & Failing Test Scenarios

- Submitting invalid feedback type (e.g. `--neutral`) errors cleanly with allowed choices (`helpful`, `not_helpful`, `stale`, `wrong`).
- Submitting feedback on a non-existent record ID returns exit code 1 with "Record not found" error.
- Corrupted frontmatter fields are repaired to numeric 0 before applying feedback increment.
