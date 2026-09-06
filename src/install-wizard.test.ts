import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  getInstallPreflight,
  normalizeInstallHosts,
  runInstallWizard
} from './install-wizard.js';

function markTty<T extends NodeJS.ReadableStream | NodeJS.WritableStream>(stream: T): T {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  return stream;
}

describe('install wizard', () => {
  it('normalizes aliases and requires explicit all permission', () => {
    assert.deepEqual(normalizeInstallHosts(['gemini', 'claude-code']), ['antigravity', 'claude']);
    assert.throws(() => normalizeInstallHosts('all'), /requires explicit confirmation/i);
    assert.deepEqual(normalizeInstallHosts('all', { allowAll: true }), [
      'cursor',
      'antigravity',
      'codex',
      'opencode',
      'claude'
    ]);
  });

  it('uses defaults and writes the plan to the supplied TTY output', async () => {
    const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-wizard-'));
    const input = markTty(new PassThrough());
    const outputLines: string[] = [];
    const output = markTty(new Writable({
      write(chunk, _encoding, callback) {
        outputLines.push(String(chunk));
        callback();
      }
    }));
    try {
      const selectionPromise = runInstallWizard({
        productRoot,
        commandName: 'install-hooks',
        input,
        output,
        preflight: {
          ok: true,
          platform: 'linux',
          memoCommand: 'memo',
          shellHookPrefix: '',
          chmodAttempted: true
        },
        previewPaths: () => ['/consumer/.cursor/hooks.json']
      });
      setTimeout(() => input.write('\n'), 0);
      setTimeout(() => input.write('\n'), 10);
      setTimeout(() => input.write('1\n'), 20);
      setTimeout(() => input.write('y\n'), 30);
      setTimeout(() => input.end(), 40);
      const selection = await selectionPromise;
      assert.deepEqual(selection?.scope, 'local');
      assert.deepEqual(selection?.conflictPolicy, 'update');
      assert.deepEqual(selection?.hosts, ['cursor']);
      assert.equal(selection?.confirmed, true);
      assert.match(outputLines.join(''), /Plan \(install-hooks\)/);
      assert.match(outputLines.join(''), /\/consumer\/\.cursor\/hooks\.json/);
    } finally {
      fs.rmSync(productRoot, { recursive: true, force: true });
    }
  });

  it('returns null for non-TTY streams without prompting', async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    });
    assert.equal(await runInstallWizard({
      productRoot: process.cwd(),
      commandName: 'install-skills',
      input,
      output
    }), null);
    input.destroy();
    output.destroy();
  });

  it('reports platform preflight and fallback warning when memo is unavailable', () => {
    const preflight = getInstallPreflight({
      platform: 'linux',
      pathEnv: '',
      cliPath: path.join(os.tmpdir(), 'missing-spec-memo-cli.js')
    });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.shellHookPrefix, '');
    assert.match(preflight.warning || '', /resolve memo/i);
  });
});
