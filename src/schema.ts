import { z } from 'zod';
import matter from 'gray-matter';
import { MemoRecord, RecordFrontmatter, RecordKind, RecordSource, RecordStatus } from './types.js';

export const RecordKindSchema = z.enum([
  'trap',
  'decision',
  'spec',
  'plan',
  'state',
  'log',
  'scratch',
  'review'
]);

export const RecordStatusSchema = z.enum([
  'active',
  'paused',
  'shipped',
  'superseded',
  'archived'
]);

export const RecordSourceSchema = z.enum(['agent', 'human', 'imported']);

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

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
  rationale: z.string().optional()
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

  return matter.stringify(record.body.trim() + '\n', record.frontmatter);
}
