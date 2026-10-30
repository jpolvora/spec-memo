'use strict';
/**
 * Traps-file backend: local `.sdw/traps.md` table (read + write).
 * Table contract: | Slug | Title | Layer | Avoid | Action | Date |
 */

const fs = require('fs');
const path = require('path');
const { MemoryBackend, norm, slugOf, cellText, keywordsOf } = require('./base.cjs');

const TRAPS_HEADER = [
  '# Anti-Regression Traps Log',
  '',
  'Central repository log of behavioral and engineering traps to prevent repeating mistakes.',
  '',
  '| Slug | Title | Layer | Avoid | Action | Date |',
  '|---|---|---|---|---|---|'
];

function trapsPathFor(root) {
  return path.join(root, '.sdw', 'memory', 'traps.md');
}

function readTrapRows(root) {
  const trapsPath = trapsPathFor(root);
  if (!fs.existsSync(trapsPath)) return { trapsPath, rows: [], exists: false };
  const rows = [];
  for (const rawLine of fs.readFileSync(trapsPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const slug = cells.length > 1 ? cells[1] : '';
    if (!slug || /^slugs?$/i.test(slug) || /^-+$/.test(slug)) continue;
    rows.push({ slug, title: cells[2] || '', layer: cells[3] || '', avoid: cells[4] || '', action: cells[5] || '', date: cells[6] || '', line });
  }
  return { trapsPath, rows, exists: true };
}

class TrapsBackend extends MemoryBackend {
  get name() {
    return 'traps';
  }

  query(text, opts = {}) {
    const limit = Math.max(parseInt(opts.limit, 10) || 5, 1);
    const { rows, exists } = readTrapRows(this.root);
    if (!exists) return { hints: [], skipped: true };
    const q = String(text || '').toLowerCase();
    const keywords = keywordsOf(text);
    const hints = [];
    for (const row of rows) {
      const hay = `${row.slug} ${row.title} ${row.avoid} ${row.action}`.toLowerCase();
      if (hay.includes(q) || keywords.some(k => hay.includes(k))) {
        hints.push({
          source: 'traps',
          slug: row.slug,
          title: row.title,
          snippet: `Avoid: ${row.avoid} Action: ${row.action}`.slice(0, 160),
          action: row.action
        });
        if (hints.length >= limit) break;
      }
    }
    return { hints, skipped: !exists };
  }

  record(entry) {
    const slug = entry.slug || slugOf(entry.title);
    if (!slug) return { recorded: false, reason: 'title yields empty slug' };
    const { trapsPath, rows, exists } = readTrapRows(this.root);
    if (rows.some(r => r.slug === slug)) return { slug, recorded: false, reason: 'trap slug already registered' };
    const date = new Date().toISOString().slice(0, 10);
    const row = `| ${cellText(slug, 80)} | ${cellText(entry.title, 80)} | ${cellText(entry.layer || 'general', 40)} | ${cellText(entry.avoid, 140)} | ${cellText(entry.action, 140)} | ${date} |`;
    if (!exists) {
      fs.mkdirSync(path.dirname(trapsPath), { recursive: true });
      fs.writeFileSync(trapsPath, [...TRAPS_HEADER, row, ''].join('\n'), 'utf8');
    } else {
      fs.appendFileSync(trapsPath, row + '\n', 'utf8');
    }
    return { slug, recorded: true, backend: 'traps' };
  }

  consolidate(dryRun) {
    const { trapsPath, rows, exists } = readTrapRows(this.root);
    if (!exists) return { removed: 0, kept: 0, note: 'no traps file present' };
    const seen = new Set();
    const kept = [];
    let removed = 0;
    for (const row of rows) {
      if (seen.has(row.slug)) { removed += 1; continue; }
      seen.add(row.slug);
      kept.push(row);
    }
    if (removed > 0 && !dryRun) {
      const lines = [...TRAPS_HEADER, ...kept.map(r => r.line), ''];
      fs.writeFileSync(trapsPath, lines.join('\n'), 'utf8');
    }
    return { removed, kept: kept.length, dryRun: Boolean(dryRun) };
  }
}

module.exports = { TrapsBackend, trapsPathFor, readTrapRows, TRAPS_HEADER, norm };
