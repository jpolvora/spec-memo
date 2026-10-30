#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = /^(?:tbd|todo|placeholder|\?+|[-–—.]{1,3}|\.{3}|n\/?a)$/i;

const SPEC_STATUSES = ['draft', 'awaiting-approval', 'ready-to-implement', 'implemented', 'abandoned'];

// Spec filenames: `00036-slug.md` (original) or `00036-v01-slug.md`,
// `00036-v02-slug.md`, ... (versioned revisions). Both forms are valid;
// the sync/index layer resolves the latest revision per prefix+slug group.
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

function isSpecFilename(filename) {
  return parseSpecFilename(filename) !== null;
}

const EARS_PATTERNS = [
  { name: 'ubiquitous', re: /^the\s+.+\s+shall\s+.+/i },
  { name: 'event-driven', re: /^when\s+.+,\s*the\s+.+\s+shall\s+.+/i },
  { name: 'state-driven', re: /^while\s+.+,\s*the\s+.+\s+shall\s+.+/i },
  { name: 'optional-feature', re: /^where\s+.+,\s*the\s+.+\s+shall\s+.+/i },
  { name: 'unwanted-behavior', re: /^if\s+.+,\s*then\s+the\s+.+\s+shall\s+.+/i },
];

function usage() {
  process.stdout.write(
    'Usage: node validate_spec.cjs [--help|-h] [--mode=authoring|compat] [--json] [--modification] [--repo-root <dir>] <spec>\n'
  );
}

function parseArgs(argv) {
  const options = { json: false, modification: false, mode: 'authoring' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--json' || token === '--modification') options[token.slice(2)] = true;
    else if (token === '--repo-root') options.repoRoot = argv[++index];
    else if (token === '--mode') options.mode = String(argv[++index] || '').trim();
    else if (token.startsWith('--mode=')) options.mode = token.slice('--mode='.length).trim();
    else if (token.startsWith('-')) throw new Error(`unknown argument: ${token}`);
    else if (!options.spec) options.spec = token;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (options.help) return options;
  if (!options.spec) throw new Error('spec path is required');
  if (!['authoring', 'compat'].includes(options.mode)) {
    throw new Error('--mode must be authoring or compat');
  }
  return options;
}

function frontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (item) values[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function compositeReason(text) {
  if ((text.match(/\*\*[^*]+\*\*/g) || []).length > 1) return 'more than one bolded component';
  if (text.trim().split(/\s+/).length > 60) return 'more than 60 words';
  const joinedImperatives = text.match(/\b(?:and|or)\s+(?:add|assert|build|check|create|emit|enforce|ensure|fail|implement|include|keep|make|persist|publish|record|reject|remove|render|report|require|run|search|store|support|update|validate|verify|write)\b/gi) || [];
  const openingImperative = /^(?:add|assert|build|check|create|emit|enforce|ensure|fail|implement|include|keep|make|persist|publish|record|reject|remove|render|report|require|run|search|store|support|update|validate|verify|write)\b/i.test(text.trim());
  if (openingImperative && joinedImperatives.length > 1) return 'more than one conjunction-joined imperative';
  return '';
}

function earsViolation(acText) {
  const body = String(acText || '').trim();
  if (EARS_PATTERNS.some((pattern) => pattern.re.test(body))) return '';
  return 'AC does not match a documented EARS pattern (expected: The/When/While/Where/If <trigger> ... the <system> shall <response>).';
}

function headingPresent(text, heading) {
  return new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text);
}

function lastHeadingIndex(text, heading) {
  const lines = text.split('\n');
  let last = -1;
  let offset = 0;
  for (const line of lines) {
    if (line === heading || (line.startsWith(heading) && /^\s*$/.test(line.slice(heading.length)))) last = offset;
    offset += line.length + 1;
  }
  return last;
}

function tableAfterHeading(text, heading) {
  const start = text.search(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (start < 0) return [];
  return tableRowsAfter(text, start);
}

function tableAfterCanonicalHeading(text, heading) {
  const start = lastHeadingIndex(text, heading);
  if (start < 0) return [];
  return tableRowsAfter(text, start);
}

function tableRowsAfter(text, start) {
  const rest = text.slice(start).split('\n').slice(1);
  const rows = [];
  let inTable = false;
  for (const line of rest) {
    if (/^##\s+/.test(line)) break;
    if (!line.trim()) {
      if (inTable) break;
      continue;
    }
    if (!line.includes('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (!cells.length) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

function isPlaceholder(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  if (/^n\/?a\s+because\b/i.test(trimmed)) return false;
  return PLACEHOLDER.test(trimmed);
}

function sectionBody(text, heading) {
  const start = text.search(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start).split('\n').slice(1);
  const lines = [];
  for (const line of rest) {
    if (/^##\s+/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function subsectionBody(text, heading) {
  const start = text.search(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start).split('\n').slice(1);
  const lines = [];
  for (const line of rest) {
    if (/^#{2,3}\s+/.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function sectionIsPlaceholder(body) {
  const lines = String(body || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  const content = [];
  for (const line of lines) {
    if (/^#{3,}\s/.test(line)) continue;
    if (line.includes('|')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      cells.forEach((cell) => {
        if (cell) content.push(cell);
      });
      continue;
    }
    content.push(line.replace(/^[-*+]\s+/, '').replace(/^\*\*[^*]+\*\*:\s*/, ''));
  }
  if (!content.length) return true;
  return content.every((item) => isPlaceholder(item));
}

function readinessFindings(text) {
  const errors = [];
  const warnings = [];
  const dorHeading = '## Definition of Ready (DoR)';
  const notesHeading = '## Validation & Observation Notes';
  const hasDor = headingPresent(text, dorHeading);
  const hasNotes = headingPresent(text, notesHeading);
  if (!hasDor) {
    const item = { code: 'dor-heading', message: 'Required section is missing: ## Definition of Ready (DoR)' };
    errors.push(item);
    warnings.push(item);
  } else {
    const data = tableAfterHeading(text, dorHeading).slice(1);
    const emptyTable = !data.length || data.every((cells) => cells.every((cell) => isPlaceholder(cell)));
    if (emptyTable || sectionIsPlaceholder(sectionBody(text, dorHeading))) {
      errors.push({
        code: 'dor-empty',
        message: 'Definition of Ready (DoR) must include non-placeholder readiness items.',
      });
    }
  }
  if (!hasNotes) {
    const item = { code: 'notes-heading', message: 'Required section is missing: ## Validation & Observation Notes' };
    errors.push(item);
    warnings.push(item);
  } else if (sectionIsPlaceholder(sectionBody(text, notesHeading))) {
    errors.push({
      code: 'notes-empty',
      message: 'Validation & Observation Notes must include non-placeholder observation or negative-test content.',
    });
  } else {
    const nsFindings = negativeScenarioFindings(text);
    errors.push(...nsFindings);
    warnings.push(...nsFindings);
  }
  return { errors, warnings };
}

function negativeScenarioFindings(text) {
  const errors = [];
  const notesHeading = '## Validation & Observation Notes';
  if (!headingPresent(text, notesHeading)) return errors;
  const notesBody = sectionBody(text, notesHeading);
  const subsection = '### Negative & Failing Test Scenarios';
  if (!headingPresent(notesBody, subsection)) {
    errors.push({
      code: 'negative-subsection',
      message: 'Validation & Observation Notes must include ### Negative & Failing Test Scenarios with at least one non-placeholder bullet.',
    });
    return errors;
  }
  const bullets = subsectionBody(notesBody, subsection)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''));
  if (!bullets.length || bullets.every((item) => isPlaceholder(item))) {
    errors.push({
      code: 'negative-empty',
      message: '### Negative & Failing Test Scenarios must list at least one expected red test or error state.',
    });
  }
  return errors;
}

function closureFindings(text) {
  const errors = [];
  const warnings = [];
  const hasOut = headingPresent(text, '## Out of Scope');
  const hasAssumptions = headingPresent(text, '## Assumptions & Open Questions');
  if (!hasOut) {
    const item = { code: 'closure-heading', message: 'Required section is missing: ## Out of Scope' };
    errors.push(item);
    warnings.push(item);
  }
  if (!hasAssumptions) {
    const item = { code: 'closure-heading', message: 'Required section is missing: ## Assumptions & Open Questions' };
    errors.push(item);
    warnings.push(item);
  }
  if (hasOut) {
    const rows = tableAfterCanonicalHeading(text, '## Out of Scope');
    const data = rows.slice(1);
    const substantive = data.filter((cells) => cells.some((cell) => !isPlaceholder(cell)));
    if (!substantive.length) {
      errors.push({ code: 'out-of-scope-empty', message: 'Out of Scope must include at least one substantive data row.' });
    }
  }
  if (hasAssumptions) {
    const rows = tableAfterHeading(text, '## Assumptions & Open Questions');
    const header = rows[0] || [];
    const data = rows.slice(1);
    if (!data.length) {
      errors.push({ code: 'assumptions-empty', message: 'Assumptions & Open Questions must include at least one data row.' });
    }
    const defaultIdx = header.findIndex((cell) => /chosen default/i.test(cell));
    const rationaleIdx = header.findIndex((cell) => /^rationale$/i.test(cell));
    const chosenAt = defaultIdx >= 0 ? defaultIdx : 1;
    const rationaleAt = rationaleIdx >= 0 ? rationaleIdx : 2;
    data.forEach((cells, index) => {
      if (isPlaceholder(cells[chosenAt]) || isPlaceholder(cells[rationaleAt])) {
        errors.push({
          code: 'assumption-placeholder',
          message: `Assumptions row ${index + 1} has an empty or placeholder Chosen default or Rationale.`,
        });
      }
    });
  }
  return { errors, warnings };
}

function validate(text, options) {
  const mode = (options && options.mode) || 'authoring';
  const errors = [];
  const warnings = [];
  const normalizedText = String(text || '').replace(/\r\n?/g, '\n');

  const fm = frontmatter(normalizedText);
  if (!fm) {
    errors.push({ code: 'frontmatter-missing', message: 'Required YAML frontmatter is missing.' });
  } else {
    for (const key of ['id', 'slug', 'title', 'source', 'status', 'specDate']) {
      if (!(key in fm) || fm[key] === '') {
        errors.push({ code: 'frontmatter-key', message: `Frontmatter key is required: ${key}` });
      }
    }
    if (fm.status && !SPEC_STATUSES.includes(fm.status)) {
      errors.push({ code: 'status', message: `status must be one of: ${SPEC_STATUSES.join(', ')}.` });
    }
    if (!['local', 'github', 'azure-devops'].includes(fm.source)) {
      errors.push({ code: 'source', message: 'source must be local, github, or azure-devops.' });
    }
    if (['github', 'azure-devops'].includes(fm.source) && !/^### Prior Work Sweep\s*$/m.test(normalizedText)) {
      errors.push({ code: 'prior-work', message: 'Tracker specifications require ### Prior Work Sweep.' });
    }
  }

  for (const heading of ['## Description', '## Acceptance Criteria']) {
    if (!normalizedText.includes(heading)) {
      errors.push({ code: 'section', message: `Required section is missing: ${heading}` });
    }
  }

  const rows = [...normalizedText.matchAll(/^- (AC([1-9][0-9]*)):\s*(.+)$/gm)];
  if (!rows.length) {
    errors.push({ code: 'acceptance-criteria', message: 'At least one one-line acceptance criterion is required.' });
  }

  rows.forEach((row, index) => {
    const expected = index + 1;
    if (Number(row[2]) !== expected) {
      errors.push({ code: 'ac-sequence', ac: row[1], message: `Expected AC${expected}, found ${row[1]}.` });
    }
    const reason = compositeReason(row[3]);
    if (reason) {
      errors.push({ code: 'composite-ac', ac: row[1], message: `${row[1]} is composite: ${reason}.` });
    }
    if (mode === 'authoring') {
      const ears = earsViolation(row[3]);
      if (ears) {
        errors.push({ code: 'ac-ears', ac: row[1], message: `${row[1]} violates EARS syntax: ${ears}` });
      }
    }
  });

  const description = normalizedText.match(/## Description\s*\n([\s\S]*?)(?=\n## )/)?.[1] || '';
  const modification = (options && options.modification) || /\b(?:modify|modification|bug\s*fix|bugfix|existing\s+(?:feature|workflow|behavior)|refactor|upgrade)\b/i.test(description);
  if (modification && !/^### Design Intent\s*$/m.test(normalizedText)) {
    errors.push({ code: 'design-intent', message: 'Modification specifications require ### Design Intent.' });
  }

  const closure = closureFindings(normalizedText);
  const readiness = readinessFindings(normalizedText);

  if (mode === 'authoring') {
    errors.push(...closure.errors, ...readiness.errors);
  } else {
    for (const warning of [...closure.warnings, ...readiness.warnings]) {
      warnings.push(warning);
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
    acceptanceCriteria: rows.map((row) => row[1])
  };
}

function validateFile(specPath, options) {
  const fullPath = path.resolve(specPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  return validate(content, options);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exitCode = 0;
      return;
    }
    const targetFile = path.resolve(options.repoRoot || '.', options.spec);
    const result = validateFile(targetFile, options);

    if (options.json) {
      process.stdout.write(JSON.stringify({ file: options.spec.replace(/\\/g, '/'), ...result }, null, 2) + '\n');
    } else {
      for (const warning of result.warnings) {
        process.stderr.write(`WARN: ${warning.message}\n`);
      }
      for (const error of result.errors) {
        process.stderr.write(`ERROR: ${error.ac ? `${error.ac}: ` : ''}${error.message}\n`);
      }
      if (result.ok) {
        process.stdout.write(`PASS: ${options.spec} (${result.acceptanceCriteria.length} ACs)\n`);
      }
    }

    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EARS_PATTERNS,
  SPEC_STATUSES,
  SPEC_FILENAME_RE,
  parseSpecFilename,
  isSpecFilename,
  earsViolation,
  validate,
  validateFile,
  parseArgs,
  usage
};
