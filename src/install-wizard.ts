import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';

export const INSTALL_SCOPES = ['local', 'global'] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export const CONFLICT_POLICIES = ['skip', 'update', 'force'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export const INSTALL_HOSTS = ['cursor', 'antigravity', 'codex', 'opencode', 'claude'] as const;
export type InstallHost = (typeof INSTALL_HOSTS)[number];

export const HOST_ALIASES: Record<string, InstallHost> = {
  gemini: 'antigravity',
  google: 'antigravity',
  gpt: 'codex',
  openai: 'codex',
  'claude-code': 'claude'
};

export interface InstallPreflight {
  ok: boolean;
  platform: 'win32' | 'linux' | 'darwin';
  memoCommand: string | null;
  memoExecutable?: string;
  memoArgs?: string[];
  memoShell?: boolean;
  shellHookPrefix: 'bash' | '';
  chmodAttempted: boolean;
  warning?: string;
}

export interface InstallWizardSelection {
  scope: InstallScope;
  conflictPolicy: ConflictPolicy;
  hosts: InstallHost[];
  confirmed: boolean;
  preflight: InstallPreflight;
}

export function canonicalInstallHost(value: string): InstallHost {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') {
    throw new Error(
      `Host 'all' is only valid with explicit confirmation. Supported hosts: ${INSTALL_HOSTS.join(', ')}; aliases: ${Object.keys(HOST_ALIASES).join(', ')}`
    );
  }
  const host = (INSTALL_HOSTS as readonly string[]).includes(normalized)
    ? (normalized as InstallHost)
    : HOST_ALIASES[normalized];
  if (!host) {
    throw new Error(
      `Unsupported hook host '${value}'. Supported hosts: ${INSTALL_HOSTS.join(', ')}; aliases: ${Object.keys(HOST_ALIASES).join(', ')}`
    );
  }
  return host;
}

export function normalizeInstallHosts(
  value: string | string[] | undefined,
  options: { allowAll?: boolean } = {}
): InstallHost[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const tokens = values.flatMap((item) => item.split(',').map((part) => part.trim())).filter(Boolean);
  if (tokens.some((token) => token.toLowerCase() === 'all')) {
    if (!options.allowAll) {
      throw new Error(
        `Host 'all' requires explicit confirmation (--yes/--confirm). Supported hosts: ${INSTALL_HOSTS.join(', ')}`
      );
    }
    return [...INSTALL_HOSTS];
  }
  return [...new Set(tokens.map(canonicalInstallHost))];
}

export function normalizeConflictPolicy(
  value: string | undefined,
  options: { force?: boolean; skipExisting?: boolean; update?: boolean } = {}
): ConflictPolicy | undefined {
  if (options.force) return 'force';
  if (options.skipExisting) return 'skip';
  if (options.update) return 'update';
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if ((CONFLICT_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as ConflictPolicy;
  }
  throw new Error(`Unknown conflict policy '${value}'. Supported policies: ${CONFLICT_POLICIES.join(', ')}`);
}

function commandOnPath(name: string, platform: string, pathEnv?: string): string | undefined {
  const lookup = platform === 'win32' ? 'where' : 'which';
  const env = pathEnv === undefined
    ? undefined
    : { ...process.env, PATH: pathEnv, Path: pathEnv };
  const result = spawnSync(lookup, [name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(env ? { env } : {})
  });
  if (result.status === 0) {
    const resolved = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (resolved) return resolved;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface MemoInvocation {
  shellCommand: string;
  executable: string;
  args: string[];
  shell: boolean;
}

function resolveMemoInvocation(options: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  cliPath?: string;
} = {}): MemoInvocation | null {
  const platform = options.platform || process.platform;
  if (commandOnPath('memo', platform, options.pathEnv)) {
    return {
      shellCommand: 'memo',
      executable: 'memo',
      args: [],
      shell: platform === 'win32'
    };
  }
  const cliPath = options.cliPath ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  if (!fs.existsSync(cliPath)) return null;
  return {
    shellCommand: `${shellQuote(process.execPath)} ${shellQuote(cliPath)}`,
    executable: process.execPath,
    args: [cliPath],
    shell: false
  };
}

export function resolveMemoCommand(options: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  cliPath?: string;
} = {}): string | null {
  return resolveMemoInvocation(options)?.shellCommand || null;
}

export function getInstallPreflight(options: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  cliPath?: string;
} = {}): InstallPreflight {
  const rawPlatform = options.platform || process.platform;
  const platform =
    rawPlatform === 'win32' || rawPlatform === 'darwin' || rawPlatform === 'linux'
      ? rawPlatform
      : 'linux';
  const memoInvocation = resolveMemoInvocation({
    platform: rawPlatform,
    pathEnv: options.pathEnv,
    cliPath: options.cliPath
  });
  return {
    ok: Boolean(memoInvocation),
    platform,
    memoCommand: memoInvocation?.shellCommand || null,
    ...(memoInvocation
      ? {
          memoExecutable: memoInvocation.executable,
          memoArgs: memoInvocation.args,
          memoShell: memoInvocation.shell
        }
      : {}),
    shellHookPrefix: platform === 'win32' ? 'bash' : '',
    chmodAttempted: platform !== 'win32',
    ...(memoInvocation ? {} : { warning: 'Unable to resolve memo on PATH or node dist/cli.js.' })
  };
}

function detectedHosts(root: string, home: string): InstallHost[] {
  const candidates: Array<[InstallHost, string]> = [
    ['cursor', path.join(root, '.cursor')],
    ['antigravity', path.join(root, '.agents')],
    ['codex', path.join(root, '.codex')],
    ['opencode', path.join(root, '.opencode')],
    ['claude', path.join(root, '.claude')]
  ];
  return candidates.filter(([, candidate]) => fs.existsSync(candidate)).map(([host]) => host)
    .concat(
      fs.existsSync(path.join(home, '.cursor')) ? ['cursor'] : [],
      fs.existsSync(path.join(home, '.gemini')) ? ['antigravity'] : [],
      fs.existsSync(path.join(home, '.codex')) ? ['codex'] : [],
      fs.existsSync(path.join(home, '.config', 'opencode')) ? ['opencode'] : [],
      fs.existsSync(path.join(home, '.claude')) ? ['claude'] : []
    )
    .filter((host, index, all) => all.indexOf(host) === index);
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: string) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    rl.once('close', () => finish(''));
    try {
      rl.question(question, finish);
    } catch {
      finish('');
    }
  });
}

function writeWizardLine(output: NodeJS.WritableStream, line = ''): void {
  output.write(`${line}\n`);
}

export async function runInstallWizard(options: {
  productRoot: string;
  homeDir?: string;
  commandName: 'install-hooks' | 'install-skills';
  defaultScope?: InstallScope;
  defaultPolicy?: ConflictPolicy;
  preflight?: InstallPreflight;
  previewPaths?: (selection: { scope: InstallScope; conflictPolicy: ConflictPolicy; hosts: InstallHost[] }) => string[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<InstallWizardSelection | null> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!(input as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY ||
      !(output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY) {
    return null;
  }
  const home = path.resolve(options.homeDir || os.homedir());
  const suggestions = detectedHosts(options.productRoot, home);
  const rl = readline.createInterface({ input, output });
  try {
    const defaultScope = options.defaultScope || 'local';
    const scopeAnswer = (await ask(rl, `Install scope [l]ocal/[g]lobal (${defaultScope}): `))
      .trim().toLowerCase() || defaultScope;
    const scope: InstallScope = scopeAnswer === 'g' || scopeAnswer === 'global' ? 'global' : 'local';
    if (scopeAnswer !== 'l' && scopeAnswer !== 'local' && scopeAnswer !== 'g' && scopeAnswer !== 'global') return null;

    const policyAnswer = (await ask(
      rl,
      `Existing-file policy [s]kip/[u]pdate/[f]orce (${options.defaultPolicy || 'update'}): `
    )).trim().toLowerCase() || (options.defaultPolicy || 'update');
    const policyMap: Record<string, ConflictPolicy> = { s: 'skip', skip: 'skip', u: 'update', update: 'update', f: 'force', force: 'force' };
    const conflictPolicy = policyMap[policyAnswer];
    if (!conflictPolicy) return null;

    writeWizardLine(output, `Hosts (comma-separated numbers; detected: ${suggestions.join(', ') || 'none'}):`);
    INSTALL_HOSTS.forEach((host, index) => {
      const checked = suggestions.includes(host) ? '[x]' : '[ ]';
      writeWizardLine(output, `  ${checked} ${index + 1}. ${host}`);
    });
    const hostAnswer = (await ask(rl, 'Hosts: ')).trim() ||
      suggestions.map((host) => String(INSTALL_HOSTS.indexOf(host) + 1)).join(',');
    if (!hostAnswer) return null;
    const hosts = normalizeInstallHosts(hostAnswer.split(',').map((token) => {
      const index = Number(token.trim());
      return Number.isInteger(index) && index >= 1 && index <= INSTALL_HOSTS.length
        ? INSTALL_HOSTS[index - 1]
        : token;
    }));
    if (hosts.length === 0) return null;

    const preflight = options.preflight || getInstallPreflight();
    writeWizardLine(output, `\nPlan (${options.commandName}):`);
    writeWizardLine(output, `  scope=${scope}, policy=${conflictPolicy}, platform=${preflight.platform}`);
    writeWizardLine(output, `  hosts=${hosts.join(', ')}`);
    writeWizardLine(output, `  memo=${preflight.memoCommand || 'unresolved'}`);
    writeWizardLine(output, `  shell=${preflight.shellHookPrefix || 'native'}, chmod=${preflight.chmodAttempted ? 'attempted' : 'not required'}`);
    const previewPaths = options.previewPaths?.({ scope, conflictPolicy, hosts }) || [];
    if (previewPaths.length > 0) {
      writeWizardLine(output, '  paths:');
      for (const previewPath of previewPaths) {
        writeWizardLine(output, `    ${previewPath}`);
      }
    }
    if (preflight.warning) writeWizardLine(output, `  warning=${preflight.warning}`);
    const confirm = (await ask(rl, 'Apply this plan? [y/N]: ')).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') return null;
    return { scope, conflictPolicy, hosts, confirmed: true, preflight };
  } finally {
    rl.close();
  }
}
