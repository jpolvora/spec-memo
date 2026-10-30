import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, memoConfig, sessionFor, TEST_MEMO_COMMAND } from './helpers/fake-ctx.js';

test('AC4: session/disposed ends the session then syncs', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());

  await fake.emit('session/disposed', sessionFor('s3', 'C:\\repo'));

  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [
      [...TEST_MEMO_COMMAND, 'prompt', 'session_end', '--session-id', 'dsh-s3'],
      [...TEST_MEMO_COMMAND, 'sync']
    ]
  );
  assert.equal(fake.invocations[0].cwd, 'C:\\repo');
});
