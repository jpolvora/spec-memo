import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DaemonServiceStatus,
  DeploymentMode,
  OperationalStatus,
  ProjectStorageStatus,
  RemoteDaemonStatus,
  StatusOptions,
  StatusResult,
  TopologyRole,
  VaultStorageStatus
} from './types.js';
import { getVaultRoot, readVaultConfig, resolveVaultGitAtomic, redactVaultGitRemoteUrl } from './vault.js';
import { readVaultGitState } from './vault-git-state.js';
import { listBackups } from './backup.js';
import { resolveProjectIdentity } from './identity.js';
import { isTokenConfigured, getResolvedAuthToken } from './setup.js';
import { openIndex } from './indexer.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
export const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 3000;

export async function probeHttpService(
  url: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
  authToken?: string,
  opts?: { requireOk?: boolean }
): Promise<{ running: boolean; statusCode?: number; latencyMs?: number; error?: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal
    });

    const latencyMs = Date.now() - start;

    if (opts?.requireOk) {
      if (res.ok) {
        return { running: true, statusCode: res.status, latencyMs };
      }
      return {
        running: false,
        statusCode: res.status,
        latencyMs,
        error:
          res.status === 401 || res.status === 403
            ? 'Unauthorized (check SPEC_MEMO_AUTH_TOKEN)'
            : `HTTP ${res.status}`
      };
    }

    if (res.ok || res.status === 401 || res.status === 403 || res.status === 404) {
      return { running: true, statusCode: res.status, latencyMs };
    }
    return { running: false, statusCode: res.status, latencyMs, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { running: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function countProjectRecords(projectDir: string): ProjectStorageStatus['counts'] {
  const counts = {
    traps: 0,
    decisions: 0,
    specs: 0,
    plans: 0,
    prompts: 0,
    sessions: 0,
    logs: 0,
    reviews: 0,
    scratch: 0,
    total: 0
  };

  if (!fs.existsSync(projectDir)) {
    return counts;
  }

  const subdirs: Array<keyof Omit<typeof counts, 'total'>> = [
    'traps',
    'decisions',
    'specs',
    'plans',
    'prompts',
    'sessions',
    'logs',
    'reviews',
    'scratch'
  ];

  for (const sub of subdirs) {
    const subPath = path.join(projectDir, sub);
    if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
      try {
        const files = fs.readdirSync(subPath).filter((f) => f.endsWith('.md') || f.endsWith('.json'));
        counts[sub] = files.length;
        counts.total += files.length;
      } catch {
        // ignore read error
      }
    }
  }

  return counts;
}

export async function runStatusCheck(options: StatusOptions = {}): Promise<StatusResult> {
  const root = getVaultRoot(options.vaultRoot);
  const configPath = path.join(root, 'config.json');
  const { config, configValid, issues } = readVaultConfig(root);
  const mode: DeploymentMode = config.mode || 'local';
  const ssePort = config.ports?.sse ?? config.ports?.mcp ?? 3123;
  const statusPort = config.ports?.status ?? config.ports?.ui ?? 3124;
  const canvasPort = config.ports?.canvas ?? 3125;

  // 1. Resolve Topology Role
  let role: TopologyRole = 'local-vault';
  if (mode === 'hybrid') {
    role = 'intermediary-proxy';
  } else if (mode === 'remote') {
    role = 'intermediary-proxy';
  }

  // 2. Probe Local Daemons
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const authToken = getResolvedAuthToken();

  const sseProbe = await probeHttpService(`http://127.0.0.1:${ssePort}/health`, timeoutMs, authToken);
  const sseStatus: DaemonServiceStatus = {
    name: 'MCP SSE Server',
    port: ssePort,
    configuredPort: config.ports?.sse ?? config.ports?.mcp ?? 3123,
    status: sseProbe.running ? 'RUNNING' : 'STOPPED',
    url: `http://127.0.0.1:${ssePort}`,
    endpoint: `http://127.0.0.1:${ssePort}/health`,
    statusCode: sseProbe.statusCode,
    latencyMs: sseProbe.latencyMs,
    error: sseProbe.error
  };

  const statusProbe = await probeHttpService(`http://127.0.0.1:${statusPort}/api/status`, timeoutMs, authToken);
  const statusCompanionStatus: DaemonServiceStatus = {
    name: 'Status Monitor Companion',
    port: statusPort,
    configuredPort: config.ports?.status ?? config.ports?.ui ?? 3124,
    status: statusProbe.running ? 'RUNNING' : 'STOPPED',
    url: `http://127.0.0.1:${statusPort}`,
    endpoint: `http://127.0.0.1:${statusPort}/api/status`,
    statusCode: statusProbe.statusCode,
    latencyMs: statusProbe.latencyMs,
    error: statusProbe.error
  };

  const canvasProbe = await probeHttpService(`http://127.0.0.1:${canvasPort}/api/graph`, timeoutMs, authToken);
  const canvasStatus: DaemonServiceStatus = {
    name: 'Canvas Visualizer',
    port: canvasPort,
    configuredPort: config.ports?.canvas ?? 3125,
    status: canvasProbe.running ? 'RUNNING' : 'STOPPED',
    url: `http://127.0.0.1:${canvasPort}`,
    endpoint: `http://127.0.0.1:${canvasPort}/api/graph`,
    statusCode: canvasProbe.statusCode,
    latencyMs: canvasProbe.latencyMs,
    error: canvasProbe.error
  };

  // 3. Probe Remote Daemon (if configured)
  const remoteUrl = config.remote?.url || null;
  const tokenPresent = isTokenConfigured();

  let remoteStatus: RemoteDaemonStatus = {
    configured: Boolean(remoteUrl),
    url: remoteUrl,
    tokenConfigured: tokenPresent,
    status: 'NOT_CONFIGURED'
  };

  if (remoteUrl) {
    const remoteTimeout = options.timeoutMs ?? DEFAULT_REMOTE_PROBE_TIMEOUT_MS;
    const probe = await probeHttpService(
      `${remoteUrl.replace(/\/+$/, '')}/health`,
      remoteTimeout,
      authToken,
      { requireOk: true }
    );
    remoteStatus = {
      configured: true,
      url: remoteUrl,
      tokenConfigured: tokenPresent,
      status: probe.running ? 'REACHABLE' : 'UNREACHABLE',
      statusCode: probe.statusCode,
      latencyMs: probe.latencyMs,
      error: probe.error
    };

    if (!probe.running && (mode === 'remote' || mode === 'hybrid')) {
      issues.push(`Remote daemon '${remoteUrl}' is unreachable: ${probe.error || 'Connection failed'}`);
    }
  } else if (mode === 'remote' || mode === 'hybrid') {
    issues.push(`Deployment mode is '${mode}' but no remote daemon URL is configured in config.json.`);
  }

  // 4. Project Identity & Storage
  const cwd = options.cwd || process.cwd();
  let projectStatus: ProjectStorageStatus | undefined;

  try {
    const identity = resolveProjectIdentity(cwd, { vaultRoot: root });
    const projectDir = path.join(root, 'projects', identity.projectId);
    const counts = countProjectRecords(projectDir);

    projectStatus = {
      projectId: identity.projectId,
      path: projectDir,
      remoteOrigin: identity.normalizedRemote,
      isFallback: identity.isFallback,
      counts
    };
  } catch {
    // ignore identity error if outside valid project
  }

  // 5. Global Vault & Backups
  const projectsDir = path.join(root, 'projects');
  let totalProjects = 0;
  if (fs.existsSync(projectsDir)) {
    try {
      totalProjects = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .length;
    } catch {
      totalProjects = 0;
    }
  }

  const ftsPath = path.join(root, 'memo.sqlite');
  let ftsDbExists = fs.existsSync(ftsPath);
  let ftsDbSize = 0;
  let ftsRecordCount = 0;

  if (ftsDbExists) {
    try {
      ftsDbSize = fs.statSync(ftsPath).size;
      const db = openIndex(root);
      const row = db.prepare('SELECT count(*) as count FROM records_fts').get() as { count: number } | undefined;
      ftsRecordCount = row?.count ?? 0;
    } catch {
      // index could be locked or transient
    }
  }

  const backups = listBackups(root);
  const backupCount = backups.length;
  const backupTotalSize = backups.reduce((acc: number, b) => acc + b.size, 0);
  const latestBackup = backups.length > 0 ? backups[0].filename : undefined;

  const vaultStorage: VaultStorageStatus = {
    vaultRoot: root,
    configFile: configPath,
    configValid,
    totalProjects,
    ftsDbExists,
    ftsDbSize,
    ftsRecordCount,
    backupCount,
    backupTotalSize,
    latestBackup
  };

  // 6. Operational Settings
  const gitState = readVaultGitState(root);
  const operational: OperationalStatus = {
    telemetry: {
      enabled: Boolean(config.enableTelemetry),
      logFile: config.telemetry ? path.join(root, 'telemetry', 'usage.jsonl') : undefined,
      maxFileSizeMb: config.telemetry?.maxFileSizeMb
    },
    ttl: {
      scratchDays: config.ttl?.scratchDays ?? 7,
      reviewDays: config.ttl?.reviewDays ?? 14,
      logCompactMonths: 1
    },
    vaultGit: {
      enabled: Boolean(config.vaultGit?.enabled),
      atomic: resolveVaultGitAtomic(config),
      remoteUrl: redactVaultGitRemoteUrl(config.vaultGit?.remoteUrl),
      dirty: gitState.dirty,
      lastError: gitState.lastError,
      lastSyncAt: gitState.lastSyncAt
    }
  };

  const isHealthy = configValid && (mode === 'local' || (remoteStatus.status === 'REACHABLE'));

  return {
    ok: isHealthy,
    code: configValid ? undefined : 'CONFIG_ERROR',
    mode,
    role,
    vault: vaultStorage,
    project: projectStatus,
    daemons: {
      sse: sseStatus,
      status: statusCompanionStatus,
      canvas: canvasStatus,
      remote: remoteStatus
    },
    operational,
    issues
  };
}

export function formatStatusDashboard(result: StatusResult, options: StatusOptions = {}): string {
  const lines: string[] = [];

  lines.push(`spec-memo — Operational Status & Configuration`);
  lines.push(`───────────────────────────────────────────────────────`);

  // Mode & Topology
  lines.push(`\nTopology & Mode:`);
  lines.push(`  Deployment Mode:    ${result.mode.toUpperCase()}`);
  lines.push(`  Topology Role:      ${result.role}`);
  if (result.daemons.remote.configured) {
    const rStatus = result.daemons.remote.status === 'REACHABLE'
      ? `REACHABLE (${result.daemons.remote.latencyMs ?? 0}ms)`
      : `UNREACHABLE (${result.daemons.remote.error || 'error'})`;
    lines.push(`  Remote Daemon:      ${result.daemons.remote.url} [${rStatus}]`);
    lines.push(`  Bearer Token:       ${result.daemons.remote.tokenConfigured ? 'Configured (SPEC_MEMO_AUTH_TOKEN)' : 'Not Set'}`);
  }

  // Daemons & Services
  lines.push(`\nDaemon Services (Configured Ports):`);
  const formatDaemonLine = (d: DaemonServiceStatus) => {
    const stateStr = d.status === 'RUNNING'
      ? `● RUNNING (${d.latencyMs ?? 0}ms)`
      : `○ STOPPED`;
    return `  - ${d.name.padEnd(26)} :${d.port} ${stateStr.padStart(16)} → ${d.url}`;
  };

  lines.push(formatDaemonLine(result.daemons.sse));
  lines.push(formatDaemonLine(result.daemons.status));
  lines.push(formatDaemonLine(result.daemons.canvas));

  // Active Project
  if (result.project) {
    lines.push(`\nActive Project Binding:`);
    lines.push(`  Project ID:         ${result.project.projectId}`);
    lines.push(`  Git Remote:         ${result.project.remoteOrigin || '(local fallback)'}`);
    lines.push(`  Project Path:       ${result.project.path}`);
    const c = result.project.counts;
    lines.push(
      `  Records Breakdown:  ${c.total} total (${c.traps} traps, ${c.decisions} decisions, ${c.specs} specs, ${c.plans} plans, ${c.prompts} prompts, ${c.sessions} sessions, ${c.logs} logs, ${c.reviews} reviews, ${c.scratch} scratch)`
    );
  }

  // Global Vault Storage
  lines.push(`\nVault Storage & Backups:`);
  lines.push(`  Vault Root:         ${result.vault.vaultRoot}`);
  lines.push(`  Total Projects:     ${result.vault.totalProjects}`);
  const ftsSizeKb = Math.max(1, Math.round(result.vault.ftsDbSize / 1024));
  lines.push(
    `  SQLite FTS5 Index:  ${result.vault.ftsDbExists ? `memo.sqlite (${ftsSizeKb} KB, ${result.vault.ftsRecordCount} docs)` : 'Not Created'}`
  );
  const backupSizeKb = Math.max(0, Math.round(result.vault.backupTotalSize / 1024));
  lines.push(
    `  Snapshot Backups:   ${result.vault.backupCount} snapshot(s) (${backupSizeKb} KB)${result.vault.latestBackup ? ` [Latest: ${result.vault.latestBackup}]` : ''}`
  );

  // Operational Settings
  lines.push(`\nOperational Policies:`);
  lines.push(`  Telemetry:          ${result.operational.telemetry.enabled ? 'Enabled' : 'Disabled'}`);
  lines.push(
    `  TTL Retention:      scratch=${result.operational.ttl.scratchDays}d, review=${result.operational.ttl.reviewDays}d, logCompaction=${result.operational.ttl.logCompactMonths}mo`
  );
  lines.push(
    `  Vault Git Sync:     ${
      result.operational.vaultGit.enabled
        ? `Enabled (${result.operational.vaultGit.atomic ? 'atomic' : 'batched'}) (${result.operational.vaultGit.remoteUrl || 'local'})`
        : 'Disabled'
    }`
  );

  // Issues & Warnings
  if (result.issues.length > 0) {
    lines.push(`\nIssues & Warnings:`);
    for (const issue of result.issues) {
      lines.push(`  ! ${issue}`);
    }
  }

  lines.push(`───────────────────────────────────────────────────────`);
  const healthLabel = result.ok ? 'OK (Healthy)' : 'ISSUES DETECTED';
  lines.push(`Overall Health: ${result.code ? `${healthLabel} [${result.code}]` : healthLabel}`);

  return lines.join('\n');
}
