import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, sessionFor, stalledSpawn, userMessage } from './helpers/fake-ctx.js';

test('AC6: every memo invocation is bounded by the configured timeout', async () => {
  const fake = createFakeContext({ spawn: stalledSpawn() });
  apply(fake.ctx, { timeoutMs: 30 });

  const startedAt = Date.now();
  await fake.emit('session/event', sessionFor('s5'), userMessage('stall please'));
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 25, `invocation returned after ${elapsed}ms, before the 30ms timeout`);
  assert.ok(elapsed < 1000, `invocation took ${elapsed}ms, so it was not bounded`);

  const status = await fake.status();
  assert.equal(status.counters.timeouts, 1);
  assert.equal(status.counters.failures, 1);
});

test('AC7: a timed out memo invocation terminates the child process', async () => {
  const terminations = [];
  let signal;
  const fake = createFakeContext({
    spawn: stalledSpawn({
      onSpawn: (request) => {
        signal = request.signal;
      },
      onTerminate: () => terminations.push(Date.now())
    })
  });
  apply(fake.ctx, { timeoutMs: 25 });

  await fake.emit('session/event', sessionFor('s6'), userMessage('stall please'));

  assert.equal(terminations.length, 1, 'the timed out child must be terminated');
  assert.equal(signal.aborted, true, 'the invocation signal must be aborted');
});

test('AC6: a spawn that never settles is still bounded', async () => {
  const fake = createFakeContext({ spawn: () => new Promise(() => {}) });
  apply(fake.ctx, { timeoutMs: 25 });

  const startedAt = Date.now();
  await fake.emit('session/event', sessionFor('s11'), userMessage('stall please'));
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 20, `invocation returned after ${elapsed}ms, before the 25ms timeout`);
  assert.ok(elapsed < 1000, `invocation took ${elapsed}ms, so it was not bounded`);
  const status = await fake.status();
  assert.equal(status.counters.timeouts, 1);
});

test('AC6/AC7: the queue keeps running after a timed out invocation', async () => {
  let calls = 0;
  const stalling = stalledSpawn();
  const fake = createFakeContext({
    spawn: (request) => {
      calls += 1;
      if (calls === 1) return stalling(request);
      return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} };
    }
  });
  apply(fake.ctx, { timeoutMs: 25 });

  await fake.emit('session/created', sessionFor('s7'));

  assert.equal(fake.invocations.length, 2, 'session_start must still run after bootstrap timed out');
  const status = await fake.status();
  assert.equal(status.counters.timeouts, 1);
  assert.equal(status.counters.session_start, 1);
  assert.equal(status.counters.bootstrap, 1);
});
