import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'spec-memo',
      version: '0.1.0'
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
    const response = await executeTool(name, args);

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

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && (process.argv[1].endsWith('mcp.js') || process.argv[1].endsWith('mcp.ts'))) {
  startMcpServer().catch((err) => {
    console.error('Failed to start spec-memo MCP server:', err);
    process.exit(1);
  });
}
