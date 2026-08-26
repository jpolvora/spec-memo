import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
type SqliteConstructor = {
  new (filename?: string | Buffer, options?: Database.Options): Database.Database;
};
const Sqlite = require('better-sqlite3') as SqliteConstructor;

/**
 * Resolve better-sqlite3.node from the installed package directory.
 * Do not use the `bindings` stack-trace walker: ESM + a client-injected cwd
 * (MCP SSE from another machine) makes it search the product tree, not node_modules.
 */
export function resolveSqliteNativeBinding(): string {
  const pkgDir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const candidates = [
    path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node'),
    path.join(pkgDir, 'build', 'Debug', 'better_sqlite3.node')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate better-sqlite3 native binding next to ${pkgDir}. Run npm rebuild better-sqlite3.`
  );
}

let cachedBinding: string | undefined;

export function createSqliteDatabase(
  filename: string,
  options: Database.Options = {}
): Database.Database {
  const nativeBinding = options.nativeBinding ?? cachedBinding ?? (cachedBinding = resolveSqliteNativeBinding());
  return new Sqlite(filename, { ...options, nativeBinding });
}
