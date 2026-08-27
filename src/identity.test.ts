import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  normalizeGitRemote,
  generateProjectIdFromRemote,
  generateProjectIdFromPath,
  findGitRoot,
  resolveProjectIdentity
} from './identity.js';

describe('Git Remote and Project Identity', () => {
  it('should normalize diverse git remote URL formats to canonical hostname/path', () => {
    const cases = [
      {
        input: 'git@github.com:jpolvora/spec-memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'https://github.com/jpolvora/spec-memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'https://github.com/jpolvora/spec-memo',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'https://user:token@github.com/jpolvora/spec-memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'ssh://git@gitlab.com/org/repo.git',
        expected: 'gitlab.com/org/repo'
      },
      {
        input: 'git+https://github.com/org/repo.git',
        expected: 'github.com/org/repo'
      },
      {
        input: 'https://GitHub.com/JPolvora/Spec-Memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      }
    ];

    for (const { input, expected } of cases) {
      assert.equal(normalizeGitRemote(input), expected, `Failed for input: ${input}`);
    }
  });

  it('should generate a filesystem-safe project ID from normalized remote', () => {
    const normalized = 'github.com/jpolvora/spec-memo';
    const projectId = generateProjectIdFromRemote(normalized);
    assert.equal(projectId, 'github.com-jpolvora-spec-memo');
  });

  it('should generate deterministic fallback project ID from local path', () => {
    const testPath = path.resolve(os.tmpdir(), 'some-project');
    const id1 = generateProjectIdFromPath(testPath);
    const id2 = generateProjectIdFromPath(testPath);
    assert.equal(id1, id2);
    assert.ok(id1.startsWith('local-some-project-'));
  });

  it('should find git root when inside a subdirectory', () => {
    const currentRoot = findGitRoot(process.cwd());
    assert.ok(currentRoot);
    assert.ok(fs.existsSync(path.join(currentRoot, '.git')));
  });

  it('should resolve project identity for current repository with remote origin', () => {
    const identity = resolveProjectIdentity(process.cwd());
    assert.equal(identity.isGit, true);
    assert.equal(identity.isFallback, false);
    assert.equal(identity.normalizedRemote, 'github.com/jpolvora/spec-memo');
    assert.equal(identity.projectId, 'github.com-jpolvora-spec-memo');
    assert.ok(identity.vaultProjectPath.includes('github.com-jpolvora-spec-memo'));
  });

  it('should fallback to path identity for non-git directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-test-nongit-'));
    try {
      const identity = resolveProjectIdentity(tempDir);
      assert.equal(identity.isGit, false);
      assert.equal(identity.isFallback, true);
      assert.equal(identity.normalizedRemote, null);
      assert.ok(identity.projectId.startsWith('local-'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should ignore a client cwd that is not a path on this host', () => {
    const foreignCwd =
      process.platform === 'win32' ? '/home/lab/no-such-consumer' : 'L:\\source\\no-such-consumer';
    assert.equal(findGitRoot(foreignCwd), null);

    const identity = resolveProjectIdentity(foreignCwd);
    assert.ok(fs.existsSync(identity.rootPath), 'rootPath must exist on the MCP host');
    assert.equal(identity.rootPath, path.resolve(process.cwd()));
    assert.ok(
      !identity.rootPath.includes('no-such-consumer'),
      'must not nest a foreign client path under process.cwd()'
    );
  });

  it('should ignore vaultRoot git repository and not treat vault as product repository', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-test-vaultgit-'));
    const tempVault = path.join(tempDir, 'vault');
    fs.mkdirSync(path.join(tempVault, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tempVault, 'projects', 'p1'), { recursive: true });

    try {
      // findGitRoot from within vaultRoot should return null
      assert.equal(findGitRoot(tempVault, tempVault), null);
      assert.equal(findGitRoot(path.join(tempVault, 'projects', 'p1'), tempVault), null);

      // resolveProjectIdentity from within vaultRoot should reuse the project partition
      const identity = resolveProjectIdentity(path.join(tempVault, 'projects', 'p1'), { vaultRoot: tempVault });
      assert.equal(identity.isGit, false);
      assert.equal(identity.isFallback, true);
      assert.equal(identity.projectId, 'p1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
