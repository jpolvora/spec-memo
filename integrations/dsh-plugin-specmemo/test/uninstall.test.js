import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { createFakeContext, memoConfig, sessionFor, userMessage } from './helpers/fake-ctx.js';

/** Recursive name+content snapshot used to prove the bridge writes nothing. */
function snapshot(root) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        entries.push(`dir:${name}`);
        walk(full);
      } else {
        entries.push(`file:${name}:${readFileSync(full, 'utf8')}`);
      }
    }
  };
  walk(root);
  return entries;
}

function workspacePair() {
  const workRoot = mkdtempSync(join(tmpdir(), 'specmemo-work-'));
  const vaultRoot = mkdtempSync(join(tmpdir(), 'specmemo-vault-'));
  writeFileSync(join(workRoot, 'sentinel.txt'), 'untouched working tree');

  mkdirSync(join(vaultRoot, 'projects'));
  writeFileSync(join(vaultRoot, 'config.json'), '{"keep":true}');
  writeFileSync(join(vaultRoot, 'projects', 'record.md'), '{"keep":"record"}');

  return {
    workRoot,
    vaultRoot,
    cleanup() {
      rmSync(workRoot, { recursive: true, force: true });
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  };
}

test('AC14: disposing the Cordis effect removes listeners and timers without writing files', async () => {
  const { workRoot, vaultRoot, cleanup } = workspacePair();
  try {
    const beforeWork = snapshot(workRoot);
    const beforeVault = snapshot(vaultRoot);

    const fake = createFakeContext();
    const dispose = apply(fake.ctx, memoConfig({ vaultRoot, debounceMs: 15 }));
    assert.equal(typeof dispose, 'function', 'apply must hand back a Cordis disposer');

    const session = sessionFor('s-uninstall', workRoot);
    await fake.emit('session/created', session);
    await fake.emit('session/event', session, userMessage('remember this turn'));
    fake.dispatch('session/flush', session);
    assert.equal(fake.listenerCount('session/created'), 1);
    assert.equal(fake.registeredTools.length, 1);

    dispose();

    for (const event of ['session/created', 'session/event', 'session/flush', 'session/disposed', 'dispose']) {
      assert.equal(fake.listenerCount(event), 0, `${event} listeners must be removed`);
    }
    assert.equal(fake.registeredTools.length, 0, 'the status tool must be unregistered');

    await sleep(60);
    const syncs = fake.invocations.filter((request) => request.argv.includes('sync'));
    assert.equal(syncs.length, 0, 'the pending flush timer must be cleared on dispose');

    assert.deepEqual(snapshot(workRoot), beforeWork, 'dispose must not write into the working tree');
    assert.deepEqual(snapshot(vaultRoot), beforeVault, 'dispose must never touch vault files');

    assert.doesNotThrow(() => dispose(), 'disposing twice must be safe');
  } finally {
    cleanup();
  }
});

test('AC14: the host dispose lifecycle event also tears the bridge down', async () => {
  const fake = createFakeContext();
  apply(fake.ctx, memoConfig({ debounceMs: 10 }));

  fake.dispatch('session/flush', sessionFor('s-lifecycle'));
  await sleep(2);
  await fake.emit('dispose');

  assert.equal(fake.listenerCount('session/created'), 0);
  assert.equal(fake.listenerCount('session/event'), 0);
  assert.equal(fake.listenerCount('dispose'), 0);

  await sleep(50);
  assert.equal(fake.invocations.length, 0, 'no timer may fire after the host dispose event');
});
