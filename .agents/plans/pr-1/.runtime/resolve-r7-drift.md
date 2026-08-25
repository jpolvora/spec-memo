No code change (score 5).

**Problem:** Outer catch in `checkSpecDrift` swallows `git status` / `git show` failures and leaves the path out of `modifiedPaths`, so bootstrap can omit drift when git is unavailable.

**Why no change:** Bootstrap drift is advisory and already fail-closed on the inner `git show` (missing blob / show failure sets `diverged = true`). The outer catch is only for `git status` failing as a whole (no `.git`, rebase lock, sandbox without git). Treating every git-unavailable product root as drifted would false-positive CI and non-git fallbacks that already pass `isGit`. Product-tree rebase conflicts are operator-visible; this catch is a best-effort degrade, not a silent rewrite of verified content.

**defectClass:** checkSpecDrift outer catch treats git failure as no-drift
**sourcesConsulted:** code, memory (spec-drift SHA), context
**proactiveFixed:** none
**proactiveSkipped:** src/bootstrap.ts — score 5 resolve-with-comment; inner show-fail already counts as drift
