#!/usr/bin/env node

import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { TOOL_NAMES, ToolName, MemoRecord } from './types.js';
import { startMcpServer } from './mcp.js';
import { runDoctor } from './doctor.js';
import { importWorkflowTree } from './importer.js';
import { installPreCommitHook } from './hook.js';
import { syncVault } from './vault.js';
import { exportVault, importVault } from './backup.js';
import { serializeRecord } from './schema.js';
import { sanitizeToolOutput } from './safety.js';
import { startCanvasServer } from './canvas.js';
import { syncVaults } from './sync.js';
import { startSseServer } from './server.js';
import { searchIndex } from './indexer.js';
import { backfillTrapRecurrence } from './store.js';

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
  bootstrap     Bind cwd's git remote; compile a session brief
  search        Filtered retrieval across memory records
  get           Read one record by id or kind+slug
  upsert        Write or update a memory record (trap, decision, spec, etc.)
  append        Append a changelog or audit run event
  forget        Supersede or archive a memory record
  gc            Apply TTL, compact shipped plans, compact logs, rebuild FTS
  promote       Copy one record into the product repository

Utility Commands:
  doctor        Diagnose vault integrity and check product tree pollution
  rank          List traps by recurrence (occurrences)
  import        Import legacy .agents tree into external vault
  export-vault  Export vault records into portable archive (optional AES-256-GCM)
  import-vault  Import vault archive into local vault
  canvas        Start interactive Canvas visualizer and graph UI server
  sync-vault    Synchronize delta changesets directly between vault instances
  serve         Run the stdio or SSE MCP server for agent integration

Global Options:
  --json        Output machine-readable JSON to stdout
  -h, --help    Show help for memo or a specific command
`);
}

function printCommandHelp(cmd: string): void {
  if (cmd === 'serve') {
    console.log(`Usage: memo serve [options]

Starts the spec-memo MCP server for AI agent host integration.

Options:
  --sse           Run as HTTP / Server-Sent Events (SSE) server
  --port          Port to listen on (default 3000 for SSE)
  --host          Host address to bind (default 127.0.0.1)
  --vaultRoot     Override vault root directory
  -h, --help      Show this help message`);
    return;
  }

  if (cmd === 'canvas' || cmd === 'serve-canvas') {
    console.log(`Usage: memo canvas [options]

Starts the embedded interactive Canvas visualizer and graph web application.

Options:
  --port          Port to listen on (default 4100)
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

  if (cmd === 'import-vault') {
    console.log(`Usage: memo import-vault <archiveFile> [options]

Restores a vault archive into the local vault with automatic index rebuilding.

Options:
  --password      Decryption password (required if archive is encrypted)
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
    if (parsed.options.sse) {
      const port = parsed.options.port ? parseInt(String(parsed.options.port), 10) : 3000;
      const host = (parsed.options.host as string) || '127.0.0.1';
      const vaultRoot = parsed.options.vaultRoot as string | undefined;
      const authToken =
        (parsed.options['auth-token'] as string | undefined) ||
        (parsed.options.authToken as string | undefined);

      const instance = await startSseServer({ port, host, vaultRoot, authToken });
      if (parsed.isJson) {
        printJson({ status: 'running', service: 'mcp-sse', url: instance.url, port: instance.port, host: instance.host });
      } else {
        console.log(`spec-memo — MCP SSE Server running at: ${instance.url}`);
        console.log(`  SSE endpoint:     ${instance.url}/sse`);
        console.log(`  Message endpoint: ${instance.url}/message`);
        console.log(`  Health check:     ${instance.url}/health`);
      }

      const shutdown = async (signal: NodeJS.Signals) => {
        try {
          await instance.close();
        } finally {
          process.exit(signal === 'SIGTERM' ? 0 : 130);
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));

      return new Promise(() => {});
    }

    await startMcpServer();
    return 0;
  }

  // Handle memo canvas command
  if (parsed.command === 'canvas' || parsed.command === 'serve-canvas') {
    try {
      const port = parsed.options.port ? parseInt(String(parsed.options.port), 10) : 4100;
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
      const layer = parsed.options.layer ? String(parsed.options.layer) : undefined;
      const limitRaw = parsed.options.limit;
      const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 10;
      const doBackfill = parsed.options.backfill === true || parsed.options.backfill === 'true';

      if (doBackfill) {
        backfillTrapRecurrence({ cwd, vaultRoot });
      }

      const hits = searchIndex({
        cwd,
        vaultRoot,
        kinds: ['trap'],
        status: 'active',
        sort: 'occurrences',
        limit: Number.isFinite(limit) && limit > 0 ? limit : 10
      }).filter((hit) => !layer || hit.layer === layer);

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
            console.log(`[${occ}x] [${layerLabel}] ${hit.title || hit.id}`);
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
        console.log(`Vault Location: ${result.vaultRoot} (exists: ${result.vaultExists})`);
        console.log(
          `Project ID:     ${result.project.projectId} (remote: ${result.project.gitRemote || 'local-fallback'})`
        );
        console.log(`Product Root:   ${result.project.rootPath} (git: ${result.project.isGit})`);
        console.log(
          `SQLite FTS:     Indexed ${result.fts.indexedRecordsCount} records (healthy: ${result.fts.healthy})\n`
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

  // Handle memo sync command (vault git remote sync per vault-git spec AC3)
  if (parsed.command === 'sync') {
    try {
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;
      const res = syncVault(vaultRoot);
      if (parsed.isJson) {
        printJson(res);
      } else {
        console.log(`[SYNC] ${res.message}`);
      }
      return 0;
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

  // Handle memo import-vault command
  if (parsed.command === 'import-vault') {
    try {
      const archivePath =
        (parsed.options.file as string) ||
        (parsed.options.archive as string) ||
        parsed.positionals[0];

      if (!archivePath) {
        throw new Error('Archive file path is required to import vault.');
      }

      if (parsed.options.password) {
        console.error('Warning: --password is visible in process listings; prefer SPEC_MEMO_VAULT_PASSWORD or stdin.');
      }
      const password =
        process.env.SPEC_MEMO_VAULT_PASSWORD ||
        (parsed.options.password as string | undefined) ||
        undefined;
      const vaultRoot = (parsed.options.vaultRoot as string) || undefined;

      const result = await importVault({
        vaultRoot,
        archivePath,
        password
      });

      if (parsed.isJson) {
        printJson(result);
      } else {
        console.log(`spec-memo — Restored Vault Archive\n`);
        console.log(`  Projects restored: ${result.restoredProjectsCount} (${result.restoredProjects.join(', ')})`);
        console.log(`  Records restored:  ${result.restoredRecordsCount}`);
        console.log(`  Rebuilt FTS index: ${result.rebuiltFts}`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parsed.isJson) {
        printJson({ isError: true, error: msg, code: 'IMPORT_VAULT_ERROR' });
      } else {
        console.error(`Import vault failed: ${msg}`);
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

    const response = await executeTool(parsed.command, payload);

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
            console.log(`  - [${sev}] ${t.frontmatter.id}: ${t.frontmatter.title || ''}`);
          }
        }
        console.log(`\nActive Decisions (${b.decisions.length} of ${b.totalDecisionsCount}):`);
        if (b.decisions.length === 0) {
          console.log(`  (None)`);
        } else {
          for (const d of b.decisions) {
            console.log(`  - ${d.frontmatter.id}: ${d.frontmatter.title || ''}`);
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
            console.log(`${kindStr} ${hit.id}${titleStr}${patternsStr}`);
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

