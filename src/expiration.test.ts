import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseDurationMs,
  parseExpiresAt,
  computeExpiresAt,
  validateTtlInput,
  isRecordExpiredAt,
  isRecordActiveAt,
  applySearchExpirationFilter
} from './expiration.js';
import { upsertRecord, getRecord } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { runGc } from './curator.js';
import { executeTool } from './tools.js';

describe('Record TTL expiration', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-ttl-test-'));
    vaultRoot = path.join(tempDir, 'vault');
    productRepo = path.join(tempDir, 'product-repo');
    fs.mkdirSync(productRepo, { recursive: true });
    fs.mkdirSync(path.join(productRepo, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeIndex();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // tolerant
      }
    }
  });

  it('parses duration strings and computes expires_at on upsert', async () => {
    assert.equal(parseDurationMs('7d'), 7 * 86400 * 1000);
    assert.equal(parseDurationMs('48h'), 48 * 3600 * 1000);
    assert.ok(!validateTtlInput('invalid').ok);

    const created = '2026-01-01T00:00:00.000Z';
    const exp = computeExpiresAt(created, '7d');
    assert.ok(exp);
    assert.ok(exp!.startsWith('2026-01-08'));

    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'temp-react-fix',
      frontmatter: { title: 'Temp react fix', ttl: '7d' },
      body: 'Temporary bypass'
    });

    const record = await getRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'temp-react-fix'
    });
    assert.ok(record?.frontmatter.expires_at);
  });

  it('excludes expired records from search by default', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'expired-trap',
      frontmatter: { title: 'Expired trap unique xyz', expires_at: past },
      body: 'Should not appear'
    });

    const hits = searchIndex({
      vaultRoot,
      cwd: productRepo,
      query: 'Expired trap unique xyz'
    });
    assert.equal(hits.length, 0);
  });

  it('includes expired records with includeExpired and badges them', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'expired-badge-trap',
      frontmatter: { title: 'Badge trap unique abc', expires_at: past },
      body: 'Expired content'
    });

    const hits = searchIndex({
      vaultRoot,
      cwd: productRepo,
      query: 'Badge trap unique abc',
      includeExpired: true
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expired, true);
  });

  it('supports as-of time-travel queries', async () => {
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'decision',
      slug: 'auth-choice',
      frontmatter: {
        title: 'Auth decision timetravel',
        created: '2026-08-01T00:00:00.000Z',
        expires_at: '2026-09-01T00:00:00.000Z'
      },
      body: 'Use JWT'
    });

    const active = searchIndex({
      vaultRoot,
      cwd: productRepo,
      query: 'Auth decision timetravel',
      asOf: '2026-08-15'
    });
    assert.equal(active.length, 1);

    const future = searchIndex({
      vaultRoot,
      cwd: productRepo,
      query: 'Auth decision timetravel',
      asOf: '2026-09-15'
    });
    assert.equal(future.length, 0);
  });

  it('omits expired traps from bootstrap brief', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'bootstrap-expired',
      frontmatter: { title: 'Bootstrap expired trap', severity: 'high', expires_at: past },
      body: 'Should not bootstrap'
    });

    const brief = await compileBootstrapBrief({ cwd: productRepo, vaultRoot });
    assert.equal(
      brief.traps.filter((t) => t.frontmatter.slug === 'bootstrap-expired').length,
      0
    );
  });

  it('annotates expired on get by id', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'get-expired',
      frontmatter: { title: 'Get expired', expires_at: past },
      body: 'Still retrievable'
    });

    const record = await getRecord({
      cwd: productRepo,
      vaultRoot,
      id: 'get-expired'
    });
    assert.equal(record?.frontmatter.expired, true);
  });

  it('archives expired traps on gc and purges with --purge', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'gc-trap',
      frontmatter: { title: 'GC trap', expires_at: past },
      body: 'Archive me'
    });

    const gcResult = await runGc({ cwd: productRepo, vaultRoot });
    assert.equal(gcResult.trapsArchivedCount, 1);

    const archived = await getRecord({ cwd: productRepo, vaultRoot, slug: 'gc-trap', kind: 'trap' });
    assert.equal(archived?.frontmatter.status, 'archived');
    assert.equal(archived?.frontmatter.archivedReason, 'expired');

    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'purge-trap',
      frontmatter: { title: 'Purge trap', expires_at: past },
      body: 'Delete me'
    });

    await runGc({ cwd: productRepo, vaultRoot, purge: true });
    const purged = await getRecord({ cwd: productRepo, vaultRoot, slug: 'purge-trap', kind: 'trap' });
    assert.equal(purged, null);
  });

  it('applySearchExpirationFilter respects active window', () => {
    const fm = {
      id: 'x',
      kind: 'decision' as const,
      project: 'p',
      status: 'active' as const,
      created: '2026-08-01T00:00:00.000Z',
      updated: '2026-08-01T00:00:00.000Z',
      source: 'agent' as const,
      expires_at: '2026-09-01T00:00:00.000Z'
    };
    assert.equal(isRecordActiveAt(fm, Date.parse('2026-08-15')), true);
    assert.equal(isRecordActiveAt(fm, Date.parse('2026-09-15')), false);
    assert.equal(
      applySearchExpirationFilter(fm, { asOf: '2026-08-15' }).include,
      true
    );
  });

  it('rejects invalid expires_at on upsert', async () => {
    await assert.rejects(
      () =>
        upsertRecord({
          cwd: productRepo,
          vaultRoot,
          kind: 'trap',
          slug: 'bad-expires',
          frontmatter: { title: 'Bad date', expires_at: 'not-a-date' },
          body: 'Should fail'
        }),
      /Invalid ttl duration or date/
    );
  });

  it('invalid asOf falls back to current-time expiration filtering', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'invalid-asof-trap',
      frontmatter: { title: 'Invalid asOf trap unique', expires_at: past },
      body: 'Hidden on bad asOf'
    });

    const hits = searchIndex({
      vaultRoot,
      cwd: productRepo,
      query: 'Invalid asOf trap unique',
      asOf: 'not-a-date'
    });
    assert.equal(hits.length, 0);
  });

  it('MCP search tool accepts includeExpired and asOf', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await upsertRecord({
      cwd: productRepo,
      vaultRoot,
      kind: 'trap',
      slug: 'mcp-expired',
      frontmatter: { title: 'MCP expired tool test', expires_at: past },
      body: 'tool path'
    });

    const res = await executeTool('search', {
      cwd: productRepo,
      vaultRoot,
      query: 'MCP expired tool test',
      includeExpired: true
    });
    assert.equal(res.isError, undefined);
    const data = (res as { data: Array<{ expired?: boolean }> }).data;
    assert.equal(data.length, 1);
    assert.equal(data[0].expired, true);
  });
});
