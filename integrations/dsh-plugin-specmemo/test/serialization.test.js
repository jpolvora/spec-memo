import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../lib/index.js';
import {
  createFakeContext,
  memoConfig,
  sessionFor,
  TEST_MEMO_COMMAND,
  toolResult,
  userMessage
} from './helpers/fake-ctx.js';

/**
 * Spawn stub that records command order and the peak number of concurrent
 * children. Each child settles after a short delay so a second invocation
 * would overlap if the queue did not serialize it.
 */
function trackingSpawn(delayMs = 12) {
  const state = { active: 0, maxActive: 0, order: [] };
  const spawn = (request) => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.order.push(request.argv.slice(TEST_MEMO_COMMAND.length).join(' '));
    const done = sleep(delayMs).then(() => {
      state.active -= 1;
      return { exitCode: 0, signal: null };
    });
    return {
      done,
      terminate() {
        state.active -= 1;
      }
    };
  };
  return { spawn, state };
}

test('AC9: two rapid user messages run strictly one after another', async () => {
  const { spawn, state } = trackingSpawn();
  const fake = createFakeContext({ spawn });
  apply(fake.ctx, memoConfig());

  const session = sessionFor('s1', 'C:\\repo');
  await Promise.all([
    ...fake.dispatch('session/created', session),
    ...fake.dispatch('session/event', session, userMessage('first message')),
    ...fake.dispatch('session/event', session, userMessage('second message'))
  ]);

  assert.equal(state.maxActive, 1, 'memo invocations must never overlap within a session');
  assert.equal(state.active, 0);
  assert.deepEqual(state.order, [
    'bootstrap --cwd C:\\repo --session-id dsh-s1',
    'prompt session_start --session-id dsh-s1 --cwd C:\\repo',
    'prompt record --session-id dsh-s1 --body first message',
    'prompt record --session-id dsh-s1 --body second message'
  ]);

  const status = await fake.status();
  assert.equal(status.queueDepth, 0);
  assert.equal(status.counters.bootstrap, 1);
  assert.equal(status.counters.session_start, 1);
  assert.equal(status.counters.prompt_record, 2);
});

test('AC9: created, message, tool, flush, and disposed run in session-event order', async () => {
  const { spawn, state } = trackingSpawn(10);
  const fake = createFakeContext({ spawn });
  apply(fake.ctx, memoConfig({ debounceMs: 10, events: { toolAudit: true } }));

  const session = sessionFor('s2', 'C:\\repo');
  await Promise.all([
    ...fake.dispatch('session/created', session),
    ...fake.dispatch('session/event', session, userMessage('audit this')),
    ...fake.dispatch('session/event', session, toolResult('read_file')),
    ...fake.dispatch('session/flush', session),
    ...fake.dispatch('session/disposed', session)
  ]);

  // A trailing sync from the flush timer would surface here if dispose had not
  // cleared the timer, so wait past the debounce window.
  await sleep(40);

  assert.equal(state.maxActive, 1, 'memo invocations must never overlap within a session');
  assert.deepEqual(state.order, [
    'bootstrap --cwd C:\\repo --session-id dsh-s2',
    'prompt session_start --session-id dsh-s2 --cwd C:\\repo',
    'prompt record --session-id dsh-s2 --body audit this',
    'append --event tool:read_file',
    'prompt session_end --session-id dsh-s2',
    'sync'
  ]);
  const status = await fake.status();
  assert.equal(status.counters.bootstrap, 1);
  assert.equal(status.counters.session_start, 1);
  assert.equal(status.counters.prompt_record, 1);
  assert.equal(status.counters.tool_audit, 1);
  assert.equal(status.counters.session_end, 1);
  assert.equal(status.counters.sync, 1);
});
