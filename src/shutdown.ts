/**
 * `memo shutdown` — graceful stop for orphaned memo serve processes.
 *
 * Editors/IDEs do not always stop the spec-memo MCP server on exit, leaving
 * stdio/SSE instances holding the vault lock. This module discovers running
 * memo serve processes by command line, asks each to exit gracefully
 * (SIGTERM, so its own SIGINT/SIGTERM handlers run `close()` plus the
 * fail-open `flushOnShutdown`), waits, and force-terminates survivors.
 *
 * Spec: `.agents/specs/0053-memo-shutdown.spec.md` (issue #56).
 * v1 uses command-line discovery plus OS signals only: no PID files,
 * no HTTP shutdown endpoint, local processes only.
 */
import { execFile } from 'node:child_process';
import { getShutdownFlushMs } from './vault.js';

export interface MemoProcessInfo {
  pid: number;
  command: string;
}

export type ShutdownScope = 'serve' | 'canvas';

export interface ShutdownTarget extends MemoProcessInfo {
  scope: ShutdownScope;
}

export type ShutdownTargetResultValue =
  | 'stopped-graceful'
  | 'stopped-forced'
  | 'already-exited'
  | 'skipped-self'
  | 'skipped'
  | 'failed';

export interface ShutdownTargetResult {
  pid: number;
  command: string;
  scope: ShutdownScope;
  result: ShutdownTargetResultValue;
  reason?: string;
}

export interface ShutdownSummary {
  total: number;
  stoppedGraceful: number;
  stoppedForced: number;
  alreadyExited: number;
  skipped: number;
  failed: number;
}

export interface ShutdownReport {
  ok: boolean;
  dryRun: boolean;
  timeoutMs: number;
  targets: ShutdownTargetResult[];
  summary: ShutdownSummary;
}

export interface ShutdownFilterOptions {
  currentPid?: number;
  /** Narrow to instances serving this vault root (slash-normalized substring). */
  vaultRoot?: string;
  /** Include `memo canvas` processes (excluded by default). */
  includeCanvas?: boolean;
}

export interface ShutdownSignalOps {
  kill(pid: number, signal: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export interface ShutdownRunOptions extends ShutdownFilterOptions {
  timeoutMs?: number;
  force?: boolean;
  dryRun?: boolean;
  listProcesses?: () => Promise<MemoProcessInfo[]>;
  signalOps?: ShutdownSignalOps;
}

const SERVE_TOKEN_RE = /(^|\s)serve(\s|$)/;
const CANVAS_TOKEN_RE = /canvas/i;

function normalizedCommand(command: string): string {
  return command.replace(/\\/g, '/');
}

/**
 * True when a command line belongs to the memo serve family: it must contain
 * a spec-memo server marker (`spec-memo` plus `dist/cli.js` or `dist/mcp.js`)
 * AND the standalone `serve` token. Plain `node` work (`ng serve`,
 * `yarn dev`, `yarn test`) never qualifies.
 */
export function isMemoServeCommand(command: string): boolean {
  if (!command) return false;
  const norm = normalizedCommand(command);
  if (!norm.includes('spec-memo')) return false;
  if (!norm.includes('dist/cli.js') && !norm.includes('dist/mcp.js')) return false;
  return SERVE_TOKEN_RE.test(norm);
}

/** True for `memo canvas` / `serve-canvas` graph UI processes. */
export function isCanvasCommand(command: string): boolean {
  if (!command) return false;
  return CANVAS_TOKEN_RE.test(normalizedCommand(command));
}

export function classifyMemoCommand(command: string): ShutdownScope | null {
  if (isCanvasCommand(command)) return 'canvas';
  if (isMemoServeCommand(command)) return 'serve';
  return null;
}

function normalizedRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Filter a raw process list down to shutdown targets. Never returns PID 0/1.
 * The invoking PID is reported as `skipped-self` when it would otherwise
 * match, so the invoker can never kill itself.
 */
export function filterShutdownTargets(
  processes: MemoProcessInfo[],
  options: ShutdownFilterOptions = {}
): { targets: ShutdownTarget[]; skippedSelf: ShutdownTargetResult[] } {
  const currentPid = options.currentPid ?? process.pid;
  const scopeRoot = options.vaultRoot ? normalizedRoot(options.vaultRoot) : undefined;
  const targets: ShutdownTarget[] = [];
  const skippedSelf: ShutdownTargetResult[] = [];

  for (const proc of processes) {
    if (!Number.isInteger(proc.pid) || proc.pid <= 1) continue;
    if (!proc.command) continue;
    const scope = classifyMemoCommand(proc.command);
    if (!scope) continue;
    if (scope === 'canvas' && !options.includeCanvas) continue;
    if (scopeRoot && !normalizedCommand(proc.command).toLowerCase().includes(scopeRoot)) {
      continue;
    }
    if (proc.pid === currentPid) {
      skippedSelf.push({
        pid: proc.pid,
        command: proc.command,
        scope,
        result: 'skipped-self',
        reason: 'invoking process never kills itself'
      });
      continue;
    }
    targets.push({ pid: proc.pid, command: proc.command, scope });
  }

  return { targets, skippedSelf };
}

/** Effective wait: explicit `--timeout-ms`, else `SPEC_MEMO_SYNC_TIMEOUT_MS`, else 8000 ms. */
export function resolveShutdownTimeoutMs(explicitMs?: number): number {
  if (explicitMs !== undefined && Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.floor(explicitMs);
  }
  return getShutdownFlushMs();
}

export const defaultSignalOps: ShutdownSignalOps = {
  kill: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal);
  },
  isAlive: (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      // EPERM: process exists but is not killable by us — still alive.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  },
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
};

const POLL_INTERVAL_MS = 100;
const FORCE_CONFIRM_MS = 1000;

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  ops: ShutdownSignalOps
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!ops.isAlive(pid)) return true;
    if (Date.now() >= deadline) return ops.isAlive(pid) === false;
    await ops.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function stopOneTarget(
  target: ShutdownTarget,
  options: { timeoutMs: number; force: boolean; dryRun: boolean },
  ops: ShutdownSignalOps
): Promise<ShutdownTargetResult> {
  const base = { pid: target.pid, command: target.command, scope: target.scope };
  if (options.dryRun) {
    return { ...base, result: 'skipped', reason: 'dry-run: no action taken' };
  }
  if (!ops.isAlive(target.pid)) {
    return { ...base, result: 'already-exited' };
  }

  if (options.force) {
    try {
      ops.kill(target.pid, 'SIGKILL');
    } catch (err: unknown) {
      if (errnoOf(err) === 'ESRCH') return { ...base, result: 'already-exited' };
      return {
        ...base,
        result: 'failed',
        reason: `force kill failed: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    const exited = await waitForExit(target.pid, FORCE_CONFIRM_MS, ops);
    return exited
      ? { ...base, result: 'stopped-forced' }
      : { ...base, result: 'failed', reason: 'process survived force termination' };
  }

  try {
    ops.kill(target.pid, 'SIGTERM');
  } catch (err: unknown) {
    if (errnoOf(err) === 'ESRCH') return { ...base, result: 'already-exited' };
    return {
      ...base,
      result: 'failed',
      reason: `graceful kill failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (await waitForExit(target.pid, options.timeoutMs, ops)) {
    return { ...base, result: 'stopped-graceful' };
  }
  try {
    ops.kill(target.pid, 'SIGKILL');
  } catch (err: unknown) {
    if (errnoOf(err) === 'ESRCH') return { ...base, result: 'already-exited' };
    return {
      ...base,
      result: 'failed',
      reason: `force kill failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const exited = await waitForExit(target.pid, FORCE_CONFIRM_MS, ops);
  return exited
    ? { ...base, result: 'stopped-forced' }
    : { ...base, result: 'failed', reason: 'process survived force termination' };
}

function summarize(results: ShutdownTargetResult[]): ShutdownSummary {
  const summary: ShutdownSummary = {
    total: results.length,
    stoppedGraceful: 0,
    stoppedForced: 0,
    alreadyExited: 0,
    skipped: 0,
    failed: 0
  };
  for (const r of results) {
    switch (r.result) {
      case 'stopped-graceful':
        summary.stoppedGraceful++;
        break;
      case 'stopped-forced':
        summary.stoppedForced++;
        break;
      case 'already-exited':
        summary.alreadyExited++;
        break;
      case 'skipped-self':
      case 'skipped':
        summary.skipped++;
        break;
      case 'failed':
        summary.failed++;
        break;
    }
  }
  return summary;
}

function listWindowsProcesses(): Promise<MemoProcessInfo[]> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2'
      ],
      { timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          const out: MemoProcessInfo[] = [];
          for (const row of rows) {
            const rec = row as { ProcessId?: unknown; CommandLine?: unknown };
            const pid = Number(rec.ProcessId);
            if (!Number.isInteger(pid) || pid <= 0) continue;
            out.push({ pid, command: typeof rec.CommandLine === 'string' ? rec.CommandLine : '' });
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

function listPosixProcesses(): Promise<MemoProcessInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-ax', '-o', 'pid=,args='],
      { timeout: 10000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        const out: MemoProcessInfo[] = [];
        for (const line of stdout.split('\n')) {
          const match = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!match) continue;
          out.push({ pid: Number(match[1]), command: (match[2] || '').trim() });
        }
        resolve(out);
      }
    );
  });
}

/** Cross-platform process enumeration (pid + full command line). Fail-open: []. */
export async function listMemoProcesses(): Promise<MemoProcessInfo[]> {
  try {
    if (process.platform === 'win32') return await listWindowsProcesses();
    return await listPosixProcesses();
  } catch {
    return [];
  }
}

/**
 * Discover memo serve targets and stop them. Never throws for discovery or
 * per-target failures — they are reported in the result array instead.
 * Exit code: 0 when nothing matched or every target settled; 1 otherwise.
 */
export async function runShutdown(options: ShutdownRunOptions = {}): Promise<{
  report: ShutdownReport;
  exitCode: number;
}> {
  const timeoutMs = resolveShutdownTimeoutMs(options.timeoutMs);
  const ops = options.signalOps ?? defaultSignalOps;
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  let processes: MemoProcessInfo[] = [];
  try {
    processes = await (options.listProcesses ?? listMemoProcesses)();
  } catch {
    processes = [];
  }

  const { targets, skippedSelf } = filterShutdownTargets(processes, {
    currentPid: options.currentPid,
    vaultRoot: options.vaultRoot,
    includeCanvas: options.includeCanvas
  });

  const results: ShutdownTargetResult[] = [...skippedSelf];
  for (const target of targets) {
    try {
      results.push(await stopOneTarget(target, { timeoutMs, force, dryRun }, ops));
    } catch (err: unknown) {
      results.push({
        pid: target.pid,
        command: target.command,
        scope: target.scope,
        result: 'failed',
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary = summarize(results);
  const ok = summary.failed === 0;
  return {
    report: { ok, dryRun, timeoutMs, targets: results, summary },
    exitCode: ok ? 0 : 1
  };
}
