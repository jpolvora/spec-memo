import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, sessionFor, waitFor } from './helpers/fake-ctx.js';

test('AC5: session/flush syncs once on the trailing edge of the debounce', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, { debounceMs: 40 });
  const session = sessionFor('s4', 'C:\\repo');

  fake.dispatch('session/flush', session);
  fake.dispatch('session/flush', session);
  fake.dispatch('session/flush', session);

  assert.equal(fake.invocations.length, 0, 'no sync may run before the debounce elapses');
  assert.equal(await waitFor(() => fake.invocations.length === 1), true);
  assert.deepEqual(fake.invocations[0].argv, ['memo', 'sync']);

  await sleep(80);
  assert.equal(fake.invocations.length, 1, 'burst flush events must collapse into one sync');
  const status = await fake.status();
  assert.equal(status.counters.sync, 1);
});
