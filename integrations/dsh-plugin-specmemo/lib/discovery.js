/**
 * memo executable discovery (AC11).
 *
 * Resolution order, first hit wins:
 *   1. `memoCommand` from the plugin row config (only when set explicitly)
 *   2. `SPEC_MEMO_MEMO` from the environment
 *   3. `memo` found on `PATH`
 *   4. `node <productRoot>/dist/cli.js` when `productRoot` is configured
 *
 * Nothing here throws: an unreadable PATH entry or filesystem probe simply
 * fails that candidate. When no candidate resolves the caller disables the
 * bridge and records one diagnostic; there is no retry loop.
 */

import { accessSync, constants } from 'node:fs';

const WINDOWS_PATH_EXTENSIONS = Object.freeze(['.CMD', '.EXE', '.BAT', '.COM', '']);

function hasPathSeparator(value) {
  return value.includes('/') || value.includes('\\');
}

function pathSeparatorFor(platform) {
  return platform === 'win32' ? '\\' : '/';
}

function joinFor(platform, base, ...parts) {
  const separator = pathSeparatorFor(platform);
  let result = String(base);
  for (const part of parts) {
    if (!result.endsWith(separator) && !result.endsWith('/') && !result.endsWith('\\')) {
      result += separator;
    }
    result += String(part);
  }
  return result;
}

function defaultFileExists(candidate, { executable = true } = {}) {
  try {
    accessSync(candidate, constants.F_OK);
    if (executable && process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    else accessSync(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function exists(candidate, fileExists, options) {
  try {
    return Boolean(fileExists(candidate, options));
  } catch {
    return false;
  }
}

function pathDirectories(env, platform) {
  const raw = env?.PATH ?? env?.Path ?? env?.path ?? '';
  if (typeof raw !== 'string') return [];
  const separator = platform === 'win32' ? ';' : ':';
  return raw.split(separator).filter((entry) => entry.length > 0);
}

function findOnPath(command, { env, platform, fileExists }) {
  const extensions = platform === 'win32' ? WINDOWS_PATH_EXTENSIONS : [''];
  for (const directory of pathDirectories(env, platform)) {
    for (const extension of extensions) {
      const candidate = joinFor(platform, directory, `${command}${extension}`);
      if (exists(candidate, fileExists)) return candidate;
    }
  }
  return null;
}

function resolveCommand(command, options) {
  if (!Array.isArray(command) || command.length === 0) return null;
  const executable = command[0];
  if (typeof executable !== 'string' || executable.trim().length === 0) return null;
  const resolved = hasPathSeparator(executable)
    ? exists(executable, options.fileExists)
      ? executable
      : null
    : findOnPath(executable, options);
  if (!resolved) return null;
  return command.map((part) => String(part));
}

/**
 * Resolve the base `memo` argv, or `null` when no candidate exists.
 *
 * `configuredCommand` must be `null` unless the row config set
 * `memoCommand` explicitly, so the documented default `["memo"]` does not
 * shadow the `SPEC_MEMO_MEMO` and PATH candidates.
 */
export function discoverMemoCommand({
  configuredCommand = null,
  env = process.env,
  productRoot = null,
  platform = process.platform,
  fileExists = defaultFileExists,
  nodeCommand = process.execPath
} = {}) {
  const options = { env, platform, fileExists };

  const fromConfig = resolveCommand(configuredCommand, options);
  if (fromConfig) return { argv: fromConfig, source: 'config' };

  const envCommand = typeof env?.SPEC_MEMO_MEMO === 'string' ? env.SPEC_MEMO_MEMO.trim() : '';
  if (envCommand) {
    const resolved =
      hasPathSeparator(envCommand) || envCommand.startsWith('.')
        ? exists(envCommand, fileExists)
          ? envCommand
          : null
        : findOnPath(envCommand, options);
    if (resolved) return { argv: [resolved], source: 'env' };
  }

  if (findOnPath('memo', options)) {
    // Windows `.cmd`/`.bat` shims are resolved by the host subprocess layer.
    return { argv: ['memo'], source: 'path' };
  }

  if (typeof productRoot === 'string' && productRoot.trim().length > 0) {
    const cliPath = joinFor(platform, productRoot, 'dist', 'cli.js');
    if (exists(cliPath, fileExists, { executable: false })) {
      return { argv: [String(nodeCommand), cliPath], source: 'product-cli' };
    }
  }

  return null;
}
