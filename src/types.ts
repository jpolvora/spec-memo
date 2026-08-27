export type RecordKind =
  | 'trap'
  | 'decision'
  | 'spec'
  | 'plan'
  | 'state'
  | 'log'
  | 'scratch'
  | 'review';

export type RecordStatus =
  | 'active'
  | 'paused'
  | 'shipped'
  | 'superseded'
  | 'archived';

export type RecordSource = 'agent' | 'human' | 'imported';

export interface RecordFrontmatter {
  id: string;
  kind: RecordKind;
  project: string;
  status: RecordStatus;
  created: string;
  updated: string;
  source: RecordSource;
  ttl?: string;
  pathPatterns?: string[];
  tags?: string[];
  supersedes?: string;
  gitRemote?: string;
  relatedSlug?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  linkedPaths?: string[];
  verifiedAtSha?: string;
  layer?: string;
  module?: string;
  occurrences?: number;
  lastSeen?: string;
  [key: string]: unknown;
}

export type TrapLayer =
  | 'application'
  | 'domain'
  | 'web'
  | 'infrastructure'
  | 'tests'
  | 'devops'
  | 'other';

export interface MemoRecord {
  frontmatter: RecordFrontmatter;
  body: string;
  path?: string;
}

export interface ToolErrorResponse {
  isError: true;
  error: string;
  code: string;
  details?: unknown;
}

export interface ToolSuccessResponse<T = unknown> {
  isError?: false;
  data: T;
}

export type ToolResponse<T = unknown> = ToolSuccessResponse<T> | ToolErrorResponse;

export const TOOL_NAMES = [
  'bootstrap',
  'search',
  'get',
  'upsert',
  'append',
  'forget',
  'gc',
  'promote',
  'check_version',
  'install_skills'
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ProjectIdentity {
  projectId: string;
  normalizedRemote: string | null;
  rootPath: string;
  isGit: boolean;
  isFallback: boolean;
  vaultProjectPath: string;
}

export interface ProjectMetadata {
  projectId: string;
  gitRemote: string | null;
  displayName: string;
  lastSeenRoot: string;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentMode = 'local' | 'hybrid' | 'remote';

export type HostName = 'cursor' | 'vscode' | 'opencode' | 'antigravity' | 'claude' | 'generic';

export type ClientType = 'proxy' | 'direct-remote' | 'web' | 'cli' | 'unknown';

export interface VaultClientInfo {
  id: string;
  ip: string;
  clientName: string;
  clientType: ClientType;
  userAgent?: string;
  projectId?: string;
  lastOperation?: string;
  connectedAt: string;
  lastSeenAt: string;
  active: boolean;
  requestCount?: number;
}

export interface TelemetryConfig {
  maxFileSizeMb?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

export type TelemetryCategory =
  | 'mcp_tool'
  | 'http_endpoint'
  | 'cli_command'
  | 'sync_operation'
  | 'curator_gc'
  | 'importer';

export interface TelemetryEvent {
  timestamp: string;
  eventId: string;
  category: TelemetryCategory;
  operation: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetryEventInput {
  category: TelemetryCategory;
  operation: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
  vaultRoot?: string;
  timestamp?: string;
  eventId?: string;
}

export interface VaultConfig {
  version: string;
  defaultRemote: string;
  enableTelemetry?: boolean;
  telemetry?: TelemetryConfig;
  mode?: DeploymentMode;
  remote?: {
    url: string;
  };
  vaultGit?: {
    enabled: boolean;
    remoteUrl?: string;
    autoCommit?: boolean;
    branch?: string;
  };
  embeddings?: {
    enabled: boolean;
    minSimilarity?: number;
    provider?: string;
  };
  ttl: {
    scratchDays: number;
    reviewDays: number;
  };
  bootstrap: {
    maxBytes: number;
    maxTraps: number;
  };
}

export interface SearchOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  query?: string;
  kinds?: RecordKind[];
  status?: RecordStatus;
  tags?: string[];
  path?: string;
  includeScratch?: boolean;
  crossProject?: boolean;
  limit?: number;
  sort?: SearchSort;
}

export type SearchSort = 'relevance' | 'occurrences' | 'updated';

export interface SearchHit {
  id: string;
  projectId: string;
  kind: RecordKind;
  status: RecordStatus;
  title?: string;
  tags?: string[];
  pathPatterns?: string[];
  filepath: string;
  snippet?: string;
  rank?: number;
  updated?: string;
  occurrences?: number;
  lastSeen?: string;
  layer?: TrapLayer;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface AppendOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  event: string;
  kind?: RecordKind;
  details?: Record<string, unknown>;
  source?: RecordSource;
}

export interface AppendResult {
  id: string;
  kind: RecordKind;
  path: string;
  event: string;
}

export interface ForgetOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  id?: string;
  kind?: RecordKind;
  slug?: string;
  purge?: boolean;
}

export interface ForgetResult {
  id: string;
  kind?: RecordKind;
  status: RecordStatus | 'purged';
  purged: boolean;
  path?: string;
}

export interface BootstrapOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  query?: string;
  slug?: string;
  path?: string;
  maxBytes?: number;
}

export interface BootstrapBrief {
  projectId: string;
  gitRemote?: string | null;
  lastSeenRoot?: string;
  activeSlice?: {
    slug: string;
    spec?: MemoRecord;
    plan?: MemoRecord;
    state?: MemoRecord;
  };
  traps: MemoRecord[];
  decisions: MemoRecord[];
  totalTrapsCount: number;
  totalDecisionsCount: number;
  byteLength: number;
  budgetBytes: number;
  truncated: boolean;
  drift?: Array<{ specSlug: string; modifiedPaths: string[] }>;
  notices: string[];
}

export interface GcOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  dryRun?: boolean;
}

export interface GcResult {
  projectId: string;
  purgedScratchCount: number;
  purgedReviewCount: number;
  compactedPlansCount: number;
  compactedLogsCount?: number;
  rebuiltFts: boolean;
  rebuiltViews: boolean;
  dryRun: boolean;
  details?: {
    purgedFiles: string[];
    compactedPlans: string[];
    compactedLogs?: string[];
  };
}

export interface PromoteOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  id?: string;
  kind?: RecordKind;
  slug?: string;
  destination: string;
  force?: boolean;
  format?: 'raw' | 'adr' | 'madr' | 'skill';
  limit?: number;
  layer?: TrapLayer;
}

export interface PromoteResult {
  id: string;
  kind: RecordKind;
  destination: string;
  targetPath: string;
  bytesWritten: number;
  format?: 'raw' | 'adr' | 'madr' | 'skill';
}

export interface CheckVersionOptions {
  /** Test hook: override npm latest lookup. Return null to simulate offline. */
  fetchLatest?: () => Promise<string | null>;
  timeoutMs?: number;
}

export interface CheckVersionResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean | 'unknown';
  source: 'npm' | 'offline';
}

export interface InstallSkillsOptions {
  /** Product repository root (preferred). */
  productRoot?: string;
  /** Fallback when productRoot omitted — resolved via project identity. */
  cwd?: string;
  vaultRoot?: string;
  /** Skill ids to install (default `["ws-memo"]`). */
  skills?: string[];
  /** Relative skills directory under product root (default `.agents/skills`). */
  skillsRoot?: string;
  force?: boolean;
  /** Test hook: override packaged skill source root. */
  packageRoot?: string;
}

export interface InstallSkillsResult {
  productRoot: string;
  skillsRoot: string;
  installed: Array<{
    skill: string;
    destination: string;
    identical: boolean;
    bytesWritten: number;
  }>;
}

export interface ExportVaultOptions {
  vaultRoot?: string;
  projectId?: string;
  outputPath?: string;
  password?: string;
}

export interface ExportVaultResult {
  vaultRoot: string;
  projectId?: string;
  outputPath?: string;
  encrypted: boolean;
  projectsCount: number;
  recordsCount: number;
  manifest: {
    version: string;
    exportedAt: string;
    projects: string[];
    recordCount: number;
  };
  payload?: string;
}

export interface ImportVaultOptions {
  vaultRoot?: string;
  archivePath?: string;
  payload?: string;
  password?: string;
  overwrite?: boolean;
}

export interface ImportVaultResult {
  vaultRoot: string;
  restoredProjectsCount: number;
  restoredRecordsCount: number;
  restoredProjects: string[];
  rebuiltFts: boolean;
}

export interface DoctorPollutionItem {
  path: string;
  absolutePath: string;
  type: 'plan_residue' | 'memory_residue' | 'state_residue' | 'spec_residue' | 'telemetry_residue' | 'log_residue';
  description: string;
}

export interface DoctorOptions {
  cwd?: string;
  vaultRoot?: string;
  productRoot?: string;
  rebuild?: boolean;
  fix?: boolean;
}

export interface HybridState {
  dirty: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  cursors?: Record<string, string>;
  dirtyProjects?: Record<string, boolean>;
}

export interface SetupOptions {
  mode?: DeploymentMode;
  url?: string;
  host?: HostName | string;
  printMcp?: boolean;
  writeMcp?: boolean;
  vaultRoot?: string;
  interactive?: boolean;
  urlPrompt?: () => string;
  authToken?: string;
}

export interface SetupResult {
  mode: DeploymentMode;
  remoteUrl?: string;
  tokenConfigured: boolean;
  configPath: string;
  hostSnippet?: Record<string, unknown> | string;
  hostConfigPath?: string;
  writtenMcp?: boolean;
  message?: string;
}

export interface DoctorResult {
  healthy: boolean;
  vaultRoot: string;
  vaultExists: boolean;
  mode?: DeploymentMode;
  remoteUrl?: string | null;
  tokenConfigured?: boolean;
  hybridState?: HybridState | null;
  remoteHealth?: {
    reachable: boolean;
    statusCode?: number;
    message?: string;
  } | null;
  project: {
    projectId: string;
    gitRemote: string | null;
    rootPath: string;
    isGit: boolean;
    isFallback: boolean;
  };
  fts: {
    dbPath: string;
    dbExists: boolean;
    indexedRecordsCount: number;
    healthy: boolean;
    rebuilt?: boolean;
  };
  pollution: {
    detected: boolean;
    fixedCount?: number;
    items: DoctorPollutionItem[];
  };
  warnings: string[];
  summary: string;
}

export interface ImportItem {
  id: string;
  kind: RecordKind;
  slug: string;
  sourcePath: string;
  vaultPath: string;
}

export interface ImportOptions {
  from?: string;
  cwd?: string;
  productRoot?: string;
  projectId?: string;
  vaultRoot?: string;
}

export interface ImportResult {
  projectId: string;
  vaultRoot: string;
  importedSpecsCount: number;
  importedTrapsCount: number;
  importedDecisionsCount: number;
  importedPlansCount: number;
  importedLogsCount: number;
  importedStateCount: number;
  skippedFilesCount: number;
  totalImported: number;
  records: ImportItem[];
  skippedPaths: string[];
}


