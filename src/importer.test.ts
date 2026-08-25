import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { importWorkflowTree } from './importer.js';
import { getRecord } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';

describe('Importer Engine (importWorkflowTree)', () => {
  let tempDir: string;
  let tempVaultRoot: string;
  let fixtureRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-import-test-'));
    tempVaultRoot = path.join(tempDir, 'vault');
    fixtureRepo = path.join(tempDir, 'fixture-repo');

    fs.mkdirSync(tempVaultRoot, { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, '.git'), { recursive: true });

    // 1. Plant specs
    const specsDir = path.join(fixtureRepo, '.agents', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(
      path.join(specsDir, 'user-auth.spec.md'),
      `---
id: user-auth
slug: user-auth
title: User Authentication Specification
status: active
---

# Specification — User Authentication
AC1: JWT validation.
`,
      'utf8'
    );

    // 2. Plant memory traps & decisions
    const memDir = path.join(fixtureRepo, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    fs.writeFileSync(
      path.join(memDir, 'trap-jwt-secrets.md'),
      `---
id: trap-jwt-secrets
title: Never log raw JWT secret tokens
severity: high
pathPatterns:
  - src/auth/**
---

## DO NOT
Do not print JWT token secrets in debug logs.

## INSTEAD DO
Redact or hash tokens before logging.
`,
      'utf8'
    );

    fs.writeFileSync(
      path.join(memDir, 'adr-001-db-choice.md'),
      `---
id: adr-001-db-choice
title: Use SQLite with WAL mode
kind: decision
status: accepted
---

# ADR 001: SQLite Choice
Rationale: Zero runtime daemon dependency.
`,
      'utf8'
    );

    // Plant compiled MEMORY.md (must be skipped)
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Compiled Memory Dump\nShould be skipped', 'utf8');

    // 3. Plant active plan directory
    const planFolder = path.join(fixtureRepo, '.agents', 'plans', 'slice-auth');
    fs.mkdirSync(planFolder, { recursive: true });
    fs.writeFileSync(
      path.join(planFolder, 'plan.md'),
      `# Plan: Slice Auth
Step 1: Create handler.
Step 2: Add test.
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(planFolder, '.state.md'),
      `# State: Slice Auth
current_step: step-2
status: in_progress
`,
      'utf8'
    );
    // Plant telemetry to skip
    fs.writeFileSync(path.join(planFolder, 'telemetry.jsonl'), '{"event": "start"}\n', 'utf8');

    // 4. Plant CHANGELOG.md
    fs.writeFileSync(
      path.join(fixtureRepo, 'CHANGELOG.md'),
      `# Agent Changelog

## 2026-08-20 — Setup Auth Module
Configured initial JWT middleware and route guards.

## 2026-08-21 — Add SQLite DB Storage
Added SQLite persistence adapter for tokens.
`,
      'utf8'
    );
  });

  afterEach(() => {
    closeIndex(tempVaultRoot);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should import specs, traps, decisions, plans, state, and changelogs correctly into vault', async () => {
    const result = await importWorkflowTree({
      from: fixtureRepo,
      vaultRoot: tempVaultRoot
    });

    assert.equal(result.importedSpecsCount, 1);
    assert.equal(result.importedTrapsCount, 1);
    assert.equal(result.importedDecisionsCount, 1);
    assert.equal(result.importedPlansCount, 1);
    assert.equal(result.importedStateCount, 1);
    assert.equal(result.importedLogsCount, 2);
    assert.ok(result.totalImported >= 7);
    assert.ok(result.skippedFilesCount >= 2); // MEMORY.md + telemetry.jsonl

    // Verify records can be retrieved from the vault
    const specRecord = await getRecord({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      id: 'user-auth'
    });
    assert.ok(specRecord);
    assert.equal(specRecord.frontmatter.kind, 'spec');
    assert.equal(specRecord.frontmatter.source, 'imported');

    const trapRecord = await getRecord({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      id: 'trap-jwt-secrets'
    });
    assert.ok(trapRecord);
    assert.equal(trapRecord.frontmatter.kind, 'trap');
    assert.equal(trapRecord.frontmatter.severity, 'high');

    const decisionRecord = await getRecord({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      id: 'adr-001-db-choice'
    });
    assert.ok(decisionRecord);
    assert.equal(decisionRecord.frontmatter.kind, 'decision');

    const planRecord = await getRecord({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      id: 'slice-auth'
    });
    assert.ok(planRecord);
    assert.equal(planRecord.frontmatter.kind, 'plan');

    // Verify FTS search finds the imported records
    const hits = searchIndex({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      query: 'SQLite'
    });
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.id === 'adr-001-db-choice'));
  });

  it('should be completely idempotent when import is run repeatedly', async () => {
    const result1 = await importWorkflowTree({
      from: fixtureRepo,
      vaultRoot: tempVaultRoot
    });

    const result2 = await importWorkflowTree({
      from: fixtureRepo,
      vaultRoot: tempVaultRoot
    });

    assert.equal(result1.totalImported, result2.totalImported);

    // Search for trap: must return exactly 1 hit, not duplicate entries
    const hits = searchIndex({
      cwd: fixtureRepo,
      vaultRoot: tempVaultRoot,
      kinds: ['trap']
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'trap-jwt-secrets');
  });
});
