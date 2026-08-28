import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  recordPromptTurn,
  startSessionRecord,
  endSessionRecord,
  getSessionTurns,
  exportSessionStory,
  listPrompts,
  searchPrompts,
  listSessions,
  deriveRulesFromPrompts,
  generateActivityReport
} from './prompt.js';
import { extractRulesFromPrompts, formatDerivedRulesForExport } from './rules-engine.js';
import { executeTool } from './tools.js';
import { ensureProjectVault, getVaultRoot } from './vault.js';
import { closeIndex } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';
import { createActivityBus } from './activity.js';
import { startStatusServer } from './status.js';
import { forgetRecord } from './store.js';

function createTempVault(): { vaultRoot: string; projectId: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-prompt-test-'));
  const projectId = 'test-proj-' + Date.now();
  const identity = {
    projectId,
    rootPath: tmpDir,
    vaultProjectPath: path.join(tmpDir, 'projects', projectId),
    normalizedRemote: null,
    isGit: false,
    isFallback: true
  };
  ensureProjectVault(identity, tmpDir);

  return {
    vaultRoot: tmpDir,
    projectId,
    cleanup: () => {
      try {
        closeIndex();
      } catch {}
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('Prompt Service - Ingest prompt turns with multi-dimensional metadata & secret redaction', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    const turn1 = await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'session-alpha',
      turn: 1,
      body: 'Please implement OAuth2 token refresh. Secret key is sk_live_1234567890abcdef.',
      ide: 'cursor',
      model: 'claude-3-7-sonnet',
      agent: 'coder',
      taskSlug: 'feature-auth-refresh',
      client: 'acme-corp',
      billable: true,
      branch: 'develop',
      gitSha: '1234567890abcdef'
    });

    assert.ok(turn1.id.startsWith('prompt-session-alpha-t1'));
    assert.strictEqual(turn1.turn, 1);
    assert.strictEqual(turn1.sessionId, 'session-alpha');
    assert.ok(fs.existsSync(turn1.path));

    // Verify secret was redacted in the saved file
    const content = fs.readFileSync(turn1.path, 'utf8');
    assert.ok(!content.includes('sk_live_1234567890abcdef'));
    assert.ok(content.includes('[REDACTED'));

    // Record turn 2 (auto turn increment when omitted)
    const turn2 = await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'session-alpha',
      body: 'Always use exponential backoff on 429 status codes. Never retry 401 without fresh credentials.',
      ide: 'cursor',
      model: 'claude-3-7-sonnet',
      agent: 'coder',
      taskSlug: 'feature-auth-refresh',
      client: 'acme-corp'
    });

    assert.strictEqual(turn2.turn, 2);

    // List session turns in order
    const turns = getSessionTurns({ vaultRoot, projectId, sessionId: 'session-alpha' });
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].frontmatter.turn, 1);
    assert.strictEqual(turns[1].frontmatter.turn, 2);
  } finally {
    cleanup();
  }
});

test('Session Lifecycle & Story Export', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    // Start session
    const start = await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-story-1',
      taskSlug: 'feature-payments',
      client: 'globex',
      billable: true,
      branch: 'feature/stripe',
      body: 'Implementing Stripe webhook handler'
    });

    assert.strictEqual(start.sessionId, 'sess-story-1');

    // Add prompt turns
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-story-1',
      turn: 1,
      body: 'Connect Stripe webhook handler with signature verification.',
      taskSlug: 'feature-payments',
      client: 'globex'
    });

    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-story-1',
      turn: 2,
      body: 'Write unit tests covering expired webhook signing secret.',
      taskSlug: 'feature-payments',
      client: 'globex'
    });

    // End session with deliverables
    const end = await endSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-story-1',
      body: 'Delivered Stripe webhook verification with 100% test coverage.',
      deliverables: [
        { type: 'pr', url: 'https://github.com/org/repo/pull/101', title: 'feat(payments): stripe webhooks' },
        { type: 'commit', sha: 'c0ffee123456', title: 'feat: add stripe webhook verification' }
      ]
    });

    assert.strictEqual(end.status, 'completed');
    assert.strictEqual(end.deliverables?.length, 2);
    assert.ok(end.durationMinutes != null && end.durationMinutes >= 0);

    // Export Session Story
    const exportFile = path.join(vaultRoot, 'story-export.md');
    const story = await exportSessionStory({
      vaultRoot,
      projectId,
      sessionId: 'sess-story-1',
      outputPath: exportFile
    });

    assert.strictEqual(story.turnsCount, 2);
    assert.ok(story.markdown.includes('sess-story-1'));
    assert.ok(story.markdown.includes('Connect Stripe webhook handler'));
    assert.ok(story.markdown.includes('https://github.com/org/repo/pull/101'));
    assert.ok(fs.existsSync(exportFile));
  } finally {
    cleanup();
  }
});

test('Prompt Query, Multi-dimensional Filtering & Pagination', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    for (let i = 1; i <= 5; i++) {
      await recordPromptTurn({
        vaultRoot,
        projectId,
        sessionId: `sess-batch-${i % 2 === 0 ? 'even' : 'odd'}`,
        turn: i,
        body: `Ingested task prompt number ${i} for component ${i % 2 === 0 ? 'backend' : 'frontend'}.`,
        ide: i % 2 === 0 ? 'cursor' : 'vscode',
        model: i % 2 === 0 ? 'claude-3-7-sonnet' : 'gpt-4o',
        client: i % 2 === 0 ? 'acme' : 'initech',
        taskSlug: `slice-${i}`
      });
    }

    // List all
    const all = listPrompts({ vaultRoot, projectId, limit: 10 });
    assert.strictEqual(all.total, 5);
    assert.strictEqual(all.items.length, 5);

    // Filter by IDE
    const cursorHits = listPrompts({ vaultRoot, projectId, ide: 'cursor' });
    assert.strictEqual(cursorHits.total, 2);

    // Filter by Client
    const initechHits = listPrompts({ vaultRoot, projectId, client: 'initech' });
    assert.strictEqual(initechHits.total, 3);

    // Pagination
    const page1 = listPrompts({ vaultRoot, projectId, limit: 2, offset: 0 });
    assert.strictEqual(page1.items.length, 2);
    assert.strictEqual(page1.hasMore, true);

    const page3 = listPrompts({ vaultRoot, projectId, limit: 2, offset: 4 });
    assert.strictEqual(page3.items.length, 1);
    assert.strictEqual(page3.hasMore, false);
  } finally {
    cleanup();
  }
});

test('AI Rule & Trap Derivation Engine', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-rules',
      turn: 1,
      body: 'Always use parameterized SQL queries with SQLite. Never interpolate raw user input.'
    });

    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-rules',
      turn: 2,
      body: 'Every time you touch schema migrations, you must run vacuum and rebuild the FTS index.'
    });

    const result = await deriveRulesFromPrompts({
      vaultRoot,
      projectId,
      sessionId: 'sess-rules',
      saveTraps: true
    });

    assert.ok(result.rules.length >= 2);
    assert.ok(result.savedTraps && result.savedTraps.length >= 1);

    // Verify rules were formatted properly
    const cursorRules = formatDerivedRulesForExport(result.rules, 'cursor');
    assert.ok(cursorRules.includes('Derived Project Rules'));

    const copilotRules = formatDerivedRulesForExport(result.rules, 'copilot');
    assert.ok(copilotRules.includes('# GitHub Copilot Instructions'));
  } finally {
    cleanup();
  }
});

test('Activity & Invoicing Reporting', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-act-1',
      taskSlug: 'feat-1',
      client: 'client-x',
      billable: true
    });

    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-act-1',
      turn: 1,
      body: 'Turn 1 of session 1',
      client: 'client-x',
      billable: true
    });

    await endSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-act-1',
      body: 'Completed session 1',
      deliverables: [{ type: 'pr', url: 'https://github.com/pr/1', title: 'PR 1' }]
    });

    const report = generateActivityReport({
      vaultRoot,
      projectId
    });

    assert.strictEqual(report.totalSessions, 1);
    assert.strictEqual(report.totalPrompts, 1);
    assert.ok(report.byClient['client-x'] != null);
    assert.strictEqual(report.byClient['client-x'].sessionCount, 1);
  } finally {
    cleanup();
  }
});

test('11th MCP Tool (prompt) Execution & Actions', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    // Record action via executeTool
    const recRes = await executeTool('prompt', {
      action: 'record',
      vaultRoot,
      projectId,
      sessionId: 'tool-sess-1',
      turn: 1,
      taskSlug: 'slice-mcp-tool',
      body: 'Testing 11th tool execution over MCP interface.'
    });

    assert.strictEqual(recRes.isError, undefined);
    assert.ok((recRes.data as any).id.startsWith('prompt-tool-sess-1-t1'));

    // Session Start action
    const startRes = await executeTool('prompt', {
      action: 'session_start',
      vaultRoot,
      projectId,
      sessionId: 'tool-sess-1',
      taskSlug: 'slice-mcp-tool'
    });
    assert.strictEqual(startRes.isError, undefined);

    // List action
    const listRes = await executeTool('prompt', {
      action: 'list',
      vaultRoot,
      projectId
    });
    assert.strictEqual(listRes.isError, undefined);
    assert.strictEqual((listRes.data as any).total, 1);

    // Session End action
    const endRes = await executeTool('prompt', {
      action: 'session_end',
      vaultRoot,
      projectId,
      sessionId: 'tool-sess-1',
      body: 'Delivered MCP tool testing'
    });
    assert.strictEqual(endRes.isError, undefined);
    assert.strictEqual((endRes.data as any).status, 'completed');

    // Activity report action
    const actRes = await executeTool('prompt', {
      action: 'activity_report',
      vaultRoot,
      projectId
    });
    assert.strictEqual(actRes.isError, undefined);
    assert.strictEqual((actRes.data as any).totalSessions, 1);
  } finally {
    cleanup();
  }
});

test('Status Monitor REST Endpoints for Prompts & Activity', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  let statusInstance: any = null;
  const savedAuth = process.env.SPEC_MEMO_AUTH_TOKEN;
  const savedSse = process.env.SPEC_MEMO_SSE_TOKEN;
  const savedStatus = process.env.SPEC_MEMO_STATUS_TOKEN;
  delete process.env.SPEC_MEMO_AUTH_TOKEN;
  delete process.env.SPEC_MEMO_SSE_TOKEN;
  delete process.env.SPEC_MEMO_STATUS_TOKEN;

  try {
    // Seed prompt and session
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-rest-1',
      turn: 1,
      body: 'Always sanitize inputs in REST endpoints.',
      ide: 'vscode',
      client: 'acme'
    });

    await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-rest-1',
      taskSlug: 'slice-rest',
      client: 'acme'
    });

    const bus = createActivityBus();
    statusInstance = await startStatusServer({
      port: 0,
      host: '127.0.0.1',
      vaultRoot,
      activityBus: bus
    });

    const baseUrl = statusInstance.url;

    // 1. GET /api/prompts
    const promptsRes = await fetch(`${baseUrl}/api/prompts?project=${projectId}`);
    assert.strictEqual(promptsRes.status, 200);
    const promptsData = (await promptsRes.json()) as any;
    assert.strictEqual(promptsData.total, 1);
    assert.strictEqual(promptsData.items[0].frontmatter.sessionId, 'sess-rest-1');
    assert.strictEqual(promptsData.items[0].path, undefined);
    assert.ok(!JSON.stringify(promptsData).includes(vaultRoot.replace(/\\/g, '\\\\')));

    // 2. GET /api/prompts/sessions/:sessionId
    const sessionRes = await fetch(`${baseUrl}/api/prompts/sessions/sess-rest-1?project=${projectId}`);
    assert.strictEqual(sessionRes.status, 200);
    const sessionData = (await sessionRes.json()) as any;
    assert.strictEqual(sessionData.sessionId, 'sess-rest-1');
    assert.strictEqual(sessionData.turns.length, 1);

    // 3. GET /api/prompts/sessions/:sessionId/export
    const exportRes = await fetch(`${baseUrl}/api/prompts/sessions/sess-rest-1/export?project=${projectId}`);
    assert.strictEqual(exportRes.status, 200);
    const exportText = await exportRes.text();
    assert.ok(exportText.includes('sess-rest-1'));

    // 4. GET /api/activity
    const actRes = await fetch(`${baseUrl}/api/activity?project=${projectId}`);
    assert.strictEqual(actRes.status, 200);
    const actData = (await actRes.json()) as any;
    assert.strictEqual(actData.totalPrompts, 1);

    // 5. POST /api/prompts/derive-rules
    const rulesRes = await fetch(`${baseUrl}/api/prompts/derive-rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, sessionId: 'sess-rest-1' })
    });
    assert.strictEqual(rulesRes.status, 200);
    const rulesData = (await rulesRes.json()) as any;
    assert.strictEqual(rulesData.ok, true);
    assert.ok(rulesData.result.rules.length >= 1);

    // 6. GET /api/prompts/:id with renderedHtml
    const promptId = promptsData.items[0].frontmatter.id;
    const detailRes = await fetch(`${baseUrl}/api/prompts/${encodeURIComponent(promptId)}?project=${projectId}`);
    assert.strictEqual(detailRes.status, 200);
    const detailData = (await detailRes.json()) as any;
    assert.strictEqual(detailData.ok, true);
    assert.ok(detailData.record);
    assert.strictEqual(detailData.record.path, undefined);
    assert.ok(typeof detailData.renderedHtml === 'string');
    assert.ok(detailData.renderedHtml.includes('sanitize') || detailData.renderedHtml.includes('Always'));

    // 7. GET /api/sessions
    const sessionsRes = await fetch(`${baseUrl}/api/sessions?project=${projectId}`);
    assert.strictEqual(sessionsRes.status, 200);
    const sessionsData = (await sessionsRes.json()) as any;
    assert.ok(sessionsData.total >= 1);
    assert.ok(sessionsData.items.some((s: any) => s.frontmatter.sessionId === 'sess-rest-1'));
  } finally {
    if (savedAuth !== undefined) process.env.SPEC_MEMO_AUTH_TOKEN = savedAuth;
    if (savedSse !== undefined) process.env.SPEC_MEMO_SSE_TOKEN = savedSse;
    if (savedStatus !== undefined) process.env.SPEC_MEMO_STATUS_TOKEN = savedStatus;
    if (statusInstance) {
      await statusInstance.close();
    }
    cleanup();
  }
});

test('Compiled Views - PROMPTS.md and SESSIONS.md Generation', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-compiled-1',
      turn: 1,
      body: 'First prompt turn for compiled view check.',
      taskSlug: 'slice-views'
    });

    await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-compiled-1',
      taskSlug: 'slice-views'
    });

    rebuildCompiledViews(projectId, vaultRoot);

    const promptsFile = path.join(vaultRoot, 'projects', projectId, 'PROMPTS.md');
    const sessionsFile = path.join(vaultRoot, 'projects', projectId, 'SESSIONS.md');

    assert.ok(fs.existsSync(promptsFile), 'PROMPTS.md must be generated');
    assert.ok(fs.existsSync(sessionsFile), 'SESSIONS.md must be generated');

    const promptsContent = fs.readFileSync(promptsFile, 'utf8');
    assert.ok(promptsContent.includes('# Prompts & Intent History —'));
    assert.ok(promptsContent.includes('sess-compiled-1'));
    assert.ok(promptsContent.includes('./prompts/'), 'PROMPTS.md must wikilink into prompts/');

    const sessionsContent = fs.readFileSync(sessionsFile, 'utf8');
    assert.ok(sessionsContent.includes('# Task & Work Sessions —'));
    assert.ok(sessionsContent.includes('sess-compiled-1'));
  } finally {
    cleanup();
  }
});

test('Vault scaffolding creates prompts/ and sessions/ dirs', () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    const promptsDir = path.join(vaultRoot, 'projects', projectId, 'prompts');
    const sessionsDir = path.join(vaultRoot, 'projects', projectId, 'sessions');
    assert.ok(fs.existsSync(promptsDir), 'prompts/ must exist');
    assert.ok(fs.existsSync(sessionsDir), 'sessions/ must exist');
  } finally {
    cleanup();
  }
});

test('FTS searchPrompts finds indexed prompt body tokens', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-fts',
      turn: 1,
      body: 'Implement uniqueTokenZebraBackoff for rate limiting retries.',
      ide: 'cursor',
      tags: ['fts-check']
    });

    const hits = searchPrompts({
      vaultRoot,
      projectId,
      query: 'uniqueTokenZebraBackoff'
    });
    assert.ok(hits.total >= 1, 'FTS must find unique token');
    assert.ok(hits.items.some((p) => p.body.includes('uniqueTokenZebraBackoff')));

    const empty = searchPrompts({ vaultRoot, projectId, query: '' });
    assert.strictEqual(empty.total, 0);

    const searchTool = await executeTool('prompt', {
      action: 'search',
      vaultRoot,
      projectId,
      query: 'uniqueTokenZebraBackoff'
    });
    assert.strictEqual(searchTool.isError, undefined);
    assert.ok(((searchTool.data as any).total as number) >= 1);
  } finally {
    cleanup();
  }
});

test('crossProject list aggregates prompts from two project vaults', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-cross-prompt-'));
  const vaultRoot = tmpDir;
  const projectA = 'proj-a-cross';
  const projectB = 'proj-b-cross';
  try {
    for (const pid of [projectA, projectB]) {
      ensureProjectVault(
        {
          projectId: pid,
          rootPath: tmpDir,
          vaultProjectPath: path.join(tmpDir, 'projects', pid),
          normalizedRemote: null,
          isGit: false,
          isFallback: true
        },
        vaultRoot
      );
      await recordPromptTurn({
        vaultRoot,
        projectId: pid,
        sessionId: `sess-${pid}`,
        turn: 1,
        body: `Cross project prompt for ${pid}`
      });
    }

    const cross = listPrompts({ vaultRoot, crossProject: true, limit: 50 });
    assert.ok(cross.total >= 2);
    const projects = new Set(cross.items.map((p) => p.frontmatter.project));
    assert.ok(projects.has(projectA));
    assert.ok(projects.has(projectB));
  } finally {
    try {
      closeIndex(vaultRoot);
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('derive-rules promote allowlist accepts IDE paths and refuses src/', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  const productRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-promote-product-'));
  try {
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-promote',
      turn: 1,
      body: 'Always close database handles before deleting test directories. Never leave SQLite open on Windows.',
      cwd: productRoot
    });

    const okDest = path.join(productRoot, '.cursor', 'rules', 'derived.mdc');
    const ok = await deriveRulesFromPrompts({
      vaultRoot,
      projectId,
      cwd: productRoot,
      sessionId: 'sess-promote',
      promote: okDest,
      format: 'cursor'
    });
    assert.ok(ok.promotedPath);
    assert.ok(fs.existsSync(okDest));

    await assert.rejects(
      () =>
        deriveRulesFromPrompts({
          vaultRoot,
          projectId,
          cwd: productRoot,
          sessionId: 'sess-promote',
          promote: path.join(productRoot, 'src', 'evil.ts'),
          format: 'markdown'
        }),
      /allowlisted IDE rule path|Safety violation/
    );

    const outsideRepo = path.join(os.tmpdir(), 'spec-memo-foreign-repo', 'CLAUDE.md');
    await assert.rejects(
      () =>
        deriveRulesFromPrompts({
          vaultRoot,
          projectId,
          cwd: productRoot,
          sessionId: 'sess-promote',
          promote: outsideRepo,
          format: 'markdown'
        }),
      /must resolve inside the product repository|Safety violation/
    );
  } finally {
    cleanup();
    try {
      fs.rmSync(productRoot, { recursive: true, force: true });
    } catch {}
  }
});

test('Status HTML includes prompts explorer polish markers', async () => {
  const { generateStatusHtml } = await import('./status.js');
  const html = generateStatusHtml('9.9.9');
  assert.ok(html.includes('tab-prompts'));
  assert.ok(html.includes('tab-invoicing') || html.includes('Activity'));
  assert.ok(html.includes('tab-rules') || html.includes('Derived Rules'));
  assert.ok(html.includes('prompt-since-input'));
  assert.ok(html.includes('prompt-until-input'));
  assert.ok(html.includes('data-ide="pi"'));
  assert.ok(html.includes('secret-badge') || html.includes('Secrets redacted'));
  assert.ok(html.includes('prompt-drawer'));
  assert.ok(html.includes('btn-drawer-export'));
  assert.ok(html.includes('exportParams') || html.includes('project'));
});


test('activity report totalPrompts respects since/until/client filters', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-old',
      turn: 1,
      body: 'Old prompt outside window',
      client: 'client-x',
      ide: 'cursor'
    });
    const oldPath = path.join(vaultRoot, 'projects', projectId, 'prompts');
    for (const f of fs.readdirSync(oldPath).filter((name) => name.endsWith('.md'))) {
      const full = path.join(oldPath, f);
      let md = fs.readFileSync(full, 'utf8');
      md = md.replace(/^created: .*$/m, 'created: 2020-01-01T00:00:00.000Z');
      fs.writeFileSync(full, md, 'utf8');
    }

    await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-win',
      client: 'client-x',
      billable: true
    });
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-win',
      turn: 1,
      body: 'In-window prompt',
      client: 'client-x'
    });
    await endSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-win',
      body: 'done'
    });

    const report = generateActivityReport({
      vaultRoot,
      projectId,
      since: '2026-01-01T00:00:00.000Z',
      until: '2099-12-31T23:59:59.999Z',
      client: 'client-x'
    });
    assert.ok(report.totalPrompts >= 1);
    assert.ok(report.totalPrompts < 3, `expected filtered prompt count, got ${report.totalPrompts}`);
  } finally {
    cleanup();
  }
});

test('auto turn allocation uses max(turn)+1 after gaps', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    const t1 = await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-gap',
      turn: 1,
      body: 'turn one'
    });
    const t2 = await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-gap',
      turn: 2,
      body: 'turn two'
    });
    await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-gap',
      turn: 3,
      body: 'turn three'
    });

    await forgetRecord({ id: t2.id, vaultRoot, projectId, purge: true });

    const next = await recordPromptTurn({
      vaultRoot,
      projectId,
      sessionId: 'sess-gap',
      body: 'auto after gap'
    });
    assert.strictEqual(Number(next.turn), 4);
    assert.notStrictEqual(next.id, t1.id);
    const turns = getSessionTurns({ vaultRoot, projectId, sessionId: 'sess-gap' });
    assert.ok(turns.some((r) => Number(r.frontmatter.turn) === 3));
    assert.ok(turns.some((r) => Number(r.frontmatter.turn) === 4));
  } finally {
    cleanup();
  }
});

test('endSessionRecord rejects sessions that were never started', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await assert.rejects(
      () =>
        endSessionRecord({
          vaultRoot,
          projectId,
          sessionId: 'orphan-never-started',
          body: 'should fail'
        }),
      /no session record found|session_start first/
    );
  } finally {
    cleanup();
  }
});

test('startSessionRecord rejects restart of a completed session', async () => {
  const { vaultRoot, projectId, cleanup } = createTempVault();
  try {
    await startSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-done',
      client: 'acme'
    });
    await endSessionRecord({
      vaultRoot,
      projectId,
      sessionId: 'sess-done',
      body: 'done'
    });
    await assert.rejects(
      () =>
        startSessionRecord({
          vaultRoot,
          projectId,
          sessionId: 'sess-done'
        }),
      /Cannot restart completed session|Start a new sessionId/
    );
  } finally {
    cleanup();
  }
});
