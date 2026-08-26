import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateFrontmatter } from './schema.js';
import { upsertRecord, getRecord, backfillTrapRecurrence } from './store.js';
import { searchIndex, closeIndex } from './indexer.js';
import { executeTool } from './tools.js';
import { promoteRecord } from './promote.js';
import { runCli } from './cli.js';
import { TOOL_NAMES } from './types.js';
import { ensureVaultStructure, initVaultGit } from './vault.js';
import { execFileSync } from 'node:child_process';
import { rankActiveTraps } from './recurrence.js';

const TRAP_BODY = `### Repeat trap
- **Layer**: Application
- **Module**: Expedicoes / Conferencia
- **DO NOT**: Skip the snapshot when mapping pedido lines.
- **INSTEAD DO**: Copy qty onto the conferencia snapshot in the same UoW.
`;

function baseFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trap-schema-ok',
    kind: 'trap' as const,
    project: 'proj-1',
    status: 'active' as const,
    created: '2026-08-25T12:00:00.000Z',
    updated: '2026-08-25T12:00:00.000Z',
    source: 'agent' as const,
    ...overrides
  };
}

describe('Trap recurrence ranking', () => {
  let tempVault: string;
  let tempProject: string;

  beforeEach(() => {
    tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-rank-vault-'));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-rank-proj-'));
    fs.mkdirSync(path.join(tempProject, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeIndex(tempVault);
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it('accepts closed layer enum and occurrences >= 1', () => {
    const result = validateFrontmatter(
      baseFrontmatter({ layer: 'application', module: 'Expedicoes', occurrences: 3, lastSeen: '2026-08-25T12:00:00.000Z' })
    );
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.layer, 'application');
      assert.equal(result.data.occurrences, 3);
    }
  });

  it('fails schema validation for unknown layer and non-positive occurrences', () => {
    const badLayer = validateFrontmatter(baseFrontmatter({ layer: 'frontend' }));
    assert.equal(badLayer.success, false);

    const zero = validateFrontmatter(baseFrontmatter({ occurrences: 0 }));
    assert.equal(zero.success, false);

    const negative = validateFrontmatter(baseFrontmatter({ occurrences: -2 }));
    assert.equal(negative.success, false);
  });

  it('fills layer and module from trap body and defaults occurrences to 1', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'body-layer',
      frontmatter: { id: 'trap-body-layer', title: 'Body layer trap', pathPatterns: ['src/**/*.cs'] },
      body: TRAP_BODY
    });

    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: res.id });
    assert.ok(record);
    assert.equal(record.frontmatter.layer, 'application');
    assert.equal(record.frontmatter.module, 'Expedicoes / Conferencia');
    assert.equal(record.frontmatter.occurrences, 1);
    assert.equal(record.frontmatter.lastSeen, record.frontmatter.created);
  });

  it('maps layer aliases and stores security as a tag', async () => {
    const front = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'front-alias',
      frontmatter: {
        id: 'trap-front-alias',
        title: 'Front alias',
        layer: 'front',
        pathPatterns: ['angular/**/*.ts']
      },
      body: '- **Layer**: Web\n- **Module**: Angular\n- **DO NOT**: Drop catchError.'
    });
    const frontRec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: front.id });
    assert.equal(frontRec?.frontmatter.layer, 'web');

    const sec = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'security-tag',
      frontmatter: {
        id: 'trap-security-tag',
        title: 'Security tag',
        layer: 'segurança',
        pathPatterns: ['src/auth/**']
      },
      body: '- **Layer**: Infrastructure\n- **Module**: Auth\n- **DO NOT**: Log tokens.'
    });
    const secRec = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: sec.id });
    assert.equal(secRec?.frontmatter.layer, 'infrastructure');
    assert.ok(Array.isArray(secRec?.frontmatter.tags));
    assert.ok(secRec?.frontmatter.tags?.includes('security'));
  });

  it('does not increment occurrences when updating the same trap id', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'same-id',
      frontmatter: { id: 'trap-same-id', title: 'Same id', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'same-id',
      frontmatter: { id: 'trap-same-id', title: 'Same id edited', pathPatterns: ['src/**'] },
      body: TRAP_BODY + '\nEdited note.'
    });
    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-same-id' });
    assert.equal(record?.frontmatter.occurrences, 1);
    assert.ok(record?.body.includes('Edited note.'));
  });

  it('bumps occurrences in place on trap-dedup match and does not write a second file', async () => {
    const first = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-raw-sql',
      frontmatter: {
        id: 'trap-no-raw-sql',
        title: 'Prevent Raw SQL Queries',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL strings in database handlers.\n\n## INSTEAD DO\nUse parameterized queries.'
    });
    const before = new Date().toISOString();
    const second = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'no-raw-sql-v2',
      frontmatter: {
        id: 'trap-no-raw-sql-v2',
        title: 'Prevent Raw SQL Queries Updated',
        pathPatterns: ['src/db/*.ts']
      },
      body: '## DO NOT\nNever execute raw unescaped SQL query strings directly.\n\n## INSTEAD DO\nUse parameterized query builders.'
    });

    assert.equal(second.id, first.id);
    assert.equal(second.recurrence, true);
    assert.equal(fs.existsSync(path.join(path.dirname(first.path), 'no-raw-sql-v2.md')), false);

    const surviving = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-no-raw-sql' });
    assert.ok(surviving);
    assert.equal(surviving.frontmatter.status, 'active');
    assert.equal(surviving.frontmatter.occurrences, 2);
    assert.ok(String(surviving.frontmatter.lastSeen) >= before);
  });

  it('copies occurrences plus one onto an explicit superseding trap', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'old-rule',
      frontmatter: {
        id: 'trap-old-rule',
        title: 'Old rule',
        pathPatterns: ['src/a.ts'],
        occurrences: 4
      },
      body: TRAP_BODY
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'new-rule',
      frontmatter: {
        id: 'trap-new-rule',
        title: 'New rule',
        pathPatterns: ['src/a.ts'],
        supersedes: 'trap-old-rule'
      },
      body: TRAP_BODY + '\nEvolved INSTEAD DO with a domain method.'
    });
    const newer = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-new-rule' });
    const older = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-old-rule' });
    assert.equal(newer?.frontmatter.occurrences, 5);
    assert.equal(older?.frontmatter.status, 'superseded');
  });

  it('sorts search hits by occurrences then lastSeen then severity', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'crit-same-count',
      frontmatter: {
        id: 'trap-crit-same-count',
        title: 'Crit same count',
        severity: 'critical',
        occurrences: 5,
        lastSeen: '2026-08-20T00:00:00.000Z',
        pathPatterns: ['src/c.ts']
      },
      body: TRAP_BODY,
      allowDuplicate: true
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'high-hot',
      frontmatter: {
        id: 'trap-high-hot',
        title: 'Hot high',
        severity: 'high',
        occurrences: 5,
        lastSeen: '2026-08-01T00:00:00.000Z',
        pathPatterns: ['src/b.ts']
      },
      body: TRAP_BODY,
      allowDuplicate: true
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'low-rare',
      frontmatter: {
        id: 'trap-low-rare',
        title: 'Rare low',
        severity: 'low',
        occurrences: 1,
        lastSeen: '2026-01-01T00:00:00.000Z',
        pathPatterns: ['src/a.ts']
      },
      body: TRAP_BODY,
      allowDuplicate: true
    });

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      kinds: ['trap'],
      status: 'active',
      sort: 'occurrences'
    });
    assert.equal(hits[0].id, 'trap-crit-same-count');
    assert.equal(hits[1].id, 'trap-high-hot');
    assert.equal(hits[2].id, 'trap-low-rare');
  });

  it('treats missing occurrences as 1 when ranking', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'legacy-missing',
      frontmatter: { id: 'trap-legacy-missing', title: 'Legacy', pathPatterns: ['src/x.ts'] },
      body: TRAP_BODY
    });
    const raw = fs.readFileSync(res.path, 'utf8').replace(/\noccurrences: 1\r?\n/, '\n');
    fs.writeFileSync(res.path, raw, 'utf8');

    const hits = searchIndex({
      cwd: tempProject,
      vaultRoot: tempVault,
      kinds: ['trap'],
      status: 'active',
      sort: 'occurrences'
    });
    const hit = hits.find((h) => h.id === 'trap-legacy-missing');
    assert.ok(hit);
    assert.equal(hit.occurrences, 1);
  });

  it('rejects invalid search sort values', async () => {
    const res = await executeTool('search', { sort: 'popularity', vaultRoot: tempVault, cwd: tempProject });
    assert.equal(res.isError, true);
    if (res.isError) {
      assert.equal(res.code, 'INVALID_ARGUMENTS');
    }
  });

  it('includes layer and occurrences on compiled TRAPS.md headings', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'compiled-heading',
      frontmatter: {
        id: 'trap-compiled-heading',
        title: 'Compiled heading',
        layer: 'domain',
        occurrences: 3,
        pathPatterns: ['src/domain/**']
      },
      body: TRAP_BODY
    });
    const projectDirs = fs.readdirSync(path.join(tempVault, 'projects'));
    const trapsMd = fs.readFileSync(path.join(tempVault, 'projects', projectDirs[0], 'TRAPS.md'), 'utf8');
    assert.ok(/layer/i.test(trapsMd));
    assert.ok(/occurrences/i.test(trapsMd));
    assert.ok(trapsMd.includes('domain'));
    assert.ok(trapsMd.includes('3'));
  });

  it('promotes ranked traps as a grouped skill file', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'web-rx',
      frontmatter: {
        id: 'trap-web-rx',
        title: 'switchMap without catchError',
        layer: 'web',
        occurrences: 6,
        pathPatterns: ['angular/**/*.ts']
      },
      body: '- **DO NOT**: Omit catchError inside switchMap.\n- **INSTEAD DO**: Return EMPTY from catchError.',
      allowDuplicate: true
    });
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'app-snap',
      frontmatter: {
        id: 'trap-app-snap',
        title: 'Conferencia snapshot',
        layer: 'application',
        occurrences: 2,
        pathPatterns: ['src/app/**']
      },
      body: TRAP_BODY,
      allowDuplicate: true
    });

    const ranked = await promoteRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      destination: '.agents/skills/ws-recurrence/SKILL.md',
      format: 'skill',
      limit: 10
    });
    assert.equal(ranked.format, 'skill');
    const content = fs.readFileSync(ranked.targetPath, 'utf8');
    assert.ok(content.includes('## web'));
    assert.ok(content.includes('## application'));
    assert.ok(content.includes('switchMap without catchError'));
    assert.ok(content.includes('occurrences'));
    assert.ok(content.includes('DO NOT'));
    assert.ok(content.includes('INSTEAD DO'));

    const single = await promoteRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      id: 'trap-web-rx',
      destination: '.agents/skills/ws-recurrence/one.md',
      format: 'skill'
    });
    const one = fs.readFileSync(single.targetPath, 'utf8');
    assert.ok(one.includes('switchMap without catchError'));
    assert.equal(one.includes('Conferencia snapshot'), false);
  });

  it('keeps promote default-deny for skill export', async () => {
    await assert.rejects(
      () =>
        promoteRecord({
          cwd: tempProject,
          vaultRoot: tempVault,
          format: 'skill',
          destination: ''
        }),
      /required/i
    );
    await assert.rejects(
      () =>
        promoteRecord({
          cwd: tempProject,
          vaultRoot: tempVault,
          format: 'skill',
          destination: path.join(tempVault, 'leak.md')
        }),
      /Default Deny/
    );
    await assert.rejects(
      () =>
        promoteRecord({
          cwd: tempProject,
          vaultRoot: tempVault,
          format: 'skill',
          destination: '.git/hooks/SKILL.md'
        }),
      /\.git/
    );
  });

  it('lists ranked traps via memo rank without adding a ninth MCP tool', async () => {
    assert.equal(TOOL_NAMES.length, 8);
    assert.equal(TOOL_NAMES.includes('rank' as (typeof TOOL_NAMES)[number]), false);

    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'cli-rank',
      frontmatter: {
        id: 'trap-cli-rank',
        title: 'CLI rank trap',
        layer: 'tests',
        occurrences: 4,
        pathPatterns: ['test/**']
      },
      body: TRAP_BODY
    });

    let captured = '';
    const origLog = console.log;
    console.log = (...args) => {
      captured += args.join(' ') + '\n';
    };
    try {
      const code = await runCli([
        'rank',
        '--cwd',
        tempProject,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(captured.trim());
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.some((h: { id: string }) => h.id === 'trap-cli-rank'));
    } finally {
      console.log = origLog;
    }
  });

  it('backfills layer module occurrences and lastSeen without changing bodies', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'needs-backfill',
      frontmatter: { id: 'trap-needs-backfill', title: 'Needs backfill', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    const stripped = fs
      .readFileSync(res.path, 'utf8')
      .replace(/\nlayer: .+\r?\n/, '\n')
      .replace(/\nmodule: .+\r?\n/, '\n')
      .replace(/\noccurrences: .+\r?\n/, '\n')
      .replace(/\nlastSeen: .+\r?\n/, '\n');
    fs.writeFileSync(res.path, stripped, 'utf8');
    const bodyBefore = stripped.split('---').slice(2).join('---').trim();

    let captured = '';
    const origLog = console.log;
    console.log = (...args) => {
      captured += args.join(' ') + '\n';
    };
    try {
      const code = await runCli([
        'rank',
        '--backfill',
        '--cwd',
        tempProject,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(code, 0);
    } finally {
      console.log = origLog;
    }

    const after = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-needs-backfill' });
    assert.equal(after?.frontmatter.layer, 'application');
    assert.equal(after?.frontmatter.module, 'Expedicoes / Conferencia');
    assert.equal(after?.frontmatter.occurrences, 1);
    assert.ok(after?.frontmatter.lastSeen);
    assert.equal(after?.body.trim(), bodyBefore);
    void captured;
  });

  it('acquires vault lock and commits backfill when vaultGit is enabled', async () => {
    const res = await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'needs-git-backfill',
      frontmatter: { id: 'trap-needs-git-backfill', title: 'Needs git backfill', pathPatterns: ['src/**'] },
      body: TRAP_BODY
    });
    ensureVaultStructure(tempVault);
    const configPath = path.join(tempVault, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.vaultGit = { enabled: true };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    assert.equal(initVaultGit(tempVault), true);

    const stripped = fs
      .readFileSync(res.path, 'utf8')
      .replace(/\nlayer: .+\r?\n/, '\n')
      .replace(/\nmodule: .+\r?\n/, '\n')
      .replace(/\noccurrences: .+\r?\n/, '\n')
      .replace(/\nlastSeen: .+\r?\n/, '\n');
    fs.writeFileSync(res.path, stripped, 'utf8');

    const result = backfillTrapRecurrence({ cwd: tempProject, vaultRoot: tempVault });
    assert.ok(result.updated >= 1);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: tempVault, encoding: 'utf8' });
    assert.match(log, /backfill trap recurrence/);
    assert.equal(fs.existsSync(path.join(tempVault, '.memo.lock')), false);
  });

  it('rank --layer frontend matches traps stored as web', async () => {
    await upsertRecord({
      cwd: tempProject,
      vaultRoot: tempVault,
      kind: 'trap',
      slug: 'web-layer-trap',
      frontmatter: { id: 'trap-web-layer', title: 'Web layer trap', pathPatterns: ['src/**'] },
      body: `### Repeat trap
- **Layer**: Frontend
- **Module**: UI
- **DO NOT**: Skip the snapshot.
- **INSTEAD DO**: Keep the snapshot in the same UoW.
`
    });

    const record = await getRecord({ cwd: tempProject, vaultRoot: tempVault, id: 'trap-web-layer' });
    assert.equal(record?.frontmatter.layer, 'web');
    const ranked = rankActiveTraps([record!], { layer: 'frontend' });
    assert.equal(ranked.length, 1);

    let captured = '';
    const origLog = console.log;
    console.log = (...args) => {
      captured += args.join(' ') + '\n';
    };
    try {
      const code = await runCli([
        'rank',
        '--layer',
        'frontend',
        '--cwd',
        tempProject,
        '--vaultRoot',
        tempVault,
        '--json'
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(captured.trim());
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.some((h: { id: string }) => h.id === 'trap-web-layer'));
    } finally {
      console.log = origLog;
    }
  });
});
