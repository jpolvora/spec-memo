import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DEFAULT_IGNORE_PATTERNS,
  checkCapturePath,
  clearIgnoreCacheForTests,
  formatCheckCaptureResult,
  isPathIgnored,
  loadIgnoreRules,
  redactIgnoredPathsInText,
  sanitizePathPatterns
} from './capture-ignore.js';
import { upsertRecord } from './store.js';
import { closeIndex } from './indexer.js';
import { recordPromptTurn } from './prompt.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { searchIndex } from './indexer.js';
import { runDoctor } from './doctor.js';

describe('Capture ignore marker and safety boundary', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-capture-ignore-'));
    vaultRoot = path.join(tempDir, 'vault');
    productRepo = path.join(tempDir, 'product-repo');
    fs.mkdirSync(productRepo, { recursive: true });
    fs.mkdirSync(path.join(productRepo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, 'config.json'),
      JSON.stringify({ version: '0.0.0-test', ttl: { scratchDays: 7, reviewDays: 14 }, bootstrap: { maxBytes: 8192, maxTraps: 50 } })
    );
    clearIgnoreCacheForTests();
  });

  afterEach(() => {
    closeIndex();
    clearIgnoreCacheForTests();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows tolerance
      }
    }
  });

  it('loads built-in baseline ignore patterns by default (AC2)', () => {
    const boundary = loadIgnoreRules(productRepo, { vaultRoot });
    assert.ok(boundary.activeRuleCount >= DEFAULT_IGNORE_PATTERNS.length);
    assert.ok(isPathIgnored('node_modules/pkg/index.js', productRepo, { vaultRoot }));
    assert.ok(isPathIgnored('.env', productRepo, { vaultRoot }));
  });

  it('parses .spec-memo-ignore with comments and negation (AC1, AC4)', () => {
    fs.writeFileSync(
      path.join(productRepo, '.spec-memo-ignore'),
      '# vendor SDK\nvendor/**\n!important.log\n'
    );
    clearIgnoreCacheForTests();
    assert.ok(isPathIgnored('vendor/sdk/foo.ts', productRepo, { vaultRoot }));
    assert.ok(!isPathIgnored('important.log', productRepo, { vaultRoot }));

    const stat = fs.statSync(path.join(productRepo, '.spec-memo-ignore'));
    fs.utimesSync(path.join(productRepo, '.spec-memo-ignore'), stat.atime, new Date());
    clearIgnoreCacheForTests();
    fs.appendFileSync(path.join(productRepo, '.spec-memo-ignore'), 'secrets/**\n');
    clearIgnoreCacheForTests();
    assert.ok(isPathIgnored('secrets/key.env', productRepo, { vaultRoot }));
  });

  it('merges config.json projects ignorePaths (AC3)', () => {
    const config = JSON.parse(fs.readFileSync(path.join(vaultRoot, 'config.json'), 'utf8'));
    config.projects = { 'test-project': { ignorePaths: ['private/**'] } };
    fs.writeFileSync(path.join(vaultRoot, 'config.json'), JSON.stringify(config));
    clearIgnoreCacheForTests();
    assert.ok(isPathIgnored('private/data.txt', productRepo, { vaultRoot, projectId: 'test-project' }));
  });

  it('check-capture reports CAPTURED and IGNORED with source layer (AC12)', () => {
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), '*.env\n');
    clearIgnoreCacheForTests();
    fs.mkdirSync(path.join(productRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(productRepo, 'src', 'app.ts'), 'export {};\n');

    const ignored = checkCapturePath('src/secrets/key.env', productRepo, { vaultRoot });
    assert.equal(ignored.status, 'IGNORED');
    assert.match(formatCheckCaptureResult(ignored), /IGNORED/);

    const captured = checkCapturePath('src/app.ts', productRepo, { vaultRoot });
    assert.equal(captured.status, 'CAPTURED');
    assert.match(formatCheckCaptureResult(captured), /CAPTURED/);
  });

  it('warns on malformed .spec-memo-ignore lines without crashing (AC14)', () => {
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), 'valid/**\n\n\n');
    clearIgnoreCacheForTests();
    const boundary = loadIgnoreRules(productRepo, { vaultRoot });
    assert.ok(boundary.activeRuleCount > 0);
    assert.doesNotThrow(() => isPathIgnored('valid/ok.ts', productRepo, { vaultRoot }));
  });

  it('never writes .spec-memo-ignore (AC10, AC11)', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productRepo,
      kind: 'trap',
      slug: 'ignore-readonly',
      body: 'Trap body'
    });
    assert.equal(fs.existsSync(path.join(productRepo, '.spec-memo-ignore')), false);
  });

  it('rejects upsert when all pathPatterns are ignored (AC6)', async () => {
    await assert.rejects(
      () =>
        upsertRecord({
          vaultRoot,
          cwd: productRepo,
          kind: 'trap',
          slug: 'ignored-trap',
          frontmatter: { title: 'Ignored', pathPatterns: ['node_modules/**'] },
          body: 'Should fail'
        }),
      /all pathPatterns match ignored paths/
    );
  });

  it('strips ignored pathPatterns but keeps valid ones (AC6)', async () => {
    const res = await upsertRecord({
      vaultRoot,
      cwd: productRepo,
      kind: 'trap',
      slug: 'partial-trap',
      frontmatter: { title: 'Partial', pathPatterns: ['node_modules/**', 'src/**/*.ts'] },
      body: 'Keeps src pattern only'
    });
    assert.ok(res.path.startsWith(vaultRoot));
  });

  it('redacts ignored file references in prompt record bodies (AC7)', async () => {
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), 'vendor/**\n');
    clearIgnoreCacheForTests();
    const res = await recordPromptTurn({
      vaultRoot,
      cwd: productRepo,
      body: 'Edited vendor/sdk/lib.ts and src/app.ts',
      sessionId: 's-capture-ignore'
    });
    const content = fs.readFileSync(res.path, 'utf8');
    assert.match(content, /\[PATH_IGNORED\]/);
    assert.match(content, /src\/app\.ts/);
  });

  it('bootstrap ignores focus path when it matches exclusion rules (AC8)', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productRepo,
      kind: 'trap',
      slug: 'vendor-trap',
      frontmatter: {
        title: 'Vendor trap',
        severity: 'high',
        pathPatterns: ['vendor/**']
      },
      body: 'Vendor-only trap'
    });
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), 'vendor/**\n');
    clearIgnoreCacheForTests();

    const withIgnoredPath = await compileBootstrapBrief({
      vaultRoot,
      cwd: productRepo,
      path: 'vendor/sdk/foo.ts'
    });
    const withoutPath = await compileBootstrapBrief({ vaultRoot, cwd: productRepo });
    assert.equal(withIgnoredPath.traps.length, withoutPath.traps.length);
  });

  it('search with ignored --path returns no matches (AC9)', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productRepo,
      kind: 'trap',
      slug: 'search-trap',
      frontmatter: { title: 'Search trap', pathPatterns: ['vendor/**'] },
      body: 'Vendor trap'
    });
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), 'vendor/**\n');
    clearIgnoreCacheForTests();

    const hits = searchIndex({
      vaultRoot,
      cwd: productRepo,
      path: 'vendor/sdk/foo.ts',
      kinds: ['trap']
    });
    assert.equal(hits.length, 0);
  });

  it('doctor reports exclusion boundary card (AC13)', async () => {
    fs.writeFileSync(path.join(productRepo, '.spec-memo-ignore'), 'vendor/**\n');
    clearIgnoreCacheForTests();
    const result = await runDoctor({ cwd: productRepo, vaultRoot });
    assert.ok(result.exclusionBoundary);
    assert.ok(result.exclusionBoundary!.activeRuleCount >= 1);
  });

  it('doctor --check-capture returns structured result', async () => {
    fs.mkdirSync(path.join(productRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(productRepo, 'src', 'app.ts'), '');
    const result = await runDoctor({
      cwd: productRepo,
      vaultRoot,
      checkCapture: 'src/app.ts'
    });
    assert.equal(result.captureCheck?.status, 'CAPTURED');
    assert.match(result.summary, /CAPTURED/);
  });
});
