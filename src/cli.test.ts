import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from './cli.js';
import { TOOL_NAMES } from './types.js';

describe('CLI Integration', () => {
  it('should print general help with 0 exit code', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const code = await runCli(['--help']);
      assert.equal(code, 0);
      assert.ok(capturedLogs.includes('spec-memo — Local working memory for coding agents'));
      for (const name of TOOL_NAMES) {
        assert.ok(capturedLogs.includes(name), `Help should include command: ${name}`);
      }
      assert.ok(capturedLogs.includes('doctor'));
      assert.ok(capturedLogs.includes('import'));
    } finally {
      console.log = origLog;
    }
  });

  it('should print subcommand help with 0 exit code', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const code = await runCli(['bootstrap', '--help']);
      assert.equal(code, 0);
      assert.ok(capturedLogs.includes('Usage: memo bootstrap'));
      assert.ok(capturedLogs.includes('--cwd'));

      capturedLogs = '';
      const docCode = await runCli(['doctor', '--help']);
      assert.equal(docCode, 0);
      assert.ok(capturedLogs.includes('Usage: memo doctor'));

      capturedLogs = '';
      const impCode = await runCli(['import', '--help']);
      assert.equal(impCode, 0);
      assert.ok(capturedLogs.includes('Usage: memo import'));
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo gc with text and json outputs', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      // JSON mode
      const codeJson = await runCli(['gc', '--dry-run', '--json']);
      assert.equal(codeJson, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.ok(parsed.projectId);
      assert.equal(parsed.dryRun, true);

      // Text mode
      capturedLogs = '';
      const codeText = await runCli(['gc', '--dry-run']);
      assert.equal(codeText, 0);
      assert.ok(capturedLogs.includes('Curator GC completed'));
      assert.ok(capturedLogs.includes('Purged expired scratch records'));
      assert.ok(capturedLogs.includes('Compacted shipped plans'));
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo bootstrap with text and json outputs', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      // JSON mode
      const codeJson = await runCli(['bootstrap', '--cwd', '.', '--json']);
      assert.equal(codeJson, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.ok(parsed.projectId);
      assert.equal(typeof parsed.truncated, 'boolean');

      // Text mode
      capturedLogs = '';
      const codeText = await runCli(['bootstrap', '--cwd', '.']);
      assert.equal(codeText, 0);
      assert.ok(capturedLogs.includes('Bootstrap Context Brief'));
      assert.ok(capturedLogs.includes('Active Traps'));
      assert.ok(capturedLogs.includes('Active Decisions'));
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo doctor command with text and json outputs', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      // JSON mode
      const codeJson = await runCli(['doctor', '--json']);
      // Returns 0 or 1 depending on whether in-repo pollution is present
      assert.ok(codeJson === 0 || codeJson === 1);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.equal(parsed.vaultRoot, undefined);
      assert.equal(parsed.fts?.dbPath, undefined);
      assert.ok(parsed.project);
      assert.ok(parsed.fts);
      if (Array.isArray(parsed.pollution?.items)) {
        for (const item of parsed.pollution.items) {
          assert.equal(item.absolutePath, undefined);
        }
      }

      // Text mode
      capturedLogs = '';
      const codeText = await runCli(['doctor']);
      assert.ok(codeText === 0 || codeText === 1);
      assert.ok(capturedLogs.includes('spec-memo — Doctor Diagnostic Report'));
      assert.ok(capturedLogs.includes('Vault Location:'));
      assert.ok(capturedLogs.includes('SQLite FTS:'));
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo upsert, memo get, memo promote, search, append, forget', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-full-'));
    const tempVault = path.join(tempDir, 'vault');
    const tempRepo = path.join(tempDir, 'product');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.mkdirSync(path.join(tempRepo, '.git'), { recursive: true });

    try {
      // Upsert
      const upsertCode = await runCli([
        'upsert',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--kind',
        'decision',
        '--slug',
        'cli-adr-01',
        '--title',
        'CLI Architecture Decision',
        '--body',
        'CLI Decision text',
        '--json'
      ]);
      assert.equal(upsertCode, 0);
      const upsertParsed = JSON.parse(capturedLogs.trim());
      assert.equal(upsertParsed.id, 'cli-adr-01');

      // Get (JSON mode)
      capturedLogs = '';
      const getCode = await runCli(['get', 'cli-adr-01', '--cwd', tempRepo, '--vaultRoot', tempVault, '--json']);
      assert.equal(getCode, 0);
      const getParsed = JSON.parse(capturedLogs.trim());
      assert.equal(getParsed.frontmatter.id, 'cli-adr-01');
      assert.equal(getParsed.body, 'CLI Decision text');

      // Get (Text mode)
      capturedLogs = '';
      const getTextCode = await runCli(['get', 'cli-adr-01', '--cwd', tempRepo, '--vaultRoot', tempVault]);
      assert.equal(getTextCode, 0);
      assert.ok(capturedLogs.includes('id: cli-adr-01'));
      assert.ok(capturedLogs.includes('CLI Decision text'));

      // Promote (JSON mode)
      capturedLogs = '';
      const promoteCode = await runCli([
        'promote',
        'cli-adr-01',
        'docs/adr/001.md',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(promoteCode, 0);
      const promoteParsed = JSON.parse(capturedLogs.trim());
      assert.equal(promoteParsed.id, 'cli-adr-01');
      assert.equal(promoteParsed.destination, 'docs/adr/001.md');
      assert.ok(fs.existsSync(path.join(tempRepo, 'docs', 'adr', '001.md')));

      // Promote (Text mode with force)
      capturedLogs = '';
      const promoteTextCode = await runCli([
        'promote',
        'cli-adr-01',
        'docs/adr/001.md',
        '--force',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault
      ]);
      assert.equal(promoteTextCode, 0);
      assert.ok(capturedLogs.includes('[PROMOTE] Record cli-adr-01'));

      // Search CLI with JSON
      capturedLogs = '';
      const searchCode = await runCli(['search', 'Architecture', '--cwd', tempRepo, '--vaultRoot', tempVault, '--json']);
      assert.equal(searchCode, 0);
      const searchParsed = JSON.parse(capturedLogs.trim());
      assert.ok(Array.isArray(searchParsed));
      assert.ok(searchParsed.some((h: { id: string }) => h.id === 'cli-adr-01'));

      // Append CLI
      capturedLogs = '';
      const appendCode = await runCli([
        'append',
        'Audit log via CLI test',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(appendCode, 0);
      const appendParsed = JSON.parse(capturedLogs.trim());
      assert.ok(appendParsed.id.startsWith('log-'));
      assert.equal(appendParsed.event, 'Audit log via CLI test');

      // Forget CLI (archive)
      capturedLogs = '';
      const forgetCode = await runCli(['forget', 'cli-adr-01', '--cwd', tempRepo, '--vaultRoot', tempVault, '--json']);
      assert.equal(forgetCode, 0);
      const forgetParsed = JSON.parse(capturedLogs.trim());
      assert.equal(forgetParsed.id, 'cli-adr-01');
      assert.equal(forgetParsed.status, 'archived');
      assert.equal(forgetParsed.purged, false);

      // Forget CLI (purge)
      capturedLogs = '';
      const purgeCode = await runCli([
        'forget',
        'cli-adr-01',
        '--purge',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(purgeCode, 0);
      const purgeParsed = JSON.parse(capturedLogs.trim());
      assert.equal(purgeParsed.id, 'cli-adr-01');
      assert.equal(purgeParsed.status, 'purged');
      assert.equal(purgeParsed.purged, true);
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('should execute memo import command via CLI', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-import-'));
    const tempVault = path.join(tempDir, 'vault');
    const fixtureRepo = path.join(tempDir, 'fixture');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, '.git'), { recursive: true });

    const specDir = path.join(fixtureRepo, '.agents', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'cli-import.spec.md'),
      '---\nid: cli-import\ntitle: CLI Import Spec\n---\n# CLI Import Spec\n',
      'utf8'
    );

    try {
      // JSON mode
      const importCode = await runCli([
        'import',
        fixtureRepo,
        '--vaultRoot',
        tempVault,
        '--cwd',
        fixtureRepo,
        '--json'
      ]);
      assert.equal(importCode, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.equal(parsed.importedSpecsCount, 1);
      assert.ok(parsed.totalImported >= 1);
      assert.equal(parsed.vaultRoot, undefined);
      if (Array.isArray(parsed.records)) {
        for (const rec of parsed.records) {
          assert.equal(rec.vaultPath, undefined);
        }
      }

      // Text mode
      capturedLogs = '';
      const importTextCode = await runCli([
        'import',
        fixtureRepo,
        '--vaultRoot',
        tempVault,
        '--cwd',
        fixtureRepo
      ]);
      assert.equal(importTextCode, 0);
      assert.ok(capturedLogs.includes('Imported Legacy Workflow Tree into Vault'));
      assert.ok(capturedLogs.includes('Specs:     1'));
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('should execute memo export-vault and memo import-vault via CLI', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-backup-test-'));
    const sourceVault = path.join(tempDir, 'source-vault');
    const targetVault = path.join(tempDir, 'target-vault');
    const fixtureRepo = path.join(tempDir, 'repo');
    const archiveFile = path.join(tempDir, 'archive.json');

    fs.mkdirSync(sourceVault, { recursive: true });
    fs.mkdirSync(targetVault, { recursive: true });
    fs.mkdirSync(fixtureRepo, { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, '.git'), { recursive: true });

    try {
      // Upsert a record first
      await runCli([
        'upsert',
        '--kind',
        'trap',
        '--slug',
        'cli-trap-test',
        '--title',
        'CLI Trap Test',
        '--cwd',
        fixtureRepo,
        '--vaultRoot',
        sourceVault,
        '--body',
        'Trap content for backup verification'
      ]);

      // Export vault via CLI
      capturedLogs = '';
      const exportCode = await runCli([
        'export-vault',
        '--vaultRoot',
        sourceVault,
        '--output',
        archiveFile,
        '--password',
        'CliTestPassword123!',
        '--json'
      ]);
      assert.equal(exportCode, 0);
      const exportJson = JSON.parse(capturedLogs.trim());
      assert.equal(exportJson.encrypted, true);
      assert.equal(exportJson.recordsCount, 1);
      assert.ok(fs.existsSync(archiveFile));

      // Import vault via CLI
      capturedLogs = '';
      const importCode = await runCli([
        'import-vault',
        archiveFile,
        '--vaultRoot',
        targetVault,
        '--password',
        'CliTestPassword123!',
        '--json'
      ]);
      assert.equal(importCode, 0);
      const importJson = JSON.parse(capturedLogs.trim());
      assert.equal(importJson.restoredRecordsCount, 1);
      assert.equal(importJson.rebuiltFts, true);
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('should execute memo promote with --format adr via CLI', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-promote-test-'));
    const vaultRoot = path.join(tempDir, 'vault');
    const fixtureRepo = path.join(tempDir, 'repo');

    fs.mkdirSync(vaultRoot, { recursive: true });
    fs.mkdirSync(fixtureRepo, { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, '.git'), { recursive: true });

    try {
      // Upsert a decision record
      await runCli([
        'upsert',
        '--kind',
        'decision',
        '--slug',
        'cli-adr-decision',
        '--title',
        'Architecture Decision for CLI',
        '--cwd',
        fixtureRepo,
        '--vaultRoot',
        vaultRoot,
        '--body',
        'ADR body explaining architectural choice'
      ]);

      // Promote with --format adr
      capturedLogs = '';
      const promoteCode = await runCli([
        'promote',
        'cli-adr-decision',
        'docs/adr/0001-cli.md',
        '--format',
        'adr',
        '--cwd',
        fixtureRepo,
        '--vaultRoot',
        vaultRoot
      ]);
      assert.equal(promoteCode, 0);
      assert.ok(capturedLogs.includes('[PROMOTE]'));
      assert.ok(capturedLogs.includes('(format: adr)'));

      const writtenFile = path.join(fixtureRepo, 'docs', 'adr', '0001-cli.md');
      assert.ok(fs.existsSync(writtenFile));
      const content = fs.readFileSync(writtenFile, 'utf8');
      assert.ok(content.includes('# ADR: Architecture Decision for CLI'));
      assert.ok(content.includes('## Context and Problem Statement'));
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });
});

