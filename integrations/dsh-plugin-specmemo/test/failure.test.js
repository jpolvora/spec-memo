import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, exitSpawn, sessionFor, userMessage } from './helpers/fake-ctx.js';

test('AC8: a non-zero exit is counted and diagnosed without failing the turn', async () => {
  const fake = createFakeContext({ spawn: exitSpawn(2) });
  apply(fake.ctx, {});

  await assert.doesNotReject(() =>
    fake.emit('session/event', sessionFor('s8'), userMessage('token-shaped secret prompt text'))
  );

  const status = await fake.status();
  assert.equal(status.counters.prompt_record, 1);
  assert.equal(status.counters.failures, 1);
  assert.equal(status.lastError.command, 'prompt_record');
  assert.equal(status.lastError.sessionId, 'dsh:s8');
  assert.match(status.lastError.message, /failed/);
  assert.ok(fake.warnings.length >= 1);
  assert.match(fake.warnings[0], /^\[specmemo-bridge\]/);
});

test('AC8: diagnostics never contain the prompt body', async () => {
  const fake = createFakeContext({ spawn: exitSpawn(1) });
  apply(fake.ctx, {});
  await fake.emit('session/event', sessionFor('s8'), userMessage('super-secret-prompt-body'));

  const diagnostics = fake.warnings.join('\n');
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics.includes('super-secret-prompt-body'), false);
});

test('AC8: spawn errors are swallowed and the next invocation still runs', async () => {
  let calls = 0;
  const fake = createFakeContext({
    spawn: () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('spawn memo ENOENT'), { code: 'ENOENT' });
      return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} };
    }
  });
  apply(fake.ctx, {});

  const session = sessionFor('s9');
  await assert.doesNotReject(() => fake.emit('session/event', session, userMessage('first')));
  await assert.doesNotReject(() => fake.emit('session/event', session, userMessage('second')));

  assert.equal(calls, 2);
  const status = await fake.status();
  assert.equal(status.counters.failures, 1);
  assert.equal(status.counters.prompt_record, 2);
  assert.equal(status.lastError.command, 'prompt_record');
});
