import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckVersionOptions, CheckVersionResult } from './types.js';

const NPM_LATEST_URL = 'https://registry.npmjs.org/spec-memo/latest';
const DEFAULT_TIMEOUT_MS = 3000;

/** Resolve the installed package root (parent of `dist/` when running compiled code). */
export function getPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function getPackageVersion(packageRoot = getPackageRoot()): string {
  const pkgPath = path.join(packageRoot, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error(`package.json at ${pkgPath} is missing a version field`);
  }
  return pkg.version;
}

/** Compare semver core (major.minor.patch); returns true when `a` is strictly newer than `b`. */
export function isSemverNewer(a: string, b: string): boolean {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function parseSemverCore(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/i, '').split('-')[0].split('+')[0];
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

async function fetchNpmLatest(timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NPM_LATEST_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report running package version and optionally compare to npm `latest`.
 * Network/registry failures soft-fail with updateAvailable `"unknown"`.
 */
export async function checkVersion(options: CheckVersionOptions = {}): Promise<CheckVersionResult> {
  const current = getPackageVersion();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let latest: string | null = null;
  let source: CheckVersionResult['source'] = 'offline';

  if (options.fetchLatest) {
    try {
      latest = await options.fetchLatest();
      source = latest ? 'npm' : 'offline';
    } catch {
      latest = null;
      source = 'offline';
    }
  } else {
    latest = await fetchNpmLatest(timeoutMs);
    source = latest ? 'npm' : 'offline';
  }

  let updateAvailable: CheckVersionResult['updateAvailable'];
  if (latest === null) {
    updateAvailable = 'unknown';
  } else {
    updateAvailable = isSemverNewer(latest, current);
  }

  return { current, latest, updateAvailable, source };
}
