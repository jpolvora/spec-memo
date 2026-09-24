import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  TelemetryRecorder,
  isTelemetryEnabled,
  getTelemetryDir,
  recordTelemetry,
  flushTelemetry,
  flushTelemetrySync,
  closeTelemetry,
  resetTelemetryRecorderForTest,
  listTelemetryFiles,
  readTelemetryEvents,
  summarizeTelemetry,
  latestTelemetryFile
} from './telemetry.js';
import { ensureVaultStructure, DEFAULT_VAULT_CONFIG } from './vault.js';
import { executeTool } from './tools.js';
import { runGc } from './curator.js';
import { closeIndex } from './indexer.js';
import { importWorkflowTree } from './importer.js';

describe('Operational Telemetry & Structured Rolling Usage Logging', () => {
  let tempVault: string;
  let tempProject: string;
  let originalEnvRoot: string | undefined;
  let originalEnvTelemetry: string | undefined;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-tel-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-tel-proj-'));
    originalEnvRoot = process.env.SPEC_MEMO_ROOT;
    originalEnvTelemetry = process.env.SPEC_MEMO_ENABLE_TELEMETRY;
    process.env.SPEC_MEMO_ROOT = tempVault;
    delete process.env.SPEC_MEMO_ENABLE_TELEMETRY;
    resetTelemetryRecorderForTest();
  });

  afterEach(async () => {
    await closeTelemetry();
    resetTelemetryRecorderForTest();
    closeIndex();

    if (originalEnvRoot !== undefined) {
      process.env.SPEC_MEMO_ROOT = originalEnvRoot;
    } else {
      delete process.env.SPEC_MEMO_ROOT;
    }

    if (originalEnvTelemetry !== undefined) {
      process.env.SPEC_MEMO_ENABLE_TELEMETRY = originalEnvTelemetry;
    } else {
      delete process.env.SPEC_MEMO_ENABLE_TELEMETRY;
    }

    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('AC1: should have enableTelemetry: true in DEFAULT_VAULT_CONFIG and VaultConfig', () => {
    assert.equal(DEFAULT_VAULT_CONFIG.enableTelemetry, true);
    assert.ok(DEFAULT_VAULT_CONFIG.telemetry);
    assert.equal(DEFAULT_VAULT_CONFIG.telemetry.maxFileSizeMb, 10);
    assert.equal(DEFAULT_VAULT_CONFIG.telemetry.flushIntervalMs, 500);
    assert.equal(DEFAULT_VAULT_CONFIG.telemetry.maxQueueSize, 50);

    const config = ensureVaultStructure(tempVault);
    assert.equal(config.enableTelemetry, true);
    assert.ok(fs.existsSync(path.join(tempVault, 'telemetry')));
  });

  it('AC2: should respect enableTelemetry: false in config.json and no-op without writes', () => {
    const configPath = path.join(tempVault, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...DEFAULT_VAULT_CONFIG,
        enableTelemetry: false
      }, null, 2),
      'utf8'
    );

    assert.equal(isTelemetryEnabled(tempVault), false);

    const recorder = new TelemetryRecorder({ vaultRoot: tempVault });
    recorder.record({
      category: 'mcp_tool',
      operation: 'bootstrap',
      durationMs: 15.2,
      success: true,
      vaultRoot: tempVault
    });

    assert.equal(recorder.getQueueLength(), 0);
    recorder.flushSync();

    const files = listTelemetryFiles(tempVault);
    assert.equal(files.length, 0);
  });

  it('AC2: should let SPEC_MEMO_ENABLE_TELEMETRY env var override config.json', () => {
    // 1. Config says true, env var says 0 -> disabled
    process.env.SPEC_MEMO_ENABLE_TELEMETRY = '0';
    assert.equal(isTelemetryEnabled(tempVault), false);

    process.env.SPEC_MEMO_ENABLE_TELEMETRY = 'false';
    assert.equal(isTelemetryEnabled(tempVault), false);

    // 2. Config says false, env var says 1 -> enabled
    const configPath = path.join(tempVault, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...DEFAULT_VAULT_CONFIG,
        enableTelemetry: false
      }, null, 2),
      'utf8'
    );
    process.env.SPEC_MEMO_ENABLE_TELEMETRY = '1';
    assert.equal(isTelemetryEnabled(tempVault), true);
  });

  it('AC3: should format events with valid JSONL schema fields', () => {
    const recorder = new TelemetryRecorder({ vaultRoot: tempVault });
    const fixedTime = '2026-08-27T12:00:00.000Z';

    recorder.record({
      timestamp: fixedTime,
      eventId: 'tel-custom-001',
      category: 'mcp_tool',
      operation: 'upsert',
      durationMs: 42.678,
      success: true,
      projectId: 'proj-sample',
      metadata: { kind: 'trap', count: 1 },
      vaultRoot: tempVault
    });

    recorder.flushSync();

    const events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.timestamp, fixedTime);
    assert.equal(ev.eventId, 'tel-custom-001');
    assert.equal(ev.category, 'mcp_tool');
    assert.equal(ev.operation, 'upsert');
    assert.equal(ev.durationMs, 42.7);
    assert.equal(ev.success, true);
    assert.equal(ev.projectId, 'proj-sample');
    assert.deepEqual(ev.metadata, { kind: 'trap', count: 1 });
  });

  it('AC4: should emit telemetry event when executeTool runs', async () => {
    ensureVaultStructure(tempVault);

    const res = await executeTool('search', {
      query: 'test query',
      vaultRoot: tempVault,
      cwd: tempProject
    });
    assert.ok(!res.isError);

    flushTelemetrySync(tempVault);

    const events = readTelemetryEvents(tempVault);
    assert.ok(events.length >= 1);
    const toolEvent = events.find((e) => e.category === 'mcp_tool' && e.operation === 'search');
    assert.ok(toolEvent, 'Expected mcp_tool search event in telemetry');
    assert.equal(toolEvent.success, true);
    assert.ok(toolEvent.durationMs >= 0);
  });

  it('AC4: should emit telemetry event when runGc runs', async () => {
    ensureVaultStructure(tempVault);

    await runGc({
      vaultRoot: tempVault,
      cwd: tempProject,
      dryRun: true
    });

    flushTelemetrySync(tempVault);

    const events = readTelemetryEvents(tempVault);
    const gcEvent = events.find((e) => e.category === 'curator_gc' && e.operation === 'memo_gc');
    assert.ok(gcEvent, 'Expected curator_gc event in telemetry');
    assert.equal(gcEvent.success, true);
  });

  it('AC4: should emit telemetry event when importWorkflowTree runs', async () => {
    ensureVaultStructure(tempVault);

    await importWorkflowTree({
      vaultRoot: tempVault,
      from: tempProject
    });

    flushTelemetrySync(tempVault);

    const events = readTelemetryEvents(tempVault);
    const importEvent = events.find((e) => e.category === 'importer' && e.operation === 'memo_import');
    assert.ok(importEvent, 'Expected importer event in telemetry');
    assert.equal(importEvent.success, true);
  });

  it('AC5 & AC6: should store files in $SPEC_MEMO_ROOT/telemetry/ with telemetry-YYYY-MM-DD.part-N.jsonl naming', () => {
    const recorder = new TelemetryRecorder({ vaultRoot: tempVault });
    recorder.record({
      timestamp: '2026-08-27T10:00:00.000Z',
      category: 'cli_command',
      operation: 'doctor',
      durationMs: 10,
      success: true,
      vaultRoot: tempVault
    });

    recorder.flushSync();

    const telDir = getTelemetryDir(tempVault);
    assert.equal(telDir, path.join(tempVault, 'telemetry'));
    assert.ok(fs.existsSync(telDir));

    const files = listTelemetryFiles(tempVault);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'telemetry-2026-08-27.part-1.jsonl');
  });

  it('AC7: should automatically roll over to part-2.jsonl when exceeding maxFileSizeMb', () => {
    // Instantiate recorder with 1 MB limit (minimum clamped)
    const recorder = new TelemetryRecorder({
      vaultRoot: tempVault,
      maxFileSizeMb: 1
    });

    const dateStr = '2026-08-27';
    const telDir = getTelemetryDir(tempVault);
    fs.mkdirSync(telDir, { recursive: true });

    // Seed part-1 file with 1 MB of padding
    const part1Path = path.join(telDir, `telemetry-${dateStr}.part-1.jsonl`);
    const padding1Mb = 'x'.repeat(1024 * 1024);
    fs.writeFileSync(part1Path, padding1Mb, 'utf8');

    // Record new event for that same date
    recorder.record({
      timestamp: `${dateStr}T14:30:00.000Z`,
      category: 'mcp_tool',
      operation: 'upsert',
      durationMs: 5,
      success: true,
      vaultRoot: tempVault
    });

    recorder.flushSync();

    const files = listTelemetryFiles(tempVault);
    assert.ok(files.includes(`telemetry-${dateStr}.part-1.jsonl`));
    assert.ok(files.includes(`telemetry-${dateStr}.part-2.jsonl`));

    const part2Events = readTelemetryEvents(tempVault, { date: dateStr, part: 2 });
    assert.equal(part2Events.length, 1);
    assert.equal(part2Events[0].operation, 'upsert');
  });

  it('AC8: should rotate to new date starting at part-1 when day advances', () => {
    const recorder = new TelemetryRecorder({ vaultRoot: tempVault });

    recorder.record({
      timestamp: '2026-08-27T23:59:59.000Z',
      category: 'mcp_tool',
      operation: 'get',
      durationMs: 2,
      success: true,
      vaultRoot: tempVault
    });

    recorder.record({
      timestamp: '2026-08-28T00:00:01.000Z',
      category: 'mcp_tool',
      operation: 'get',
      durationMs: 3,
      success: true,
      vaultRoot: tempVault
    });

    recorder.flushSync();

    const files = listTelemetryFiles(tempVault);
    assert.ok(files.includes('telemetry-2026-08-27.part-1.jsonl'));
    assert.ok(files.includes('telemetry-2026-08-28.part-1.jsonl'));

    const day1Events = readTelemetryEvents(tempVault, { date: '2026-08-27' });
    const day2Events = readTelemetryEvents(tempVault, { date: '2026-08-28' });
    assert.equal(day1Events.length, 1);
    assert.equal(day2Events.length, 1);
  });

  it('AC9: should flush asynchronously when queue threshold is reached', async () => {
    const recorder = new TelemetryRecorder({
      vaultRoot: tempVault,
      maxQueueSize: 3,
      flushIntervalMs: 10000 // long interval
    });

    recorder.record({
      category: 'mcp_tool',
      operation: 'tool1',
      durationMs: 1,
      success: true,
      vaultRoot: tempVault
    });
    recorder.record({
      category: 'mcp_tool',
      operation: 'tool2',
      durationMs: 1,
      success: true,
      vaultRoot: tempVault
    });

    assert.equal(recorder.getQueueLength(), 2);

    // Third record triggers queue threshold flush
    recorder.record({
      category: 'mcp_tool',
      operation: 'tool3',
      durationMs: 1,
      success: true,
      vaultRoot: tempVault
    });

    await new Promise((r) => setTimeout(r, 50));

    const events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 3);
  });

  it('AC10: should safely isolate disk write errors without throwing into caller', () => {
    const invalidVault = path.join(tempVault, 'nonexistent-subdir', '\0invalid-path');
    const recorder = new TelemetryRecorder({ vaultRoot: invalidVault });

    assert.doesNotThrow(() => {
      recorder.record({
        category: 'mcp_tool',
        operation: 'search',
        durationMs: 5,
        success: true,
        vaultRoot: invalidVault
      });
      recorder.flushSync();
    });
  });

  it('AC11: should sanitize credentials and tokens from metadata', () => {
    recordTelemetry({
      category: 'mcp_tool',
      operation: 'test-sanitization',
      durationMs: 10,
      success: true,
      vaultRoot: tempVault,
      metadata: {
        token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
        bearer: 'Bearer secret-jwt-token-with-many-characters-12345',
        safeKey: 'valid_data',
        vaultRoot: tempVault,
        nested: {
          pathWithSecret: 'key is ghp_9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA',
          hostPath: 'C:\\Users\\john\\secret\\file.txt'
        }
      }
    });

    flushTelemetrySync(tempVault);

    const events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 1);
    const meta = events[0].metadata as Record<string, unknown>;
    assert.ok(meta);
    assert.equal(meta.safeKey, 'valid_data');
    assert.ok(typeof meta.token === 'string' && (meta.token as string).includes('[REDACTED'));
    assert.ok(typeof meta.bearer === 'string' && (meta.bearer as string).includes('[REDACTED'));
    assert.equal(meta.vaultRoot, undefined); // stripped by stripVaultPaths
    const nested = meta.nested as Record<string, string>;
    assert.ok(nested);
    assert.ok(nested.pathWithSecret.includes('[REDACTED'));
    assert.ok(!nested.hostPath.includes('Users'));
  });

  it('AC12: should flush pending telemetry on closeTelemetry and flushTelemetrySync', async () => {
    recordTelemetry({
      category: 'mcp_tool',
      operation: 'flush-test',
      durationMs: 4,
      success: true,
      vaultRoot: tempVault
    });

    await closeTelemetry();

    const events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'flush-test');
  });

  it('should isolate telemetry records per vaultRoot in multi-vault processes', async () => {
    const secondVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-telemetry-vault2-'));
    try {
      recordTelemetry({
        category: 'mcp_tool',
        operation: 'vault-1-op',
        durationMs: 10,
        success: true,
        vaultRoot: tempVault
      });

      recordTelemetry({
        category: 'mcp_tool',
        operation: 'vault-2-op',
        durationMs: 20,
        success: true,
        vaultRoot: secondVault
      });

      await closeTelemetry();

      const events1 = readTelemetryEvents(tempVault);
      const events2 = readTelemetryEvents(secondVault);

      assert.equal(events1.length, 1);
      assert.equal(events1[0].operation, 'vault-1-op');

      assert.equal(events2.length, 1);
      assert.equal(events2[0].operation, 'vault-2-op');
    } finally {
      fs.rmSync(secondVault, { recursive: true, force: true });
    }
  });

  it('should consume telemetry config block from config.json when constructing recorder', async () => {
    const configPath = path.join(tempVault, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        telemetry: {
          maxQueueSize: 2,
          flushIntervalMs: 50
        }
      })
    );
    resetTelemetryRecorderForTest();

    recordTelemetry({
      category: 'mcp_tool',
      operation: 'cfg-1',
      durationMs: 1,
      success: true,
      vaultRoot: tempVault
    });

    // Not yet flushed because maxQueueSize is 2
    let events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 0);

    // Second event triggers flush due to maxQueueSize: 2
    recordTelemetry({
      category: 'mcp_tool',
      operation: 'cfg-2',
      durationMs: 2,
      success: true,
      vaultRoot: tempVault
    });

    // Wait a tick for async flush to complete
    await new Promise((r) => setTimeout(r, 60));

    events = readTelemetryEvents(tempVault);
    assert.equal(events.length, 2);
  });

  it('summarizeTelemetry classifies expected vs product faults and points at rolling files', () => {
    const dir = getTelemetryDir(tempVault);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'telemetry-2026-09-22.part-1.jsonl');
    const rows = [
      { timestamp: '2026-09-22T00:00:00.000Z', eventId: 'a', category: 'cli_command', operation: 'doctor', durationMs: 10, success: false, errorCode: 'EXIT_1' },
      { timestamp: '2026-09-22T00:00:01.000Z', eventId: 'b', category: 'sync_operation', operation: 'sync_dual', durationMs: 40, success: false, errorCode: 'VAULT_GIT_SYNC_FAILED' },
      { timestamp: '2026-09-22T00:00:02.000Z', eventId: 'c', category: 'mcp_tool', operation: 'get', durationMs: 5, success: true }
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const summary = summarizeTelemetry(tempVault, { maxEvents: 100 });
    assert.equal(summary.eventCount, 3);
    assert.equal(summary.failureCount, 2);
    assert.equal(summary.expectedFaults, 1);
    assert.equal(summary.productFaults, 1);
    assert.ok(latestTelemetryFile(tempVault)?.endsWith('telemetry-2026-09-22.part-1.jsonl'));
  });
  it('AC19/AC21: summary exposes failure rate, per-project health and observable counters', () => {
    process.env.SPEC_MEMO_TELEMETRY_TEST = '1';
    try {
      recordTelemetry({ category: 'sync_operation', operation: 'sync_hybrid', durationMs: 10, success: true, projectId: 'p1', vaultRoot: tempVault, metadata: { pulledSkipped: 2, pushedConflicts: 1 } });
      recordTelemetry({ category: 'sync_operation', operation: 'sync_dual', durationMs: 20, success: false, errorCode: 'HYBRID_FAILED', projectId: 'p1', vaultRoot: tempVault, metadata: { pulledConflicts: 1, hybridDirtyBefore: true, hybridDirtyAfter: false } });
      recordTelemetry({ category: 'sync_operation', operation: 'view_rebuild', durationMs: 0, success: true, projectId: 'p2', vaultRoot: tempVault, metadata: { skipped: 3, rebuildSkipped: 3 } });
      recordTelemetry({ category: 'http_endpoint', operation: 'health_check', durationMs: 1, success: true, vaultRoot: tempVault });
      recordTelemetry({ category: 'mcp_tool', operation: 'search', durationMs: 5, success: true, projectId: 'p2', vaultRoot: tempVault });
    } finally {
      delete process.env.SPEC_MEMO_TELEMETRY_TEST;
    }
    flushTelemetrySync(tempVault);
    const summary = summarizeTelemetry(tempVault);
    assert.equal(summary.eventCount, 5);
    assert.equal(summary.failureCount, 1);
    assert.equal(summary.failureRate, 0.2);
    const p1 = summary.perProject.find((p) => p.projectId === 'p1');
    assert.ok(p1 && p1.eventCount === 2 && p1.failureCount === 1);
    assert.equal(summary.counters.syncConflicts, 2);
    assert.equal(summary.counters.skippedRecords, 5); // 2 pull-skipped + 3 view-rebuild-skipped (sync_operation)
    assert.equal(summary.counters.rebuildSkips, 3);
    assert.equal(summary.counters.dirtyTransitions, 1);
    assert.equal(summary.counters.probeNoise, 1);
    assert.equal(summary.counters.testOriginated, 5);
  });

  it('NS12: malformed telemetry history yields bounded redacted summary', () => {
    const dir = path.join(tempVault, 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', eventId: 'ns12', category: 'cli_command', operation: 'status', durationMs: 1, success: true });
    fs.writeFileSync(path.join(dir, 'telemetry-2026-01-01.part-1.jsonl'), 'not json\n'.repeat(50) + good + '\n{broken', 'utf8');
    const summary = summarizeTelemetry(tempVault);
    assert.equal(summary.eventCount, 1);
    assert.ok(summary.counters);
    assert.ok(summary.logFile && summary.logFile.includes('telemetry-2026-01-01.part-1.jsonl'));
  });

});
