#!/usr/bin/env node

import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { TOOL_NAMES, ToolName } from './types.js';
import { startMcpServer } from './mcp.js';

interface ParsedCliArgs {
  command?: string;
  subcommandHelp: boolean;
  isJson: boolean;
  options: Record<string, string | boolean>;
  positionals: string[];
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    subcommandHelp: false,
    isJson: false,
    options: {},
    positionals: []
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--json') {
      result.isJson = true;
    } else if (arg === '--help' || arg === '-h') {
      if (result.command) {
        result.subcommandHelp = true;
      } else {
        result.options.help = true;
      }
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=', 2);
        result.options[k] = v;
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          result.options[key] = next;
          i++;
        } else {
          result.options[key] = true;
        }
      }
    } else if (!result.command) {
      result.command = arg;
    } else {
      result.positionals.push(arg);
    }
    i++;
  }

  return result;
}

function printGeneralHelp(): void {
  console.log(`spec-memo — Local working memory for coding agents

Usage:
  memo <command> [options]
  memo serve

Core Memory Commands:
  bootstrap   Bind cwd's git remote; compile a session brief
  search      Filtered retrieval across memory records
  get         Read one record by id or kind+slug
  upsert      Write or update a memory record (trap, decision, spec, etc.)
  append      Append a changelog or audit run event
  forget      Supersede or archive a memory record
  gc          Apply TTL, compact shipped plans, rebuild FTS
  promote     Copy one record into the product repository

Utility Commands:
  doctor      Diagnose vault integrity and check product tree pollution
  import      Import legacy .agents tree into external vault
  serve       Run the stdio MCP server for agent integration

Global Options:
  --json      Output machine-readable JSON to stdout
  -h, --help  Show help for memo or a specific command
`);
}

function printCommandHelp(cmd: string): void {
  if (cmd === 'serve') {
    console.log(`Usage: memo serve

Starts the spec-memo stdio MCP server for AI agent host integration.`);
    return;
  }

  if (cmd === 'doctor') {
    console.log(`Usage: memo doctor [--json]

Inspects local vault status, SQLite FTS index integrity, and detects workflow pollution in the product repository.`);
    return;
  }

  if (cmd === 'import') {
    console.log(`Usage: memo import <productRoot> [--json]

Imports legacy .agents/ directory (specs, memory, plans) from product repository into external vault.`);
    return;
  }

  const tool = TOOL_DEFINITIONS[cmd as ToolName];
  if (tool) {
    console.log(`Usage: memo ${cmd} [options]

${tool.description}

Properties:
${Object.entries(tool.inputSchema.properties)
  .map(([prop, val]) => `  --${prop.padEnd(14)} ${(val as { description?: string }).description || ''}`)
  .join('\n')}

Options:
  --json         Output result as JSON
  -h, --help     Show this help message
`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printGeneralHelp();
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (!parsed.command || (parsed.options.help && !parsed.command)) {
    printGeneralHelp();
    return 0;
  }

  if (parsed.subcommandHelp) {
    printCommandHelp(parsed.command);
    return 0;
  }

  if (parsed.command === 'serve') {
    await startMcpServer();
    return 0;
  }

  if (parsed.command === 'doctor' || parsed.command === 'import') {
    const response = {
      isError: true,
      error: `Command '${parsed.command}' is not yet implemented in Slice 1`,
      code: 'NOT_IMPLEMENTED',
      details: { command: parsed.command }
    };
    if (parsed.isJson) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.error(`Error [${response.code}]: ${response.error}`);
    }
    return 1;
  }

  if (TOOL_NAMES.includes(parsed.command as ToolName)) {
    const payload = { ...parsed.options };
    delete payload.help;
    delete payload.json;

    const response = await executeTool(parsed.command, payload);

    if (parsed.isJson) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      if (response.isError) {
        console.error(`Error [${response.code}]: ${response.error}`);
      } else {
        console.log(JSON.stringify(response.data, null, 2));
      }
    }

    return response.isError ? 1 : 0;
  }

  console.error(`Unknown command: ${parsed.command}`);
  printGeneralHelp();
  return 1;
}

if (process.argv[1] && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'))) {
  runCli().then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  });
}
