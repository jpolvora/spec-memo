import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSearchExplain,
  roundExplain,
  safeExplainNum,
  severityMultiplierOf,
  pathPatternBoostOf,
  hitsBoostOf,
  occurrencesBoostOf,
  formatSearchExplainTree
} from './ranking-explain.js';

describe('ranking-explain', () => {
  it('rounds to 2 decimal places', () => {
    assert.equal(roundExplain(1.2345), 1.23);
    assert.equal(roundExplain(NaN), 1);
  });

  it('safeExplainNum falls back on non-numeric values', () => {
    assert.equal(safeExplainNum('bad', 1.5), 1.5);
    assert.equal(safeExplainNum(3, 1.5), 3);
  });

  it('severityMultiplierOf maps severity tiers', () => {
    assert.equal(severityMultiplierOf('critical'), 1.4);
    assert.equal(severityMultiplierOf('high'), 1.3);
    assert.equal(severityMultiplierOf('unknown'), 1);
  });

  it('pathPatternBoostOf returns 1.25 when path matches', () => {
    assert.equal(pathPatternBoostOf('src/db/client.ts', ['src/db/**/*.ts']), 1.25);
    assert.equal(pathPatternBoostOf('other.ts', ['src/db/**/*.ts']), 1);
  });

  it('hitsBoostOf and occurrencesBoostOf use neutral 1.0 for malformed frontmatter', () => {
    assert.equal(hitsBoostOf({ hits: 'bad' }), 1);
    assert.equal(occurrencesBoostOf({ occurrences: 'bad' }), 1);
  });

  it('computeSearchExplain returns all required fields', () => {
    const explain = computeSearchExplain(
      { severity: 'high', hits: 5, occurrences: 3 },
      { ftsRank: -2.5, pathFilter: 'src/a.ts', pathPatterns: ['src/**/*.ts'] }
    );
    assert.ok(explain.ftsBm25 > 0);
    assert.equal(explain.pathPatternBoost, 1.25);
    assert.equal(explain.severityMultiplier, 1.3);
    assert.ok(explain.hitsBoost >= 1);
    assert.ok(explain.occurrencesBoost >= 1);
    assert.equal(explain.feedbackMultiplier, 1);
    assert.ok(explain.finalScore > 0);
  });

  it('formatSearchExplainTree renders indented tree', () => {
    const tree = formatSearchExplainTree({
      ftsBm25: 2,
      pathPatternBoost: 1,
      severityMultiplier: 1,
      hitsBoost: 1,
      occurrencesBoost: 1,
      feedbackMultiplier: 1,
      finalScore: 2
    });
    assert.match(tree, /FTS BM25: 2/);
    assert.match(tree, /Final score: 2/);
  });
});
