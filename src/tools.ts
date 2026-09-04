import { z } from 'zod';
import {
  TOOL_NAMES,
  ToolName,
  ToolResponse,
  AppendOptions,
  BootstrapOptions,
  ForgetOptions,
  GcOptions,
  PromoteOptions,
  CheckVersionOptions,
  InstallSkillsOptions,
  PromptOptions,
  RecordKind,
  RecordStatus,
  SearchOptions
} from './types.js';
import { RecordKindSchema, RecordStatusSchema } from './schema.js';
import { upsertRecord, getRecord, appendEvent, forgetRecord } from './store.js';
import { searchIndex } from './indexer.js';
import { wrapSqliteOpenError } from './sqlite.js';
import { compileBootstrapBrief } from './bootstrap.js';
import {
  recordMemoryHits,
  collectBootstrapHitIds,
  isHitEligibleKind
} from './hits.js';
import { runGc } from './curator.js';
import { promoteRecord } from './promote.js';
import { checkVersion } from './version.js';
import { installSkills } from './skills-install.js';
import {
  recordPromptTurn,
  startSessionRecord,
  endSessionRecord,
  getSessionTurns,
  exportSessionStory,
  listPrompts,
  searchPrompts,
  deriveRulesFromPrompts,
  generateActivityReport
} from './prompt.js';
import { submitMemoryFeedback } from './feedback.js';
import { sanitizeToolOutput } from './safety.js';
import { scheduleHybridPush } from './hybrid-sync.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot, getProjectMetadata } from './vault.js';
import { recordTelemetry } from './telemetry.js';
import { logErrorReport } from './error-logger.js';

function resolveHybridPushProjectId(opts: {
  cwd?: string;
  vaultRoot?: string;
  projectId?: string;
}): string {
  if (opts.projectId && opts.projectId.trim().length > 0) {
    return opts.projectId;
  }
  return resolveProjectIdentity(opts.cwd || process.cwd(), {
    vaultRoot: getVaultRoot(opts.vaultRoot)
  }).projectId;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  zodSchema: z.ZodTypeAny;
}

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  bootstrap: {
    name: 'bootstrap',
    description: "Bind cwd's git remote; compile a token-budgeted session brief (traps, open decisions, live spec/plan, drift flags). In hybrid mode, pulls remote deltas before compiling the brief.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Product repository working directory (defaults to current dir)' },
        query: { type: 'string', description: 'Optional context query or task intent to filter relevant traps/decisions' },
        slug: { type: 'string', description: 'Active feature spec/plan slug identifier' },
        path: { type: 'string', description: 'Focus file path to prioritize matching traps' },
        maxBytes: { type: 'number', description: 'Maximum UTF-8 payload byte budget (defaults to vault config.bootstrap.maxBytes, 8192)' },
        projectId: { type: 'string', description: 'Specific project ID override' },
        sessionId: {
          type: 'string',
          description: 'Optional session id for hit de-dupe (at most one bump per record per session)'
        }
      }
    },
    zodSchema: z.object({
      cwd: z.string().optional(),
      query: z.string().optional(),
      slug: z.string().optional(),
      path: z.string().optional(),
      maxBytes: z.number().int().positive().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional(),
      sessionId: z.string().optional()
    })
  },
  search: {
    name: 'search',
    description: 'Filtered full-text retrieval across memory records via SQLite FTS5 (excludes scratch, logs, review by default). Bare search does not increment hits; pass hitIds for rows you actually used.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or FTS query' },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review']
          },
          description: 'Filter by record kinds (trap, decision, spec, plan, state, log, scratch, review)'
        },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'shipped', 'superseded', 'archived'],
          description: 'Filter by status (active, paused, shipped, superseded, archived)'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags'
        },
        path: { type: 'string', description: 'Match records whose pathPatterns cover this file path' },
        includeScratch: { type: 'boolean', description: 'Include scratch records (omitted by default)' },
        projectId: { type: 'string', description: 'Specific project ID to search' },
        crossProject: { type: 'boolean', description: 'Search across all bound projects in vault' },
        limit: { type: 'number', description: 'Maximum number of results to return' },
        sort: {
          type: 'string',
          enum: ['relevance', 'occurrences', 'updated', 'hits'],
          description: 'Result order: relevance (default), occurrences, updated, or hits'
        },
        hitIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Record ids to acknowledge as retrieval hits after search (optional; bare search does not count)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional session id for hit de-dupe when recording hitIds'
        },
        cwd: { type: 'string', description: 'Product repository working directory' }
      }
    },
    zodSchema: z.object({
      query: z.string().optional(),
      kinds: z.array(RecordKindSchema).optional(),
      status: RecordStatusSchema.optional(),
      tags: z.array(z.string()).optional(),
      path: z.string().optional(),
      includeScratch: z.boolean().optional(),
      projectId: z.string().optional(),
      crossProject: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      sort: z.enum(['relevance', 'occurrences', 'updated', 'hits']).optional(),
      hitIds: z.array(z.string()).optional(),
      sessionId: z.string().optional()
    })
  },
  get: {
    name: 'get',
    description: 'Read one record by unique id OR by kind+slug. Successful get of trap/decision/spec/plan increments hits.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record unique ID (e.g. trap-sqlite-wal-lock). Provide id OR kind+slug.' },
        kind: {
          type: 'string',
          enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review'],
          description: 'Record kind (when lookup by kind+slug)'
        },
        slug: { type: 'string', description: 'Record slug identifier (when lookup by kind+slug)' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID override' },
        sessionId: {
          type: 'string',
          description: 'Optional session id for hit de-dupe (at most one bump per record per session)'
        }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: RecordKindSchema.optional(),
      slug: z.string().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional(),
      sessionId: z.string().optional()
    })
  },
  upsert: {
    name: 'upsert',
    description:
      'Write or update a memory record (trap, decision, spec, plan, state, review, scratch). Updates FTS5 and compiled views; schedules hybrid debounced push when mode is hybrid. With vaultGit.enabled, batched mode (vaultGit.atomic false, default) defers git commit until memo sync, session_end, or serve shutdown; atomic true commits and remote-syncs fail-open per mutation.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review'],
          description: 'Record kind (trap, decision, spec, plan, state, log, scratch, review)'
        },
        slug: { type: 'string', description: 'Record slug identifier (auto-derived from title/body if omitted)' },
        frontmatter: {
          type: 'object',
          description: 'Record frontmatter metadata (title, severity: low|medium|high|critical, layer: application|domain|web|infrastructure|tests|devops|other, module, pathPatterns: string[], tags: string[], occurrences: number, supersedes: string, linkedPaths: string[], verifiedAtSha: string)'
        },
        body: { type: 'string', description: 'Record Markdown content. For traps, use DO NOT / INSTEAD DO format.' },
        path: { type: 'string', description: 'Associated focus file path (maps to pathPatterns/linkedPaths)' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID override' }
      },
      required: ['kind', 'body']
    },
    zodSchema: z.object({
      kind: RecordKindSchema,
      slug: z.string().optional(),
      frontmatter: z.record(z.unknown()).optional(),
      body: z.string().min(1, 'Record body must not be empty'),
      path: z.string().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  append: {
    name: 'append',
    description: 'Append a changelog or audit run event (write-only append log).',
    inputSchema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event description or log text (write-only)' },
        kind: {
          type: 'string',
          enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review'],
          description: 'Log record kind (defaults to "log")'
        },
        details: { type: 'object', description: 'Additional structured event details' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID override' }
      },
      required: ['event']
    },
    zodSchema: z.object({
      event: z.string().min(1, 'Event description must not be empty'),
      kind: RecordKindSchema.optional(),
      details: z.record(z.unknown()).optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  forget: {
    name: 'forget',
    description: 'Supersede or archive a memory record (soft-archive by default; purge only with explicit confirmation).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID to archive or purge. Provide id OR kind+slug.' },
        kind: {
          type: 'string',
          enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review'],
          description: 'Record kind (when lookup by kind+slug)'
        },
        slug: { type: 'string', description: 'Record slug (when lookup by kind+slug)' },
        purge: { type: 'boolean', description: 'Set true to permanently delete file (defaults to false for soft archive)' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID override' }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: RecordKindSchema.optional(),
      slug: z.string().optional(),
      purge: z.boolean().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  gc: {
    name: 'gc',
    description: 'Apply TTL retention (7-day scratch, 14-day review), compact shipped plans, roll up monthly logs, and rebuild FTS index.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID to clean' },
        dryRun: { type: 'boolean', description: 'Check what would be cleaned without modifying files (defaults to false)' }
      }
    },
    zodSchema: z.object({
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      vaultRoot: z.string().optional(),
      dryRun: z.boolean().optional()
    })
  },
  promote: {
    name: 'promote',
    description: 'Copy one record or top ranked traps into the product repository (default deny without product-relative destination).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID to promote (omit when format=skill to promote top ranked traps)' },
        kind: {
          type: 'string',
          enum: ['trap', 'decision', 'spec', 'plan', 'state', 'log', 'scratch', 'review'],
          description: 'Record kind (when lookup by kind+slug)'
        },
        slug: { type: 'string', description: 'Record slug (when lookup by kind+slug)' },
        destination: { type: 'string', description: 'Product-relative destination path (e.g. docs/adr/001.md or .agents/skills/ws-recurrence/SKILL.md)' },
        format: {
          type: 'string',
          enum: ['raw', 'adr', 'madr', 'skill'],
          description: 'Output format: raw markdown, Nygard ADR, MADR, or compiled skill'
        },
        force: { type: 'boolean', description: 'Overwrite destination if it already exists' },
        limit: { type: 'number', description: 'When format is skill and id is omitted, number of top ranked traps to compile (default 10)' },
        cwd: { type: 'string', description: 'Product repository working directory' }
      },
      required: ['destination']
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: RecordKindSchema.optional(),
      slug: z.string().optional(),
      destination: z.string().min(1, 'Destination path is required'),
      format: z.enum(['raw', 'adr', 'madr', 'skill']).optional(),
      force: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional()
    })
  },
  check_version: {
    name: 'check_version',
    description:
      'Compare the running spec-memo package version to the latest npm release so agents can detect stale installs (soft-fails offline).',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    zodSchema: z.object({})
  },
  install_skills: {
    name: 'install_skills',
    description:
      'Install packaged spec-memo runtime skill(s) (default ws-memo + ws-session-tracking) into a consumer product {skillsRoot}, or with global=true into $HOME/.agents/skills (+ Antigravity if present).',
    inputSchema: {
      type: 'object',
      properties: {
        productRoot: {
          type: 'string',
          description: 'Consumer product repository root (required for local install unless cwd resolves one; ignored when global=true)'
        },
        cwd: { type: 'string', description: 'Working directory used to resolve product root when productRoot omitted' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill IDs to install (default ["ws-memo", "ws-session-tracking"])'
        },
        skillsRoot: {
          type: 'string',
          description: 'Relative skills directory under product root (default .agents/skills); ignored when global=true'
        },
        force: { type: 'boolean', description: 'Overwrite destination when it differs from packaged skill' },
        global: {
          type: 'boolean',
          description:
            'Install into $HOME/.agents/skills (always) and $HOME/.gemini/config/skills when Antigravity/Gemini config exists'
        }
      }
    },
    zodSchema: z.object({
      productRoot: z.string().optional(),
      cwd: z.string().optional(),
      skills: z.array(z.string()).optional(),
      skillsRoot: z.string().optional(),
      force: z.boolean().optional(),
      global: z.boolean().optional(),
      vaultRoot: z.string().optional(),
      packageRoot: z.string().optional(),
      homeDir: z.string().optional()
    })
  },
  prompt: {
    name: 'prompt',
    description:
      'Ingest prompt history, session lifecycles, and timesheet deliverables; query prompts, derive AI rules, export intent stories, and generate activity reports. session_end also flushes hybrid HTTP and batched vault-git sync when enabled (fail-open).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'record',
            'list',
            'get',
            'search',
            'session',
            'session_start',
            'session_end',
            'activity_report',
            'derive_rules',
            'export_story'
          ],
          description: 'Action to perform (default: "record"). session_end closes the session and triggers dual sync flush when hybrid or vaultGit is enabled.'
        },
        body: { type: 'string', description: 'Prompt content or work summary' },
        id: { type: 'string', description: 'Unique record identifier' },
        sessionId: { type: 'string', description: 'Session correlation identifier' },
        turn: { type: 'number', description: 'Turn number in conversational session' },
        taskSlug: { type: 'string', description: 'Active feature / task slug' },
        client: { type: 'string', description: 'Client or account identifier for invoicing' },
        billable: { type: 'boolean', description: 'Whether the prompt/session is billable (default: true)' },
        ide: { type: 'string', description: 'Host environment / IDE (cursor, vscode, claude, gemini, etc.)' },
        model: { type: 'string', description: 'LLM model identifier' },
        agent: { type: 'string', description: 'Subagent or role identifier' },
        deliverables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['pr', 'commit', 'spec'] },
              url: { type: 'string' },
              sha: { type: 'string' },
              title: { type: 'string' }
            }
          },
          description: 'Deliverables completed during session'
        },
        query: { type: 'string', description: 'Search term or FTS query' },
        since: { type: 'string', description: 'ISO date/time lower bound' },
        until: { type: 'string', description: 'ISO date/time upper bound' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        limit: { type: 'number', description: 'Pagination limit (default: 20, max: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        sort: { type: 'string', enum: ['date-desc', 'date-asc', 'relevance'], description: 'Sort order' },
        saveTraps: { type: 'boolean', description: 'Save derived rules as traps in vault (for derive_rules)' },
        promote: { type: 'string', description: 'Destination path to promote derived rules to' },
        format: { type: 'string', description: 'Format for rule export (cursor, copilot, claude, gemini, markdown)' },
        feedback: { type: 'string', enum: ['helpful', 'not_helpful', 'stale', 'wrong'], description: 'Feedback type (for feedback action)' },
        comment: { type: 'string', description: 'Optional feedback comment' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID override' },
        crossProject: { type: 'boolean', description: 'Query across all vaults' }
      }
    },
    zodSchema: z.object({
      action: z.enum([
        'record',
        'list',
        'get',
        'search',
        'session',
        'session_start',
        'session_end',
        'activity_report',
        'derive_rules',
        'export_story',
        'feedback'
      ]).default('record'),
      body: z.string().optional(),
      id: z.string().optional(),
      sessionId: z.string().optional(),
      turn: z.number().int().positive().optional(),
      taskSlug: z.string().optional(),
      client: z.string().optional(),
      billable: z.boolean().optional(),
      ide: z.string().optional(),
      model: z.string().optional(),
      agent: z.string().optional(),
      branch: z.string().optional(),
      gitSha: z.string().optional(),
      linkedPaths: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      deliverables: z.array(z.object({
        type: z.enum(['pr', 'commit', 'spec']),
        url: z.string().optional(),
        sha: z.string().optional(),
        title: z.string().optional()
      })).optional(),
      query: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
      sort: z.enum(['date-desc', 'date-asc', 'relevance']).optional(),
      saveTraps: z.boolean().optional(),
      promote: z.string().optional(),
      format: z.string().optional(),
      feedback: z.enum(['helpful', 'not_helpful', 'stale', 'wrong']).optional(),
      comment: z.string().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional(),
      crossProject: z.boolean().optional()
    })
  }
};

function ok(data: unknown): { data: unknown } {
  return { data: sanitizeToolOutput(data) };
}

function fail(code: string, err: unknown, details?: unknown): ToolResponse {
  const message = wrapSqliteOpenError(err).message;
  return {
    isError: true,
    error: String(sanitizeToolOutput(message)),
    code,
    details: details !== undefined ? sanitizeToolOutput(details) : undefined
  };
}

export async function executeTool(name: string, args: unknown): Promise<ToolResponse> {
  const started = performance.now();
  let projectId: string | undefined;
  let vaultRoot: string | undefined;

  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    if (typeof a.projectId === 'string') projectId = a.projectId;
    if (typeof a.vaultRoot === 'string') vaultRoot = a.vaultRoot;
    if (!projectId && typeof a.cwd === 'string') {
      try {
        projectId = resolveHybridPushProjectId({ cwd: a.cwd, vaultRoot });
      } catch {
        // ignore project resolution error
      }
    }
  }

  let response: ToolResponse;
  try {
    response = await executeToolDirect(name, args);
  } catch (err: unknown) {
    response = fail('EXECUTE_TOOL_FAILED', err);
  } finally {
    const durationMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
    const success = response! ? !response!.isError : false;
    const errorCode = response! && response!.isError ? response!.code : undefined;
    recordTelemetry({
      category: 'mcp_tool',
      operation: name,
      durationMs,
      success,
      errorCode,
      projectId,
      vaultRoot,
      metadata: {
        tool: name
      }
    });
  }

  if (response.isError) {
    logErrorReport({
      subsystem: 'mcp-tool',
      tool: name,
      projectId,
      error: response.error || 'Tool execution error',
      level: response.code === 'EXECUTE_TOOL_FAILED' ? 'ERROR' : 'WARN',
      context: {
        code: response.code,
        details: response.details,
        args: args && typeof args === 'object' ? args : { raw: args }
      }
    }, { vaultRoot });
  }

  return response;
}

async function executeToolDirect(name: string, args: unknown): Promise<ToolResponse> {
  if (!TOOL_NAMES.includes(name as ToolName)) {
    return fail('UNKNOWN_TOOL', `Unknown tool: ${name}`, { supportedTools: TOOL_NAMES });
  }

  const tool = TOOL_DEFINITIONS[name as ToolName];
  const parseResult = tool.zodSchema.safeParse(args ?? {});
  if (!parseResult.success) {
    return fail(
      'INVALID_ARGUMENTS',
      `Invalid arguments for ${name}: ${parseResult.error.message}`,
      parseResult.error.format()
    );
  }

  if (name === 'bootstrap') {
    try {
      const bootstrapOpts = parseResult.data as BootstrapOptions;
      const result = await compileBootstrapBrief(bootstrapOpts);
      const hitIds = collectBootstrapHitIds(result);
      if (hitIds.length > 0) {
        await recordMemoryHits({
          ids: hitIds,
          sessionId: bootstrapOpts.sessionId,
          source: 'bootstrap',
          projectId: bootstrapOpts.projectId || result.projectId,
          vaultRoot: bootstrapOpts.vaultRoot,
          cwd: bootstrapOpts.cwd
        });
      }
      return ok(result);
    } catch (err: unknown) {
      return fail('BOOTSTRAP_FAILED', err);
    }
  }

  if (name === 'search') {
    try {
      const searchOpts = parseResult.data as SearchOptions;
      const { hitIds, sessionId, ...indexOpts } = searchOpts;
      const results = searchIndex(indexOpts);
      if (Array.isArray(hitIds) && hitIds.length > 0) {
        const hitIdSet = new Set(hitIds);
        const idProjectHints: Record<string, string> = {};
        const ambiguousHitIds = new Set<string>();
        for (const hit of results) {
          if (!hitIdSet.has(hit.id) || !hit.projectId) continue;
          if (idProjectHints[hit.id] && idProjectHints[hit.id] !== hit.projectId) {
            ambiguousHitIds.add(hit.id);
          } else {
            idProjectHints[hit.id] = hit.projectId;
          }
        }
        for (const id of ambiguousHitIds) {
          delete idProjectHints[id];
        }
        await recordMemoryHits({
          ids: hitIds.filter((id) => !ambiguousHitIds.has(id)),
          sessionId,
          source: 'search',
          projectId: searchOpts.projectId,
          idProjectHints,
          vaultRoot: searchOpts.vaultRoot,
          cwd: searchOpts.cwd
        });
      }
      return ok(results);
    } catch (err: unknown) {
      return fail('SEARCH_FAILED', err);
    }
  }

  if (name === 'upsert') {
    try {
      const { kind, slug, frontmatter, body, path: optPath, cwd, vaultRoot, projectId } = parseResult.data as {
        kind: RecordKind;
        slug?: string;
        frontmatter?: Record<string, unknown>;
        body: string;
        path?: string;
        cwd?: string;
        vaultRoot?: string;
        projectId?: string;
      };
      if (!body || !body.trim()) {
        return fail('INVALID_ARGUMENTS', "Parameter 'body' must be a non-empty string for upsert");
      }
      const fm = { ...(frontmatter || {}) };
      if (optPath && typeof optPath === 'string' && optPath.trim()) {
        const trimmedPath = optPath.trim();
        if (!fm.pathPatterns && (kind === 'trap' || !fm.linkedPaths)) {
          fm.pathPatterns = [trimmedPath];
        }
        if (!fm.linkedPaths) {
          fm.linkedPaths = [trimmedPath];
        }
      }
      const result = await upsertRecord({
        kind,
        slug,
        frontmatter: fm,
        body,
        cwd,
        vaultRoot,
        projectId
      });
      scheduleHybridPush(vaultRoot, resolveHybridPushProjectId({ cwd, vaultRoot, projectId }));
      return ok(result);
    } catch (err: unknown) {
      return fail('UPSERT_FAILED', err);
    }
  }

  if (name === 'get') {
    try {
      const { id, kind, slug, cwd, vaultRoot, projectId, sessionId } = parseResult.data as {
        id?: string;
        kind?: RecordKind;
        slug?: string;
        cwd?: string;
        vaultRoot?: string;
        projectId?: string;
        sessionId?: string;
      };
      if (!id && !(kind && slug)) {
        return fail(
          'INVALID_ARGUMENTS',
          "Either 'id' or both 'kind' and 'slug' must be provided for get"
        );
      }
      const record = await getRecord({ id, kind, slug, cwd, vaultRoot, projectId });
      if (!record) {
        return fail('RECORD_NOT_FOUND', `Record not found: id=${id || 'n/a'}, kind=${kind || 'n/a'}, slug=${slug || 'n/a'}`);
      }
      if (isHitEligibleKind(record.frontmatter.kind)) {
        await recordMemoryHits({
          ids: [String(record.frontmatter.id)],
          sessionId,
          source: 'get',
          projectId: projectId || String(record.frontmatter.project),
          vaultRoot,
          cwd
        });
        const refreshed = await getRecord({ id: String(record.frontmatter.id), kind: record.frontmatter.kind, cwd, vaultRoot, projectId });
        if (refreshed) {
          // AC5: missing hits → 0 in payload without requiring a file rewrite
          if (refreshed.frontmatter.hits == null) {
            return ok({
              ...refreshed,
              frontmatter: { ...refreshed.frontmatter, hits: 0 }
            });
          }
          return ok(refreshed);
        }
      }
      // AC5: treat missing hits as 0 in payload without rewriting the file
      if (record.frontmatter.hits == null) {
        return ok({
          ...record,
          frontmatter: { ...record.frontmatter, hits: 0 }
        });
      }
      return ok(record);
    } catch (err: unknown) {
      return fail('GET_FAILED', err);
    }
  }

  if (name === 'append') {
    try {
      const appendOpts = parseResult.data as AppendOptions;
      if (!appendOpts.event || !appendOpts.event.trim()) {
        return fail('INVALID_ARGUMENTS', "Parameter 'event' must be a non-empty string for append");
      }
      const result = await appendEvent(appendOpts);
      scheduleHybridPush(
        appendOpts.vaultRoot,
        resolveHybridPushProjectId(appendOpts)
      );
      return ok(result);
    } catch (err: unknown) {
      return fail('APPEND_FAILED', err);
    }
  }

  if (name === 'forget') {
    try {
      const forgetOpts = parseResult.data as ForgetOptions;
      if (!forgetOpts.id && !(forgetOpts.kind && forgetOpts.slug)) {
        return fail(
          'INVALID_ARGUMENTS',
          "Either 'id' or both 'kind' and 'slug' must be provided for forget"
        );
      }
      const result = await forgetRecord(forgetOpts);
      scheduleHybridPush(
        forgetOpts.vaultRoot,
        resolveHybridPushProjectId(forgetOpts)
      );
      return ok(result);
    } catch (err: unknown) {
      return fail('FORGET_FAILED', err);
    }
  }

  if (name === 'gc') {
    try {
      const gcOpts = parseResult.data as GcOptions;
      const result = await runGc(gcOpts);
      if (!gcOpts.dryRun) {
        scheduleHybridPush(
          gcOpts.vaultRoot,
          resolveHybridPushProjectId({
            cwd: gcOpts.cwd,
            vaultRoot: gcOpts.vaultRoot,
            projectId: gcOpts.projectId || result.projectId
          })
        );
      }
      return ok(result);
    } catch (err: unknown) {
      return fail('GC_FAILED', err);
    }
  }

  if (name === 'promote') {
    try {
      const promoteOpts = parseResult.data as PromoteOptions;
      if (!promoteOpts.destination || !promoteOpts.destination.trim()) {
        return fail(
          'INVALID_ARGUMENTS',
          "Parameter 'destination' is required and must be a non-empty product-relative path"
        );
      }
      const result = await promoteRecord(promoteOpts);
      return ok(result);
    } catch (err: unknown) {
      return fail('PROMOTE_FAILED', err);
    }
  }

  if (name === 'check_version') {
    try {
      const versionOpts = parseResult.data as CheckVersionOptions;
      const result = await checkVersion(versionOpts);
      return ok(result);
    } catch (err: unknown) {
      return fail('CHECK_VERSION_FAILED', err);
    }
  }

  if (name === 'install_skills') {
    try {
      const installOpts = parseResult.data as InstallSkillsOptions;
      const result = await installSkills(installOpts);
      return ok(result);
    } catch (err: unknown) {
      return fail('INSTALL_SKILLS_FAILED', err);
    }
  }

  if (name === 'prompt') {
    try {
      const promptOpts = parseResult.data as PromptOptions;
      const action = promptOpts.action || 'record';
      const vaultRoot = promptOpts.vaultRoot;
      const cwd = promptOpts.cwd;
      const projectId = promptOpts.projectId;

      if (action === 'record') {
        if (!promptOpts.body || !promptOpts.body.trim()) {
          return fail('INVALID_ARGUMENTS', "Parameter 'body' is required for prompt record action.");
        }
        const result = await recordPromptTurn(promptOpts);
        scheduleHybridPush(vaultRoot, resolveHybridPushProjectId({ cwd, vaultRoot, projectId }));
        return ok(result);
      }

      if (action === 'session_start') {
        const result = await startSessionRecord(promptOpts);
        scheduleHybridPush(vaultRoot, resolveHybridPushProjectId({ cwd, vaultRoot, projectId }));
        return ok(result);
      }

      if (action === 'session_end') {
        if (!promptOpts.sessionId) {
          return fail('INVALID_ARGUMENTS', "Parameter 'sessionId' is required for session_end action.");
        }
        const result = await endSessionRecord(promptOpts);
        scheduleHybridPush(vaultRoot, resolveHybridPushProjectId({ cwd, vaultRoot, projectId }));
        return ok(result);
      }

      if (action === 'search') {
        const result = searchPrompts(promptOpts);
        return ok(result);
      }

      if (action === 'list') {
        const result = listPrompts(promptOpts);
        return ok(result);
      }

      if (action === 'session') {
        if (!promptOpts.sessionId) {
          return fail('INVALID_ARGUMENTS', "Parameter 'sessionId' is required for session action.");
        }
        const result = getSessionTurns({
          sessionId: promptOpts.sessionId,
          cwd: promptOpts.cwd,
          projectId: promptOpts.projectId,
          vaultRoot: promptOpts.vaultRoot
        });
        return ok(result);
      }

      if (action === 'get') {
        if (!promptOpts.id) {
          return fail('INVALID_ARGUMENTS', "Parameter 'id' is required for get action.");
        }
        const record = (await getRecord({
          id: promptOpts.id,
          kind: 'prompt',
          cwd: promptOpts.cwd,
          vaultRoot: promptOpts.vaultRoot,
          projectId: promptOpts.projectId
        })) || (await getRecord({
          id: promptOpts.id,
          kind: 'session',
          cwd: promptOpts.cwd,
          vaultRoot: promptOpts.vaultRoot,
          projectId: promptOpts.projectId
        }));

        if (!record) {
          return fail('RECORD_NOT_FOUND', `Prompt or session record '${promptOpts.id}' not found`);
        }
        return ok(record);
      }

      if (action === 'activity_report') {
        const result = generateActivityReport(promptOpts);
        return ok(result);
      }

      if (action === 'derive_rules') {
        const productCwd =
          promptOpts.cwd ||
          (promptOpts.projectId
            ? getProjectMetadata(promptOpts.projectId, getVaultRoot(promptOpts.vaultRoot))?.lastSeenRoot
            : undefined);
        if (promptOpts.promote && !productCwd) {
          return fail(
            'INVALID_ARGUMENTS',
            'cwd or a bootstrapped projectId with lastSeenRoot is required when promote is set.'
          );
        }
        const result = await deriveRulesFromPrompts({
          cwd: productCwd,
          projectId: promptOpts.projectId,
          vaultRoot: promptOpts.vaultRoot,
          sessionId: promptOpts.sessionId,
          saveTraps: promptOpts.saveTraps,
          promote: promptOpts.promote,
          format: promptOpts.format as any
        });
        if (result.savedTraps && result.savedTraps.length > 0) {
          scheduleHybridPush(vaultRoot, resolveHybridPushProjectId({ cwd, vaultRoot, projectId }));
        }
        return ok(result);
      }

      if (action === 'export_story') {
        if (!promptOpts.sessionId) {
          return fail('INVALID_ARGUMENTS', "Parameter 'sessionId' is required for export_story action.");
        }
        const productCwd =
          promptOpts.cwd ||
          (promptOpts.projectId
            ? getProjectMetadata(promptOpts.projectId, getVaultRoot(promptOpts.vaultRoot))?.lastSeenRoot
            : undefined);
        if (promptOpts.promote && !productCwd) {
          return fail(
            'INVALID_ARGUMENTS',
            'cwd or a bootstrapped projectId with lastSeenRoot is required when promote/outputPath is set.'
          );
        }
        const result = await exportSessionStory({
          sessionId: promptOpts.sessionId,
          cwd: productCwd,
          projectId: promptOpts.projectId,
          vaultRoot: promptOpts.vaultRoot,
          outputPath: promptOpts.promote
        });
        return ok(result);
      }

      if (action === 'feedback') {
        if (!promptOpts.id) {
          return fail('INVALID_ARGUMENTS', "Parameter 'id' is required for feedback action.");
        }
        if (!promptOpts.feedback) {
          return fail('INVALID_ARGUMENTS', "Parameter 'feedback' is required for feedback action.");
        }
        try {
          const result = await submitMemoryFeedback({
            id: promptOpts.id,
            feedback: promptOpts.feedback,
            comment: promptOpts.comment,
            cwd: promptOpts.cwd,
            vaultRoot: promptOpts.vaultRoot,
            projectId: promptOpts.projectId
          });
          return ok(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Record not found')) {
            return fail('RECORD_NOT_FOUND', msg);
          }
          return fail('FEEDBACK_FAILED', err);
        }
      }

      return fail('INVALID_ARGUMENTS', `Unsupported prompt action: ${action}`);
    } catch (err: unknown) {
      return fail('PROMPT_TOOL_FAILED', err);
    }
  }

  return {
    isError: true,
    error: `Tool '${name}' is not yet implemented`,
    code: 'NOT_IMPLEMENTED',
    details: { tool: name, args: parseResult.data }
  };
}



