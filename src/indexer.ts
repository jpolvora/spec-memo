import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoRecord, RecordFrontmatter, RecordKind, RecordStatus, SearchHit, SearchOptions } from './types.js';
import { getVaultRoot, withVaultLock } from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { parseRecord } from './schema.js';
import { compareSearchHits, enrichHitFromFile } from './recurrence.js';

const dbPool = new Map<string, Database.Database>();

/**
 * Open or initialize the SQLite FTS5 database in the vault root.
 */
export function openIndex(vaultRoot: string = getVaultRoot()): Database.Database {
  const dbPath = path.join(vaultRoot, 'memo.sqlite');

  let db = dbPool.get(dbPath);
  if (db && db.open) {
    return db;
  }

  if (!fs.existsSync(vaultRoot)) {
    fs.mkdirSync(vaultRoot, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Virtual FTS5 table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
      id,
      projectId UNINDEXED,
      kind UNINDEXED,
      status UNINDEXED,
      title,
      tags,
      pathPatterns,
      body,
      filepath UNINDEXED,
      updated UNINDEXED,
      tokenize = 'porter ascii'
    );
  `);

  dbPool.set(dbPath, db);
  return db;
}

/**
 * Close active database connection(s) if open.
 */
export function closeIndex(vaultRoot?: string): void {
  if (vaultRoot) {
    const dbPath = path.join(vaultRoot, 'memo.sqlite');
    const db = dbPool.get(dbPath);
    if (db && db.open) {
      db.close();
    }
    dbPool.delete(dbPath);
  } else {
    for (const [, db] of dbPool.entries()) {
      if (db && db.open) {
        db.close();
      }
    }
    dbPool.clear();
  }
}

/**
 * Index or update a single record in the FTS table.
 */
export function indexRecord(
  db: Database.Database,
  record: { frontmatter: RecordFrontmatter; body: string },
  filepath: string
): void {
  const fm = record.frontmatter;
  const id = fm.id;
  const projectId = fm.project;
  const kind = fm.kind;
  const status = fm.status || 'active';
  const title = fm.title || '';
  const tags = (fm.tags || []).join(' ');
  const pathPatterns = (fm.pathPatterns || []).join(' ');
  const body = record.body || '';
  const updated = fm.updated || new Date().toISOString();

  const del = db.prepare('DELETE FROM records_fts WHERE id = ? AND projectId = ?');
  del.run(id, projectId);

  const ins = db.prepare(`
    INSERT INTO records_fts (id, projectId, kind, status, title, tags, pathPatterns, body, filepath, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  ins.run(id, projectId, kind, status, title, tags, pathPatterns, body, filepath, updated);
}

/**
 * Remove a record from the FTS index.
 */
export function removeRecord(db: Database.Database, id: string, projectId?: string): void {
  if (projectId) {
    db.prepare('DELETE FROM records_fts WHERE id = ? AND projectId = ?').run(id, projectId);
  } else {
    db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);
  }
}

/**
 * Match a file path against a glob-style pattern (e.g. src/db/*.ts, src/**\/*.ts).
 */
export function matchesPathPattern(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  if (normPath === normPattern || normPattern === '*' || normPattern === '**') {
    return true;
  }

  const GLOB_GLOBSTAR_SLASH = '___GLOBSTAR_SLASH___';
  const GLOB_GLOBSTAR = '___GLOBSTAR___';
  const GLOB_STAR = '___STAR___';
  const GLOB_QUESTION = '___QUESTION___';

  const tokenized = normPattern
    .replace(/\*\*\//g, GLOB_GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOB_GLOBSTAR)
    .replace(/\*/g, GLOB_STAR)
    .replace(/\?/g, GLOB_QUESTION);

  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  const regexStr = escaped
    .replace(new RegExp(GLOB_GLOBSTAR_SLASH, 'g'), '(?:.+/)?')
    .replace(new RegExp(GLOB_GLOBSTAR, 'g'), '.*')
    .replace(new RegExp(GLOB_STAR, 'g'), '[^/]*')
    .replace(new RegExp(GLOB_QUESTION, 'g'), '[^/]');

  try {
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(normPath);
  } catch {
    return false;
  }
}

/**
 * Test if a file path matches any pattern in a list.
 */
export function matchesAnyPattern(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((p) => matchesPathPattern(filePath, p));
}

/**
 * Sanitize a search query for FTS5 execution.
 */
export function sanitizeFtsQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) return '';

  // If already wrapped in quotes as a phrase, keep quotes clean
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const inner = trimmed.slice(1, -1).replace(/"/g, '""');
    return `"${inner}"`;
  }

  // Split into tokens
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const formatted: string[] = [];

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      formatted.push(upper);
      continue;
    }

    // Strip characters that disrupt FTS5 syntax
    const cleaned = token.replace(/[*"':()^]/g, '');
    if (cleaned.length > 0) {
      formatted.push(`"${cleaned}"*`);
    }
  }

  return formatted.join(' ');
}

/**
 * AC1: Compute term-frequency vector similarity between query and record content.
 */
export function calculateVectorSimilarity(text1: string, text2: string): number {
  const getTokens = (t: string) =>
    t.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const tokens1 = getTokens(text1);
  const tokens2 = getTokens(text2);

  if (tokens1.length === 0 || tokens2.length === 0) return 0;

  const freq1 = new Map<string, number>();
  const freq2 = new Map<string, number>();

  for (const t of tokens1) freq1.set(t, (freq1.get(t) || 0) + 1);
  for (const t of tokens2) freq2.set(t, (freq2.get(t) || 0) + 1);

  let dotProduct = 0;
  for (const [token, count1] of freq1.entries()) {
    const count2 = freq2.get(token) || 0;
    dotProduct += count1 * count2;
  }

  let mag1 = 0;
  for (const count of freq1.values()) mag1 += count * count;
  let mag2 = 0;
  for (const count of freq2.values()) mag2 += count * count;

  if (mag1 === 0 || mag2 === 0) return 0;
  return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

/**
 * Search memory records via SQLite FTS5 index.
 */
export function searchIndex(options: SearchOptions): SearchHit[] {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const db = openIndex(vaultRoot);

  let targetProjectId = options.projectId;
  if (!targetProjectId && !options.crossProject) {
    const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
    targetProjectId = identity.projectId;
  }

  let embeddingsConfig: { enabled: boolean; minSimilarity?: number } | undefined = undefined;
  const configPath = path.join(vaultRoot, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.embeddings?.enabled) {
        embeddingsConfig = cfg.embeddings;
      }
    } catch {
      // Ignore config read error
    }
  }

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (targetProjectId && !options.crossProject) {
    clauses.push('projectId = ?');
    params.push(targetProjectId);
  }

  if (options.kinds && options.kinds.length > 0) {
    const placeholders = options.kinds.map(() => '?').join(', ');
    clauses.push(`kind IN (${placeholders})`);
    params.push(...options.kinds);
  } else if (options.crossProject) {
    clauses.push("kind NOT IN ('scratch', 'state', 'review')");
  } else if (!options.includeScratch) {
    clauses.push("kind != 'scratch'");
  }

  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }

  const rawQuery = (options.query || '').trim();
  const hasFtsQuery = rawQuery.length > 0;
  let ftsQuery = '';

  if (hasFtsQuery) {
    ftsQuery = sanitizeFtsQuery(rawQuery);
    if (ftsQuery) {
      clauses.push('records_fts MATCH ?');
      params.push(ftsQuery);
    }
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = options.limit && options.limit > 0 ? options.limit : 50;
  const sort = options.sort || 'relevance';
  const limitSql = sort === 'occurrences' ? '' : `LIMIT ${limit * 2}`;

  let querySql: string;
  if (hasFtsQuery && ftsQuery) {
    querySql = `
      SELECT
        id,
        projectId,
        kind,
        status,
        title,
        tags,
        pathPatterns,
        body,
        filepath,
        updated,
        snippet(records_fts, 7, '', '', '...', 24) AS snippet,
        rank
      FROM records_fts
      ${whereSql}
      ORDER BY rank
      ${limitSql}
    `;
  } else {
    const orderSql = sort === 'updated' ? 'ORDER BY updated DESC' : 'ORDER BY updated DESC';
    querySql = `
      SELECT
        id,
        projectId,
        kind,
        status,
        title,
        tags,
        pathPatterns,
        body,
        filepath,
        updated,
        '' AS snippet,
        0 AS rank
      FROM records_fts
      ${whereSql}
      ${orderSql}
      ${limitSql}
    `;
  }

  interface SqlRow {
    id: string;
    projectId: string;
    kind: string;
    status: string;
    title: string;
    tags: string;
    pathPatterns: string;
    body: string;
    filepath: string;
    updated: string;
    snippet: string;
    rank: number;
  }

  let rows: SqlRow[] = [];
  try {
    const stmt = db.prepare(querySql);
    rows = stmt.all(...params) as SqlRow[];
  } catch {
    // If MATCH query fails due to complex syntax, fallback to unranked scan
    try {
      const fallbackClauses = clauses.filter((c) => !c.includes('MATCH'));
      const fallbackParams = params.filter((p) => p !== ftsQuery);
      const fallbackWhere = fallbackClauses.length > 0 ? `WHERE ${fallbackClauses.join(' AND ')}` : '';
      const fallbackSql = `
        SELECT id, projectId, kind, status, title, tags, pathPatterns, body, filepath, updated, '' AS snippet, 0 AS rank
        FROM records_fts
        ${fallbackWhere}
        ORDER BY updated DESC
        LIMIT ${limit * 2}
      `;
      rows = db.prepare(fallbackSql).all(...fallbackParams) as SqlRow[];
    } catch {
      rows = [];
    }
  }

  const results: SearchHit[] = [];

  for (const row of rows) {
    const tagsArr = row.tags ? row.tags.split(/\s+/).filter(Boolean) : [];
    const patternsArr = row.pathPatterns ? row.pathPatterns.split(/\s+/).filter(Boolean) : [];

    // Filter by tags if specified
    if (options.tags && options.tags.length > 0) {
      const hasAllTags = options.tags.every((t) => tagsArr.includes(t));
      if (!hasAllTags) {
        continue;
      }
    }

    // Filter by path if specified
    if (options.path) {
      const matchesPath = matchesAnyPattern(options.path, patternsArr);
      if (!matchesPath) {
        continue;
      }
    }

    // Embeddings vector similarity filtering if enabled
    if (embeddingsConfig && rawQuery) {
      const targetText = `${row.title} ${row.tags} ${row.body || ''}`;
      const sim = calculateVectorSimilarity(rawQuery, targetText);
      const minSim = embeddingsConfig.minSimilarity ?? 0.3;
      if (sim < minSim) {
        continue;
      }
    }

    results.push({
      id: row.id,
      projectId: row.projectId,
      kind: row.kind as RecordKind,
      status: row.status as RecordStatus,
      title: row.title || undefined,
      tags: tagsArr.length > 0 ? tagsArr : undefined,
      pathPatterns: patternsArr.length > 0 ? patternsArr : undefined,
      filepath: row.filepath,
      snippet: row.snippet || undefined,
      rank: row.rank,
      updated: row.updated || undefined
    });

    if (sort !== 'occurrences' && results.length >= limit) {
      break;
    }
  }

  if (sort === 'occurrences') {
    for (const hit of results) {
      const extra = enrichHitFromFile(hit.filepath);
      hit.occurrences = extra.occurrences;
      hit.lastSeen = extra.lastSeen;
      hit.layer = extra.layer as SearchHit['layer'];
      hit.severity = extra.severity;
    }
    results.sort(compareSearchHits);
    return results.slice(0, limit);
  }

  if (sort === 'updated') {
    results.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  }

  return results;
}

export function searchRecords(
  vaultRoot: string = getVaultRoot(),
  options: { query?: string; projectId?: string; kinds?: string[]; limit?: number } = {}
): SearchHit[] {
  return searchIndex({
    vaultRoot,
    query: options.query,
    projectId: options.projectId,
    kinds: options.kinds as unknown as RecordKind[] | undefined,
    limit: options.limit
  });
}

/**
 * Rebuild the entire SQLite FTS index from vault Markdown files.
 */
export async function rebuildIndex(vaultRoot: string = getVaultRoot()): Promise<{ indexed: number }> {
  return withVaultLock(vaultRoot, async () => {
  const db = openIndex(vaultRoot);
  const projectsDir = path.join(vaultRoot, 'projects');

  if (!fs.existsSync(projectsDir)) {
    db.prepare('DELETE FROM records_fts').run();
    return { indexed: 0 };
  }

  const recordsToIndex: Array<{ record: MemoRecord; filepath: string }> = [];

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const proj of projectDirs) {
    if (proj.isDirectory()) {
      const projectPath = path.join(projectsDir, proj.name);
      const subdirs = fs.readdirSync(projectPath, { withFileTypes: true });

      for (const subdir of subdirs) {
        if (subdir.isDirectory()) {
          const subPath = path.join(projectPath, subdir.name);
          const files = fs.readdirSync(subPath);

          for (const file of files) {
            if (file.endsWith('.md')) {
              const filePath = path.join(subPath, file);
              try {
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = parseRecord(content, filePath);
                recordsToIndex.push({ record: parsed, filepath: filePath });
              } catch {
                // Ignore unparseable files
              }
            }
          }
        }
      }
    }
  }

  const rebuildTx = db.transaction(() => {
    db.prepare('DELETE FROM records_fts').run();
    const ins = db.prepare(`
      INSERT INTO records_fts (id, projectId, kind, status, title, tags, pathPatterns, body, filepath, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of recordsToIndex) {
      const fm = item.record.frontmatter;
      const tags = (fm.tags || []).join(' ');
      const pathPatterns = (fm.pathPatterns || []).join(' ');
      ins.run(
        fm.id,
        fm.project,
        fm.kind,
        fm.status || 'active',
        fm.title || '',
        tags,
        pathPatterns,
        item.record.body || '',
        item.filepath,
        fm.updated || new Date().toISOString()
      );
    }
  });

  rebuildTx();

  return { indexed: recordsToIndex.length };
  });
}
