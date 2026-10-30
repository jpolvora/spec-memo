#!/usr/bin/env node
'use strict';
/**
 * sdw-memory Tier-3 helper (stdlib only: fs, path, child_process, os).
 * Central wrapper for product knowledge: query/record/consolidate/classify
 * memory entries (trap|gap|pattern|error) across pluggable store backends.
 *
 * Backends live in separated contract files and are the only modules that
 * touch their store (see backends/base.cjs):
 *   - backends/traps.cjs   — local `.sdw/traps.md` table (read + write)
 *   - backends/files.cjs   — MEMORY.md / memory/*.md (read-only)
 *   - backends/wsmemo.cjs  — ws-memo vault via memo CLI (read + write)
 * This file only routes between backends; it never reads stores directly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createBackend } = require('./backends/base.cjs');
const { memoDisabled, memoAvailable, resolveSkillDir, wsMemoStatus } = require('./backends/wsmemo.cjs');

const KINDS = new Set(['trap', 'gap', 'pattern', 'error']);
const CORE_MODULES = new Set(['fs', 'path', 'os', 'child_process', 'util']);
const QUERY_LIMIT_DEFAULT = 5;
const QUERY_LIMIT_MAX = 20;

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function findProjectRoot(startDir) {
  let curr = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(curr, '.sdw')) ||
        fs.existsSync(path.join(curr, '.git')) ||
        fs.existsSync(path.join(curr, 'skills')) ||
        fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return path.resolve(startDir || process.cwd());
}

function keywordsOf(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this'].includes(w));
}

function slugOf(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/* ---------------- unified operations (routing only) ---------------- */

function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  if (!KINDS.has(entry.kind)) errors.push(`kind must be one of ${[...KINDS].join('|')}`);
  if (typeof entry.title !== 'string' || entry.title.trim() === '') errors.push('title is required');
  if (typeof entry.avoid !== 'string' || entry.avoid.trim() === '') errors.push('avoid is required');
  if (typeof entry.action !== 'string' || entry.action.trim() === '') errors.push('action is required');
  if (entry.slug !== undefined && entry.slug !== null && !/^[a-z0-9][a-z0-9-]*$/.test(String(entry.slug))) {
    errors.push('slug must match ^[a-z0-9][a-z0-9-]*$');
  }
  return errors;
}

function capLimit(limit) {
  return Math.min(Math.max(parseInt(limit, 10) || QUERY_LIMIT_DEFAULT, 1), QUERY_LIMIT_MAX);
}

function kindOf(options) {
  return options.kind && KINDS.has(options.kind) ? options.kind : null;
}

/* ---------------- backend selection: CLI > config > availability ----------------
   `.sdw/config.json` may declare `{ "memory": { "backends": {
   "wsMemo": true|false, "traps": true|false, "files": true|false } } }`.
   Missing keys default to enabled. Explicit `--backend` pins the target set;
   requesting a config-disabled backend is an error. SDW_MEMORY_NO_MEMO=1 and
   an unreachable memo CLI always disable the ws-memo vault. */

function loadMemoryConfig(root) {
  try {
    const p = path.join(path.resolve(root), '.sdw', 'config.json');
    if (!fs.existsSync(p)) return {};
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const m = cfg && cfg.memory;
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (e) {
    return {};
  }
}

function backendsEnabled(root, requested) {
  const memCfg = loadMemoryConfig(root);
  const cfgBackends = memCfg && memCfg.backends && typeof memCfg.backends === 'object' ? memCfg.backends : {};
  const cfgFlag = (key) => cfgBackends[key] === undefined ? true : Boolean(cfgBackends[key]);
  const enabled = {
    'ws-memo': cfgFlag('wsMemo') && cfgFlag('ws-memo'),
    traps: cfgFlag('traps'),
    files: cfgFlag('files')
  };
  const want = requested === undefined ? 'auto' : String(requested).toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(want)) {
    return { error: `unknown backend "${requested}" (expected auto|ws-memo|traps|files|all)` };
  }
  return { enabled, want };
}

/* Canonical per-backend consultation. Each section reports { hints, skipped }
   independently. `options.backends` accepts a subset like ['traps', 'files']
   to skip the vault. This is the single entry every skill must use instead
   of raw traps.md / MEMORY.md / memo access. */
function consultMemory(root, text, options = {}) {
  const limit = capLimit(options.limit);
  const kind = kindOf(options);
  const only = Array.isArray(options.backends) ? options.backends.map(s => String(s).toLowerCase()) : null;
  const cfg = backendsEnabled(root, undefined);
  const cfgEnabled = cfg.error ? { 'ws-memo': true, traps: true, files: true } : cfg.enabled;
  const out = {
    traps: { hints: [], skipped: true },
    files: { hints: [], skipped: true },
    vault: { hints: [], skipped: true }
  };
  const wants = (...names) => !only || names.some(n => only.includes(n));
  const vaultUp = !memoDisabled() && memoAvailable();
  if (wants('traps') && cfgEnabled.traps) {
    try {
      const b = createBackend('traps', { root });
      const r = b.query(text, { kind, limit });
      out.traps = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.traps = { hints: [], skipped: true };
    }
  }
  if (wants('files', 'memory-files') && cfgEnabled.files) {
    try {
      const b = createBackend('files', { root });
      const r = b.query(text, { kind, limit });
      out.files = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.files = { hints: [], skipped: true };
    }
  }
  if (wants('vault', 'ws-memo', 'wsmemo', 'spec-memo') && cfgEnabled['ws-memo'] && vaultUp) {
    try {
      const b = createBackend('ws-memo', { root });
      const r = b.query(text, { kind, limit });
      out.vault = { hints: r.hints, skipped: r.skipped };
    } catch (e) {
      out.vault = { hints: [], skipped: true };
    }
  }
  void kind;
  return out;
}

function queryMemory(root, text, options = {}) {
  const limit = capLimit(options.limit);
  const backendOpt = options.backend === undefined ? 'auto' : String(options.backend).toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(backendOpt)) {
    return { error: `unknown backend "${options.backend}" (expected auto|ws-memo|traps|files|all)` };
  }
  const cfg = backendsEnabled(root, backendOpt);
  if (cfg.error) return { error: cfg.error };
  const only = backendOpt === 'auto' || backendOpt === 'all' ? undefined : [backendOpt];
  const c = consultMemory(root, text, { kind: kindOf(options), limit, backends: only });
  const hints = [...c.traps.hints, ...c.files.hints, ...c.vault.hints].slice(0, limit);
  const sources = [
    c.traps.hints.length > 0 ? `memory-traps:${c.traps.hints.length} hints` : 'memory-traps:consult-skipped',
    c.files.hints.length > 0 ? `memory-files:${c.files.hints.length} hints` : 'memory-files:consult-skipped',
    c.vault.skipped ? 'spec-memo:consult-skipped' : `spec-memo:${c.vault.hints.length} hints`
  ];
  return { hints, sources };
}

function recordMemory(root, entry, options = {}) {
  const errors = validateEntry(entry);
  if (errors.length > 0) return { exit: 1, error: errors.join('; ') };
  const backendOpt = String(options.backend || 'auto').toLowerCase();
  if (!['auto', 'ws-memo', 'traps', 'files', 'all'].includes(backendOpt)) {
    return { exit: 1, error: `unknown backend "${options.backend}" (expected auto|ws-memo|traps|files|all)` };
  }
  if (backendOpt === 'files') return { exit: 1, error: 'files backend is read-only; record targets ws-memo and/or traps' };
  const cfg = backendsEnabled(root, backendOpt);
  if (cfg.error) return { exit: 1, error: cfg.error };
  const slug = entry.slug || slugOf(entry.title);
  if (!slug) return { exit: 1, error: 'title yields empty slug; pass --slug explicitly' };
  const full = { kind: entry.kind, slug, title: entry.title.trim(), avoid: entry.avoid.trim(), action: entry.action.trim(), layer: entry.layer || 'other', severity: entry.severity || 'medium', tags: entry.tags || [], paths: entry.paths || [] };
  const vaultUp = !memoDisabled() && memoAvailable();
  const names = backendOpt === 'all'
    ? ['ws-memo', 'traps'].filter(n => (n === 'traps' ? cfg.enabled.traps : cfg.enabled['ws-memo'] && vaultUp))
    : backendOpt === 'auto'
      ? (vaultUp && cfg.enabled['ws-memo'] ? ['ws-memo'] : (cfg.enabled.traps ? ['traps'] : []))
      : (backendOpt === 'ws-memo'
        ? (cfg.enabled['ws-memo'] && vaultUp ? ['ws-memo'] : [])
        : (cfg.enabled.traps ? ['traps'] : []));
  const labels = { 'ws-memo': 'ws-memo', traps: 'traps' };
  const recorded = [];
  const skipped = [];
  for (const name of names) {
    let backend;
    try {
      backend = createBackend(name, { root });
    } catch (e) {
      skipped.push({ backend: labels[name] || name, reason: e.message });
      continue;
    }
    const r = backend.record(full);
    if (r.recorded) recorded.push({ backend: labels[name] || name, slug: r.slug || slug });
    else skipped.push({ backend: labels[name] || name, reason: r.reason });
  }
  if (recorded.length === 0) {
    if (names.length === 0) {
      return { exit: 0, report: { slug, recorded: [], skipped: [{ backend: backendOpt, reason: 'no memory backend enabled or available' }], noop: true } };
    }
    return { exit: 1, error: `nothing recorded: ${skipped.map(s => `${s.backend} (${s.reason})`).join('; ') || 'no backend selected'}` };
  }
  return { exit: 0, report: { slug, recorded, skipped } };
}

/** Compatibility wrapper for sdw-rules log-trap hook. */
function recordTrap({ slug, title, avoid, action, layer, root, kind, tags, paths, backend }) {
  const res = recordMemory(path.resolve(root || findProjectRoot()), {
    kind: kind || 'trap', slug, title, avoid, action,
    layer: layer || 'general', tags, paths
  }, { backend: backend || 'auto' });
  if (res.exit !== 0) return { recorded: false, reason: res.error };
  const vaultHit = res.report.recorded.find(r => r.backend === 'ws-memo');
  return { recorded: true, slug: res.report.slug, backend: vaultHit ? 'ws-memo' : res.report.recorded[0].backend };
}

function classifyMemory(text) {
  const t = String(text || '').toLowerCase();
  const has = (...words) => words.some(w => t.includes(w));
  if (has('secret', 'token', 'api key', 'apikey', 'credential', 'password', 'private key', 'leak')) {
    return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: ['security'], layer: 'other' };
  }
  if (has('debugger', 'console.log', 'todo', 'fixme', 'lint')) {
    return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: ['hygiene'], layer: 'tests' };
  }
  if (has('flaky', 'race', 'timeout', 'perf', 'slow', 'hang', 'deadlock')) {
    return { kind: 'gap', slug: slugOf(text.split('\n')[0] || text), tags: ['reliability'], layer: 'infrastructure' };
  }
  if (has('pattern', 'convention', 'template', 'idiom', 'best practice')) {
    return { kind: 'pattern', slug: slugOf(text.split('\n')[0] || text), tags: ['convention'], layer: 'application' };
  }
  if (has('fail', 'error', 'crash', 'exception', 'broken', 'regression')) {
    return { kind: 'error', slug: slugOf(text.split('\n')[0] || text), tags: ['defect'], layer: 'application' };
  }
  return { kind: 'trap', slug: slugOf(text.split('\n')[0] || text), tags: [], layer: 'other' };
}

function consolidateMemory(root, options = {}) {
  const backendOpt = String(options.backend || 'traps').toLowerCase();
  if (!['traps', 'auto'].includes(backendOpt)) {
    if (['ws-memo', 'files', 'all'].includes(backendOpt)) {
      return { exit: 0, report: { backend: backendOpt, removed: 0, kept: 0, note: 'vault records are never auto-deleted; use memo gc / forget for lifecycle' } };
    }
    return { exit: 1, error: `unknown backend "${options.backend}" (expected traps|auto)` };
  }
  const cfg = backendsEnabled(root, 'traps');
  if (cfg.error) return { exit: 1, error: cfg.error };
  if (!cfg.enabled.traps) {
    return { exit: 0, report: { backend: 'traps', removed: 0, kept: 0, note: 'traps backend disabled in .sdw/config.json memory.backends' } };
  }
  const backend = createBackend('traps', { root });
  const r = backend.consolidate(Boolean(options.dryRun));
  return { exit: 0, report: { backend: 'traps', removed: r.removed, kept: r.kept, dryRun: Boolean(options.dryRun), ...(r.note ? { note: r.note } : {}) } };
}

function cmdDoctor(options = {}) {
  const root = path.resolve(options.root || findProjectRoot());
  const issues = [];
  const skillDir = path.join(root, 'skills', 'sdw-memory');
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    issues.push('SKILL.md missing');
  } else {
    const content = fs.readFileSync(skillMd, 'utf8');
    if (content.split(/\r?\n/).length > 120) issues.push('SKILL.md exceeds 120 lines');
    if (!/>\s*When this skill is loaded,\s*output/i.test(content)) issues.push('SKILL.md missing announcement banner');
    if (!/sdw-rules/i.test(content)) issues.push('SKILL.md missing sdw-rules reference');
  }
  if (!fs.existsSync(path.join(skillDir, 'references', 'memory_protocol.md'))) {
    issues.push('references/memory_protocol.md missing');
  }
  const backendsDir = path.join(skillDir, 'scripts', 'backends');
  for (const f of ['base.cjs', 'traps.cjs', 'files.cjs', 'wsmemo.cjs']) {
    if (!fs.existsSync(path.join(backendsDir, f))) issues.push(`scripts/backends/${f} missing`);
  }
  const selfCheck = spawnSync(process.execPath, ['--check', __filename], { encoding: 'utf8' });
  if (selfCheck.status !== 0) issues.push(`script syntax check failed: ${(selfCheck.stderr || '').trim()}`);
  try {
    const src = fs.readFileSync(__filename, 'utf8');
    const requires = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map(m => m[1]);
    const external = requires.filter(r => !CORE_MODULES.has(r) && !r.startsWith('.') && !r.startsWith('/'));
    if (external.length > 0) issues.push(`external runtime dependencies: ${external.join(', ')}`);
  } catch (e) {
    issues.push(`cannot self-inspect requires: ${e.message}`);
  }
  let memo = 'unavailable';
  let wsMemoSkill = null;
  try {
    const st = wsMemoStatus(root);
    wsMemoSkill = st.skillDir;
    memo = st.cliAvailable ? 'available' : 'unavailable';
  } catch (e) {
    memo = 'unavailable';
  }
  void os;
  const passed = issues.length === 0;
  const result = { passed, skill: 'sdw-memory', memo, wsMemoSkill, issues, summary: passed ? 'sdw-memory doctor passed.' : `sdw-memory doctor failed: ${issues.join('; ')}` };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sdw-memory doctor] ${result.summary} (vault: ${memo})`);
  return { exit: passed ? 0 : 1, result };
}

function parseArgs(args) {
  const o = { subcommand: null, backend: 'auto', kind: null, title: null, avoid: null, action: null, slug: null, tags: null, paths: null, layer: null, severity: null, limit: null, path: null, file: null, text: null, json: false, dryRun: false, root: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--backend' && args[i + 1]) o.backend = args[++i];
    else if (a.startsWith('--backend=')) o.backend = a.slice(10);
    else if (a === '--kind' && args[i + 1]) o.kind = args[++i];
    else if (a.startsWith('--kind=')) o.kind = a.slice(7);
    else if (a === '--title' && args[i + 1]) o.title = args[++i];
    else if (a.startsWith('--title=')) o.title = a.slice(8);
    else if (a === '--avoid' && args[i + 1]) o.avoid = args[++i];
    else if (a.startsWith('--avoid=')) o.avoid = a.slice(8);
    else if (a === '--action' && args[i + 1]) o.action = args[++i];
    else if (a.startsWith('--action=')) o.action = a.slice(9);
    else if (a === '--slug' && args[i + 1]) o.slug = args[++i];
    else if (a.startsWith('--slug=')) o.slug = a.slice(7);
    else if (a === '--tags' && args[i + 1]) o.tags = args[++i];
    else if (a.startsWith('--tags=')) o.tags = a.slice(7);
    else if (a === '--paths' && args[i + 1]) o.paths = args[++i];
    else if (a.startsWith('--paths=')) o.paths = a.slice(8);
    else if (a === '--layer' && args[i + 1]) o.layer = args[++i];
    else if (a.startsWith('--layer=')) o.layer = a.slice(8);
    else if (a === '--severity' && args[i + 1]) o.severity = args[++i];
    else if (a.startsWith('--severity=')) o.severity = a.slice(11);
    else if (a === '--limit' && args[i + 1]) o.limit = args[++i];
    else if (a.startsWith('--limit=')) o.limit = a.slice(8);
    else if (a === '--path' && args[i + 1]) o.path = args[++i];
    else if (a.startsWith('--path=')) o.path = a.slice(7);
    else if (a === '--root' && args[i + 1]) o.root = args[++i];
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (!a.startsWith('-')) positional.push(a);
  }
  o.subcommand = positional[0] || null;
  o.text = positional.slice(1).join(' ');
  return o;
}

function emitSummary(r) {
  if (r.error) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root || findProjectRoot());
  if (!options.subcommand || options.subcommand === 'help' || options.subcommand === '--help') {
    console.log(`sdw-memory — central product knowledge wrapper (trap|gap|pattern|error)
Backends live in scripts/backends/ (contract: backends/base.cjs). Default backend auto prefers the ws-memo vault, falling back to the local traps file.
Usage:
  node sdw_memory.cjs query "<text>" [--kind <kind>] [--backend auto|ws-memo|traps|files|all] [--limit N] [--json]
  node sdw_memory.cjs record --kind <kind> --title "..." --avoid "..." --action "..." [--slug S] [--tags a,b] [--paths f] [--layer L] [--severity S] [--backend ...] [--json]
  node sdw_memory.cjs consolidate [--backend traps] [--dry-run] [--json]
  node sdw_memory.cjs classify "<text>" [--json]
  node sdw_memory.cjs doctor [--json]`);
    process.exit(0);
  }
  if (options.subcommand === 'query') {
    if (!options.text) { console.error('[sdw-memory] Error: query requires text'); process.exit(1); }
    const r = queryMemory(root, options.text, options);
    emitSummary(r);
    if (options.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`[sdw-memory] ${r.hints.length} hint(s): ${r.sources.join(', ')}`);
      for (const h of r.hints) console.log(`  - [${h.source}] ${h.slug || h.id || h.file || ''} ${h.title || ''}`.trim());
    }
    process.exit(0);
  }
  if (options.subcommand === 'record') {
    if (options.dryRun) {
      const errors = validateEntry({ kind: options.kind, title: options.title, avoid: options.avoid, action: options.action, slug: options.slug });
      if (errors.length > 0) { console.error(`[sdw-memory] Error: ${errors.join('; ')}`); process.exit(1); }
      console.log(JSON.stringify({ dryRun: true, slug: options.slug || slugOf(options.title), backends: options.backend }, null, 2));
      process.exit(0);
    }
    const r = recordMemory(root, {
      kind: options.kind, title: options.title, avoid: options.avoid, action: options.action,
      slug: options.slug, layer: options.layer,
      tags: options.tags ? options.tags.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      paths: options.paths ? options.paths.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      severity: options.severity
    }, { backend: options.backend });
    if (r.exit !== 0) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r.report, null, 2));
    else console.log(`[sdw-memory] Recorded ${r.report.slug}: ${r.report.recorded.map(x => x.backend).join(', ')}`);
    process.exit(0);
  }
  if (options.subcommand === 'consolidate') {
    const r = consolidateMemory(root, { backend: options.backend === 'auto' ? 'traps' : options.backend, dryRun: options.dryRun });
    if (r.exit !== 0) { console.error(`[sdw-memory] Error: ${r.error}`); process.exit(1); }
    if (options.json) console.log(JSON.stringify(r.report, null, 2));
    else console.log(`[sdw-memory] Consolidate (${r.report.backend}): removed ${r.report.removed}, kept ${r.report.kept}${options.dryRun ? ' (dry-run)' : ''}${r.report.note ? ` — ${r.report.note}` : ''}`);
    process.exit(0);
  }
  if (options.subcommand === 'classify') {
    if (!options.text) { console.error('[sdw-memory] Error: classify requires text'); process.exit(1); }
    console.log(JSON.stringify(classifyMemory(options.text), null, 2));
    process.exit(0);
  }
  if (options.subcommand === 'doctor') {
    const r = cmdDoctor({ root, json: options.json });
    process.exit(r.exit);
  }
  console.error(`[sdw-memory] Unknown subcommand "${options.subcommand}". Use query|record|consolidate|classify|doctor.`);
  process.exit(1);
}

module.exports = {
  findProjectRoot, keywordsOf, slugOf, memoAvailable, memoDisabled,
  resolveSkillDir, wsMemoStatus, trapsPathFor: require('./backends/traps.cjs').trapsPathFor,
  consultMemory, queryMemory, recordMemory, recordTrap, loadMemoryConfig, backendsEnabled,
  classifyMemory, consolidateMemory, cmdDoctor
};

if (require.main === module) main();
