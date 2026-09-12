import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMemoCommand,
  filterShutdownTargets,
  isCanvasCommand,
  isMemoServeCommand,
  resolveShutdownTimeoutMs,
  runShutdown,
  type MemoProcessInfo,
  type ShutdownSignalOps
} from './shutdown.js';
import { runCli } from './cli.js';

const SERVE_POSIX = 'node /opt/spec-memo/dist/cli.js serve --vaultRoot /home/dev/.spec-memo';
const SERVE_SSE = 'node /opt/spec-memo/dist/cli.js serve --sse --vaultRoot /home/dev/.spec-memo';
const SERVE_WIN =
  'node C:\\Users\\jpolv\\AppData\\Roaming\\npm\\node_modules\\spec-memo\\dist\\cli.js serve --vaultRoot C:\\Users\\jpolv\\.spec-memo';
const SERVE_MCP = 'node /opt/spec-memo/dist/mcp.js serve --vaultRoot /home/dev/.spec-memo';
const CANVAS = 'node /opt/spec-memo/dist/cli.js canvas --port 3125';
const NG_SERVE = 'node /usr/local/bin/ng serve --port 4200';
const YARN_DEV = 'yarn dev';
const YARN_TEST = 'yarn test --watch';

function stubOps(initialAlive: number[], ignoreTerm: number[] = []): {
  ops: ShutdownSignalOps;
  calls: string[];
} {
  const alive = new Set(initialAlive);
  const ignore = new Set(ignoreTerm);
  const calls: string[] = [];
  return {
    calls,
    ops: {
      kill: (pid: number, signal: NodeJS.Signals): void => {
        calls.push(`kill ${pid} ${signal}`);
        if (!alive.has(pid)) {
          const err = new Error(`kill ESRCH`) as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        if (signal === 'SIGKILL' || !ignore.has(pid)) {
          alive.delete(pid);
        }
      },
      isAlive: (pid: number): boolean => alive.has(pid),
      sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
    }
  };
}

describe('shutdown discovery filtering (spec 0053 AC2/AC3)', () => {
  it('matches memo serve family on posix, windows, sse, and mcp.js', () => {
    assert.equal(isMemoServeCommand(SERVE_POSIX), true);
    assert.equal(isMemoServeCommand(SERVE_SSE), true);
    assert.equal(isMemoServeCommand(SERVE_WIN), true);
    assert.equal(isMemoServeCommand(SERVE_MCP), true);
  });

  it('never matches unrelated node work', () => {
    assert.equal(isMemoServeCommand(NG_SERVE), false);
    assert.equal(isMemoServeCommand(YARN_DEV), false);
    assert.equal(isMemoServeCommand(YARN_TEST), false);
    assert.equal(isMemoServeCommand(''), false);
    assert.equal(isMemoServeCommand('node server.js'), false);
  });

  it('classifies canvas separately and excludes it by default', () => {
    assert.equal(isCanvasCommand(CANVAS), true);
    assert.equal(classifyMemoCommand(CANVAS), 'canvas');
    assert.equal(classifyMemoCommand(SERVE_POSIX), 'serve');
    assert.equal(classifyMemoCommand(NG_SERVE), null);

    const procs: MemoProcessInfo[] = [
      { pid: 101, command: SERVE_POSIX },
      { pid: 102, command: CANVAS }
    ];
    const withoutCanvas = filterShutdownTargets(procs, { currentPid: 1 });
    assert.deepEqual(
      withoutCanvas.targets.map((t) => t.pid),
      [101]
    );
    const withCanvas = filterShutdownTargets(procs, { currentPid: 1, includeCanvas: true });
    assert.deepEqual(
      withCanvas.targets.map((t) => t.pid),
      [101, 102]
    );
    assert.equal(withCanvas.targets[1]?.scope, 'canvas');
  });

  it('excludes pid 0/1, empty commands, and reports self as skipped-self', () => {
    const procs: MemoProcessInfo[] = [
      { pid: 0, command: SERVE_POSIX },
      { pid: 1, command: SERVE_POSIX },
      { pid: 200, command: '' },
      { pid: 201, command: SERVE_POSIX }
    ];
    const { targets, skippedSelf } = filterShutdownTargets(procs, { currentPid: 201 });
    assert.deepEqual(targets, []);
    assert.equal(skippedSelf.length, 1);
    assert.equal(skippedSelf[0]?.pid, 201);
    assert.equal(skippedSelf[0]?.result, 'skipped-self');
  });

  it('narrows by vaultRoot with normalized separators', () => {
    const procs: MemoProcessInfo[] = [
      { pid: 301, command: SERVE_WIN },
      { pid: 302, command: SERVE_POSIX }
    ];
    const scoped = filterShutdownTargets(procs, {
      currentPid: 1,
      vaultRoot: 'C:/Users/jpolv/.spec-memo'
    });
    assert.deepEqual(scoped.targets.map((t) => t.pid), [301]);
  });
});

describe('shutdown stop paths (spec 0053 AC4/AC5/AC6)', () => {
  it('stops gracefully with SIGTERM when the target exits', async () => {
    const { ops, calls } = stubOps([401]);
    const { report, exitCode } = await runShutdown({
      listProcesses: async () => [{ pid: 401, command: SERVE_POSIX }],
      signalOps: ops,
      currentPid: 1,
      timeoutMs: 200
    });
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.targets[0]?.result, 'stopped-graceful');
    assert.ok(calls.some((c) => c === 'kill 401 SIGTERM'));
    assert.ok(!calls.some((c) => c.includes('SIGKILL')));
  });

  it('force-terminates survivors of the graceful window', async () => {
    const { ops, calls } = stubOps([402], [402]);
    const { report, exitCode } = await runShutdown({
      listProcesses: async () => [{ pid: 402, command: SERVE_POSIX }],
      signalOps: ops,
      currentPid: 1,
      timeoutMs: 30
    });
    assert.equal(exitCode, 0);
    assert.equal(report.targets[0]?.result, 'stopped-forced');
    assert.ok(calls.some((c) => c === 'kill 402 SIGTERM'));
    assert.ok(calls.some((c) => c === 'kill 402 SIGKILL'));
  });

  it('--force skips the graceful wait', async () => {
    const { ops, calls } = stubOps([403]);
    const { report } = await runShutdown({
      listProcesses: async () => [{ pid: 403, command: SERVE_POSIX }],
      signalOps: ops,
      currentPid: 1,
      force: true
    });
    assert.equal(report.targets[0]?.result, 'stopped-forced');
    assert.equal(calls[0], 'kill 403 SIGKILL');
  });

  it('--dry-run lists without killing and exits 0', async () => {
    const { ops, calls } = stubOps([404]);
    const { report, exitCode } = await runShutdown({
      listProcesses: async () => [{ pid: 404, command: SERVE_POSIX }],
      signalOps: ops,
      currentPid: 1,
      dryRun: true
    });
    assert.equal(exitCode, 0);
    assert.equal(report.dryRun, true);
    assert.equal(report.ok, true);
    assert.deepEqual(calls, []);
    assert.equal(report.targets[0]?.result, 'skipped');
  });

  it('reports already-exited for dead pids and failed for force survivors', async () => {
    const { ops } = stubOps([]);
    const exited = await runShutdown({
      listProcesses: async () => [{ pid: 405, command: SERVE_POSIX }],
      signalOps: ops,
      currentPid: 1
    });
    assert.equal(exited.report.targets[0]?.result, 'already-exited');
    assert.equal(exited.exitCode, 0);

    const stubborn: ShutdownSignalOps = {
      kill: (): void => undefined,
      isAlive: (): boolean => true,
      sleep: (): Promise<void> => Promise.resolve()
    };
    const failed = await runShutdown({
      listProcesses: async () => [{ pid: 406, command: SERVE_POSIX }],
      signalOps: stubborn,
      currentPid: 1,
      timeoutMs: 1,
      force: true
    });
    assert.equal(failed.report.targets[0]?.result, 'failed');
    assert.equal(failed.report.ok, false);
    assert.equal(failed.exitCode, 1);
  });

  it('empty run is idempotent with exit 0', async () => {
    const { ops } = stubOps([]);
    const { report, exitCode } = await runShutdown({
      listProcesses: async () => [],
      signalOps: ops,
      currentPid: 1
    });
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.summary.total, 0);
  });
});

describe('shutdown timeout + CLI surface (spec 0053 AC1/AC9)', () => {
  it('resolves timeout as flag > env > 8000 default', () => {
    assert.equal(resolveShutdownTimeoutMs(250), 250);
    const prev = process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
    process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = '1234';
    try {
      assert.equal(resolveShutdownTimeoutMs(), 1234);
    } finally {
      if (prev === undefined) delete process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
      else process.env.SPEC_MEMO_SYNC_TIMEOUT_MS = prev;
    }
    delete process.env.SPEC_MEMO_SYNC_TIMEOUT_MS;
    assert.equal(resolveShutdownTimeoutMs(), 8000);
    assert.equal(resolveShutdownTimeoutMs(-5), 8000);
  });

  it('memo --help lists shutdown under Utility Commands', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured += args.map(String).join(' ') + '\n';
    };
    try {
      const code = await runCli(['--help']);
      assert.equal(code, 0);
      assert.match(captured, /shutdown/);
    } finally {
      console.log = origLog;
    }
  });

  it('memo shutdown --help exits 0', async () => {
    const code = await runCli(['shutdown', '--help']);
    assert.equal(code, 0);
  });

  it('rejects invalid --timeout-ms and unknown flags', async () => {
    assert.equal(await runCli(['shutdown', '--timeout-ms', 'abc']), 1);
    assert.equal(await runCli(['shutdown', '--timeout-ms=-5']), 1);
    assert.equal(await runCli(['shutdown', '--bogus-flag']), 1);
  });

  it('memo shutdown --dry-run --json emits ok/shape without killing', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured += args.map(String).join(' ') + '\n';
    };
    try {
      const code = await runCli(['shutdown', '--dry-run', '--json']);
      assert.equal(code, 0);
      const payload = JSON.parse(captured.trim()) as {
        ok: boolean;
        dryRun: boolean;
        timeoutMs: number;
        targets: unknown[];
        summary: Record<string, number>;
      };
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, true);
      assert.ok(typeof payload.timeoutMs === 'number');
      assert.ok(Array.isArray(payload.targets));
      assert.ok(typeof payload.summary.total === 'number');
    } finally {
      console.log = origLog;
    }
  });
});
