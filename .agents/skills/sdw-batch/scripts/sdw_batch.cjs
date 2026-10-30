#!/usr/bin/env node
'use strict';

// sdw-batch CLI: loop a specification list through sdw-run single runs.

const queue = require('./batch_queue.cjs');

const USAGE = `Usage: node sdw_batch.cjs <subcommand> [specPath...] [options]

Subcommands:
  run <specPath...>       Execute each specification as an independent sdw-run single run
  resume [batchId]        Continue a paused batch from its first non-completed item
  status [batchId]        Show batch progress
  help                    Show this help

Options:
  --root <path>           Target workspace project root
  --batch-id <id>         Explicit batch identifier
  --continue-on-error     Continue the queue when a specification fails
  --no-sync               Skip sdw-spec sync after a completed specification
  --dry-run               Validate the specification list and print the plan only
  --json                  Print the manifest as JSON
  -h, --help              Show this help`;

function parseArgs(argv) {
  const options = {
    subcommand: null,
    specPaths: [],
    batchId: null,
    root: null,
    json: false,
    dryRun: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--continue-on-error') options.continueOnError = true;
    else if (arg === '--no-sync') options.noSync = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--root') options.root = argv[++i];
    else if (arg.startsWith('--root=')) options.root = arg.slice(7);
    else if (arg === '--batch-id') options.batchId = argv[++i];
    else if (arg.startsWith('--batch-id=')) options.batchId = arg.slice(11);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  options.subcommand = positional[0] || null;
  if (options.subcommand === 'run') {
    options.specPaths = positional.slice(1);
  } else if (options.subcommand === 'resume' || options.subcommand === 'status') {
    options.batchId = options.batchId || positional[1] || null;
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error(USAGE);
    return 1;
  }

  if (!options.subcommand || options.help || options.subcommand === 'help') {
    console.log(USAGE);
    return options.help || options.subcommand === 'help' ? 0 : 1;
  }

  try {
    switch (options.subcommand) {
      case 'run':
        return queue.runBatch(options.specPaths, options);
      case 'resume':
        return queue.resumeBatch(options.batchId, options);
      case 'status': {
        const config = queue.loadConfig(options.root);
        const manifest = queue.loadManifest(config, options.batchId);
        if (!manifest) {
          console.error('No batch manifest found.');
          return 1;
        }
        console.log(options.json ? JSON.stringify(manifest, null, 2) : queue.formatStatus(manifest));
        return 0;
      }
      default:
        console.error(`Unknown subcommand: "${options.subcommand}". Run with --help.`);
        return 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, USAGE };
