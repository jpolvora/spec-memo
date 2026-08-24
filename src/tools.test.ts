import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { TOOL_NAMES, ToolName } from './types.js';

describe('Tool Definitions and Execution', () => {
  it('should define all 8 core tools', () => {
    assert.equal(TOOL_NAMES.length, 8);
    for (const name of TOOL_NAMES) {
      assert.ok(TOOL_DEFINITIONS[name], `Missing definition for ${name}`);
      assert.equal(TOOL_DEFINITIONS[name].name, name);
      assert.ok(TOOL_DEFINITIONS[name].description.length > 0);
      assert.ok(TOOL_DEFINITIONS[name].inputSchema);
    }
  });

  it('should return error for unknown tool', async () => {
    const res = await executeTool('nonexistent_tool', {});
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'UNKNOWN_TOOL');
    }
  });

  it('should validate tool arguments', async () => {
    // upsert requires kind and body
    const res = await executeTool('upsert', {});
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'INVALID_ARGUMENTS');
    }
  });

  it('should execute upsert, search, and get tools successfully', async () => {
    const upsertRes = await executeTool('upsert', {
      kind: 'trap',
      slug: 'test-exec-trap',
      frontmatter: {
        id: 'trap-test-exec',
        title: 'Execution Test Trap',
        severity: 'high',
        tags: ['security', 'tools']
      },
      body: 'Body content for security verification'
    });

    assert.equal(upsertRes.isError, undefined);
    assert.ok(upsertRes.data);

    // Search via executeTool
    const searchRes = await executeTool('search', {
      query: 'security'
    });
    assert.equal(searchRes.isError, undefined);
    assert.ok(Array.isArray(searchRes.data));
    const hits = searchRes.data as Array<{ id: string }>;
    assert.ok(hits.some((h) => h.id === 'trap-test-exec'));

    const getRes = await executeTool('get', {
      id: 'trap-test-exec'
    });

    assert.equal(getRes.isError, undefined);
    assert.ok(getRes.data);
    const memo = getRes.data as { frontmatter: { id: string } };
    assert.equal(memo.frontmatter.id, 'trap-test-exec');

    // Append tool
    const appendRes = await executeTool('append', {
      event: 'Tool execution log event',
      details: { trigger: 'test' }
    });
    assert.equal(appendRes.isError, undefined);
    assert.ok(appendRes.data);
    const appended = appendRes.data as { id: string; event: string };
    assert.equal(appended.event, 'Tool execution log event');

    // Forget tool (soft archive)
    const forgetRes = await executeTool('forget', {
      id: 'trap-test-exec'
    });
    assert.equal(forgetRes.isError, undefined);
    const forgotten = forgetRes.data as { id: string; status: string; purged: boolean };
    assert.equal(forgotten.id, 'trap-test-exec');
    assert.equal(forgotten.status, 'archived');
    assert.equal(forgotten.purged, false);

    // Forget tool (purge)
    const purgeRes = await executeTool('forget', {
      id: 'trap-test-exec',
      purge: true
    });
    assert.equal(purgeRes.isError, undefined);
    const purged = purgeRes.data as { id: string; status: string; purged: boolean };
    assert.equal(purged.id, 'trap-test-exec');
    assert.equal(purged.status, 'purged');
    assert.equal(purged.purged, true);
  });

  it('should return NOT_IMPLEMENTED for remaining unbuilt tools', async () => {
    const unbuiltTools: Array<{ name: ToolName; args: unknown }> = [
      { name: 'bootstrap', args: { cwd: '.' } },
      { name: 'gc', args: { dryRun: true } },
      { name: 'promote', args: { destination: 'docs/test.md' } }
    ];

    for (const { name, args } of unbuiltTools) {
      const res = await executeTool(name, args);
      assert.equal(res.isError, true);
      if (res.isError) {
        assert.equal(res.code, 'NOT_IMPLEMENTED');
      }
    }
  });
});
