import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  ensureVaultStructure,
  initVaultGit,
  commitVaultChange,
  resolveVaultGitAtomic,
  redactVaultGitRemoteUrl,
  flushVaultGit,
  flushScheduledVaultGit,
  withVaultLockSync,
  REQUIRED_VAULT_GITIGNORE
} from './vault.js';
import { upsertRecord, appendEvent, forgetRecord } from './store.js';
import { closeIndex } from './indexer.js';
import { startSessionRecord, endSessionRecord } from './prompt.js';
import { syncDual, flushOnShutdown } from './dual-sync.js';
import { runCli } from './cli.js';
import { runDoctor } from './doctor.js';
import { runStatusCheck, formatStatusDashboard } from './status-cmd.js';
import { readVaultGitState, redactVaultGitError } from './vault-git-state.js';

function gitLog(root: string): string {
  try {
    return execFileSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' });
  } catch {
    return '';
  }
}

function enableVaultGit(
  root: string,
  extra: Record<string, unknown> = {}
): void {
  const configPath = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.vaultGit = { enabled: true, ...extra };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

describe('vault-git-hybrid-sync', () => {
  let tempVault: string;
  let tempProject: string;

  let prevTimeout: string | undefined;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-vghs-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-vghs-proj-'));
    ensureVaultStructure(tempVault);
    prevTimeout = process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
    if (!process.env.SPEC_MEMO_SYNC_TIMEOUT_MS) {
      process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = '1500';
    }
  });

  afterEach(async () => {
    await flushScheduledVaultGit().catch(() => undefined);
    closeIndex();
    if (prevTimeout === undefined) delete process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
    else process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = prevTimeout;
    try {
      fs.rmSync(tempVault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may keep git.exe cwd lock on the temp vault
    }
    try {
      fs.rmSync(tempProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  it('AC1: omitted atomic defaults to false when vaultGit is enabled', () => {
    enableVaultGit(tempVault);
    const config = JSON.parse(fs.readFileSync(path.join(tempVault, 'config.json'), 'utf8'));
    assert.equal(resolveVaultGitAtomic(config), false);
  });

  it('AC2: autoCommit aliases atomic when atomic is omitted', () => {
    enableVaultGit(tempVault, { autoCommit: true });
    const config = JSON.parse(fs.readFileSync(path.join(tempVault, 'config.json'), 'utf8'));
    assert.equal(resolveVaultGitAtomic(config), true);
  });

  it('AC2: atomic wins over autoCommit', () => {
    enableVaultGit(tempVault, { autoCommit: true, atomic: false });
    const config = JSON.parse(fs.readFileSync(path.join(tempVault, 'config.json'), 'utf8'));
    assert.equal(resolveVaultGitAtomic(config), false);
  });

  it('AC4: invalid atomic string does not crash upsert', async () => {
    enableVaultGit(tempVault);
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.vaultGit.atomic = 'yes';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'invalid-atomic',
      body: 'hello'
    });
    assert.ok(res.id);
    assert.equal(gitLog(tempVault).includes('upsert'), false);
  });

  it('AC5: batched upsert creates no git commit', async () => {
    enableVaultGit(tempVault);
    assert.equal(initVaultGit(tempVault), true);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'batched-no-commit',
      frontmatter: { title: 'Batched', pathPatterns: ['src/**'] },
      body: '### Repeat\n- **DO NOT**: x\n- **INSTEAD DO**: y\n'
    });
    assert.equal(gitLog(tempVault).includes('upsert trap:'), false);
  });

  it('AC11: atomic upsert creates a structured git commit', async () => {
    enableVaultGit(tempVault, { atomic: true });
    assert.equal(initVaultGit(tempVault), true);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'atomic-commit',
      frontmatter: { title: 'Atomic', pathPatterns: ['src/**'] },
      body: '### Repeat\n- **DO NOT**: x\n- **INSTEAD DO**: y\n'
    });
    assert.match(gitLog(tempVault), /upsert trap:/);
  });

  it('AC12: git remote failure does not throw from atomic upsert', async () => {
    enableVaultGit(tempVault, {
      atomic: true,
      remoteUrl: 'file:///no-such-spec-memo-vault.git'
    });
    initVaultGit(tempVault);
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'remote-fail',
      body: 'still written'
    });
    assert.ok(res.id);
    assert.ok(fs.existsSync(res.path));
  });

  it('AC31: initVaultGit appends required gitignore lines', () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    const gi = fs.readFileSync(path.join(tempVault, '.gitignore'), 'utf8');
    for (const line of REQUIRED_VAULT_GITIGNORE) {
      assert.ok(gi.includes(line), `missing ${line}`);
    }
  });

  it('AC33: remote mode skips vault git init', () => {
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mode = 'remote';
    config.remote = { url: 'http://127.0.0.1:9' };
    config.vaultGit = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    assert.equal(initVaultGit(tempVault), false);
    assert.equal(fs.existsSync(path.join(tempVault, '.git')), false);
  });

  it('AC9: empty flush skips empty commit', async () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    commitVaultChange('seed', tempVault, [], { force: true, skipRemote: true });
    const before = gitLog(tempVault);
    const flush = await flushVaultGit(tempVault, { trigger: 'sync' });
    assert.equal(flush.committed, false);
    assert.equal(gitLog(tempVault), before);
  });

  it('AC21: dry-run flush does not commit', async () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'dry-run-flush',
      body: 'dirty'
    });
    const flush = await flushVaultGit(tempVault, { dryRun: true, trigger: 'sync' });
    assert.equal(flush.committed, false);
    assert.ok((flush.wouldCommit || []).length > 0);
    assert.equal(gitLog(tempVault), '');
  });

  it('AC21: dual-mode syncDual dry-run reports both channels without commit', async () => {
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mode = 'hybrid';
    config.remote = { url: 'http://127.0.0.1:1' };
    config.vaultGit = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    initVaultGit(tempVault);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'dual-dry-run',
      body: 'dual dry'
    });
    const report = await syncDual({
      vaultRoot: tempVault,
      trigger: 'sync',
      dryRun: true
    });
    assert.ok(report.hybrid);
    assert.ok(report.vaultGit);
    assert.equal(report.vaultGit?.committed, false);
    assert.ok((report.vaultGit?.wouldCommit || []).length > 0);
    assert.equal(gitLog(tempVault), '');
  });

  it('AC23: session_end flush commits batched dirty tree', async () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    const start = await startSessionRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      sessionId: 's-flush'
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'session-dirty',
      body: 'pending commit'
    });
    assert.equal(gitLog(tempVault), '');
    const end = await endSessionRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      sessionId: start.sessionId
    });
    assert.equal(end.status, 'completed');
    assert.match(gitLog(tempVault), /vault-git flush/);
  });

  it('AC39: batched append and forget create no git commit', async () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    await appendEvent({
      cwd: tempProject,
      vaultRoot: tempVault,
      event: 'hello log'
    });
    const created = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'to-forget',
      body: 'gone'
    });
    await forgetRecord({ cwd: tempProject, vaultRoot: tempVault, id: created.id });
    assert.equal(gitLog(tempVault).includes('append'), false);
    assert.equal(gitLog(tempVault).includes('forget'), false);
  });

  it('AC17: dual sync still commits vault-git when hybrid fails', async () => {
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mode = 'hybrid';
    config.remote = { url: 'http://127.0.0.1:1' };
    config.vaultGit = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    initVaultGit(tempVault);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'dual-dirty',
      body: 'needs flush'
    });
    const report = await syncDual({
      vaultRoot: tempVault,
      trigger: 'sync',
      projectId: 'x'
    });
    assert.ok(report.hybrid);
    assert.equal(report.hybrid?.ok, false);
    assert.ok(report.vaultGit);
    assert.equal(report.vaultGit?.committed, true);
    assert.match(gitLog(tempVault), /vault-git flush/);
  });

  it('AC19: memo sync --json includes both channels when dual-mode', async () => {
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mode = 'hybrid';
    config.remote = { url: 'http://127.0.0.1:1' };
    config.vaultGit = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    initVaultGit(tempVault);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'cli-dual',
      body: 'cli dual'
    });
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured += args.map(String).join(' ') + '\n';
    };
    try {
      const code = await runCli(['sync', '--json', '--vaultRoot', tempVault, '--cwd', tempProject]);
      assert.ok(code === 0 || code === 1);
      const parsed = JSON.parse(captured.trim());
      assert.ok(parsed.hybrid);
      assert.ok(parsed.vaultGit);
      assert.equal(parsed.trigger, 'sync');
    } finally {
      console.log = origLog;
    }
  });

  it('AC20: vault lock is not held across async git remote I/O', async () => {
    enableVaultGit(tempVault, { remoteUrl: 'file:///no-such-spec-memo-vault.git' });
    initVaultGit(tempVault);
    commitVaultChange('seed', tempVault, [], { force: true, skipRemote: true });
    let lockMs = 0;
    const started = Date.now();
    const lockP = new Promise<void>((resolve) => {
      setImmediate(() => {
        withVaultLockSync(tempVault, () => {
          lockMs = Date.now() - started;
        });
        resolve();
      });
    });
    await Promise.all([flushVaultGit(tempVault, { trigger: 'sync' }), lockP]);
    assert.ok(lockMs >= 0 && lockMs < 800, `lock wait ${lockMs}ms`);
  });

  it('AC34: status reports Enabled (batched) and redacts userinfo', async () => {
    enableVaultGit(tempVault, { remoteUrl: 'http://user:secret@example.com/vault.git' });
    const status = await runStatusCheck({ vaultRoot: tempVault, cwd: tempProject });
    assert.equal(status.operational.vaultGit.enabled, true);
    assert.equal(status.operational.vaultGit.atomic, false);
    assert.equal(status.operational.vaultGit.remoteUrl?.includes('secret'), false);
    const dash = formatStatusDashboard(status);
    assert.match(dash, /Enabled \(batched\)/);
  });

  it('AC35: doctor json includes vault-git without secret', async () => {
    enableVaultGit(tempVault, { remoteUrl: 'http://user:secret@example.com/vault.git' });
    const doc = await runDoctor({ vaultRoot: tempVault, cwd: tempProject });
    assert.equal(doc.vaultGit?.enabled, true);
    assert.equal(doc.vaultGit?.atomic, false);
    assert.equal((doc.vaultGit?.remoteUrl || '').includes('secret'), false);
  });

  it('AC29: failed remote flush marks vault-git-state dirty', async () => {
    enableVaultGit(tempVault, { remoteUrl: 'file:///no-such-spec-memo-vault.git' });
    initVaultGit(tempVault);
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'scratch',
      slug: 'dirty-state',
      body: 'x'
    });
    await flushVaultGit(tempVault, { trigger: 'sync' });
    const state = readVaultGitState(tempVault);
    assert.equal(state.dirty, true);
    assert.ok(state.lastError);
  });

  it('AC45 helper: redactVaultGitRemoteUrl strips user:pass', () => {
    assert.equal(
      redactVaultGitRemoteUrl('http://alice:pw@host/repo.git'),
      'http://***:***@host/repo.git'
    );
  });

  it('AC24: flushOnShutdown is no-op in default local mode', async () => {
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.mode = 'local';
    delete config.vaultGit;
    delete config.remote;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    await flushOnShutdown(tempVault);
  });

  it('AC24: flushOnShutdown completes within shutdown cap (SPEC_MEMO_SYNC_TIMEOUT_MS)', async () => {
    const prev = process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
    process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = '150';
    try {
      enableVaultGit(tempVault, { remoteUrl: 'http://127.0.0.1:9/unreachable.git' });
      const configPath = path.join(tempVault, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config.mode = 'hybrid';
      config.remote = { url: 'http://127.0.0.1:9' };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      initVaultGit(tempVault);
      const started = Date.now();
      await flushOnShutdown(tempVault);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `shutdown flush took ${elapsed}ms`);
    } finally {
      if (prev === undefined) delete process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
      else process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = prev;
    }
  });

  it('AC44: git status failure does not treat vault as clean', async () => {
    enableVaultGit(tempVault);
    initVaultGit(tempVault);
    const gitDir = path.join(tempVault, '.git');
    fs.rmSync(gitDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(tempVault, '.git'), 'corrupt-not-a-repo');
    const result = await flushVaultGit(tempVault, { trigger: 'sync' });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });

  it('lastError redacts user:pass embedded in git failure messages', async () => {
    enableVaultGit(tempVault, { remoteUrl: 'http://alice:secret@example.com/vault.git' });
    initVaultGit(tempVault);
    const result = await flushVaultGit(tempVault, { trigger: 'sync' });
    if (result.error) {
      assert.equal(result.error.includes('secret'), false);
      assert.equal(result.error.includes('alice'), false);
    }
    const state = readVaultGitState(tempVault);
    if (state.lastError) {
      assert.equal(state.lastError.includes('secret'), false);
      assert.equal(state.lastError.includes('alice'), false);
    }
    assert.equal(
      redactVaultGitError('fatal: http://bob:token@host/repo.git denied'),
      'fatal: http://***:***@host/repo.git denied'
    );
  });
});
