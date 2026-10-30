import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, sessionFor, userMessage } from './helpers/fake-ctx.js';

test('AC3: user/message records the prompt body for the session', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, {});
  await fake.emit('session/event', sessionFor('s2', 'C:\\repo'), userMessage('please remember this'));

  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [['memo', 'prompt', 'record', '--session-id', 'dsh:s2', '--body', 'please remember this']]
  );
  assert.equal(fake.invocations[0].cwd, 'C:\\repo');
});

test('AC3: non user/message session events are ignored', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, {});
  await fake.emit('session/event', sessionFor('s2'), { type: 'tool/result', data: { text: 'ignored' } });
  assert.equal(fake.invocations.length, 0);
});

test('AC3: message content parts are flattened into the body', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, {});
  await fake.emit(
    'session/event',
    sessionFor('s2'),
    { type: 'user/message', data: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] } }
  );
  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [['memo', 'prompt', 'record', '--session-id', 'dsh:s2', '--body', 'hello world']]
  );
});

test('AC3: prompt bodies are truncated to maxBodyBytes', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, { maxBodyBytes: 5 });
  await fake.emit('session/event', sessionFor('s2'), userMessage('0123456789'));
  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [['memo', 'prompt', 'record', '--session-id', 'dsh:s2', '--body', '01234']]
  );
});
