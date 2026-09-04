import { RecordFrontmatter, RecordKind } from './types.js';

/** Parse duration strings like `7d`, `48h`, `30m`. */
export function parseDurationMs(ttl: string): number | null {
  const durMatch = ttl.match(/^(\d+(?:\.\d+)?)\s*([dhms]|days?|hours?|mins?|minutes?|secs?|seconds?)?$/i);
  if (!durMatch) return null;
  const num = parseFloat(durMatch[1]);
  const unit = (durMatch[2] || 'd').toLowerCase();
  if (unit.startsWith('h')) return num * 3600 * 1000;
  if (unit.startsWith('m')) return num * 60 * 1000;
  if (unit.startsWith('s')) return num * 1000;
  return num * 86400 * 1000;
}

/** Parse RFC3339 timestamps or `YYYY-MM-DD` (end of that UTC day). */
export function parseExpiresAt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Date.parse(`${trimmed}T23:59:59.999Z`);
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

export function validateTtlInput(ttl?: string): { ok: true } | { ok: false; error: string } {
  if (!ttl) return { ok: true };
  if (parseDurationMs(ttl) !== null) return { ok: true };
  if (parseExpiresAt(ttl) !== null) return { ok: true };
  return { ok: false, error: `Invalid ttl duration or date: "${ttl}"` };
}

export function computeExpiresAt(
  created: string,
  ttl?: string,
  expiresAt?: string
): string | undefined {
  if (expiresAt) {
    const ms = parseExpiresAt(expiresAt);
    if (ms === null) return undefined;
    return new Date(ms).toISOString();
  }
  if (!ttl) return undefined;
  const durMs = parseDurationMs(ttl);
  if (durMs !== null) {
    const createdMs = Date.parse(created);
    if (Number.isNaN(createdMs)) return undefined;
    return new Date(createdMs + durMs).toISOString();
  }
  const dateMs = parseExpiresAt(ttl);
  if (dateMs !== null) return new Date(dateMs).toISOString();
  return undefined;
}

export function defaultTtlDaysForKind(
  kind: RecordKind,
  scratchDays: number,
  reviewDays: number
): number | undefined {
  if (kind === 'scratch') return scratchDays;
  if (kind === 'review') return reviewDays;
  return undefined;
}

export function resolveExpiresAtMs(
  fm: RecordFrontmatter,
  defaultTtlDays?: number
): number | null {
  const expiresAt = typeof fm.expires_at === 'string' ? fm.expires_at : undefined;
  if (expiresAt) {
    return parseExpiresAt(expiresAt);
  }
  const ttl = typeof fm.ttl === 'string' ? fm.ttl : undefined;
  if (ttl) {
    const computed = computeExpiresAt(String(fm.created || fm.updated), ttl);
    if (computed) return parseExpiresAt(computed);
  }
  if (defaultTtlDays !== undefined) {
    const createdMs = Date.parse(String(fm.created || fm.updated));
    if (!Number.isNaN(createdMs)) {
      return createdMs + defaultTtlDays * 86400 * 1000;
    }
  }
  return null;
}

export function isRecordExpiredAt(
  fm: RecordFrontmatter,
  now: number = Date.now(),
  defaultTtlDays?: number
): boolean {
  const expMs = resolveExpiresAtMs(fm, defaultTtlDays);
  if (expMs === null) return false;
  return now >= expMs;
}

export function isRecordActiveAt(
  fm: RecordFrontmatter,
  asOfMs: number,
  defaultTtlDays?: number
): boolean {
  const createdMs = Date.parse(String(fm.created || fm.updated));
  if (Number.isNaN(createdMs) || createdMs > asOfMs) return false;
  const expMs = resolveExpiresAtMs(fm, defaultTtlDays);
  if (expMs === null) return true;
  return asOfMs < expMs;
}

export function annotateExpiredFrontmatter(
  fm: RecordFrontmatter,
  scratchDays = 7,
  reviewDays = 14,
  now: number = Date.now()
): RecordFrontmatter {
  const defaultDays = defaultTtlDaysForKind(fm.kind, scratchDays, reviewDays);
  if (isRecordExpiredAt(fm, now, defaultDays)) {
    return { ...fm, expired: true };
  }
  return fm;
}

export interface SearchExpirationContext {
  includeExpired?: boolean;
  asOf?: string;
  now?: number;
  scratchDays?: number;
  reviewDays?: number;
}

export function applySearchExpirationFilter(
  fm: RecordFrontmatter,
  ctx: SearchExpirationContext
): { include: boolean; expired: boolean } {
  const scratchDays = ctx.scratchDays ?? 7;
  const reviewDays = ctx.reviewDays ?? 14;
  const defaultDays = defaultTtlDaysForKind(fm.kind, scratchDays, reviewDays);

  if (ctx.asOf) {
    const asOfMs = parseExpiresAt(ctx.asOf) ?? Date.parse(ctx.asOf);
    if (Number.isNaN(asOfMs)) {
      return { include: true, expired: false };
    }
    const active = isRecordActiveAt(fm, asOfMs, defaultDays);
    const hadExpiry = resolveExpiresAtMs(fm, defaultDays) !== null;
    return { include: active, expired: hadExpiry && !active };
  }

  const expired = isRecordExpiredAt(fm, ctx.now ?? Date.now(), defaultDays);
  if (expired && !ctx.includeExpired) {
    return { include: false, expired: true };
  }
  return { include: true, expired };
}
