import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Minimal fake Cordis context: records spawn requests, captures listeners, and
 * exposes the registered status tool.
 */
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
          return tool;
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
