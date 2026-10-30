import { normalizeConfig } from './config.js';
import { createMemoRunner, truncateUtf8 } from './memo-runner.js';

export const name = 'specmemo-bridge';
export const inject = ['subprocess', 'sessions'];

const LOG_PREFIX = '[specmemo-bridge]';
const SESSION_PREFIX = 'dsh:';
const STATUS_TOOL = 'specmemo_bridge_status';

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function diagnose(ctx, message) {
  const line = `${LOG_PREFIX} ${message}`;
  try {
    const logger = ctx?.logger;
    if (logger && typeof logger.warn === 'function') {
      logger.warn(line);
      return;
    }
  } catch {
    // A broken logger must not break the bridge.
  }
  try {
    console.warn(line);
  } catch {
    // Diagnostics are best effort.
  }
}

function resolveService(ctx, serviceName) {
  try {
    const viaGet = ctx?.get?.(serviceName);
    if (viaGet) return viaGet;
  } catch {
    // Cordis throws for services that are not loaded; fall through.
  }
  try {
    return ctx?.[serviceName] ?? null;
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function identityOf(session) {
  const header = session?.header ?? {};
  const rawId = stringOrNull(header.id) ?? stringOrNull(session?.id);
  const cwd = stringOrNull(header.cwd) ?? stringOrNull(session?.cwd);
  return {
    key: rawId ?? '<unknown>',
    sessionId: rawId ? `${SESSION_PREFIX}${rawId}` : null,
    cwd
  };
}

function flattenContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

function extractUserMessageText(event) {
  const data = event?.data;
  const candidates = [
    typeof data === 'string' ? data : undefined,
    data?.text,
    data?.body,
    data?.content,
    data?.message?.text,
    data?.message?.content,
    event?.text,
    event?.body,
    event?.content,
    event?.message?.text,
    event?.message?.content
  ];
  for (const candidate of candidates) {
    const text = flattenContent(candidate);
    if (text) return text;
  }
  return '';
}

function registerStatusTool(ctx, status) {
  try {
    const tools = resolveService(ctx, 'tools');
    const register = tools?.register;
    if (typeof register !== 'function') return;
    register.call(tools, {
      name: STATUS_TOOL,
      description: 'Read-only status of the spec-memo bridge: queue depth, invocation counters, and the last error.',
      parameters: { type: 'object', properties: {} },
      execute: async () => status()
    });
  } catch (error) {
    diagnose(ctx, `failed to register ${STATUS_TOOL} tool: ${messageOf(error)}`);
  }
}

export function apply(ctx, rawConfig = {}) {
  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    diagnose(ctx, `invalid configuration: ${messageOf(error)}`);
    return;
  }

  if (!config.enabled) return;

  const subprocess = resolveService(ctx, 'subprocess');
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    diagnose(ctx, 'subprocess service unavailable; bridge disabled');
    return;
  }
  if (typeof ctx?.on !== 'function') {
    diagnose(ctx, 'event bus unavailable; bridge disabled');
    return;
  }

  const counters = {
    bootstrap: 0,
    session_start: 0,
    prompt_record: 0,
    tool_audit: 0,
    sync: 0,
    session_end: 0,
    failures: 0,
    timeouts: 0,
    queue_overflow: 0
  };
  const state = {
    lastError: null,
    lastInvocationAt: null,
    started: new Set(),
    ended: new Set(),
    flushTimers: new Map()
  };

  const runner = createMemoRunner({
    spawn: (request) => subprocess.spawn(request),
    config,
    onOverflow: () => {
      counters.queue_overflow += 1;
      diagnose(ctx, 'invocation queue overflow; dropped the oldest pending command');
    }
  });

  function status() {
    return {
      enabled: config.enabled,
      queueDepth: runner.queueDepth(),
      counters: { ...counters },
      lastError: state.lastError,
      lastInvocationAt: state.lastInvocationAt
    };
  }

  registerStatusTool(ctx, status);

  function safeTask(work) {
    return async () => {
      try {
        await work();
      } catch (error) {
        diagnose(ctx, `handler failed: ${messageOf(error)}`);
      }
    };
  }

  async function invoke(label, sessionId, cwd, args) {
    let result;
    try {
      result = await runner.run({ args, cwd });
    } catch (error) {
      result = { ok: false, exitCode: null, durationMs: 0, error: messageOf(error) };
    }
    counters[label] = (counters[label] ?? 0) + 1;
    state.lastInvocationAt = new Date().toISOString();
    if (!result.ok) {
      counters.failures += 1;
      if (result.error === 'timeout') counters.timeouts += 1;
      const detail =
        result.error === 'timeout'
          ? `timed out after ${config.timeoutMs}ms`
          : `failed (${result.error ?? `exit code ${result.exitCode}`})`;
      state.lastError = { command: label, sessionId, message: detail, at: state.lastInvocationAt };
      diagnose(ctx, `${label} ${detail} for session ${sessionId ?? 'unknown'}`);
    }
    return result;
  }

  function buildSessionStartCommands(sessionId, cwd) {
    const bootstrap = ['bootstrap'];
    if (cwd) bootstrap.push('--cwd', cwd);
    bootstrap.push('--session-id', sessionId);

    const begin = ['prompt', 'session_start', '--session-id', sessionId];
    if (cwd) begin.push('--cwd', cwd);
    return [bootstrap, begin];
  }

  function handleSessionCreated(session) {
    try {
      const { key, sessionId, cwd } = identityOf(session);
      if (!sessionId) {
        diagnose(ctx, 'session/created without a session id; skipping bootstrap');
        return undefined;
      }
      if (state.started.has(key)) return undefined;
      state.started.add(key);
      state.ended.delete(key);
      const [bootstrap, begin] = buildSessionStartCommands(sessionId, cwd);
      return runner.enqueue(
        key,
        safeTask(async () => {
          await invoke('bootstrap', sessionId, cwd, bootstrap);
          await invoke('session_start', sessionId, cwd, begin);
        })
      );
    } catch (error) {
      diagnose(ctx, `session/created handler failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  function handleSessionEvent(session, event) {
    try {
      if (!event || typeof event !== 'object' || event.type !== 'user/message') return undefined;
      const text = extractUserMessageText(event);
      if (!text) return undefined;
      const { key, sessionId, cwd } = identityOf(session);
      if (!sessionId) {
        diagnose(ctx, 'user/message without a session id; skipping prompt record');
        return undefined;
      }
      const body = truncateUtf8(text, config.maxBodyBytes);
      if (!body) return undefined;
      return runner.enqueue(
        key,
        safeTask(() => invoke('prompt_record', sessionId, cwd, ['prompt', 'record', '--session-id', sessionId, '--body', body]))
      );
    } catch (error) {
      diagnose(ctx, `session/event handler failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  function handleSessionDisposed(session) {
    try {
      const { key, sessionId, cwd } = identityOf(session);
      clearFlushTimer(key);
      state.started.delete(key);
      if (!sessionId) {
        diagnose(ctx, 'session/disposed without a session id; skipping session_end');
        return undefined;
      }
      if (state.ended.has(key)) return undefined;
      state.ended.add(key);
      return runner.enqueue(
        key,
        safeTask(async () => {
          await invoke('session_end', sessionId, cwd, ['prompt', 'session_end', '--session-id', sessionId]);
          await invoke('sync', sessionId, cwd, ['sync']);
        })
      );
    } catch (error) {
      diagnose(ctx, `session/disposed handler failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  function clearFlushTimer(key) {
    const timer = state.flushTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    state.flushTimers.delete(key);
  }

  function handleSessionFlush(session) {
    try {
      const { key, sessionId, cwd } = identityOf(session);
      if (!sessionId) {
        diagnose(ctx, 'session/flush without a session id; skipping debounced sync');
        return undefined;
      }
      if (state.ended.has(key)) return undefined;
      clearFlushTimer(key);
      const timer = setTimeout(() => {
        state.flushTimers.delete(key);
        runner.enqueue(
          key,
          safeTask(() => invoke('sync', sessionId, cwd, ['sync']))
        );
      }, config.debounceMs);
      timer.unref?.();
      state.flushTimers.set(key, timer);
      return undefined;
    } catch (error) {
      diagnose(ctx, `session/flush handler failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  const subscriptions = [
    ['session/created', handleSessionCreated],
    ['session/event', handleSessionEvent],
    ['session/disposed', handleSessionDisposed],
    ['session/flush', handleSessionFlush]
  ];
  for (const [event, handler] of subscriptions) {
    try {
      ctx.on(event, handler);
    } catch (error) {
      diagnose(ctx, `failed to subscribe to ${event}: ${messageOf(error)}`);
    }
  }
}
