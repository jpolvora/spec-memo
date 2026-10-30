#!/usr/bin/env node
'use strict';

// Spec 00071 AC6: report a header-vs-registry status divergence WITHOUT
// mutating either file. Exit 0 when in sync, 2 when diverged, 1 on error
// (unknown slug, missing file, malformed input). Never writes, never repairs.

const path = require('path');
const { checkHeaderRegistryDivergence } = require('./spec_sync.cjs');

function parseArgs(args) {
  const options = { slug: null, root: null, json: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') options.root = args[++i];
    else if (arg.startsWith('--root=')) options.root = arg.slice(7);
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  options.slug = positional[0] || null;
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.slug) {
    console.error('Error: a specification slug or prefix is required: node spec_check.cjs <slug> [--root <path>] [--json].');
    process.exit(1);
  }
  let report;
  try {
    report = checkHeaderRegistryDivergence(options.slug, { root: options.root });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.message);
  }
  process.exit(report.diverged ? 2 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
