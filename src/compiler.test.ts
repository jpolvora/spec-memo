import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { upsertRecord } from './store.js';
import { rebuildCompiledViews, writeFileAtomicSync } from './compiler.js';
import { resolveProjectIdentity } from './identity.js';
import { closeIndex } from './indexer.js';

describe('Compiled Views (TRAPS.md, DECISIONS.md, INDEX.md)', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-comp-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-comp-proj-'));
  });

  afterEach(() => {
    closeIndex();
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('should restore deleted compiled views when rebuildCompiledViews is executed', async () => {
    // 1. Add some records
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-low',
      frontmatter: { id: 'trap-low', title: 'Low priority trap', severity: 'low' },
      body: 'Low priority body'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'trap-crit',
      frontmatter: { id: 'trap-crit', title: 'Critical trap', severity: 'critical' },
      body: 'Critical body'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'decision-1',
      frontmatter: { id: 'decision-1', title: 'Adopt TypeScript' },
      body: 'Decision details'
    });

    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const projectDir = identity.vaultProjectPath;

    const trapsPath = path.join(projectDir, 'TRAPS.md');
    const decisionsPath = path.join(projectDir, 'DECISIONS.md');
    const indexPath = path.join(projectDir, 'INDEX.md');

    assert.ok(fs.existsSync(trapsPath));
    assert.ok(fs.existsSync(decisionsPath));
    assert.ok(fs.existsSync(indexPath));

    // Delete the compiled files
    fs.unlinkSync(trapsPath);
    fs.unlinkSync(decisionsPath);
    fs.unlinkSync(indexPath);

    assert.equal(fs.existsSync(trapsPath), false);
    assert.equal(fs.existsSync(decisionsPath), false);
    assert.equal(fs.existsSync(indexPath), false);

    // Rebuild from sources
    const result = rebuildCompiledViews(identity.projectId, tempVault);
    assert.equal(result.trapsCount, 2);
    assert.equal(result.decisionsCount, 1);
    assert.equal(result.totalRecords, 3);

    // Verify restored files
    assert.ok(fs.existsSync(trapsPath));
    assert.ok(fs.existsSync(decisionsPath));
    assert.ok(fs.existsSync(indexPath));

    const trapsContent = fs.readFileSync(trapsPath, 'utf8');
    // Ensure critical trap comes before low trap
    const critIndex = trapsContent.indexOf('[CRITICAL] Critical trap');
    const lowIndex = trapsContent.indexOf('[LOW] Low priority trap');
    assert.ok(critIndex !== -1 && lowIndex !== -1);
    assert.ok(critIndex < lowIndex, 'Critical trap should appear before low trap in TRAPS.md');
  });

  it('should generate standard relative markdown links and wikilinks for Obsidian compatibility', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'obsidian-trap',
      frontmatter: { id: 'trap-obsidian', title: 'Obsidian Compatible Trap' },
      body: 'Body content'
    });

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'obsidian-adr',
      frontmatter: { id: 'adr-obsidian', title: 'Obsidian ADR' },
      body: 'ADR details'
    });

    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const projectDir = identity.vaultProjectPath;

    const trapsContent = fs.readFileSync(path.join(projectDir, 'TRAPS.md'), 'utf8');
    const decisionsContent = fs.readFileSync(path.join(projectDir, 'DECISIONS.md'), 'utf8');
    const indexContent = fs.readFileSync(path.join(projectDir, 'INDEX.md'), 'utf8');

    assert.ok(trapsContent.includes('[[trap-obsidian]]'));
    assert.ok(trapsContent.includes('./traps/trap-obsidian.md'));

    assert.ok(decisionsContent.includes('[[adr-obsidian]]'));
    assert.ok(decisionsContent.includes('./decisions/adr-obsidian.md'));

    assert.ok(indexContent.includes('./traps/trap-obsidian.md'));
    assert.ok(indexContent.includes('./decisions/adr-obsidian.md'));
  });

  it('should include full datetime timestamps in DECISIONS.md and INDEX.md views', async () => {
    const fixedIso = '2026-08-28T14:30:45.123Z';
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'decision',
      slug: 'datetime-adr',
      frontmatter: {
        id: 'adr-datetime',
        title: 'Datetime Precision ADR',
        updated: fixedIso,
        created: fixedIso
      },
      body: 'Full datetime body'
    });

    const identity = resolveProjectIdentity(tempProject, { vaultRoot: tempVault });
    const projectDir = identity.vaultProjectPath;

    const decisionsContent = fs.readFileSync(path.join(projectDir, 'DECISIONS.md'), 'utf8');
    const indexContent = fs.readFileSync(path.join(projectDir, 'INDEX.md'), 'utf8');

    assert.ok(decisionsContent.includes(fixedIso), 'DECISIONS.md summary table should contain full datetime');
    assert.ok(indexContent.includes(fixedIso), 'INDEX.md table should contain full datetime');
  });
});

describe('Atomic compiled-view writes (vault-log-sweep-bugfix AC1-AC3)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes full content atomically with no temp litter', () => {
    const target = path.join(tempDir, 'TRAPS.md');
    writeFileAtomicSync(target, '# traps\nbody');
    assert.equal(fs.readFileSync(target, 'utf8'), '# traps\nbody');
    const leftovers = fs.readdirSync(tempDir).filter((f) => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0);
  });

  it('retries transient EBUSY then succeeds without caller-visible error', () => {
    const target = path.join(tempDir, 'TRAPS.md');
    let calls = 0;
    writeFileAtomicSync(target, 'recovered', {
      writeFileSync: (p, c, enc) => {
        calls++;
        if (calls < 3) {
          const err = new Error(`EBUSY: resource busy, open '${target}'`) as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        fs.writeFileSync(p, c, enc);
      },
      renameSync: (src, dst) => fs.renameSync(src, dst)
    });
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(target, 'utf8'), 'recovered');
  });

  it('persistent transient failure throws with the view path in scope and no tmp litter', () => {
    const target = path.join(tempDir, 'TRAPS.md');
    let calls = 0;
    assert.throws(
      () =>
        writeFileAtomicSync(target, 'doomed', {
          writeFileSync: () => {
            calls++;
            const err = new Error(`UNKNOWN: unknown error, open '${target}'`) as NodeJS.ErrnoException;
            err.code = 'UNKNOWN';
            throw err;
          }
        }),
      /TRAPS\.md/
    );
    assert.equal(calls, 3);
    assert.equal(fs.existsSync(target), false);
    const leftovers = fs.readdirSync(tempDir).filter((f) => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0);
  });

  it('non-transient failure throws immediately without retry', () => {
    const target = path.join(tempDir, 'TRAPS.md');
    let calls = 0;
    assert.throws(
      () =>
        writeFileAtomicSync(target, 'doomed', {
          writeFileSync: () => {
            calls++;
            const err = new Error(`ENOSPC: no space left on device, write`) as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            throw err;
          }
        }),
      /ENOSPC/
    );
    assert.equal(calls, 1);
  });
});

