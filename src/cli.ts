#!/usr/bin/env node

import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { TOOL_NAMES, ToolName, MemoRecord } from './types.js';
import { startMcpServer } from './mcp.js';
import { runDoctor } from './doctor.js';
import { importWorkflowTree } from './importer.js';
import { installPreCommitHook } from './hook.js';
import { syncVault, ensureVaultStructure, getVaultRoot } from './vault.js';
import { exportVault, importVault, resetVault, restoreVault, listBackups } from './backup.js';
import { serializeRecord } from './schema.js';
import { sanitizeToolOutput } from './safety.js';
import { startCanvasServer } from './canvas.js';
import { syncVaults } from './sync.js';
import { startSseServer } from './server.js';
import { backfillTrapRecurrence, listProjectRecords } from './store.js';
import { aliasLayer, rankActiveTraps, occurrenceOf, lastSeenOf, applyTrapClassification } from './recurrence.js';
import { resolveProjectIdentity } from './identity.js';
import { runSetup } from './setup.js';
import { syncHybrid } from './hybrid-sync.js';
import { callRemoteTool } from './mcp-proxy.js';
import { recordTelemetry, flushTelemetrySync } from './telemetry.js';
import { runStatusCheck, formatStatusDashboard } from './status-cmd.js';
import { getPackageVersion } from './version.js';
import { assertSupportedNodeRuntime } from './sqlite.js';
import * as path from 'node:path';
import * as readline from 'node:readline';

async function confirmPrompt(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/** True when this process is a CLI invocation (dist/cli.js, src/cli.ts, or npm bin shim named memo). */
export function isCliMainEntry(argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  const base = path.posix.basename(argv1.replace(/\\/g, '/')).toLowerCase();
  return base === 'cli.js' || base === 'cli.ts' || base === 'memo' || base === 'memo.cmd' || base === 'memo.ps1';
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(sanitizeToolOutput(payload), null, 2));
}

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
    } else if (arg === '--version' || arg === '-v') {
      result.options.version = true;
    } else if (arg === '--help' || arg === '-h') {
      if (result.command) {
        result.subcommandHelp = true;
      } else {
        result.options.help = true;
      }
    } else if (arg === '-o') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        result.options.output = next;
        i++;
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
  bootstrap       Bind cwd's git remote; compile a session brief
  search          Filtered retrieval across memory records
  get             Read one record by id or kind+slug
  upsert          Write or update a memory record (trap, decision, spec, etc.)
  append          Append a changelog or audit run event
  forget          Supersede or archive a memory record
  gc              Apply TTL, compact shipped plans, compact logs, rebuild FTS
  promote         Copy one record into the product repository
  check_version   Compare running version to npm latest (alias: check-version)
  install_skills  Install ws-memo / ws-session-tracking into a consumer repo or --global (alias: install-skills)
  prompt          Ingest, query, export prompt turns, stories, and derive rules
  session         Start, complete, export, or inspect session lifecycles
  activity        Generate timesheet activity and invoicing report

Utility Commands:
  status        Display read-only operational status, daemon probes, and configuration (aliases: info, state)
  setup         Configure deployment mode (local, hybrid, remote) and host MCP wiring
  doctor        Diagnose vault integrity and check product tree pollution
  sync          Synchronize vault records (hybrid mode or vault-git)
  rank          List traps by recurrence (occurrences)
  import        Import legacy .agents tree into external vault
  export-vault  Export vault records into portable archive (optional AES-256-GCM)
  import-vault  Import vault archive into local vault
  restore       Restore a vault backup archive (aliases: restore-vault, import-vault)
  backups       List available timestamped backups in $SPEC_MEMO_ROOT/backups/
  reset         Reset vault database and clear records with mandatory pre-wipe backup
  canvas        Start interactive Canvas visualizer and graph UI server
  sync-vault    Synchronize delta changesets directly between vault instances
  serve         Run the stdio or SSE MCP server for agent integration

Global Options:
  --json        Output machine-readable JSON to stdout
  -h, --help    Show help for memo or a specific command
`);
}

function printCommandHelp(cmd: string): void {
  if (cmd === 'status' || cmd === 'info' || cmd === 'state') {
    console.log(`Usage: memo status [options]

Display comprehensive read-only operational status, running daemon probes, configuration, and storage statistics.

Options:
  --check         Validate health and exit with non-zero code if issues exist
  --cwd           Target working directory (default: current directory)
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'setup' || cmd === 'config') {
    console.log(`Usage: memo setup [options]

Configure spec-memo deployment mode (local, hybrid, remote) and agent host MCP wiring.

Options:
  --mode          Deployment mode: local (default), hybrid, or remote
  --url           Remote daemon origin URL (required for hybrid and remote modes)
  --host          Target agent host (cursor, vscode, opencode, antigravity, claude, generic)
  --print-mcp     Print host MCP configuration snippet to stdout
  --write-mcp     Write/merge host MCP configuration to host config file
  --auth-token    Bearer authentication token override
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'sync') {
    console.log(`Usage: memo sync [options]

Synchronize vault records against remote daemon (hybrid mode) or git remote (vaultGit).

Options:
  --all           Synchronize all projects in vault (default: current project)
  --dry-run       Preview changes without modifying local records
  --vaultRoot     Override vault root directory
  --json          Output report as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'serve') {
    console.log(`Usage: memo serve [options]

Starts the spec-memo MCP server for AI agent host integration.

Options:
  --sse           Run as HTTP / Server-Sent Events (SSE) server
  --port          Port to listen on (default 3123 for SSE, configurable via config.json)
  --host          Host address to bind (default 127.0.0.1)
  --status-port   Status monitor companion port (default 3124, configurable via config.json)
  --no-status     Do not start the status monitor companion
  --auth-token    Bearer token for SSE/status when binding beyond loopback
  --vaultRoot     Override vault root directory
  --json          Output server URL metadata as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'canvas' || cmd === 'serve-canvas') {
    console.log(`Usage: memo canvas [options]

Starts the embedded interactive Canvas visualizer and graph web application.

Options:
  --port          Port to listen on (default 3125, configurable via config.json)
  --host          Host address to bind (default 127.0.0.1)
  --project       Pre-select a specific project ID
  --vaultRoot     Override vault root directory
  --json          Output server URL metadata as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'sync-vault') {
    console.log(`Usage: memo sync-vault <targetVaultPath> [options]

Synchronizes delta changesets bidirectionally between vault instances.

Options:
  --two-way       Perform bidirectional two-way synchronization
  --dry-run       Preview changes without writing to disk
  --vaultRoot     Override source vault root directory
  --json          Output synchronization report as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'export-vault') {
    console.log(`Usage: memo export-vault [options]

Exports project vault records into a portable JSON archive with optional AES-256-GCM encryption.

Options:
  --password      Encryption password (uses AES-256-GCM + PBKDF2)
  --output, -o    Output archive file path
  --project       Specific project ID to export
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'import-vault' || cmd === 'restore' || cmd === 'restore-vault') {
    console.log(`Usage: memo restore [archiveFile] [options]

Restores a vault archive into the local vault with automatic index rebuilding.

Options:
  --backup        Path or filename of backup archive to restore
  --latest        Restore the most recent backup from $SPEC_MEMO_ROOT/backups/
  --password      Decryption password (required if archive is encrypted)
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'backups') {
    console.log(`Usage: memo backups [options]

Lists all saved backup archives stored in $SPEC_MEMO_ROOT/backups/.

Options:
  --vaultRoot     Override vault root directory
  --json          Output list as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'reset' || cmd === 'reset-vault') {
    console.log(`Usage: memo reset [options]

Completely wipes vault records and SQLite databases after generating a mandatory pre-wipe backup snapshot.

Options:
  --all           Wipe all projects in the vault (default when no project is specified)
  --project       Specific project ID to wipe
  --force         Bypass interactive confirmation prompt
  --password      Optional encryption password for pre-wipe backup
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'rank') {
    console.log(`Usage: memo rank [options]

List active traps ordered by occurrences, then lastSeen, then severity.

Options:
  --layer         Filter by closed layer enum
  --limit         Maximum traps to list (default 10)
  --backfill      Write layer, module, occurrences, lastSeen onto existing traps
  --cwd           Product repository working directory
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'doctor') {
    console.log(`Usage: memo doctor [productRoot] [options]

Inspects local vault status, SQLite FTS index integrity, and detects workflow pollution in the product repository.

Options:
  --cwd           Product repository working directory
  --vaultRoot     Override vault root directory
  --productRoot   Path to product repository root
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'import') {
    console.log(`Usage: memo import [productRoot] [options]

Imports legacy .agents/ directory (specs, memory, plans) from product repository into external vault.

Options:
  --from          Source repository or .agents directory path
  --cwd           Product repository working directory
  --vaultRoot     Override vault root directory
  --json          Output result as JSON
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'prompt' || cmd === 'prompts' || cmd === 'session' || cmd === 'activity') {
    console.log(`Usage:
  memo prompt <action> [options]
  memo prompts <action> [options]     (alias)
  memo session start|end|show|export [sessionId] [options]
  memo activity [options]

Actions (prompt):
  record              Ingest a prompt turn (--body required)
  list                List prompts (metadata filters; no FTS)
  search <query>      FTS5 search over prompt body/title/tags
  show|get <id>       Fetch one prompt or session by id
  session <id>        List chronological turns for a session
  session-start|start Start a work session
  session-end|end     Complete a session (--summary, --pr, --deliverables)
  export|export-story Export session intent story (--output path outside product tree)
  derive-rules        Scan prompts for AI rule candidates (--save-traps, --promote)
  activity|activity-report  Timesheet / invoicing report

Preferred IDE vocabulary (free string): cursor, vscode, claude, gemini, antigravity, opencode, codex, pi, terminal, generic

Key options:
  --body, --session-id, --turn, --task-slug|--slug, --client, --billable
  --ide, --model, --agent, --branch, --git-sha, --tags, --since, --until
  --query, --limit, --offset, --cross-project|--all
  --output|-o         Export story path (refused inside product tree)
  --summary           Session-end summary body
  --pr <url>          Append a PR deliverable on session-end
  --promote <path>    Allowlisted IDE rule dest (.cursor/rules/*, CLAUDE.md, GEMINI.md, .github/copilot-instructions.md)
  --save-traps        Persist high-confidence derived rules as vault traps
  --format            cursor|copilot|claude|gemini|markdown
  --json              Machine-readable output
  -h, --help          Show this help
`);
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

/** Map CLI kebab aliases to MCP tool names. */
const CLI_TOOL_ALIASES: Record<string, ToolName> = {
  'check-version': 'check_version',
  'install-skills': 'install_skills',
  prompts: 'prompt',
  session: 'prompt',
  activity: 'prompt'
};

function resolveCliCommand(command: string | undefined): string | undefined {
  if (!command) return command;
  return CLI_TOOL_ALIASES[command] || command;
}

function isReadOnlyStatusCommand(parsed: ParsedCliArgs): boolean {
  return (
    parsed.command === 'status' ||
    parsed.command === 'info' ||
    parsed.command === 'state' ||
    ((parsed.command === 'setup' || parsed.command === 'config') &&
      (parsed.options.check === true ||
        parsed.options.check === 'true' ||
        parsed.options.status === true ||
        parsed.options.status === 'true' ||
        parsed.options.info === true ||
        parsed.options.info === 'true'))
  );
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const started = performance.now();
  const parsed = parseCliArgs(argv);
  const command = resolveCliCommand(parsed.command);
  const vaultRootArg = (parsed.options.vaultRoot as string) || undefined;
  let exitCode = 1;

  try {
    exitCode = await runCliInner(argv, parsed, command, vaultRootArg);
    return exitCode;
  } finally {
    if (!isReadOnlyStatusCommand({ ...parsed, command })) {
      const durationMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
      recordTelemetry({
        category: 'cli_command',
        operation: command || (parsed.options.help ? 'help' : 'unknown'),
        durationMs,
        success: exitCode === 0,
        errorCode: exitCode !== 0 ? `EXIT_${exitCode}` : undefined,
        vaultRoot: vaultRootArg,
        metadata: {
          isJson: parsed.isJson,
          subcommandHelp: parsed.subcommandHelp
        }
      });
      flushTelemetrySync(vaultRootArg);
    }
  }
}

async function runCliInner(
  argv: string[],
  parsed: ParsedCliArgs,
  command: string | undefined,
  vaultRootArg: string | undefined
): Promise<number> {
  parsed.command = command;

  if (parsed.options.version && !parsed.command) {
    if (parsed.isJson) {
      printJson({ version: getPackageVersion() });
    } else {
      console.log(getPackageVersion());
    }
    return 0;
  }

  if (!parsed.command || (parsed.options.help && !parsed.command)) {
    printGeneralHelp();
    return 0;
  }

  if (parsed.subcommandHelp) {
    printCommandHelp(parsed.command);
    return 0;
  }

  try {
    assertSupportedNodeRuntime();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.isJson) {
      printJson({ isError: true, error: message, code: 'UNSUPPORTED_NODE' });
    } else {
      console.error(message);
    }
    return 1;
  }

  vaultRootArg = (parsed.options.vaultRoot as string) || vaultRootArg;

  // Read-only status must run before ensureVaultStructure (AC10).
  if (isReadOnlyStatusCommand(parsed)) {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const cwd = (parsed.options.cwd as string) || process.cwd();
      const check = parsed.options.check === true || parsed.options.check === 'true';
      const verbose =
        parsed.options.verbose === true ||
        parsed.options.verbose === 'true' ||
        parsed.options.v === true;

      const result = await runStatusCheck({
        vaultRoot,
        cwd,
        check,
        verbose
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(formatStatusDashboard(result, { verbose }));
      }

      return check ? (result.ok ? 0 : 1) : 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'STATUS_ERROR' });
      } else {
        console.error(`Status check failed: ${msg}`);
      }
      return 1;
    }
  }

  const activeVaultConfig = ensureVaultStructure(getVaultRoot(vaultRootArg));
  const isRemoteMode = activeVaultConfig.mode === 'remote';

  // Remote mode command restrictions (AC29)
  if (
    isRemoteMode &&
    ['canvas', 'serve-canvas', 'sync-vault', 'export-vault', 'import-vault', 'hook'].includes(parsed.command || '')
  ) {
    const msg = `Command '${parsed.command}' is not available in remote mode (data resides on remote daemon).`;
    if (parsed.isJson) {
      printJson({ isError: true, error: msg, code: 'REMOTE_MODE_RESTRICTION' });
    } else {
      console.error(msg);
    }
    return 1;
  }

  // Handle memo setup / memo config command
  if (parsed.command === 'setup' || parsed.command === 'config') {
    try {
      const mode = (parsed.options.mode as import('./types.js').DeploymentMode) || undefined;
      const url = (parsed.options.url as string) || undefined;
      const host = (parsed.options.host as string) || undefined;
      const printMcp =
        parsed.options['print-mcp'] === true ||
        parsed.options['print-mcp'] === 'true' ||
        parsed.options.printMcp === true;
      const writeMcp =
        parsed.options['write-mcp'] === true ||
        parsed.options['write-mcp'] === 'true' ||
        parsed.options.writeMcp === true;
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const authToken =
        (parsed.options['auth-token'] as string) ||
        (parsed.options.authToken as string) ||
        undefined;

      const result = runSetup({
        mode,
        url,
        host,
        printMcp,
        writeMcp,
        vaultRoot,
        authToken,
        interactive: process.stdin.isTTY && process.stdout.isTTY
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Setup Complete\n`);
        console.log(`  Mode:             ${result.mode}`);
        if (result.remoteUrl) {
          console.log(`  Remote URL:       ${result.remoteUrl}`);
        }
        console.log(`  Token Configured: ${result.tokenConfigured ? 'Yes' : 'No (set SPEC_MEMO_AUTH_TOKEN)'}`);
        console.log(`  Vault Config:     ${result.configPath}`);
        if (result.hostSnippet) {
          console.log(`\nHost MCP Configuration (${parsed.options.host}):`);
          if (result.writtenMcp && result.hostConfigPath) {
            console.log(`  Written to:       ${result.hostConfigPath}`);
          } else {
            console.log(JSON.stringify(result.hostSnippet, null, 2));
          }
        }
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const partial = (err as Error & { partialResult?: import('./types.js').SetupResult }).partialResult;
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'SETUP_ERROR', ...(partial ? { data: partial } : {}) });
      } else {
        console.error(`Setup failed: ${msg}`);
        if (partial?.hostSnippet) {
          console.log(`\nHost MCP Configuration (${parsed.options.host}):`);
          console.log(JSON.stringify(partial.hostSnippet, null, 2));
        }
      }
      return 1;
    }
  }

  if (parsed.command === 'serve') {
    if (parsed.options.sse) {
      try {
      const port = parsed.options.port ? parseInt(String(parsed.options.port), 10) : undefined;
      const host = (parsed.options.host as string) || '127.0.0.1';
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const authToken =
        (parsed.options['auth-token'] as string | undefined) ||
        (parsed.options.authToken as string | undefined);
      const noStatus =
        parsed.options['no-status'] === true ||
        parsed.options['no-status'] === 'true' ||
        parsed.options.noStatus === true;
      const statusPort = parsed.options['status-port']
        ? parseInt(String(parsed.options['status-port']), 10)
        : parsed.options.statusPort
          ? parseInt(String(parsed.options.statusPort), 10)
          : undefined;

      const instance = await startSseServer({
        port,
        host,
        vaultRoot,
        authToken,
        enableStatus: !noStatus,
        statusPort
      });
      if (parsed.isJson) {
        const payload: Record<string, unknown> = {
          status: 'running',
          service: 'mcp-sse',
          url: instance.url,
          port: instance.port,
          host: instance.host
        };
        if (instance.statusUrl) {
          payload.statusUrl = instance.statusUrl;
          payload.statusPort = instance.statusPort;
        }
        printJson(payload);
      } else {
        console.log(`spec-memo — MCP SSE Server running at: ${instance.url}`);
        console.log(`  SSE endpoint:     ${instance.url}/sse`);
        console.log(`  Message endpoint: ${instance.url}/message`);
        console.log(`  Health check:     ${instance.url}/health`);
        if (instance.statusUrl) {
          console.log(`  Status monitor:   ${instance.statusUrl}`);
        }
      }

      const shutdown = async (signal: NodeJS.Signals) => {
        try {
          await instance.close();
        } finally {
          flushTelemetrySync(vaultRoot);
          process.exit(signal === 'SIGTERM' ? 0 : 130);
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));

      return new Promise(() => {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (parsed.isJson) {
          printJson({ isError: true, error: msg, code: 'SSE_ERROR' });
        } else {
          console.error(`SSE server failed: ${msg}`);
        }
        return 1;
      }
    }

    const vaultRoot = parsed.options.vaultRoot as string | undefined;
    const noStatus =
      parsed.options['no-status'] === true ||
      parsed.options['no-status'] === 'true' ||
      parsed.options.noStatus === true;
    const statusPort = parsed.options['status-port']
      ? parseInt(String(parsed.options['status-port']), 10)
      : parsed.options.statusPort
        ? parseInt(String(parsed.options.statusPort), 10)
        : undefined;
    const statusHost = (parsed.options['status-host'] as string) || (parsed.options.host as string) || '127.0.0.1';
    const statusAuthToken =
      (parsed.options['auth-token'] as string | undefined) ||
      (parsed.options.authToken as string | undefined);

    await startMcpServer({
      vaultRoot,
      enableStatus: !noStatus,
      statusPort,
      statusHost,
      statusAuthToken
    });
    return 0;
  }

  // Handle memo canvas command
  if (parsed.command === 'canvas' || parsed.command === 'serve-canvas') {
    try {
      const port = parsed.options.port ? parseInt(String(parsed.options.port), 10) : undefined;
      const host = (parsed.options.host as string) || '127.0.0.1';
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const project = (parsed.options.project as string) || undefined;
      const authToken =
        (parsed.options['auth-token'] as string | undefined) ||
        (parsed.options.authToken as string | undefined);

      const instance = await startCanvasServer({ port, host, vaultRoot, project, authToken });
      if (parsed.isJson) {
        printJson({ status: 'running', url: instance.url, port: instance.port, host: instance.host });
      } else {
        console.log(`spec-memo — Visual Graph Canvas running at: ${instance.url}`);
      }

      const shutdown = async (signal: NodeJS.Signals) => {
        try {
          await instance.close();
        } finally {
          flushTelemetrySync(vaultRoot);
          process.exit(signal === 'SIGTERM' ? 0 : 130);
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));

      return new Promise(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'CANVAS_ERROR' });
      } else {
        console.error(`Canvas server failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo sync-vault command
  if (parsed.command === 'sync-vault') {
    try {
      const targetPath =
        (parsed.options.target as string) ||
        (parsed.options.to as string) ||
        parsed.positionals[0];

      if (!targetPath) {
        throw new Error('Target vault path is required for sync-vault.');
      }

      const sourceVault =
        (parsed.options.source as string) ||
        (parsed.options.from as string) ||
        (parsed.options.vaultRoot as string) ||
        undefined;
      const twoWay = parsed.options['two-way'] === true || parsed.options.twoWay === true;
      const dryRun = parsed.options['dry-run'] === true || parsed.options.dryRun === true;
      const since = (parsed.options.since as string) || undefined;

      const result = await syncVaults(sourceVault || '', targetPath, { twoWay, dryRun, since });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Vault Synchronization Complete\n`);
        console.log(`Forward Sync (Source -> Target):`);
        console.log(`  Applied:   ${result.forward.applied}`);
        console.log(`  Skipped:   ${result.forward.skipped}`);
        console.log(`  Conflicts: ${result.forward.conflicts}`);
        if (result.backward) {
          console.log(`\nBackward Sync (Target -> Source):`);
          console.log(`  Applied:   ${result.backward.applied}`);
          console.log(`  Skipped:   ${result.backward.skipped}`);
          console.log(`  Conflicts: ${result.backward.conflicts}`);
        }
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'SYNC_VAULT_ERROR' });
      } else {
        console.error(`Sync vault failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo rank command (CLI-only; not an MCP tool)
  if (parsed.command === 'rank') {
    try {
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const cwd = (parsed.options.cwd as string) || process.cwd();
      const layerRaw = parsed.options.layer ? String(parsed.options.layer) : undefined;
      const layer = layerRaw ? aliasLayer(layerRaw) ?? layerRaw : undefined;
      const limitRaw = parsed.options.limit;
      const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 10;
      const doBackfill = parsed.options.backfill === true || parsed.options.backfill === 'true';

      if (isRemoteMode) {
        if (doBackfill) {
          throw new Error(
            'memo rank --backfill is not available in remote mode (trap backfill requires local vault access).'
          );
        }

        const remoteRes = await callRemoteTool(
          'search',
          {
            query: '',
            kinds: ['trap'],
            status: 'active',
            sort: 'occurrences',
            limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
            cwd
          },
          { vaultRoot }
        );

        if (remoteRes.isError) {
          throw new Error(remoteRes.error);
        }

        const rawHits = (Array.isArray(remoteRes.data) ? remoteRes.data : []) as Array<any>;
        let hits = rawHits.map((h) => ({
          id: h.id,
          projectId: h.projectId,
          kind: h.kind,
          status: h.status,
          title: h.title,
          filepath: h.filepath || '',
          occurrences: h.occurrences || 1,
          lastSeen: h.lastSeen,
          layer: h.layer || 'other',
          severity: h.severity
        }));

        if (layer) {
          hits = hits.filter((h) => h.layer === layer);
        }

        if (parsed.isJson) {
          printJson(hits);
        } else {
          console.log(`spec-memo — Recurring traps (${hits.length})\n`);
          if (hits.length === 0) {
            console.log('No active traps.');
          } else {
            for (const hit of hits) {
              const occ = hit.occurrences || 1;
              const layerLabel = hit.layer || 'other';
              const lastSeenStr = hit.lastSeen ? ` (lastSeen: ${hit.lastSeen})` : '';
              console.log(`[${occ}x] [${layerLabel}] ${hit.title || hit.id}${lastSeenStr}`);
            }
          }
        }
        return 0;
      }

      if (doBackfill) {
        backfillTrapRecurrence({ cwd, vaultRoot });
      }

      const root = vaultRoot || getVaultRoot();
      const identity = resolveProjectIdentity(cwd, { vaultRoot: root });
      const ranked = rankActiveTraps(listProjectRecords(root, identity.projectId), {
        layer,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10
      });
      const hits = ranked.map((record) => {
        const classified = applyTrapClassification(record.frontmatter, record.body);
        return {
          id: record.frontmatter.id,
          projectId: record.frontmatter.project,
          kind: record.frontmatter.kind,
          status: record.frontmatter.status,
          title: record.frontmatter.title,
          filepath: record.path || '',
          occurrences: occurrenceOf(record.frontmatter),
          lastSeen: lastSeenOf(record.frontmatter),
          layer: record.frontmatter.layer || classified.layer,
          severity: record.frontmatter.severity
        };
      });

      if (parsed.isJson) {
        printJson(hits);
      } else {
        console.log(`spec-memo — Recurring traps (${hits.length})\n`);
        if (hits.length === 0) {
          console.log('No active traps.');
        } else {
          for (const hit of hits) {
            const occ = hit.occurrences || 1;
            const layerLabel = hit.layer || 'other';
            const lastSeenStr = hit.lastSeen ? ` (lastSeen: ${hit.lastSeen})` : '';
            console.log(`[${occ}x] [${layerLabel}] ${hit.title || hit.id}${lastSeenStr}`);
          }
        }
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'RANK_ERROR' });
      } else {
        console.error(`Rank failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo doctor command
  if (parsed.command === 'doctor') {
    try {
      const productRoot =
        (parsed.options.productRoot as string) ||
        (parsed.options.from as string) ||
        (parsed.options.cwd as string) ||
        parsed.positionals[0];
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const cwd = (parsed.options.cwd as string) || productRoot;
      const rebuild = parsed.options.rebuild === true || parsed.options.rebuild === 'true';
      const fix = parsed.options.fix === true || parsed.options.fix === 'true';

      const result = await runDoctor({
        cwd,
        productRoot,
        vaultRoot,
        rebuild,
        fix
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Doctor Diagnostic Report\n`);
        console.log(`Deployment Mode: ${result.mode || 'local'}`);
        if (result.remoteUrl) {
          console.log(`Remote Origin:   ${result.remoteUrl}`);
          console.log(`Token Present:   ${result.tokenConfigured ? 'Yes' : 'No'}`);
          if (result.remoteHealth) {
            console.log(
              `Remote Health:   ${result.remoteHealth.reachable ? 'Reachable' : `Unreachable (${result.remoteHealth.message || 'error'})`}`
            );
          }
        }
        if (result.hybridState) {
          console.log(
            `Hybrid State:    dirty=${result.hybridState.dirty}, lastSync=${result.hybridState.lastSyncAt || 'never'}${result.hybridState.lastError ? `, lastError=${result.hybridState.lastError}` : ''}`
          );
        }
        console.log(`Vault Location:  ${result.vaultRoot} (exists: ${result.vaultExists})`);
        console.log(
          `Project ID:      ${result.project.projectId} (remote: ${result.project.gitRemote || 'local-fallback'})`
        );
        console.log(`Product Root:    ${result.project.rootPath} (git: ${result.project.isGit})`);
        console.log(
          `SQLite FTS:      Indexed ${result.fts.indexedRecordsCount} records (healthy: ${result.fts.healthy})\n`
        );

        console.log(`Repository Pollution Scan:`);
        if (!result.pollution.detected) {
          console.log(`  [CLEAN] No in-repo workflow residue found.`);
        } else {
          console.log(`  [POLLUTION DETECTED] ${result.pollution.items.length} item(s) found:`);
          for (const item of result.pollution.items) {
            console.log(`    - [${item.type}] ${item.path}`);
          }
        }

        if (result.warnings.length > 0) {
          console.log(`\nWarnings:`);
          for (const w of result.warnings) {
            console.log(`  - ${w}`);
          }
        }

        console.log(`\nSummary: ${result.summary}`);
      }

      return result.healthy ? 0 : 1;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'DOCTOR_ERROR' });
      } else {
        console.error(`Doctor failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo import command
  if (parsed.command === 'import') {
    try {
      const fromPath =
        (parsed.options.from as string) ||
        (parsed.options.productRoot as string) ||
        parsed.positionals[0] ||
        (parsed.options.cwd as string) ||
        process.cwd();
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const cwd = (parsed.options.cwd as string) || fromPath;

      const result = await importWorkflowTree({
        from: fromPath,
        cwd,
        vaultRoot
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Imported Legacy Workflow Tree into Vault\n`);
        console.log(`Project ID: ${result.projectId}`);
        console.log(`Vault Root: ${result.vaultRoot}\n`);
        console.log(`Imported Records:`);
        console.log(`  Specs:     ${result.importedSpecsCount}`);
        console.log(`  Traps:     ${result.importedTrapsCount}`);
        console.log(`  Decisions: ${result.importedDecisionsCount}`);
        console.log(`  Plans:     ${result.importedPlansCount}`);
        console.log(`  State:     ${result.importedStateCount}`);
        console.log(`  Logs:      ${result.importedLogsCount}`);
        console.log(`  Total:     ${result.totalImported} (skipped files: ${result.skippedFilesCount})`);
      }

      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'IMPORT_ERROR' });
      } else {
        console.error(`Import failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo hook command
  if (parsed.command === 'hook') {
    try {
      const sub = parsed.positionals[0] || 'install';
      if (sub === 'install') {
        const targetRepo = (parsed.options.productRoot as string) || (parsed.options.cwd as string) || process.cwd();
        const res = installPreCommitHook(targetRepo);
        if (parsed.isJson) {
          printJson(res);
        } else {
          console.log(`[HOOK] Pre-commit write-block hook installed at: ${res.path}`);
        }
        return 0;
      }
      throw new Error(`Unknown hook subcommand: ${sub}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'HOOK_ERROR' });
      } else {
        console.error(`Hook installation failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo sync command (hybrid HTTP sync per AC21 or vault git remote sync per AC3)
  if (parsed.command === 'sync') {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const config = ensureVaultStructure(getVaultRoot(vaultRoot));
      const all = parsed.options.all === true || parsed.options.all === 'true';
      const dryRun =
        parsed.options['dry-run'] === true ||
        parsed.options['dry-run'] === 'true' ||
        parsed.options.dryRun === true;
      const cwd = (parsed.options.cwd as string) || process.cwd();
      const identity = resolveProjectIdentity(cwd, { vaultRoot: getVaultRoot(vaultRoot) });

      if (config.mode === 'hybrid') {
        const report = await syncHybrid({
          vaultRoot,
          projectId: identity.projectId,
          all,
          dryRun
        });
        if (parsed.isJson) {
          printJson(report);
        } else {
          console.log(`spec-memo — Hybrid Synchronization Complete\n`);
          console.log(`  Scope:    ${report.all ? 'All Projects' : `Project ${report.projectId}`}`);
          console.log(
            `  Pulled:   applied=${report.pulled.applied}, skipped=${report.pulled.skipped}, conflicts=${report.pulled.conflicts}`
          );
          console.log(
            `  Pushed:   applied=${report.pushed.applied}, skipped=${report.pushed.skipped}, conflicts=${report.pushed.conflicts}`
          );
        }
        return 0;
      }

      if (config.mode === 'remote') {
        throw new Error('memo sync is not available in remote mode (data resides on remote daemon).');
      }

      if (config.vaultGit?.enabled) {
        const res = syncVault(vaultRoot);
        if (parsed.isJson) {
          printJson(res);
        } else {
          console.log(`[SYNC] ${res.message}`);
        }
        return 0;
      }

      throw new Error(
        `memo sync requires hybrid mode or vaultGit.enabled in config.json (current mode: ${config.mode || 'local'}).`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'SYNC_ERROR' });
      } else {
        console.error(`Sync failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo export-vault command
  if (parsed.command === 'export-vault') {
    try {
      if (parsed.options.password) {
        console.error('Warning: --password is visible in process listings; prefer SPEC_MEMO_VAULT_PASSWORD or stdin.');
      }
      const password =
        process.env.SPEC_MEMO_VAULT_PASSWORD ||
        (parsed.options.password as string | undefined) ||
        undefined;
      const outputPath =
        (parsed.options.output as string) ||
        (parsed.options.o as string) ||
        parsed.positionals[0] ||
        undefined;
      const projectId = (parsed.options.project as string) || undefined;
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;

      const result = await exportVault({
        vaultRoot,
        projectId,
        outputPath,
        password
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        const encStr = result.encrypted ? ' (AES-256-GCM Encrypted)' : ' (Plaintext)';
        console.log(`spec-memo — Exported Vault Archive${encStr}\n`);
        console.log(`  Projects exported: ${result.projectsCount}`);
        console.log(`  Records exported:  ${result.recordsCount}`);
        if (result.outputPath) {
          console.log(`  Saved archive to:  ${result.outputPath}`);
        } else if (result.payload) {
          console.log(`\n${result.payload}`);
        }
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'EXPORT_VAULT_ERROR' });
      } else {
        console.error(`Export vault failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo restore / import-vault command
  if (parsed.command === 'restore' || parsed.command === 'restore-vault' || parsed.command === 'import-vault') {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const isLatest = parsed.options.latest === true || parsed.options.latest === 'true';
      let archivePath =
        (parsed.options.backup as string) ||
        (parsed.options.file as string) ||
        (parsed.options.archive as string) ||
        parsed.positionals[0];

      if (isLatest) {
        const backups = listBackups(vaultRoot);
        if (backups.length === 0) {
          throw new Error('No backup archives found in vault backups/ directory.');
        }
        archivePath = backups[0].path;
      }

      if (!archivePath) {
        throw new Error('Archive file path or --latest flag is required to restore vault.');
      }

      if (parsed.options.password) {
        console.error('Warning: --password is visible in process listings; prefer SPEC_MEMO_VAULT_PASSWORD or stdin.');
      }
      const password =
        process.env.SPEC_MEMO_VAULT_PASSWORD ||
        (parsed.options.password as string | undefined) ||
        undefined;
      const overwrite = parsed.options.overwrite !== false && parsed.options.overwrite !== 'false';

      const result = await restoreVault({
        vaultRoot,
        archivePath,
        password,
        overwrite
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Restored Vault Archive\n`);
        console.log(`  Source archive:    ${archivePath}`);
        console.log(`  Projects restored: ${result.restoredProjectsCount} (${result.restoredProjects.join(', ')})`);
        console.log(`  Records restored:  ${result.restoredRecordsCount}`);
        console.log(`  Rebuilt FTS index: ${result.rebuiltFts}`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'RESTORE_VAULT_ERROR' });
      } else {
        console.error(`Restore vault failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo backups command
  if (parsed.command === 'backups' || parsed.command === 'list-backups') {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const backups = listBackups(vaultRoot);

      if (parsed.isJson) {
        printJson({ ok: true, backups });
      } else {
        const root = vaultRoot || getVaultRoot();
        console.log(`spec-memo — Vault Backups (${path.join(root, 'backups')})\n`);
        if (backups.length === 0) {
          console.log('  (No backups found)');
        } else {
          for (const b of backups) {
            const sizeKb = Math.max(1, Math.round(b.size / 1024));
            const dateStr = b.createdAt ? b.createdAt.slice(0, 19).replace('T', ' ') : '';
            console.log(`  - ${b.filename} (${sizeKb} KB, ${dateStr})`);
          }
        }
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'BACKUPS_ERROR' });
      } else {
        console.error(`List backups failed: ${msg}`);
      }
      return 1;
    }
  }

  // Handle memo reset command
  if (parsed.command === 'reset' || parsed.command === 'reset-vault') {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const projectId = (parsed.options.project as string) || undefined;
      const all = parsed.options.all === true || parsed.options.all === 'true' || !projectId;
      const force = parsed.options.force === true || parsed.options.force === 'true' || parsed.options.y === true;
      const password =
        process.env.SPEC_MEMO_VAULT_PASSWORD ||
        (parsed.options.password as string | undefined) ||
        undefined;

      if (!force) {
        if (!process.stdin.isTTY) {
          throw new Error('Vault reset requires explicit confirmation (--force) in non-interactive environments.');
        }
        const targetDesc = projectId && !all ? `project '${projectId}'` : 'ALL projects and databases in the entire vault';
        console.log(`\n[WARNING] You are about to reset ${targetDesc}.`);
        console.log(`A mandatory timestamped pre-wipe backup snapshot will be saved in $SPEC_MEMO_ROOT/backups/ before deletion.`);
        const confirmed = await confirmPrompt('Are you sure you want to proceed? (y/N): ');
        if (!confirmed) {
          console.log('Vault reset aborted.');
          return 0;
        }
      }

      const result = await resetVault({
        vaultRoot,
        projectId,
        all,
        password
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Vault Reset Complete\n`);
        console.log(`  Pre-wipe backup:  ${result.backupPath}`);
        console.log(`  Projects wiped:   ${result.wipedProjectsCount}`);
        console.log(`  Records wiped:    ${result.wipedRecordsCount}`);
        console.log(`  Rebuilt FTS DB:   ${result.rebuiltFts}`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'RESET_VAULT_ERROR' });
      } else {
        console.error(`Vault reset failed: ${msg}`);
      }
      return 1;
    }
  }

  if (TOOL_NAMES.includes(parsed.command as ToolName)) {
    const payload: Record<string, unknown> = { ...parsed.options };
    delete payload.help;
    delete payload.json;

    // Normalization for bootstrap command
    if (parsed.command === 'bootstrap') {
      if (payload['max-bytes']) {
        payload.maxBytes = parseInt(String(payload['max-bytes']), 10);
        delete payload['max-bytes'];
      }
      if (typeof payload.maxBytes === 'string') {
        payload.maxBytes = parseInt(payload.maxBytes, 10);
      }
    }

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
      if (payload.sort) {
        payload.sort = String(payload.sort);
      }
    }

    // Normalization for get command
    if (parsed.command === 'get') {
      if (parsed.positionals.length > 0 && !payload.id && !payload.slug) {
        payload.id = parsed.positionals[0];
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

    // Normalization for gc command
    if (parsed.command === 'gc') {
      if (
        payload['dry-run'] === true ||
        payload['dry-run'] === 'true' ||
        payload.dryRun === true ||
        payload.dryRun === 'true'
      ) {
        payload.dryRun = true;
        delete payload['dry-run'];
      }
      if (payload.project) {
        payload.projectId = String(payload.project);
        delete payload.project;
      }
    }

    // Normalization for promote command
    if (parsed.command === 'promote') {
      if (parsed.positionals.length > 0 && !payload.id && !payload.slug) {
        payload.id = parsed.positionals[0];
      }
      if (parsed.positionals.length > 1 && !payload.destination && !payload.to) {
        payload.destination = parsed.positionals[1];
      }
      if (payload.to && !payload.destination) {
        payload.destination = payload.to;
        delete payload.to;
      }
      if (payload.force === true || payload.force === 'true') {
        payload.force = true;
      }
      if (payload.format) {
        payload.format = String(payload.format);
      }
      if (typeof payload.limit === 'string') {
        payload.limit = parseInt(payload.limit, 10);
      }
    }

    // Normalization for install_skills / install-skills
    if (parsed.command === 'install_skills') {
      if (payload['product-root'] && !payload.productRoot) {
        payload.productRoot = String(payload['product-root']);
        delete payload['product-root'];
      }
      if (typeof payload.productRoot !== 'string') {
        delete payload.productRoot;
      }
      if (payload['skills-root'] && !payload.skillsRoot) {
        payload.skillsRoot = String(payload['skills-root']);
        delete payload['skills-root'];
      }
      if (typeof payload.skillsRoot !== 'string') {
        delete payload.skillsRoot;
      }
      if (payload.skill && !payload.skills) {
        payload.skills = [String(payload.skill)];
        delete payload.skill;
      } else if (typeof payload.skills === 'string') {
        payload.skills = (payload.skills as string).split(',').map((s) => s.trim());
      }
      if (parsed.positionals.length > 0 && !payload.productRoot && !payload.global) {
        payload.productRoot = parsed.positionals[0];
      }
      if (payload.force === true || payload.force === 'true') {
        payload.force = true;
      }
      if (payload.global === true || payload.global === 'true') {
        payload.global = true;
      }
    }

    // Normalization for prompt / session / activity commands
    if (parsed.command === 'prompt') {
      const origCmd = argv[0];
      const pos0 = parsed.positionals[0];

      if (origCmd === 'session') {
        if (pos0 === 'start') {
          payload.action = 'session_start';
          if (parsed.positionals[1]) payload.sessionId = parsed.positionals[1];
        } else if (pos0 === 'end') {
          payload.action = 'session_end';
          if (parsed.positionals[1]) payload.sessionId = parsed.positionals[1];
        } else if (pos0 === 'export') {
          payload.action = 'export_story';
          if (parsed.positionals[1]) payload.sessionId = parsed.positionals[1];
        } else if (pos0 === 'show' || pos0 === 'get') {
          payload.action = 'session';
          if (parsed.positionals[1]) payload.sessionId = parsed.positionals[1];
        } else if (pos0 === 'list') {
          payload.action = 'list';
        } else if (pos0 && !payload.sessionId) {
          payload.action = 'session';
          payload.sessionId = pos0;
        } else if (!payload.action) {
          payload.action = 'list';
        }
      } else if (origCmd === 'activity') {
        payload.action = 'activity_report';
      } else {
        // memo prompt <action>
        const ACTION_MAP: Record<string, string> = {
          record: 'record',
          list: 'list',
          get: 'get',
          show: 'get',
          search: 'search',
          session: 'session',
          session_start: 'session_start',
          'session-start': 'session_start',
          start: 'session_start',
          session_end: 'session_end',
          'session-end': 'session_end',
          end: 'session_end',
          activity: 'activity_report',
          activity_report: 'activity_report',
          'activity-report': 'activity_report',
          derive_rules: 'derive_rules',
          'derive-rules': 'derive_rules',
          export_story: 'export_story',
          'export-story': 'export_story',
          export: 'export_story'
        };

        if (pos0 && ACTION_MAP[pos0]) {
          payload.action = ACTION_MAP[pos0];
          const rest = parsed.positionals.slice(1);
          if (rest.length > 0) {
            if (payload.action === 'get') {
              payload.id = rest[0];
            } else if (payload.action === 'search' && !payload.query) {
              payload.query = rest.join(' ');
            } else if (payload.action === 'session' || payload.action === 'export_story') {
              payload.sessionId = rest[0];
            } else if (payload.action === 'record' && !payload.body) {
              payload.body = rest.join(' ');
            }
          }
        } else if (parsed.positionals.length > 0 && !payload.body) {
          payload.body = parsed.positionals.join(' ');
          if (!payload.action) payload.action = 'record';
        }
      }

      if (!payload.action) {
        payload.action = payload.body ? 'record' : 'list';
      }

      if (payload['session-id'] && !payload.sessionId) {
        payload.sessionId = String(payload['session-id']);
        delete payload['session-id'];
      }
      if (payload['task-slug'] && !payload.taskSlug) {
        payload.taskSlug = String(payload['task-slug']);
        delete payload['task-slug'];
      }
      if (payload.slug && !payload.taskSlug) {
        payload.taskSlug = String(payload.slug);
        delete payload.slug;
      }
      if ((payload.output || payload.o) && !payload.promote) {
        payload.promote = String(payload.output || payload.o);
        delete payload.output;
        delete payload.o;
      }
      if (payload.summary && !payload.body) {
        payload.body = String(payload.summary);
        delete payload.summary;
      }
      if (payload.pr) {
        const prUrl = String(payload.pr);
        const existing = Array.isArray(payload.deliverables) ? payload.deliverables : [];
        payload.deliverables = [...existing, { type: 'pr', url: prUrl, title: prUrl }];
        delete payload.pr;
      }
      if (payload['save-traps'] === true || payload['save-traps'] === 'true' || payload.saveTraps === true || payload.saveTraps === 'true') {
        payload.saveTraps = true;
        delete payload['save-traps'];
      }
      if (payload['cross-project'] === true || payload['cross-project'] === 'true' || payload.all === true || payload.all === 'true') {
        payload.crossProject = true;
        delete payload['cross-project'];
      }
      if (payload.billable === 'false' || payload.billable === false) {
        payload.billable = false;
      } else if (payload.billable === 'true' || payload.billable === true) {
        payload.billable = true;
      }
      if (typeof payload.turn === 'string') {
        payload.turn = parseInt(payload.turn, 10);
      }
      if (typeof payload.limit === 'string') {
        payload.limit = parseInt(payload.limit, 10);
      }
      if (typeof payload.offset === 'string') {
        payload.offset = parseInt(payload.offset, 10);
      }
      if (typeof payload.deliverables === 'string') {
        try {
          payload.deliverables = JSON.parse(payload.deliverables as string);
        } catch {
          throw new Error(
            'Invalid JSON for --deliverables; expected an array of {type,url,sha,title} objects.'
          );
        }
      }
      if (payload.deliverables != null && !Array.isArray(payload.deliverables)) {
        throw new Error('--deliverables must be a JSON array.');
      }
    }

    const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
    const response = isRemoteMode
      ? await callRemoteTool(parsed.command, payload, { vaultRoot })
      : await executeTool(parsed.command, payload);

    if (parsed.isJson) {
      if (response.isError) {
        printJson(response);
      } else {
        printJson(response.data);
      }
    } else {
      if (response.isError) {
        console.error(`Error [${response.code}]: ${response.error}`);
      } else if (parsed.command === 'bootstrap' && response.data) {
        const b = response.data as import('./types.js').BootstrapBrief;
        console.log(`spec-memo — Bootstrap Context Brief (${b.byteLength} / ${b.budgetBytes} bytes)\n`);
        console.log(`Project: ${b.projectId} (remote: ${b.gitRemote || 'local-only'})`);
        if (b.activeSlice) {
          console.log(`\nActive Feature Slice: ${b.activeSlice.slug}`);
          if (b.activeSlice.spec)
            console.log(`  Spec: ${b.activeSlice.spec.frontmatter.title || b.activeSlice.spec.frontmatter.id}`);
          if (b.activeSlice.plan)
            console.log(`  Plan: ${b.activeSlice.plan.frontmatter.title || b.activeSlice.plan.frontmatter.id}`);
        }
        console.log(`\nActive Traps (${b.traps.length} of ${b.totalTrapsCount}):`);
        if (b.traps.length === 0) {
          console.log(`  (None)`);
        } else {
          for (const t of b.traps) {
            const sev = (t.frontmatter.severity || 'medium').toUpperCase();
            const timeStr = t.frontmatter.updated || t.frontmatter.created ? ` (${t.frontmatter.updated || t.frontmatter.created})` : '';
            console.log(`  - [${sev}] ${t.frontmatter.id}: ${t.frontmatter.title || ''}${timeStr}`);
          }
        }
        console.log(`\nActive Decisions (${b.decisions.length} of ${b.totalDecisionsCount}):`);
        if (b.decisions.length === 0) {
          console.log(`  (None)`);
        } else {
          for (const d of b.decisions) {
            const timeStr = d.frontmatter.updated || d.frontmatter.created ? ` (${d.frontmatter.updated || d.frontmatter.created})` : '';
            console.log(`  - ${d.frontmatter.id}: ${d.frontmatter.title || ''}${timeStr}`);
          }
        }
        if (b.truncated) {
          console.log(`\n[WARNING] Context truncated:`);
          for (const n of b.notices) {
            console.log(`  ${n}`);
          }
        }
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
            const timeStr = (hit as any).updated ? ` [${(hit as any).updated}]` : ((hit as any).lastSeen ? ` [${(hit as any).lastSeen}]` : '');
            console.log(`${kindStr} ${hit.id}${titleStr}${patternsStr}${timeStr}`);
            if (hit.snippet) {
              console.log(`  ${hit.snippet.trim()}`);
            }
          }
        }
      } else if (parsed.command === 'get' && response.data) {
        const rec = response.data as MemoRecord;
        console.log(serializeRecord(rec));
      } else if (parsed.command === 'append' && response.data) {
        const res = response.data as { id: string; path: string };
        console.log(`[APPEND] Recorded event ${res.id}`);
      } else if (parsed.command === 'forget' && response.data) {
        const res = response.data as { id: string; status: string; purged: boolean };
        console.log(`[FORGET] Record ${res.id} ${res.purged ? 'permanently purged' : 'archived'}`);
      } else if (parsed.command === 'gc' && response.data) {
        const g = response.data as import('./types.js').GcResult;
        const dryNotice = g.dryRun ? ' (Dry Run — no files modified)' : '';
        console.log(`spec-memo — Curator GC completed for project: ${g.projectId}${dryNotice}\n`);
        console.log(`  Purged expired scratch records: ${g.purgedScratchCount}`);
        console.log(`  Purged stale review records:   ${g.purgedReviewCount}`);
        console.log(`  Compacted shipped plans:       ${g.compactedPlansCount}`);
        console.log(`  Compacted historical logs:     ${g.compactedLogsCount || 0}`);
        console.log(`  Rebuilt FTS index:             ${g.rebuiltFts}`);
        console.log(`  Rebuilt compiled views:        ${g.rebuiltViews}`);
      } else if (parsed.command === 'promote' && response.data) {
        const p = response.data as import('./types.js').PromoteResult;
        const fmtStr = p.format ? ` (format: ${p.format})` : '';
        console.log(`[PROMOTE] Record ${p.id} (${p.kind})${fmtStr} exported to ${p.destination} (${p.bytesWritten} bytes)`);
      } else if (parsed.command === 'check_version' && response.data) {
        const v = response.data as import('./types.js').CheckVersionResult;
        console.log(`spec-memo — Version\n`);
        console.log(`  Current:          ${v.current}`);
        console.log(`  Latest:           ${v.latest ?? '(unavailable)'}`);
        console.log(`  Update available: ${String(v.updateAvailable)}`);
        console.log(`  Source:           ${v.source}`);
      } else if (parsed.command === 'install_skills' && response.data) {
        const i = response.data as import('./types.js').InstallSkillsResult;
        const where =
          i.mode === 'global'
            ? `global skills roots (home ${i.productRoot})`
            : i.productRoot;
        console.log(`spec-memo — Installed skills into ${where}\n`);
        for (const row of i.installed) {
          const note = row.identical ? ' (already identical)' : ` (${row.bytesWritten} bytes)`;
          const target = row.target ? ` [${row.target}]` : '';
          console.log(`  - ${row.skill} → ${row.destination}${target}${note}`);
        }
        if (i.skippedTargets?.length) {
          console.log('');
          for (const s of i.skippedTargets) {
            console.log(`  (skipped ${s.kind}: ${s.reason})`);
          }
        }
      } else if (parsed.command === 'prompt' && response.data) {
        const data = response.data as any;
        if (data.markdown) {
          console.log(data.markdown);
        } else if (data.turn != null && data.sessionId) {
          console.log(`[PROMPT] Recorded turn ${data.turn} in session ${data.sessionId} (${data.id})`);
        } else if (data.sessionId && Array.isArray(data.deliverables) && data.endTime) {
          console.log(
            `[SESSION] Completed session ${data.sessionId} (${data.durationMinutes ?? 0} min, ${data.deliverables.length} deliverables)`
          );
        } else if (data.sessionId && data.startTime && !data.turns && !data.endTime) {
          console.log(`[SESSION] Started session ${data.sessionId} (${data.id})`);
        } else if (data.turns && Array.isArray(data.turns)) {
          console.log(`spec-memo — Session ${data.sessionId} (${data.turns.length} turns)\n`);
          for (const t of data.turns) {
            console.log(`Turn ${t.frontmatter.turn} [${t.frontmatter.created}]:\n${t.body}\n`);
          }
        } else if (data.items && Array.isArray(data.items)) {
          console.log(`spec-memo — Prompt Records (${data.total} total)\n`);
          for (const p of data.items) {
            const ide = p.frontmatter.ide || 'generic';
            const sess = p.frontmatter.sessionId ? ` [${p.frontmatter.sessionId}]` : '';
            const snippet = p.body.replace(/\n+/g, ' ').slice(0, 70);
            console.log(`  - [${ide}] ${p.frontmatter.id}${sess} (turn ${p.frontmatter.turn ?? 1}): ${snippet}…`);
          }
        } else if (data.totalBillableHours != null) {
          console.log(`spec-memo — Activity & Invoicing Report\n`);
          console.log(`  Total Billable Hours:  ${data.totalBillableHours} hrs`);
          console.log(`  Total Work Sessions:   ${data.totalSessions}`);
          console.log(`  Total Ingested Prompts:${data.totalPrompts}`);
          console.log(`  Total Work Duration:   ${data.totalDurationMinutes} min\n`);
          if (data.byClient && Object.keys(data.byClient).length > 0) {
            console.log(`Breakdown by Client:`);
            for (const [cl, m] of Object.entries(data.byClient as Record<string, any>)) {
              console.log(`  - ${cl}: ${m.totalHours} hrs (${m.sessionCount} sessions)`);
            }
          }
          if (data.byProject && Object.keys(data.byProject).length > 0) {
            console.log(`Breakdown by Project:`);
            for (const [pid, m] of Object.entries(data.byProject as Record<string, any>)) {
              console.log(`  - ${pid}: ${m.totalHours} hrs (${m.sessionCount} sessions)`);
            }
          }
        } else if (data.rules && Array.isArray(data.rules)) {
          console.log(`spec-memo — Derived Rules (${data.rules.length} candidates from ${data.scannedPromptsCount} prompts)\n`);
          for (const r of data.rules) {
            console.log(`  - [${Math.round(r.confidence * 100)}%] ${r.ruleTitle} (${r.category})`);
            console.log(`    Pattern: ${r.pattern}`);
          }
          if (data.savedTraps && data.savedTraps.length > 0) {
            console.log(`\nSaved ${data.savedTraps.length} trap(s) to vault:`);
            for (const st of data.savedTraps) {
              console.log(`  - ${st.id}: ${st.title}`);
            }
          }
        } else {
          console.log(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2));
        }
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

if (isCliMainEntry()) {
  runCli()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else if (process.env.SPEC_MEMO_DEBUG === '1' && process.argv[1]) {
  console.error(`spec-memo: skipped CLI entry (argv[1]=${process.argv[1]})`);
}

