import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import {
  createFakeContext,
  exitSpawn,
  memoConfig,
  sessionFor,
  TEST_MEMO_COMMAND,
  toolResult
} from './helpers/fake-ctx.js';

test('AC15: tool/result appends tool:<name> when auditing is enabled', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await fake.emit('session/event', sessionFor('s1', 'C:\\repo'), toolResult('read_file'));

  assert.deepEqual(
    fake.invocations.map((request) => request.argv),
    [[...TEST_MEMO_COMMAND, 'append', '--event', 'tool:read_file']]
  );
  assert.equal(fake.invocations[0].cwd, 'C:\\repo');

  const status = await fake.status();
  assert.equal(status.counters.tool_audit, 1);
  assert.equal(status.counters.failures, 0);
});

test('AC15: tool/result spawns nothing when auditing is disabled', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig());

  await fake.emit('session/event', sessionFor('s2'), toolResult('read_file'));

  assert.equal(fake.invocations.length, 0);
  assert.equal((await fake.status()).counters.tool_audit, 0);
});

test('AC15: a failing tool audit stays fail-open and is counted', async () => {
  const fake = createFakeContext({ spawn: exitSpawn(2) });
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await assert.doesNotReject(() =>
    fake.emit('session/event', sessionFor('s3'), toolResult('shell'))
  );

  const status = await fake.status();
  assert.equal(status.counters.tool_audit, 1);
  assert.equal(status.counters.failures, 1);
  assert.equal(status.lastError.command, 'tool_audit');
  assert.match(status.lastError.message, /failed/);
});

test('AC15: tool names are bounded before they reach argv', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await fake.emit('session/event', sessionFor('s4'), toolResult('x'.repeat(500)));

  const eventArgument = fake.invocations[0].argv.at(-1);
  assert.ok(eventArgument.startsWith('tool:'));
  assert.ok(eventArgument.length <= 'tool:'.length + 64, 'tool names must be bounded');
  assert.equal(/[\r\n]/.test(eventArgument), false);
});

test('AC15: tool results without a name are ignored', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await fake.emit('session/event', sessionFor('s5'), { type: 'tool/result', data: { status: 'ok' } });

  assert.equal(fake.invocations.length, 0);
});

test('AC15: tool results without a session id are skipped with a diagnostic', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await fake.emit('session/event', { header: {} }, toolResult('read_file'));

  assert.equal(fake.invocations.length, 0, 'no orphan append may be spawned');
  assert.ok(fake.warnings.some((line) => /tool\/result without a session id/.test(line)));
});
