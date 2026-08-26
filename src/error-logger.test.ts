import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveErrorLogPath,
  formatErrorReport,
  logErrorReport,
  readErrorLogs,
  clearErrorLogs,
  ErrorReport
} from './error-logger.js';

describe('Error Logger Subsystem', () => {
  let testVaultRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    testVaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-error-log-test-'));
    originalEnv = process.env.SPEC_MEMO_ERROR_LOG;
    delete process.env.SPEC_MEMO_ERROR_LOG;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SPEC_MEMO_ERROR_LOG = originalEnv;
    } else {
      delete process.env.SPEC_MEMO_ERROR_LOG;
    }
    if (fs.existsSync(testVaultRoot)) {
      fs.rmSync(testVaultRoot, { recursive: true, force: true });
    }
  });

  it('resolves default path to <vaultRoot>/error.logs', () => {
    const resolved = resolveErrorLogPath(testVaultRoot);
    assert.strictEqual(resolved, path.join(testVaultRoot, 'error.logs'));
  });

  it('respects SPEC_MEMO_ERROR_LOG environment variable', () => {
    const customEnvPath = path.join(testVaultRoot, 'custom-env.logs');
    process.env.SPEC_MEMO_ERROR_LOG = customEnvPath;
    const resolved = resolveErrorLogPath(testVaultRoot);
    assert.strictEqual(resolved, path.resolve(customEnvPath));
  });

  it('prioritizes explicit customPath argument over env var and default', () => {
    const customArgPath = path.join(testVaultRoot, 'custom-arg.logs');
    process.env.SPEC_MEMO_ERROR_LOG = path.join(testVaultRoot, 'ignored-env.logs');
    const resolved = resolveErrorLogPath(testVaultRoot, customArgPath);
    assert.strictEqual(resolved, path.resolve(customArgPath));
  });

  it('formats ErrorReport with all metadata and stack traces', () => {
    const err = new Error('Test connection reset');
    const report: ErrorReport = {
      timestamp: '2026-08-26T20:00:00.000Z',
      level: 'ERROR',
      subsystem: 'sse-server',
      port: 3000,
      host: '127.0.0.1',
      mode: 'hybrid',
      endpoint: '/api/sync/push',
      method: 'POST',
      projectId: 'test-project-123',
      clientIp: '127.0.0.1',
      error: err,
      context: {
        payloadSize: 1024,
        dryRun: false
      }
    };

    const formatted = formatErrorReport(report);

    assert(formatted.includes('[2026-08-26T20:00:00.000Z] [ERROR] [sse-server] (Port: 3000, Host: 127.0.0.1, Mode: hybrid)'));
    assert(formatted.includes('Endpoint:    POST /api/sync/push'));
    assert(formatted.includes('Project ID:  test-project-123'));
    assert(formatted.includes('Client IP:   127.0.0.1'));
    assert(formatted.includes('Error:       Test connection reset'));
    assert(formatted.includes('Stack Trace:'));
    assert(formatted.includes('Context Details:'));
    assert(formatted.includes('"payloadSize": 1024'));
    assert(formatted.includes('================================================================================'));
  });

  it('redacts secrets (bearer tokens, API keys, private keys) from error report', () => {
    const secretToken = 'Bearer secret-token-value-12345678901234567890';
    const secretError = new Error(`Authentication failure with ${secretToken}`);
    const report: ErrorReport = {
      subsystem: 'status-server',
      port: 3001,
      error: secretError,
      context: {
        authorization: 'Bearer supersecrettokenvalue12345678901234567890',
        apiKey: 'api_key="12345678901234567890"'
      }
    };

    const formatted = formatErrorReport(report);

    assert(!formatted.includes('secret-token-value-12345678901234567890'));
    assert(!formatted.includes('supersecrettokenvalue12345678901234567890'));
    assert(formatted.includes('[REDACTED:'));
  });

  it('sanitizes short bearer tokens, headers, and query parameters from context', () => {
    const report: ErrorReport = {
      subsystem: 'sse-server',
      port: 3000,
      error: 'Unauthorized access',
      context: {
        headers: {
          authorization: 'Bearer short-123',
          cookie: 'session_id=abcdef123',
          'x-api-key': 'shortkey'
        },
        query: {
          token: 'short-query-token',
          authToken: 'another-token',
          project: 'test-proj'
        },
        password: 'cleartext-password'
      }
    };

    const formatted = formatErrorReport(report);

    assert(!formatted.includes('short-123'));
    assert(!formatted.includes('abcdef123'));
    assert(!formatted.includes('shortkey'));
    assert(!formatted.includes('short-query-token'));
    assert(!formatted.includes('another-token'));
    assert(!formatted.includes('cleartext-password'));
    assert(formatted.includes('"project": "test-proj"'));
  });

  it('appends multiple error reports to error.logs without overwriting', () => {
    logErrorReport(
      {
        subsystem: 'sse-server',
        port: 3000,
        error: 'First failure'
      },
      { vaultRoot: testVaultRoot }
    );

    logErrorReport(
      {
        subsystem: 'status-server',
        port: 3001,
        error: 'Second failure'
      },
      { vaultRoot: testVaultRoot }
    );

    const content = readErrorLogs(testVaultRoot);
    assert(content.includes('First failure'));
    assert(content.includes('Second failure'));
    assert(content.includes('[sse-server]'));
    assert(content.includes('[status-server]'));
  });

  it('clearErrorLogs safely removes the log file', () => {
    logErrorReport(
      {
        subsystem: 'sse-server',
        port: 3000,
        error: 'A transient issue'
      },
      { vaultRoot: testVaultRoot }
    );

    assert(fs.existsSync(path.join(testVaultRoot, 'error.logs')));
    clearErrorLogs(testVaultRoot);
    assert(!fs.existsSync(path.join(testVaultRoot, 'error.logs')));
    assert.strictEqual(readErrorLogs(testVaultRoot), '');
  });
});
