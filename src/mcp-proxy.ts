import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { ToolName, ToolResponse } from './types.js';
import { ensureVaultStructure, getVaultRoot, resolveConfiguredPorts } from './vault.js';
import { getResolvedAuthToken, normalizeRemoteUrl } from './setup.js';
import { sanitizeToolOutput } from './safety.js';
import { logErrorReport } from './error-logger.js';
import { getPackageVersion } from './version.js';
import { ActivityBus, createActivityBus } from './activity.js';
import { startStatusServer, StatusServerInstance } from './status.js';

export interface RemoteProxyOptions {
  vaultRoot?: string;
  remoteUrl?: string;
  authToken?: string;
  errorLogPath?: string;
  enableStatus?: boolean;
  statusPort?: number;
  statusHost?: string;
  statusAuthToken?: string;
  activityBus?: ActivityBus;
}

/**
 * Creates an authenticated SSE client connected to the remote daemon.
 */
export async function createRemoteClient(options: RemoteProxyOptions = {}): Promise<{
  client: Client;
  transport: SSEClientTransport;
  close: () => Promise<void>;
}> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);
  const rawUrl = options.remoteUrl || config.remote?.url;

  if (!rawUrl) {
    const err = new Error("Remote URL is not configured. Run 'memo setup --url <origin>' to configure.");
    logErrorReport({
      subsystem: 'remote-proxy',
      mode: 'remote',
      error: err
    }, { vaultRoot, logPath: options.errorLogPath });
    throw err;
  }

  const origin = normalizeRemoteUrl(rawUrl);
  const token = getResolvedAuthToken(options.authToken);

  const sseUrl = new URL(`${origin}/sse`);
  if (token) {
    sseUrl.searchParams.set('token', token);
  }

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const transport = new SSEClientTransport(sseUrl, {
    requestInit: {
      headers
    }
  });

  const client = new Client(
    {
      name: 'spec-memo-remote-proxy',
      version: getPackageVersion()
    },
    {
      capabilities: {}
    }
  );

  try {
    await client.connect(transport);
  } catch (err) {
    logErrorReport({
      subsystem: 'remote-proxy',
      mode: 'remote',
      error: err,
      context: { remoteUrl: origin }
    }, { vaultRoot, logPath: options.errorLogPath });
    try {
      await transport.close();
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    client,
    transport,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore close error
      }
      try {
        await transport.close();
      } catch {
        // ignore close error
      }
    }
  };
}

/**
 * Direct helper to execute a tool on the remote daemon over SSE client.
 */
export async function callRemoteTool(
  name: string,
  args: Record<string, unknown>,
  options: RemoteProxyOptions = {}
): Promise<ToolResponse> {
  const startTime = Date.now();
  let connection: { client: Client; transport: SSEClientTransport; close: () => Promise<void> } | undefined;
  try {
    connection = await createRemoteClient(options);
    const result = await connection.client.callTool({
      name,
      arguments: args
    });

    const durationMs = Date.now() - startTime;

    if (result.isError) {
      let errText = 'Remote tool execution error';
      if (Array.isArray(result.content) && result.content[0] && 'text' in result.content[0]) {
        errText = result.content[0].text;
      }
      try {
        const parsed = JSON.parse(errText);
        const errResp = parsed.isError ? parsed : { isError: true, error: errText, code: 'REMOTE_TOOL_ERROR' };
        logErrorReport({
          subsystem: 'remote-proxy',
          mode: 'remote',
          tool: name,
          error: errResp.error || errText,
          context: { tool: name, args }
        }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });

        if (options.activityBus) {
          options.activityBus.capture({
            type: 'tool',
            tool: name as ToolName,
            kind: (TOOL_DEFINITIONS as any)[name]?.kind || 'read',
            ok: false,
            durationMs,
            summary: `proxied ${name} (error: ${errResp.error || errText})`,
            operation: `proxied ${name}`,
            clientName: 'spec-memo-remote-proxy',
            clientType: 'proxy'
          });
        }

        return errResp;
      } catch {
        logErrorReport({
          subsystem: 'remote-proxy',
          mode: 'remote',
          tool: name,
          error: errText,
          context: { tool: name, args }
        }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });

        if (options.activityBus) {
          options.activityBus.capture({
            type: 'tool',
            tool: name as ToolName,
            kind: (TOOL_DEFINITIONS as any)[name]?.kind || 'read',
            ok: false,
            durationMs,
            summary: `proxied ${name} (error: ${errText})`,
            operation: `proxied ${name}`,
            clientName: 'spec-memo-remote-proxy',
            clientType: 'proxy'
          });
        }

        return { isError: true, error: errText, code: 'REMOTE_TOOL_ERROR' };
      }
    }

    if (options.activityBus) {
      options.activityBus.capture({
        type: 'tool',
        tool: name as ToolName,
        kind: (TOOL_DEFINITIONS as any)[name]?.kind || 'read',
        ok: true,
        durationMs,
        summary: `proxied ${name}`,
        operation: `proxied ${name}`,
        clientName: 'spec-memo-remote-proxy',
        clientType: 'proxy'
      });
    }

    if (Array.isArray(result.content) && result.content[0] && 'text' in result.content[0]) {
      const rawText = result.content[0].text;
      try {
        const parsed = JSON.parse(rawText);
        return { isError: false, data: sanitizeToolOutput(parsed) };
      } catch {
        return { isError: false, data: sanitizeToolOutput(rawText) };
      }
    }

    return { isError: false, data: sanitizeToolOutput(result) };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    logErrorReport({
      subsystem: 'remote-proxy',
      mode: 'remote',
      tool: name,
      error: `Remote daemon communication failed: ${msg}`,
      context: { tool: name, args }
    }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });

    if (options.activityBus) {
      options.activityBus.capture({
        type: 'tool',
        tool: name as ToolName,
        kind: (TOOL_DEFINITIONS as any)[name]?.kind || 'read',
        ok: false,
        durationMs,
        summary: `proxied ${name} (remote unreachable: ${msg})`,
        operation: `proxied ${name}`,
        clientName: 'spec-memo-remote-proxy',
        clientType: 'proxy'
      });
    }

    return {
      isError: true,
      error: `Remote daemon communication failed: ${msg}`,
      code: 'REMOTE_UNREACHABLE',
      details: { tool: name, args }
    };
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}

/**
 * Creates stdio MCP Server proxying to remote daemon.
 */
export function createRemoteMcpProxyServer(options: RemoteProxyOptions = {}): Server {
  const server = new Server(
    {
      name: 'spec-memo-remote-proxy',
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
    try {
      const response = await callRemoteTool(name, (args as Record<string, unknown>) || {}, options);

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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logErrorReport({
        subsystem: 'remote-proxy',
        mode: 'remote',
        tool: name,
        error: err,
        level: 'ERROR',
        context: { args }
      }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              isError: true,
              error: `Remote proxy error: ${errMsg}`,
              code: 'PROXY_INTERNAL_ERROR',
              details: { tool: name }
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

export async function startRemoteMcpProxyServer(options: RemoteProxyOptions = {}): Promise<{
  server: Server;
  statusServer?: StatusServerInstance;
  activityBus: ActivityBus;
  close: () => Promise<void>;
}> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const bus = options.activityBus || createActivityBus();
  const mergedOptions: RemoteProxyOptions = {
    ...options,
    vaultRoot,
    activityBus: bus
  };

  let statusServer: StatusServerInstance | undefined;

  if (options.enableStatus !== false) {
    const configuredPorts = resolveConfiguredPorts(vaultRoot);
    const statusPort = options.statusPort ?? configuredPorts.status;
    const statusHost = options.statusHost || '127.0.0.1';
    const authToken = options.statusAuthToken || options.authToken || process.env.SPEC_MEMO_AUTH_TOKEN;

    try {
      statusServer = await startStatusServer({
        port: statusPort,
        host: statusHost,
        vaultRoot,
        authToken,
        activityBus: bus,
        errorLogPath: options.errorLogPath,
        isProxy: true
      });
    } catch (err) {
      logErrorReport({
        subsystem: 'remote-proxy',
        mode: 'remote',
        error: `Failed to start proxy status companion on port ${statusPort}: ${err instanceof Error ? err.message : String(err)}`,
        level: 'WARN'
      }, { vaultRoot, logPath: options.errorLogPath });
    }
  }

  const server = createRemoteMcpProxyServer(mergedOptions);
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
