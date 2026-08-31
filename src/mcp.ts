import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { ActivityBus, createActivityBus } from './activity.js';
import { resolveProjectIdentity } from './identity.js';
import { ensureVaultStructure, getVaultRoot, resolveConfiguredPorts } from './vault.js';
import { ToolName, ToolResponse, ClientType } from './types.js';
import { startRemoteMcpProxyServer } from './mcp-proxy.js';
import { logErrorReport } from './error-logger.js';
import { getPackageVersion } from './version.js';
import { startStatusServer, StatusServerInstance } from './status.js';

const READ_TOOLS = new Set<ToolName>(['bootstrap', 'search', 'get', 'check_version']);
const WRITE_TOOLS = new Set<ToolName>(['upsert', 'append', 'forget', 'gc', 'promote', 'install_skills', 'prompt']);

export function resolveToolProjectId(
  name: ToolName,
  args: Record<string, unknown>,
  vaultRoot?: string
): string | undefined {
  if (typeof args.projectId === 'string' && args.projectId) {
    return args.projectId;
  }
  if (name === 'search' && args.crossProject === true) {
    return undefined;
  }
  if (name === 'gc' && !args.projectId && !args.cwd) {
    return undefined;
  }
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  try {
    return resolveProjectIdentity(cwd, { vaultRoot: vaultRoot || getVaultRoot() }).projectId;
  } catch {
    return undefined;
  }
}

export function buildToolSummary(name: ToolName, args: Record<string, unknown>, response: ToolResponse): string {
  if (response.isError) {
    return `${name} failed: ${response.error || 'error'}`;
  }
  switch (name) {
    case 'search': {
      const hits = Array.isArray(response.data) ? response.data.length : 0;
      const q = args.query ? String(args.query) : '';
      const p = args.path ? ` path=${String(args.path)}` : '';
      return `search ${q}${p} (${hits} hits)`.trim();
    }
    case 'get':
      return `get ${args.id || `${args.kind || 'record'}:${args.slug || '?'}`}`;
    case 'upsert':
      return `upsert ${args.kind || 'record'}${args.slug ? ` slug=${String(args.slug)}` : ''}`;
    case 'append':
      return `append event${args.kind ? ` kind=${String(args.kind)}` : ''}`;
    case 'forget':
      return `forget ${args.id || 'record'}`;
    case 'gc':
      return `gc${args.projectId ? ` project=${String(args.projectId)}` : ''}`;
    case 'promote':
      return `promote ${args.id || 'ranked'}${args.destination ? ` to ${String(args.destination)}` : ''}`;
    case 'bootstrap':
      return `bootstrap${args.slug ? ` slug=${String(args.slug)}` : ''}${args.path ? ` path=${String(args.path)}` : ''}`;
    case 'check_version':
      return 'check_version';
    case 'install_skills':
      return `install_skills${args.global ? ' --global' : ''}${args.skills ? ` ${(args.skills as string[]).join(',')}` : ' ws-memo'}`;
    case 'prompt': {
      const action = args.action ? String(args.action) : 'record';
      const sess = args.sessionId ? ` session=${String(args.sessionId)}` : '';
      return `prompt ${action}${sess}`;
    }
    default:
      return name;
  }
}

export function createMcpServer(opts: {
  defaultVaultRoot?: string;
  activityBus?: ActivityBus;
  errorLogPath?: string;
  clientIp?: string;
  clientName?: string;
  clientType?: ClientType;
  clientId?: string;
} = {}): Server {
  const server = new Server(
    {
      name: 'spec-memo',
      version: getPackageVersion()
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Object.values(TOOL_DEFINITIONS).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolName = name as ToolName;
    const resolvedArgs = {
      ...(args ?? {}),
      vaultRoot: (args as Record<string, unknown>)?.vaultRoot ?? opts.defaultVaultRoot
    };
    const argRecord = resolvedArgs as Record<string, unknown>;
    const started = Date.now();

    try {
      const response = await executeTool(name, resolvedArgs);
      const durationMs = Date.now() - started;
      let projId: string | undefined;
      try {
        projId = resolveToolProjectId(toolName, argRecord, opts.defaultVaultRoot);
      } catch {
        // Non-blocking project identity resolution error
      }
      let summary = name;
      try {
        summary = buildToolSummary(toolName, argRecord, response);
      } catch {
        // Non-blocking summary build error
      }

      if (opts.activityBus && opts.clientId) {
        try {
          opts.activityBus.updateClientActivity(opts.clientId, {
            operation: `mcp:${toolName}`,
            projectId: projId,
            clientName: opts.clientName
          });
        } catch {
          // Non-blocking activity update error
        }
      }

      if (opts.activityBus && TOOL_DEFINITIONS[toolName]) {
        try {
          const kind = READ_TOOLS.has(toolName) ? 'read' : WRITE_TOOLS.has(toolName) ? 'write' : 'meta';
          opts.activityBus.capture({
            type: 'tool',
            kind,
            ok: !response.isError,
            durationMs,
            summary,
            tool: toolName,
            operation: `mcp:${toolName}`,
            projectId: projId,
            clientIp: opts.clientIp,
            clientName: opts.clientName,
            clientType: opts.clientType
          });
        } catch {
          // Non-blocking activity capture error
        }
      }

      if (response.isError) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response, null, 2)
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)
          }
        ]
      };
    } catch (unhandledErr: unknown) {
      const errMsg = unhandledErr instanceof Error ? unhandledErr.message : String(unhandledErr);
      logErrorReport({
        subsystem: 'mcp-server',
        tool: toolName,
        projectId: resolveToolProjectId(toolName, argRecord, opts.defaultVaultRoot),
        error: unhandledErr,
        level: 'ERROR',
        context: { args: argRecord }
      }, { vaultRoot: opts.defaultVaultRoot, logPath: opts.errorLogPath });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              isError: true,
              error: `Internal MCP tool error: ${errMsg}`,
              code: 'INTERNAL_ERROR',
              details: { tool: toolName, args: argRecord }
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

export async function startMcpServer(
  options: {
    vaultRoot?: string;
    errorLogPath?: string;
    enableStatus?: boolean;
    statusPort?: number;
    statusHost?: string;
    statusAuthToken?: string;
  } = {}
): Promise<{
  server: Server;
  statusServer?: StatusServerInstance;
  activityBus?: ActivityBus;
  close: () => Promise<void>;
}> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);

  if (config.mode === 'remote') {
    return await startRemoteMcpProxyServer(options);
  }

  const bus = createActivityBus();
  let statusServer: StatusServerInstance | undefined;

  if (options.enableStatus !== false) {
    const configuredPorts = resolveConfiguredPorts(vaultRoot, config);
    const statusPort = options.statusPort ?? configuredPorts.status;
    const statusHost = options.statusHost || '127.0.0.1';
    const authToken = options.statusAuthToken || process.env.SPEC_MEMO_AUTH_TOKEN;

    try {
      statusServer = await startStatusServer({
        port: statusPort,
        host: statusHost,
        vaultRoot,
        authToken,
        activityBus: bus,
        errorLogPath: options.errorLogPath,
        isDaemon: false
      });
    } catch (err) {
      logErrorReport({
        subsystem: 'mcp-server',
        error: `Failed to start stdio status companion on port ${statusPort}: ${err instanceof Error ? err.message : String(err)}`,
        level: 'WARN'
      }, { vaultRoot, logPath: options.errorLogPath });
    }
  }

  const server = createMcpServer({
    defaultVaultRoot: vaultRoot,
    activityBus: bus,
    errorLogPath: options.errorLogPath
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    server,
    statusServer,
    activityBus: bus,
    close: async () => {
      await server.close();
      if (statusServer) {
        await statusServer.close();
      }
      bus.close();
      process.stdin.pause();
    }
  };
}

if (process.argv[1] && (process.argv[1].endsWith('mcp.js') || process.argv[1].endsWith('mcp.ts'))) {
  startMcpServer().catch((err) => {
    console.error('Failed to start spec-memo MCP server:', err);
    process.exit(1);
  });
}
