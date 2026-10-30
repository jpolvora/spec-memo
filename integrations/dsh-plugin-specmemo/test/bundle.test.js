import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('AC1: the bundle declares the DSH patch and entry point', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-plugin-specmemo');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'lib/index.js');
  assert.deepEqual(manifest.dsh, { bundle: { patch: './cordis.patch.yml' } });
});

test('AC1: cordis.patch.yml inserts exactly one host row', () => {
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  assert.equal((patch.match(/^\s*-\s*insert:\s*$/gm) ?? []).length, 1);
  assert.equal((patch.match(/^\s*-\s*id:\s*specmemo-bridge\s*$/gm) ?? []).length, 1);
  assert.equal((patch.match(/^\s*name:\s*dsh-plugin-specmemo\s*$/gm) ?? []).length, 1);
  assert.equal((patch.match(/^\s*-\s*id:/gm) ?? []).length, 1);
});

test('AC1: the entry exports Cordis plugin metadata', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(plugin.name, 'specmemo-bridge');
  assert.deepEqual(plugin.inject, ['subprocess', 'sessions']);
  assert.equal(typeof plugin.apply, 'function');
});
