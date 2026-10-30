'use strict';
/**
 * Memory Backend Contract (Tier-3).
 *
 * Every store backend implements this interface. Backends live in separated
 * files and are the only modules allowed to touch their store:
 *   - backends/traps.cjs   — local `.sdw/traps.md` table (read + write)
 *   - backends/files.cjs   — MEMORY.md / memory/*.md (read-only)
 *   - backends/wsmemo.cjs  — ws-memo vault via memo CLI (read + write)
 *
 * `sdw_memory.cjs` only routes between backends; it never reads stores
 * directly. Agent skills must call the sdw-memory CLI, never these files.
 */

const SNIPPET_LEN = 160;

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function keywordsOf(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this'].includes(w));
}

function slugOf(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

function cellText(value, maxLen) {
  return String(value || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function cleanSnippet(value) {
  return String(value || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
}

class MemoryBackend {
  constructor(options = {}) {
    this.root = options.root ? String(options.root) : process.cwd();
  }

  get name() {
    return 'base';
  }

  get readable() {
    return true;
  }

  get writable() {
    return true;
  }

  query(text, opts) {
    void text;
    void opts;
    throw new Error('query must be implemented by the backend.');
  }

  record(entry) {
    void entry;
    throw new Error('record must be implemented by the backend.');
  }
}

const BACKEND_FILES = ['base.cjs', 'traps.cjs', 'files.cjs', 'wsmemo.cjs'];

function createBackend(name, options = {}) {
  const want = String(name || '').toLowerCase();
  if (want === 'traps') return new (require('./traps.cjs').TrapsBackend)(options);
  if (want === 'files') return new (require('./files.cjs').FilesBackend)(options);
  if (want === 'ws-memo' || want === 'wsmemo' || want === 'vault') {
    return new (require('./wsmemo.cjs').WsMemoBackend)(options);
  }
  throw new Error(`unknown memory backend "${name}" (expected traps|files|ws-memo)`);
}

module.exports = {
  MemoryBackend,
  BACKEND_FILES,
  SNIPPET_LEN,
  norm,
  keywordsOf,
  slugOf,
  cellText,
  cleanSnippet,
  createBackend
};
