import { setTimeout as delay } from 'node:timers/promises';

const STDIO = Object.freeze({
  stdin: 'ignore',
  stdout: { maxBytes: 8192 },
  stderr: { maxBytes: 8192 }
});

const SPAWN_GRACE_MS = 2000;
const DONE_GRACE_MS = 250;

export function buildMemoArgv(memoCommand, args = []) {
  if (!Array.isArray(memoCommand) || memoCommand.length === 0) {
    throw new TypeError('memoCommand must be a non-empty array');
  }
  return [...memoCommand, ...args.map((value) => String(value))];
}

export function buildMemoEnv(config, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (config?.vaultRoot) env.SPEC_MEMO_ROOT = config.vaultRoot;
  return env;
}

/**
 * Truncate text to at most maxBytes UTF-8 bytes without splitting a code point.
 */
export function truncateUtf8(text, maxBytes) {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let bytes = 0;
  let output = '';
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    output += character;
  }
  return output;
}

function errorLabel(error) {
  if (!error) return 'spawn-error';
  if (typeof error === 'string') return error;
  if (error.code) return `spawn-${String(error.code)}`;
  if (error.name) return `spawn-${String(error.name)}`;
  return 'spawn-error';
}

function terminateHandle(handle) {
  try {
    handle.terminate?.();
  } catch {
    // Terminating a child that already exited is not an error.
  }
}

/**
 * Run one memo command through the host subprocess service. The returned
 * promise never rejects: failures and timeouts are reported as result values.
 */
export async function runMemoCommand({ spawn, argv, cwd, env, timeoutMs }) {
  const startedAt = Date.now();
  const failed = (error) => ({ ok: false, exitCode: null, durationMs: Date.now() - startedAt, error });
  if (typeof spawn !== 'function') return failed('subprocess-unavailable');

  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // AbortSignal implementations always accept abort().
      }
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });

  const spawned = Promise.resolve()
    .then(() => spawn({ argv, cwd, env, stdio: STDIO, graceMs: SPAWN_GRACE_MS, signal: controller.signal }))
    .then(
      (handle) => ({ kind: 'handle', handle }),
      (error) => ({ kind: 'spawn-error', error })
    );

  const acquisition = await Promise.race([spawned, timeout]);
  if (acquisition.kind === 'timeout') {
    // The host may still hand back a handle after the deadline; kill it then.
    spawned.then((outcome) => {
      if (outcome.kind === 'handle') terminateHandle(outcome.handle);
    });
    return failed('timeout');
  }
  if (acquisition.kind === 'spawn-error') {
    clearTimeout(timer);
    return failed(errorLabel(acquisition.error));
  }

  const handle = acquisition.handle;
  if (!handle || typeof handle !== 'object') {
    clearTimeout(timer);
    return failed('subprocess-handle-missing');
  }

  let done;
  try {
    done = Promise.resolve(handle.done).then(
      (outcome) => ({ kind: 'done', outcome }),
      (error) => ({ kind: 'error', error })
    );
  } catch (error) {
    clearTimeout(timer);
    terminateHandle(handle);
    return failed(errorLabel(error));
  }

  const first = await Promise.race([done, timeout]);
  clearTimeout(timer);

  if (first.kind === 'timeout') {
    terminateHandle(handle);
    // Wait briefly for the killed child to settle, but never past the bound.
    await Promise.race([done, delay(DONE_GRACE_MS)]);
    return failed('timeout');
  }

  if (first.kind === 'error') {
    terminateHandle(handle);
    return failed(errorLabel(first.error));
  }

  const outcome = first.outcome ?? {};
  const exitCode = Number.isInteger(outcome.exitCode) ? outcome.exitCode : null;
  const signal = outcome.signal ?? null;
  const ok = exitCode === 0;
  return {
    ok,
    exitCode,
    signal,
    durationMs: Date.now() - startedAt,
    error: ok ? null : `exit-code-${exitCode ?? signal ?? 'unknown'}`
  };
}

/**
 * FIFO task queue, one lane per DSH session. Overflow drops the oldest pending
 * task and reports it through onOverflow.
 */
export function createSessionQueue({ limit = 64, onOverflow } = {}) {
  const lanes = new Map();
  let pending = 0;

  function drain(key) {
    const lane = lanes.get(key);
    if (!lane || lane.running) return;
    const entry = lane.items.shift();
    if (!entry) {
      lanes.delete(key);
      return;
    }
    lane.running = true;
    Promise.resolve()
      .then(() => entry.task())
      .then(
        (value) => {
          pending -= 1;
          entry.resolve(value);
        },
        (error) => {
          pending -= 1;
          entry.reject(error);
        }
      )
      .finally(() => {
        lane.running = false;
        drain(key);
      })
      .catch(() => {});
  }

  function enqueue(sessionKey, task) {
    const key = sessionKey ?? '<unknown>';
    return new Promise((resolve, reject) => {
      let lane = lanes.get(key);
      if (!lane) {
        lane = { items: [], running: false };
        lanes.set(key, lane);
      }
      if (lane.items.length >= limit) {
        const dropped = lane.items.shift();
        pending -= 1;
        try {
          onOverflow?.(key);
        } catch {
          // Overflow reporting must never break the queue.
        }
        dropped?.resolve(undefined);
      }
      lane.items.push({ task, resolve, reject });
      pending += 1;
      queueMicrotask(() => drain(key));
    });
  }

  return {
    enqueue,
    depth: () => pending,
    size: (sessionKey) => lanes.get(sessionKey ?? '<unknown>')?.items.length ?? 0
  };
}

export function createMemoRunner({ spawn, config, onOverflow } = {}) {
  const queue = createSessionQueue({ limit: config?.queueLimit ?? 64, onOverflow });
  return {
    enqueue: (sessionKey, task) => queue.enqueue(sessionKey, task),
    queueDepth: () => queue.depth(),
    run: ({ args = [], cwd } = {}) =>
      runMemoCommand({
        spawn,
        argv: buildMemoArgv(config.memoCommand, args),
        cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
        env: buildMemoEnv(config),
        timeoutMs: config.timeoutMs
      })
  };
}
