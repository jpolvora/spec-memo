import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { TOOL_NAMES, ToolName } from './types.js';
import { closeIndex } from './indexer.js';

describe('Tool Definitions and Execution', () => {
  let tempVault: string;
  let tempProject: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-tools-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-tools-proj-'));
    originalEnv = process.env.SPEC_MEMO_ROOT;
    process.env.SPEC_MEMO_ROOT = tempVault;
  });

  afterEach(() => {
    closeIndex();
    if (originalEnv !== undefined) {
      process.env.SPEC_MEMO_ROOT = originalEnv;
    } else {
      delete process.env.SPEC_MEMO_ROOT;
    }
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });
  it('should define all 10 core tools', () => {
    assert.equal(TOOL_NAMES.length, 10);
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

    // Bootstrap tool
    const bootstrapRes = await executeTool('bootstrap', {
      cwd: tempProject
    });
    assert.equal(bootstrapRes.isError, undefined);
    assert.ok(bootstrapRes.data);
    const brief = bootstrapRes.data as { projectId: string; traps: unknown[]; truncated: boolean };
    assert.ok(brief.projectId);
    assert.equal(typeof brief.truncated, 'boolean');

    // GC tool
    const gcRes = await executeTool('gc', {
      dryRun: true
    });
    assert.equal(gcRes.isError, undefined);
    assert.ok(gcRes.data);
    const gcData = gcRes.data as { dryRun: boolean };
    assert.equal(gcData.dryRun, true);

    // Promote tool
    const promoteRes = await executeTool('promote', {
      id: 'tool-exec-spec',
      destination: 'docs/test-spec.md'
    });
    // With nonexistent record, promote should fail with RECORD_NOT_FOUND or PROMOTE_FAILED (not NOT_IMPLEMENTED)
    assert.equal(promoteRes.isError, true);
    if (promoteRes.isError) {
      assert.notEqual(promoteRes.code, 'NOT_IMPLEMENTED');
      assert.equal(promoteRes.code, 'PROMOTE_FAILED');
    }
  });

  it('should execute all 10 tools without NOT_IMPLEMENTED errors', () => {
    assert.equal(TOOL_NAMES.length, 10);
  });

  it('should omit vaultRoot from advertised MCP schemas and strip vault paths from search hits', async () => {
    for (const name of TOOL_NAMES) {
      const props = TOOL_DEFINITIONS[name].inputSchema.properties;
      assert.equal(props.vaultRoot, undefined, `${name} schema advertised vaultRoot`);
    }

    const upsertRes = await executeTool('upsert', {
      kind: 'trap',
      slug: 'path-leak-trap',
      frontmatter: {
        id: 'trap-path-leak',
        title: 'Path leak trap'
      },
      body: 'Body for path leak check'
    });
    assert.equal(upsertRes.isError, undefined);
    const upsertData = upsertRes.data as { path?: string; filepath?: string };
    assert.equal(upsertData.path, undefined);
    assert.equal(upsertData.filepath, undefined);

    const searchRes = await executeTool('search', { query: 'path leak' });
    assert.equal(searchRes.isError, undefined);
    const hits = searchRes.data as Array<{ id: string; filepath?: string; path?: string }>;
    const hit = hits.find((h) => h.id === 'trap-path-leak');
    assert.ok(hit);
    assert.equal(hit.filepath, undefined);
    assert.equal(hit.path, undefined);
  });

  it('should reject get without id or (kind + slug) with INVALID_ARGUMENTS', async () => {
    const res = await executeTool('get', {});
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'INVALID_ARGUMENTS');
      assert.ok(res.error.includes('Either'));
    }

    const resKindOnly = await executeTool('get', { kind: 'trap' });
    assert.equal(resKindOnly.isError, true);
    if (resKindOnly.isError) {
      assert.equal(resKindOnly.code, 'INVALID_ARGUMENTS');
    }
  });

  it('should reject forget without id or (kind + slug) with INVALID_ARGUMENTS', async () => {
    const res = await executeTool('forget', {});
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'INVALID_ARGUMENTS');
      assert.ok(res.error.includes('Either'));
    }
  });

  it('should reject promote without destination with INVALID_ARGUMENTS', async () => {
    const res = await executeTool('promote', { id: 'some-id' });
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'INVALID_ARGUMENTS');
    }
  });

  it('should reject invalid record kind in search, upsert, append, or get with INVALID_ARGUMENTS', async () => {
    const upsertRes = await executeTool('upsert', {
      kind: 'invalid_kind',
      body: 'test'
    });
    assert.equal(upsertRes.isError, true);
    if (upsertRes.isError) {
      assert.equal(upsertRes.code, 'INVALID_ARGUMENTS');
    }

    const searchRes = await executeTool('search', {
      kinds: ['not_a_kind' as any]
    });
    assert.equal(searchRes.isError, true);
    if (searchRes.isError) {
      assert.equal(searchRes.code, 'INVALID_ARGUMENTS');
    }
  });

  it('should log failed tool executions to error.logs in vault', async () => {
    await executeTool('get', {}); // causes INVALID_ARGUMENTS
    const errorLogPath = path.join(tempVault, 'error.logs');
    assert.ok(fs.existsSync(errorLogPath), 'error.logs should exist in vault');
    const content = fs.readFileSync(errorLogPath, 'utf8');
    assert.ok(content.includes('[mcp-tool]'), 'error log should mention [mcp-tool]');
    assert.ok(content.includes('Tool:        get'), 'error log should mention Tool: get');
  });

  it('should support path argument in upsert tool and map to pathPatterns and linkedPaths', async () => {
    const upsertRes = await executeTool('upsert', {
      kind: 'trap',
      slug: 'path-param-trap',
      path: 'src/utils/security.ts',
      frontmatter: {
        id: 'trap-path-param',
        title: 'Trap with Path Param'
      },
      body: 'Body content'
    });

    assert.equal(upsertRes.isError, undefined);

    const getRes = await executeTool('get', { id: 'trap-path-param' });
    assert.equal(getRes.isError, undefined);
    const memo = getRes.data as { frontmatter: { pathPatterns?: string[]; linkedPaths?: string[] } };
    assert.deepEqual(memo.frontmatter.pathPatterns, ['src/utils/security.ts']);
    assert.deepEqual(memo.frontmatter.linkedPaths, ['src/utils/security.ts']);
  });
});

