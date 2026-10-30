import { normalizeConfig } from './config.js';
import { discoverMemoCommand } from './discovery.js';
import { createMemoRunner, truncateUtf8 } from './memo-runner.js';
import { describeError, redactText } from './redact.js';

export const name = 'specmemo-bridge';
export const inject = ['subprocess', 'sessions'];

const LOG_PREFIX = '[specmemo-bridge]';
const SESSION_PREFIX = 'dsh-';
const STATUS_TOOL = 'specmemo_bridge_status';
const TOOL_NAME_MAX_LENGTH = 64;
const SESSION_ID_MAX_LENGTH = 128;

function diagnose(ctx, message) {
  const line = `${LOG_PREFIX} ${redactText(message)}`;
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

/**
 * Best-effort tool name for `tool/result` session events. Only the name is
 * ever used; tool arguments and results never leave the event handler.
 */
function extractToolName(event) {
  const data = event?.data;
  const candidates = [
    data?.name,
    data?.tool,
    data?.toolName,
    data?.tool?.name,
    data?.call?.name,
    data?.invocation?.name,
    data?.toolCall?.name,
    event?.name,
    event?.tool,
    event?.toolName
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.trim().replace(/\s+/g, '_');
    if (!cleaned) continue;
    const safe = redactText(cleaned, { maxLength: TOOL_NAME_MAX_LENGTH });
    if (safe) return safe;
  }
  return null;
}

/**
 * Register the read-only status tool. Returns a disposer, or `null` when the
 * host has no tools service (AC12).
 */
function registerStatusTool(ctx, status) {
  try {
    const tools = resolveService(ctx, 'tools');
    const register = tools?.register;
    if (typeof register !== 'function') return null;
    const result = register.call(tools, {
      name: STATUS_TOOL,
      description:
        'Read-only status of the spec-memo bridge: queue depth, invocation counters, and the last error.',
      parameters: { type: 'object', properties: {} },
      execute: async () => status()
    });
    if (typeof result === 'function') return result;
    if (typeof tools.unregister === 'function') {
      return () => tools.unregister(STATUS_TOOL);
    }
    return null;
  } catch (error) {
    diagnose(ctx, `failed to register ${STATUS_TOOL} tool: ${describeError(error)}`);
    return null;
  }
}

function isExplicitMemoCommand(rawConfig) {
  return Boolean(
    rawConfig &&
      typeof rawConfig === 'object' &&
      Object.prototype.hasOwnProperty.call(rawConfig, 'memoCommand')
  );
}

export function apply(ctx, rawConfig = {}) {
  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    diagnose(ctx, `invalid configuration: ${describeError(error)}`);
    return undefined;
  }

  if (!config.enabled) return undefined;

  const subprocess = resolveService(ctx, 'subprocess');
  if (!subprocess || typeof subprocess.spawn !== 'function') {
    diagnose(ctx, 'subprocess service unavailable; bridge disabled');
    return undefined;
  }
  if (typeof ctx?.on !== 'function') {
    diagnose(ctx, 'event bus unavailable; bridge disabled');
    return undefined;
  }

  // AC11: resolve the executable up front. If nothing resolves the bridge is
  // disabled after exactly one diagnostic and no listener or timer is created.
  let memo;
  try {
    memo = discoverMemoCommand({
      configuredCommand: isExplicitMemoCommand(rawConfig) ? config.memoCommand : null,
      vaultRoot: config.vaultRoot
    });
  } catch (error) {
    diagnose(ctx, `memo executable discovery failed: ${describeError(error)}`);
    return undefined;
  }
  if (!memo) {
    diagnose(
      ctx,
      'memo executable not found (checked memoCommand, SPEC_MEMO_MEMO, PATH, and vaultRoot dist/cli.js); bridge disabled'
    );
    return undefined;
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
  const disposers = [];
  let disposed = false;

  const runner = createMemoRunner({
    spawn: (request) => subprocess.spawn(request),
    config,
    memoCommand: memo.argv,
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
      lastError: state.lastError ? { ...state.lastError } : null,
      lastInvocationAt: state.lastInvocationAt
    };
  }

  const statusDisposer = registerStatusTool(ctx, status);

  function safeTask(work) {
    return async () => {
      if (disposed) return;
      try {
        await work();
      } catch (error) {
        diagnose(ctx, `handler failed: ${describeError(error)}`);
      }
    };
  }

  async function invoke(label, sessionId, cwd, args) {
    if (disposed) return { ok: false, exitCode: null, durationMs: 0, error: 'disposed' };
    let result;
    try {
      result = await runner.run({ args, cwd });
    } catch (error) {
      result = { ok: false, exitCode: null, durationMs: 0, error: describeError(error) };
    }
    counters[label] = (counters[label] ?? 0) + 1;
    state.lastInvocationAt = new Date().toISOString();
    if (!result.ok) {
      counters.failures += 1;
      if (result.error === 'timeout') counters.timeouts += 1;
      const detail =
        result.error === 'timeout'
          ? `timed out after ${config.timeoutMs}ms`
          : `failed (${redactText(String(result.error ?? `exit code ${result.exitCode}`))})`;
      state.lastError = {
        command: label,
        sessionId: sessionId ? redactText(String(sessionId), { maxLength: SESSION_ID_MAX_LENGTH }) : null,
        message: redactText(detail),
        at: state.lastInvocationAt
      };
      diagnose(
        ctx,
        `${label} ${detail} for ${sessionId ? `session ${sessionId}` : 'an unknown session'}`
      );
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

  // AC10: `events.bootstrap` gates the whole `session/created` row
  // (`memo bootstrap` + `memo prompt session_start`).
  function handleSessionCreated(session) {
    try {
      if (!config.events.bootstrap) return undefined;
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
      diagnose(ctx, `session/created handler failed: ${describeError(error)}`);
      return undefined;
    }
  }

  // AC10: `events.promptRecord` gates `user/message` -> `memo prompt record`.
  function handleUserMessage(session, event) {
    if (!config.events.promptRecord) return undefined;
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
      safeTask(() =>
        invoke('prompt_record', sessionId, cwd, [
          'prompt',
          'record',
          '--session-id',
          sessionId,
          '--body',
          body
        ])
      )
    );
  }

  // AC10/AC15: `events.toolAudit` gates `tool/result` -> `memo append`.
  function handleToolResult(session, event) {
    if (!config.events.toolAudit || disposed) return undefined;
    const toolName = extractToolName(event);
    if (!toolName) return undefined;
    const { key, sessionId, cwd } = identityOf(session);
    return runner.enqueue(
      key,
      safeTask(() =>
        invoke('tool_audit', sessionId, cwd, ['append', '--event', `tool:${toolName}`])
      )
    );
  }

  function handleSessionEvent(session, event) {
    try {
      if (!event || typeof event !== 'object') return undefined;
      if (event.type === 'tool/result') return handleToolResult(session, event);
      if (event.type !== 'user/message') return undefined;
      return handleUserMessage(session, event);
    } catch (error) {
      diagnose(ctx, `session/event handler failed: ${describeError(error)}`);
      return undefined;
    }
  }

  function clearFlushTimer(key) {
    const timer = state.flushTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    state.flushTimers.delete(key);
  }

  // AC10: `events.syncOnFlush` gates the debounced `memo sync`.
  function handleSessionFlush(session) {
    try {
      if (!config.events.syncOnFlush || disposed) return undefined;
      const { key, sessionId, cwd } = identityOf(session);
      if (!sessionId) {
        diagnose(ctx, 'session/flush without a session id; skipping debounced sync');
        return undefined;
      }
      if (state.ended.has(key)) return undefined;
      clearFlushTimer(key);
      const timer = setTimeout(() => {
        state.flushTimers.delete(key);
        if (disposed) return;
        runner.enqueue(
          key,
          safeTask(() => invoke('sync', sessionId, cwd, ['sync']))
        );
      }, config.debounceMs);
      timer.unref?.();
      state.flushTimers.set(key, timer);
      return undefined;
    } catch (error) {
      diagnose(ctx, `session/flush handler failed: ${describeError(error)}`);
      return undefined;
    }
  }

  // AC10: `events.sessionEnd` gates the whole `session/disposed` row
  // (`memo prompt session_end` + `memo sync`).
  function handleSessionDisposed(session) {
    try {
      const { key, sessionId, cwd } = identityOf(session);
      clearFlushTimer(key);
      state.started.delete(key);
      if (!config.events.sessionEnd || disposed) return undefined;
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
      diagnose(ctx, `session/disposed handler failed: ${describeError(error)}`);
      return undefined;
    }
  }

  // AC14: disposing the Cordis effect removes listeners, timers, and the
  // status tool. The bridge owns no durable state, so nothing is written.
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const key of [...state.flushTimers.keys()]) clearFlushTimer(key);
    try {
      statusDisposer?.();
    } catch {
      // Unregistering an already-gone tool is not an error.
    }
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {
        // A listener that is already gone is not an error.
      }
    }
    state.started.clear();
    state.ended.clear();
  }

  const subscriptions = [
    ['session/created', handleSessionCreated],
    ['session/event', handleSessionEvent],
    ['session/disposed', handleSessionDisposed],
    ['session/flush', handleSessionFlush]
  ];
  for (const [event, handler] of subscriptions) {
    try {
      const off = ctx.on(event, handler);
      if (typeof off === 'function') disposers.push(off);
    } catch (error) {
      diagnose(ctx, `failed to subscribe to ${event}: ${describeError(error)}`);
    }
  }
  try {
    const offDispose = ctx.on('dispose', dispose);
    if (typeof offDispose === 'function') disposers.push(offDispose);
  } catch {
    // The returned disposer is the primary teardown path.
  }

  return dispose;
}
