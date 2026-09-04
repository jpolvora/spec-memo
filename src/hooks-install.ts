import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectIdentity } from './identity.js';
import { getPackageVersion } from './version.js';

export const SUPPORTED_HOOK_HOSTS = ['antigravity', 'opencode', 'cursor', 'claude', 'all'] as const;
export type HookHostName = (typeof SUPPORTED_HOOK_HOSTS)[number];

export const HOOK_TIMEOUT_MS = 1500;
export const GENERATED_BY_PREFIX = '// generated-by: spec-memo@';

export interface InstallHooksOptions {
  host?: HookHostName | string;
  global?: boolean;
  apply?: boolean;
  dryRun?: boolean;
  force?: boolean;
  remove?: boolean;
  cwd?: string;
  productRoot?: string;
  homeDir?: string;
  /** Test hook: override package version stamp. */
  packageVersion?: string;
}

export interface InstallHooksRow {
  host: string;
  path: string;
  status: 'installed' | 'removed' | 'unchanged' | 'preview';
  diff?: string;
}

export interface InstallHooksResult {
  mode: 'local' | 'global';
  productRoot: string;
  results: InstallHooksRow[];
}

export interface HookPathTarget {
  host: Exclude<HookHostName, 'all'>;
  path: string;
  kind: 'json' | 'js' | 'mdc' | 'shell' | 'dir';
}

export interface AgentHookHostStatus {
  host: string;
  paths: string[];
  version?: string;
  outdated?: boolean;
  active: boolean;
}

export interface AgentHooksInspection {
  installed: boolean;
  hosts: AgentHookHostStatus[];
  summary: string;
}

function assertHookHost(host: string): asserts host is Exclude<HookHostName, 'all'> {
  if (!(SUPPORTED_HOOK_HOSTS as readonly string[]).includes(host) || host === 'all') {
    throw new Error(
      `Unsupported hook host '${host}'. Supported hosts: ${SUPPORTED_HOOK_HOSTS.filter((h) => h !== 'all').join(', ')}, all`
    );
  }
}

function resolveHosts(hostArg?: string): Array<Exclude<HookHostName, 'all'>> {
  const normalized = (hostArg || 'all').toLowerCase();
  if (normalized === 'all') {
    return ['antigravity', 'opencode', 'cursor', 'claude'];
  }
  assertHookHost(normalized);
  return [normalized];
}

/**
 * Resolve canonical hook destination paths for a host.
 */
export function resolveHostHookPaths(
  host: Exclude<HookHostName, 'all'>,
  options: { global?: boolean; productRoot: string; homeDir?: string }
): HookPathTarget[] {
  const home = path.resolve(options.homeDir || os.homedir());
  const root = path.resolve(options.productRoot);
  const global = options.global === true;

  switch (host) {
    case 'antigravity':
      return [
        {
          host,
          path: global
            ? path.join(home, '.gemini', 'config', 'hooks.json')
            : path.join(root, '.agents', 'hooks.json'),
          kind: 'json'
        },
        ...(global
          ? []
          : [
              {
                host,
                path: path.join(root, '.agents', 'hooks'),
                kind: 'dir' as const
              }
            ])
      ];
    case 'opencode':
      return [
        {
          host,
          path: global
            ? path.join(home, '.config', 'opencode', 'plugins', 'spec-memo.js')
            : path.join(root, '.opencode', 'plugins', 'spec-memo.js'),
          kind: 'js'
        }
      ];
    case 'cursor':
      if (global) {
        return [];
      }
      return [
        { host, path: path.join(root, '.cursor', 'rules', 'spec-memo.mdc'), kind: 'mdc' },
        { host, path: path.join(root, '.cursor', 'hooks.json'), kind: 'json' },
        { host, path: path.join(root, '.cursor', 'hooks'), kind: 'dir' }
      ];
    case 'claude':
      if (global) {
        return [{ host, path: path.join(home, '.claude', 'config.json'), kind: 'json' }];
      }
      return [
        { host, path: path.join(root, '.claude', 'hooks'), kind: 'dir' },
        { host, path: path.join(root, '.claude', 'config.json'), kind: 'json' }
      ];
    default:
      return [];
  }
}

export function deepMergeJson(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergeJson(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function shellHeader(version: string): string {
  return `#!/bin/sh
# ${GENERATED_BY_PREFIX}${version}
# spec-memo fail-open hook (max ${HOOK_TIMEOUT_MS}ms)
`;
}

export function generateFailOpenShellBody(memoArgs: string[]): string {
  const quoted = memoArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return `${shellHeader(getPackageVersion())}
run_memo() {
  if command -v memo >/dev/null 2>&1; then
    timeout 1.5 memo ${quoted} >/dev/null 2>&1 || true
  fi
  exit 0
}
run_memo
`;
}

function generateAntigravityHooksJson(version: string): Record<string, unknown> {
  return {
    hooks: {
      PreInvocation: [
        {
          matcher: { invocationNum: 0 },
          command: '.agents/hooks/spec-memo-session-start.sh'
        }
      ],
      PostInvocation: [
        {
          command: '.agents/hooks/spec-memo-session-end.sh'
        }
      ]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

function generateCursorHooksJson(version: string): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: '.cursor/hooks/spec-memo-bootstrap.sh', timeout: 1 }],
      beforeSubmitPrompt: [{ command: '.cursor/hooks/spec-memo-record.sh', timeout: 1 }],
      sessionEnd: [{ command: '.cursor/hooks/spec-memo-session-end.sh', timeout: 1 }]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

function generateClaudeHooksConfig(version: string): Record<string, unknown> {
  return {
    hooks: {
      SessionStart: [{ type: 'command', command: '.claude/hooks/spec-memo-bootstrap.sh' }],
      UserPromptSubmit: [{ type: 'command', command: '.claude/hooks/spec-memo-record.sh' }],
      PreCompact: [{ type: 'command', command: '.claude/hooks/spec-memo-checkpoint.sh' }],
      SessionEnd: [{ type: 'command', command: '.claude/hooks/spec-memo-session-end.sh' }]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

export function generateOpenCodePlugin(version: string): string {
  return `${GENERATED_BY_PREFIX}${version}
export default {
  name: 'spec-memo',
  async onInit() {
    await runMemo(['bootstrap']);
  },
  async onPrompt() {
    await runMemo(['prompt', 'record', '--body', '']);
  },
  async onExit() {
    await runMemo(['sync']);
  }
};

async function runMemo(args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('memo', args, { stdio: 'ignore', shell: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve(0);
    }, ${HOOK_TIMEOUT_MS});
    child.on('error', () => { clearTimeout(timer); resolve(0); });
    child.on('close', () => { clearTimeout(timer); resolve(0); });
  });
}
`;
}

export function generateCursorRule(version: string): string {
  return `---
description: spec-memo agent memory integration (bootstrap + session tracking)
alwaysApply: true
globs:
  - "**/*"
---

# spec-memo agent hooks

${GENERATED_BY_PREFIX}${version}

On session intake, invoke \`memo bootstrap\` with the product root as \`cwd\` before planning or coding.
Record prompt turns via \`memo prompt record\` and end sessions with \`memo prompt session_end\` including deliverables.
Hooks are optional; skill-only mode via ws-memo autoload is fully supported.
`;
}

function uniqueScripts(
  host: Exclude<HookHostName, 'all'>
): Array<{ rel: string; content: string }> {
  switch (host) {
    case 'antigravity':
      return [
        {
          rel: 'spec-memo-session-start.sh',
          content: `${shellHeader(getPackageVersion())}
if command -v memo >/dev/null 2>&1; then
  timeout 1.5 memo bootstrap >/dev/null 2>&1 || true
  timeout 1.5 memo prompt session_start >/dev/null 2>&1 || true
fi
exit 0
`
        },
        {
          rel: 'spec-memo-session-end.sh',
          content: generateFailOpenShellBody(['prompt', 'session_end'])
        }
      ];
    case 'cursor':
      return [
        { rel: 'spec-memo-bootstrap.sh', content: generateFailOpenShellBody(['bootstrap']) },
        {
          rel: 'spec-memo-record.sh',
          content: generateFailOpenShellBody(['prompt', 'record', '--body', ''])
        },
        {
          rel: 'spec-memo-session-end.sh',
          content: generateFailOpenShellBody(['prompt', 'session_end'])
        }
      ];
    case 'claude':
      return [
        { rel: 'spec-memo-bootstrap.sh', content: generateFailOpenShellBody(['bootstrap']) },
        {
          rel: 'spec-memo-record.sh',
          content: generateFailOpenShellBody(['prompt', 'record', '--body', ''])
        },
        {
          rel: 'spec-memo-checkpoint.sh',
          content: generateFailOpenShellBody(['prompt', 'record', '--checkpoint'])
        },
        {
          rel: 'spec-memo-session-end.sh',
          content: generateFailOpenShellBody(['prompt', 'session_end'])
        }
      ];
    default:
      return [];
  }
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function simpleDiff(before: string, after: string): string {
  if (before === after) return '';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const a = afterLines[i];
    const b = beforeLines[i];
    if (a === b) continue;
    if (b !== undefined) lines.push(`- ${b}`);
    if (a !== undefined) lines.push(`+ ${a}`);
  }
  return lines.join('\n');
}

function backupIfNeeded(filePath: string, nextContent: string): void {
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing === nextContent) return;
  const bak = `${filePath}.${Date.now()}.bak`;
  fs.copyFileSync(filePath, bak);
}

function writeFileAtomic(filePath: string, content: string, force: boolean): 'installed' | 'unchanged' {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === content) return 'unchanged';
    if (!force) {
      throw new Error(`Target exists and differs: ${filePath}. Pass --force to overwrite or use --remove first.`);
    }
    backupIfNeeded(filePath, content);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return 'installed';
}

function removeSpecMemoBlock(filePath: string): 'removed' | 'unchanged' {
  if (!fs.existsSync(filePath)) return 'unchanged';
  const bakCandidates = fs
    .readdirSync(path.dirname(filePath))
    .filter((f) => f.startsWith(path.basename(filePath) + '.') && f.endsWith('.bak'))
    .sort()
    .reverse();
  if (bakCandidates.length > 0) {
    const bakPath = path.join(path.dirname(filePath), bakCandidates[0]);
    fs.copyFileSync(bakPath, filePath);
    return 'removed';
  }
  if (filePath.endsWith('.json')) {
    const parsed = readJsonFile(filePath);
    if (parsed['spec-memo']) {
      delete parsed['spec-memo'];
      if (parsed.hooks && typeof parsed.hooks === 'object') {
        // Best-effort prune: if only spec-memo hooks, leave merged hooks for user
      }
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
      return 'removed';
    }
  }
  if (filePath.endsWith('.mdc') || filePath.endsWith('.js')) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.includes(GENERATED_BY_PREFIX)) {
      fs.unlinkSync(filePath);
      return 'removed';
    }
  }
  return 'unchanged';
}

function buildHostArtifacts(
  host: Exclude<HookHostName, 'all'>,
  version: string
): Array<{ path: string; content: string; kind: HookPathTarget['kind'] }> {
  const scripts = uniqueScripts(host);
  const artifacts: Array<{ path: string; content: string; kind: HookPathTarget['kind'] }> = [];

  switch (host) {
    case 'antigravity':
      artifacts.push({
        path: 'hooks.json',
        content: JSON.stringify(generateAntigravityHooksJson(version), null, 2) + '\n',
        kind: 'json'
      });
      for (const s of scripts) {
        artifacts.push({ path: s.rel, content: s.content, kind: 'shell' });
      }
      break;
    case 'opencode':
      artifacts.push({
        path: 'spec-memo.js',
        content: generateOpenCodePlugin(version),
        kind: 'js'
      });
      break;
    case 'cursor':
      artifacts.push({
        path: 'spec-memo.mdc',
        content: generateCursorRule(version),
        kind: 'mdc'
      });
      artifacts.push({
        path: 'hooks.json',
        content: JSON.stringify(generateCursorHooksJson(version), null, 2) + '\n',
        kind: 'json'
      });
      for (const s of scripts) {
        artifacts.push({ path: s.rel, content: s.content, kind: 'shell' });
      }
      break;
    case 'claude':
      for (const s of scripts) {
        artifacts.push({ path: s.rel, content: s.content, kind: 'shell' });
      }
      artifacts.push({
        path: 'config.json',
        content: JSON.stringify(generateClaudeHooksConfig(version), null, 2) + '\n',
        kind: 'json'
      });
      break;
  }
  return artifacts;
}

function mapArtifactToAbsolute(
  host: Exclude<HookHostName, 'all'>,
  target: HookPathTarget,
  artifactName: string,
  productRoot: string
): string {
  if (target.kind === 'dir') {
    return path.join(target.path, artifactName);
  }
  if (artifactName === 'hooks.json' || artifactName === 'config.json') {
    return target.path;
  }
  if (artifactName === 'spec-memo.mdc') {
    return target.path;
  }
  if (artifactName === 'spec-memo.js') {
    return target.path;
  }
  const hookDir =
    host === 'antigravity'
      ? path.join(productRoot, '.agents', 'hooks')
      : host === 'cursor'
        ? path.join(productRoot, '.cursor', 'hooks')
        : path.join(productRoot, '.claude', 'hooks');
  return path.join(hookDir, artifactName);
}

export async function installHooks(options: InstallHooksOptions = {}): Promise<InstallHooksResult> {
  const global = options.global === true;
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const force = options.force === true;
  const remove = options.remove === true;
  const version = options.packageVersion || getPackageVersion();

  const explicitRoot = options.productRoot?.trim();
  const cwdFallback = options.cwd?.trim() || process.cwd();
  const productRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : global
      ? path.resolve(options.homeDir || os.homedir())
      : resolveProjectIdentity(cwdFallback).rootPath;

  const hosts = resolveHosts(options.host);
  const results: InstallHooksRow[] = [];

  for (const host of hosts) {
    const targets = resolveHostHookPaths(host, { global, productRoot, homeDir: options.homeDir });
    if (targets.length === 0) {
      results.push({
        host,
        path: '(skipped — workspace-only host)',
        status: 'unchanged'
      });
      continue;
    }

    const artifacts = buildHostArtifacts(host, version);
    const jsonTarget = targets.find((t) => t.kind === 'json');

    for (const artifact of artifacts) {
      let absPath = '';
      if (artifact.kind === 'json' && jsonTarget) {
        absPath = jsonTarget.path;
      } else if (artifact.kind === 'mdc') {
        absPath = targets.find((t) => t.kind === 'mdc')?.path || '';
      } else if (artifact.kind === 'js') {
        absPath = targets.find((t) => t.kind === 'js')?.path || '';
      } else if (artifact.kind === 'shell') {
        absPath = mapArtifactToAbsolute(host, targets.find((t) => t.kind === 'dir') || targets[0], artifact.path, productRoot);
      }
      if (!absPath) continue;

      const relDisplay = absPath.replace(/\\/g, '/');

      if (remove) {
        if (dryRun) {
          results.push({ host, path: relDisplay, status: 'preview', diff: 'would remove spec-memo hooks' });
          continue;
        }
        const status = artifact.kind === 'shell' && fs.existsSync(absPath)
          ? (fs.unlinkSync(absPath), 'removed' as const)
          : removeSpecMemoBlock(absPath);
        results.push({ host, path: relDisplay, status });
        continue;
      }

      let nextContent = artifact.content;
      if (artifact.kind === 'json' && fs.existsSync(absPath)) {
        const existing = readJsonFile(absPath);
        const patch = JSON.parse(artifact.content) as Record<string, unknown>;
        nextContent = JSON.stringify(deepMergeJson(existing, patch), null, 2) + '\n';
      }

      const before = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
      const diff = simpleDiff(before, nextContent);

      if (dryRun) {
        results.push({
          host,
          path: relDisplay,
          status: 'preview',
          diff: diff || (before ? '(content differs)' : '(new file)')
        });
        continue;
      }

      if (artifact.kind === 'shell') {
        const st = writeFileAtomic(absPath, nextContent, force);
        try {
          fs.chmodSync(absPath, 0o755);
        } catch {
          // Windows may not support chmod
        }
        results.push({ host, path: relDisplay, status: st, diff: diff || undefined });
        continue;
      }

      const st = writeFileAtomic(absPath, nextContent, force);
      results.push({ host, path: relDisplay, status: st, diff: diff || undefined });
    }
  }

  return {
    mode: global ? 'global' : 'local',
    productRoot,
    results
  };
}

function extractGeneratedVersion(content: string): string | undefined {
  const match = content.match(/generated-by:\s*spec-memo@([^\s*]+)/);
  return match?.[1];
}

/**
 * Inspect installed agent hooks for doctor diagnostics (AC18).
 */
export function inspectAgentHooks(options: {
  productRoot?: string;
  cwd?: string;
  homeDir?: string;
  runningVersion?: string;
} = {}): AgentHooksInspection {
  const cwd = options.cwd?.trim() || process.cwd();
  const productRoot = options.productRoot
    ? path.resolve(options.productRoot)
    : resolveProjectIdentity(cwd).rootPath;
  const home = path.resolve(options.homeDir || os.homedir());
  const runningVersion = options.runningVersion || getPackageVersion();
  const hosts: AgentHookHostStatus[] = [];

  const checks: Array<{ host: Exclude<HookHostName, 'all'>; paths: string[] }> = [
    {
      host: 'antigravity',
      paths: [
        path.join(productRoot, '.agents', 'hooks.json'),
        path.join(home, '.gemini', 'config', 'hooks.json')
      ]
    },
    {
      host: 'opencode',
      paths: [
        path.join(productRoot, '.opencode', 'plugins', 'spec-memo.js'),
        path.join(home, '.config', 'opencode', 'plugins', 'spec-memo.js')
      ]
    },
    {
      host: 'cursor',
      paths: [
        path.join(productRoot, '.cursor', 'rules', 'spec-memo.mdc'),
        path.join(productRoot, '.cursor', 'hooks.json')
      ]
    },
    {
      host: 'claude',
      paths: [
        path.join(productRoot, '.claude', 'config.json'),
        path.join(home, '.claude', 'config.json'),
        path.join(productRoot, '.claude', 'hooks')
      ]
    }
  ];

  for (const check of checks) {
    const activePaths: string[] = [];
    let version: string | undefined;
    let outdated = false;

    for (const p of check.paths) {
      if (!fs.existsSync(p)) continue;
      let content = '';
      if (fs.statSync(p).isDirectory()) {
        const files = fs.readdirSync(p).filter((f) => f.includes('spec-memo'));
        if (files.length === 0) continue;
        activePaths.push(p);
        for (const f of files) {
          const c = fs.readFileSync(path.join(p, f), 'utf8');
          const v = extractGeneratedVersion(c);
          if (v) version = v;
        }
      } else {
        content = fs.readFileSync(p, 'utf8');
        if (!content.includes('spec-memo') && !content.includes(GENERATED_BY_PREFIX)) {
          const parsed = readJsonFile(p);
          if (!parsed['spec-memo']) continue;
          version = (parsed['spec-memo'] as { version?: string })?.version || version;
        } else {
          activePaths.push(p);
          version = extractGeneratedVersion(content) || version;
        }
      }
      if (version && version !== runningVersion) outdated = true;
    }

    if (activePaths.length > 0) {
      hosts.push({
        host: check.host.charAt(0).toUpperCase() + check.host.slice(1),
        paths: activePaths.map((p) => p.replace(/\\/g, '/')),
        version,
        outdated,
        active: true
      });
    }
  }

  const installed = hosts.length > 0;
  const summary = installed
    ? `Agent Hooks: ${hosts.map((h) => `${h.host} (Active${h.outdated ? ', outdated' : ''})`).join(', ')}`
    : 'Agent Hooks: Not installed (Skill-only mode active via ws-memo)';

  return { installed, hosts, summary };
}
