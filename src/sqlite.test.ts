import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  assertSupportedNodeRuntime,
  createSqliteDatabase,
  isSqliteAbiMismatch,
  resolveSqliteNativeBinding,
  wrapSqliteOpenError
} from './sqlite.js';

describe('SQLite native binding loader', () => {
  it('resolves better-sqlite3.node from the package, not process.cwd()', () => {
    const binding = resolveSqliteNativeBinding();
    assert.equal(path.basename(binding), 'better_sqlite3.node');
    assert.ok(fs.existsSync(binding));
    const normalized = binding.replace(/\\/g, '/');
    assert.ok(
      normalized.includes('node_modules/better-sqlite3/'),
      `expected package-relative binding, got ${binding}`
    );
  });

  it('opens a database after chdir to a directory with no node_modules', () => {
    const origCwd = process.cwd();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-sqlite-cwd-'));
    const dbFile = path.join(emptyDir, 'memo.sqlite');
    try {
      process.chdir(emptyDir);
      const db = createSqliteDatabase(dbFile);
      try {
        const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
        assert.equal(row.ok, 1);
      } finally {
        db.close();
      }
    } finally {
      process.chdir(origCwd);
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('SQLite ABI mismatch and Node engines', () => {
  it('detects NODE_MODULE_VERSION mismatch messages', () => {
    const err = new Error(
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.'
    );
    assert.equal(isSqliteAbiMismatch(err), true);
    assert.equal(isSqliteAbiMismatch(new Error('SQLITE_ERROR: no such table')), false);
  });

  it('wraps ABI errors with npm rebuild and doctor --rebuild guidance', () => {
    const err = new Error(
      'The module \'better_sqlite3.node\' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
    );
    const wrapped = wrapSqliteOpenError(err);
    assert.ok(wrapped.message.includes('npm rebuild better-sqlite3'));
    assert.ok(wrapped.message.includes('memo doctor --rebuild'));
    assert.ok(wrapped.message.includes('NODE_MODULE_VERSION'));
    const again = wrapSqliteOpenError(wrapped);
    assert.equal(again.message, wrapped.message);
  });

  it('accepts Node 22 and 24 and rejects Node below 22', () => {
    assert.doesNotThrow(() => assertSupportedNodeRuntime('22.13.9'));
    assert.doesNotThrow(() => assertSupportedNodeRuntime('24.16.0'));
    assert.throws(() => assertSupportedNodeRuntime('20.19.0'), /requires Node.js >= 22/);
    assert.throws(() => assertSupportedNodeRuntime('18.20.0'), /requires Node.js >= 22/);
  });
});
