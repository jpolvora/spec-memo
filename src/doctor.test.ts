import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runDoctor, scanForRepoPollution } from './doctor.js';
import { upsertRecord } from './store.js';
import { openIndex, closeIndex } from './indexer.js';

describe('Doctor & Pollution Diagnostics (runDoctor)', () => {
  let tempDir: string;
  let tempVaultRoot: string;
  let tempProductRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-doctor-test-'));
    tempVaultRoot = path.join(tempDir, 'vault');
    tempProductRepo = path.join(tempDir, 'product-repo');

    fs.mkdirSync(tempVaultRoot, { recursive: true });
    fs.mkdirSync(path.join(tempProductRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tempProductRepo, 'README.md'), '# Clean Repo\n', 'utf8');
  });

  afterEach(() => {
    closeIndex(tempVaultRoot);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should report healthy: true on clean product repo with valid vault and FTS index', async () => {
    // Populate at least one record in vault
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'trap',
      slug: 'clean-trap',
      frontmatter: {
        id: 'clean-trap',
        title: 'Clean Trap Rule'
      },
      body: 'Body content'
    });

    const doc = await runDoctor({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot
    });

    assert.equal(doc.vaultExists, true);
    assert.equal(doc.fts.healthy, true);
    assert.ok(doc.fts.indexedRecordsCount >= 1);
    assert.equal(doc.pollution.detected, false);
    assert.equal(doc.pollution.items.length, 0);
  });

  it('should detect planted .agents/plans/foo.md as in-tree pollution', async () => {
    // Plant in-tree plan residue
    const planDir = path.join(tempProductRepo, '.agents', 'plans');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'foo.md'), '# Planted Plan Residue\n', 'utf8');

    const pollution = scanForRepoPollution(tempProductRepo);
    assert.ok(pollution.some((p) => p.type === 'plan_residue' && p.path.includes('.agents/plans/foo.md')));

    const doc = await runDoctor({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot
    });

    assert.equal(doc.pollution.detected, true);
    assert.equal(doc.healthy, false);
    assert.ok(doc.warnings.some((w) => w.includes('in-tree workflow pollution')));
  });

  it('should detect in-tree MEMORY.md and memory/*.md files as memory_residue', async () => {
    // Plant in-tree memory files
    fs.writeFileSync(path.join(tempProductRepo, 'MEMORY.md'), '# In-repo memory\n', 'utf8');
    const memDir = path.join(tempProductRepo, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'trap-01.md'), '# In-repo trap\n', 'utf8');

    // Plant nested memory file
    const nestedShared = path.join(tempProductRepo, '.agents', 'skills', 'ws-shared');
    fs.mkdirSync(nestedShared, { recursive: true });
    fs.writeFileSync(path.join(nestedShared, 'MEMORY.md'), '# Nested in-repo memory\n', 'utf8');

    const pollution = scanForRepoPollution(tempProductRepo);
    assert.ok(pollution.some((p) => p.type === 'memory_residue' && p.path === 'MEMORY.md'));
    assert.ok(pollution.some((p) => p.type === 'memory_residue' && p.path.includes('trap-01.md')));
    assert.ok(pollution.some((p) => p.type === 'memory_residue' && p.path.includes('ws-shared/MEMORY.md')));
  });

  it('should detect in-tree run.json, .state.md, and telemetry dumps as state/telemetry residue', async () => {
    fs.writeFileSync(path.join(tempProductRepo, 'run.json'), '{"step": 1}\n', 'utf8');
    fs.writeFileSync(path.join(tempProductRepo, '.state.md'), '# State\n', 'utf8');
    fs.writeFileSync(path.join(tempProductRepo, 'telemetry.jsonl'), '{"event": "start"}\n', 'utf8');

    const pollution = scanForRepoPollution(tempProductRepo);
    assert.ok(pollution.some((p) => p.type === 'state_residue' && p.path.includes('run.json')));
    assert.ok(pollution.some((p) => p.type === 'state_residue' && p.path.includes('.state.md')));
    assert.ok(pollution.some((p) => p.type === 'telemetry_residue' && p.path.includes('telemetry.jsonl')));
  });

  it('should report warnings if vault or FTS index are not yet initialized', async () => {
    const uninitVault = path.join(tempDir, 'nonexistent-vault');
    const doc = await runDoctor({
      cwd: tempProductRepo,
      vaultRoot: uninitVault
    });

    assert.equal(doc.vaultExists, false);
    assert.equal(doc.healthy, false);
    assert.ok(doc.warnings.some((w) => w.includes('Vault root directory does not exist')));
  });

  it('should support rebuilding FTS index when rebuild flag is true', async () => {
    await upsertRecord({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      kind: 'trap',
      slug: 'rebuild-trap',
      frontmatter: {
        id: 'rebuild-trap',
        title: 'Rebuild Trap'
      },
      body: 'Rebuild body'
    });

    const doc = await runDoctor({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      rebuild: true
    });

    assert.equal(doc.fts.rebuilt, true);
    assert.ok(doc.fts.indexedRecordsCount >= 1);
  });

  it('should support cleaning up in-repo pollution when fix flag is true', async () => {
    const planDir = path.join(tempProductRepo, '.agents', 'plans');
    fs.mkdirSync(planDir, { recursive: true });
    const plantedFile = path.join(planDir, 'residue.md');
    fs.writeFileSync(plantedFile, '# Planted Residue\n', 'utf8');

    assert.ok(fs.existsSync(plantedFile));

    const doc = await runDoctor({
      cwd: tempProductRepo,
      vaultRoot: tempVaultRoot,
      fix: true
    });

    assert.equal(doc.pollution.fixedCount, 1);
    assert.ok(!fs.existsSync(plantedFile));
    assert.equal(doc.pollution.detected, false);
  });
});

