'use strict';

// Read-only transcript discovery from environment facts and filesystem
// conventions. The finder never prints file content and never writes a file.
// It prints one JSON object and exits 0 whether or not a candidate is found.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ENTRIES = 4000;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_DEPTH = 4;
const MAX_ROOTS = 6;
const RECENT_MS = 24 * 60 * 60 * 1000;
const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl', '.json', '.log', '.txt', '.md', '.zst', '.zstd']);
const TRANSCRIPT_ONLY_EXTENSIONS = new Set(['.jsonl', '.json', '.log', '.zst', '.zstd']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', 'tmp', 'temp']);
const ROOT_VARIABLE = /(HOME|DIR|ROOT|DATA|CONFIG|PROFILE)/i;
const PREFERRED_ROOT = /(SESSION|HARNESS|AGENT|DATA|CONFIG|HOME|PROFILE)/i;
const DATA_LIKE_VARIABLE = /(HOME|DATA|CONFIG|PROFILE)/i;
const SESSION_VARIABLE = /(SESSION|CONVERSATION|THREAD|RUN)/i;
const OS_VARIABLE = /(SYSTEM|DRIVERS|DOTNET|TEMP|TMP)/i;
const OS_DIR_VARIABLE = /^(SYSTEMROOT|WINDIR|PROGRAMFILES|PROGRAMDATA)/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function parseArgs(argv) {
  const options = {
    root: null,
    json: false,
    maxEntries: DEFAULT_MAX_ENTRIES,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value) {
        options.root = path.resolve(value);
        index += 1;
      }
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--max-entries') {
      const value = Number(argv[index + 1]);
      if (Number.isInteger(value) && value > 0) {
        options.maxEntries = value;
        index += 1;
      }
    } else if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (Number.isInteger(value) && value >= 0) {
        options.timeoutMs = value;
        index += 1;
      }
    }
  }
  return options;
}

function isTranscriptFile(file) {
  return TRANSCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isTextLike(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(512);
    const bytes = fs.readSync(fd, head, 0, head.length, 0);
    const sample = head.subarray(0, bytes);
    if (sample.length >= ZSTD_MAGIC.length && sample.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      return true;
    }
    for (const byte of sample) {
      if (byte < 9 || (byte > 13 && byte < 32)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor is already unusable; there is nothing else to close.
      }
    }
  }
}

function scoreCandidate(candidate) {
  let score = 0;
  if (isTranscriptFile(candidate.path)) score += 20;
  if (Date.now() - candidate.mtimeMs <= RECENT_MS) score += 10;
  if (candidate.sessionMatch) score += 60;
  if (candidate.dataLike) score += 10;
  return score;
}

function matchesSession(relative, sessionId) {
  if (!sessionId) return false;
  const needle = sessionId.toLowerCase();
  return relative.split(path.sep).some((segment) => segment.toLowerCase().includes(needle));
}

function isEligible(candidate, sessionId) {
  if (sessionId) return candidate.sessionMatch === true;
  return TRANSCRIPT_ONLY_EXTENSIONS.has(path.extname(candidate.path).toLowerCase());
}

function normalizeForCompare(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function collectOsDirs(env) {
  const dirs = [];
  for (const name of Object.keys(env)) {
    if (!OS_DIR_VARIABLE.test(name) || !env[name]) continue;
    try {
      const absolute = path.resolve(env[name]);
      if (fs.statSync(absolute).isDirectory()) dirs.push(absolute);
    } catch {
      continue;
    }
  }
  return dirs;
}

function isInsideOsTree(absolute, osDirs) {
  const target = normalizeForCompare(absolute);
  return osDirs.some((dir) => {
    const base = normalizeForCompare(dir).replace(/[\\/]+$/, '');
    return target === base || target.startsWith(`${base}${path.sep}`);
  });
}

function collectFacts(env) {
  const rootsByPath = new Map();
  const filesByPath = new Map();
  const osDirs = collectOsDirs(env);
  let sessionId = null;

  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (!value) continue;

    if (SESSION_VARIABLE.test(name) && SESSION_ID.test(value)) {
      if (!sessionId || value.length > sessionId.length) sessionId = value;
    }

    let stat;
    try {
      stat = fs.statSync(path.resolve(value));
    } catch {
      continue;
    }

    if (stat.isDirectory() && ROOT_VARIABLE.test(name)) {
      const absolute = path.resolve(value);
      if (OS_VARIABLE.test(name)) continue;
      if (path.parse(absolute).root === absolute) continue;
      if (isInsideOsTree(absolute, osDirs)) continue;
      if (!rootsByPath.has(absolute)) {
        rootsByPath.set(absolute, {
          path: absolute,
          variable: name,
          dataLike: DATA_LIKE_VARIABLE.test(name)
        });
      }
    } else if (stat.isFile() && isTranscriptFile(value) && isTextLike(path.resolve(value))) {
      const absolute = path.resolve(value);
      if (!filesByPath.has(absolute)) {
        filesByPath.set(absolute, {
          path: absolute,
          mtimeMs: stat.mtimeMs,
          source: 'env-file',
          dataLike: false
        });
      }
    }
  }

  const roots = [...rootsByPath.values()];
  const preferred = roots.filter((root) => PREFERRED_ROOT.test(root.variable));
  const rest = roots.filter((root) => !PREFERRED_ROOT.test(root.variable));

  return {
    sessionId,
    roots: preferred.concat(rest).slice(0, MAX_ROOTS),
    files: [...filesByPath.values()]
  };
}

function searchRoots(roots, sessionId, options, startedAt) {
  const deadline = startedAt + options.timeoutMs;
  const candidates = [];
  let entriesScanned = 0;
  let foundMatch = false;

  for (let index = 0; index < roots.length && !foundMatch; index += 1) {
    if (entriesScanned >= options.maxEntries || Date.now() >= deadline) break;
    const root = roots[index];
    const rootsLeft = roots.length - index;
    const entryBudget = Math.max(1, Math.ceil((options.maxEntries - entriesScanned) / rootsLeft));
    const timeBudget = Math.floor((deadline - Date.now()) / rootsLeft);
    const rootDeadline = Math.min(deadline, Date.now() + timeBudget);
    const queue = [{ dir: root.path, depth: 0 }];
    let next = 0;
    let taken = 0;
    const stopRoot = () => taken >= entryBudget
      || entriesScanned >= options.maxEntries
      || foundMatch
      || Date.now() >= rootDeadline;

    while (next < queue.length && !stopRoot()) {
      const current = queue[next];
      next += 1;

      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

      for (const entry of entries) {
        if (stopRoot()) break;
        taken += 1;
        entriesScanned += 1;
        const absolute = path.join(current.dir, entry.name);

        if (entry.isDirectory()) {
          if (current.depth + 1 <= MAX_DEPTH && !SKIP_DIRS.has(entry.name.toLowerCase())) {
            queue.push({ dir: absolute, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile() || !isTranscriptFile(entry.name)) continue;

        let stat;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue;
        }
        const relative = path.relative(root.path, absolute);
        const sessionMatch = matchesSession(relative, sessionId);
        if (!sessionMatch && Date.now() - stat.mtimeMs > RECENT_MS) continue;
        if (!isTextLike(absolute)) continue;

        candidates.push({
          path: absolute,
          mtimeMs: stat.mtimeMs,
          source: 'search-root',
          sessionMatch,
          dataLike: root.dataLike
        });
        if (sessionMatch) foundMatch = true;
      }
    }
  }

  return { candidates, entriesScanned };
}

function reportPath(absolute, projectRoot) {
  if (!projectRoot) return absolute;
  const relative = path.relative(projectRoot, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolute;
}

function main(argv) {
  const startedAt = Date.now();
  const options = parseArgs(argv);
  const facts = collectFacts(process.env);
  const discovered = searchRoots(facts.roots, facts.sessionId, options, startedAt);
  const candidates = facts.files.concat(discovered.candidates);

  for (const candidate of candidates) {
    if (candidate.sessionMatch === undefined) {
      candidate.sessionMatch = matchesSession(candidate.path, facts.sessionId);
    }
    candidate.score = scoreCandidate(candidate);
  }
  candidates.sort((left, right) => (
    right.score - left.score
    || right.mtimeMs - left.mtimeMs
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  ));

  const best = candidates.find((candidate) => isEligible(candidate, facts.sessionId)) || null;
  const result = {
    found: Boolean(best),
    path: best ? reportPath(best.path, options.root) : null,
    score: best ? best.score : 0,
    source: best ? best.source : null,
    sessionId: facts.sessionId,
    entriesScanned: discovered.entriesScanned,
    elapsedMs: Date.now() - startedAt,
    roots: facts.roots.map((root) => ({ variable: root.variable, path: root.path }))
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main(process.argv.slice(2));
