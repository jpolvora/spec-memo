import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js';
import { apply } from '../lib/index.js';
import { createFakeContext, memoConfig, sessionFor } from './helpers/fake-ctx.js';

test('config defaults resolve to the documented values', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config, {
    enabled: true,
    memoCommand: ['memo'],
    vaultRoot: null,
    timeoutMs: 2000,
    debounceMs: 1500,
    queueLimit: 64,
    maxBodyBytes: 8000,
    events: {
      bootstrap: true,
      promptRecord: true,
      toolAudit: false,
      syncOnFlush: true,
      sessionEnd: true
    }
  });
  assert.equal(DEFAULT_CONFIG.memoCommand[0], 'memo');
});

test('config accepts a string command and partial event overrides', () => {
  const config = normalizeConfig({ memoCommand: 'node ./dist/cli.js', events: { toolAudit: true } });
  assert.deepEqual(config.memoCommand, ['node ./dist/cli.js']);
  assert.equal(config.events.toolAudit, true);
  assert.equal(config.events.bootstrap, true);
});

test('invalid config is rejected', () => {
  assert.throws(() => normalizeConfig({ timeoutMs: 0 }), TypeError);
  assert.throws(() => normalizeConfig({ debounceMs: -1 }), TypeError);
  assert.throws(() => normalizeConfig({ memoCommand: [] }), TypeError);
  assert.throws(() => normalizeConfig({ memoCommand: [42] }), TypeError);
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), TypeError);
  assert.throws(() => normalizeConfig({ events: { promptRecord: 'yes' } }), TypeError);
  assert.throws(() => normalizeConfig([]), TypeError);
});

test('apply disables the bridge with a diagnostic when config is invalid', () => {
  const fake = createFakeContext();
  assert.doesNotThrow(() => apply(fake.ctx, { timeoutMs: -5 }));
  assert.equal(fake.listenerCount('session/created'), 0);
  assert.match(fake.warnings[0], /^\[specmemo-bridge\] invalid configuration/);
});

test('apply is a no-op when the bridge is disabled', () => {
  const fake = createFakeContext();
  apply(fake.ctx, { enabled: false });
  assert.equal(fake.listenerCount('session/created'), 0);
  assert.equal(fake.listenerCount('session/event'), 0);
});

test('apply tolerates a missing tools service', async () => {
  const fake = createFakeContext({ tools: false });
  assert.doesNotThrow(() => apply(fake.ctx, memoConfig()));
  await fake.emit('session/created', sessionFor('s10'));
  assert.equal(fake.invocations.length, 2);
});
