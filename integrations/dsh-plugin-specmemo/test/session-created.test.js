import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, memoConfig, sessionFor, TEST_MEMO_COMMAND } from './helpers/fake-ctx.js';

test('AC2: session/created bootstraps the session cwd before session_start', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());

  assert.equal(fake.listenerCount('session/created'), 1);
  await fake.emit('session/created', sessionFor('s1', 'C:\\repo'));

  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [
      [...TEST_MEMO_COMMAND, 'bootstrap', '--cwd', 'C:\\repo', '--session-id', 'dsh-s1'],
      [...TEST_MEMO_COMMAND, 'prompt', 'session_start', '--session-id', 'dsh-s1', '--cwd', 'C:\\repo']
    ]
  );
  assert.equal(fake.invocations[0].cwd, 'C:\\repo');
  assert.equal(fake.invocations[0].stdio.stdin, 'ignore');
  assert.equal(typeof fake.invocations[0].signal?.aborted, 'boolean');
});

test('AC2: duplicate session/created runs bootstrap once per live session', async () => {  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());
  const session = sessionFor('s1', 'C:\\repo');

  await fake.emit('session/created', session);
  await fake.emit('session/created', session);

  assert.equal(fake.invocations.length, 2, 'the second created event must not repeat the handshake');
  assert.deepEqual(
    fake.invocations.map((request) => request.argv[1] ?? request.argv[0]),
    ['bootstrap', 'prompt']
  );
});

test('AC2: session ids are filesystem-safe on Windows', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());
  await fake.emit('session/created', sessionFor('s1', 'C:\\repo'));

  const sessionIds = fake.invocations
    .flatMap((request) => request.argv)
    .filter((arg) => typeof arg === 'string' && arg.startsWith('dsh-'));
  assert.ok(sessionIds.length > 0, 'the prefixed session id must reach the memo argv');
  for (const id of sessionIds) {
    assert.doesNotMatch(id, /[<>:"/\\|?*]/, `reserved Windows filename character in ${id}`);
  }
});

test('AC2: hostile session ids are sanitized before they reach the vault', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());
  await fake.emit('session/created', sessionFor('../../evil id\n', 'C:\\repo'));

  const sessionIds = fake.invocations
    .flatMap((request) => request.argv)
    .filter((arg) => typeof arg === 'string' && arg.startsWith('dsh-'));
  assert.ok(sessionIds.length > 0);
  for (const id of sessionIds) {
    assert.match(id, /^dsh-[A-Za-z0-9_-]+$/);
    assert.equal(id.includes('..'), false);
    assert.equal(id.includes('/'), false);
  }
});
