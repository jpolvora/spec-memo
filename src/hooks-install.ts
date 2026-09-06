import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectIdentity } from './identity.js';
import { getPackageVersion } from './version.js';
import {
  canonicalInstallHost,
  normalizeInstallHosts,
  getInstallPreflight,
  InstallPreflight,
  ConflictPolicy,
  InstallHost
} from './install-wizard.js';

export const SUPPORTED_HOOK_HOSTS = ['antigravity', 'opencode', 'cursor', 'claude', 'codex', 'all'] as const;
export type HookHostName = (typeof SUPPORTED_HOOK_HOSTS)[number];

export const HOOK_TIMEOUT_MS = 1500;
export const GENERATED_BY_PREFIX = '// generated-by: spec-memo@';
export const ACTIVE_SESSION_FILE = '.spec-memo/.active-session-id';
const CODEX_BLOCK_START = '<!-- spec-memo:start -->';
const CODEX_BLOCK_END = '<!-- spec-memo:end -->';

export interface InstallHooksOptions {
  host?: HookHostName | string;
  hosts?: string[];
  global?: boolean;
  scope?: 'local' | 'global';
  apply?: boolean;
  dryRun?: boolean;
  force?: boolean;
  skipExisting?: boolean;
  update?: boolean;
  conflictPolicy?: ConflictPolicy;
  confirm?: boolean;
  preflight?: InstallPreflight;
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
  status: 'installed' | 'removed' | 'unchanged' | 'preview' | 'skipped' | 'refused';
  diff?: string;
}

export interface InstallHooksResult {
  mode: 'local' | 'global';
  productRoot: string;
  scope?: 'local' | 'global';
  hosts?: string[];
  conflictPolicy?: ConflictPolicy;
  status?: 'applied' | 'preview';
  preflight: InstallPreflight;
  results: InstallHooksRow[];
}

export interface HookPathTarget {
  host: Exclude<HookHostName, 'all'>;
  path: string;
  kind: 'json' | 'js' | 'mdc' | 'md' | 'shell' | 'dir';
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
      `Unsupported hook host '${host}'. Supported hosts: ${SUPPORTED_HOOK_HOSTS.filter((h) => h !== 'all').join(', ')}, aliases: gemini, google, gpt, openai, claude-code, all`
    );
  }
}

function resolveHosts(
  hostArg?: string,
  hostList?: string[]
): Array<Exclude<HookHostName, 'all'>> {
  const requested = hostList?.length ? hostList : hostArg;
  if (!requested) {
    throw new Error('Hook host selection is required. Pass --host <host> or use the interactive wizard.');
  }
  const normalized = normalizeInstallHosts(requested, { allowAll: true });
  for (const host of normalized) assertHookHost(host);
  return normalized;
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
        {
          host,
          path: global
            ? path.join(home, '.gemini', 'config', 'hooks')
            : path.join(root, '.agents', 'hooks'),
          kind: 'dir'
        }
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
      return global
        ? [
            { host, path: path.join(home, '.cursor', 'hooks.json'), kind: 'json' },
            { host, path: path.join(home, '.cursor', 'hooks'), kind: 'dir' }
          ]
        : [
            { host, path: path.join(root, '.cursor', 'rules', 'spec-memo.mdc'), kind: 'mdc' },
            { host, path: path.join(root, '.cursor', 'hooks.json'), kind: 'json' },
            { host, path: path.join(root, '.cursor', 'hooks'), kind: 'dir' }
          ];
    case 'claude':
      return global
        ? [
            { host, path: path.join(home, '.claude', 'hooks'), kind: 'dir' },
            { host, path: path.join(home, '.claude', 'config.json'), kind: 'json' }
          ]
        : [
            { host, path: path.join(root, '.claude', 'hooks'), kind: 'dir' },
            { host, path: path.join(root, '.claude', 'config.json'), kind: 'json' }
          ];
    case 'codex':
      return [{
        host,
        path: global
          ? path.join(home, '.codex', 'AGENTS.md')
          : path.join(root, '.codex', 'AGENTS.md'),
        kind: 'md'
      }];
    default:
      return [];
  }
}

function mergeHookArrays(existing: unknown[], incoming: unknown[]): unknown[] {
  const seen = new Set(existing.map((entry) => JSON.stringify(entry)));
  const out = [...existing];
  for (const entry of incoming) {
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

export function deepMergeJson(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      if (Array.isArray(out[key])) {
        out[key] = mergeHookArrays(out[key] as unknown[], value);
      } else {
        out[key] = value;
      }
      continue;
    }
    if (
      value &&
      typeof value === 'object' &&
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

function isSpecMemoHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = String((entry as Record<string, unknown>).command || '');
  return /(?:^|\s|[/\\])spec-memo-(?:bootstrap|record|checkpoint|session-start|session-end)\.sh(?:\s|$)/.test(cmd);
}

export function stripSpecMemoFromHookConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  delete parsed['spec-memo'];
  const hooks = parsed.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const [key, value] of Object.entries(hooks as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        (hooks as Record<string, unknown>)[key] = value.filter((entry) => !isSpecMemoHookEntry(entry));
      }
    }
  }
  return parsed;
}

function isSpecMemoStamped(content: string): boolean {
  if (content.includes(GENERATED_BY_PREFIX)) return true;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const marker = parsed['spec-memo'];
    return Boolean(
      marker &&
      typeof marker === 'object' &&
      String((marker as Record<string, unknown>).generatedBy || '').startsWith('spec-memo@')
    );
  } catch {
    return false;
  }
}

function mergeManagedJson(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return deepMergeJson(stripSpecMemoFromHookConfig(existing), patch);
}

function mergeCodexAgents(existing: string, generated: string): string {
  const start = existing.indexOf(CODEX_BLOCK_START);
  const end = existing.indexOf(CODEX_BLOCK_END);
  if (start >= 0 && end >= start) {
    return `${existing.slice(0, start)}${generated.trimEnd()}${existing.slice(end + CODEX_BLOCK_END.length)}`;
  }
  if (!existing) return generated;
  return `${existing.trimEnd()}\n\n${generated}`;
}

function shellHeader(version: string): string {
  return `#!/bin/sh
# ${GENERATED_BY_PREFIX}${version}
# spec-memo fail-open hook (max ${HOOK_TIMEOUT_MS}ms)
SESSION_FILE="${ACTIVE_SESSION_FILE}"
`;
}

function generateSessionStartScript(version: string, memoCommand = 'memo'): string {
  return `${shellHeader(version)}SID="hook-$(date +%s)-$$"
mkdir -p .spec-memo 2>/dev/null || true
echo "$SID" > "$SESSION_FILE" 2>/dev/null || true
timeout 1.5 ${memoCommand} bootstrap >/dev/null 2>&1 || true
timeout 1.5 ${memoCommand} prompt session_start --session-id "$SID" >/dev/null 2>&1 || true
exit 0
`;
}

function generateRecordScript(version: string, body: string, memoCommand = 'memo'): string {
  const escaped = body.replace(/'/g, `'\\''`);
  return `${shellHeader(version)}SID=""
if [ -f "$SESSION_FILE" ]; then SID="$(cat "$SESSION_FILE" 2>/dev/null)"; fi
if [ -z "$SID" ]; then SID="hook-orphan-$$"; fi
timeout 1.5 ${memoCommand} prompt record --session-id "$SID" --body '${escaped}' >/dev/null 2>&1 || true
exit 0
`;
}

function generateSessionEndScript(version: string, memoCommand = 'memo'): string {
  return `${shellHeader(version)}SID=""
if [ -f "$SESSION_FILE" ]; then SID="$(cat "$SESSION_FILE" 2>/dev/null)"; fi
if [ -z "$SID" ]; then exit 0; fi
timeout 1.5 ${memoCommand} prompt session_end --session-id "$SID" >/dev/null 2>&1 || true
rm -f "$SESSION_FILE" 2>/dev/null || true
exit 0
`;
}

export function generateFailOpenShellBody(
  memoArgs: string[],
  version = getPackageVersion(),
  memoCommand = 'memo'
): string {
  const quoted = memoArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  return `${shellHeader(version)}timeout 1.5 ${memoCommand} ${quoted} >/dev/null 2>&1 || true
exit 0
`;
}

function managedHookCommand(prefix: 'bash' | '', relativePath: string): string {
  return prefix ? `${prefix} ${relativePath}` : relativePath;
}

export function generateAntigravityHooksJson(
  version: string,
  options: { global?: boolean; shellHookPrefix?: 'bash' | '' } = {}
): Record<string, unknown> {
  // Prefix shell hooks with `bash` so Windows hosts (Cursor/Antigravity/Claude)
  // execute via Git Bash instead of opening `.sh` as a document. Works on
  // macOS/Linux when `bash` is on PATH (see CROSS-PLATFORM managed-script rule).
  const prefix = options.shellHookPrefix ?? 'bash';
  const hookRoot = options.global ? './hooks' : '.agents/hooks';
  return {
    hooks: {
      PreInvocation: [
        {
          matcher: { invocationNum: 0 },
          command: managedHookCommand(prefix, `${hookRoot}/spec-memo-session-start.sh`)
        }
      ],
      PostInvocation: [
        {
          command: managedHookCommand(prefix, `${hookRoot}/spec-memo-session-end.sh`)
        }
      ]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

export function generateCursorHooksJson(
  version: string,
  options: { global?: boolean; shellHookPrefix?: 'bash' | '' } = {}
): Record<string, unknown> {
  // Same `bash` prefix rationale as Antigravity: Windows Cursor spawns `command`
  // without a POSIX shebang interpreter, so bare `.sh` paths open in an editor.
  const prefix = options.shellHookPrefix ?? 'bash';
  const hookRoot = options.global ? './hooks' : '.cursor/hooks';
  return {
    version: 1,
    hooks: {
      sessionStart: [{ command: managedHookCommand(prefix, `${hookRoot}/spec-memo-bootstrap.sh`), timeout: 1 }],
      beforeSubmitPrompt: [{ command: managedHookCommand(prefix, `${hookRoot}/spec-memo-record.sh`), timeout: 1 }],
      sessionEnd: [{ command: managedHookCommand(prefix, `${hookRoot}/spec-memo-session-end.sh`), timeout: 1 }]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

export function generateClaudeHooksConfig(
  version: string,
  options: { global?: boolean; shellHookPrefix?: 'bash' | '' } = {}
): Record<string, unknown> {
  // Same `bash` prefix rationale: Claude hook runners on Windows hit the same
  // `.sh` file-association limitation as Cursor.
  const prefix = options.shellHookPrefix ?? 'bash';
  const hookRoot = options.global ? './hooks' : '.claude/hooks';
  return {
    hooks: {
      SessionStart: [{ type: 'command', command: managedHookCommand(prefix, `${hookRoot}/spec-memo-bootstrap.sh`) }],
      UserPromptSubmit: [{ type: 'command', command: managedHookCommand(prefix, `${hookRoot}/spec-memo-record.sh`) }],
      PreCompact: [{ type: 'command', command: managedHookCommand(prefix, `${hookRoot}/spec-memo-checkpoint.sh`) }],
      SessionEnd: [{ type: 'command', command: managedHookCommand(prefix, `${hookRoot}/spec-memo-session-end.sh`) }]
    },
    'spec-memo': {
      version,
      generatedBy: `spec-memo@${version}`
    }
  };
}

export function generateCodexAgents(version: string, memoCommand = 'memo'): string {
  return `# spec-memo Codex agent instructions

${CODEX_BLOCK_START}
${GENERATED_BY_PREFIX}${version}

Use the external spec-memo memory during each session. These commands are fail-open
and bounded to ${HOOK_TIMEOUT_MS}ms:

\`timeout 1.5 ${memoCommand} bootstrap >/dev/null 2>&1 || true\`
\`timeout 1.5 ${memoCommand} prompt record --body '[hook-automated turn]' >/dev/null 2>&1 || true\`
\`timeout 1.5 ${memoCommand} prompt session_end >/dev/null 2>&1 || true\`
${CODEX_BLOCK_END}
`;
}

export function generateOpenCodePlugin(
  version: string,
  memoExecutable = 'memo',
  memoArgs: string[] = [],
  memoShell = process.platform === 'win32'
): string {
  return `${GENERATED_BY_PREFIX}${version}
import * as fs from 'node:fs';

const SESSION_FILE = '${ACTIVE_SESSION_FILE}';

function readSessionId() {
  try {
    return fs.readFileSync(SESSION_FILE, 'utf8').trim();
  } catch {
    return \`hook-\${Date.now()}\`;
  }
}

function writeSessionId(id) {
  try {
    fs.mkdirSync('.spec-memo', { recursive: true });
    fs.writeFileSync(SESSION_FILE, id, 'utf8');
  } catch {}
}

async function runMemo(args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(
      ${JSON.stringify(memoExecutable)},
      [...${JSON.stringify(memoArgs)}, ...args],
      { stdio: 'ignore', shell: ${memoShell} }
    );
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve(0);
    }, ${HOOK_TIMEOUT_MS});
    child.on('error', () => { clearTimeout(timer); resolve(0); });
    child.on('close', () => { clearTimeout(timer); resolve(0); });
  });
}

export default {
  name: 'spec-memo',
  async onInit() {
    const sid = \`hook-\${Date.now()}\`;
    writeSessionId(sid);
    await runMemo(['bootstrap']);
    await runMemo(['prompt', 'session_start', '--session-id', sid]);
  },
  async onPrompt() {
    const sid = readSessionId();
    await runMemo(['prompt', 'record', '--session-id', sid, '--body', '[hook-automated turn]']);
  },
  async onExit() {
    const sid = readSessionId();
    await runMemo(['prompt', 'session_end', '--session-id', sid]);
    try { fs.unlinkSync(SESSION_FILE); } catch {}
    await runMemo(['sync']);
  }
};
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
  host: Exclude<HookHostName, 'all'>,
  version: string,
  memoCommand = 'memo'
): Array<{ rel: string; content: string }> {
  switch (host) {
    case 'antigravity':
      return [
        { rel: 'spec-memo-session-start.sh', content: generateSessionStartScript(version, memoCommand) },
        { rel: 'spec-memo-session-end.sh', content: generateSessionEndScript(version, memoCommand) }
      ];
    case 'cursor':
      return [
        { rel: 'spec-memo-bootstrap.sh', content: generateSessionStartScript(version, memoCommand) },
        { rel: 'spec-memo-record.sh', content: generateRecordScript(version, '[hook-automated turn]', memoCommand) },
        { rel: 'spec-memo-session-end.sh', content: generateSessionEndScript(version, memoCommand) }
      ];
    case 'claude':
      return [
        { rel: 'spec-memo-bootstrap.sh', content: generateSessionStartScript(version, memoCommand) },
        { rel: 'spec-memo-record.sh', content: generateRecordScript(version, '[hook-automated turn]', memoCommand) },
        {
          rel: 'spec-memo-checkpoint.sh',
          content: generateRecordScript(version, '[pre-compact checkpoint]', memoCommand)
        },
        { rel: 'spec-memo-session-end.sh', content: generateSessionEndScript(version, memoCommand) }
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
    const before = JSON.stringify(parsed);
    stripSpecMemoFromHookConfig(parsed);
    if (before === JSON.stringify(parsed)) return 'unchanged';
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    return 'removed';
  }
  if (filePath.endsWith('.mdc') || filePath.endsWith('.js')) {
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.includes(GENERATED_BY_PREFIX)) {
      fs.unlinkSync(filePath);
      return 'removed';
    }
  }
  if (filePath.endsWith('.md')) {
    const text = fs.readFileSync(filePath, 'utf8');
    const start = text.indexOf(CODEX_BLOCK_START);
    const end = text.indexOf(CODEX_BLOCK_END);
    if (start >= 0 && end >= start) {
      const cleaned = `${text.slice(0, start)}${text.slice(end + CODEX_BLOCK_END.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd();
      if (cleaned) fs.writeFileSync(filePath, `${cleaned}\n`, 'utf8');
      else fs.unlinkSync(filePath);
      return 'removed';
    }
  }
  return 'unchanged';
}

function buildHostArtifacts(
  host: Exclude<HookHostName, 'all'>,
  version: string,
  options: {
    global?: boolean;
    shellHookPrefix?: 'bash' | '';
    memoCommand?: string;
    memoExecutable?: string;
    memoArgs?: string[];
    memoShell?: boolean;
  } = {}
): Array<{ path: string; content: string; kind: HookPathTarget['kind'] }> {
  const scripts = uniqueScripts(host, version, options.memoCommand);
  const artifacts: Array<{ path: string; content: string; kind: HookPathTarget['kind'] }> = [];

  switch (host) {
    case 'antigravity':
      artifacts.push({
        path: 'hooks.json',
        content: JSON.stringify(generateAntigravityHooksJson(version, options), null, 2) + '\n',
        kind: 'json'
      });
      for (const s of scripts) {
        artifacts.push({ path: s.rel, content: s.content, kind: 'shell' });
      }
      break;
    case 'opencode':
      artifacts.push({
        path: 'spec-memo.js',
        content: generateOpenCodePlugin(
          version,
          options.memoExecutable || options.memoCommand || 'memo',
          options.memoArgs,
          options.memoShell ?? process.platform === 'win32'
        ),
        kind: 'js'
      });
      break;
    case 'cursor':
      if (!options.global) {
        artifacts.push({
          path: 'spec-memo.mdc',
          content: generateCursorRule(version),
          kind: 'mdc'
        });
      }
      artifacts.push({
        path: 'hooks.json',
        content: JSON.stringify(generateCursorHooksJson(version, options), null, 2) + '\n',
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
        content: JSON.stringify(generateClaudeHooksConfig(version, options), null, 2) + '\n',
        kind: 'json'
      });
      break;
    case 'codex':
      artifacts.push({
        path: 'AGENTS.md',
        content: generateCodexAgents(version, options.memoCommand),
        kind: 'md'
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
  if (artifactName === 'hooks.json' || artifactName === 'config.json' || artifactName === 'AGENTS.md') {
    return target.path;
  }
  if (artifactName === 'spec-memo.mdc') {
    return target.path;
  }
  if (artifactName === 'spec-memo.js') {
    return target.path;
  }
  return path.join(target.path, artifactName);
}

export async function installHooks(options: InstallHooksOptions = {}): Promise<InstallHooksResult> {
  const global = options.scope ? options.scope === 'global' : options.global === true;
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const force = options.force === true || options.conflictPolicy === 'force';
  const remove = options.remove === true;
  const version = options.packageVersion || getPackageVersion();
  const preflight = options.preflight || getInstallPreflight();
  const permissionGated = options.scope !== undefined ||
    options.hosts !== undefined ||
    options.conflictPolicy !== undefined;
  const conflictPolicy =
    options.conflictPolicy ||
    (options.force ? 'force' : undefined) ||
    (options.skipExisting ? 'skip' : undefined) ||
    (options.update ? 'update' : undefined) ||
    'update';

  const explicitRoot = options.productRoot?.trim();
  const cwdFallback = options.cwd?.trim() || process.cwd();
  const productRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : global
      ? path.resolve(options.homeDir || os.homedir())
      : resolveProjectIdentity(cwdFallback).rootPath;

  if (permissionGated && apply && !dryRun && options.confirm !== true) {
    throw new Error('Hook installation requires explicit confirmation (confirm: true or --yes).');
  }
  const hosts = resolveHosts(options.host, options.hosts);
  if (apply && !dryRun && !preflight.ok && !force) {
    throw new Error(
      `${preflight.warning || 'Unable to resolve an invocable memo command.'} Pass --force only after explicit confirmation to install fail-open hooks anyway.`
    );
  }
  const results: InstallHooksRow[] = [];

  for (const host of hosts) {
    const targets = resolveHostHookPaths(host, { global, productRoot, homeDir: options.homeDir });
    const artifacts = buildHostArtifacts(host, version, {
      global,
      shellHookPrefix: preflight.shellHookPrefix,
      memoCommand: preflight.memoCommand || 'memo',
      memoExecutable: preflight.memoExecutable,
      memoArgs: preflight.memoArgs,
      memoShell: preflight.memoShell
    });
    const jsonTarget = targets.find((t) => t.kind === 'json');

    for (const artifact of artifacts) {
      let absPath = '';
      if (artifact.kind === 'json' && jsonTarget) {
        absPath = jsonTarget.path;
      } else if (artifact.kind === 'mdc') {
        absPath = targets.find((t) => t.kind === 'mdc')?.path || '';
      } else if (artifact.kind === 'js') {
        absPath = targets.find((t) => t.kind === 'js')?.path || '';
      } else if (artifact.kind === 'md') {
        absPath = targets.find((t) => t.kind === 'md')?.path || '';
      } else if (artifact.kind === 'shell') {
        const dirTarget = targets.find((t) => t.kind === 'dir');
        if (dirTarget) {
          absPath = mapArtifactToAbsolute(host, dirTarget, artifact.path, productRoot);
        }
      }
      if (!absPath) continue;

      const relDisplay = absPath.replace(/\\/g, '/');

      if (remove) {
        if (dryRun) {
          results.push({ host, path: relDisplay, status: 'preview', diff: 'would remove spec-memo hooks' });
          continue;
        }
        const status = artifact.kind === 'shell'
          ? (() => {
              if (!fs.existsSync(absPath)) return 'unchanged' as const;
              const existing = fs.readFileSync(absPath, 'utf8');
              if (!isSpecMemoStamped(existing)) return 'unchanged' as const;
              fs.unlinkSync(absPath);
              return 'removed' as const;
            })()
          : removeSpecMemoBlock(absPath);
        results.push({ host, path: relDisplay, status });
        continue;
      }

      let nextContent = artifact.content;
      if (artifact.kind === 'json' && fs.existsSync(absPath)) {
        const existing = readJsonFile(absPath);
        const patch = JSON.parse(artifact.content) as Record<string, unknown>;
        nextContent = JSON.stringify(mergeManagedJson(existing, patch), null, 2) + '\n';
      } else if (artifact.kind === 'md' && fs.existsSync(absPath)) {
        nextContent = mergeCodexAgents(fs.readFileSync(absPath, 'utf8'), artifact.content);
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

      const existing = fs.existsSync(absPath);
      const identical = before === nextContent;
      if (identical) {
        results.push({ host, path: relDisplay, status: 'unchanged' });
        continue;
      }
      if (existing && conflictPolicy === 'skip') {
        results.push({ host, path: relDisplay, status: 'skipped', diff });
        continue;
      }
      if (
        existing &&
        conflictPolicy === 'update' &&
        !isSpecMemoStamped(before) &&
        artifact.kind !== 'json'
      ) {
        results.push({
          host,
          path: relDisplay,
          status: 'refused',
          diff: 'existing destination is not a spec-memo-generated file'
        });
        continue;
      }
      if (
        existing &&
        conflictPolicy === 'update' &&
        artifact.kind === 'json' &&
        !isSpecMemoStamped(before)
      ) {
        results.push({
          host,
          path: relDisplay,
          status: 'refused',
          diff: 'existing destination is not a spec-memo-generated configuration'
        });
        continue;
      }

      const allowOverwrite = !existing || conflictPolicy === 'force' || conflictPolicy === 'update';
      if (artifact.kind === 'shell') {
        const st = writeFileAtomic(absPath, nextContent, allowOverwrite);
        try {
          fs.chmodSync(absPath, 0o755);
        } catch {
          // Windows may not support chmod
        }
        results.push({ host, path: relDisplay, status: st, diff: diff || undefined });
        continue;
      }

      const st = writeFileAtomic(absPath, nextContent, allowOverwrite);
      results.push({ host, path: relDisplay, status: st, diff: diff || undefined });
    }
  }

  return {
    mode: global ? 'global' : 'local',
    productRoot,
    scope: global ? 'global' : 'local',
    hosts,
    conflictPolicy,
    status: dryRun ? 'preview' : 'applied',
    preflight,
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
        path.join(productRoot, '.cursor', 'hooks.json'),
        path.join(home, '.cursor', 'hooks.json'),
        path.join(home, '.cursor', 'hooks')
      ]
    },
    {
      host: 'claude',
      paths: [
        path.join(productRoot, '.claude', 'config.json'),
        path.join(home, '.claude', 'config.json'),
        path.join(productRoot, '.claude', 'hooks'),
        path.join(home, '.claude', 'hooks')
      ]
    },
    {
      host: 'codex',
      paths: [
        path.join(productRoot, '.codex', 'AGENTS.md'),
        path.join(home, '.codex', 'AGENTS.md')
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
