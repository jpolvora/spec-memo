import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { closeIndex } from './indexer.js';
import { upsertRecord } from './store.js';
import { ensureProjectVault, ensureVaultStructure } from './vault.js';
import { occurrenceOf, hitCountOf } from './recurrence.js';
import { parseRecord } from './schema.js';
import {
  collectWikiSources,
  loadWikiTemplate,
  readWikiFile,
  regenerateWiki,
  renderWikiMarkdown,
  WIKI_AUTO_MARKER
} from './wiki.js';

function listRel(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('project wiki', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productDir: string;
  const projectId = 'wiki-test-proj';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-wiki-'));
    vaultRoot = path.join(tempDir, 'vault');
    productDir = path.join(tempDir, 'product');
    fs.mkdirSync(productDir, { recursive: true });
    fs.writeFileSync(path.join(productDir, 'README.md'), '# Product\n', 'utf8');
    ensureVaultStructure(vaultRoot);
    ensureProjectVault(
      {
        projectId,
        normalizedRemote: null,
        rootPath: productDir,
        isGit: false,
        isFallback: true,
        vaultProjectPath: path.join(vaultRoot, 'projects', projectId)
      },
      vaultRoot
    );
  });

  afterEach(() => {
    closeIndex(vaultRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('shipped template.md exists and lists required section headings in order', () => {
    const srcTemplate = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wiki', 'template.md');
    const packaged = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wiki', 'template.md');
    const raw = fs.existsSync(packaged)
      ? fs.readFileSync(packaged, 'utf8')
      : fs.readFileSync(srcTemplate, 'utf8');
    const headings = [...raw.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, [
      'Overview',
      'Architecture & decisions',
      'Active traps',
      'Specs & plans',
      'Sessions',
      'Structured links'
    ]);
    const loaded = loadWikiTemplate();
    assert.ok(loaded.includes('{{projectTitle}}'));
    assert.ok(loaded.includes('{{structuredLinks}}'));
  });

  it('regenerateWiki writes UTF-8 WIKI.md under projects/{id} and does not touch consumer cwd', async () => {
    const beforeProduct = listRel(productDir);
    const result = await regenerateWiki({ projectId, vaultRoot });
    assert.equal(result.ok, true);
    const wikiPath = path.join(vaultRoot, 'projects', projectId, 'WIKI.md');
    assert.ok(fs.existsSync(wikiPath));
    const body = fs.readFileSync(wikiPath, 'utf8');
    assert.ok(body.includes('# '));
    assert.equal(listRel(productDir).join('\n'), beforeProduct.join('\n'));
    assert.equal(fs.readFileSync(path.join(productDir, 'README.md'), 'utf8'), '# Product\n');
    assert.ok(!fs.existsSync(path.join(productDir, 'WIKI.md')));
  });

  it('renderWikiMarkdown replaces every placeholder; persisted file has no raw {{', async () => {
    await regenerateWiki({ projectId, vaultRoot });
    const body = fs.readFileSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md'), 'utf8');
    assert.equal(body.includes('{{'), false);
    const sources = collectWikiSources(projectId, vaultRoot);
    const rendered = renderWikiMarkdown(sources, loadWikiTemplate(), '2026-09-04T00:00:00.000Z');
    assert.equal(rendered.includes('{{'), false);
  });

  it('structured links use ./traps ./decisions ./specs ./plans ./INDEX.md ./TRAPS.md ./DECISIONS.md', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'trap',
      slug: 'wiki-link-trap',
      frontmatter: { title: 'Link trap', status: 'active' },
      body: 'trap body'
    });
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'decision',
      slug: 'wiki-link-adr',
      frontmatter: { title: 'Link adr', status: 'active' },
      body: 'adr body'
    });
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'spec',
      slug: 'wiki-link-spec',
      frontmatter: { title: 'Link spec', status: 'active' },
      body: 'spec body'
    });
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'plan',
      slug: 'wiki-link-plan',
      frontmatter: { title: 'Link plan', status: 'active' },
      body: 'plan body'
    });
    await regenerateWiki({ projectId, vaultRoot });
    const body = fs.readFileSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md'), 'utf8');
    assert.ok(body.includes('./traps/'));
    assert.ok(body.includes('./decisions/'));
    assert.ok(body.includes('./specs/'));
    assert.ok(body.includes('./plans/'));
    assert.ok(body.includes('./INDEX.md'));
    assert.ok(body.includes('./TRAPS.md'));
    assert.ok(body.includes('./DECISIONS.md'));
  });

  it('regenerate with wiki.aiEnabled unset/false persists complete page aiPolished:false', async () => {
    const result = await regenerateWiki({ projectId, vaultRoot });
    assert.equal(result.aiPolished, false);
    const body = fs.readFileSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md'), 'utf8');
    assert.ok(body.includes('## Overview'));
    assert.ok(body.includes('## Structured links'));
    assert.equal(body.includes('{{'), false);
  });

  it('polish throw/timeout still persists deterministic page ok:true aiPolished:false aiError sanitized', async () => {
    const cfgPath = path.join(vaultRoot, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.wiki = { aiEnabled: true, timeoutMs: 50 };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    const result = await regenerateWiki({
      projectId,
      vaultRoot,
      polishWikiMarkdown: async () => {
        throw new Error('C:\\\\Users\\\\secret\\\\vault exploded');
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.aiPolished, false);
    assert.ok(result.aiError);
    assert.ok(!result.aiError.includes('C:\\\\Users'));
    const wikiPath = path.join(vaultRoot, 'projects', projectId, 'WIKI.md');
    assert.ok(fs.existsSync(wikiPath));
    const body = fs.readFileSync(wikiPath, 'utf8');
    assert.ok(body.includes(WIKI_AUTO_MARKER));
    assert.equal(body.includes('{{'), false);
  });

  it('unit: polishWikiMarkdown throw still writes WIKI.md and aiPolished false', async () => {
    const cfgPath = path.join(vaultRoot, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.wiki = { aiEnabled: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    const result = await regenerateWiki({
      projectId,
      vaultRoot,
      polishWikiMarkdown: () => {
        throw new Error('provider down');
      }
    });
    assert.equal(result.aiPolished, false);
    assert.ok(fs.existsSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md')));
  });

  it('collect/regenerate does not increment hits or occurrences on sample trap', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'trap',
      slug: 'wiki-hit-trap',
      frontmatter: { title: 'Hit trap', status: 'active', hits: 3, occurrences: 2 },
      body: 'hit body'
    });
    const trapPath = path.join(vaultRoot, 'projects', projectId, 'traps', 'wiki-hit-trap.md');
    const before = parseRecord(fs.readFileSync(trapPath, 'utf8'), trapPath);
    const hitsBefore = hitCountOf(before.frontmatter);
    const occBefore = occurrenceOf(before.frontmatter);
    collectWikiSources(projectId, vaultRoot);
    await regenerateWiki({ projectId, vaultRoot });
    const after = parseRecord(fs.readFileSync(trapPath, 'utf8'), trapPath);
    assert.equal(hitCountOf(after.frontmatter), hitsBefore);
    assert.equal(occurrenceOf(after.frontmatter), occBefore);
  });

  it('collector skips *.conflict.* markdown sidecars', async () => {
    await upsertRecord({
      vaultRoot,
      cwd: productDir,
      projectId,
      kind: 'trap',
      slug: 'wiki-real-trap',
      frontmatter: { title: 'Real trap', status: 'active' },
      body: 'real'
    });
    const sidecar = path.join(vaultRoot, 'projects', projectId, 'traps', 'wiki-conflict.conflict.123.md');
    fs.writeFileSync(
      sidecar,
      `---
id: wiki-conflict-sidecar
kind: trap
status: active
title: Conflict sidecar
---

should not appear
`,
      'utf8'
    );
    const sources = collectWikiSources(projectId, vaultRoot);
    assert.ok(sources.trapsActive.some((r) => r.frontmatter.id === 'wiki-real-trap'));
    assert.equal(sources.trapsActive.some((r) => r.frontmatter.id === 'wiki-conflict-sidecar'), false);
    await regenerateWiki({ projectId, vaultRoot });
    const body = fs.readFileSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md'), 'utf8');
    assert.equal(body.includes('wiki-conflict-sidecar'), false);
  });

  it('readWiki GET helper on pristine empty vaultRoot does not create config.json/projects/telemetry', () => {
    const emptyRoot = path.join(tempDir, 'empty-vault');
    fs.mkdirSync(emptyRoot, { recursive: true });
    const before = listRel(emptyRoot);
    assert.throws(() => readWikiFile('any-proj', emptyRoot), /Not found|projectId/i);
    assert.deepEqual(listRel(emptyRoot), before);
    assert.ok(!fs.existsSync(path.join(emptyRoot, 'config.json')));
    assert.ok(!fs.existsSync(path.join(emptyRoot, 'projects')));
    assert.ok(!fs.existsSync(path.join(emptyRoot, 'telemetry')));
  });

  it('WIKI.md contains AUTO-GENERATED marker and lastGenerated ISO', async () => {
    const result = await regenerateWiki({ projectId, vaultRoot, now: new Date('2026-09-04T18:00:00.000Z') });
    const body = fs.readFileSync(path.join(vaultRoot, 'projects', projectId, 'WIKI.md'), 'utf8');
    assert.ok(body.includes(WIKI_AUTO_MARKER));
    assert.ok(body.includes('*Last generated:'));
    assert.match(body, /\*Last generated:\s*2026-09-04T18:00:00\.000Z\*/);
    assert.equal(result.lastGenerated, '2026-09-04T18:00:00.000Z');
  });
});
