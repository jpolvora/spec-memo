import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { ActivityBus } from './activity.js';
import { resolveProjectIdentity } from './identity.js';
import { ensureVaultStructure, getVaultRoot } from './vault.js';
import { ToolName, ToolResponse, ClientType } from './types.js';
import { startRemoteMcpProxyServer } from './mcp-proxy.js';
import { logErrorReport } from './error-logger.js';
import { getPackageVersion } from './version.js';

const READ_TOOLS = new Set<ToolName>(['bootstrap', 'search', 'get', 'check_version']);
const WRITE_TOOLS = new Set<ToolName>(['upsert', 'append', 'forget', 'gc', 'promote', 'install_skills']);

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
      return `install_skills${args.skills ? ` ${(args.skills as string[]).join(',')}` : ' ws-memo'}`;
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

export async function startMcpServer(options: { vaultRoot?: string; errorLogPath?: string } = {}): Promise<void> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);

  if (config.mode === 'remote') {
    await startRemoteMcpProxyServer(options);
    return;
  }

  const server = createMcpServer({ defaultVaultRoot: vaultRoot, errorLogPath: options.errorLogPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && (process.argv[1].endsWith('mcp.js') || process.argv[1].endsWith('mcp.ts'))) {
  startMcpServer().catch((err) => {
    console.error('Failed to start spec-memo MCP server:', err);
    process.exit(1);
  });
}
