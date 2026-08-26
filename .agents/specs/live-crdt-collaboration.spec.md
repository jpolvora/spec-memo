---
id: null
slug: live-crdt-collaboration
title: "Live CRDT collaboration mode for team vaults"
source: local
specDate: 2026-08-26
status: draft
target_phase: Phase 7
---

# Specification — Live CRDT collaboration mode for team vaults

## Description

Teams sharing one vault today sync with **batch** peer deltas (`memo sync-vault` / `exportChangeset` / `applyChangeset`) using last-write-wins and `.conflict.*` sidecars. Concurrent live edits of the same Markdown record collide; agents and humans cannot co-author a trap body or plan without serializing writers behind `withVaultLock`.

This Phase 7 **MVP** adds an **opt-in live collaboration room** for a single vault project: peers join a WebSocket session keyed by `(projectId, recordId)`, share a Yjs CRDT document for the **record body** (Markdown text), see basic **presence**, and periodically **flush** the converged body back through the existing `upsertRecord` path so Markdown remains source of truth and FTS/compiler stay valid.

Architecture touchpoints:

- **New module `src/collab.ts`**: `createCollabHub`, room lifecycle, Yjs `Y.Doc` per room, presence map, debounced flush to vault, auth/loopback refusal matching SSE/canvas/status.
- **Transport**: companion HTTP+WS listener (default port `3002`) started from CLI (`memo collab --port` / `memo serve --sse --collab` optional flag). Not a ninth MCP tool.
- **Store integration**: flush calls `upsertRecord` with `kind`/`id` from the room binding; never bypass schema or `assertNoSecrets`. Hold vault lock only for the flush write, not for the entire live session.
- **CLI (`src/cli.ts`)**: start/stop collab listener; print WS URL; `--json` includes `collabUrl`.
- **Safety**: sanitize presence display names; refuse non-loopback bind without token; never put secrets in CRDT awareness payloads.
- **Tests (`src/collab.test.ts`)**: two in-process Yjs clients converge on the same body; flush writes a parseable vault record; empty room / unknown record fail closed; auth refusal; ring/presence bounds.
- **Docs**: README/AGENTS note opt-in nature and that `memo sync-vault` remains the offline/async path.

Design gray areas: [`live-crdt-collaboration.context.md`](live-crdt-collaboration.context.md).

### Layer: infrastructure / application

- CRDT hub + WS transport (infrastructure)
- Flush → upsert / CLI / docs (application)

## Acceptance Criteria

- AC1: `createCollabHub(options)` returns a hub with `listen({ port, host })`, `close()`, and `getRoom(projectId, recordId)` that creates or returns a room bound to one existing vault record (or creates a `scratch` record when `createIfMissing: true`).
- AC2: Binding the collab listener to a non-loopback host without an auth token (`--auth-token` / `SPEC_MEMO_AUTH_TOKEN` / `SPEC_MEMO_COLLAB_TOKEN`) throws before listen, matching SSE/canvas/status refusal semantics.
- AC3: Two independent Yjs clients connected to the same room WebSocket converge on identical body text after concurrent inserts (deterministic test using in-process WS or y-protocols sync).
- AC4: After edits, a debounced flush (default ≤ 2s, configurable) persists the converged body via `upsertRecord` so `getRecord({ id })` returns the merged Markdown; SQLite FTS rebuild occurs through the normal upsert/index path (no hand-rolled index write).
- AC5: Flush refuses bodies that fail `assertNoSecrets` / schema validation; the live room stays open but the failed flush is reported on the hub event log / returned promise rejection without corrupting the on-disk record.
- AC6: Presence: each connected client publishes a peer id + optional display name; `GET /api/collab/rooms/:projectId/:recordId/peers` (or hub `listPeers`) returns the current set; disconnect removes the peer within one heartbeat interval (default ≤ 30s).
- AC7: CLI `memo collab [--port 3002] [--host 127.0.0.1] [--json]` starts the listener and prints the WebSocket URL; SIGINT/SIGTERM close the hub cleanly (no orphan ports in tests).
- AC8: Default `memo serve --sse` does not start the collab listener (opt-in only via `--collab` or `SPEC_MEMO_COLLAB=1`).
- AC9: When collab is started with serve, the serve banner and `--json` output include a non-empty `collabUrl`.
- AC10: Rooms are scoped to kinds `scratch` and `plan` in this MVP; attempting to open a room for `trap`, `decision`, `log`, `review`, `state`, or `spec` returns a structured error unless `forceKind` is explicitly set in hub options (default deny).
- AC11: Automated tests cover AC3–AC6 and AC10 without requiring a second physical machine; `npm test` includes the new suite and existing suites remain green.
- AC12: README (and AGENTS HTTP/SSE section) documents collab URL, opt-in flags, kind scope (`scratch`/`plan`), and that `memo sync-vault` remains the batch peer sync path.

## Original Issue Context

Inbox item from `PRODUCT.PRD` / `index.PRD` § Inbox: "Live CRDT collaboration mode for team vaults."

### Prior Work Sweep

- No open PR exact-match for CRDT/collaboration (`gh pr list --search "CRDT OR collaboration"` empty).
- Related delivered work: Phase 5 `multi-machine-sync` (`src/sync.ts`) — batch LWW deltas + conflict sidecars; Phase 3 `vault-git` — async git sync, non-goal includes realtime OT; Phase 5/6 SSE — MCP RPC + status activity stream only.
- No `yjs` / `automerge` / websocket collab deps in `package.json`.
- Test fixture slug `crdt-decision` in `sync.test.ts` is unrelated naming only.

### Design Intent

Greenfield additive slice. Skip `git log -L` restoration analysis: no prior CRDT implementation to restore. Intentionally **does not** replace `syncVaults` LWW policy.

## Notes

- Prefer **Yjs** + WebSocket provider over Automerge for Node WS familiarity and smaller MVP surface.
- Markdown remains SoT: CRDT is the live session substrate; disk truth is the flushed `.md` record.
- Do not add a ninth MCP tool; agents keep using `get`/`upsert` while humans/peers may attach WS clients.
- Keep vault lock duration minimal (flush only).

## Out of Scope

| Feature | Reason |
|---------|--------|
| CRDT for traps/decisions/logs/specs by default | Dedup/supersede and append-only semantics conflict with free-form text CRDT; deferred |
| Replacing `memo sync-vault` / vault-git | Offline/async paths stay; collab is complementary |
| Hosted multi-tenant SaaS / billing / SSO | Local-first product thesis |
| E2E encryption of CRDT traffic | Separate security slice |
| Rich-text / canvas graph co-editing UI | MVP is body-text rooms + APIs; no full editor product |
| Mobile companion dashboard | Separate inbox item |
| Ninth MCP tool | Hard invariant of 8 core tools |
| Automatic merge of existing `.conflict.*` sidecars | Out of MVP; leave LWW artifacts untouched |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| CRDT library | Yjs | Mature WS ecosystem; fits Node tests | y (autoMode) |
| Default port | 3002 | 3000 SSE, 3001 status, 4100 canvas | y (autoMode) |
| MVP record kinds | `scratch` + `plan` only | Lowest risk vs trap dedup / log append | y (autoMode) |
| Presence UI | API + peers list only (no fancy cursors UI) | Keep diff small; tests assert peers | y (autoMode) |
| Tenancy / i18n / migrations / RBAC | N/A because local single-vault opt-in MVP with loopback auth parity | Not applicable to this slice | y (autoMode) |
