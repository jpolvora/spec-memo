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
  resolveProjectIdentity,
  getGitRemoteUrl
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
        input: 'https://github.com/jpolvora/spec-memo/',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'https://github.com/jpolvora/spec-memo.git/',
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
      },
      {
        input: 'git@github.com:JPolvora/Spec-Memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'ssh://git@ssh.github.com:443/jpolvora/spec-memo.git',
        expected: 'github.com/jpolvora/spec-memo'
      },
      {
        input: 'ssh://git@altssh.bitbucket.org:443/org/repo.git',
        expected: 'bitbucket.org/org/repo'
      },
      // Azure DevOps diverse formats
      {
        input: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'https://user@dev.azure.com/myorg/myproject/_git/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'https://myorg.visualstudio.com/myproject/_git/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'https://myorg.visualstudio.com/DefaultCollection/myproject/_git/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'git@ssh.dev.azure.com:v3/myorg/myproject/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'ssh://git@ssh.dev.azure.com:v3/myorg/myproject/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      {
        input: 'myorg@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo',
        expected: 'dev.azure.com/myorg/myproject/myrepo'
      },
      // AWS CodeCommit
      {
        input: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/myrepo',
        expected: 'git-codecommit.us-east-1.amazonaws.com/repos/myrepo'
      },
      {
        input: 'ssh://APKAEI123@git-codecommit.us-east-1.amazonaws.com/v1/repos/myrepo',
        expected: 'git-codecommit.us-east-1.amazonaws.com/repos/myrepo'
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

  it('should fall back to upstream or first available remote when origin is absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-test-upstream-'));
    const gitDir = path.join(tempDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    // Write git config with upstream and custom remote, but no origin
    const gitConfig = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[remote "upstream"]
\turl = https://github.com/upstream-org/upstream-repo.git
\tfetch = +refs/heads/*:refs/remotes/upstream/*
`;
    fs.writeFileSync(path.join(gitDir, 'config'), gitConfig, 'utf8');

    try {
      const identity = resolveProjectIdentity(tempDir);
      assert.equal(identity.isGit, true);
      assert.equal(identity.isFallback, false);
      assert.equal(identity.normalizedRemote, 'github.com/upstream-org/upstream-repo');
      assert.equal(identity.projectId, 'github.com-upstream-org-upstream-repo');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve remote URL from Git worktree via commondir', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-test-worktree-'));
    const mainRepo = path.join(tempDir, 'main-repo');
    const mainGit = path.join(mainRepo, '.git');
    const worktreeDir = path.join(tempDir, 'worktree-1');
    const worktreeGitDir = path.join(mainGit, 'worktrees', 'worktree-1');

    fs.mkdirSync(mainGit, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });

    // Main repo config
    fs.writeFileSync(
      path.join(mainGit, 'config'),
      `[remote "origin"]\n\turl = git@github.com:myorg/myrepo.git\n`,
      'utf8'
    );

    // Worktree pointer (.git file pointing to worktrees/worktree-1)
    fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8');
    // Worktree commondir pointing to main .git
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), `../..\n`, 'utf8');

    try {
      const identity = resolveProjectIdentity(worktreeDir);
      assert.equal(identity.isGit, true);
      assert.equal(identity.isFallback, false);
      assert.equal(identity.normalizedRemote, 'github.com/myorg/myrepo');
      assert.equal(identity.projectId, 'github.com-myorg-myrepo');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should resolve upstream remote URL for local clones of clones', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-test-local-clone-'));
    const parentRepo = path.join(tempDir, 'parent-repo');
    const cloneRepo = path.join(tempDir, 'clone-repo');

    fs.mkdirSync(path.join(parentRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(cloneRepo, '.git'), { recursive: true });

    // Parent repo cloned from GitHub
    fs.writeFileSync(
      path.join(parentRepo, '.git', 'config'),
      `[remote "origin"]\n\turl = https://github.com/shared-org/shared-repo.git\n`,
      'utf8'
    );

    // Clone repo cloned locally from parentRepo
    fs.writeFileSync(
      path.join(cloneRepo, '.git', 'config'),
      `[remote "origin"]\n\turl = ${parentRepo}\n`,
      'utf8'
    );

    try {
      const parentIdentity = resolveProjectIdentity(parentRepo);
      const cloneIdentity = resolveProjectIdentity(cloneRepo);

      assert.equal(parentIdentity.projectId, 'github.com-shared-org-shared-repo');
      assert.equal(cloneIdentity.projectId, 'github.com-shared-org-shared-repo');
      assert.equal(parentIdentity.projectId, cloneIdentity.projectId);
      assert.equal(parentIdentity.normalizedRemote, cloneIdentity.normalizedRemote);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
