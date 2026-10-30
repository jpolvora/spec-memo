import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { discoverMemoCommand } from '../lib/discovery.js';
import { apply } from '../lib/index.js';
import {
  createFakeContext,
  sessionFor,
  userMessage,
  withoutMemoExecutable
} from './helpers/fake-ctx.js';

test('AC11: an explicitly configured command wins over env, PATH, and productRoot', () => {
  const checked = [];
  const result = discoverMemoCommand({
    configuredCommand: ['custom-memo'],
    env: { PATH: '/usr/bin', SPEC_MEMO_MEMO: '/opt/memo/bin/memo' },
    productRoot: '/vault',
    platform: 'linux',
    fileExists: (candidate) => {
      checked.push(candidate);
      return candidate === '/usr/bin/custom-memo';
    }
  });

  assert.deepEqual(result, { argv: ['custom-memo'], source: 'config' });
  assert.deepEqual(checked, ['/usr/bin/custom-memo']);
});

test('AC11: SPEC_MEMO_MEMO is used when the configured command does not resolve', () => {
  const result = discoverMemoCommand({
    configuredCommand: ['missing-memo'],
    env: { PATH: '/usr/bin', SPEC_MEMO_MEMO: '/opt/memo/bin/memo' },
    platform: 'linux',
    fileExists: (candidate) => candidate === '/opt/memo/bin/memo'
  });

  assert.deepEqual(result, { argv: ['/opt/memo/bin/memo'], source: 'env' });
});

test('AC11: memo on PATH is used when no config or env command resolves', () => {
  const result = discoverMemoCommand({
    env: { PATH: '/usr/bin:/usr/local/bin', SPEC_MEMO_MEMO: '/missing/memo' },
    platform: 'linux',
    fileExists: (candidate) => candidate === '/usr/local/bin/memo'
  });

  assert.deepEqual(result, { argv: ['memo'], source: 'path' });
});

test('AC11: node <productRoot>/dist/cli.js is the last discovery candidate', () => {
  const result = discoverMemoCommand({
    env: { PATH: '/usr/bin' },
    productRoot: '/vault',
    platform: 'linux',
    nodeCommand: '/usr/bin/node',
    fileExists: (candidate) => candidate === '/vault/dist/cli.js'
  });

  assert.deepEqual(result, { argv: ['/usr/bin/node', '/vault/dist/cli.js'], source: 'product-cli' });
});

test('AC11: vaultRoot alone does not provide the node fallback', () => {
  const result = discoverMemoCommand({
    env: { PATH: '/usr/bin' },
    vaultRoot: '/vault',
    platform: 'linux',
    nodeCommand: '/usr/bin/node',
    fileExists: (candidate) => candidate === '/vault/dist/cli.js'
  });

  assert.equal(result, null, 'the vault data root is not a product checkout');
});

test('AC11: the node fallback probes readability, not execute permission', () => {
  const probes = [];
  const result = discoverMemoCommand({
    env: { PATH: '/usr/bin' },
    productRoot: '/vault',
    platform: 'linux',
    nodeCommand: '/usr/bin/node',
    fileExists: (candidate, options) => {
      probes.push([candidate, options]);
      return candidate === '/vault/dist/cli.js';
    }
  });

  assert.deepEqual(result, { argv: ['/usr/bin/node', '/vault/dist/cli.js'], source: 'product-cli' });
  const probe = probes.find(([candidate]) => candidate === '/vault/dist/cli.js');
  assert.deepEqual(probe[1], { executable: false });
});

test('AC11: discovery returns null when nothing resolves', () => {
  assert.equal(
    discoverMemoCommand({ env: {}, productRoot: null, platform: 'linux', fileExists: () => false }),
    null
  );
});

test('AC11: a missing memo executable disables the bridge with one diagnostic', async () => {
  let spawnCalls = 0;
  const fake = createFakeContext({
    spawn: () => {
      spawnCalls += 1;
      return { done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {} };
    }
  });

  await withoutMemoExecutable(async () => {
    assert.doesNotThrow(() => apply(fake.ctx, {}));
  });

  assert.equal(fake.warnings.length, 1, 'exactly one diagnostic must be recorded');
  assert.match(fake.warnings[0], /^\[specmemo-bridge\] memo executable not found/);
  for (const event of ['session/created', 'session/event', 'session/flush', 'session/disposed']) {
    assert.equal(fake.listenerCount(event), 0, `${event} must not be subscribed`);
  }
  assert.equal(fake.registeredTools.length, 0);

  await fake.emit('session/created', sessionFor('m1'));
  await fake.emit('session/event', sessionFor('m1'), userMessage('ignored'));
  await sleep(30);

  assert.equal(spawnCalls, 0, 'a disabled bridge must never spawn memo');
  assert.equal(fake.invocations.length, 0);
  assert.equal(fake.warnings.length, 1, 'the bridge must not retry or repeat the diagnostic');
});
