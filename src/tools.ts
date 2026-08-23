import { z } from 'zod';
import { TOOL_NAMES, ToolName, ToolResponse } from './types.js';

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
        slug: { type: 'string', description: 'Active feature spec/plan slug' }
      }
    },
    zodSchema: z.object({
      cwd: z.string().optional(),
      query: z.string().optional(),
      slug: z.string().optional()
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
        limit: { type: 'number', description: 'Maximum number of results to return' }
      },
      required: ['query']
    },
    zodSchema: z.object({
      query: z.string(),
      kinds: z.array(z.string()).optional(),
      status: z.string().optional(),
      limit: z.number().optional()
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
        slug: { type: 'string', description: 'Record slug (if kind is specified)' }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional()
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
        body: { type: 'string', description: 'Record Markdown content' }
      },
      required: ['kind', 'body']
    },
    zodSchema: z.object({
      kind: z.string(),
      slug: z.string().optional(),
      frontmatter: z.record(z.unknown()).optional(),
      body: z.string()
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
        details: { type: 'object', description: 'Additional structured event details' }
      },
      required: ['event']
    },
    zodSchema: z.object({
      event: z.string(),
      kind: z.string().optional(),
      details: z.record(z.unknown()).optional()
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
        purge: { type: 'boolean', description: 'Set true to permanently delete file (defaults to false for archive)' }
      }
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional(),
      purge: z.boolean().optional()
    })
  },
  gc: {
    name: 'gc',
    description: 'Apply TTL, compact shipped plans, and rebuild FTS index.',
    inputSchema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'Check what would be cleaned without modifying files' }
      }
    },
    zodSchema: z.object({
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
        destination: { type: 'string', description: 'Product-relative destination path (e.g. docs/adr/001.md)' }
      },
      required: ['destination']
    },
    zodSchema: z.object({
      id: z.string().optional(),
      kind: z.string().optional(),
      slug: z.string().optional(),
      destination: z.string()
    })
  }
};

export async function executeTool(name: string, args: unknown): Promise<ToolResponse> {
  if (!TOOL_NAMES.includes(name as ToolName)) {
    return {
      isError: true,
      error: `Unknown tool: ${name}`,
      code: 'UNKNOWN_TOOL',
      details: { supportedTools: TOOL_NAMES }
    };
  }

  const tool = TOOL_DEFINITIONS[name as ToolName];
  const parseResult = tool.zodSchema.safeParse(args ?? {});
  if (!parseResult.success) {
    return {
      isError: true,
      error: `Invalid arguments for ${name}: ${parseResult.error.message}`,
      code: 'INVALID_ARGUMENTS',
      details: parseResult.error.format()
    };
  }

  // Slice 1 stub: return a stable NOT_IMPLEMENTED response
  return {
    isError: true,
    error: `Tool '${name}' is not yet implemented in Slice 1`,
    code: 'NOT_IMPLEMENTED',
    details: { tool: name, args: parseResult.data }
  };
}
