# PR-1 Round 3

Lock class completion: rebuildIndex and syncVault now acquire `.memo.lock`. Covers doctor --rebuild, importer FTS rebuild, and vault git pull/push.

Learning: Take vault lock at shared primitives
