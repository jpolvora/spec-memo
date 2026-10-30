import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../lib/index.js';
import {
  createFakeContext,
  memoConfig,
  sessionFor,
  toolResult,
  userMessage
} from './helpers/fake-ctx.js';

test('AC10: events.bootstrap=false skips the session/created handshake', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { bootstrap: false } }));

  await fake.emit('session/created', sessionFor('t1', 'C:\\repo'));

  assert.equal(fake.invocations.length, 0, 'no subprocess may be spawned for a disabled event');
  const status = await fake.status();
  assert.equal(status.counters.bootstrap, 0);
  assert.equal(status.counters.session_start, 0);

  // Other rows stay enabled; disabling one toggle must not disable the bridge.
  await fake.emit('session/event', sessionFor('t1', 'C:\\repo'), userMessage('still recorded'));
  assert.equal(fake.invocations.length, 1);
  assert.equal((await fake.status()).counters.prompt_record, 1);
});

test('AC10: events.promptRecord=false skips prompt record invocations', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { promptRecord: false } }));

  await fake.emit('session/event', sessionFor('t2'), userMessage('must not be recorded'));

  assert.equal(fake.invocations.length, 0);
  assert.equal((await fake.status()).counters.prompt_record, 0);
});

test('AC10: events.toolAudit=false skips tool result invocations', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { toolAudit: false } }));

  await fake.emit('session/event', sessionFor('t3'), toolResult('read_file'));

  assert.equal(fake.invocations.length, 0);
  assert.equal((await fake.status()).counters.tool_audit, 0);
});

test('AC10: events.syncOnFlush=false skips the debounced sync', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ debounceMs: 10, events: { syncOnFlush: false } }));

  fake.dispatch('session/flush', sessionFor('t4'));
  await sleep(60);

  assert.equal(fake.invocations.length, 0, 'no sync timer may be armed when the toggle is off');
  assert.equal((await fake.status()).counters.sync, 0);
});

test('AC10: events.sessionEnd=false skips session_end and its trailing sync', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { sessionEnd: false } }));

  await fake.emit('session/disposed', sessionFor('t5'));

  assert.equal(fake.invocations.length, 0);
  const status = await fake.status();
  assert.equal(status.counters.session_end, 0);
  assert.equal(status.counters.sync, 0);
});
