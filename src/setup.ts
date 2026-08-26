import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DeploymentMode, HostName, SetupOptions, SetupResult, VaultConfig } from './types.js';
import { ensureVaultStructure, getVaultRoot, withVaultLockSync } from './vault.js';

export const SUPPORTED_HOSTS: HostName[] = [
  'cursor',
  'vscode',
  'opencode',
  'antigravity',
  'claude',
  'generic'
];

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

export function resolveHostConfigPath(host: HostName): string {
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
 * Generate host-specific stdio MCP configuration snippet.
 */
export function generateHostMcpSnippet(
  host: HostName,
  command: string = 'memo',
  args: string[] = ['serve']
): Record<string, unknown> {
  const normalizedHost = host.toLowerCase() as HostName;
  if (!SUPPORTED_HOSTS.includes(normalizedHost)) {
    throw new Error(`Unsupported host '${host}'. Supported hosts: ${SUPPORTED_HOSTS.join(', ')}`);
  }

  switch (normalizedHost) {
    case 'cursor':
      return {
        mcpServers: {
          'spec-memo': {
            command,
            args
          }
        }
      };
    case 'vscode':
      return {
        servers: {
          'spec-memo': {
            command,
            args
          }
        }
      };
    case 'opencode':
      return {
        mcp: {
          'spec-memo': {
            type: 'stdio',
            command,
            args
          }
        }
      };
    case 'antigravity':
    case 'claude':
    case 'generic':
    default:
      return {
        mcpServers: {
          'spec-memo': {
            command,
            args
          }
        }
      };
  }
}

/**
 * Merges host snippet into existing host configuration file.
 */
export function writeHostMcpConfig(
  host: HostName,
  snippet: Record<string, unknown>
): { configPath: string; written: boolean } {
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

  for (const [key, value] of Object.entries(snippet)) {
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

/**
 * Configure spec-memo deployment mode and remote daemon wiring.
 */
export function runSetup(options: SetupOptions = {}): SetupResult {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const configPath = path.join(vaultRoot, 'config.json');

  return withVaultLockSync(vaultRoot, () => {
    const existing = ensureVaultStructure(vaultRoot);

    const targetMode: DeploymentMode = options.mode || existing.mode || 'local';
    if (!['local', 'hybrid', 'remote'].includes(targetMode)) {
      throw new Error(`Invalid mode '${targetMode}'. Supported modes: local, hybrid, remote.`);
    }

    let normalizedUrl: string | undefined;
    const rawUrl = options.url || existing.remote?.url;

    if (targetMode === 'hybrid' || targetMode === 'remote') {
      if (!rawUrl || rawUrl.trim().length === 0) {
        throw new Error(`Remote URL (--url) is required when mode is '${targetMode}'.`);
      }
      normalizedUrl = normalizeRemoteUrl(rawUrl);
    } else if (rawUrl && rawUrl.trim().length > 0) {
      try {
        normalizedUrl = normalizeRemoteUrl(rawUrl);
      } catch {
        // In local mode, ignore invalid URL if not explicitly changing
      }
    }

    const updatedConfig: VaultConfig = {
      ...existing,
      mode: targetMode
    };

    if (normalizedUrl) {
      updatedConfig.remote = { url: normalizedUrl };
    } else if (targetMode === 'local' && !options.url && existing.remote) {
      updatedConfig.remote = existing.remote;
    }

    // Persist configuration update (NEVER write auth tokens)
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf8');

    const tokenConfigured = isTokenConfigured(options.authToken);

    // Host MCP snippet handling
    let hostSnippet: Record<string, unknown> | undefined;
    let hostConfigPath: string | undefined;
    let writtenMcp = false;

    if (options.host) {
      const host = options.host.toLowerCase() as HostName;
      hostSnippet = generateHostMcpSnippet(host);
      hostConfigPath = resolveHostConfigPath(host);

      if (options.writeMcp) {
        writeHostMcpConfig(host, hostSnippet);
        writtenMcp = true;
      }
    }

    // Check token presence after saving configuration (AC5)
    if ((targetMode === 'hybrid' || targetMode === 'remote') && !tokenConfigured) {
      const tokenError = new Error(
        `Bearer token not found in environment for mode '${targetMode}'. Set SPEC_MEMO_AUTH_TOKEN or SPEC_MEMO_SSE_TOKEN.`
      );
      (tokenError as Error & { partialResult?: SetupResult }).partialResult = {
        mode: targetMode,
        remoteUrl: normalizedUrl,
        tokenConfigured: false,
        configPath,
        hostSnippet,
        hostConfigPath,
        writtenMcp
      };
      throw tokenError;
    }

    return {
      mode: targetMode,
      remoteUrl: normalizedUrl,
      tokenConfigured,
      configPath,
      hostSnippet,
      hostConfigPath,
      writtenMcp,
      message: `spec-memo configured successfully in '${targetMode}' mode.`
    };
  });
}
