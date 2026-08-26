import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import { TOOL_NAMES } from './types.js';

describe('MCP Server Integration', () => {
  it('should list all 10 tools via MCP handshake', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    assert.ok(toolsResult.tools);
    assert.equal(toolsResult.tools.length, 10);

    const toolNames = toolsResult.tools.map((t) => t.name);
    for (const name of TOOL_NAMES) {
      assert.ok(toolNames.includes(name), `Expected MCP server to expose tool: ${name}`);
    }

    await client.close();
    await server.close();
  });

  it('should handle tool call and return UNKNOWN_TOOL error for invalid tool name', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'non_existent_tool',
      arguments: {}
    });

    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.ok(content && content.length > 0);
    assert.equal(content[0].type, 'text');

    const parsed = JSON.parse(content[0].text as string);
    assert.equal(parsed.isError, true);
    assert.equal(parsed.code, 'UNKNOWN_TOOL');

    await client.close();
    await server.close();
  });

  it('should successfully execute upsert, get, search, append, forget, bootstrap, and gc over MCP', async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const upsertRes = await client.callTool({
      name: 'upsert',
      arguments: {
        kind: 'trap',
        slug: 'mcp-test-trap',
        frontmatter: { id: 'mcp-test-trap', title: 'MCP Trap' },
        body: 'MCP test body'
      }
    });

    assert.equal(upsertRes.isError, undefined);

    const getRes = await client.callTool({
      name: 'get',
      arguments: {
        id: 'mcp-test-trap'
      }
    });

    assert.equal(getRes.isError, undefined);
    const content = getRes.content as Array<{ type: string; text?: string }>;
    assert.ok(content && content.length > 0);
    const parsed = JSON.parse(content[0].text as string);
    assert.equal(parsed.frontmatter.id, 'mcp-test-trap');

    // Test search tool over MCP
    const searchRes = await client.callTool({
      name: 'search',
      arguments: {
        query: 'MCP'
      }
    });
    assert.equal(searchRes.isError, undefined);
    const searchContent = searchRes.content as Array<{ type: string; text?: string }>;
    assert.ok(searchContent && searchContent.length > 0);
    const searchHits = JSON.parse(searchContent[0].text as string) as Array<{ id: string }>;
    assert.ok(Array.isArray(searchHits));
    assert.ok(searchHits.some((h) => h.id === 'mcp-test-trap'));

    // Test bootstrap tool over MCP
    const bootRes = await client.callTool({
      name: 'bootstrap',
      arguments: {
        cwd: '.'
      }
    });
    assert.equal(bootRes.isError, undefined);
    const bootContent = bootRes.content as Array<{ type: string; text?: string }>;
    assert.ok(bootContent && bootContent.length > 0);
    const bootData = JSON.parse(bootContent[0].text as string);
    assert.ok(bootData.projectId);
    assert.equal(typeof bootData.truncated, 'boolean');

    // Test append tool over MCP
    const appendRes = await client.callTool({
      name: 'append',
      arguments: {
        event: 'MCP append event test'
      }
    });
    assert.equal(appendRes.isError, undefined);
    const appendContent = appendRes.content as Array<{ type: string; text?: string }>;
    const appendData = JSON.parse(appendContent[0].text as string);
    assert.ok(appendData.id.startsWith('log-'));

    // Test forget tool over MCP
    const forgetRes = await client.callTool({
      name: 'forget',
      arguments: {
        id: 'mcp-test-trap'
      }
    });
    assert.equal(forgetRes.isError, undefined);
    const forgetContent = forgetRes.content as Array<{ type: string; text?: string }>;
    const forgetData = JSON.parse(forgetContent[0].text as string);
    assert.equal(forgetData.status, 'archived');

    // Test gc tool over MCP
    const gcRes = await client.callTool({
      name: 'gc',
      arguments: {
        dryRun: true
      }
    });
    assert.equal(gcRes.isError, undefined);
    const gcContent = gcRes.content as Array<{ type: string; text?: string }>;
    const gcData = JSON.parse(gcContent[0].text as string);
    assert.equal(gcData.dryRun, true);

    await client.close();
    await server.close();
  });
});
