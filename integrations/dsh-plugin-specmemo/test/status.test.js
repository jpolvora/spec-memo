import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../lib/index.js';
import {
  createFakeContext,
  memoConfig,
  sessionFor,
  stalledSpawn,
  userMessage
} from './helpers/fake-ctx.js';

const STATUS_KEYS = ['counters', 'enabled', 'lastError', 'lastInvocationAt', 'queueDepth'];

test('AC12: specmemo_bridge_status exposes the documented read-only payload', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());

  const tool = fake.registeredTools.find((candidate) => candidate.name === 'specmemo_bridge_status');
  assert.ok(tool, 'the status tool must be registered');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.parameters.type, 'object');

  const initial = await fake.status();
  assert.deepEqual(Object.keys(initial).sort(), STATUS_KEYS);
  assert.equal(initial.enabled, true);
  assert.equal(initial.queueDepth, 0);
  assert.equal(initial.lastError, null);
  assert.equal(initial.lastInvocationAt, null);
  assert.equal(Object.values(initial.counters).every((value) => value === 0), true);

  await fake.emit('session/created', sessionFor('s1'));

  const after = await fake.status();
  assert.equal(after.enabled, true);
  assert.equal(after.queueDepth, 0);
  assert.equal(after.counters.bootstrap, 1);
  assert.equal(after.counters.session_start, 1);
  assert.equal(after.lastError, null);
  assert.match(after.lastInvocationAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('AC12: the status payload is a copy and cannot mutate bridge state', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());
  await fake.emit('session/created', sessionFor('s2'));

  const first = await fake.status();
  first.counters.bootstrap = 99;
  first.enabled = false;

  const second = await fake.status();
  assert.equal(second.counters.bootstrap, 1, 'the status tool is read-only');
  assert.equal(second.enabled, true);
});

test('AC12: queueDepth reports a running invocation and returns to zero', async () => {
  const fake = createFakeContext({ spawn: stalledSpawn() });
  apply(fake.ctx, memoConfig({ timeoutMs: 40 }));

  const pending = fake.emit('session/event', sessionFor('s3'), userMessage('slow'));
  await sleep(10);

  const during = await fake.status();
  assert.equal(during.queueDepth, 1, 'the in-flight invocation must be visible as queue depth');

  await pending;
  const settled = await fake.status();
  assert.equal(settled.queueDepth, 0);
  assert.equal(settled.counters.timeouts, 1);
  assert.equal(settled.lastError.command, 'prompt_record');
});

test('AC12: registration is optional-safe when the host has no tools service', async () => {
  const fake = createFakeContext({ tools: false });
  assert.doesNotThrow(() => apply(fake.ctx, memoConfig()));
  assert.equal(fake.registeredTools.length, 0);
  assert.equal(await fake.status(), undefined);

  await fake.emit('session/created', sessionFor('s4'));
  assert.equal(fake.invocations.length, 2, 'the bridge still mirrors events without a tools service');
});
