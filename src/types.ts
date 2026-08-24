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
  [key: string]: unknown;
}

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
  'promote'
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

export interface VaultConfig {
  version: string;
  defaultRemote: string;
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
}

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

