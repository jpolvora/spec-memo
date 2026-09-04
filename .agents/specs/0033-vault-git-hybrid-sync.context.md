# Context — vault-git-hybrid-sync

## Feature Boundary

This slice changes **when** vault-git commits/pushes and **how** `memo sync` / session_end share the road with hybrid HTTP. It does not replace hybrid changeset sync, `memo sync-vault` (filesystem peers), encrypted backup, or remote-mode proxy.

In: `vaultGit.atomic`, batched flush events, dual-channel orchestrator, fail-open logging, gitignore/.sync state, status/doctor/docs, tests.

Out: CRDT, extra debounce timers, conflict UI, new MCP tool, remote-mode local git.

## Implementation Decisions

1. **Default batched (`atomic: false`).** Operator asked to stop per-upsert git. Existing `vault-git` AC2 micro-commit is superseded as the default. Operators who want the old cadence set `atomic: true`.
2. **Atomic includes remote sync, not commit-only.** User wording was commit/push/sync. Hybrid HTTP stays independently debounced so atomic git does not force synchronous hybrid round-trips on every upsert.
3. **Flush events: `memo sync`, `session_end`, graceful serve shutdown.** Shutdown is the extra event the user did not name; without it a batched SSE daemon can stop with a dirty tree and never push. CLI one-shot `memo upsert` does **not** flush on exit (avoids git from scripts).
4. **Parallel channels with serialized vault lock.** Network (`fetch`, `git pull/push`) runs without the lock. Local apply/commit takes the existing vault lock. `Promise.allSettled` so one failure cannot cancel the other.
5. **`autoCommit` aliases `atomic` only when `atomic` is omitted.** Avoids a dead schema field; `atomic` wins if both exist.
6. **Cadence break is documented, not compatibility-shimmed.** No env flag to restore micro-commits besides `atomic: true`.

## Deferred Ideas

- Optional debounce window for atomic git push (mirror hybrid 2s) if commit storms return under `atomic: true`.
- `memo sync --vault-git-only` / `--hybrid-only` flags if operators need to isolate a broken channel.
- Status monitor Backups-tab sibling for vault-git dirty badge.
- Auto `git rebase --abort` policy after a timed-out rebase (needs evidence from production logs first).
