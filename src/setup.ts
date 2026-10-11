import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DeploymentMode, DshTransport, HostName, SetupOptions, SetupResult, VaultConfig } from './types.js';
import { ensureVaultStructure, getVaultRoot, withVaultLockSync, writeBootstrapVaultRoot } from './vault.js';
import { resolveProjectIdentity } from './identity.js';

export const SUPPORTED_HOSTS: HostName[] = [
  'cursor',
  'vscode',
  'opencode',
  'antigravity',
  'claude',
  'generic',
  'dsh'
];

export const DSH_MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
export const DSH_PATCH_FILENAME = 'cordis.patch.yml';
export const DSH_DEFAULT_HTTP_URL = 'http://127.0.0.1:3123/sse';
export const DSH_PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DSH_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const DSH_AUTH_ENV_VAR = 'SPEC_MEMO_AUTH_TOKEN';

function dshError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export function getDshHome(override?: string): string {
  const raw = (override ?? process.env.DSH_HOME ?? '').trim();
  if (raw.length > 0) {
    return path.resolve(raw);
  }
  return path.join(os.homedir(), '.dsh');
}

export function validateDshProfile(profile: string): void {
  if (!DSH_PROFILE_PATTERN.test(profile)) {
    throw dshError(
      `Invalid DSH profile '${profile}'. Use 1-64 chars of [A-Za-z0-9_-].`,
      'DSH_PROFILE_INVALID'
    );
  }
}

export function validateDshServerName(name: string): void {
  if (!DSH_SERVER_NAME_PATTERN.test(name)) {
    throw dshError(
      `Invalid DSH serverName '${name}'. Use 1-32 chars of [A-Za-z0-9_-].`,
      'DSH_SERVER_NAME_INVALID'
    );
  }
}

export function validateDshTransport(value: string): asserts value is DshTransport {
  if (value !== 'stdio' && value !== 'streamable-http') {
    throw dshError(
      `Invalid DSH transport '${value}'. Supported: stdio, streamable-http.`,
      'DSH_TRANSPORT_INVALID'
    );
  }
}

export function resolveDshPatchPath(profile: string, dshHome?: string): string {
  if (!profile || profile.trim().length === 0) {
    throw dshError('DSH profile is required. Pass --profile <name>.', 'DSH_PROFILE_REQUIRED');
  }
  const clean = profile.trim();
  validateDshProfile(clean);
  const base = getDshHome(dshHome);
  return path.join(base, 'profiles', clean, DSH_PATCH_FILENAME);
}

export function getDshServerName(override?: string): string {
  const raw = (override ?? 'spec-memo').trim();
  if (raw.length === 0) {
    return 'spec-memo';
  }
  validateDshServerName(raw);
  return raw;
}

function yamlScalar(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./@+-]+$/.test(value) && !value.includes('://')) {
    return value;
  }
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function yamlQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface DshPatchConfigStdio {
  serverName: string;
  transport: 'stdio';
  command: string;
  args: string[];
  cwd: string;
}

export interface DshPatchConfigHttp {
  serverName: string;
  transport: 'streamable-http';
  url: string;
  headers: { Authorization: string };
}

export interface DshPatchEntry {
  id: string;
  name: string;
  config: DshPatchConfigStdio | DshPatchConfigHttp;
}

export type DshPatch = Array<{ insert: DshPatchEntry[] }>;

export interface DshSnippetOptions {
  vaultRoot?: string;
  cwd?: string;
  projectRoot?: string;
  transport?: string;
  url?: string;
  serverName?: string;
}

export function resolveDshCwd(opts: { projectRoot?: string; cwd?: string; vaultRoot?: string }): {
  cwd: string;
  warnings: string[];
  projectId: string;
  isFallback: boolean;
} {
  const warnings: string[] = [];
  if (opts.projectRoot !== undefined) {
    const raw = opts.projectRoot.trim();
    if (raw.length === 0) {
      throw dshError('Invalid project root: empty path.', 'DSH_PROJECT_ROOT_INVALID');
    }
    const resolved = path.resolve(raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw dshError(`Invalid project root '${opts.projectRoot}': path does not exist.`, 'DSH_PROJECT_ROOT_INVALID');
    }
    if (!stat.isDirectory()) {
      throw dshError(`Invalid project root '${opts.projectRoot}': not a directory.`, 'DSH_PROJECT_ROOT_INVALID');
    }
    let identity: { rootPath: string; projectId: string; isFallback: boolean };
    try {
      identity = resolveProjectIdentity(resolved, { vaultRoot: opts.vaultRoot });
    } catch {
      identity = { rootPath: resolved, projectId: 'local-unknown', isFallback: true };
    }
    const cwd = path.resolve(identity.rootPath);
    if (identity.isFallback) {
      warnings.push(
        `vault operations will bind to a fallback project (${identity.projectId}); pass --project-root <path> to bind the workspace project`
      );
    }
    return { cwd, warnings, projectId: identity.projectId, isFallback: identity.isFallback };
  }
  const probe = (opts.cwd ?? process.cwd()).trim() || process.cwd();
  let identity: { rootPath: string; projectId: string; isFallback: boolean };
  try {
    identity = resolveProjectIdentity(probe, { vaultRoot: opts.vaultRoot });
  } catch {
    const fallback = path.resolve(probe);
    identity = { rootPath: fallback, projectId: 'local-unknown', isFallback: true };
  }
  const cwd = path.resolve(identity.rootPath);
  if (identity.isFallback) {
    warnings.push(
      `vault operations will bind to a fallback project (${identity.projectId}); pass --project-root <path> to bind the workspace project`
    );
  }
  return { cwd, warnings, projectId: identity.projectId, isFallback: identity.isFallback };
}

export function generateDshPatchObject(params: {
  serverName: string;
  transport: DshTransport;
  cwd?: string;
  command?: string;
  args?: string[];
  url?: string;
}): DshPatch {
  const serverName = getDshServerName(params.serverName);
  validateDshTransport(params.transport);
  const id = `mcp-${serverName}`;
  if (params.transport === 'streamable-http') {
    const url = (params.url ?? DSH_DEFAULT_HTTP_URL).trim() || DSH_DEFAULT_HTTP_URL;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw dshError(`Invalid DSH url '${url}': must include http:// or https://.`, 'DSH_URL_INVALID');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw dshError(`Invalid DSH url protocol '${parsed.protocol}': only http:// and https:// are supported.`, 'DSH_URL_INVALID');
    }
    return [
      {
        insert: [
          {
            id,
            name: DSH_MCP_CLIENT_NAME,
            config: {
              serverName,
              transport: 'streamable-http',
              url,
              headers: { Authorization: '!!js process.env.SPEC_MEMO_AUTH_TOKEN' }
            }
          }
        ]
      }
    ];
  }
  const command = (params.command ?? 'memo').trim() || 'memo';
  const args = stripStatusAutostartArgs(params.args ?? ['serve']);
  const cwd = params.cwd ? path.resolve(params.cwd) : path.resolve(process.cwd());
  return [
    {
      insert: [
        {
          id,
          name: DSH_MCP_CLIENT_NAME,
          config: { serverName, transport: 'stdio', command, args, cwd }
        }
      ]
    }
  ];
}

export function serializeDshPatch(patch: DshPatch): string {
  const lines: string[] = [];
  for (const doc of patch) {
    lines.push('- insert:');
    for (const item of doc.insert) {
      lines.push(`    - id: ${yamlScalar(item.id)}`);
      lines.push(`      name: ${yamlQuoted(item.name)}`);
      lines.push('      config:');
      lines.push(`        serverName: ${yamlScalar(item.config.serverName)}`);
      lines.push(`        transport: ${yamlScalar(item.config.transport)}`);
      if (item.config.transport === 'stdio') {
        const stdio = item.config;
        lines.push(`        command: ${yamlScalar(stdio.command)}`);
        const argList = stdio.args.map((a) => yamlQuoted(a)).join(', ');
        lines.push(`        args: [${argList}]`);
        lines.push(`        cwd: ${yamlScalar(stdio.cwd)}`);
      } else {
        const http = item.config;
        lines.push(`        url: ${yamlScalar(http.url)}`);
        lines.push('        headers:');
        lines.push('          Authorization: !!js process.env.SPEC_MEMO_AUTH_TOKEN');
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function generateDshPatch(params: {
  serverName: string;
  transport: DshTransport;
  cwd?: string;
  command?: string;
  args?: string[];
  url?: string;
}): string {
  return serializeDshPatch(generateDshPatchObject(params));
}

/**
 * Normalizes remote daemon URL to origin only (scheme + host + port).
 * Strips /sse, /message, trailing slashes, queries.
 */
export function normalizeRemoteUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('Remote URL must be a non-empty string.');
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid remote URL '${trimmed}': must include http:// or https:// scheme and valid host.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid remote URL protocol '${parsed.protocol}': only http:// and https:// are supported.`);
  }

  return parsed.origin;
}

export function isTokenConfigured(tokenOverride?: string): boolean {
  if (tokenOverride && tokenOverride.trim().length > 0) {
    return true;
  }
  const envToken = process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_SSE_TOKEN;
  return Boolean(envToken && envToken.trim().length > 0);
}

export function getResolvedAuthToken(tokenOverride?: string): string | undefined {
  if (tokenOverride && tokenOverride.trim().length > 0) {
    return tokenOverride.trim();
  }
  const envToken = process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_SSE_TOKEN;
  return envToken && envToken.trim().length > 0 ? envToken.trim() : undefined;
}

export function resolveHostConfigPath(host: HostName, profile?: string, dshHome?: string): string {
  const normalized = (host as string).toLowerCase() as HostName;
  if (normalized === 'dsh') {
    return resolveDshPatchPath(profile ?? '', dshHome);
  }
  switch (host) {
    case 'cursor':
      return path.join(os.homedir(), '.cursor', 'mcp.json');
    case 'vscode':
      return path.join(os.homedir(), '.vscode', 'mcp.json');
    case 'opencode':
      return path.join(os.homedir(), '.config', 'opencode', 'config.json');
    case 'antigravity':
      return path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
    case 'claude':
      if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    case 'generic':
    default:
      return path.join(os.homedir(), '.mcp', 'mcp_config.json');
  }
}

/**
 * Stdio host MCP config MUST NOT auto-start the :3124 status monitor.
 * Every editor window spawns its own `memo serve`, so a fixed status port
 * collides (EADDRINUSE) once more than one window is open. The companion is
 * opt-in via `memo serve --sse`, never via per-window host MCP args.
 */
export function stripStatusAutostartArgs(args: string[]): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--status' || arg === '--no-status') {
      continue;
    }
    if (arg === '--status-port') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--status-port=')) {
      continue;
    }
    cleaned.push(arg);
  }
  return cleaned;
}

/**
 * Generate host-specific MCP configuration snippet.
 * OpenCode uses `type: "local"` + `command: string[]` (McpLocalConfig);
 * all other stdio hosts use `command: string` + `args: string[]`.
 */
export function generateHostMcpSnippet(
  host: HostName,
  command: string = 'memo',
  args: string[] = ['serve'],
  options: DshSnippetOptions = {}
): Record<string, unknown> | string {
  const normalizedHost = (host as string).toLowerCase() as HostName;
  if (!SUPPORTED_HOSTS.includes(normalizedHost)) {
    throw new Error(`Unsupported host '${host}'. Supported hosts: ${SUPPORTED_HOSTS.join(', ')}`);
  }

  if (normalizedHost === 'dsh') {
    const transportRaw = ((options.transport ?? 'stdio') as string).trim() || 'stdio';
    validateDshTransport(transportRaw);
    const serverName = getDshServerName(options.serverName);
    const safeArgs = stripStatusAutostartArgs(args);
    if (transportRaw === 'streamable-http') {
      const url = ((options.url ?? DSH_DEFAULT_HTTP_URL).trim() || DSH_DEFAULT_HTTP_URL);
      return generateDshPatch({ serverName, transport: 'streamable-http', url });
    }
    let cwd: string;
    if (options.projectRoot !== undefined) {
      const raw = options.projectRoot.trim();
      if (raw.length === 0) {
        throw dshError('Invalid project root: empty path.', 'DSH_PROJECT_ROOT_INVALID');
      }
      const resolved = path.resolve(raw);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw dshError(`Invalid project root '${options.projectRoot}': path does not exist.`, 'DSH_PROJECT_ROOT_INVALID');
      }
      if (!stat.isDirectory()) {
        throw dshError(`Invalid project root '${options.projectRoot}': not a directory.`, 'DSH_PROJECT_ROOT_INVALID');
      }
      try {
        const identity = resolveProjectIdentity(resolved, { vaultRoot: options.vaultRoot });
        cwd = path.resolve(identity.rootPath);
      } catch {
        cwd = resolved;
      }
    } else if (options.cwd !== undefined && options.cwd.trim().length > 0) {
      try {
        const identity = resolveProjectIdentity(options.cwd, { vaultRoot: options.vaultRoot });
        cwd = path.resolve(identity.rootPath);
      } catch {
        cwd = path.resolve(options.cwd);
      }
    } else {
      try {
        const identity = resolveProjectIdentity(process.cwd(), { vaultRoot: options.vaultRoot });
        cwd = path.resolve(identity.rootPath);
      } catch {
        cwd = path.resolve(process.cwd());
      }
    }
    return generateDshPatch({ serverName, transport: 'stdio', cwd, command, args: safeArgs });
  }

  const safeArgs = stripStatusAutostartArgs(args);

  switch (normalizedHost) {
    case 'cursor':
      return {
        mcpServers: {
          'spec-memo': {
            command,
            args: safeArgs
          }
        }
      };
    case 'vscode':
      return {
        servers: {
          'spec-memo': {
            command,
            args: safeArgs
          }
        }
      };
    case 'opencode': {
      const fullCommand = [command, ...safeArgs];
      const vaultRoot = options.vaultRoot?.trim();
      const defaultRoot = path.join(os.homedir(), '.spec-memo');
      const isNonDefault =
        Boolean(vaultRoot) && path.resolve(vaultRoot as string) !== path.resolve(defaultRoot);
      if (isNonDefault) {
        const root = vaultRoot as string;
        return {
          mcp: {
            'spec-memo': {
              type: 'local',
              command: [...fullCommand, '--vaultRoot', root],
              enabled: true,
              environment: {
                SPEC_MEMO_ROOT: root
              }
            }
          }
        };
      }
      return {
        mcp: {
          'spec-memo': {
            type: 'local',
            command: fullCommand,
            enabled: true
          }
        }
      };
    }
    case 'antigravity':
    case 'claude':
    case 'generic':
    default:
      return {
        mcpServers: {
          'spec-memo': {
            command,
            args: safeArgs
          }
        }
      };
  }
}

export interface WriteDshOptions {
  profile?: string;
  dshHome?: string;
  patchPath?: string;
  serverName?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDshSnippetToYaml(
  snippet: Record<string, unknown> | string | unknown[],
  serverNameFallback?: string
): { yaml: string; serverId: string } {
  if (typeof snippet === 'string') {
    const yaml = snippet.endsWith('\n') ? snippet : snippet + '\n';
    const m = yaml.match(/id:\s*['"]?(mcp-[A-Za-z0-9_-]+)['"]?/);
    const serverId = m ? m[1] : `mcp-${getDshServerName(serverNameFallback)}`;
    return { yaml, serverId };
  }
  if (Array.isArray(snippet)) {
    const patch = snippet as DshPatch;
    const yaml = serializeDshPatch(patch);
    const first = patch[0]?.insert?.[0];
    const serverId = first?.id ?? `mcp-${getDshServerName(serverNameFallback)}`;
    return { yaml, serverId };
  }
  if (snippet !== null && typeof snippet === 'object') {
    const rec = snippet as Record<string, unknown>;
    if (typeof rec.patch === 'string') {
      const yaml = (rec.patch as string).endsWith('\n') ? (rec.patch as string) : (rec.patch as string) + '\n';
      const m = yaml.match(/id:\s*['"]?(mcp-[A-Za-z0-9_-]+)['"]?/);
      const serverId = m ? m[1] : `mcp-${getDshServerName(serverNameFallback)}`;
      return { yaml, serverId };
    }
    const json = JSON.stringify(rec);
    const m = json.match(/mcp-[A-Za-z0-9_-]+/);
    const serverId = m ? m[0] : `mcp-${getDshServerName(serverNameFallback)}`;
    throw dshError(
      `Unsupported DSH snippet object shape for merge (missing patch YAML for ${serverId}).`,
      'DSH_SNIPPET_INVALID'
    );
  }
  throw dshError('Unsupported DSH snippet shape for merge.', 'DSH_SNIPPET_INVALID');
}

function findDshEntrySpan(
  lines: string[],
  serverId: string
): { startLine: number; coreEndLine: number; endLine: number } | null {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('- ')) {
      starts.push(i);
    }
  }
  if (starts.length === 0) {
    return null;
  }
  const idRe = new RegExp(`id:\\s*['"]?${escapeRegExp(serverId)}['"]?`);
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(start, end).join('\n');
    if (idRe.test(block)) {
      let coreEnd = end;
      while (coreEnd - 1 > start && lines[coreEnd - 1].trim() === '') {
        coreEnd -= 1;
      }
      return { startLine: start, coreEndLine: coreEnd, endLine: end };
    }
  }
  return null;
}

export function writeDshPatchConfig(
  snippet: Record<string, unknown> | string | unknown[],
  dshOptions: WriteDshOptions = {}
): { configPath: string; written: boolean; alreadyConfigured?: boolean } {
  let patchPath: string;
  if (dshOptions.patchPath) {
    patchPath = path.resolve(dshOptions.patchPath);
    if (dshOptions.profile !== undefined) {
      if (dshOptions.profile.trim().length === 0) {
        throw dshError('DSH profile is required. Pass --profile <name>.', 'DSH_PROFILE_REQUIRED');
      }
      validateDshProfile(dshOptions.profile.trim());
    }
  } else {
    if (!dshOptions.profile || dshOptions.profile.trim().length === 0) {
      throw dshError('DSH profile is required. Pass --profile <name>.', 'DSH_PROFILE_REQUIRED');
    }
    patchPath = resolveDshPatchPath(dshOptions.profile, dshOptions.dshHome);
  }
  const { yaml, serverId } = normalizeDshSnippetToYaml(snippet, dshOptions.serverName);
  const newBlock = yaml.trim() + '\n';
  const dir = path.dirname(patchPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(patchPath)) {
    fs.writeFileSync(patchPath, newBlock, 'utf8');
    return { configPath: patchPath, written: true };
  }
  const existing = fs.readFileSync(patchPath, 'utf8');
  if (existing.trim().length === 0) {
    fs.writeFileSync(patchPath, newBlock, 'utf8');
    return { configPath: patchPath, written: true };
  }
  const lines = existing.split('\n');
  const span = findDshEntrySpan(lines, serverId);
  if (!span) {
    let next = existing;
    if (next.endsWith('\n\n')) {
      next = next + newBlock;
    } else if (next.endsWith('\n')) {
      next = next + '\n' + newBlock;
    } else {
      next = next + '\n\n' + newBlock;
    }
    fs.writeFileSync(patchPath, next, 'utf8');
    return { configPath: patchPath, written: true };
  }
  const coreBlock = lines.slice(span.startLine, span.coreEndLine).join('\n').trim() + '\n';
  if (coreBlock.trim() === newBlock.trim()) {
    return { configPath: patchPath, written: false, alreadyConfigured: true };
  }
  // Replace exactly the entry span by byte offset so every unrelated byte
  // (including separators and trailing blank lines) is preserved verbatim.
  // Offsets are exact for both LF and CRLF inputs: split('\n') keeps '\r'
  // inside each line, and each line contributes length + 1 bytes.
  const lineOffsets: number[] = [0];
  let acc = 0;
  for (const line of lines) {
    acc += line.length + 1;
    lineOffsets.push(acc);
  }
  const startOffset = lineOffsets[span.startLine] ?? 0;
  const coreEndOffset = lineOffsets[span.coreEndLine] ?? existing.length;
  const rebuilt = existing.slice(0, startOffset) + newBlock.trim() + '\n' + existing.slice(coreEndOffset);
  fs.writeFileSync(patchPath, rebuilt, 'utf8');
  return { configPath: patchPath, written: true };
}

export type DshSpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: { encoding: string; timeout: number }
) => { status: number | null; stdout: unknown; stderr: unknown; error?: { code?: string; message?: string } };

export function verifyDshPatch(
  profile: string,
  patchPath: string,
  serverId: string,
  spawnFn?: DshSpawnSyncFn
): void {
  if (!profile || profile.trim().length === 0) {
    throw dshError('DSH profile is required. Pass --profile <name>.', 'DSH_PROFILE_REQUIRED');
  }
  validateDshProfile(profile.trim());
  const run: DshSpawnSyncFn =
    spawnFn ??
    ((cmd: string, args: string[], opts: { encoding: string; timeout: number }) => {
      const res = spawnSync(cmd, args, { encoding: opts.encoding as BufferEncoding, timeout: opts.timeout });
      const err = res.error as { code?: string; message?: string } | undefined;
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        ...(err ? { error: { code: (err as { code?: string }).code, message: err.message } } : {})
      };
    });
  let result: { status: number | null; stdout: unknown; stderr: unknown; error?: { code?: string; message?: string } };
  try {
    result = run('dsh', ['--profile', profile.trim(), '--patch', patchPath, '--dump-config'], {
      encoding: 'utf8',
      timeout: 15000
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw dshError('DSH CLI not found. Install DeepSeek Harness 0.2 or later.', 'DSH_CLI_NOT_FOUND');
    }
    throw dshError(
      `DSH verification failed for profile '${profile}': ${err instanceof Error ? err.message : String(err)}`,
      'DSH_VERIFY_FAILED'
    );
  }
  if (result.error && result.error.code === 'ENOENT') {
    throw dshError('DSH CLI not found. Install DeepSeek Harness 0.2 or later.', 'DSH_CLI_NOT_FOUND');
  }
  if (result.error) {
    throw dshError(
      `DSH verification failed for profile '${profile}': ${result.error.message ?? 'spawn failed'}`,
      'DSH_VERIFY_FAILED'
    );
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? '');
  const notFoundRe = new RegExp(`entry\\s+"${escapeRegExp(serverId)}"\\s+not found`);
  if (notFoundRe.test(stderr)) {
    throw dshError(
      `DSH verification failed: patch entry "${serverId}" not found (missing insert wrapper?).`,
      'DSH_VERIFY_FAILED'
    );
  }
  if (!stdout.includes(serverId)) {
    throw dshError(
      `DSH verification failed: composed config does not contain "${serverId}".`,
      'DSH_VERIFY_FAILED'
    );
  }
  if (result.status !== 0) {
    throw dshError(`DSH verification failed with exit code ${String(result.status)}.`, 'DSH_VERIFY_FAILED');
  }
}

/**
 * Merges host snippet into existing host configuration file.
 */
export function writeHostMcpConfig(
  host: HostName,
  snippet: Record<string, unknown> | string,
  dshOptions: WriteDshOptions = {}
): { configPath: string; written: boolean; alreadyConfigured?: boolean } {
  const normalized = (host as string).toLowerCase() as HostName;
  if (normalized === 'dsh') {
    return writeDshPatchConfig(snippet, dshOptions);
  }
  const configPath = resolveHostConfigPath(host);
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let merged: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      merged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      merged = {};
    }
  }

  const snippetRecord = snippet as Record<string, unknown>;
  for (const [key, value] of Object.entries(snippetRecord)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      merged[key] = {
        ...(typeof merged[key] === 'object' && merged[key] !== null ? (merged[key] as Record<string, unknown>) : {}),
        ...value
      };
    } else {
      merged[key] = value;
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
  return { configPath, written: true };
}

function promptRemoteUrlLine(): string {
  process.stdout.write('Remote daemon URL (http://host:port): ');
  const buf = Buffer.alloc(4096);
  const bytes = fs.readSync(0, buf, 0, 4096, null);
  return buf.toString('utf8', 0, bytes).trim();
}

function resolveRemoteUrlForMode(
  targetMode: DeploymentMode,
  rawUrl: string | undefined,
  options: SetupOptions
): string | undefined {
  if (targetMode !== 'hybrid' && targetMode !== 'remote') {
    if (rawUrl && rawUrl.trim().length > 0) {
      return normalizeRemoteUrl(rawUrl);
    }
    return undefined;
  }

  let resolved = rawUrl?.trim();
  if (!resolved) {
    if (options.urlPrompt) {
      resolved = options.urlPrompt()?.trim();
    } else {
      const isInteractive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
      if (isInteractive) {
        resolved = promptRemoteUrlLine();
      }
    }
  }

  if (!resolved) {
    throw new Error(`Remote URL (--url) is required when mode is '${targetMode}'.`);
  }

  return normalizeRemoteUrl(resolved);
}

/**
 * Configure spec-memo deployment mode and remote daemon wiring.
 */
export function runSetup(options: SetupOptions = {}): SetupResult {
  let bootstrapConfigPath: string | undefined;
  let defaultVaultRoot: string | undefined;

  if (options.defaultVaultRoot && options.defaultVaultRoot.trim().length > 0) {
    defaultVaultRoot = path.resolve(options.defaultVaultRoot.trim());
    bootstrapConfigPath = writeBootstrapVaultRoot(defaultVaultRoot);
  }

  const vaultRoot = getVaultRoot(options.vaultRoot || defaultVaultRoot);
  const configPath = path.join(vaultRoot, 'config.json');

  return withVaultLockSync(vaultRoot, () => {
    const existing = ensureVaultStructure(vaultRoot);

    const targetMode: DeploymentMode = options.mode || existing.mode || 'local';
    if (!['local', 'hybrid', 'remote'].includes(targetMode)) {
      throw new Error(`Invalid mode '${targetMode}'. Supported modes: local, hybrid, remote.`);
    }

    let normalizedUrl: string | undefined;
    const isDshHttpLocal =
      String(options.host ?? '').toLowerCase() === 'dsh' &&
      String(options.transport ?? 'stdio').trim() === 'streamable-http' &&
      (options.mode || existing.mode || 'local') === 'local';
    const rawUrl = isDshHttpLocal ? existing.remote?.url : options.url || existing.remote?.url;

    try {
      normalizedUrl = resolveRemoteUrlForMode(targetMode, rawUrl, options);
    } catch (err) {
      if (targetMode === 'local' && rawUrl && rawUrl.trim().length > 0) {
        try {
          normalizedUrl = normalizeRemoteUrl(rawUrl);
        } catch {
          // In local mode, ignore invalid URL if not explicitly changing
        }
      } else {
        throw err;
      }
    }

    const updatedConfig: VaultConfig = {
      ...existing,
      mode: targetMode
    };

    if (defaultVaultRoot) {
      updatedConfig.vaultRoot = defaultVaultRoot;
    }

    if (normalizedUrl) {
      updatedConfig.remote = { url: normalizedUrl };
    } else if (targetMode === 'local' && existing.remote && (!options.url || isDshHttpLocal)) {
      updatedConfig.remote = existing.remote;
    }

    // Persist configuration update (NEVER write auth tokens)
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');

    const tokenConfigured = isTokenConfigured(options.authToken);

    // Host MCP snippet handling
    let hostSnippet: Record<string, unknown> | string | undefined;
    let hostConfigPath: string | undefined;
    let writtenMcp = false;
    let dshProfile: string | undefined;
    let dshPatchPath: string | undefined;
    let dshAlreadyConfigured = false;
    let dshWarnings: string[] | undefined;

    if (options.host) {
      const host = String(options.host).toLowerCase() as HostName;
      if (!SUPPORTED_HOSTS.includes(host)) {
        throw new Error(`Unsupported host '${options.host}'. Supported hosts: ${SUPPORTED_HOSTS.join(', ')}`);
      }
      if (host === 'dsh') {
        const transportRaw = String(options.transport ?? 'stdio').trim() || 'stdio';
        validateDshTransport(transportRaw);
        const serverName = getDshServerName(options.serverName);
        const serverId = `mcp-${serverName}`;
        if (options.writeMcp) {
          if (!options.profile || options.profile.trim().length === 0) {
            throw dshError('DSH profile is required. Pass --profile <name>.', 'DSH_PROFILE_REQUIRED');
          }
          validateDshProfile(options.profile.trim());
        } else if (options.profile !== undefined && options.profile.trim().length > 0) {
          validateDshProfile(options.profile.trim());
        }
        const cwdRes = resolveDshCwd({ projectRoot: options.projectRoot, cwd: options.cwd, vaultRoot });
        const warnings: string[] = [...cwdRes.warnings];
        let snippetUrl: string | undefined;
        if (transportRaw === 'streamable-http') {
          const rawOpt = options.url?.trim();
          if (rawOpt && rawOpt.length > 0) {
            snippetUrl = rawOpt;
          } else {
            snippetUrl = DSH_DEFAULT_HTTP_URL;
            warnings.push(
              `using default URL ${DSH_DEFAULT_HTTP_URL}; pass --url <http(s)://host:port/path> to override`
            );
          }
        }
        const yaml = generateHostMcpSnippet(host, 'memo', ['serve'], {
          vaultRoot,
          transport: transportRaw,
          url: snippetUrl,
          serverName,
          projectRoot: options.projectRoot,
          cwd: options.cwd ?? cwdRes.cwd
        }) as string;
        hostSnippet = yaml;
        if (options.profile && options.profile.trim().length > 0) {
          dshProfile = options.profile.trim();
          dshPatchPath = resolveDshPatchPath(dshProfile, options.dshHome);
          hostConfigPath = dshPatchPath;
        }
        dshWarnings = warnings.length > 0 ? warnings : undefined;

        if (options.writeMcp) {
          const profile = dshProfile as string;
          const patchPath = dshPatchPath as string;
          let merge: { configPath: string; written: boolean; alreadyConfigured?: boolean };
          try {
            merge = writeDshPatchConfig(yaml, {
              profile,
              dshHome: options.dshHome,
              patchPath,
              serverName
            });
          } catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (typeof code === 'string') {
              throw err;
            }
            throw err;
          }
          hostConfigPath = merge.configPath;
          dshPatchPath = merge.configPath;
          try {
            verifyDshPatch(profile, merge.configPath, serverId, options.dshSpawnSync);
          } catch (err: unknown) {
            const verifyErr = err as Error & { code?: string; partialResult?: SetupResult };
            if (!verifyErr.partialResult) {
              verifyErr.partialResult = {
                mode: targetMode,
                remoteUrl: normalizedUrl,
                tokenConfigured,
                configPath,
                hostSnippet,
                hostConfigPath,
                writtenMcp: false,
                profile,
                patchPath: merge.configPath,
                warnings: dshWarnings
              };
            }
            throw verifyErr;
          }
          if (merge.alreadyConfigured) {
            dshAlreadyConfigured = true;
            writtenMcp = false;
          } else {
            writtenMcp = true;
          }
        }
      } else {
        hostSnippet = generateHostMcpSnippet(host, 'memo', ['serve'], { vaultRoot });
        hostConfigPath = resolveHostConfigPath(host);

        if (options.writeMcp) {
          writeHostMcpConfig(host, hostSnippet as Record<string, unknown>);
          writtenMcp = true;
        }
      }
    }

    // Check token presence after saving configuration (AC5)
    if ((targetMode === 'hybrid' || targetMode === 'remote') && !tokenConfigured) {
      const tokenError = new Error(
        `Bearer token not found in environment for mode '${targetMode}'. Set SPEC_MEMO_AUTH_TOKEN or SPEC_MEMO_SSE_TOKEN.`
      );
      (tokenError as Error & { code?: string; partialResult?: SetupResult }).partialResult = {
        mode: targetMode,
        remoteUrl: normalizedUrl,
        tokenConfigured: false,
        configPath,
        hostSnippet,
        hostConfigPath,
        writtenMcp,
        ...(dshProfile ? { profile: dshProfile } : {}),
        ...(dshPatchPath ? { patchPath: dshPatchPath } : {}),
        ...(dshWarnings ? { warnings: dshWarnings } : {}),
        ...(dshAlreadyConfigured ? { alreadyConfigured: true } : {})
      };
      (tokenError as Error & { code?: string }).code = 'SETUP_ERROR';
      throw tokenError;
    }

    if (dshProfile !== undefined || dshPatchPath !== undefined || dshWarnings !== undefined || dshAlreadyConfigured) {
      return {
        mode: targetMode,
        remoteUrl: normalizedUrl,
        tokenConfigured,
        configPath,
        bootstrapConfigPath,
        defaultVaultRoot,
        hostSnippet,
        hostConfigPath,
        writtenMcp,
        ...(dshProfile ? { profile: dshProfile } : {}),
        ...(dshPatchPath ? { patchPath: dshPatchPath } : {}),
        ...(dshAlreadyConfigured ? { alreadyConfigured: true } : {}),
        ...(dshWarnings ? { warnings: dshWarnings } : {}),
        message: dshAlreadyConfigured
          ? 'spec-memo MCP already configured for DSH profile.'
          : `spec-memo configured successfully in '${targetMode}' mode.`
      };
    }

    return {
      mode: targetMode,
      remoteUrl: normalizedUrl,
      tokenConfigured,
      configPath,
      bootstrapConfigPath,
      defaultVaultRoot,
      hostSnippet,
      hostConfigPath,
      writtenMcp,
      message: `spec-memo configured successfully in '${targetMode}' mode.`
    };
  });
}
