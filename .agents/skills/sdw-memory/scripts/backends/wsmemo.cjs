'use strict';
/**
 * ws-memo backend: spec-memo vault via the memo CLI (read + write).
 * Compatibility: resolves the ws-memo skill with the same precedence as
 * sdw-router (canonical skills/ > consumer .agents/skills/ > global
 * $HOME/.agents/skills/) and uses the memo search/upsert surface that skill
 * documents. The CLI is the operative dependency and is probed directly;
 * every failure degrades to skipped/unrecorded, never throws.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MemoryBackend, keywordsOf, cleanSnippet } = require('./base.cjs');

const MEMO_TIMEOUT_SEARCH_MS = 15000;
const MEMO_TIMEOUT_WRITE_MS = 60000;

function memoDisabled() {
  return process.env.SDW_MEMORY_NO_MEMO === '1';
}

function findOnPath(names) {
  const pathEnv = process.env.PATH || process.env.Path || '';
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = (rawDir || '').trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const n of names) {
      try {
        const abs = path.join(dir, n);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      } catch (e) {}
    }
  }
  return null;
}

/* Resolve how to launch the memo CLI. Plain `memo` works on POSIX and on
   Windows setups where the shim resolves without a shell, but npm's default
   Windows shims (memo.cmd / memo.ps1) are invisible to CreateProcess. In
   that case run the package entrypoint directly with the current node
   binary: <shimDir>/node_modules/spec-memo/dist/cli.js. Result is cached. */
let memoLauncher = null;
let memoLauncherResolved = false;

function resolveMemoLauncher() {
  if (memoLauncherResolved) return memoLauncher;
  memoLauncherResolved = true;
  try {
    const res = spawnSync('memo', ['--help'], { encoding: 'utf8', timeout: 10000 });
    if (res && res.status === 0) {
      memoLauncher = { argv0: 'memo', prefix: [] };
      return memoLauncher;
    }
  } catch (e) {}
  if (process.platform === 'win32') {
    const shim = findOnPath(['memo.cmd']);
    if (shim) {
      const cliJs = path.join(path.dirname(shim), 'node_modules', 'spec-memo', 'dist', 'cli.js');
      try {
        if (fs.existsSync(cliJs) && fs.statSync(cliJs).isFile()) {
          memoLauncher = { argv0: process.execPath, prefix: [cliJs] };
          return memoLauncher;
        }
      } catch (e) {}
    }
  }
  memoLauncher = null;
  return memoLauncher;
}

function runMemo(args, opts = {}) {
  if (memoDisabled()) return { ok: false, reason: 'SDW_MEMORY_NO_MEMO=1' };
  const launcher = resolveMemoLauncher();
  if (!launcher) return { ok: false, reason: 'memo CLI unavailable' };
  try {
    const res = spawnSync(launcher.argv0, [...launcher.prefix, ...args],
      { encoding: 'utf8', timeout: opts.timeout || 15000 });
    if (!res || typeof res.status !== 'number' || res.status !== 0) {
      const err = String(((res && res.stderr) || '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      return { ok: false, reason: `memo exited non-zero${err ? `: ${err}` : ''}`, stdout: String((res && res.stdout) || '') };
    }
    return { ok: true, stdout: String(res.stdout || '') };
  } catch (e) {
    return { ok: false, reason: 'memo CLI unavailable' };
  }
}

let memoReachable = null;

function memoAvailable() {
  if (memoDisabled()) return false;
  if (memoReachable !== null) return memoReachable;
  const launcher = resolveMemoLauncher();
  if (!launcher) {
    memoReachable = false;
    return false;
  }
  try {
    const res = spawnSync(launcher.argv0, [...launcher.prefix, '--help'], { encoding: 'utf8', timeout: 10000 });
    memoReachable = !!(res && res.status === 0);
  } catch (e) {
    memoReachable = false;
  }
  return memoReachable;
}

function resolveSkillDir(root, name) {
  const candidates = [
    path.join(root, 'skills', name, 'SKILL.md'),
    path.join(root, '.agents', 'skills', name, 'SKILL.md')
  ];
  try {
    const home = os.homedir();
    if (home) candidates.push(path.join(home, '.agents', 'skills', name, 'SKILL.md'));
  } catch (e) {}
  for (const skillMd of candidates) {
    try {
      if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) return path.dirname(skillMd);
    } catch (e) {}
  }
  return null;
}

function wsMemoStatus(root) {
  const dir = resolveSkillDir(path.resolve(root || process.cwd()), 'ws-memo');
  let cli = false;
  try {
    cli = memoAvailable();
  } catch (e) {
    cli = false;
  }
  return { skillDir: dir, hasSkill: Boolean(dir), cliAvailable: cli };
}

class WsMemoBackend extends MemoryBackend {
  get name() {
    return 'ws-memo';
  }

  query(text, opts = {}) {
    const limit = Math.max(parseInt(opts.limit, 10) || 5, 1);
    const query = `${text} ${keywordsOf(text).join(' ')}`.trim().slice(0, 120);
    const r = runMemo(
      ['search', '--query', query, '--kinds', 'trap', '--limit', String(limit), '--sort', 'relevance', '--json', '--cwd', this.root],
      { timeout: MEMO_TIMEOUT_SEARCH_MS });
    if (!r.ok) return { hints: [], skipped: true, reason: r.reason || 'memo search failed' };
    const raw = r.stdout;
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data.hits || data.records || data.results || [];
      const hints = list.slice(0, limit).filter(h => h && typeof h === 'object').map(h => ({
        source: 'ws-memo',
        id: String(h.id || h.slug || ''),
        title: String(h.title || '').slice(0, 120),
        snippet: cleanSnippet(h.snippet || h.summary || '')
      }));
      return { hints, skipped: false };
    } catch (e) {
      return { hints: [], skipped: true, reason: 'memo search returned invalid JSON' };
    }
  }

  record(entry) {
    const tags = [...new Set([...(entry.tags || []), `sdw-kind:${entry.kind}`])];
    const body = [
      `### [${new Date().toISOString()}] ${entry.title}`,
      `- **Layer**: ${entry.layer || 'other'}`,
      `- **SDW kind**: ${entry.kind}`,
      `- **Scenario / Context**: ${entry.avoid}`,
      `- **DO NOT**: ${entry.avoid}`,
      `- **INSTEAD DO**: ${entry.action}`
    ].join('\n');
    const args = ['upsert', '--kind', 'trap', '--slug', entry.slug, '--body', body, '--cwd', this.root, '--json'];
    if (entry.title) args.push('--title', entry.title);
    if (entry.severity) args.push('--severity', entry.severity);
    if (entry.paths && entry.paths.length > 0) args.push('--path', entry.paths[0]);
    void tags;
    const r = runMemo(args, { timeout: MEMO_TIMEOUT_WRITE_MS });
    if (!r.ok) return { recorded: false, reason: r.reason || 'memo upsert failed' };
    const raw = r.stdout;
    try {
      JSON.parse(raw);
      return { recorded: true, backend: 'ws-memo', slug: entry.slug };
    } catch (e) {
      return { recorded: false, reason: 'memo upsert returned invalid JSON' };
    }
  }
}

module.exports = {
  WsMemoBackend,
  memoDisabled,
  memoAvailable,
  resolveSkillDir,
  wsMemoStatus,
  resolveMemoLauncher,
  runMemo,
  MEMO_TIMEOUT_SEARCH_MS,
  MEMO_TIMEOUT_WRITE_MS
};
