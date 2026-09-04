import { RecordFrontmatter } from './types.js';
import { hitCountOf, occurrenceOf } from './recurrence.js';
import { salienceMultiplier } from './salience.js';
import { matchesAnyPattern } from './indexer.js';

export interface SearchScoreExplain {
  ftsBm25: number;
  pathPatternBoost: number;
  severityMultiplier: number;
  hitsBoost: number;
  occurrencesBoost: number;
  feedbackMultiplier: number;
  finalScore: number;
}

export function roundExplain(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.round(n * 100) / 100;
}

export function safeExplainNum(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function severityMultiplierOf(severity?: string): number {
  const map: Record<string, number> = {
    critical: 1.4,
    high: 1.3,
    medium: 1,
    low: 0.9
  };
  return map[String(severity || 'medium').toLowerCase()] ?? 1;
}

export function pathPatternBoostOf(pathFilter: string | undefined, patterns?: string[]): number {
  if (!pathFilter || !patterns?.length) return 1;
  return matchesAnyPattern(pathFilter, patterns) ? 1.25 : 1;
}

export function hitsBoostOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const hits = safeExplainNum(hitCountOf(fm), 0);
  return roundExplain(1 + Math.min(hits, 20) * 0.02);
}

export function occurrencesBoostOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const occ = safeExplainNum(occurrenceOf(fm), 1);
  return roundExplain(1 + Math.min(Math.max(occ - 1, 0), 20) * 0.03);
}

/**
 * Ephemeral scoring breakdown for search diagnostics (does not alter FTS ranking).
 */
export function computeSearchExplain(
  fm: RecordFrontmatter | Record<string, unknown>,
  options: { ftsRank?: number; pathFilter?: string; pathPatterns?: string[] } = {}
): SearchScoreExplain {
  const ftsBm25 = roundExplain(Math.abs(safeExplainNum(options.ftsRank, 0)));
  const pathPatternBoost = roundExplain(
    pathPatternBoostOf(options.pathFilter, options.pathPatterns)
  );
  const severityMultiplier = roundExplain(
    severityMultiplierOf(typeof fm.severity === 'string' ? fm.severity : undefined)
  );
  const hitsBoost = hitsBoostOf(fm);
  const occurrencesBoost = occurrencesBoostOf(fm);
  const feedbackMultiplier = roundExplain(salienceMultiplier(fm));
  const finalScore = roundExplain(
    ftsBm25 * pathPatternBoost * severityMultiplier * hitsBoost * occurrencesBoost * feedbackMultiplier
  );
  return {
    ftsBm25,
    pathPatternBoost,
    severityMultiplier,
    hitsBoost,
    occurrencesBoost,
    feedbackMultiplier,
    finalScore
  };
}

export function formatSearchExplainTree(explain: SearchScoreExplain, indent = '  '): string {
  const lines = [
    `${indent}├─ FTS BM25: ${explain.ftsBm25}`,
    `${indent}├─ Path affinity: ×${explain.pathPatternBoost}`,
    `${indent}├─ Severity: ×${explain.severityMultiplier}`,
    `${indent}├─ Recurrence (occurrences): ×${explain.occurrencesBoost}`,
    `${indent}├─ Hit frequency: ×${explain.hitsBoost}`,
    `${indent}├─ Feedback salience: ×${explain.feedbackMultiplier}`,
    `${indent}└─ Final score: ${explain.finalScore}`
  ];
  return lines.join('\n');
}
