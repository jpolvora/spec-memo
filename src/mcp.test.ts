import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import { TOOL_NAMES } from './types.js';

describe('MCP Server Integration', () => {
  it('should list all 8 tools via MCP handshake', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    assert.ok(toolsResult.tools);
    assert.equal(toolsResult.tools.length, 8);

    const toolNames = toolsResult.tools.map((t) => t.name);
    for (const name of TOOL_NAMES) {
      assert.ok(toolNames.includes(name), `Expected MCP server to expose tool: ${name}`);
    }

    await client.close();
    await server.close();
  });

  it('should handle tool call and return NOT_IMPLEMENTED error shape', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'bootstrap',
      arguments: { cwd: '.' }
    });

    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.ok(content && content.length > 0);
    assert.equal(content[0].type, 'text');

    const parsed = JSON.parse(content[0].text as string);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.code, 'NOT_IMPLEMENTED');

    await client.close();
    await server.close();
  });
});
