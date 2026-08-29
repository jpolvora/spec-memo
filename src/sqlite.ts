import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
type SqliteConstructor = {
  new (filename?: string | Buffer, options?: Database.Options): Database.Database;
};
const Sqlite = require('better-sqlite3') as SqliteConstructor;

export const MIN_NODE_MAJOR = 22;

export const SQLITE_ABI_REBUILD_HINT =
  'better-sqlite3 native module ABI mismatch for this Node.js version. Install compile tools if needed (Debian/Ubuntu: apt install build-essential), then run npm rebuild better-sqlite3 and memo doctor --rebuild.';

export function assertSupportedNodeRuntime(
  nodeVersion: string = process.env.SPEC_MEMO_SIMULATE_NODE || process.versions.node
): void {
  const major = Number.parseInt(nodeVersion, 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `spec-memo requires Node.js >= ${MIN_NODE_MAJOR} (current: ${nodeVersion}).`
    );
  }
}

export function isSqliteAbiMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('NODE_MODULE_VERSION') ||
    msg.includes('compiled against a different Node.js version')
  );
}

export function wrapSqliteOpenError(err: unknown): Error {
  if (!isSqliteAbiMismatch(err)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  if (err instanceof Error && err.message.startsWith('better-sqlite3 native module ABI')) {
    return err;
  }
  const inner = err instanceof Error ? err.message : String(err);
  return new Error(`${SQLITE_ABI_REBUILD_HINT} (${inner})`);
}

export function sqlitePrebuildFileName(): string {
  const linuxMusl =
    process.platform === 'linux' &&
    !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
      ?.glibcVersionRuntime;
  const platform = linuxMusl ? 'linuxmusl' : process.platform;
  return `${platform}-${process.arch}.node`;
}

/**
 * Resolve better-sqlite3.node from the installed package directory.
 * Do not use the `bindings` stack-trace walker: ESM + a client-injected cwd
 * (MCP SSE from another machine) makes it search the product tree, not node_modules.
 */
export function resolveSqliteNativeBinding(): string {
  const pkgDir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const candidates = [
    path.join(pkgDir, 'prebuilds', sqlitePrebuildFileName()),
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
  try {
    return new Sqlite(filename, { ...options, nativeBinding });
  } catch (err) {
    throw wrapSqliteOpenError(err);
  }
}
