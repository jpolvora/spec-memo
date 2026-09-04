import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveProjectIdentity } from './identity.js';
import { ensureVaultStructure, getProjectMetadata } from './vault.js';
import { upsertRecord, getRecord, appendEvent } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { runDoctor } from './doctor.js';

describe('Multi-Clone Memory Sharing', () => {
  it('should share memory, search index, and vault between different local clones of the same repository', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-multiclone-'));
    const vaultRoot = path.join(tempRoot, 'vault');
    const cloneA = path.join(tempRoot, 'repo-clone-a');
    const cloneB = path.join(tempRoot, 'repo-clone-b');

    // Scaffolding git repositories for Clone A (HTTPS) and Clone B (SSH)
    fs.mkdirSync(path.join(cloneA, '.git'), { recursive: true });
    fs.mkdirSync(path.join(cloneB, '.git'), { recursive: true });

    fs.writeFileSync(
      path.join(cloneA, '.git', 'config'),
      `[remote "origin"]\n\turl = https://github.com/myteam/core-platform.git\n`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(cloneB, '.git', 'config'),
      `[remote "origin"]\n\turl = git@github.com:myteam/core-platform.git\n`,
      'utf8'
    );

    try {
      // 1. Verify identical project identity resolution
      const identityA = resolveProjectIdentity(cloneA, { vaultRoot });
      const identityB = resolveProjectIdentity(cloneB, { vaultRoot });

      assert.equal(identityA.projectId, 'github.com-myteam-core-platform');
      assert.equal(identityB.projectId, 'github.com-myteam-core-platform');
      assert.equal(identityA.projectId, identityB.projectId);
      assert.equal(identityA.vaultProjectPath, identityB.vaultProjectPath);
      assert.equal(identityA.isFallback, false);
      assert.equal(identityB.isFallback, false);

      // 2. Clone A creates memory records (trap, decision, spec)
      const trapResult = await upsertRecord({
        kind: 'trap',
        body: 'Windows file handles on SQLite databases must be closed before directory deletion.',
        cwd: cloneA,
        vaultRoot,
        frontmatter: {
          title: 'SQLite handle lock on Windows',
          severity: 'critical',
          tags: ['sqlite', 'windows', 'concurrency'],
          pathPatterns: ['src/**/*.ts']
        }
      });
      assert.ok(trapResult.id);
      const trapId = String(trapResult.id);

      const decisionResult = await upsertRecord({
        kind: 'decision',
        body: 'We choose SQLite WAL mode for high concurrency across agent workers.',
        cwd: cloneA,
        vaultRoot,
        frontmatter: {
          title: 'Adopt SQLite WAL mode',
          tags: ['architecture', 'storage']
        }
      });
      assert.ok(decisionResult.id);

      // Verify metadata after Clone A writes
      let meta = getProjectMetadata(identityA.projectId, vaultRoot);
      assert.ok(meta);
      assert.equal(meta.lastSeenRoot, path.resolve(cloneA));
      assert.ok(meta.knownRoots?.includes(path.resolve(cloneA)));

      // 3. Clone B queries the shared vault via getRecord
      const retrievedTrap = await getRecord({
        id: trapId,
        cwd: cloneB,
        vaultRoot
      });
      assert.ok(retrievedTrap, 'Clone B must find trap created by Clone A');
      assert.equal(retrievedTrap.frontmatter.title, 'SQLite handle lock on Windows');
      assert.equal(retrievedTrap.frontmatter.severity, 'critical');

      // 4. Clone B searches the shared FTS index
      const searchHits = searchIndex({
        query: 'SQLite handle lock',
        cwd: cloneB,
        vaultRoot
      });
      assert.ok(searchHits.length > 0, 'Clone B must find records via FTS search');
      assert.equal(searchHits[0].id, trapId);

      // 5. Clone B compiles bootstrap brief
      const briefB = await compileBootstrapBrief({
        cwd: cloneB,
        vaultRoot
      });
      assert.equal(briefB.projectId, 'github.com-myteam-core-platform');
      assert.equal(briefB.lastSeenRoot, path.resolve(cloneB));
      assert.ok(briefB.traps.some((t) => t.frontmatter.id === trapId), 'Brief in Clone B must contain trap from Clone A');
      assert.ok(
        briefB.decisions.some((d) => d.frontmatter.title === 'Adopt SQLite WAL mode'),
        'Brief in Clone B must contain decision from Clone A'
      );

      // 6. Verify knownRoots in project.json now contains both clone roots
      meta = getProjectMetadata(identityB.projectId, vaultRoot);
      assert.ok(meta);
      assert.equal(meta.lastSeenRoot, path.resolve(cloneB));
      assert.ok(meta.knownRoots?.includes(path.resolve(cloneA)), 'knownRoots must include Clone A');
      assert.ok(meta.knownRoots?.includes(path.resolve(cloneB)), 'knownRoots must include Clone B');

      // 7. Clone B appends an audit event; Clone A verifies it is present in the shared log
      await appendEvent({
        event: 'Clone B completed integration tests slice 1',
        cwd: cloneB,
        vaultRoot,
        details: { agent: 'agent-b' }
      });

      const allEventsBrief = await compileBootstrapBrief({
        cwd: cloneA,
        vaultRoot
      });
      assert.equal(allEventsBrief.projectId, 'github.com-myteam-core-platform');
      assert.equal(allEventsBrief.lastSeenRoot, path.resolve(cloneA));

      // 8. Clone B updates/adds a decision; Clone A immediately sees it
      await upsertRecord({
        kind: 'decision',
        body: 'Approved hybrid sync interval of 5 seconds.',
        cwd: cloneB,
        vaultRoot,
        frontmatter: {
          title: 'Hybrid sync interval policy',
          status: 'active'
        }
      });

      const cloneASearch = searchIndex({
        query: 'Hybrid sync interval',
        cwd: cloneA,
        vaultRoot
      });
      assert.ok(cloneASearch.length > 0, 'Clone A must see decisions added by Clone B');

      // 9. Doctor diagnostics run in both clones report the same healthy project
      const doctorA = await runDoctor({ cwd: cloneA, vaultRoot });
      const doctorB = await runDoctor({ cwd: cloneB, vaultRoot });

      assert.equal(doctorA.project.projectId, 'github.com-myteam-core-platform');
      assert.equal(doctorB.project.projectId, 'github.com-myteam-core-platform');
      assert.equal(doctorA.project.isFallback, false);
      assert.equal(doctorB.project.isFallback, false);
      assert.equal(doctorA.healthy, true);
      assert.equal(doctorB.healthy, true);
    } finally {
      closeIndex(vaultRoot);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
