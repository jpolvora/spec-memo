import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { ToolName, ToolResponse } from './types.js';
import { ensureVaultStructure, getVaultRoot } from './vault.js';
import { getResolvedAuthToken, normalizeRemoteUrl } from './setup.js';
import { sanitizeToolOutput } from './safety.js';
import { logErrorReport } from './error-logger.js';

export interface RemoteProxyOptions {
  vaultRoot?: string;
  remoteUrl?: string;
  authToken?: string;
  errorLogPath?: string;
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
      version: '0.4.0'
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
  let connection: { client: Client; transport: SSEClientTransport; close: () => Promise<void> } | undefined;
  try {
    connection = await createRemoteClient(options);
    const result = await connection.client.callTool({
      name,
      arguments: args
    });

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
        return errResp;
      } catch {
        logErrorReport({
          subsystem: 'remote-proxy',
          mode: 'remote',
          tool: name,
          error: errText,
          context: { tool: name, args }
        }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });
        return { isError: true, error: errText, code: 'REMOTE_TOOL_ERROR' };
      }
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
    const msg = err instanceof Error ? err.message : String(err);
    logErrorReport({
      subsystem: 'remote-proxy',
      mode: 'remote',
      tool: name,
      error: `Remote daemon communication failed: ${msg}`,
      context: { tool: name, args }
    }, { vaultRoot: options.vaultRoot, logPath: options.errorLogPath });
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
      version: '0.4.0'
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
  });

  return server;
}

export async function startRemoteMcpProxyServer(options: RemoteProxyOptions = {}): Promise<void> {
  const server = createRemoteMcpProxyServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
