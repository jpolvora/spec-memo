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
    const payload: Record<string, unknown> = { ...parsed.options };
    delete payload.help;
    delete payload.json;

    // Normalization for search command
    if (parsed.command === 'search') {
      if (parsed.positionals.length > 0 && !payload.query) {
        payload.query = parsed.positionals.join(' ');
      }
      if (payload.kind) {
        payload.kinds = [String(payload.kind)];
        delete payload.kind;
      } else if (typeof payload.kinds === 'string') {
        payload.kinds = (payload.kinds as string).split(',').map((s) => s.trim());
      }
      if (payload.tag) {
        payload.tags = [String(payload.tag)];
        delete payload.tag;
      } else if (typeof payload.tags === 'string') {
        payload.tags = (payload.tags as string).split(',').map((s) => s.trim());
      }
      if (payload.scratch === true) {
        payload.includeScratch = true;
        delete payload.scratch;
      }
      if (payload.all === true) {
        payload.crossProject = true;
        delete payload.all;
      }
      if (typeof payload.limit === 'string') {
        payload.limit = parseInt(payload.limit, 10);
      }
    }

    // Normalization for upsert command
    if (parsed.command === 'upsert') {
      const fm: Record<string, unknown> =
        typeof payload.frontmatter === 'object' && payload.frontmatter
          ? { ...(payload.frontmatter as Record<string, unknown>) }
          : {};

      if (payload.title) {
        fm.title = payload.title;
        delete payload.title;
      }
      if (payload.severity) {
        fm.severity = payload.severity;
        delete payload.severity;
      }
      if (payload['path-patterns']) {
        fm.pathPatterns = String(payload['path-patterns']).split(',').map((s) => s.trim());
        delete payload['path-patterns'];
      }
      if (payload.pathPatterns) {
        fm.pathPatterns = Array.isArray(payload.pathPatterns)
          ? payload.pathPatterns
          : String(payload.pathPatterns).split(',').map((s) => s.trim());
        delete payload.pathPatterns;
      }
      if (payload.tags) {
        fm.tags = Array.isArray(payload.tags)
          ? payload.tags
          : String(payload.tags).split(',').map((s) => s.trim());
        delete payload.tags;
      }
      if (payload.tag) {
        fm.tags = [String(payload.tag)];
        delete payload.tag;
      }
      if (payload.supersedes) {
        fm.supersedes = payload.supersedes;
        delete payload.supersedes;
      }
      if (payload.rationale) {
        fm.rationale = payload.rationale;
        delete payload.rationale;
      }
      if (Object.keys(fm).length > 0) {
        payload.frontmatter = fm;
      }
      if (parsed.positionals.length > 0 && !payload.body) {
        payload.body = parsed.positionals.join(' ');
      }
    }

    // Normalization for append command
    if (parsed.command === 'append') {
      if (parsed.positionals.length > 0 && !payload.event) {
        payload.event = parsed.positionals.join(' ');
      }
      if (typeof payload.details === 'string') {
        try {
          payload.details = JSON.parse(payload.details as string);
        } catch {
          // Keep as string or ignore
        }
      }
    }

    // Normalization for forget command
    if (parsed.command === 'forget') {
      if (parsed.positionals.length > 0 && !payload.id) {
        payload.id = parsed.positionals[0];
      }
      if (payload.purge === true || payload.purge === 'true') {
        payload.purge = true;
      }
    }

    const response = await executeTool(parsed.command, payload);

    if (parsed.isJson) {
      if (response.isError) {
        console.log(JSON.stringify(response, null, 2));
      } else {
        console.log(JSON.stringify(response.data, null, 2));
      }
    } else {
      if (response.isError) {
        console.error(`Error [${response.code}]: ${response.error}`);
      } else if (parsed.command === 'search' && Array.isArray(response.data)) {
        const hits = response.data as Array<{
          id: string;
          kind: string;
          status?: string;
          title?: string;
          pathPatterns?: string[];
          snippet?: string;
        }>;
        if (hits.length === 0) {
          console.log('No matching records found.');
        } else {
          console.log(`Found ${hits.length} record${hits.length === 1 ? '' : 's'}:\n`);
          for (const hit of hits) {
            const statusStr = hit.status ? `:${hit.status.toUpperCase()}` : '';
            const kindStr = `[${hit.kind.toUpperCase()}${statusStr}]`;
            const titleStr = hit.title ? `: ${hit.title}` : '';
            const patternsStr = hit.pathPatterns ? ` (paths: ${hit.pathPatterns.join(', ')})` : '';
            console.log(`${kindStr} ${hit.id}${titleStr}${patternsStr}`);
            if (hit.snippet) {
              console.log(`  ${hit.snippet.trim()}`);
            }
          }
        }
      } else if (parsed.command === 'append' && response.data) {
        const res = response.data as { id: string; path: string };
        console.log(`[APPEND] Recorded event ${res.id}`);
      } else if (parsed.command === 'forget' && response.data) {
        const res = response.data as { id: string; status: string; purged: boolean };
        console.log(`[FORGET] Record ${res.id} ${res.purged ? 'permanently purged' : 'archived'}`);
      } else {
        console.log(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2));
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
