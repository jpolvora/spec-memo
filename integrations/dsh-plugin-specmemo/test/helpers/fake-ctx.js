import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Resolvable stand-in for the `memo` executable. Tests never execute it; it
 * only has to satisfy executable discovery (AC11), so an absolute path that
 * exists on every machine keeps the suite independent of PATH.
 */
export const TEST_MEMO_COMMAND = Object.freeze([process.execPath]);

/** Plugin config with an explicit, always-resolvable `memoCommand`. */
export function memoConfig(extra = {}) {
  return { memoCommand: [...TEST_MEMO_COMMAND], ...extra };
}

/** Minimal Cordis-style fake: records spawns, listeners, tools, and warnings. */
export function createFakeContext({ spawn, tools = true } = {}) {
  const listeners = new Map();
  const invocations = [];
  const warnings = [];
  const registeredTools = [];

  const subprocess = {
    spawn(request) {
      invocations.push(request);
      if (typeof spawn === 'function') return spawn(request);
      return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} };
    }
  };

  const toolsService = tools
    ? {
        register(tool) {
          registeredTools.push(tool);
          const off = () => {
            const index = registeredTools.indexOf(tool);
            if (index >= 0) registeredTools.splice(index, 1);
          };
          return off;
        }
      }
    : undefined;

  const ctx = {
    logger: {
      warn(message) {
        warnings.push(message);
      },
      info() {}
    },
    subprocess,
    get(serviceName) {
      if (serviceName === 'tools') return toolsService;
      if (serviceName === 'subprocess') return subprocess;
      return undefined;
    },
    on(event, handler) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    }
  };

  const handlersFor = (event) => listeners.get(event) ?? [];

  return {
    ctx,
    invocations,
    warnings,
    registeredTools,
    listenerCount: (event) => handlersFor(event).length,
    async emit(event, ...args) {
      for (const handler of handlersFor(event)) await handler(...args);
    },
    dispatch(event, ...args) {
      return handlersFor(event).map((handler) => handler(...args));
    },
    async status() {
      const tool = registeredTools.find((candidate) => candidate.name === 'specmemo_bridge_status');
      return tool ? tool.execute() : undefined;
    }
  };
}

export async function waitFor(predicate, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  return predicate();
}

export function sessionFor(id = 'session-1', cwd = 'C:\\repo') {
  return { header: { id, cwd } };
}

export function userMessage(text) {
  return { type: 'user/message', data: { text } };
}

export function toolResult(name, extra = {}) {
  return { type: 'tool/result', data: { name, ...extra } };
}

export function stalledSpawn({ onSpawn, onTerminate } = {}) {
  return (request) => {
    onSpawn?.(request);
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    return {
      done,
      terminate() {
        onTerminate?.(request);
        settle({ exitCode: null, signal: 'SIGTERM' });
      }
    };
  };
}

export function exitSpawn(exitCode) {
  return () => ({ done: Promise.resolve({ exitCode, signal: null }), terminate() {} });
}

/**
 * Run `work` with no `memo` on PATH and no `SPEC_MEMO_MEMO`, so executable
 * discovery has nothing to resolve (AC11). The environment is restored even
 * when `work` throws.
 */
export async function withoutMemoExecutable(work) {
  const previousPath = process.env.PATH;
  const previousMemo = process.env.SPEC_MEMO_MEMO;
  process.env.PATH = '';
  delete process.env.SPEC_MEMO_MEMO;
  try {
    return await work();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMemo === undefined) delete process.env.SPEC_MEMO_MEMO;
    else process.env.SPEC_MEMO_MEMO = previousMemo;
  }
}
