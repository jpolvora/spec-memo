import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    } finally {
      console.log = origLog;
    }
  });

  it('should output JSON error and exit 1 on tool execution in Slice 1', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const code = await runCli(['bootstrap', '--cwd', '.', '--json']);
      assert.equal(code, 1);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.equal(parsed.isError, true);
      assert.equal(parsed.code, 'NOT_IMPLEMENTED');
    } finally {
      console.log = origLog;
    }
  });

  it('should return 1 for unimplemented doctor command', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const code = await runCli(['doctor', '--json']);
      assert.equal(code, 1);
      const parsed = JSON.parse(capturedLogs.trim());
      assert.equal(parsed.isError, true);
      assert.equal(parsed.code, 'NOT_IMPLEMENTED');
    } finally {
      console.log = origLog;
    }
  });

  it('should execute memo upsert and memo get through CLI with --json', async () => {
    let capturedLogs = '';
    const origLog = console.log;
    console.log = (...args) => {
      capturedLogs += args.join(' ') + '\n';
    };

    try {
      const upsertCode = await runCli([
        'upsert',
        '--kind',
        'decision',
        '--slug',
        'cli-adr-01',
        '--body',
        'CLI Decision text',
        '--json'
      ]);
      assert.equal(upsertCode, 0);
      const upsertParsed = JSON.parse(capturedLogs.trim());
      assert.equal(upsertParsed.id, 'cli-adr-01');

      capturedLogs = '';
      const getCode = await runCli(['get', '--id', 'cli-adr-01', '--json']);
      assert.equal(getCode, 0);
      const getParsed = JSON.parse(capturedLogs.trim());
      assert.equal(getParsed.frontmatter.id, 'cli-adr-01');
      assert.equal(getParsed.body, 'CLI Decision text');
    } finally {
      console.log = origLog;
    }
  });
});
