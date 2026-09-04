import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SUPPORTED_HOOK_HOSTS,
  resolveHostHookPaths,
  installHooks,
  inspectAgentHooks,
  deepMergeJson,
  generateFailOpenShellBody,
  generateOpenCodePlugin,
  generateCursorRule,
  stripSpecMemoFromHookConfig,
  HOOK_TIMEOUT_MS
} from './hooks-install.js';

describe('hooks-install', () => {
  let tempDir: string;
  let productRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-hooks-'));
    productRoot = path.join(tempDir, 'product');
    homeDir = path.join(tempDir, 'home');
    fs.mkdirSync(path.join(productRoot, '.git'), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('defines SUPPORTED_HOOK_HOSTS per AC1', () => {
    assert.deepEqual(SUPPORTED_HOOK_HOSTS, ['antigravity', 'opencode', 'cursor', 'claude', 'all']);
  });

  it('resolveHostHookPaths returns canonical destinations per AC2', () => {
    const agWs = resolveHostHookPaths('antigravity', { global: false, productRoot });
    assert.ok(agWs.some((t) => t.path.endsWith('.agents/hooks.json'.replace(/\//g, path.sep))));

    const agGl = resolveHostHookPaths('antigravity', { global: true, productRoot, homeDir });
    assert.ok(
      agGl.some((t) =>
        t.path.includes(path.join('.gemini', 'config', 'hooks.json'))
      )
    );

    const oc = resolveHostHookPaths('opencode', { global: false, productRoot });
    assert.ok(oc[0].path.includes(path.join('.opencode', 'plugins', 'spec-memo.js')));

    const cursor = resolveHostHookPaths('cursor', { global: false, productRoot });
    assert.ok(cursor.some((t) => t.path.endsWith('spec-memo.mdc')));
    assert.ok(cursor.some((t) => t.path.endsWith('hooks.json')));

    const claudeWs = resolveHostHookPaths('claude', { global: false, productRoot });
    assert.ok(claudeWs.some((t) => t.path.endsWith(path.join('.claude', 'hooks'))));
  });

  it('deepMergeJson preserves existing custom hooks per AC6', () => {
    const merged = deepMergeJson(
      { hooks: { Custom: [{ command: 'echo hi' }] }, keep: true },
      { hooks: { PreInvocation: [{ matcher: { invocationNum: 0 }, command: 'memo bootstrap' }] } }
    );
    assert.deepEqual(merged.hooks, {
      Custom: [{ command: 'echo hi' }],
      PreInvocation: [{ matcher: { invocationNum: 0 }, command: 'memo bootstrap' }]
    });
    assert.equal(merged.keep, true);
  });

  it('deepMergeJson appends hook arrays instead of replacing existing entries', () => {
    const merged = deepMergeJson(
      { hooks: { PreInvocation: [{ command: 'echo keep-me' }] } },
      { hooks: { PreInvocation: [{ command: '.agents/hooks/spec-memo-session-start.sh' }] } }
    );
    assert.equal((merged.hooks as { PreInvocation: unknown[] }).PreInvocation.length, 2);
  });

  it('dry-run preview does not write files per AC13', async () => {
    const result = await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      packageVersion: '9.9.9'
    });
    assert.ok(result.results.every((r) => r.status === 'preview'));
    assert.equal(fs.existsSync(path.join(productRoot, '.cursor', 'rules', 'spec-memo.mdc')), false);
  });

  it('--apply writes cursor rule and hooks per AC9/AC14', async () => {
    const result = await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      force: true,
      packageVersion: '1.2.3'
    });
    const rulePath = path.join(productRoot, '.cursor', 'rules', 'spec-memo.mdc');
    assert.equal(fs.existsSync(rulePath), true);
    const rule = fs.readFileSync(rulePath, 'utf8');
    assert.match(rule, /alwaysApply:\s*true/);
    assert.match(rule, /globs:/);
    assert.match(rule, /generated-by: spec-memo@1\.2\.3/);
    assert.ok(result.results.some((r) => r.status === 'installed' || r.status === 'unchanged'));
  });

  it('antigravity preview includes PreInvocation hooks per AC4', async () => {
    const result = await installHooks({
      host: 'antigravity',
      productRoot,
      cwd: productRoot,
      packageVersion: '1.0.0'
    });
    const hooksRow = result.results.find((r) => r.path.includes('hooks.json'));
    assert.ok(hooksRow);
    assert.match(hooksRow!.diff || '', /PreInvocation/);
    assert.match(hooksRow!.diff || '', /invocationNum/);
  });

  it('opencode plugin includes init/prompt/exit handlers per AC7', () => {
    const plugin = generateOpenCodePlugin('2.0.0');
    assert.match(plugin, /onInit/);
    assert.match(plugin, /onPrompt/);
    assert.match(plugin, /onExit/);
    assert.match(plugin, /bootstrap/);
    assert.match(plugin, /sync/);
    assert.ok(plugin.includes(String(HOOK_TIMEOUT_MS)));
  });

  it('shell hooks use timeout and fail-open per AC11/AC12', () => {
    const script = generateFailOpenShellBody(['bootstrap']);
    assert.match(script, /timeout 1\.5/);
    assert.match(script, /exit 0/);
    assert.match(script, /\|\| true/);
  });

  it('unsupported host errors cleanly', async () => {
    await assert.rejects(
      () => installHooks({ host: 'unknown', productRoot, apply: true }),
      /Unsupported hook host/
    );
  });

  it('install-hooks --json returns structured rows per AC16', async () => {
    const result = await installHooks({
      host: 'opencode',
      productRoot,
      cwd: productRoot,
      packageVersion: '3.0.0'
    });
    assert.ok(Array.isArray(result.results));
    for (const row of result.results) {
      assert.ok(['installed', 'removed', 'unchanged', 'preview'].includes(row.status));
      assert.ok(row.host);
      assert.ok(row.path);
    }
  });

  it('doctor inspect reports skill-only when hooks absent per AC18', () => {
    const inspection = inspectAgentHooks({ productRoot, cwd: productRoot, runningVersion: '1.0.0' });
    assert.equal(inspection.installed, false);
    assert.match(inspection.summary, /Not installed/);
    assert.match(inspection.summary, /ws-memo/);
  });

  it('doctor inspect reports active hosts when installed', async () => {
    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      force: true,
      packageVersion: '1.0.0'
    });
    const inspection = inspectAgentHooks({ productRoot, cwd: productRoot, runningVersion: '1.0.0' });
    assert.equal(inspection.installed, true);
    assert.ok(inspection.hosts.some((h) => h.host === 'Cursor' && h.active));
    assert.match(inspection.summary, /Cursor \(Active\)/);
  });

  it('generated record scripts include session id and non-empty body', async () => {
    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      force: true,
      packageVersion: '1.0.0'
    });
    const record = fs.readFileSync(
      path.join(productRoot, '.cursor', 'hooks', 'spec-memo-record.sh'),
      'utf8'
    );
    assert.match(record, /--session-id/);
    assert.match(record, /\[hook-automated turn\]/);
  });

  it('--remove strips spec-memo hook entries from hooks.json per AC15', async () => {
    const hooksPath = path.join(productRoot, '.cursor', 'hooks.json');
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: 'echo keep' }],
            beforeSubmitPrompt: [{ command: '.cursor/hooks/spec-memo-record.sh' }]
          }
        },
        null,
        2
      ),
      'utf8'
    );

    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      remove: true,
      packageVersion: '1.0.0'
    });

    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }>; beforeSubmitPrompt?: unknown[] };
    };
    assert.equal(parsed.hooks.sessionStart.length, 1);
    assert.equal(parsed.hooks.beforeSubmitPrompt?.length ?? 0, 0);
  });

  it('stripSpecMemoFromHookConfig removes spec-memo commands only', () => {
    const cleaned = stripSpecMemoFromHookConfig({
      hooks: {
        sessionStart: [{ command: 'echo ok' }, { command: '.cursor/hooks/spec-memo-bootstrap.sh' }]
      },
      'spec-memo': { version: '1.0.0' }
    });
    assert.equal((cleaned.hooks as { sessionStart: unknown[] }).sessionStart.length, 1);
    assert.equal(cleaned['spec-memo'], undefined);
  });

  it('--remove uninstalls generated cursor artifacts per AC15', async () => {
    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      force: true,
      packageVersion: '1.0.0'
    });
    const rulePath = path.join(productRoot, '.cursor', 'rules', 'spec-memo.mdc');
    assert.equal(fs.existsSync(rulePath), true);

    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      remove: true,
      packageVersion: '1.0.0'
    });
    assert.equal(fs.existsSync(rulePath), false);
  });

  it('creates .bak backup when overwriting with --force per AC14', async () => {
    const rulePath = path.join(productRoot, '.cursor', 'rules', 'spec-memo.mdc');
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, '---\nalwaysApply: false\n---\nold\n', 'utf8');

    await installHooks({
      host: 'cursor',
      productRoot,
      cwd: productRoot,
      apply: true,
      force: true,
      packageVersion: '2.0.0'
    });

    const dir = path.dirname(rulePath);
    const baks = fs.readdirSync(dir).filter((f) => f.includes('.bak'));
    assert.ok(baks.length >= 1);
    const updated = fs.readFileSync(rulePath, 'utf8');
    assert.match(updated, /generated-by: spec-memo@2\.0\.0/);
  });

  it('cursor rule includes file-pattern frontmatter per AC10', () => {
    const rule = generateCursorRule('1.0.0');
    assert.match(rule, /globs:\s*\n\s+-\s+"\*\*\/\*"/);
  });
});
