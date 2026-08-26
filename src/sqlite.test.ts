import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSqliteDatabase, resolveSqliteNativeBinding } from './sqlite.js';

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
