#!/usr/bin/env node
'use strict';

// append_changelog.cjs — append one delivery record to the project changelog.
//
// The target file comes from `changelogFile` in {projectRoot}/.sdw/config.json
// and falls back to {projectRoot}/CHANGELOG.md. Entries are inserted directly
// below the `# Changelog` header; existing bytes are preserved unchanged and an
// identical Prompt/Done/Result block is skipped. The resolved path must stay
// inside the project root.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = '{projectRoot}/CHANGELOG.md';
const HEADER = '# Changelog';
const USAGE = 'Usage: append_changelog.cjs --prompt <text> --done <text> --result <text> [--agent <id>] [--date "YYYY-MM-DD HH:MM"] [--root <path>] [--json]';

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    prompt: null,
    done: null,
    result: null,
    agent: null,
    date: null,
    root: null,
    json: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--prompt') options.prompt = argv[++i];
    else if (arg === '--done') options.done = argv[++i];
    else if (arg === '--result') options.result = argv[++i];
    else if (arg === '--agent') options.agent = argv[++i];
    else if (arg === '--date') options.date = argv[++i];
    else if (arg === '--root') options.root = argv[++i];
    else if (arg.startsWith('--prompt=')) options.prompt = arg.slice('--prompt='.length);
    else if (arg.startsWith('--done=')) options.done = arg.slice('--done='.length);
    else if (arg.startsWith('--result=')) options.result = arg.slice('--result='.length);
    else if (arg.startsWith('--agent=')) options.agent = arg.slice('--agent='.length);
    else if (arg.startsWith('--date=')) options.date = arg.slice('--date='.length);
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }

  for (const flag of ['prompt', 'done', 'result']) {
    const value = options[flag];
    if (value === undefined || value === null) {
      throw new UsageError(`missing required --${flag}`);
    }
    if (String(value).trim() === '') {
      throw new UsageError(`missing required --${flag}: value must not be empty`);
    }
  }

  return options;
}

function findProjectRoot(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, '.sdw')) || fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function readConfig(root) {
  const configFile = path.join(root, '.sdw', 'config.json');
  if (!fs.existsSync(configFile)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`invalid .sdw/config.json: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid .sdw/config.json: expected a JSON object');
  }
  return parsed;
}

function resolveChangelogFile(root, config) {
  const configured = config && typeof config.changelogFile === 'string' && config.changelogFile.trim()
    ? config.changelogFile.trim()
    : DEFAULT_FILE;
  if (path.isAbsolute(configured)) {
    throw new Error(`changelogFile must be relative or use the {projectRoot} token: ${configured}`);
  }
  const projectRoot = path.resolve(root);
  const expanded = configured.replace(/\{projectRoot\}/g, projectRoot);
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(projectRoot, expanded);
  const relative = path.relative(projectRoot, resolved);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`changelogFile must resolve inside the project root: ${configured}`);
  }
  return resolved;
}

function localStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function entryBody(options) {
  return [
    `- **Prompt**: ${oneLine(options.prompt)}`,
    `- **Done**: ${oneLine(options.done)}`,
    `- **Result**: ${oneLine(options.result)}`
  ].join('\n');
}

function formatEntry(options, agent, stamp) {
  return [
    `### [${stamp}] Agent: ${agent}`,
    entryBody(options)
  ].join('\n');
}

// A record is a duplicate only when the exact three-line block occupies whole
// lines in the existing file. A substring match would silently drop a genuine
// record whose lines happen to prefix a longer line.
function isDuplicate(existing, body) {
  if (!existing) return false;
  const normalized = existing.replace(/\r\n/g, '\n');
  let index = normalized.indexOf(body);
  while (index !== -1) {
    const atLineStart = index === 0 || normalized[index - 1] === '\n';
    const afterBody = index + body.length;
    const atLineEnd = afterBody === normalized.length || normalized[afterBody] === '\n';
    if (atLineStart && atLineEnd) return true;
    index = normalized.indexOf(body, index + 1);
  }
  return false;
}

// Insert the block below `# Changelog` without rewriting existing content.
function renderChangelog(existing, block) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const entry = block.replace(/\n/g, eol);

  if (existing === '') {
    return `${HEADER}${eol}${eol}${entry}${eol}`;
  }

  const headerMatch = /^# Changelog[ \t]*(?:\r?\n|$)/m.exec(existing);
  if (!headerMatch) {
    return `${HEADER}${eol}${eol}${entry}${eol}${eol}${existing}`;
  }

  const headerEnd = headerMatch.index + headerMatch[0].length;
  const head = existing.slice(0, headerEnd);
  let rest = existing.slice(headerEnd);
  if (rest !== '' && !rest.startsWith('\n') && !rest.startsWith('\r\n')) {
    rest = `${eol}${eol}${rest}`;
  }

  return `${head}${eol}${entry}${eol}${rest}`;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, file);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      // Ignore cleanup failures; the original error is more useful.
    }
    throw error;
  }
}

function appendChangelog(options) {
  const root = options.root ? path.resolve(options.root) : findProjectRoot(process.cwd());
  const config = readConfig(root);
  if (config.changelogEnabled === false) {
    return { skipped: 'disabled', root };
  }

  const file = resolveChangelogFile(root, config);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const agent = options.agent && String(options.agent).trim() ? String(options.agent).trim() : 'agent';
  const stamp = options.date && String(options.date).trim() ? String(options.date).trim() : localStamp();
  const body = entryBody(options);

  if (isDuplicate(existing, body)) {
    return { skipped: 'duplicate-block', file, root };
  }

  writeAtomic(file, renderChangelog(existing, formatEntry(options, agent, stamp)));
  return { file, root };
}

function main(argv) {
  let options = null;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = appendChangelog(options);
    if (result.skipped) {
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, skipped: result.skipped })}\n`);
      else process.stdout.write(`changelog: skipped: ${result.skipped}\n`);
      return;
    }
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, file: result.file })}\n`);
    else process.stdout.write(`changelog: appended to ${result.file}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  appendChangelog,
  formatEntry,
  main,
  parseArgs,
  renderChangelog,
  resolveChangelogFile
};
