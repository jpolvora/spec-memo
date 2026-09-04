import { MemoRecord, RecordFrontmatter } from './types.js';

export type RecordLinkType = 'fixes' | 'contradicts' | 'causes';

export interface RecordLink {
  target: string;
  type: RecordLinkType;
}

export const RECORD_LINK_TYPES: readonly RecordLinkType[] = ['fixes', 'contradicts', 'causes'];

export const STALE_BADGE = '⚠️ [POSSIBLY STALE]';

export function helpfulCountOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const value = Number(fm.helpfulCount);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function staleCountOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const value = Number(fm.staleCount);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function parseRecordLinks(fm: RecordFrontmatter | Record<string, unknown>): RecordLink[] {
  const raw = fm.links;
  if (!Array.isArray(raw)) return [];
  const out: RecordLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const target = typeof (item as RecordLink).target === 'string' ? (item as RecordLink).target.trim() : '';
    const type = (item as RecordLink).type;
    if (target && RECORD_LINK_TYPES.includes(type as RecordLinkType)) {
      out.push({ target, type: type as RecordLinkType });
    }
  }
  return out;
}

export function isFlaggedStale(fm: RecordFrontmatter | Record<string, unknown>): boolean {
  const stale = staleCountOf(fm);
  const helpful = helpfulCountOf(fm);
  return stale >= 3 && stale > helpful;
}

/** Returns 1 when not demoted; otherwise 1 / (1 + staleCount - helpfulCount). */
export function salienceMultiplier(fm: RecordFrontmatter | Record<string, unknown>): number {
  const stale = staleCountOf(fm);
  const helpful = helpfulCountOf(fm);
  if (stale <= helpful) return 1;
  return 1 / (1 + stale - helpful);
}

export function applyStaleBadgeToTitle(title: string | undefined, fm: RecordFrontmatter): string {
  if (!isFlaggedStale(fm)) return title || String(fm.id || '');
  const base = title || String(fm.id || '');
  if (base.startsWith(STALE_BADGE)) return base;
  return `${STALE_BADGE} ${base}`;
}

export function cloneRecordWithStaleBadge(record: MemoRecord): MemoRecord {
  if (!isFlaggedStale(record.frontmatter)) return record;
  return {
    ...record,
    frontmatter: {
      ...record.frontmatter,
      title: applyStaleBadgeToTitle(
        typeof record.frontmatter.title === 'string' ? record.frontmatter.title : undefined,
        record.frontmatter
      )
    }
  };
}
