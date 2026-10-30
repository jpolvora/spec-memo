'use strict';
/**
 * Memory-files backend: MEMORY.md / .sdw/MEMORY.md / memory/*.md /
 * .sdw/memory/*.md (read-only; the traps table itself is excluded and served
 * by the traps backend). sdw-memory never writes these files; record always
 * reports read-only.
 */

const fs = require('fs');
const path = require('path');
const { MemoryBackend, norm, keywordsOf, SNIPPET_LEN } = require('./base.cjs');
const { trapsPathFor } = require('./traps.cjs');

class FilesBackend extends MemoryBackend {
  get name() {
    return 'files';
  }

  get writable() {
    return false;
  }

  query(text, opts = {}) {
    const limit = Math.max(parseInt(opts.limit, 10) || 5, 1);
    const candidates = [
      path.join(this.root, 'MEMORY.md'),
      path.join(this.root, '.sdw', 'MEMORY.md')
    ];
    const excludedTable = norm(trapsPathFor(this.root));
    const addDir = (dir) => {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          for (const entry of fs.readdirSync(dir)) {
            if (entry.toLowerCase().endsWith('.md')) candidates.push(path.join(dir, entry));
          }
        }
      } catch (e) {}
    };
    addDir(path.join(this.root, 'memory'));
    addDir(path.join(this.root, '.sdw', 'memory'));
    const wanted = candidates.filter(abs => norm(abs) !== excludedTable);
    const q = String(text || '').toLowerCase();
    const keywords = keywordsOf(text);
    const hints = [];
    let scannedFiles = 0;
    for (const abs of wanted) {
      let content;
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        content = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        continue;
      }
      scannedFiles += 1;
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const lineLower = line.toLowerCase();
        if (lineLower.includes(q) || keywords.some(k => lineLower.includes(k))) {
          hints.push({ source: 'memory-files', file: norm(path.relative(this.root, abs)), snippet: line.slice(0, SNIPPET_LEN) });
          if (hints.length >= limit) break;
        }
      }
      if (hints.length >= limit) break;
    }
    return { hints, skipped: scannedFiles === 0 };
  }

  record(entry) {
    void entry;
    return { recorded: false, reason: 'files backend is read-only' };
  }
}

module.exports = { FilesBackend };
