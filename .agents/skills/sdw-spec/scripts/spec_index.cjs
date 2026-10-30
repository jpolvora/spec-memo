'use strict';

const fs = require('fs');
const path = require('path');
const { validateFile } = require('./validate_spec.cjs');

function resolvePaths(projectRoot) {
  let root = projectRoot ? path.resolve(projectRoot) : process.cwd();
  let specsDir = path.join(root, '.sdw', 'specs');
  let stateDir = path.join(root, '.sdw', 'state');

  try {
    const sdwConfig = require('../../sdw-config/scripts/sdw_config.cjs');
    if (sdwConfig && typeof sdwConfig.loadConfig === 'function') {
      const cfg = sdwConfig.loadConfig(root);
      if (cfg.specsDir) specsDir = cfg.specsDir;
      if (cfg.stateDir) stateDir = cfg.stateDir;
    }
  } catch (e) {
    const configFile = path.join(root, '.sdw', 'config.json');
    if (fs.existsSync(configFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const normRoot = root.replace(/\\/g, '/');
        if (raw.specsDir) specsDir = raw.specsDir.replace(/\{projectRoot\}/g, normRoot);
        if (raw.stateDir) stateDir = raw.stateDir.replace(/\{projectRoot\}/g, normRoot);
      } catch (err) {}
    }
  }

  return {
    root,
    specsDir: path.resolve(specsDir),
    stateDir: path.resolve(stateDir),
    indexPath: path.join(path.resolve(specsDir), 'index.specs.md')
  };
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (item) {
      let val = item[2].trim().replace(/^['"]|['"]$/g, '');
      if (val === 'null') val = null;
      values[item[1]] = val;
    }
  }
  return values;
}

// Versioned spec filenames: `00036-slug.md` (v00, the untouched original)
// or `00036-v01-slug.md`, `00036-v02-slug.md`, ... (later revisions).
const SPEC_FILENAME_RE = /^(\d{5})(?:-v(\d{2}))?-(.+)\.md$/;

function parseSpecFilename(filename) {
  const base = String(filename || '').split('/').pop();
  const m = base.match(SPEC_FILENAME_RE);
  if (!m) return null;
  return {
    prefix: m[1],
    version: m[2] ? parseInt(m[2], 10) : 0,
    baseSlug: m[3],
    slug: base.replace(/\.md$/, ''),
    filename: base
  };
}

function specGroupKey(parsed) {
  return `${parsed.prefix}-${parsed.baseSlug}`;
}

function versionedFilename(prefix, version, baseSlug) {
  return `${prefix}-v${String(version).padStart(2, '0')}-${baseSlug}.md`;
}

// Every on-disk file in one spec group (original + revisions), oldest first.
// `key` may be a prefix, full slug, base slug, group key, or filename.
function findSpecGroupFiles(specsDir, key) {
  if (!specsDir || !fs.existsSync(specsDir)) return null;
  const target = String(key || '').trim();
  if (!target) return null;
  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md');
  const parsed = files.map(f => ({ parsed: parseSpecFilename(f), file: f })).filter(x => x.parsed);
  if (parsed.length === 0) return null;
  let group = null;
  const exact = parsed.find(x => x.parsed.slug === target || x.file === target);
  if (exact) group = specGroupKey(exact.parsed);
  if (!group) {
    const byPrefix = parsed.filter(x => x.parsed.prefix === target);
    if (byPrefix.length > 0) group = specGroupKey(byPrefix[0].parsed);
  }
  if (!group) {
    const byBase = parsed.filter(x => x.parsed.baseSlug === target || specGroupKey(x.parsed) === target);
    if (byBase.length > 0) group = specGroupKey(byBase[0].parsed);
  }
  if (!group) {
    const loose = parsed.find(x => x.parsed.slug.includes(target) || target.includes(x.parsed.slug));
    if (loose) group = specGroupKey(loose.parsed);
  }
  if (!group) return null;
  const members = parsed
    .filter(x => specGroupKey(x.parsed) === group)
    .map(x => ({ ...x.parsed, fullPath: path.join(specsDir, x.file) }))
    .sort((a, b) => a.version - b.version);
  if (members.length === 0) return null;
  return { key: group, prefix: members[0].prefix, baseSlug: members[0].baseSlug, files: members };
}

function latestGroupFile(specsDir, key) {
  const group = findSpecGroupFiles(specsDir, key);
  if (!group || group.files.length === 0) return null;
  return group.files[group.files.length - 1];
}

function readIndex(options = {}) {
  const { indexPath, specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(indexPath)) {
    return {
      exists: false,
      indexPath,
      entries: []
    };
  }

  const content = fs.readFileSync(indexPath, 'utf8');
  const lines = content.split('\n');
  const entries = [];

  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('| Prefix |') || trimmed.startsWith('|Prefix|')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!trimmed.startsWith('|')) {
        if (trimmed) inTable = false;
        continue;
      }
      if (/^\|[\s:-]+\|$/.test(trimmed) || trimmed.includes('---')) {
        continue;
      }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length >= 6) {
        entries.push({
          prefix: cells[0] || '',
          slug: cells[1] || '',
          title: cells[2] || '',
          status: cells[3] || 'pending',
          source: cells[4] || 'local',
          specDate: cells[5] || '',
          validation: cells[6] || 'PASS',
          archivalDate: cells[7] || null
        });
      }
    }
  }

  return {
    exists: true,
    indexPath,
    entries
  };
}

function readTrailingBlock(indexPath) {
  // Spec 00071 AC5: the registry writer owns the header, status definitions,
  // and specification table only. Everything after the last table row is
  // foreign (hand-written notes such as a Lean-Core cut list) and must be
  // carried over byte-for-byte on rewrite. Returns '' when there is no
  // foreign content. Read-only: never writes.
  try {
    if (!indexPath || !fs.existsSync(indexPath)) return '';
    const content = fs.readFileSync(indexPath, 'utf8');
    const lines = content.split('\n');
    // Anchor on the owned specification table: it opens with the Prefix/Slug
    // header row and its rows are contiguous. Scanning stops at the first line
    // that is not a table row, including a blank line, so a foreign markdown
    // table further down is never mistaken for an owned row.
    let lastRow = -1;
    let inTable = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!inTable) {
        if (/^\|/.test(t) && /prefix/i.test(t) && /slug/i.test(t)) inTable = true;
        continue;
      }
      if (/^\|.*\|\s*$/.test(t)) {
        lastRow = i;
        continue;
      }
      // Owned rows are contiguous: a blank line or any other line ends the
      // owned table, so a foreign table that follows it stays foreign and
      // survives the rewrite.
      break;
    }
    if (lastRow === -1) {
      // No recognizable owned table: nothing foreign can be identified.
      return '';
    }
    const trailing = lines.slice(lastRow + 1).join('\n');
    if (!trailing.trim()) return '';
    return trailing;
  } catch (e) {
    return '';
  }
}

function writeIndex(entries, options = {}) {
  const { indexPath, specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    fs.mkdirSync(specsDir, { recursive: true });
  }

  // Spec 00071 AC5: preserve foreign trailing sections across rewrites.
  const trailing = readTrailingBlock(indexPath);

  // Sort entries deterministically by prefix
  entries.sort((a, b) => {
    const numA = parseInt(a.prefix, 10) || 0;
    const numB = parseInt(b.prefix, 10) || 0;
    return numA - numB;
  });

  let md = `# Specification Index\n\n`;
  md += `Central repository index tracking specification lifecycle states, metadata, and validation health.\n\n`;
  md += `## Status Definitions\n\n`;
  md += `- \`pending\`: Specification is authored and awaiting execution or currently in progress.\n`;
  md += `- \`completed\`: Implementation, verification, and pull request preparation are complete.\n`;
  md += `- \`archived\`: Specification lifecycle is finished and retired from active development.\n\n`;
  md += `## Specifications\n\n`;
  md += `| Prefix | Slug | Title | Status | Source | Spec Date | Validation | Archival Date |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;

  for (const e of entries) {
    const prefix = e.prefix || '';
    const slug = e.slug || '';
    const title = (e.title || '').replace(/\|/g, '\\|');
    const status = e.status || 'pending';
    const source = e.source || 'local';
    const specDate = e.specDate || '';
    const validation = e.validation || 'PASS';
    const archival = e.archivalDate || '-';
    md += `| ${prefix} | ${slug} | ${title} | ${status} | ${source} | ${specDate} | ${validation} | ${archival} |\n`;
  }

  fs.writeFileSync(indexPath, trailing ? `${md}${trailing}` : md, 'utf8');
  return entries;
}

function scanSpecsDir(options = {}) {
  const { specsDir } = resolvePaths(options.root);
  if (!fs.existsSync(specsDir)) {
    return [];
  }

  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.md') && f !== 'index.specs.md');
  // Group original + versioned revisions by prefix+slug; the index tracks
  // only the latest file per group while history stays on disk.
  const groups = new Map();
  for (const f of files) {
    const parsed = parseSpecFilename(f);
    const key = parsed ? specGroupKey(parsed) : `raw:${f}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file: f, parsed });
  }
  const detected = [];

  for (const [, members] of groups) {
    members.sort((a, b) => (a.parsed ? a.parsed.version : 0) - (b.parsed ? b.parsed.version : 0));
    const latest = members[members.length - 1];
    const fullPath = path.join(specsDir, latest.file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const fm = parseFrontmatter(content);
    const prefix = latest.parsed ? latest.parsed.prefix
      : (latest.file.match(/^(\d{5})-/) ? latest.file.match(/^(\d{5})-/)[1]
        : (fm.slug && fm.slug.match(/^(\d{5})-/) ? fm.slug.match(/^(\d{5})-/)[1] : ''));
    const slug = fm.slug || (latest.parsed ? latest.parsed.slug : path.basename(latest.file, '.md'));
    const title = fm.title || slug;
    const source = fm.source || 'local';
    const specDate = fm.specDate || '';

    let validation = 'PASS';
    try {
      const v = validateFile(fullPath, { mode: 'authoring' });
      validation = v.ok ? 'PASS' : 'FAIL';
    } catch (e) {
      validation = 'FAIL';
    }

    detected.push({
      prefix,
      slug,
      title,
      status: 'pending',
      source,
      specDate,
      validation,
      archivalDate: null,
      filename: latest.file,
      versions: members.length,
      version: latest.parsed ? latest.parsed.version : 0
    });
  }

  return detected;
}

function initIndex(options = {}) {
  const { indexPath } = resolvePaths(options.root);

  if (fs.existsSync(indexPath) && !options.force) {
    const existing = readIndex(options);
    if (existing.entries.length > 0) {
      throw new Error(`Specification index already exists at ${indexPath}. Preserving existing records. Use --force to overwrite.`);
    }
  }

  const detected = scanSpecsDir(options);
  writeIndex(detected, options);
  return detected;
}

function listIndex(options = {}) {
  const { exists, entries } = readIndex(options);
  let list = entries;

  if (!exists) {
    // If index.specs.md doesn't exist yet, scan directory directly
    list = scanSpecsDir(options);
  }

  // Attach live revision counts so list groups by prefix+slug and shows
  // the latest entry plus how many on-disk revisions it has.
  try {
    const { specsDir } = resolvePaths(options.root);
    list = list.map(e => {
      const group = findSpecGroupFiles(specsDir, e.slug) || findSpecGroupFiles(specsDir, e.prefix);
      if (!group) return e;
      const latest = group.files[group.files.length - 1];
      return { ...e, versions: group.files.length, version: latest.version, filename: latest.filename };
    });
  } catch (err) {}

  if (options.status) {
    const targetStatus = String(options.status).toLowerCase().trim();
    list = list.filter(e => (e.status || '').toLowerCase() === targetStatus);
  }

  return list;
}

function archiveSpec(slugOrPrefix, options = {}) {
  const { exists, entries } = readIndex(options);
  if (!exists || entries.length === 0) {
    throw new Error('Specification index does not exist. Run "sdw-spec init" first.');
  }

  const target = String(slugOrPrefix).trim();
  const index = entries.findIndex(e => e.slug === target || e.prefix === target || target.includes(e.slug));

  if (index === -1) {
    throw new Error(`Specification "${slugOrPrefix}" not found in specification index.`);
  }

  const entry = entries[index];
  if (entry.status !== 'completed' && !options.force) {
    throw new Error(`Cannot archive specification "${entry.slug}" with status "${entry.status}". Only completed specifications can be archived. Use --force to override.`);
  }

  entry.status = 'archived';
  entry.archivalDate = new Date().toISOString().slice(0, 10);
  writeIndex(entries, options);
  return entry;
}

function updateSpecStatus(slugOrPrefix, newStatus, options = {}) {
  const { exists, entries } = readIndex(options);
  if (!exists) return null;

  const target = String(slugOrPrefix).trim();
  const entry = entries.find(e => e.slug === target || e.prefix === target || target.includes(e.slug));
  if (!entry) return null;

  entry.status = newStatus;
  if (options.validation) {
    entry.validation = options.validation;
  }
  writeIndex(entries, options);
  return entry;
}

function registerSpec(meta, options = {}) {
  const { entries } = readIndex(options);
  // Match by slug, by version-group (original + vNN revisions share one row
  // that always points at the latest), or by numeric prefix.
  const metaParsed = parseSpecFilename(`${meta.slug || ''}.md`);
  const metaKey = metaParsed ? specGroupKey(metaParsed) : null;
  const existingIdx = entries.findIndex(e => {
    if (e.slug === meta.slug) return true;
    if (metaKey) {
      const eParsed = parseSpecFilename(`${e.slug || ''}.md`);
      if (eParsed && specGroupKey(eParsed) === metaKey) return true;
      if (e.filename) {
        const fParsed = parseSpecFilename(e.filename);
        if (fParsed && specGroupKey(fParsed) === metaKey) return true;
      }
    }
    return Boolean(meta.prefix && e.prefix === meta.prefix);
  });

  if (existingIdx >= 0) {
    entries[existingIdx] = {
      ...entries[existingIdx],
      ...meta
    };
  } else {
    entries.push({
      prefix: meta.prefix || '',
      slug: meta.slug || '',
      title: meta.title || meta.slug || '',
      status: meta.status || 'pending',
      source: meta.source || 'local',
      specDate: meta.specDate || new Date().toISOString().slice(0, 10),
      validation: meta.validation || 'PASS',
      archivalDate: meta.archivalDate || null
    });
  }

  writeIndex(entries, options);
  return meta;
}

module.exports = {
  resolvePaths,
  parseFrontmatter,
  parseSpecFilename,
  specGroupKey,
  versionedFilename,
  findSpecGroupFiles,
  latestGroupFile,
  readIndex,
  writeIndex,
  readTrailingBlock,
  scanSpecsDir,
  initIndex,
  listIndex,
  archiveSpec,
  updateSpecStatus,
  registerSpec
};
