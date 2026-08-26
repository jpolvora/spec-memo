import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ensureVaultStructure, ensureProjectVault, getVaultRoot, withVaultLockSync } from './vault.js';
import { closeIndex, rebuildIndex } from './indexer.js';
import { normalizeRemoteUrl, generateHostMcpSnippet, runSetup, SUPPORTED_HOSTS } from './setup.js';
import { readHybridState, writeHybridState } from './hybrid-state.js';
import { runDoctor } from './doctor.js';
import { startSseServer } from './server.js';
import {
  syncHybrid,
  pullHybridProject,
  pushHybridProject,
  scheduleHybridPush,
  clearDebouncedPushes,
  flushDebouncedPushes
} from './hybrid-sync.js';
import { callRemoteTool, createRemoteClient } from './mcp-proxy.js';
import { runCli } from './cli.js';
import { upsertRecord } from './store.js';
import { exportChangeset } from './sync.js';
import { resolveProjectIdentity } from './identity.js';
import { executeTool } from './tools.js';

test('Deployment Modes & Portable MCP Wiring (Phase 1, 2, 3)', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-modes-test-'));
  const vaultRoot = path.join(tempDir, 'vault');
  const projectId = 'modes-test-proj';
  const allVaultRoots = new Set<string>([vaultRoot]);

  function trackVault(v: string): string {
    allVaultRoots.add(v);
    return v;
  }

  t.after(() => {
    clearDebouncedPushes();
    for (const root of allVaultRoots) {
      try {
        closeIndex(root);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  ensureProjectVault(
    {
      projectId,
      normalizedRemote: null,
      rootPath: tempDir,
      isGit: false,
      isFallback: true,
      vaultProjectPath: path.join(vaultRoot, 'projects', projectId)
    },
    vaultRoot
  );

  // -------------------------------------------------------------
  // Phase 1: Config, Setup, Doctor, Portable MCP
  // -------------------------------------------------------------
  await t.test('Phase 1: Config schema defaults mode to local when omitted', () => {
    const config = ensureVaultStructure(vaultRoot);
    assert.strictEqual(config.mode, undefined); // Omitted means local
    assert.ok(config.ttl);
    assert.ok(config.bootstrap);
  });

  await t.test('Phase 1: URL normalization strips /sse, /message, trailing slashes, queries', () => {
    assert.strictEqual(normalizeRemoteUrl('http://127.0.0.1:3000/sse'), 'http://127.0.0.1:3000');
    assert.strictEqual(normalizeRemoteUrl('http://localhost:3000/message?token=abc'), 'http://localhost:3000');
    assert.strictEqual(normalizeRemoteUrl('https://my-host.org:8443///'), 'https://my-host.org:8443');
    assert.throws(() => normalizeRemoteUrl('ftp://invalid.com'), /only http:\/\/ and https:\/\//);
    assert.throws(() => normalizeRemoteUrl(''), /non-empty/);
  });

  await t.test('Phase 1: Setup preserves existing config blocks when merging', () => {
    const customVault = trackVault(path.join(tempDir, 'custom-vault'));
    ensureVaultStructure(customVault);
    const configPath = path.join(customVault, 'config.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.ttl.scratchDays = 99;
    existing.vaultGit = { enabled: true, remoteUrl: 'git@github.com:user/vault.git' };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf8');

    const result = runSetup({
      vaultRoot: customVault,
      mode: 'local'
    });

    assert.strictEqual(result.mode, 'local');
    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(updated.ttl.scratchDays, 99);
    assert.strictEqual(updated.vaultGit.enabled, true);
    closeIndex(customVault);
  });

  await t.test('Phase 1: Setup requires URL in hybrid/remote mode and checks env token', () => {
    const testVault = trackVault(path.join(tempDir, 'vault-token-test'));
    ensureVaultStructure(testVault);

    // Missing URL
    assert.throws(() => {
      runSetup({ vaultRoot: testVault, mode: 'hybrid' });
    }, /Remote URL \(--url\) is required/);

    // Missing Token (URL is saved before error thrown per AC5)
    const prevAuth = process.env.SPEC_MEMO_AUTH_TOKEN;
    const prevSse = process.env.SPEC_MEMO_SSE_TOKEN;
    delete process.env.SPEC_MEMO_AUTH_TOKEN;
    delete process.env.SPEC_MEMO_SSE_TOKEN;

    try {
      assert.throws(() => {
        runSetup({ vaultRoot: testVault, mode: 'hybrid', url: 'http://127.0.0.1:3000/sse' });
      }, /Bearer token not found in environment/);

      const cfg = JSON.parse(fs.readFileSync(path.join(testVault, 'config.json'), 'utf8'));
      assert.strictEqual(cfg.mode, 'hybrid');
      assert.strictEqual(cfg.remote.url, 'http://127.0.0.1:3000');
    } finally {
      if (prevAuth) process.env.SPEC_MEMO_AUTH_TOKEN = prevAuth;
      if (prevSse) process.env.SPEC_MEMO_SSE_TOKEN = prevSse;
      closeIndex(testVault);
    }
  });

  await t.test('Phase 1: Setup generates stdio MCP snippets for all supported hosts', () => {
    for (const host of SUPPORTED_HOSTS) {
      const snippet = generateHostMcpSnippet(host);
      assert.ok(snippet, `Snippet for ${host} must be defined`);
      const str = JSON.stringify(snippet);
      assert.ok(str.includes('memo') && str.includes('serve'), `Snippet for ${host} must run memo serve`);
    }
  });

  await t.test('Phase 1: Doctor reports mode, remote URL, token status, and hybrid state', async () => {
    const docVault = trackVault(path.join(tempDir, 'vault-doc-test'));
    ensureProjectVault(
      {
        projectId: 'doc-proj',
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(docVault, 'projects', 'doc-proj')
      },
      docVault
    );
    await rebuildIndex(docVault);
    writeHybridState(docVault, { dirty: true, lastSyncAt: '2026-08-26T12:00:00.000Z', lastError: null });

    const configPath = path.join(docVault, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.mode = 'hybrid';
    cfg.remote = { url: 'http://127.0.0.1:3000' };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const result = await runDoctor({ vaultRoot: docVault, cwd: tempDir });
    assert.strictEqual(result.mode, 'hybrid');
    assert.strictEqual(result.remoteUrl, 'http://127.0.0.1:3000');
    assert.ok(result.hybridState);
    assert.strictEqual(result.hybridState.dirty, true);
    // Remote daemon not running -> warning in hybrid mode, but local vault remains operational
    assert.strictEqual(result.healthy, true);
    assert.ok(result.warnings.some((w) => w.includes('Remote daemon unreachable')));

    closeIndex(docVault);
  });

  // -------------------------------------------------------------
  // Phase 2: Daemon HTTP Sync, Hybrid Pull/Push, Debounce
  // -------------------------------------------------------------
  await t.test('Phase 2: Daemon exposes authenticated HTTP sync endpoints', async () => {
    const daemonVault = trackVault(path.join(tempDir, 'daemon-vault'));
    const clientVault = trackVault(path.join(tempDir, 'client-vault'));
    const authToken = 'test-secret-token-123';

    ensureProjectVault(
      {
        projectId: 'sync-proj',
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(daemonVault, 'projects', 'sync-proj')
      },
      daemonVault
    );

    ensureProjectVault(
      {
        projectId: 'sync-proj',
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(clientVault, 'projects', 'sync-proj')
      },
      clientVault
    );

    // Create a record in daemon
    await upsertRecord({
      vaultRoot: daemonVault,
      projectId: 'sync-proj',
      kind: 'trap',
      slug: 'daemon-trap-1',
      body: 'Trap from daemon',
      frontmatter: { title: 'Daemon Trap 1', severity: 'high' }
    });

    const daemonServer = await startSseServer({
      vaultRoot: daemonVault,
      port: 0,
      host: '127.0.0.1',
      authToken,
      enableStatus: false
    });

    const clientCfgPath = path.join(clientVault, 'config.json');
    const clientCfg = JSON.parse(fs.readFileSync(clientCfgPath, 'utf8'));
    clientCfg.mode = 'hybrid';
    clientCfg.remote = { url: daemonServer.url };
    fs.writeFileSync(clientCfgPath, JSON.stringify(clientCfg, null, 2), 'utf8');

    try {
      // 1. Unauthorized request without token fails (401)
      const unauthPull = await fetch(`${daemonServer.url}/api/sync/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'sync-proj' })
      });
      assert.strictEqual(unauthPull.status, 401);

      // 2. Authorized pull downloads records
      const pullResult = await pullHybridProject(clientVault, 'sync-proj', daemonServer.url, authToken);
      assert.strictEqual(pullResult.applied, 1);

      // Verify record exists in client
      const clientTrapPath = path.join(clientVault, 'projects', 'sync-proj', 'traps', 'daemon-trap-1.md');
      assert.ok(fs.existsSync(clientTrapPath));

      // 3. Client creates local record and pushes
      await upsertRecord({
        vaultRoot: clientVault,
        projectId: 'sync-proj',
        kind: 'decision',
        slug: 'client-decision-1',
        body: 'Decision from client',
        frontmatter: { title: 'Client Decision 1' }
      });

      const pushResult = await pushHybridProject(clientVault, 'sync-proj', daemonServer.url, authToken);
      assert.strictEqual(pushResult.applied, 1);

      // Verify record exists in daemon
      const daemonDecisionPath = path.join(
        daemonVault,
        'projects',
        'sync-proj',
        'decisions',
        'client-decision-1.md'
      );
      assert.ok(fs.existsSync(daemonDecisionPath));

      // 4. Two-way syncHybrid works
      const syncReport = await syncHybrid({
        vaultRoot: clientVault,
        projectId: 'sync-proj',
        remoteUrl: daemonServer.url,
        authToken
      });
      assert.strictEqual(syncReport.all, false);
      assert.ok(syncReport.pulled);
      assert.ok(syncReport.pushed);
    } finally {
      await daemonServer.close();
      closeIndex(daemonVault);
      closeIndex(clientVault);
    }
  });

  await t.test('Phase 2: hybrid push dry-run does not apply on daemon (AC21)', async () => {
    const daemonVault = trackVault(path.join(tempDir, 'dryrun-daemon-vault'));
    const clientVault = trackVault(path.join(tempDir, 'dryrun-client-vault'));
    const authToken = 'dryrun-token';
    const pid = 'dryrun-proj';

    ensureProjectVault(
      {
        projectId: pid,
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(daemonVault, 'projects', pid)
      },
      daemonVault
    );
    ensureProjectVault(
      {
        projectId: pid,
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(clientVault, 'projects', pid)
      },
      clientVault
    );

    const daemonServer = await startSseServer({
      vaultRoot: daemonVault,
      port: 0,
      host: '127.0.0.1',
      authToken,
      enableStatus: false
    });

    const clientCfgPath = path.join(clientVault, 'config.json');
    const clientCfg = JSON.parse(fs.readFileSync(clientCfgPath, 'utf8'));
    clientCfg.mode = 'hybrid';
    clientCfg.remote = { url: daemonServer.url };
    fs.writeFileSync(clientCfgPath, JSON.stringify(clientCfg, null, 2), 'utf8');

    await upsertRecord({
      vaultRoot: clientVault,
      projectId: pid,
      kind: 'trap',
      slug: 'dry-run-trap',
      body: 'should not land on daemon',
      frontmatter: { title: 'Dry Run Trap' }
    });

    const trapsDir = path.join(daemonVault, 'projects', pid, 'traps');
    const before = fs.existsSync(trapsDir) ? fs.readdirSync(trapsDir).sort() : [];

    try {
      const report = await syncHybrid({
        vaultRoot: clientVault,
        projectId: pid,
        remoteUrl: daemonServer.url,
        authToken,
        dryRun: true
      });
      assert.strictEqual(report.pushed.dryRun, true);
      const after = fs.existsSync(trapsDir) ? fs.readdirSync(trapsDir).sort() : [];
      assert.deepStrictEqual(after, before);
      assert.ok(!fs.existsSync(path.join(trapsDir, 'dry-run-trap.md')));

      const changeset = exportChangeset(clientVault, { projectId: pid });
      const twoWay = await fetch(`${daemonServer.url}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({ push: { changeset, dryRun: true } })
      });
      assert.strictEqual(twoWay.status, 200);
      const twoWayJson = (await twoWay.json()) as { applied: { dryRun: boolean } };
      assert.strictEqual(twoWayJson.applied.dryRun, true);
      assert.ok(!fs.existsSync(path.join(trapsDir, 'dry-run-trap.md')));
    } finally {
      await daemonServer.close();
      closeIndex(daemonVault);
      closeIndex(clientVault);
    }
  });

  await t.test('Phase 2: debounced push is scoped to cwd project (AC18/AC25)', async () => {
    const daemonVault = trackVault(path.join(tempDir, 'scope-daemon-vault'));
    const clientVault = trackVault(path.join(tempDir, 'scope-client-vault'));
    const authToken = 'scope-token';
    const cwdA = path.join(tempDir, 'repo-a');
    const cwdB = path.join(tempDir, 'repo-b');
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });

    const idA = resolveProjectIdentity(cwdA, { vaultRoot: clientVault }).projectId;
    const idB = resolveProjectIdentity(cwdB, { vaultRoot: clientVault }).projectId;
    assert.notStrictEqual(idA, idB);

    for (const [id, cwd] of [
      [idA, cwdA],
      [idB, cwdB]
    ] as const) {
      ensureProjectVault(
        {
          projectId: id,
          normalizedRemote: null,
          rootPath: cwd,
          isGit: false,
          isFallback: true,
          vaultProjectPath: path.join(clientVault, 'projects', id)
        },
        clientVault
      );
      ensureProjectVault(
        {
          projectId: id,
          normalizedRemote: null,
          rootPath: cwd,
          isGit: false,
          isFallback: true,
          vaultProjectPath: path.join(daemonVault, 'projects', id)
        },
        daemonVault
      );
    }

    await upsertRecord({
      vaultRoot: clientVault,
      projectId: idB,
      kind: 'trap',
      slug: 'b-only-trap',
      body: 'B only',
      frontmatter: { title: 'B Only' }
    });

    const daemonServer = await startSseServer({
      vaultRoot: daemonVault,
      port: 0,
      host: '127.0.0.1',
      authToken,
      enableStatus: false
    });

    const clientCfgPath = path.join(clientVault, 'config.json');
    const clientCfg = JSON.parse(fs.readFileSync(clientCfgPath, 'utf8'));
    clientCfg.mode = 'hybrid';
    clientCfg.remote = { url: daemonServer.url };
    fs.writeFileSync(clientCfgPath, JSON.stringify(clientCfg, null, 2), 'utf8');

    const prevAuth = process.env.SPEC_MEMO_AUTH_TOKEN;
    process.env.SPEC_MEMO_AUTH_TOKEN = authToken;

    try {
      const upsertRes = await executeTool('upsert', {
        kind: 'trap',
        slug: 'a-only-trap',
        body: 'A only',
        frontmatter: { title: 'A Only' },
        cwd: cwdA,
        vaultRoot: clientVault
      });
      assert.strictEqual(upsertRes.isError, undefined);
      assert.ok(fs.existsSync(path.join(clientVault, 'projects', idA, 'traps', 'a-only-trap.md')));
      await flushDebouncedPushes();

      assert.ok(fs.existsSync(path.join(daemonVault, 'projects', idA, 'traps', 'a-only-trap.md')));
      assert.ok(!fs.existsSync(path.join(daemonVault, 'projects', idB, 'traps', 'b-only-trap.md')));
    } finally {
      if (prevAuth === undefined) {
        delete process.env.SPEC_MEMO_AUTH_TOKEN;
      } else {
        process.env.SPEC_MEMO_AUTH_TOKEN = prevAuth;
      }
      await daemonServer.close();
      closeIndex(daemonVault);
      closeIndex(clientVault);
    }
  });

  await t.test('Phase 2: debounced push single-flights per projectId', async () => {
    const clientVault = trackVault(path.join(tempDir, 'flight-client-vault'));
    ensureVaultStructure(clientVault);

    let inFlight = 0;
    let maxInFlight = 0;
    let pushCount = 0;

    const slow = http.createServer((req, res) => {
      if (req.method === 'POST' && (req.url || '').startsWith('/api/sync/push')) {
        req.resume();
        req.on('end', () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pushCount++;
          setTimeout(() => {
            inFlight--;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                applied: 0,
                skipped: 0,
                conflicts: 0,
                dryRun: false,
                recordsApplied: []
              })
            );
          }, 150);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      slow.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = slow.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;

    const cfgPath = path.join(clientVault, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.mode = 'hybrid';
    cfg.remote = { url };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    try {
      scheduleHybridPush(clientVault, 'flight-proj', 0);
      await new Promise((r) => setTimeout(r, 15));
      scheduleHybridPush(clientVault, 'flight-proj', 0);
      await new Promise((r) => setTimeout(r, 15));
      await flushDebouncedPushes();
      assert.strictEqual(maxInFlight, 1);
      assert.ok(pushCount >= 2);
    } finally {
      await new Promise<void>((r) => slow.close(() => r()));
      closeIndex(clientVault);
    }
  });

  await t.test('Phase 2: writeHybridState serializes via vault lock (AC23)', () => {
    const lockVault = trackVault(path.join(tempDir, 'hybrid-lock-vault'));
    ensureVaultStructure(lockVault);
    withVaultLockSync(lockVault, () => {
      writeHybridState(lockVault, { dirty: true });
      writeHybridState(lockVault, { lastError: 'nested' });
    });
    const state = readHybridState(lockVault);
    assert.strictEqual(state.dirty, true);
    assert.strictEqual(state.lastError, 'nested');
    closeIndex(lockVault);
  });

  // -------------------------------------------------------------
  // Phase 3: Remote stdio MCP Proxy & Remote CLI Extras Refusal
  // -------------------------------------------------------------
  await t.test('Phase 3: Remote proxy tool execution parity & CLI extras refusal', async () => {
    const daemonVault = trackVault(path.join(tempDir, 'daemon-remote-vault'));
    const remoteClientVault = trackVault(path.join(tempDir, 'remote-client-vault'));
    const authToken = 'remote-token-456';

    ensureProjectVault(
      {
        projectId: 'remote-proj',
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(daemonVault, 'projects', 'remote-proj')
      },
      daemonVault
    );

    ensureVaultStructure(remoteClientVault);
    const clientCfgPath = path.join(remoteClientVault, 'config.json');

    const daemonServer = await startSseServer({
      vaultRoot: daemonVault,
      port: 0,
      host: '127.0.0.1',
      authToken,
      enableStatus: false
    });

    fs.writeFileSync(
      clientCfgPath,
      JSON.stringify(
        {
          version: '0.4.0',
          defaultRemote: 'origin',
          mode: 'remote',
          remote: { url: daemonServer.url },
          ttl: { scratchDays: 7, reviewDays: 14 },
          bootstrap: { maxBytes: 8192, maxTraps: 10 }
        },
        null,
        2
      ),
      'utf8'
    );

    try {
      // 1. Call upsert through remote proxy helper
      const upsertRes = await callRemoteTool(
        'upsert',
        {
          kind: 'trap',
          slug: 'remote-proxied-trap',
          body: 'Trap created via remote proxy',
          frontmatter: { title: 'Remote Proxied Trap', severity: 'critical' },
          projectId: 'remote-proj'
        },
        { vaultRoot: remoteClientVault, authToken }
      );

      assert.strictEqual(upsertRes.isError, false);
      const daemonTrap = path.join(
        daemonVault,
        'projects',
        'remote-proj',
        'traps',
        'remote-proxied-trap.md'
      );
      assert.ok(fs.existsSync(daemonTrap), 'Record must exist on daemon vault');

      // Local client projects dir must remain untouched (AC26)
      const localProjectTrap = path.join(
        remoteClientVault,
        'projects',
        'remote-proj',
        'traps',
        'remote-proxied-trap.md'
      );
      assert.strictEqual(fs.existsSync(localProjectTrap), false, 'Record must NOT exist on local vault in remote mode');

      // 2. Call search through remote proxy
      const searchRes = await callRemoteTool(
        'search',
        {
          query: 'proxied',
          projectId: 'remote-proj'
        },
        { vaultRoot: remoteClientVault, authToken }
      );

      assert.strictEqual(searchRes.isError, false);
      assert.ok(Array.isArray(searchRes.data));
      assert.strictEqual((searchRes.data as any[]).length, 1);

      // 3. CLI extras refusal in remote mode (AC29)
      const exitCanvas = await runCli(['canvas', '--vaultRoot', remoteClientVault]);
      assert.strictEqual(exitCanvas, 1);

      const exitSyncVault = await runCli(['sync-vault', '/tmp/target', '--vaultRoot', remoteClientVault]);
      assert.strictEqual(exitSyncVault, 1);

      const exitExport = await runCli(['export-vault', '--vaultRoot', remoteClientVault]);
      assert.strictEqual(exitExport, 1);

      // 4. Remote mode doctor fails when daemon is stopped (AC12b)
      await daemonServer.close();

      const docRes = await runDoctor({ vaultRoot: remoteClientVault });
      assert.strictEqual(docRes.healthy, false);
      assert.ok(docRes.warnings.some((w) => w.includes('Remote daemon unreachable')));

      // 5. Remote mode fails closed on tool execution when daemon is down (AC30)
      const failClosedRes = await callRemoteTool(
        'upsert',
        {
          kind: 'trap',
          slug: 'fail-closed-trap',
          body: 'Should fail closed',
          projectId: 'remote-proj'
        },
        { vaultRoot: remoteClientVault, authToken }
      );
      assert.strictEqual(failClosedRes.isError, true);
      assert.strictEqual((failClosedRes as any).code, 'REMOTE_UNREACHABLE');
    } finally {
      await daemonServer.close().catch(() => {});
      closeIndex(daemonVault);
      closeIndex(remoteClientVault);
    }
  });

  await t.test('Phase 1 & 2: CLI setup and hybrid fail-open bootstrap', async () => {
    const cliVault = trackVault(path.join(tempDir, 'cli-vault-test'));
    ensureProjectVault(
      {
        projectId: 'cli-proj',
        normalizedRemote: null,
        rootPath: tempDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(cliVault, 'projects', 'cli-proj')
      },
      cliVault
    );
    await rebuildIndex(cliVault);

    // 1. CLI setup in local mode
    const exitSetup = await runCli(['setup', '--mode', 'local', '--vaultRoot', cliVault, '--print-mcp', '--host', 'cursor']);
    assert.strictEqual(exitSetup, 0);

    // 2. CLI sync fails in local mode without vaultGit
    const exitSync = await runCli(['sync', '--vaultRoot', cliVault]);
    assert.strictEqual(exitSync, 1);

    // 3. Configure hybrid with unreachable remote (using immediately closed server port for instant connection refusal)
    const dummyServer = await startSseServer({ vaultRoot: cliVault, port: 0, host: '127.0.0.1', enableStatus: false });
    const deadUrl = dummyServer.url;
    await dummyServer.close();

    const cfgPath = path.join(cliVault, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.mode = 'hybrid';
    cfg.remote = { url: deadUrl };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    // Create a local trap
    await upsertRecord({
      vaultRoot: cliVault,
      projectId: 'cli-proj',
      kind: 'trap',
      slug: 'local-trap-hybrid',
      body: 'Local trap body',
      frontmatter: { title: 'Local Trap Hybrid', severity: 'critical' }
    });

    // Run bootstrap in hybrid mode: must return local data and note sync notice (fail open)
    const { compileBootstrapBrief } = await import('./bootstrap.js');
    const brief = await compileBootstrapBrief({ vaultRoot: cliVault, projectId: 'cli-proj', cwd: tempDir });
    assert.strictEqual(brief.projectId, 'cli-proj');
    assert.strictEqual(brief.traps.length, 1);
    assert.ok(brief.traps[0].frontmatter.id.includes('local-trap-hybrid'));
    assert.ok(brief.notices.some((n) => n.includes('Hybrid sync pull notice')));

    // Hybrid state must be marked dirty
    const state = readHybridState(cliVault);
    assert.strictEqual(state.dirty, true);
    assert.ok(state.lastError);

    closeIndex(cliVault);
  });
});
