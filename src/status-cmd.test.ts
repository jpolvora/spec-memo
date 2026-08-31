import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  runStatusCheck,
  formatStatusDashboard,
  countProjectRecords,
  probeHttpService
} from './status-cmd.js';
import { ensureVaultStructure } from './vault.js';
import { upsertRecord } from './store.js';

describe('status-cmd & CLI memo status', () => {
  let tempDir: string;
  let vaultRoot: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-status-test-'));
    vaultRoot = path.join(tempDir, 'vault');
    repoDir = path.join(tempDir, 'repo');

    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize mock git repo
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], {
      cwd: repoDir,
      stdio: 'ignore'
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should run status check on clean local vault and report default configuration', async () => {
    ensureVaultStructure(vaultRoot);
    const configPath = path.join(vaultRoot, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0',
        mode: 'local',
        ports: { sse: 59123, status: 59124, canvas: 59125 }
      }),
      'utf8'
    );

    const result = await runStatusCheck({
      vaultRoot,
      cwd: repoDir
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'local');
    assert.strictEqual(result.role, 'local-vault');
    assert.strictEqual(result.vault.configValid, true);
    assert.strictEqual(result.daemons.sse.port, 59123);
    assert.strictEqual(result.daemons.status.port, 59124);
    assert.strictEqual(result.daemons.canvas.port, 59125);
    assert.strictEqual(result.daemons.sse.status, 'STOPPED');
    assert.strictEqual(result.daemons.status.status, 'STOPPED');
    assert.strictEqual(result.daemons.canvas.status, 'STOPPED');
    assert.strictEqual(result.daemons.remote.configured, false);
    assert.strictEqual(result.project?.projectId, 'github.com-acme-widgets');
    assert.strictEqual(result.project?.counts.total, 0);
  });

  it('should probe live running HTTP services and report status RUNNING', async () => {
    // Start a mock HTTP server
    const server = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const probe = await probeHttpService(`http://127.0.0.1:${port}/health`, 1000);
      assert.strictEqual(probe.running, true);
      assert.strictEqual(probe.statusCode, 200);
      assert.strictEqual(typeof probe.latencyMs, 'number');

      // Write port to config.json
      ensureVaultStructure(vaultRoot);
      const configPath = path.join(vaultRoot, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: '1.0',
          mode: 'local',
          ports: { sse: port }
        }),
        'utf8'
      );

      const status = await runStatusCheck({ vaultRoot, cwd: repoDir });
      assert.strictEqual(status.daemons.sse.port, port);
      assert.strictEqual(status.daemons.sse.status, 'RUNNING');
      assert.strictEqual(status.daemons.sse.statusCode, 200);
    } finally {
      server.close();
    }
  });

  it('should probe remote daemon when in hybrid/remote mode', async () => {
    const remoteServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.13.0' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', () => resolve()));
    const remotePort = (remoteServer.address() as { port: number }).port;
    const remoteUrl = `http://127.0.0.1:${remotePort}`;

    try {
      ensureVaultStructure(vaultRoot);
      const configPath = path.join(vaultRoot, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: '1.0',
          mode: 'hybrid',
          remote: { url: remoteUrl }
        }),
        'utf8'
      );

      const status = await runStatusCheck({ vaultRoot, cwd: repoDir });
      assert.strictEqual(status.mode, 'hybrid');
      assert.strictEqual(status.role, 'intermediary-proxy');
      assert.strictEqual(status.daemons.remote.configured, true);
      assert.strictEqual(status.daemons.remote.url, remoteUrl);
      assert.strictEqual(status.daemons.remote.status, 'REACHABLE');
      assert.strictEqual(status.daemons.remote.statusCode, 200);
      assert.strictEqual(status.ok, true);
    } finally {
      remoteServer.close();
    }
  });

  it('should report UNREACHABLE and issues when remote daemon is offline in hybrid/remote mode', async () => {
    ensureVaultStructure(vaultRoot);
    const configPath = path.join(vaultRoot, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0',
        mode: 'remote',
        remote: { url: 'http://127.0.0.1:59999' }
      }),
      'utf8'
    );

    const status = await runStatusCheck({ vaultRoot, cwd: repoDir, timeoutMs: 300 });
    assert.strictEqual(status.mode, 'remote');
    assert.strictEqual(status.daemons.remote.status, 'UNREACHABLE');
    assert.strictEqual(status.ok, false);
    assert.strictEqual(status.issues.length > 0, true);
  });

  it('should treat remote /health 401 as UNREACHABLE and fail health check', async () => {
    const remoteServer = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', () => resolve()));
    const remotePort = (remoteServer.address() as { port: number }).port;
    const remoteUrl = `http://127.0.0.1:${remotePort}`;

    try {
      ensureVaultStructure(vaultRoot);
      fs.writeFileSync(
        path.join(vaultRoot, 'config.json'),
        JSON.stringify({
          version: '1.0',
          mode: 'remote',
          remote: { url: remoteUrl }
        }),
        'utf8'
      );

      const status = await runStatusCheck({ vaultRoot, cwd: repoDir });
      assert.strictEqual(status.daemons.remote.status, 'UNREACHABLE');
      assert.strictEqual(status.daemons.remote.statusCode, 401);
      assert.strictEqual(status.ok, false);
      assert.strictEqual(status.issues.length > 0, true);
    } finally {
      remoteServer.close();
    }
  });

  it('should treat local 401/404 as RUNNING liveness but requireOk as not running', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const live = await probeHttpService(`http://127.0.0.1:${port}/health`, 1000);
      assert.strictEqual(live.running, true);
      assert.strictEqual(live.statusCode, 401);

      const strict = await probeHttpService(`http://127.0.0.1:${port}/health`, 1000, undefined, {
        requireOk: true
      });
      assert.strictEqual(strict.running, false);
      assert.strictEqual(strict.statusCode, 401);
    } finally {
      server.close();
    }
  });

  it('should accurately count records across kinds in project storage', () => {
    ensureVaultStructure(vaultRoot);

    upsertRecord({
      vaultRoot,
      cwd: repoDir,
      kind: 'trap',
      body: 'Trap body 1',
      frontmatter: { title: 'Trap 1', severity: 'high' }
    });

    upsertRecord({
      vaultRoot,
      cwd: repoDir,
      kind: 'decision',
      body: 'Decision body 1',
      frontmatter: { title: 'Decision 1' }
    });

    upsertRecord({
      vaultRoot,
      cwd: repoDir,
      kind: 'spec',
      body: 'Spec body 1',
      frontmatter: { title: 'Spec 1' }
    });

    const projectDir = path.join(vaultRoot, 'projects', 'github.com-acme-widgets');
    const counts = countProjectRecords(projectDir);

    assert.strictEqual(counts.traps, 1);
    assert.strictEqual(counts.decisions, 1);
    assert.strictEqual(counts.specs, 1);
    assert.strictEqual(counts.total, 3);
  });

  it('should handle malformed config.json gracefully without crashing', async () => {
    ensureVaultStructure(vaultRoot);
    const configPath = path.join(vaultRoot, 'config.json');
    fs.writeFileSync(configPath, '{ invalid JSON syntax', 'utf8');

    const status = await runStatusCheck({ vaultRoot, cwd: repoDir });
    assert.strictEqual(status.vault.configValid, false);
    assert.strictEqual(status.code, 'CONFIG_ERROR');
    assert.strictEqual(status.ok, false);
    assert.strictEqual(status.issues.length > 0, true);
    assert.strictEqual(status.issues[0].includes('Malformed config.json'), true);
  });

  it('AC10: memo status does not mutate an uninitialized vault root', async () => {
    const pristineRoot = path.join(tempDir, 'pristine-vault');
    fs.mkdirSync(pristineRoot, { recursive: true });
    const before = fs.readdirSync(pristineRoot);

    await runStatusCheck({ vaultRoot: pristineRoot, cwd: repoDir });

    const after = fs.readdirSync(pristineRoot);
    assert.deepStrictEqual(after.sort(), before.sort());
    assert.strictEqual(fs.existsSync(path.join(pristineRoot, 'config.json')), false);
    assert.strictEqual(fs.existsSync(path.join(pristineRoot, 'projects')), false);
    assert.strictEqual(fs.existsSync(path.join(pristineRoot, 'telemetry')), false);
  });

  it('AC10: memo status does not create a missing vault root', async () => {
    const missingRoot = path.join(tempDir, 'missing-vault');
    await runStatusCheck({ vaultRoot: missingRoot, cwd: repoDir });
    assert.strictEqual(fs.existsSync(missingRoot), false);
  });

  it('should format clean human-readable dashboard string', async () => {
    ensureVaultStructure(vaultRoot);
    const status = await runStatusCheck({ vaultRoot, cwd: repoDir });
    const formatted = formatStatusDashboard(status);

    assert.strictEqual(typeof formatted, 'string');
    assert.strictEqual(formatted.includes('spec-memo — Operational Status & Configuration'), true);
    assert.strictEqual(formatted.includes('Topology & Mode:'), true);
    assert.strictEqual(formatted.includes('Daemon Services (Configured Ports):'), true);
    assert.strictEqual(formatted.includes('Active Project Binding:'), true);
    assert.strictEqual(formatted.includes('Records Breakdown:'), true);
    assert.strictEqual(formatted.includes('reviews'), true);
    assert.strictEqual(formatted.includes('scratch'), true);
    assert.strictEqual(formatted.includes('Vault Storage & Backups:'), true);
  });

  it('should execute CLI status, info, state, and setup --check commands', () => {
    ensureVaultStructure(vaultRoot);
    const cliPath = path.resolve('dist/cli.js');

    // memo status --json
    const outStatus = execFileSync(process.execPath, [cliPath, 'status', '--json', '--vaultRoot', vaultRoot, '--cwd', repoDir], {
      encoding: 'utf8'
    });
    const parsedStatus = JSON.parse(outStatus);
    assert.strictEqual(parsedStatus.ok, true);
    assert.strictEqual(parsedStatus.mode, 'local');

    // memo info --json
    const outInfo = execFileSync(process.execPath, [cliPath, 'info', '--json', '--vaultRoot', vaultRoot, '--cwd', repoDir], {
      encoding: 'utf8'
    });
    const parsedInfo = JSON.parse(outInfo);
    assert.strictEqual(parsedInfo.mode, 'local');

    // memo setup --check --json
    const outSetupCheck = execFileSync(process.execPath, [cliPath, 'setup', '--check', '--json', '--vaultRoot', vaultRoot, '--cwd', repoDir], {
      encoding: 'utf8'
    });
    const parsedSetupCheck = JSON.parse(outSetupCheck);
    assert.strictEqual(parsedSetupCheck.ok, true);
  });
});
