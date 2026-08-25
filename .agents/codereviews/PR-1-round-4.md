# PR-1 Round 4

Fixed remaining score 6-10 threads: bootstrap notices can no longer keep the brief over budget; stale `.memo.lock` recovered after 10s. Score 5 searchIndex-without-lock resolved with no code change (SQLite read vs exclusive writer lock).

Learning: N/A (no new reviewer-CI trap beyond existing bootstrap-byte-cap and lock-primitives entries)
