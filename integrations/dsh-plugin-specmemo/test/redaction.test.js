import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { MAX_DIAGNOSTIC_LENGTH, redactText } from '../lib/redact.js';
import {
  createFakeContext,
  exitSpawn,
  memoConfig,
  sessionFor,
  toolResult,
  userMessage
} from './helpers/fake-ctx.js';

const TOKEN = 'sk-live-abcdefgh12345678';
const ASSIGNMENT_SECRET = 'supersecretvalue';

function assertNoSecrets(text) {
  for (const forbidden of [TOKEN, 'abcdefgh12345678', ASSIGNMENT_SECRET, '--body', '--session-id']) {
    assert.equal(text.includes(forbidden), false, `diagnostic leaked ${forbidden}`);
  }
}

test('AC13: redactText masks credential shapes', () => {
  const bearer = redactText('Authorization: Bearer abcdefghijklmnop');
  assert.equal(bearer.includes('abcdefghijklmnop'), false);

  const keyed = redactText('api_key=abcdef123456');
  assert.equal(keyed.includes('abcdef123456'), false);

  const envStyle = redactText('SPEC_MEMO_SSE_TOKEN=abcdef123456');
  assert.equal(envStyle.includes('abcdef123456'), false);

  const github = redactText('push failed for ghp_abcdefghijklmnopqrstuvwxyz');
  assert.equal(github.includes('ghp_abcdefghijklmnopqrstuvwxyz'), false);

  const openai = redactText(`call failed with ${TOKEN}`);
  assert.equal(openai.includes(TOKEN), false);
});

test('AC13: redactText caps diagnostic length and collapses line breaks', () => {
  const long = redactText(`start ${'x'.repeat(1000)} end`);
  assert.ok(long.length <= MAX_DIAGNOSTIC_LENGTH, `length ${long.length} exceeds the cap`);
  assert.equal(redactText('line one\nline two\r\nline three').includes('\n'), false);
});

test('AC13: prompt bodies never reach logs or status', async () => {
  const fake = createFakeContext({ spawn: exitSpawn(1) });
  apply(fake.ctx, memoConfig());

  const body = `please use Bearer ${TOKEN} and token=${ASSIGNMENT_SECRET}`;
  await assert.doesNotReject(() =>
    fake.emit('session/event', sessionFor('s8'), userMessage(body))
  );

  assert.ok(fake.warnings.length >= 1);
  const logs = fake.warnings.join('\n');
  assertNoSecrets(logs);
  assert.equal(logs.includes(body), false, 'the prompt body must never be logged');

  const status = await fake.status();
  assert.equal(status.counters.prompt_record, 1);
  assert.equal(status.counters.failures, 1);
  assertNoSecrets(JSON.stringify(status));
  assertNoSecrets(JSON.stringify(status.lastError));
});

test('AC13: tool arguments and results never reach logs', async () => {
  const fake = createFakeContext({ spawn: exitSpawn(1) });
  apply(fake.ctx, memoConfig({ events: { toolAudit: true } }));

  await fake.emit(
    'session/event',
    sessionFor('s9'),
    toolResult('shell', {
      args: { command: `curl -H "Authorization: Bearer ${TOKEN}" https://example.test` }
    })
  );

  const logs = fake.warnings.join('\n');
  assert.equal(logs.includes('curl'), false, 'tool arguments must not be logged');
  assertNoSecrets(logs);
  assertNoSecrets(JSON.stringify(await fake.status()));
});
