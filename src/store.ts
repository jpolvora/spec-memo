import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoRecord, RecordFrontmatter, RecordKind, RecordSource, RecordStatus, AppendOptions, AppendResult, ForgetOptions, ForgetResult } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { randomBytes } from 'node:crypto';
import { ensureProjectVault, getVaultRoot, commitVaultChange, withVaultLock, withVaultLockSync } from './vault.js';
import { parseRecord, serializeRecord, validateFrontmatter } from './schema.js';
import { rebuildCompiledViews } from './compiler.js';
import { openIndex, indexRecord, removeRecord } from './indexer.js';
import { assertNoSecrets, assertNotInProductRoot } from './safety.js';
import { recordTombstone } from './sync.js';
import { applyTrapClassification, occurrenceOf, lastSeenOf } from './recurrence.js';

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
  recurrence?: boolean;
}

export interface GetOptions {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  id?: string;
  kind?: RecordKind;
  slug?: string;
  /** When set, at most one hit bump per (sessionId, record id) on eligible gets. */
  sessionId?: string;
}

export function listProjectRecords(vaultRoot: string = getVaultRoot(), projectId: string): MemoRecord[] {
  const projectDir = path.join(vaultRoot, 'projects', projectId);
  if (!fs.existsSync(projectDir)) return [];
  const results: MemoRecord[] = [];
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subPath = path.join(projectDir, entry.name);
      const files = fs.readdirSync(subPath);
      for (const file of files) {
        if (file.endsWith('.md') && !file.includes('.conflict.')) {
          const filePath = path.join(subPath, file);
          try {
            results.push(parseRecord(fs.readFileSync(filePath, 'utf8'), filePath));
          } catch {
            // Ignore unparseable
          }
        }
      }
    }
  }
  return results;
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
    case 'prompt':
      return 'prompts';
    case 'session':
      return 'sessions';
    default:
      return `${kind}s`;
  }
}

function findMatchingTrap(
  projectDir: string,
  recordId: string,
  slug: string,
  pathPatterns: string[] | undefined,
  body: string
): MemoRecord | null {
  const newPatterns = (pathPatterns || []).slice().sort();
  const trapsDir = path.join(projectDir, 'traps');
  if (!fs.existsSync(trapsDir)) return null;
  const files = fs.readdirSync(trapsDir);
  for (const file of files) {
    if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
    const trapPath = path.join(trapsDir, file);
    try {
      const existing = parseRecord(fs.readFileSync(trapPath, 'utf8'), trapPath);
      if (
        existing.frontmatter.status !== 'active' ||
        existing.frontmatter.id === recordId ||
        existing.frontmatter.id === slug
      ) {
        continue;
      }
      const existingPatterns = (existing.frontmatter.pathPatterns || []).slice().sort();
      const samePatterns =
        newPatterns.length === existingPatterns.length &&
        newPatterns.every((p, idx) => p === existingPatterns[idx]);
      if (samePatterns && calculateTextOverlap(body, existing.body) >= 0.7) {
        return existing;
      }
    } catch {
      // Ignore unparseable
    }
  }
  return null;
}

/**
 * Write or update a memory record in the project vault.
 */
export async function upsertRecord(options: UpsertOptions): Promise<UpsertResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
    const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
    const projectId = options.projectId || identity.projectId;

    ensureProjectVault(identity, vaultRoot);

    const projectDir = path.join(vaultRoot, 'projects', projectId);
    const subdir = getSubdirForKind(options.kind);
    const targetDir = path.join(projectDir, subdir);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Derive slug and record ID
  let slug = options.slug || (typeof options.frontmatter?.id === 'string' ? options.frontmatter.id : '');
  if (!slug && typeof options.frontmatter?.title === 'string') {
    slug = slugify(options.frontmatter.title);
  }
  if (!slug) {
    if (options.kind === 'prompt') {
      const sessId = options.frontmatter?.sessionId as string | undefined;
      const turnNum = options.frontmatter?.turn as number | undefined;
      if (sessId && turnNum != null) {
        slug = `prompt-${sessId}-t${turnNum}`;
      } else {
        slug = `prompt-${Date.now()}-${randomBytes(3).toString('hex')}`;
      }
    } else if (options.kind === 'session') {
      const sessId = options.frontmatter?.sessionId as string | undefined;
      if (sessId) {
        slug = `session-${sessId}`;
      } else {
        slug = `session-${Date.now()}-${randomBytes(3).toString('hex')}`;
      }
    } else {
      slug = `${options.kind}-${Date.now()}`;
    }
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

  assertNoSecrets(options.body, 'record body');
  if (options.frontmatter) {
    assertNoSecrets(options.frontmatter, 'record frontmatter');
  }

  if (
    options.kind === 'trap' &&
    !options.allowDuplicate &&
    !options.frontmatter?.supersedes &&
    !existingRecord
  ) {
    const match = findMatchingTrap(projectDir, recordId, slug, options.frontmatter?.pathPatterns, options.body);
    if (match && match.path) {
      const bumpedFm: RecordFrontmatter = {
        ...match.frontmatter,
        occurrences: occurrenceOf(match.frontmatter) + 1,
        lastSeen: now,
        updated: now
      };
      const bumpedContent = serializeRecord({ frontmatter: bumpedFm, body: match.body });
      fs.writeFileSync(match.path, bumpedContent, 'utf8');
      try {
        const db = openIndex(vaultRoot);
        indexRecord(db, { frontmatter: bumpedFm, body: match.body }, match.path);
      } catch {
        // Non-blocking if index fails
      }
      rebuildCompiledViews(projectId, vaultRoot);
      commitVaultChange(`recurrence ${options.kind}:${match.frontmatter.id}`, vaultRoot, [
        path.join('projects', projectId)
      ]);
      return {
        id: match.frontmatter.id,
        kind: options.kind,
        slug: String(match.frontmatter.slug || match.frontmatter.id),
        path: match.path,
        superseded: false,
        recurrence: true
      };
    }
  }

  const rawFrontmatter: RecordFrontmatter = {
    ...(existingRecord?.frontmatter || {}),
    ...(options.frontmatter || {}),
    id: recordId,
    slug: options.slug || options.frontmatter?.slug || existingRecord?.frontmatter?.slug,
    kind: options.kind,
    project: projectId,
    status: (options.frontmatter?.status as RecordStatus) || (existingRecord?.frontmatter.status ?? 'active'),
    created: existingRecord?.frontmatter.created || options.frontmatter?.created || now,
    updated: options.frontmatter?.updated || now,
    source: options.source || options.frontmatter?.source || existingRecord?.frontmatter.source || 'agent'
  };

  if (typeof rawFrontmatter.severity === 'string') {
    rawFrontmatter.severity = rawFrontmatter.severity.trim().toLowerCase() as RecordFrontmatter['severity'];
  }
  if (typeof rawFrontmatter.status === 'string') {
    rawFrontmatter.status = rawFrontmatter.status.trim().toLowerCase() as RecordStatus;
  }

  if (rawFrontmatter.path && typeof rawFrontmatter.path === 'string') {
    const rawPath = String(rawFrontmatter.path).trim();
    if (rawPath) {
      if (!rawFrontmatter.pathPatterns) {
        rawFrontmatter.pathPatterns = [rawPath];
      }
      if (!rawFrontmatter.linkedPaths) {
        rawFrontmatter.linkedPaths = [rawPath];
      }
    }
    delete (rawFrontmatter as Record<string, unknown>).path;
  }

  if (options.kind === 'trap') {
    const classified = applyTrapClassification(rawFrontmatter, options.body);
    rawFrontmatter.layer = classified.layer;
    if (classified.module) {
      rawFrontmatter.module = classified.module;
    }
    if (classified.tags) {
      rawFrontmatter.tags = classified.tags;
    }
    if (!existingRecord) {
      if (rawFrontmatter.occurrences == null) {
        rawFrontmatter.occurrences = 1;
      }
      if (!rawFrontmatter.lastSeen) {
        rawFrontmatter.lastSeen = rawFrontmatter.created || now;
      }
    }
    if (rawFrontmatter.supersedes && options.frontmatter?.occurrences == null && !existingRecord) {
      const older = await getRecord({
        projectId,
        vaultRoot,
        id: String(rawFrontmatter.supersedes),
        kind: 'trap'
      });
      if (older) {
        rawFrontmatter.occurrences = occurrenceOf(older.frontmatter) + 1;
      }
    }
  }

  const validation = validateFrontmatter(rawFrontmatter);
  if (!validation.success) {
    throw new Error(`Invalid record frontmatter: ${validation.errors.join(', ')}`);
  }

  // Safety checks: protect product tree (secrets already scanned above)
  assertNotInProductRoot(filePath, identity.rootPath, identity.isGit, vaultRoot);

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
  commitVaultChange(`upsert ${options.kind}:${recordId}`, vaultRoot, [
    path.join('projects', projectId)
  ]);

  return {
    id: recordId,
    kind: options.kind,
    slug,
    path: filePath,
    superseded
  };
  });
}

/**
 * Retrieve a memory record by ID or by kind+slug.
 */
export async function getRecord(options: GetOptions): Promise<MemoRecord | null> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;
  const projectDir = path.join(vaultRoot, 'projects', projectId);

  const directLookup = options.slug || options.id;
  const lookupId = options.id || options.slug;
  if (!lookupId && !directLookup) {
    return null;
  }

  if (fs.existsSync(projectDir)) {
    // If kind and slug or id provided, check direct path
    if (options.kind && directLookup) {
      const subdir = getSubdirForKind(options.kind);
      const directPath = path.join(projectDir, subdir, `${directLookup}.md`);
      if (fs.existsSync(directPath)) {
        try {
          return parseRecord(fs.readFileSync(directPath, 'utf8'), directPath);
        } catch {
          return null;
        }
      }
    }

    // Otherwise search across subdirectories
    if (lookupId) {
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
    }
  }

const CROSS_PROJECT_GET_EXCLUDED: RecordKind[] = ['scratch', 'state', 'review'];

  // Fallback: search across other projects in vault if projectId was not explicitly specified
  if (!options.projectId && lookupId) {
    const projectsDir = path.join(vaultRoot, 'projects');
    if (fs.existsSync(projectsDir)) {
      const crossProjectMatches: MemoRecord[] = [];
      const otherProjects = fs.readdirSync(projectsDir).filter((p) => p !== projectId);
      for (const otherProj of otherProjects) {
        const otherProjectDir = path.join(projectsDir, otherProj);
        try {
          if (!fs.statSync(otherProjectDir).isDirectory()) continue;
        } catch {
          continue;
        }

        if (options.kind && directLookup) {
          if (CROSS_PROJECT_GET_EXCLUDED.includes(options.kind)) {
            continue;
          }
          const subdir = getSubdirForKind(options.kind);
          const directPath = path.join(otherProjectDir, subdir, `${directLookup}.md`);
          if (fs.existsSync(directPath)) {
            try {
              const parsed = parseRecord(fs.readFileSync(directPath, 'utf8'), directPath);
              if (
                !CROSS_PROJECT_GET_EXCLUDED.includes(parsed.frontmatter.kind) &&
                (options.slug
                  ? parsed.frontmatter.id === directLookup || parsed.frontmatter.slug === options.slug
                  : parsed.frontmatter.id === lookupId)
              ) {
                crossProjectMatches.push(parsed);
              }
            } catch {
              // continue scanning
            }
          }
        }

        try {
          const otherSubdirs = fs.readdirSync(otherProjectDir, { withFileTypes: true });
          for (const d of otherSubdirs) {
            if (d.isDirectory()) {
              const kindFromDir = d.name.replace(/s$/, '') as RecordKind;
              if (CROSS_PROJECT_GET_EXCLUDED.includes(kindFromDir) || d.name === 'scratch' || d.name === 'state' || d.name === 'reviews' || d.name === 'scratches' || d.name === 'states') {
                continue;
              }
              const dirPath = path.join(otherProjectDir, d.name);
              const directFile = path.join(dirPath, `${lookupId}.md`);
              if (fs.existsSync(directFile)) {
                try {
                  const parsed = parseRecord(fs.readFileSync(directFile, 'utf8'), directFile);
                  if (
                    !CROSS_PROJECT_GET_EXCLUDED.includes(parsed.frontmatter.kind) &&
                    parsed.frontmatter.id === lookupId
                  ) {
                    crossProjectMatches.push(parsed);
                  }
                } catch {
                  // continue scanning
                }
              }
              const files = fs.readdirSync(dirPath);
              for (const file of files) {
                if (file.endsWith('.md')) {
                  const filePath = path.join(dirPath, file);
                  try {
                    const parsed = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
                    if (!CROSS_PROJECT_GET_EXCLUDED.includes(parsed.frontmatter.kind) && parsed.frontmatter.id === lookupId) {
                      crossProjectMatches.push(parsed);
                    }
                  } catch {
                    // ignore
                  }
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }

      const uniqueMatches = [
        ...new Map(
          crossProjectMatches.map((r) => [
            r.path ?? `${r.frontmatter.project}:${r.frontmatter.id}`,
            r
          ])
        ).values()
      ];

      if (uniqueMatches.length === 1) {
        return uniqueMatches[0];
      }
      if (uniqueMatches.length > 1) {
        // Ambiguous match across multiple sibling projects — fail closed
        return null;
      }
    }
  }

  return null;
}

/**
 * Append a write-only log or audit event record without overwriting previous events.
 */
export async function appendEvent(options: AppendOptions): Promise<AppendResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
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
  const logId = `log-${dateStr}-${process.pid}-${randomBytes(4).toString('hex')}`;
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
  assertNotInProductRoot(filePath, identity.rootPath, identity.isGit, vaultRoot);

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
  commitVaultChange(`append ${kind}:${logId}`, vaultRoot, [path.join('projects', projectId)]);

  return {
    id: logId,
    kind,
    path: filePath,
    event: options.event
  };
  });
}

/**
 * Archive or permanently purge a memory record.
 */
export async function forgetRecord(options: ForgetOptions): Promise<ForgetResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
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

  assertNotInProductRoot(record.path, identity.rootPath, identity.isGit, vaultRoot);

  const id = record.frontmatter.id;
  const kind = record.frontmatter.kind;

  if (options.purge) {
    // Permanent physical delete
    if (fs.existsSync(record.path)) {
      fs.unlinkSync(record.path);
    }

    recordTombstone(
      vaultRoot,
      projectId,
      kind,
      id,
      (record.frontmatter.slug as string) || id
    );

    try {
      const db = openIndex(vaultRoot);
      removeRecord(db, id, projectId);
    } catch {
      // Non-blocking
    }

    rebuildCompiledViews(projectId, vaultRoot);
    commitVaultChange(`forget purge ${kind}:${id}`, vaultRoot, [
      path.join('projects', projectId)
    ]);

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
  commitVaultChange(`forget archive ${kind}:${id}`, vaultRoot, [
    path.join('projects', projectId)
  ]);

  return {
    id,
    kind,
    status: 'archived',
    purged: false,
    path: record.path
  };
  });
}

export function backfillTrapRecurrence(options: {
  cwd?: string;
  vaultRoot?: string;
  projectId?: string;
}): { updated: number; projectId: string } {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLockSync(vaultRoot, () => {
    const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
    const projectId = options.projectId || identity.projectId;
    const records = listProjectRecords(vaultRoot, projectId);
    let updated = 0;
    const db = openIndex(vaultRoot);

    for (const record of records) {
      if (record.frontmatter.kind !== 'trap' || !record.path) continue;
      const classified = applyTrapClassification(record.frontmatter, record.body);
      const next: RecordFrontmatter = {
        ...record.frontmatter,
        layer: record.frontmatter.layer || classified.layer,
        occurrences: occurrenceOf(record.frontmatter),
        lastSeen: lastSeenOf(record.frontmatter)
      };
      if (!next.module && classified.module) {
        next.module = classified.module;
      }
      if (classified.tags) {
        next.tags = classified.tags;
      }
      for (const key of Object.keys(next)) {
        if (next[key] === undefined) {
          delete next[key];
        }
      }
      const changed =
        next.layer !== record.frontmatter.layer ||
        next.module !== record.frontmatter.module ||
        next.occurrences !== record.frontmatter.occurrences ||
        next.lastSeen !== record.frontmatter.lastSeen ||
        JSON.stringify(next.tags || []) !== JSON.stringify(record.frontmatter.tags || []);
      if (!changed) continue;
      fs.writeFileSync(record.path, serializeRecord({ frontmatter: next, body: record.body }), 'utf8');
      try {
        indexRecord(db, { frontmatter: next, body: record.body }, record.path);
      } catch {
        // Non-blocking if index fails; doctor --rebuild can repair FTS
      }
      updated += 1;
    }

    if (updated > 0) {
      rebuildCompiledViews(projectId, vaultRoot);
      commitVaultChange(`backfill trap recurrence ${projectId}`, vaultRoot, [
        path.join('projects', projectId)
      ]);
    }

    return { updated, projectId };
  });
}
