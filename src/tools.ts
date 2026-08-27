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
  RecordKind,
  RecordStatus,
  SearchOptions
} from './types.js';
import { upsertRecord, getRecord, appendEvent, forgetRecord } from './store.js';
import { searchIndex } from './indexer.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { runGc } from './curator.js';
import { promoteRecord } from './promote.js';
import { checkVersion } from './version.js';
import { installSkills } from './skills-install.js';
import { sanitizeToolOutput } from './safety.js';
import { scheduleHybridPush } from './hybrid-sync.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot } from './vault.js';
import { recordTelemetry } from './telemetry.js';

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
    description: "Bind cwd's git remote; compile a session brief (traps, open decisions, live spec/plan, drift flags).",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Product repository working directory (defaults to current dir)' },
        query: { type: 'string', description: 'Optional context query or task intent to filter traps/decisions' },
        slug: { type: 'string', description: 'Active feature spec/plan slug' },
        path: { type: 'string', description: 'Focus file path to prioritize matching traps' },
        maxBytes: { type: 'number', description: 'Maximum UTF-8 payload byte budget (defaults to vault config.bootstrap.maxBytes, 8192)' },
        projectId: { type: 'string', description: 'Specific project ID' }
      }
    },
    zodSchema: z.object({
      cwd: z.string().optional(),
      query: z.string().optional(),
      slug: z.string().optional(),
      path: z.string().optional(),
      maxBytes: z.number().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  search: {
    name: 'search',
    description: 'Filtered retrieval across memory records (excludes scratch, logs, review by default).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or FTS query' },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by record kinds (e.g. trap, decision, spec)'
        },
        status: { type: 'string', description: 'Filter by status (active, shipped, superseded, archived)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags'
        },
        path: { type: 'string', description: 'Match records whose pathPatterns cover this file path' },
        includeScratch: { type: 'boolean', description: 'Include scratch records (omitted by default)' },
        projectId: { type: 'string', description: 'Specific project ID to search' },
        crossProject: { type: 'boolean', description: 'Search across all bound projects' },
        limit: { type: 'number', description: 'Maximum number of results to return' },
        sort: {
          type: 'string',
          enum: ['relevance', 'occurrences', 'updated'],
          description: 'Result order: relevance (default), occurrences, or updated'
        },
        cwd: { type: 'string', description: 'Product repository working directory' },
      }
    },
    zodSchema: z.object({
      query: z.string().optional(),
      kinds: z.array(z.string()).optional(),
      status: z.string().optional(),
      tags: z.array(z.string()).optional(),
      path: z.string().optional(),
      includeScratch: z.boolean().optional(),
      projectId: z.string().optional(),
      crossProject: z.boolean().optional(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      sort: z.enum(['relevance', 'occurrences', 'updated']).optional()
    })
  },
  get: {
    name: 'get',
    description: 'Read one record by id or kind+slug.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record unique ID' },
        kind: { type: 'string', description: 'Record kind' },
        slug: { type: 'string', description: 'Record slug (if kind is specified)' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID' }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  upsert: {
    name: 'upsert',
    description: 'Write or update a memory record (trap, decision, spec, plan, state, review, scratch).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Record kind (trap, decision, spec, plan, state, log, scratch, review)' },
        slug: { type: 'string', description: 'Record slug identifier' },
        frontmatter: { type: 'object', description: 'Record frontmatter metadata' },
        body: { type: 'string', description: 'Record Markdown content' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID' }
      },
      required: ['kind', 'body']
    },
    zodSchema: z.object({
      kind: z.string(),
      slug: z.string().optional(),
      frontmatter: z.record(z.unknown()).optional(),
      body: z.string(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  append: {
    name: 'append',
    description: 'Append a changelog or audit run event (write-only).',
    inputSchema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event description or log text' },
        kind: { type: 'string', description: 'Log kind (defaults to log)' },
        details: { type: 'object', description: 'Additional structured event details' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID' }
      },
      required: ['event']
    },
    zodSchema: z.object({
      event: z.string(),
      kind: z.string().optional(),
      details: z.record(z.unknown()).optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  forget: {
    name: 'forget',
    description: 'Supersede or archive a memory record.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID to archive' },
        kind: { type: 'string', description: 'Record kind' },
        slug: { type: 'string', description: 'Record slug' },
        purge: { type: 'boolean', description: 'Set true to permanently delete file (defaults to false for archive)' },
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID' }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional(),
      purge: z.boolean().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional(),
      projectId: z.string().optional()
    })
  },
  gc: {
    name: 'gc',
    description: 'Apply TTL, compact shipped plans, and rebuild FTS index.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Product repository working directory' },
        projectId: { type: 'string', description: 'Specific project ID to clean' },
        dryRun: { type: 'boolean', description: 'Check what would be cleaned without modifying files' }
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
    description: 'Copy one record into the product repository (default deny without product-relative destination).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record ID to promote' },
        kind: { type: 'string', description: 'Record kind' },
        slug: { type: 'string', description: 'Record slug' },
        destination: { type: 'string', description: 'Product-relative destination path (e.g. docs/adr/001.md)' },
        format: {
          type: 'string',
          enum: ['raw', 'adr', 'madr', 'skill'],
          description: 'Output format: raw markdown, Nygard ADR, MADR, or compiled skill'
        },
        force: { type: 'boolean', description: 'Overwrite destination if it already exists' },
        limit: { type: 'number', description: 'When format is skill and id is omitted, number of ranked traps to compile' },
        cwd: { type: 'string', description: 'Product repository working directory' },
      },
      required: ['destination']
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional(),
      destination: z.string(),
      format: z.enum(['raw', 'adr', 'madr', 'skill']).optional(),
      force: z.boolean().optional(),
      limit: z.number().optional(),
      cwd: z.string().optional(),
      vaultRoot: z.string().optional()
    })
  },
  check_version: {
    name: 'check_version',
    description:
      'Compare the running spec-memo package version to the latest npm release so agents can detect stale installs.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    zodSchema: z.object({})
  },
  install_skills: {
    name: 'install_skills',
    description:
      'Install packaged spec-memo runtime skill(s) (default ws-memo) into a consumer product {skillsRoot}.',
    inputSchema: {
      type: 'object',
      properties: {
        productRoot: {
          type: 'string',
          description: 'Consumer product repository root (required unless cwd resolves one)'
        },
        cwd: { type: 'string', description: 'Working directory used to resolve product root when productRoot omitted' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill ids to install (default ["ws-memo"])'
        },
        skillsRoot: {
          type: 'string',
          description: 'Relative skills directory under product root (default .agents/skills)'
        },
        force: { type: 'boolean', description: 'Overwrite destination when it differs from packaged skill' }
      }
    },
    zodSchema: z.object({
      productRoot: z.string().optional(),
      cwd: z.string().optional(),
      skills: z.array(z.string()).optional(),
      skillsRoot: z.string().optional(),
      force: z.boolean().optional(),
      vaultRoot: z.string().optional(),
      packageRoot: z.string().optional()
    })
  }
};

function ok(data: unknown): { data: unknown } {
  return { data: sanitizeToolOutput(data) };
}

function fail(code: string, err: unknown, details?: unknown): ToolResponse {
  const message = err instanceof Error ? err.message : String(err);
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
      return ok(result);
    } catch (err: unknown) {
      return fail('BOOTSTRAP_FAILED', err);
    }
  }

  if (name === 'search') {
    try {
      const searchOpts = parseResult.data as SearchOptions;
      const results = searchIndex(searchOpts);
      return ok(results);
    } catch (err: unknown) {
      return fail('SEARCH_FAILED', err);
    }
  }

  if (name === 'upsert') {
    try {
      const { kind, slug, frontmatter, body, cwd, vaultRoot, projectId } = parseResult.data as {
        kind: RecordKind;
        slug?: string;
        frontmatter?: Record<string, unknown>;
        body: string;
        cwd?: string;
        vaultRoot?: string;
        projectId?: string;
      };
      const result = await upsertRecord({
        kind,
        slug,
        frontmatter,
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
      const { id, kind, slug, cwd, vaultRoot, projectId } = parseResult.data as {
        id?: string;
        kind?: RecordKind;
        slug?: string;
        cwd?: string;
        vaultRoot?: string;
        projectId?: string;
      };
      const record = await getRecord({ id, kind, slug, cwd, vaultRoot, projectId });
      if (!record) {
        return fail('RECORD_NOT_FOUND', `Record not found: id=${id || 'n/a'}, kind=${kind || 'n/a'}, slug=${slug || 'n/a'}`);
      }
      return ok(record);
    } catch (err: unknown) {
      return fail('GET_FAILED', err);
    }
  }

  if (name === 'append') {
    try {
      const appendOpts = parseResult.data as AppendOptions;
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

  return {
    isError: true,
    error: `Tool '${name}' is not yet implemented`,
    code: 'NOT_IMPLEMENTED',
    details: { tool: name, args: parseResult.data }
  };
}


