export type RecordKind =
  | 'trap'
  | 'decision'
  | 'spec'
  | 'plan'
  | 'state'
  | 'log'
  | 'scratch'
  | 'review'
  | 'prompt'
  | 'session';

export type RecordStatus =
  | 'active'
  | 'paused'
  | 'shipped'
  | 'superseded'
  | 'archived'
  | 'completed';

export type RecordSource = 'agent' | 'human' | 'imported';

export interface SessionDeliverable {
  type: 'pr' | 'commit' | 'spec';
  url?: string;
  sha?: string;
  title?: string;
}

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
  /** Retrieval usefulness counter (bootstrap/get/search.hitIds). Orthogonal to occurrences. */
  hits?: number;
  /** ISO timestamp of the most recent retrieval hit. */
  lastHit?: string;
  // Prompt & Session extended fields
  ide?: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  turn?: number;
  taskSlug?: string;
  client?: string;
  billable?: boolean;
  branch?: string;
  gitSha?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
  humanTotalMinutes?: number;
  agentRunningMinutes?: number;
  deliverables?: SessionDeliverable[];
  summary?: string;
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
  'install_skills',
  'prompt'
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

export interface PortsConfig {
  sse?: number;
  mcp?: number;
  status?: number;
  ui?: number;
  canvas?: number;
}

export type ConflictStrategy = 'smart-merge' | 'local-wins' | 'remote-wins' | 'sidecar';

export interface SyncConfig {
  /** Primary conflict resolution strategy (spec AC5). */
  conflictStrategy?: ConflictStrategy;
  /** @deprecated Use conflictStrategy */
  defaultStrategy?: ConflictStrategy;
  cleanSidecars?: boolean;
  autoSyncIntervalMinutes?: number;
}

export type ConflictCategory = 'body_divergence' | 'metadata_divergence' | 'timestamp_collision';

export interface ConflictRecordDetail {
  id: string;
  kind: RecordKind;
  projectId: string;
  category: ConflictCategory;
  resolution: 'merged' | 'local-applied' | 'remote-applied' | 'sidecar-written' | 'skipped';
  localTime?: string;
  remoteTime?: string;
  message?: string;
}

export interface VaultConfig {
  version: string;
  defaultRemote: string;
  /** Persistent vault root pointer (bootstrap ~/.spec-memo/config.json or in-vault config.json). */
  vaultRoot?: string;
  enableTelemetry?: boolean;
  telemetry?: TelemetryConfig;
  mode?: DeploymentMode;
  ports?: PortsConfig;
  remote?: {
    url: string;
  };
  sync?: SyncConfig;
  vaultGit?: {
    enabled: boolean;
    remoteUrl?: string;
    autoCommit?: boolean;
    /** When true, commit+push after each mutation. Default false (batched flush). */
    atomic?: boolean;
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
  /** Record ids to acknowledge as retrieval hits after search returns (optional). */
  hitIds?: string[];
  /** When set, at most one hit bump per (sessionId, record id). */
  sessionId?: string;
}

export type SearchSort = 'relevance' | 'occurrences' | 'updated' | 'hits';

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
  hits?: number;
  lastHit?: string | null;
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
  /** When set, at most one hit bump per (sessionId, record id). */
  sessionId?: string;
}

export interface MemoryRecordListItem {
  id: string;
  projectId: string;
  kind: RecordKind;
  status: RecordStatus;
  title?: string;
  hits: number;
  occurrences: number;
  lastHit?: string | null;
  lastSeen?: string | null;
  updated: string;
  snippet?: string;
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
  /** Test/clock override for deterministic TTL and log roll-up boundaries. */
  now?: number;
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
  /** Product repository root (preferred for local install). */
  productRoot?: string;
  /** Fallback when productRoot omitted — resolved via project identity. */
  cwd?: string;
  vaultRoot?: string;
  /** Skill ids to install (default `["ws-memo", "ws-session-tracking"]`). */
  skills?: string[];
  /** Relative skills directory under product root (default `.agents/skills`). Ignored when `global`. */
  skillsRoot?: string;
  force?: boolean;
  /**
   * Install into global skills roots instead of a product repo:
   * `$HOME/.agents/skills` always; `$HOME/.gemini/config/skills` when Antigravity/Gemini config exists.
   */
  global?: boolean;
  /** Test hook: override packaged skill source root. */
  packageRoot?: string;
  /** Test hook: override `$HOME` for `--global` installs. */
  homeDir?: string;
}

export interface InstallSkillsInstalledRow {
  skill: string;
  destination: string;
  identical: boolean;
  bytesWritten: number;
  /** Destination kind: local product, Cursor/agents global, or Antigravity. */
  target?: 'local' | 'agents' | 'antigravity';
}

export interface InstallSkillsResult {
  mode: 'local' | 'global';
  /** Local: product root. Global: resolved home directory. */
  productRoot: string;
  /** Local: relative skillsRoot. Global: `"global"`. */
  skillsRoot: string;
  installed: InstallSkillsInstalledRow[];
  /** Global-only: Antigravity (or other) roots that were skipped because missing. */
  skippedTargets?: Array<{ kind: string; path: string; reason: string }>;
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
    scope?: 'full' | 'project';
    recordsByKind?: Record<string, number>;
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

export interface ResetVaultOptions {
  vaultRoot?: string;
  projectId?: string;
  all?: boolean;
  password?: string;
  backupDir?: string;
}

export interface ResetVaultResult {
  ok: boolean;
  vaultRoot: string;
  projectId?: string;
  backupFilename: string;
  backupPath: string;
  wipedProjectsCount: number;
  wipedRecordsCount: number;
  rebuiltFts: boolean;
}

export interface BackupFileInfo {
  filename: string;
  /** Absolute path on disk; stripped by sanitizeToolOutput for HTTP/CLI JSON. */
  path: string;
  size: number;
  createdAt: string;
  isZip: boolean;
  encrypted?: boolean;
  /** `full` = all projects; `project` = one or more named projects; omitted when unknown (encrypted unread). */
  scope?: 'full' | 'project';
  projectIds?: string[];
  recordCount?: number | null;
  recordsByKind?: Record<string, number>;
  inspectable?: boolean;
  format?: string;
}

export interface BackupListFilters {
  q?: string;
  scope?: 'all' | 'full' | 'project';
  projectId?: string;
  encrypted?: boolean;
  since?: string;
  until?: string;
  kinds?: string[];
  minSize?: number;
  maxSize?: number;
}

export interface PersistBackupOptions {
  vaultRoot?: string;
  projectId?: string;
  password?: string;
}

export interface PersistBackupResult {
  filename: string;
  size: number;
  recordCount: number;
  projectIds: string[];
  encrypted: boolean;
}

export interface InspectBackupResult {
  ok: true;
  filename: string;
  size: number;
  createdAt: string;
  isZip: boolean;
  encrypted: boolean;
  inspectable: boolean;
  scope?: 'full' | 'project';
  projectIds?: string[];
  recordCount?: number | null;
  recordsByKind?: Record<string, number>;
  format?: string;
  manifest?: {
    version?: string;
    exportedAt?: string;
    projects?: string[];
    recordCount?: number;
  };
}

export type TopologyRole = 'local-vault' | 'intermediary-proxy' | 'final-remote';

export interface TopologyInfo {
  mode: 'local' | 'hybrid' | 'remote';
  role: TopologyRole;
  roleLabel: string;
  upstreamRemoteUrl: string | null;
  isProxy: boolean;
  isRemoteDaemon: boolean;
  syncSummary?: string;
  description: string;
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
  /** One-shot override for this command (same as --vaultRoot). */
  vaultRoot?: string;
  /** Persist default vault root in bootstrap config.json (same as --vault-root). */
  defaultVaultRoot?: string;
  interactive?: boolean;
  urlPrompt?: () => string;
  authToken?: string;
}

export interface SetupResult {
  mode: DeploymentMode;
  remoteUrl?: string;
  tokenConfigured: boolean;
  configPath: string;
  bootstrapConfigPath?: string;
  defaultVaultRoot?: string;
  hostSnippet?: Record<string, unknown> | string;
  hostConfigPath?: string;
  writtenMcp?: boolean;
  message?: string;
}

export interface StatusOptions {
  cwd?: string;
  vaultRoot?: string;
  json?: boolean;
  check?: boolean;
  verbose?: boolean;
  timeoutMs?: number;
}

export interface DaemonServiceStatus {
  name: string;
  port: number;
  configuredPort: number;
  status: 'RUNNING' | 'STOPPED';
  url: string;
  endpoint: string;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface RemoteDaemonStatus {
  configured: boolean;
  url: string | null;
  tokenConfigured: boolean;
  status: 'REACHABLE' | 'UNREACHABLE' | 'NOT_CONFIGURED';
  statusCode?: number;
  latencyMs?: number;
  error?: string;
}

export interface ProjectStorageStatus {
  projectId: string;
  path: string;
  remoteOrigin: string | null;
  isFallback: boolean;
  counts: {
    traps: number;
    decisions: number;
    specs: number;
    plans: number;
    prompts: number;
    sessions: number;
    logs: number;
    reviews: number;
    scratch: number;
    total: number;
  };
}

export interface VaultStorageStatus {
  vaultRoot: string;
  configFile: string;
  configValid: boolean;
  totalProjects: number;
  ftsDbExists: boolean;
  ftsDbSize: number;
  ftsRecordCount: number;
  backupCount: number;
  backupTotalSize: number;
  latestBackup?: string;
}

export interface OperationalStatus {
  telemetry: {
    enabled: boolean;
    logFile?: string;
    maxFileSizeMb?: number;
  };
  ttl: {
    scratchDays: number;
    reviewDays: number;
    logCompactMonths: number;
  };
  vaultGit: {
    enabled: boolean;
    atomic?: boolean;
    remoteUrl?: string;
    dirty?: boolean;
    lastError?: string | null;
    lastSyncAt?: string | null;
  };
}

export interface StatusResult {
  ok: boolean;
  code?: 'CONFIG_ERROR' | 'STATUS_ERROR';
  mode: DeploymentMode;
  role: TopologyRole;
  vault: VaultStorageStatus;
  project?: ProjectStorageStatus;
  daemons: {
    sse: DaemonServiceStatus;
    status: DaemonServiceStatus;
    canvas: DaemonServiceStatus;
    remote: RemoteDaemonStatus;
  };
  operational: OperationalStatus;
  issues: string[];
}

export interface DoctorResult {
  healthy: boolean;
  vaultRoot: string;
  vaultExists: boolean;
  mode?: DeploymentMode;
  remoteUrl?: string | null;
  tokenConfigured?: boolean;
  hybridState?: HybridState | null;
  vaultGit?: {
    enabled: boolean;
    atomic: boolean;
    remoteUrl?: string;
    dirty?: boolean;
    lastError?: string | null;
    lastSyncAt?: string | null;
  };
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

export type PromptAction =
  | 'record'
  | 'list'
  | 'get'
  | 'search'
  | 'session'
  | 'session_start'
  | 'session_end'
  | 'activity_report'
  | 'derive_rules'
  | 'export_story';

export interface PaginatedResult<T> {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  items: T[];
}

export interface PromptOptions {
  action?: PromptAction;
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  crossProject?: boolean;
  id?: string;
  body?: string;
  sessionId?: string;
  turn?: number;
  taskSlug?: string;
  client?: string;
  billable?: boolean;
  ide?: string;
  model?: string;
  agent?: string;
  branch?: string;
  gitSha?: string;
  linkedPaths?: string[];
  tags?: string[];
  deliverables?: SessionDeliverable[];
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  sort?: 'date-desc' | 'date-asc' | 'relevance';
  saveTraps?: boolean;
  promote?: string;
  format?: string;
}

export interface PromptRecordResult {
  id: string;
  path: string;
  created: string;
  turn?: number;
  sessionId?: string;
  projectId: string;
}

export interface SessionResult {
  id: string;
  sessionId: string;
  projectId: string;
  status: RecordStatus;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  taskSlug?: string;
  client?: string;
  billable: boolean;
  deliverables?: SessionDeliverable[];
  summary?: string;
  path: string;
  sync?: unknown;
}

export interface ActivityReportResult {
  since?: string;
  until?: string;
  client?: string;
  projectId?: string;
  totalDurationMinutes: number;
  totalBillableHours: number;
  totalSessions: number;
  totalPrompts: number;
  sessions: Array<{
    id: string;
    sessionId: string;
    projectId: string;
    client?: string;
    taskSlug?: string;
    startTime: string;
    endTime?: string;
    durationMinutes: number;
    billable: boolean;
    deliverables?: SessionDeliverable[];
    summary?: string;
  }>;
  byClient: Record<string, { totalHours: number; sessionCount: number }>;
  byProject: Record<string, { totalHours: number; sessionCount: number }>;
}

export interface DerivedRuleCandidate {
  ruleTitle: string;
  pattern: string;
  category: string;
  confidence: number;
  sourcePromptIds: string[];
  suggestedBody: string;
}

export interface DeriveRulesResult {
  projectId?: string;
  sessionId?: string;
  scannedPromptsCount: number;
  rules: DerivedRuleCandidate[];
  savedTraps?: Array<{ id: string; title: string; path: string }>;
  promotedPath?: string;
}

export interface ExportStoryResult {
  sessionId: string;
  projectId: string;
  turnsCount: number;
  markdown: string;
  outputPath?: string;
}



