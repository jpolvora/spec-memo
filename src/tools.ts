import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TOOL_NAMES,
  ToolName,
  ToolResponse,
  AppendOptions,
  BootstrapOptions,
  BootstrapBrief,
  ForgetOptions,
  GcOptions,
  IoGuardEnvelope,
  MemoRecord,
  PromoteOptions,
  CheckVersionOptions,
  InstallSkillsOptions,
  PromptOptions,
  RecordKind,
  RecordStatus,
  SearchHit,
  SearchOptions
} from './types.js';
import { RecordKindSchema, RecordStatusSchema } from './schema.js';
import { upsertRecord, getRecord, appendEvent, forgetRecord } from './store.js';
import { searchIndexRanked } from './ai/search.js';
import { resolveVaultAiAgent, VAULT_AI_DEFAULT_TIMEOUT_MS, VAULT_AI_DEFAULT_RANK_TOP_K } from './ai/index.js';
import type { VaultAiAgent } from './ai/types.js';
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
import { normalizeInstallHosts } from './install-wizard.js';
import {
  recordPromptTurn,
  startSessionRecord,
  endSessionRecord,
  getSessionTurns,
  exportSessionStory,
  listPrompts,
  searchPrompts,
  deriveRulesFromPrompts,
  generateActivityReport,
  cancelHandoffRecord,
  showHandoffRecord,
  listSessions
} from './prompt.js';

function preprocessJsonObject(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return val;
    }
  }
  return val;
}

function preprocessJsonArray(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return val;
    }
  }
  return val;
}

import { submitMemoryFeedback } from './feedback.js';
import { sanitizeToolOutput } from './safety.js';
import {
  canonicalBodyForChecksum,
  fenceInnerOf,
  inspectAgentIo,
  ioChecksumHex,
  isIoGuardError,
  isUntrustedWrapped,
  logIoGuardRefusal,
  UNTRUSTED_BEGIN,
  verifyIoChecksum,
  verifyStoredChecksum,
  wrapUntrustedText
} from './io-guard.js';
import { parseRecord } from './schema.js';
import { calculatePayloadSize } from './bootstrap.js';
import { rollbackHandoffClaim } from './handoff.js';
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

/**
 * Resolve the vault AI agent for a tool call (spec 0056).
 * Fail-open: unknown providers or config errors yield a null agent here;
 * process startup (`mcp.ts`/`server.ts`/CLI serve) validates fail-closed.
 */
function resolveToolAi(vaultRoot: string | undefined): {
  agent: VaultAiAgent | null;
  rankTopK: number;
  timeoutMs: number;
} {
  try {
    const root = vaultRoot || getVaultRoot();
    const { agent, config } = resolveVaultAiAgent(root);
    if (!agent.isAvailable()) {
      return { agent: null, rankTopK: config.rankTopK, timeoutMs: config.timeoutMs };
    }
    return { agent, rankTopK: config.rankTopK, timeoutMs: config.timeoutMs };
  } catch {
    return { agent: null, rankTopK: VAULT_AI_DEFAULT_RANK_TOP_K, timeoutMs: VAULT_AI_DEFAULT_TIMEOUT_MS };
  }
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
        },
        explain: {
          type: 'boolean',
          description: 'When true, include budget allocation diagnostics in the response'
        },
        continuation: {
          type: 'boolean',
          description:
            'When true, include latest session summary, eligible handoff, and at most 3 durable traps (default false)'
        },
        resume: {
          type: 'boolean',
          description: 'Alias for continuation; continuation wins when both are set'
        }
      }
    },
    zodSchema: z
      .object({
        cwd: z.string().optional(),
        query: z.string().optional(),
        slug: z.string().optional(),
        path: z.string().optional(),
        maxBytes: z.number().int().positive().optional(),
        vaultRoot: z.string().optional(),
        projectId: z.string().optional(),
        sessionId: z.string().optional(),
        explain: z.boolean().optional(),
        continuation: z.boolean().optional(),
        resume: z.boolean().optional()
      })
      .transform((data) => {
        const { resume, ...rest } = data;
        return {
          ...rest,
          continuation: data.continuation ?? resume ?? false
        };
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
        explain: {
          type: 'boolean',
          description: 'When true, attach ephemeral scoring breakdown per hit'
        },
        includeExpired: {
          type: 'boolean',
          description: 'Include expired records in results (default false)'
        },
        asOf: {
          type: 'string',
          description: 'Point-in-time ISO date (YYYY-MM-DD or RFC3339) for time-travel search'
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
      sessionId: z.string().optional(),
      explain: z.boolean().optional(),
      includeExpired: z.boolean().optional(),
      asOf: z.string().optional()
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
      frontmatter: z.preprocess(preprocessJsonObject, z.record(z.unknown()).optional()),
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
      details: z.preprocess(preprocessJsonObject, z.record(z.unknown()).optional()),
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
        dryRun: { type: 'boolean', description: 'Check what would be cleaned without modifying files (defaults to false)' },
        purge: { type: 'boolean', description: 'Permanently unlink expired records instead of archiving traps/decisions/plans' }
      }
    },
    zodSchema: z.object({
      cwd: z.string().optional(),
      projectId: z.string().optional(),
      vaultRoot: z.string().optional(),
      dryRun: z.boolean().optional(),
      purge: z.boolean().optional()
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
      'Install packaged spec-memo runtime skill(s) into explicitly selected local or global host roots. Writes require scope, hosts, conflictPolicy, and confirm: true.',
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
            'Legacy alias for scope=global; host targets are never inferred'
        },
        scope: {
          type: 'string',
          enum: ['local', 'global'],
          description: 'Required install scope'
        },
        hosts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required explicit host ids or aliases; all requires confirm: true'
        },
        conflictPolicy: {
          type: 'string',
          enum: ['skip', 'update', 'force'],
          description: 'Required existing-destination policy'
        },
        confirm: {
          type: 'boolean',
          description: 'Required explicit permission to write files'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview without writing files'
        }
      },
      required: ['scope', 'hosts', 'conflictPolicy', 'confirm']
    },
    zodSchema: z.object({
      productRoot: z.string().optional(),
      cwd: z.string().optional(),
      skills: z.array(z.string()).optional(),
      skillsRoot: z.string().optional(),
      force: z.boolean().optional(),
      global: z.boolean().optional(),
      scope: z.enum(['local', 'global']).optional(),
      hosts: z.array(z.string()).optional(),
      conflictPolicy: z.enum(['skip', 'update', 'force']).optional(),
      confirm: z.boolean().optional(),
      dryRun: z.boolean().optional(),
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
            'cancel_handoff',
            'activity_report',
            'derive_rules',
            'export_story'
          ],
          description: 'Action to perform (default: "record"). session returns turns for a sessionId, or lists sessions if sessionId is omitted. session_end closes the session and triggers dual sync flush when hybrid or vaultGit is enabled.'
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
        handoff: {
          type: 'object',
          description: 'Forward-looking handoff baton for the next agent session',
          properties: {
            nextSteps: { type: 'array', items: { type: 'string' } },
            failedApproaches: { type: 'array', items: { type: 'string' } },
            openQuestions: { type: 'array', items: { type: 'string' } },
            branch: { type: 'string' },
            owner: { type: 'string' },
            shared: { type: 'boolean' }
          }
        },
        objective: { type: 'string', description: 'In-flight session focus recorded on session_start' },
        shared: { type: 'boolean', description: 'Mark handoff as project-wide (session_end)' },
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
        'cancel_handoff',
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
      deliverables: z.preprocess(
        preprocessJsonArray,
        z.array(z.object({
          type: z.enum(['pr', 'commit', 'spec']),
          url: z.string().optional(),
          sha: z.string().optional(),
          title: z.string().optional()
        })).optional()
      ),
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
      handoff: z.preprocess(
        preprocessJsonObject,
        z.object({
          nextSteps: z.array(z.string()),
          failedApproaches: z.array(z.string()).optional(),
          openQuestions: z.array(z.string()).optional(),
          branch: z.string().optional(),
          owner: z.string().optional(),
          shared: z.boolean().optional()
        }).optional()
      ),
      objective: z.string().optional(),
      shared: z.boolean().optional(),
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

/**
 * Spec 0059 outbound (AC12-AC14, AC21): sanitize first (secrets/paths),
 * then verify stored checksums (mismatch omits body, never whole-tool
 * fail), then fence bodies/snippets as untrusted data with a SHA-256
 * envelope over the fence-inner text.
 */
function buildIoGuardEnvelope(args: {
  inners: string[];
  queryDropped?: boolean;
  checksumMismatch?: boolean;
}): IoGuardEnvelope {
  const envelope: IoGuardEnvelope = { untrusted: true, alg: 'sha256' };
  if (args.inners.length > 0) {
    const candidate = ioChecksumHex(args.inners.join('\n'));
    // AC22: the checksum field is present only when it equals
    // ioChecksumHex(inner); recomputed here, so it always does — the
    // explicit re-verify keeps the invariant fail-closed by construction.
    if (verifyIoChecksum(args.inners.join('\n'), candidate)) {
      envelope.checksum = candidate;
    }
  }
  if (args.queryDropped === true) {
    envelope.queryDropped = true;
  }
  if (args.checksumMismatch === true) {
    envelope.checksumMismatch = true;
  }
  return envelope;
}

/** Verify one sanitized record body; omit + flag on mismatch (AC21). */
function verifyAndCollectRecordBody(
  record: MemoRecord,
  inners: string[],
  ctx: { vaultRoot?: string; projectId?: string; tool: string; recordId: string }
): boolean {
  const stored = (record.frontmatter as Record<string, unknown> | undefined)?.ioChecksum;
  if (
    stored !== undefined &&
    stored !== null &&
    !verifyIoChecksum(canonicalBodyForChecksum(record.body || ''), stored)
  ) {
    record.body = '';
    logIoGuardRefusal(
      {
        reason: 'read omitted: checksum mismatch',
        flags: [],
        bodyChars: 0,
        projectId: ctx.projectId,
        tool: ctx.tool,
        recordId: ctx.recordId
      },
      { vaultRoot: ctx.vaultRoot }
    );
    return true;
  }
  if (typeof record.body === 'string' && record.body.length > 0) {
    const fenced = wrapUntrustedText(record.body);
    inners.push(fenceInnerOf(fenced));
    record.body = fenced;
  }
  return false;
}

/** Spec 0059 outbound for `get` (AC12-AC14, AC21): sanitize, verify, fence. */
function guardGetRecord(
  record: MemoRecord,
  ctx: { vaultRoot?: string; projectId?: string }
): { data: unknown; ioGuard: IoGuardEnvelope } {
  const sanitized = sanitizeToolOutput(record) as MemoRecord;
  const inners: string[] = [];
  const mismatch = verifyAndCollectRecordBody(sanitized, inners, {
    vaultRoot: ctx.vaultRoot,
    projectId: ctx.projectId || String(sanitized.frontmatter?.project || ''),
    tool: 'get',
    recordId: String(sanitized.frontmatter?.id || sanitized.frontmatter?.slug || 'unknown')
  });
  const ioGuard = buildIoGuardEnvelope({ inners, checksumMismatch: mismatch });
  return {
    data: { ...sanitized, ioGuard },
    ioGuard
  };
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
      const bootstrapOpts = parseResult.data as BootstrapOptions & { resume?: boolean };
      delete bootstrapOpts.resume;
      const toolAi = resolveToolAi(bootstrapOpts.vaultRoot);
      const result = await compileBootstrapBrief(bootstrapOpts, {
        agent: toolAi.agent,
        rankTopK: toolAi.rankTopK,
        timeoutMs: toolAi.timeoutMs
      });
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
      // Spec 0059 outbound: sanitize, checksum-verify, fence, envelope.
      const brief = sanitizeToolOutput(result) as BootstrapBrief;
      // Round-3 review: thread the hostile-query signal into the envelope
      // directly (not via notices, which budget pressure can evict).
      const queryDropped =
        typeof bootstrapOpts.query === 'string' &&
        bootstrapOpts.query.trim().length > 0 &&
        !inspectAgentIo(bootstrapOpts.query).ok;
      const inners: string[] = [];
      let checksumMismatch = false;
      const guardCtx = {
        vaultRoot: bootstrapOpts.vaultRoot,
        projectId: bootstrapOpts.projectId || brief.projectId,
        tool: 'bootstrap'
      };
      for (const rec of [...(brief.traps || []), ...(brief.decisions || [])]) {
        if (
          verifyAndCollectRecordBody(rec, inners, {
            ...guardCtx,
            recordId: String(rec.frontmatter?.id || rec.frontmatter?.slug || 'unknown')
          })
        ) {
          checksumMismatch = true;
        }
      }
      for (const sliceRec of [
        brief.activeSlice?.spec,
        brief.activeSlice?.plan,
        brief.activeSlice?.state
      ]) {
        if (sliceRec) {
          if (
            verifyAndCollectRecordBody(sliceRec, inners, {
              ...guardCtx,
              recordId: String(sliceRec.frontmatter?.id || sliceRec.frontmatter?.slug || 'unknown')
            })
          ) {
            checksumMismatch = true;
          }
        }
      }
      if (brief.handoffMarkdown) {
        const fenced = isUntrustedWrapped(brief.handoffMarkdown)
          ? brief.handoffMarkdown
          : wrapUntrustedText(brief.handoffMarkdown);
        inners.push(fenceInnerOf(fenced));
        brief.handoffMarkdown = fenced;
      }
      if (brief.handoff) {
        // PR#65 round 3: the structured handoff object carries the same free
        // text as handoffMarkdown (nextSteps/failedApproaches/openQuestions/
        // harness) but was delivered raw. Fence the object fields and fold
        // their inners into the envelope so the checksum covers them.
        const h = { ...brief.handoff };
        const fenceOne = (s: string): string =>
          isUntrustedWrapped(s) ? s : wrapUntrustedText(s);
        h.nextSteps = (h.nextSteps || []).map(fenceOne);
        if (h.failedApproaches) h.failedApproaches = h.failedApproaches.map(fenceOne);
        if (h.openQuestions) h.openQuestions = h.openQuestions.map(fenceOne);
        if (typeof h.harness === 'string' && h.harness.length > 0) {
          h.harness = fenceOne(h.harness);
        }
        if (typeof h.owner === 'string' && h.owner.length > 0) {
          h.owner = fenceOne(h.owner);
        }
        if (typeof h.branch === 'string' && h.branch.length > 0) {
          h.branch = fenceOne(h.branch);
        }
        brief.handoff = h;
        for (const s of [
          ...h.nextSteps,
          ...(h.failedApproaches ?? []),
          ...(h.openQuestions ?? [])
        ]) {
          inners.push(fenceInnerOf(s));
        }
        for (const s of [h.harness, h.owner, h.branch]) {
          if (typeof s === 'string' && s.length > 0) {
            inners.push(fenceInnerOf(s));
          }
        }
      }
      if (brief.sessionObjective?.objective) {
        const fenced = isUntrustedWrapped(brief.sessionObjective.objective)
          ? brief.sessionObjective.objective
          : wrapUntrustedText(brief.sessionObjective.objective);
        inners.push(fenceInnerOf(fenced));
        brief.sessionObjective = { ...brief.sessionObjective, objective: fenced };
      }
      if (brief.sessionResume) {
        const resume = { ...brief.sessionResume };
        for (const key of ['summary', 'body'] as const) {
          const val = resume[key];
          if (typeof val === 'string' && val.length > 0) {
            const fenced = isUntrustedWrapped(val) ? val : wrapUntrustedText(val);
            inners.push(fenceInnerOf(fenced));
            resume[key] = fenced;
          }
        }
        brief.sessionResume = resume;
      }
      const ioGuard = buildIoGuardEnvelope({ inners, checksumMismatch, queryDropped });
      brief.ioGuard = ioGuard;
      // Spec 0059 review (PR#65): fences grow bodies after the byte-budget
      // pass, so re-account and shed lowest-ranked fenced records first.
      // The stale-budget payload must never exceed what byteLength claims.
      const collectFenceInners = (target: string[]): void => {
        const collectOne = (rec: MemoRecord | undefined): void => {
          if (!rec || typeof rec.body !== 'string' || !rec.body.includes(UNTRUSTED_BEGIN)) {
            return;
          }
          target.push(fenceInnerOf(rec.body));
        };
        for (const rec of [...brief.traps, ...brief.decisions]) {
          collectOne(rec);
        }
        collectOne(brief.activeSlice?.spec);
        collectOne(brief.activeSlice?.plan);
        collectOne(brief.activeSlice?.state);
        if (brief.handoff) {
          const h = brief.handoff;
          for (const s of [
            ...(h.nextSteps || []),
            ...(h.failedApproaches ?? []),
            ...(h.openQuestions ?? [])
          ]) {
            if (typeof s === 'string' && s.includes(UNTRUSTED_BEGIN)) {
              target.push(fenceInnerOf(s));
            }
          }
          if (typeof h.harness === 'string' && h.harness.includes(UNTRUSTED_BEGIN)) {
            target.push(fenceInnerOf(h.harness));
          }
          for (const s of [h.owner, h.branch]) {
            if (typeof s === 'string' && s.includes(UNTRUSTED_BEGIN)) {
              target.push(fenceInnerOf(s));
            }
          }
        }
        if (
          typeof brief.handoffMarkdown === 'string' &&
          brief.handoffMarkdown.includes(UNTRUSTED_BEGIN)
        ) {
          target.push(fenceInnerOf(brief.handoffMarkdown));
        }
        if (
          typeof brief.sessionObjective?.objective === 'string' &&
          brief.sessionObjective.objective.includes(UNTRUSTED_BEGIN)
        ) {
          target.push(fenceInnerOf(brief.sessionObjective.objective));
        }
        for (const key of ['summary', 'body'] as const) {
          const val = brief.sessionResume?.[key];
          if (typeof val === 'string' && val.includes(UNTRUSTED_BEGIN)) {
            target.push(fenceInnerOf(val));
          }
        }
      };
      const refitEnvelope = (): IoGuardEnvelope => {
        const refitInners: string[] = [];
        collectFenceInners(refitInners);
        return buildIoGuardEnvelope({ inners: refitInners, checksumMismatch, queryDropped });
      };
      brief.byteLength = calculatePayloadSize(brief);
      if (brief.byteLength > brief.budgetBytes) {
        const overBudget = (): boolean => calculatePayloadSize(brief) > brief.budgetBytes;
        while (brief.traps.length > 0 && overBudget()) {
          brief.traps.pop();
        }
        while (brief.decisions.length > 0 && overBudget()) {
          brief.decisions.pop();
        }
        while (brief.activeSlice?.state && overBudget()) {
          delete brief.activeSlice.state;
        }
        while (brief.activeSlice?.plan && overBudget()) {
          delete brief.activeSlice.plan;
        }
        while (brief.activeSlice?.spec && overBudget()) {
          delete brief.activeSlice.spec;
        }
        // Round-2 review: shed the handoff block last (highest value).
        // Partition is airtight: an object present at refit start was
        // claimed this session (rollback on markdown shed); markdown-only
        // briefs were delivered unclaimed pre-fence (no rollback needed).
        const refitClaimedId =
          brief.handoff && typeof brief.handoff.id === 'string' ? brief.handoff.id : undefined;
        if (brief.handoff && overBudget()) {
          delete brief.handoff;
        }
        if (brief.handoffMarkdown && overBudget()) {
          if (refitClaimedId) {
            try {
              const handoffProjectDir = path.join(
                getVaultRoot(bootstrapOpts.vaultRoot),
                'projects',
                String(bootstrapOpts.projectId || brief.projectId)
              );
              rollbackHandoffClaim(handoffProjectDir, refitClaimedId);
            } catch {
              // Best-effort rollback; the shed below still holds the budget.
            }
          }
          delete brief.handoffMarkdown;
        }
        // Round-3 review: shed the same low-value fields bootstrap sheds
        // pre-fence (drift, sessionResume, explain report), then notices
        // oldest-first keeping the final receipt.
        while (brief.drift && brief.drift.length > 0 && overBudget()) {
          brief.drift.pop();
        }
        if (brief.drift && brief.drift.length === 0) {
          brief.drift = undefined;
        }
        if (brief.sessionResume && overBudget()) {
          delete brief.sessionResume;
        }
        if (brief.budgetReport && overBudget()) {
          delete brief.budgetReport;
        }
        // PR#65 round 3: a large fenced sessionObjective must not keep the
        // brief over budget once every lower-value field has been shed.
        if (brief.sessionObjective && overBudget()) {
          delete brief.sessionObjective;
        }
        while (brief.notices.length > 1 && overBudget()) {
          brief.notices.shift();
        }
        brief.truncated = true;
        if (!brief.notices.some((n) => n.includes('truncated'))) {
          brief.notices.push(
            `Context brief truncated to fit ${brief.budgetBytes} byte budget (post-fence refit).`
          );
        }
        // Rebuild the envelope from the survivors so the checksum covers
        // exactly the delivered fence-inner text (AC22).
        const refit = refitEnvelope();
        brief.ioGuard = refit;
        brief.byteLength = calculatePayloadSize(brief);
        // The refit notice itself costs bytes: shed whole records (no
        // further notice edits) until the budget holds, then re-sync the
        // envelope to the final delivered set.
        while ((brief.traps.length > 0 || brief.decisions.length > 0) && overBudget()) {
          if (brief.traps.length > 0) {
            brief.traps.pop();
          } else {
            brief.decisions.pop();
          }
        }
        const finalGuard = refitEnvelope();
        brief.ioGuard = finalGuard;
        brief.byteLength = calculatePayloadSize(brief);
        return { data: brief, ioGuard: finalGuard };
      }
      return { data: brief, ioGuard };
    } catch (err: unknown) {
      return fail('BOOTSTRAP_FAILED', err);
    }
  }

  if (name === 'search') {
    try {
      const searchOpts = parseResult.data as SearchOptions;
      const { hitIds, sessionId, ...indexOpts } = searchOpts;
      // Spec 0059 inbound queries (AC10): drop-not-fail. A query matching
      // the override table runs as empty query (unfiltered sort path).
      let queryDropped = false;
      const effectiveIndexOpts: SearchOptions = { ...indexOpts };
      if (
        typeof searchOpts.query === 'string' &&
        searchOpts.query.trim().length > 0 &&
        !inspectAgentIo(searchOpts.query).ok
      ) {
        effectiveIndexOpts.query = '';
        queryDropped = true;
      }
      const toolAi = resolveToolAi(searchOpts.vaultRoot);
      const { hits: results } = await searchIndexRanked(effectiveIndexOpts, {
        agent: toolAi.agent,
        rankTopK: toolAi.rankTopK,
        timeoutMs: toolAi.timeoutMs,
        projectId: searchOpts.projectId
      });
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
      // Spec 0059 outbound (AC12-AC14, AC21): verify stored checksums
      // against the on-disk body (mismatch omits the snippet, never fails
      // the tool), then sanitize and fence snippets as untrusted data.
      const mismatchByIndex = new Set<number>();
      results.forEach((hit, idx) => {
        const filePath = typeof hit.filepath === 'string' ? hit.filepath : '';
        if (!filePath) return;
        try {
          const parsed = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
          const stored = (parsed.frontmatter as Record<string, unknown>).ioChecksum;
          if (stored !== undefined && stored !== null && !verifyStoredChecksum(parsed.body, stored)) {
            mismatchByIndex.add(idx);
            logIoGuardRefusal(
              {
                reason: 'search snippet omitted: checksum mismatch',
                flags: [],
                bodyChars: 0,
                projectId: searchOpts.projectId || hit.projectId,
                tool: 'search',
                recordId: String(hit.id)
              },
              { vaultRoot: searchOpts.vaultRoot }
            );
          }
        } catch {
          // Fail-open: unreadable files keep their snippet.
        }
      });
      const hits = sanitizeToolOutput(results) as SearchHit[];
      const inners: string[] = [];
      hits.forEach((hit, idx) => {
        if (mismatchByIndex.has(idx)) {
          delete hit.snippet;
          return;
        }
        if (typeof hit.snippet === 'string' && hit.snippet.length > 0) {
          const fencedSnippet = wrapUntrustedText(hit.snippet);
          inners.push(fenceInnerOf(fencedSnippet));
          hit.snippet = fencedSnippet;
        }
      });
      const ioGuard = buildIoGuardEnvelope({
        inners,
        queryDropped,
        checksumMismatch: mismatchByIndex.size > 0
      });
      return { data: hits, ioGuard };
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
      // Spec 0059 AC8: IO_GUARD refusals map to a stable fail payload.
      if (isIoGuardError(err)) {
        return fail('IO_GUARD', err);
      }
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
          const payload =
            refreshed.frontmatter.hits == null
              ? {
                  ...refreshed,
                  frontmatter: { ...refreshed.frontmatter, hits: 0 }
                }
              : refreshed;
          return guardGetRecord(payload, { vaultRoot, projectId });
        }
      }
      // AC5: treat missing hits as 0 in payload without rewriting the file
      const payload =
        record.frontmatter.hits == null
          ? {
              ...record,
              frontmatter: { ...record.frontmatter, hits: 0 }
            }
          : record;
      return guardGetRecord(payload, { vaultRoot, projectId });
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
      // Spec 0059 AC8: IO_GUARD refusals map to a stable fail payload.
      if (isIoGuardError(err)) {
        return fail('IO_GUARD', err);
      }
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
      const missing: string[] = [];
      if (installOpts.confirm !== true) missing.push('confirm: true');
      if (!installOpts.scope) missing.push('scope');
      if (!installOpts.hosts || installOpts.hosts.length === 0) missing.push('hosts');
      if (!installOpts.conflictPolicy) missing.push('conflictPolicy');
      if (missing.length > 0) {
        return fail(
          'INSTALL_SKILLS_PERMISSION_REQUIRED',
          `install_skills writes require explicit ${missing.join(', ')}. No files were written.`
        );
      }
      const hosts = normalizeInstallHosts(installOpts.hosts, { allowAll: true });
      if (hosts.length === 0) {
        return fail(
          'INSTALL_SKILLS_PERMISSION_REQUIRED',
          'install_skills writes require at least one non-empty host. No files were written.'
        );
      }
      const result = await installSkills({
        ...installOpts,
        hosts,
        global: installOpts.scope === 'global'
      });
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

      if (action === 'cancel_handoff') {
        const result = cancelHandoffRecord(promptOpts);
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
          const result = listSessions(promptOpts);
          return ok(result);
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
      // Spec 0059 AC8: IO_GUARD refusals map to a stable fail payload.
      if (isIoGuardError(err)) {
        return fail('IO_GUARD', err);
      }
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



