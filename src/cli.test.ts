import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isCliMainEntry, runCli, stdioServeEnablesStatus } from './cli.js';
import { TOOL_NAMES } from './types.js';

describe('CLI entry gate (npm-link shim)', () => {
  it('treats compiled and source cli paths as main', () => {
    assert.equal(isCliMainEntry('/opt/spec-memo/dist/cli.js'), true);
    assert.equal(isCliMainEntry('L:\\source\\spec-memo\\src\\cli.ts'), true);
  });

  it('treats npm-link / global bin shims named memo as main', () => {
    assert.equal(
      isCliMainEntry('/root/.nvm/versions/node/v24.16.0/bin/memo'),
      true
    );
    assert.equal(isCliMainEntry('C:\\Users\\me\\AppData\\Roaming\\npm\\memo.cmd'), true);
    assert.equal(isCliMainEntry('/usr/local/bin/memo.ps1'), true);
  });

  it('does not treat unrelated scripts as main', () => {
    assert.equal(isCliMainEntry(undefined), false);
    assert.equal(isCliMainEntry('/opt/spec-memo/dist/cli.test.js'), false);
    assert.equal(isCliMainEntry('/usr/bin/node'), false);
  });

  it('does not start stdio status companion unless --status or --status-port', () => {
    assert.equal(stdioServeEnablesStatus({}), false);
    assert.equal(stdioServeEnablesStatus({ sse: true }), false);
    assert.equal(stdioServeEnablesStatus({ status: true }), true);
    assert.equal(stdioServeEnablesStatus({ 'status-port': '3124' }), true);
    assert.equal(stdioServeEnablesStatus({ statusPort: 3124 }), true);
    assert.equal(stdioServeEnablesStatus({ status: true, 'no-status': true }), false);
  });

  it('returns exit 1 with stderr when Node runtime guard throws', async () => {
    const prev = process.env.SPEC_MEMO_SIMULATE_NODE;
    process.env.SPEC_MEMO_SIMULATE_NODE = '20.19.0';
    let capturedErr = '';
    const origErr = console.error;
    console.error = (...args) => {
      capturedErr += args.join(' ') + '\n';
    };
    try {
      const code = await runCli(['bootstrap', '--cwd', '.']);
      assert.equal(code, 1);
      assert.ok(capturedErr.includes('requires Node.js >= 22'));
    } finally {
      console.error = origErr;
      if (prev === undefined) {
        delete process.env.SPEC_MEMO_SIMULATE_NODE;
      } else {
        process.env.SPEC_MEMO_SIMULATE_NODE = prev;
      }
    }
  });
});

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

  it('should print package version with --version and -v', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const code1 = await runCli(['--version']);
      assert.equal(code1, 0);
      assert.ok(capturedLogs.trim().match(/^\d+\.\d+\.\d+/));

      capturedLogs = '';
      const code2 = await runCli(['-v']);
      assert.equal(code2, 0);
      assert.ok(capturedLogs.trim().match(/^\d+\.\d+\.\d+/));

      capturedLogs = '';
      const code3 = await runCli(['--version', '--json']);
      assert.equal(code3, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.ok(parsed.version && parsed.version.match(/^\d+\.\d+\.\d+/));
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

  it('should print help for canvas, sync-vault, and serve commands', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      capturedLogs = '';
      const canvasCode = await runCli(['canvas', '--help']);
      assert.equal(canvasCode, 0);
      assert.ok(capturedLogs.includes('Usage: memo canvas'));

      capturedLogs = '';
      const syncCode = await runCli(['sync-vault', '--help']);
      assert.equal(syncCode, 0);
      assert.ok(capturedLogs.includes('Usage: memo sync-vault'));

      capturedLogs = '';
      const serveCode = await runCli(['serve', '--help']);
      assert.equal(serveCode, 0);
      assert.ok(capturedLogs.includes('Usage: memo serve'));
      assert.ok(capturedLogs.includes('--sse'));
      assert.ok(capturedLogs.includes('--status'));
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo sync-vault between two vault directories', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cli-sync-test-'));
    const vaultA = path.join(tempDir, 'vault-a');
    const vaultB = path.join(tempDir, 'vault-b');
    const fixtureRepo = path.join(tempDir, 'fixture-repo');
    fs.mkdirSync(fixtureRepo, { recursive: true });

    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      // 1. Create a trap in Vault A
      await runCli([
        'upsert',
        '--kind',
        'trap',
        '--slug',
        'cli-sync-trap',
        '--cwd',
        fixtureRepo,
        '--vaultRoot',
        vaultA,
        '--body',
        '# CLI Sync Trap Body'
      ]);

      // 2. Sync from Vault A to Vault B with --json
      capturedLogs = '';
      const syncJsonCode = await runCli([
        'sync-vault',
        vaultB,
        '--vaultRoot',
        vaultA,
        '--two-way',
        '--json'
      ]);
      assert.equal(syncJsonCode, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.ok(parsed.forward);
      assert.ok(parsed.forward.applied >= 1);

      // 3. Sync from Vault A to Vault B with standard text output
      capturedLogs = '';
      const syncTextCode = await runCli([
        'sync-vault',
        vaultB,
        '--vaultRoot',
        vaultA,
        '--two-way'
      ]);
      assert.equal(syncTextCode, 0);
      assert.ok(capturedLogs.includes('Vault Synchronization Complete'));
      assert.ok(capturedLogs.includes('Forward Sync'));
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('should execute memo install-skills without crashing when boolean flags are passed', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-inst-'));
    const tempConsumer = path.join(tempDir, 'consumer');
    fs.mkdirSync(path.join(tempConsumer, '.git'), { recursive: true });

    try {
      const code = await runCli([
        'install-skills',
        tempConsumer,
        '--force',
        '--json'
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.ok(Array.isArray(parsed.installed));
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('should output datetime in search and rank human-readable CLI outputs', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cli-dt-'));
    const tempVault = path.join(tempDir, 'vault');
    const tempRepo = path.join(tempDir, 'repo');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.mkdirSync(path.join(tempRepo, '.git'), { recursive: true });

    try {
      const fixedIso = new Date().toISOString();
      const dayPrefix = fixedIso.slice(0, 10); // YYYY-MM-DD
      await runCli([
        'upsert',
        '--cwd', tempRepo,
        '--vaultRoot', tempVault,
        '--kind', 'trap',
        '--slug', 'dt-test-trap',
        '--title', 'Datetime Output Trap',
        '--severity', 'high',
        '--body', `### [${fixedIso}] Datetime Output Trap\n- **Layer**: Web\n- **Module**: UI\n- **Severity**: High\n- **PathPattern**: src/ui.ts\n- **Scenario / Context**: X\n- **DO NOT**: Y\n- **INSTEAD DO**: Z`
      ]);

      // Search in text mode
      capturedLogs = '';
      const searchCode = await runCli([
        'search',
        'Datetime Output Trap',
        '--cwd', tempRepo,
        '--vaultRoot', tempVault
      ]);
      assert.equal(searchCode, 0);
      assert.ok(capturedLogs.includes('dt-test-trap'));
      assert.ok(capturedLogs.includes(dayPrefix + 'T'));

      // Rank in text mode
      capturedLogs = '';
      const rankCode = await runCli([
        'rank',
        '--cwd', tempRepo,
        '--vaultRoot', tempVault
      ]);
      assert.equal(rankCode, 0);
      assert.ok(capturedLogs.includes('lastSeen: ' + dayPrefix + 'T'));
    } finally {
      console.log = origLog;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  it('prompt / prompts / session / activity CLI actions (JSON)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cli-prompt-'));
    const tempVault = path.join(tempDir, 'vault');
    const tempRepo = path.join(tempDir, 'repo');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.mkdirSync(tempRepo, { recursive: true });

    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      capturedLogs = '';
      const helpCode = await runCli(['prompt', '--help']);
      assert.equal(helpCode, 0);
      assert.ok(capturedLogs.includes('memo prompt'));
      assert.ok(capturedLogs.includes('derive-rules'));

      capturedLogs = '';
      const startCode = await runCli([
        'session',
        'start',
        'cli-sess-1',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--slug',
        'cli-prompt-slice',
        '--client',
        'acme',
        '--json'
      ]);
      assert.equal(startCode, 0);
      const started = JSON.parse(capturedLogs.trim());
      assert.equal(started.isError, undefined);
      assert.equal(started.sessionId, 'cli-sess-1');

      capturedLogs = '';
      const recordCode = await runCli([
        'prompt',
        'record',
        '--body',
        'Always use uniqueCliZebraToken in backoff loops.',
        '--session-id',
        'cli-sess-1',
        '--ide',
        'cursor',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(recordCode, 0);

      capturedLogs = '';
      const listCode = await runCli([
        'prompts',
        'list',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(listCode, 0);
      const listed = JSON.parse(capturedLogs.trim());
      assert.ok(listed.total >= 1);
      const promptId = listed.items[0].frontmatter.id;

      capturedLogs = '';
      const searchCode = await runCli([
        'prompt',
        'search',
        'uniqueCliZebraToken',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(searchCode, 0);
      const searched = JSON.parse(capturedLogs.trim());
      assert.ok(searched.total >= 1);

      capturedLogs = '';
      const showCode = await runCli([
        'prompt',
        'show',
        promptId,
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(showCode, 0);
      const shown = JSON.parse(capturedLogs.trim());
      assert.equal(shown.frontmatter.id, promptId);

      capturedLogs = '';
      const sessCode = await runCli([
        'prompt',
        'session',
        'cli-sess-1',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(sessCode, 0);
      const sess = JSON.parse(capturedLogs.trim());
      assert.ok(Array.isArray(sess.turns) || Array.isArray(sess));

      const exportOut = path.join(tempDir, 'story.md');
      capturedLogs = '';
      const exportCode = await runCli([
        'prompt',
        'export',
        'cli-sess-1',
        '--output',
        exportOut,
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(exportCode, 0);
      assert.ok(fs.existsSync(exportOut));

      capturedLogs = '';
      const endCode = await runCli([
        'session',
        'end',
        'cli-sess-1',
        '--summary',
        'Finished CLI prompt coverage',
        '--pr',
        'https://github.com/org/repo/pull/42',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(endCode, 0);
      const ended = JSON.parse(capturedLogs.trim());
      assert.equal(ended.status, 'completed');
      assert.ok(Array.isArray(ended.deliverables));
      assert.ok(ended.deliverables.length >= 1);

      capturedLogs = '';
      const actCode = await runCli([
        'activity',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(actCode, 0);
      const act = JSON.parse(capturedLogs.trim());
      assert.ok(act.totalSessions >= 1);
      assert.ok(act.byClient);

      capturedLogs = '';
      const deriveCode = await runCli([
        'prompt',
        'derive-rules',
        '--session-id',
        'cli-sess-1',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(deriveCode, 0);
      const derived = JSON.parse(capturedLogs.trim());
      assert.ok(Array.isArray(derived.rules));
    } finally {
      console.log = origLog;
      try {
        const { closeIndex } = await import('./indexer.js');
        closeIndex(tempVault);
      } catch {}
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('should support memo reset, backups, and restore CLI commands', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-cli-reset-'));
    const tempVault = path.join(tempDir, 'vault');
    const tempRepo = path.join(tempDir, 'repo');
    fs.mkdirSync(tempVault, { recursive: true });
    fs.mkdirSync(tempRepo, { recursive: true });

    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      // 1. Verify help outputs
      capturedLogs = '';
      const resetHelp = await runCli(['reset', '--help']);
      assert.equal(resetHelp, 0);
      assert.ok(capturedLogs.includes('Usage: memo reset'));

      capturedLogs = '';
      const restoreHelp = await runCli(['restore', '--help']);
      assert.equal(restoreHelp, 0);
      assert.ok(capturedLogs.includes('Usage: memo restore'));

      capturedLogs = '';
      const backupsHelp = await runCli(['backups', '--help']);
      assert.equal(backupsHelp, 0);
      assert.ok(capturedLogs.includes('Usage: memo backups'));

      // 2. Upsert a trap record
      capturedLogs = '';
      const upCode = await runCli([
        'upsert',
        '--kind',
        'trap',
        '--title',
        'CLI Reset Trap',
        '--severity',
        'high',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json',
        'Body of CLI trap'
      ]);
      assert.equal(upCode, 0);

      // 3. Reset vault with --force
      capturedLogs = '';
      const resetCode = await runCli([
        'reset',
        '--all',
        '--force',
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(resetCode, 0);
      const resetRes = JSON.parse(capturedLogs.trim());
      assert.equal(resetRes.ok, true);
      assert.ok(resetRes.backupFilename.endsWith('.zip'));
      assert.equal(resetRes.wipedRecordsCount, 1);

      // 4. List backups via CLI
      capturedLogs = '';
      const backupsCode = await runCli([
        'backups',
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(backupsCode, 0);
      const backupsRes = JSON.parse(capturedLogs.trim());
      assert.equal(backupsRes.ok, true);
      assert.ok(backupsRes.backups.length >= 1);
      assert.equal(backupsRes.backups[0].filename, resetRes.backupFilename);

      // 5. Restore from latest backup via CLI
      capturedLogs = '';
      const restoreCode = await runCli([
        'restore',
        '--latest',
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(restoreCode, 0);
      const restoreRes = JSON.parse(capturedLogs.trim());
      assert.equal(restoreRes.restoredRecordsCount, 1);

      // Verify search finds the restored trap
      capturedLogs = '';
      const searchCode = await runCli([
        'search',
        'Reset Trap',
        '--cwd',
        tempRepo,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(searchCode, 0);
      const searchRes = JSON.parse(capturedLogs.trim());
      assert.ok(Array.isArray(searchRes));
      assert.equal(searchRes.length, 1);
    } finally {
      console.log = origLog;
      try {
        const { closeIndex } = await import('./indexer.js');
        closeIndex(tempVault);
      } catch {}
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });
});



