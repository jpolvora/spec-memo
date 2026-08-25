import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoRecord, RecordFrontmatter, RecordKind, RecordSource, RecordStatus, AppendOptions, AppendResult, ForgetOptions, ForgetResult } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { ensureProjectVault, getVaultRoot, commitVaultChange } from './vault.js';
import { parseRecord, serializeRecord, validateFrontmatter } from './schema.js';
import { rebuildCompiledViews } from './compiler.js';
import { openIndex, indexRecord, removeRecord } from './indexer.js';
import { assertNoSecrets, assertNotInProductRoot } from './safety.js';

export interface UpsertOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  kind: RecordKind;
  slug?: string;
  frontmatter?: Partial<RecordFrontmatter>;
  body: string;
  source?: RecordSource;
  allowDuplicate?: boolean;
}

export interface UpsertResult {
  id: string;
  kind: RecordKind;
  slug: string;
  path: string;
  superseded: boolean;
}

export interface GetOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  id?: string;
  kind?: RecordKind;
  slug?: string;
}

/**
 * Calculate Jaccard token overlap between two strings (0.0 to 1.0).
 */
export function calculateTextOverlap(text1: string, text2: string): number {
  const tokens1 = new Set(text1.toLowerCase().split(/\W+/).filter(Boolean));
  const tokens2 = new Set(text2.toLowerCase().split(/\W+/).filter(Boolean));
  if (tokens1.size === 0 || tokens2.size === 0) return 0;
  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  const minSize = Math.min(tokens1.size, tokens2.size);
  return minSize === 0 ? 0 : intersection / minSize;
}

/**
 * Generate a slug/id from a title or string.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Get target subdirectory name for a record kind.
 */
export function getSubdirForKind(kind: RecordKind): string {
  switch (kind) {
    case 'trap':
      return 'traps';
    case 'decision':
      return 'decisions';
    case 'spec':
      return 'specs';
    case 'plan':
      return 'plans';
    case 'log':
      return 'logs';
    case 'review':
      return 'reviews';
    case 'scratch':
      return 'scratch';
    case 'state':
      return 'plans'; // state records live under plans/ or state subfolder
    default:
      return `${kind}s`;
  }
}

/**
 * Upsert a memory record (trap, decision, spec, plan, state, log, scratch, review)
 * and update compiled index views.
 */
export async function upsertRecord(options: UpsertOptions): Promise<UpsertResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;

  ensureProjectVault(identity, vaultRoot);

  const projectDir = path.join(vaultRoot, 'projects', projectId);
  const subdir = getSubdirForKind(options.kind);
  const targetDir = path.join(projectDir, subdir);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // AC1-AC4 (Slice 12 Trap Dedup): Automatically find and supersede matching traps
  if (options.kind === 'trap' && !options.allowDuplicate && !options.frontmatter?.supersedes) {
    const newPatterns = (options.frontmatter?.pathPatterns || []).slice().sort();
    const trapsDir = path.join(projectDir, 'traps');
    if (fs.existsSync(trapsDir)) {
      const files = fs.readdirSync(trapsDir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const trapPath = path.join(trapsDir, file);
          try {
            const existing = parseRecord(fs.readFileSync(trapPath, 'utf8'), trapPath);
            if (existing.frontmatter.status === 'active' && existing.frontmatter.id !== options.slug) {
              const existingPatterns = (existing.frontmatter.pathPatterns || []).slice().sort();
              const samePatterns =
                newPatterns.length === existingPatterns.length &&
                newPatterns.every((p, idx) => p === existingPatterns[idx]);

              if (samePatterns || newPatterns.length === 0) {
                const overlap = calculateTextOverlap(options.body, existing.body);
                if (overlap >= 0.7) {
                  options.frontmatter = {
                    ...(options.frontmatter || {}),
                    supersedes: existing.frontmatter.id
                  };
                  break;
                }
              }
            }
          } catch {
            // Ignore unparseable
          }
        }
      }
    }
  }

  // Derive slug and record ID
  let slug = options.slug || (typeof options.frontmatter?.id === 'string' ? options.frontmatter.id : '');
  if (!slug && typeof options.frontmatter?.title === 'string') {
    slug = slugify(options.frontmatter.title);
  }
  if (!slug) {
    slug = `${options.kind}-${Date.now()}`;
  }

  const recordId = (typeof options.frontmatter?.id === 'string' ? options.frontmatter.id : null) || slug;
  const fileName = `${slug}.md`;
  const filePath = path.join(targetDir, fileName);


  let existingRecord: MemoRecord | null = null;
  if (fs.existsSync(filePath)) {
    try {
      existingRecord = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
    } catch {
      // Overwrite if corrupt
    }
  }

  const now = new Date().toISOString();
  const rawFrontmatter: RecordFrontmatter = {
    ...(existingRecord?.frontmatter || {}),
    ...(options.frontmatter || {}),
    id: recordId,
    kind: options.kind,
    project: projectId,
    status: (options.frontmatter?.status as RecordStatus) || (existingRecord?.frontmatter.status ?? 'active'),
    created: existingRecord?.frontmatter.created || options.frontmatter?.created || now,
    updated: now,
    source: options.source || options.frontmatter?.source || existingRecord?.frontmatter.source || 'agent'
  };

  const validation = validateFrontmatter(rawFrontmatter);
  if (!validation.success) {
    throw new Error(`Invalid record frontmatter: ${validation.errors.join(', ')}`);
  }

  // Safety checks: assert no secrets in body or frontmatter, and protect product tree
  assertNoSecrets(options.body, 'record body');
  if (options.frontmatter) {
    assertNoSecrets(options.frontmatter, 'record frontmatter');
  }
  assertNotInProductRoot(filePath, identity.rootPath, identity.isGit);

  // If this record supersedes an existing one, update the older record
  let superseded = false;
  if (validation.data.supersedes) {
    const olderRecord = await getRecord({
      projectId,
      vaultRoot,
      id: validation.data.supersedes,
      kind: options.kind
    });

    if (olderRecord && olderRecord.path && fs.existsSync(olderRecord.path)) {
      const updatedOlderFm: RecordFrontmatter = {
        ...olderRecord.frontmatter,
        status: 'superseded',
        updated: now
      };
      const updatedOlderContent = serializeRecord({
        frontmatter: updatedOlderFm,
        body: olderRecord.body
      });
      fs.writeFileSync(olderRecord.path, updatedOlderContent, 'utf8');

      // Update superseded record in FTS index
      try {
        const db = openIndex(vaultRoot);
        indexRecord(db, { frontmatter: updatedOlderFm, body: olderRecord.body }, olderRecord.path);
      } catch {
        // Non-blocking if index fails
      }

      superseded = true;
    }
  }

  const fileContent = serializeRecord({
    frontmatter: validation.data,
    body: options.body
  });

  fs.writeFileSync(filePath, fileContent, 'utf8');

  // Index record into SQLite FTS
  try {
    const db = openIndex(vaultRoot);
    indexRecord(db, { frontmatter: validation.data, body: options.body }, filePath);
  } catch {
    // Non-blocking if index fails
  }

  // Automatically update compiled views (TRAPS.md, DECISIONS.md, INDEX.md)
  rebuildCompiledViews(projectId, vaultRoot);
  commitVaultChange(`upsert ${options.kind}:${recordId}`, vaultRoot);

  return {
    id: recordId,
    kind: options.kind,
    slug,
    path: filePath,
    superseded
  };
}

/**
 * Retrieve a memory record by ID or by kind+slug.
 */
export async function getRecord(options: GetOptions): Promise<MemoRecord | null> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;
  const projectDir = path.join(vaultRoot, 'projects', projectId);

  if (!fs.existsSync(projectDir)) {
    return null;
  }

  // If kind and slug provided, check direct path
  if (options.kind && options.slug) {
    const subdir = getSubdirForKind(options.kind);
    const directPath = path.join(projectDir, subdir, `${options.slug}.md`);
    if (fs.existsSync(directPath)) {
      try {
        return parseRecord(fs.readFileSync(directPath, 'utf8'), directPath);
      } catch {
        return null;
      }
    }
  }

  // Otherwise search across subdirectories
  const lookupId = options.id || options.slug;
  if (!lookupId) {
    return null;
  }

  const subdirs = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const d of subdirs) {
    if (d.isDirectory()) {
      const dirPath = path.join(projectDir, d.name);
      // Check exact slug filename first
      const directFile = path.join(dirPath, `${lookupId}.md`);
      if (fs.existsSync(directFile)) {
        try {
          return parseRecord(fs.readFileSync(directFile, 'utf8'), directFile);
        } catch {
          // Continue scanning
        }
      }

      // Check all files in directory for matching frontmatter id
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = path.join(dirPath, file);
          try {
            const parsed = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
            if (parsed.frontmatter.id === lookupId) {
              return parsed;
            }
          } catch {
            // Ignore unparseable
          }
        }
      }
    }
  }

  return null;
}

let logSequence = 0;

/**
 * Append a write-only log or audit event record without overwriting previous events.
 */
export async function appendEvent(options: AppendOptions): Promise<AppendResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;

  ensureProjectVault(identity, vaultRoot);

  const projectDir = path.join(vaultRoot, 'projects', projectId);
  const kind: RecordKind = options.kind || 'log';
  const subdir = getSubdirForKind(kind);
  const targetDir = path.join(projectDir, subdir);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-');
  logSequence = (logSequence + 1) % 10000;
  const seqStr = String(logSequence).padStart(4, '0');
  const logId = `log-${dateStr}-${seqStr}`;
  const fileName = `${logId}.md`;
  const filePath = path.join(targetDir, fileName);

  const frontmatter: RecordFrontmatter = {
    id: logId,
    kind,
    project: projectId,
    status: 'active',
    created: now.toISOString(),
    updated: now.toISOString(),
    source: options.source || 'agent',
    ...(options.details || {})
  };

  const validation = validateFrontmatter(frontmatter);
  if (!validation.success) {
    throw new Error(`Invalid log frontmatter: ${validation.errors.join(', ')}`);
  }

  // Safety checks: assert no secrets and protect product tree
  assertNoSecrets(options.event, 'event log body');
  if (options.details) {
    assertNoSecrets(options.details, 'event log details');
  }
  assertNotInProductRoot(filePath, identity.rootPath, identity.isGit);

  const fileContent = serializeRecord({
    frontmatter: validation.data,
    body: options.event
  });

  fs.writeFileSync(filePath, fileContent, 'utf8');

  // Index into SQLite FTS
  try {
    const db = openIndex(vaultRoot);
    indexRecord(db, { frontmatter: validation.data, body: options.event }, filePath);
  } catch {
    // Non-blocking
  }

  // Update compiled views
  rebuildCompiledViews(projectId, vaultRoot);

  return {
    id: logId,
    kind,
    path: filePath,
    event: options.event
  };
}

/**
 * Archive or permanently purge a memory record.
 */
export async function forgetRecord(options: ForgetOptions): Promise<ForgetResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;

  const record = await getRecord({
    cwd: options.cwd,
    projectId,
    vaultRoot,
    id: options.id,
    kind: options.kind,
    slug: options.slug
  });

  if (!record || !record.path) {
    const lookup = options.id || `${options.kind || ''}/${options.slug || ''}`;
    throw new Error(`Record not found: ${lookup}`);
  }

  assertNotInProductRoot(record.path, identity.rootPath, identity.isGit);

  const id = record.frontmatter.id;
  const kind = record.frontmatter.kind;

  if (options.purge) {
    // Permanent physical delete
    if (fs.existsSync(record.path)) {
      fs.unlinkSync(record.path);
    }

    try {
      const db = openIndex(vaultRoot);
      removeRecord(db, id, projectId);
    } catch {
      // Non-blocking
    }

    rebuildCompiledViews(projectId, vaultRoot);

    return {
      id,
      kind,
      status: 'purged',
      purged: true,
      path: record.path
    };
  }

  // Soft archive (default)
  const now = new Date().toISOString();
  const updatedFrontmatter: RecordFrontmatter = {
    ...record.frontmatter,
    status: 'archived',
    updated: now
  };

  const fileContent = serializeRecord({
    frontmatter: updatedFrontmatter,
    body: record.body
  });

  fs.writeFileSync(record.path, fileContent, 'utf8');

  try {
    const db = openIndex(vaultRoot);
    indexRecord(db, { frontmatter: updatedFrontmatter, body: record.body }, record.path);
  } catch {
    // Non-blocking
  }

  rebuildCompiledViews(projectId, vaultRoot);

  return {
    id,
    kind,
    status: 'archived',
    purged: false,
    path: record.path
  };
}
