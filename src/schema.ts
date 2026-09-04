import { z } from 'zod';
import matter from 'gray-matter';
import { MemoRecord, RecordFrontmatter, RecordKind, RecordSource, RecordStatus, TrapLayer } from './types.js';

export const RecordKindSchema = z.enum([
  'trap',
  'decision',
  'spec',
  'plan',
  'state',
  'log',
  'scratch',
  'review',
  'prompt',
  'session'
]);

export const RecordStatusSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
  z.enum(['active', 'paused', 'shipped', 'superseded', 'archived', 'completed'])
);

export const RecordSourceSchema = z.enum(['agent', 'human', 'imported']);

export const SeveritySchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
  z.enum(['low', 'medium', 'high', 'critical'])
);

export const DeliverableSchema = z.object({
  type: z.enum(['pr', 'commit', 'spec']),
  url: z.string().optional(),
  sha: z.string().optional(),
  title: z.string().optional()
});

export const DateOrStringSchema = z.union([z.string(), z.date()]).transform((val) => {
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val);
});

export const RecordFrontmatterSchema = z.object({
  id: z.string().min(1, 'Record id is required'),
  kind: RecordKindSchema,
  project: z.string().min(1, 'Project id is required'),
  status: RecordStatusSchema.default('active'),
  created: DateOrStringSchema,
  updated: DateOrStringSchema,
  source: RecordSourceSchema.default('agent'),
  title: z.string().optional(),
  ttl: z.string().optional(),
  pathPatterns: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  supersedes: z.string().optional(),
  gitRemote: z.string().optional(),
  relatedSlug: z.string().optional(),
  severity: SeveritySchema.optional(),
  linkedPaths: z.array(z.string()).optional(),
  verifiedAtSha: z.string().optional(),
  rationale: z.string().optional(),
  layer: z.enum(['application', 'domain', 'web', 'infrastructure', 'tests', 'devops', 'other']).optional(),
  module: z.string().optional(),
  occurrences: z.coerce.number().int().min(1).optional(),
  lastSeen: DateOrStringSchema.optional(),
  hits: z.coerce.number().int().min(0).optional(),
  lastHit: DateOrStringSchema.optional(),
  helpfulCount: z.coerce.number().int().min(0).optional(),
  staleCount: z.coerce.number().int().min(0).optional(),
  lastFeedback: DateOrStringSchema.optional(),
  links: z
    .array(
      z.object({
        target: z.string().min(1),
        type: z.enum(['fixes', 'contradicts', 'causes'])
      })
    )
    .optional(),
  // Prompt & Session extended fields
  ide: z.string().optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
  sessionId: z.string().optional(),
  turn: z.coerce.number().int().positive().optional(),
  taskSlug: z.string().optional(),
  client: z.string().optional(),
  billable: z.boolean().optional(),
  branch: z.string().optional(),
  gitSha: z.string().optional(),
  startTime: DateOrStringSchema.optional(),
  endTime: DateOrStringSchema.optional(),
  durationMinutes: z.coerce.number().optional(),
  humanTotalMinutes: z.coerce.number().optional(),
  agentRunningMinutes: z.coerce.number().optional(),
  deliverables: z.array(DeliverableSchema).optional(),
  summary: z.string().optional()
}).passthrough();

export type ValidatedFrontmatter = z.infer<typeof RecordFrontmatterSchema> & RecordFrontmatter;

export function validateFrontmatter(
  data: unknown
): { success: true; data: ValidatedFrontmatter } | { success: false; errors: string[] } {
  const result = RecordFrontmatterSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as ValidatedFrontmatter };
  }
  const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  return { success: false, errors };
}

/**
 * Parse a raw markdown string with YAML frontmatter into a MemoRecord.
 */
export function parseRecord(fileContent: string, filePath?: string): MemoRecord {
  const parsed = matter(fileContent);
  const validation = validateFrontmatter(parsed.data);

  if (!validation.success) {
    throw new Error(
      `Invalid frontmatter${filePath ? ` in ${filePath}` : ''}: ${validation.errors.join(', ')}`
    );
  }

  return {
    frontmatter: validation.data,
    body: parsed.content.trim(),
    path: filePath
  };
}

/**
 * Serialize frontmatter and body into Markdown string with YAML frontmatter.
 */
export function serializeRecord(record: { frontmatter: RecordFrontmatter; body: string }): string {
  const validation = validateFrontmatter(record.frontmatter);
  if (!validation.success) {
    throw new Error(`Cannot serialize invalid frontmatter: ${validation.errors.join(', ')}`);
  }

  const frontmatter: Record<string, unknown> = { ...validation.data };
  for (const key of Object.keys(frontmatter)) {
    if (frontmatter[key] === undefined) {
      delete frontmatter[key];
    }
  }

  return matter.stringify(record.body.trim() + '\n', frontmatter);
}
