import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, sessionFor } from './helpers/fake-ctx.js';

test('AC2: session/created bootstraps the session cwd before session_start', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, {});

  assert.equal(fake.listenerCount('session/created'), 1);
  await fake.emit('session/created', sessionFor('s1', 'C:\\repo'));

  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [
      ['memo', 'bootstrap', '--cwd', 'C:\\repo', '--session-id', 'dsh:s1'],
      ['memo', 'prompt', 'session_start', '--session-id', 'dsh:s1', '--cwd', 'C:\\repo']
    ]
  );
  assert.equal(fake.invocations[0].cwd, 'C:\\repo');
  assert.equal(fake.invocations[0].stdio.stdin, 'ignore');
  assert.equal(typeof fake.invocations[0].signal?.aborted, 'boolean');
});

test('AC2: duplicate session/created runs bootstrap once per live session', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, {});
  const session = sessionFor('s1', 'C:\\repo');

  await fake.emit('session/created', session);
  await fake.emit('session/created', session);

  assert.equal(fake.invocations.length, 2, 'the second created event must not repeat the handshake');
  assert.deepEqual(
    fake.invocations.map((request) => request.argv[1] ?? request.argv[0]),
    ['bootstrap', 'prompt']
  );
});
