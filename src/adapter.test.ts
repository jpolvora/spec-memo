import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryAdapter } from './adapter.js';

import { closeIndex } from './indexer.js';

describe('MemoryAdapter (Phase 2 MCP Consumer Integration)', () => {
  let tempVaultRoot: string;
  let adapter: MemoryAdapter;

  beforeEach(() => {
    tempVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-adapter-test-'));
    adapter = new MemoryAdapter(tempVaultRoot);
  });

  afterEach(() => {
    closeIndex(tempVaultRoot);
    fs.rmSync(tempVaultRoot, { recursive: true, force: true });
  });

  it('should call bootstrap brief and return token-budgeted traps', async () => {
    const brief = await adapter.readMemoryBootstrap(process.cwd());
    assert.ok(brief.projectId);
    assert.equal(typeof brief.truncated, 'boolean');
    assert.ok(Array.isArray(brief.traps));
  });

  it('should record trap via updateMemoryTrap without touching product working tree', async () => {
    const res = await adapter.updateMemoryTrap(process.cwd(), {
      scenario: 'Avoid Direct DB Access',
      doNot: 'Do not connect directly to SQLite from UI',
      insteadDo: 'Use the MCP search or store interface',
      pathPatterns: ['src/ui/**/*.ts'],
      severity: 'high'
    });

    assert.ok(res.id);
    assert.equal(res.kind, 'trap');
    assert.equal((res as { path?: string }).path, undefined);
    const projectDirs = fs.readdirSync(path.join(tempVaultRoot, 'projects'));
    assert.ok(projectDirs.length > 0);
    const trapsDir = path.join(tempVaultRoot, 'projects', projectDirs[0], 'traps');
    const trapFiles = fs.readdirSync(trapsDir).filter((f) => f.endsWith('.md'));
    assert.ok(trapFiles.length >= 1);
  });

  it('should append log event via updateMemoryLog', async () => {
    const res = await adapter.updateMemoryLog(process.cwd(), 'Completed Slice 10 implementation', {
      slice: 'memory-adapter-mcp'
    });

    assert.ok(res.id);
    assert.equal(res.event, 'Completed Slice 10 implementation');
    assert.equal((res as { path?: string }).path, undefined);
  });
});
