import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ExportVaultOptions,
  ExportVaultResult,
  ImportVaultOptions,
  ImportVaultResult,
  ResetVaultOptions,
  ResetVaultResult,
  BackupFileInfo,
  BackupListFilters,
  PersistBackupOptions,
  PersistBackupResult,
  InspectBackupResult,
  VaultConfig
} from './types.js';
import { getVaultRoot, ensureVaultStructure, withVaultLock, commitVaultChange, RECORD_SUBDIRS } from './vault.js';
import { rebuildCompiledViews } from './compiler.js';
import { rebuildIndex } from './indexer.js';
import { isPathInside, assertNoSecrets, assertValidProjectId } from './safety.js';
import { parseRecord, validateFrontmatter } from './schema.js';
import { upsertRecord } from './store.js';
import { packVaultZip, unpackVaultZip } from './status-backup.js';

const DIR_TO_KIND: Record<string, string> = {
  traps: 'trap',
  decisions: 'decision',
  specs: 'spec',
  plans: 'plan',
  logs: 'log',
  reviews: 'review',
  scratch: 'scratch',
  prompts: 'prompt',
  sessions: 'session'
};

const backupMetaCache = new Map<string, { mtimeMs: number; meta: Partial<BackupFileInfo> }>();

function backupMetaCacheKey(filePath: string, password?: string): string {
  return `${path.resolve(filePath)}\0${password ?? ''}`;
}

function invalidateBackupMetaCache(filePath: string): void {
  const resolved = path.resolve(filePath);
  const prefix = resolved + '\0';
  for (const key of [...backupMetaCache.keys()]) {
    if (key === resolved || key.startsWith(prefix)) {
      backupMetaCache.delete(key);
    }
  }
}

function cachedPeekBackupMetadata(filePath: string, password?: string): Partial<BackupFileInfo> {
  const stat = fs.statSync(filePath);
  const cacheKey = backupMetaCacheKey(filePath, password);
  const cached = backupMetaCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.meta;
  }
  const meta = peekBackupMetadata(filePath, password);
  backupMetaCache.set(cacheKey, { mtimeMs: stat.mtimeMs, meta });
  return meta;
}

function kindFromRecord(relativePath: string, content: string): string {
  const dir = relativePath.split(/[/\\]/)[0] || '';
  if (dir === 'plans') {
    try {
      const parsed = parseRecord(content);
      if (parsed.frontmatter?.kind === 'state') return 'state';
      if (parsed.frontmatter?.kind === 'plan') return 'plan';
    } catch {
      // fall through
    }
  }
  return DIR_TO_KIND[dir] || dir || 'unknown';
}

function summarizePlainArchive(plain: PlainVaultArchive): Partial<BackupFileInfo> {
  const projectIds = (plain.manifest?.projects || plain.projects.map((p) => p.projectId)).filter(Boolean);
  // Legacy archives without manifest.scope: infer full only when multiple projects; never guess "project".
  const scope: 'full' | 'project' | undefined =
    plain.manifest?.scope ?? (projectIds.length > 1 ? 'full' : undefined);

  const manifestKinds = plain.manifest?.recordsByKind;
  const hasKindCounts = Boolean(manifestKinds && typeof manifestKinds === 'object');
  let recordsByKind: Record<string, number> = hasKindCounts ? { ...manifestKinds } : {};
  let walkedCount = 0;
  if (!hasKindCounts) {
    for (const project of plain.projects || []) {
      for (const record of project.records || []) {
        const kind = kindFromRecord(record.relativePath, record.content);
        recordsByKind[kind] = (recordsByKind[kind] || 0) + 1;
        walkedCount++;
      }
    }
  }

  return {
    encrypted: false,
    inspectable: true,
    format: plain.format,
    scope,
    projectIds,
    recordCount: plain.manifest?.recordCount ?? walkedCount,
    recordsByKind
  };
}

function readArchivePayload(filePath: string): string {
  const fileBuf = fs.readFileSync(filePath);
  if (
    filePath.toLowerCase().endsWith('.zip') ||
    (fileBuf.length >= 4 &&
      fileBuf[0] === 0x50 &&
      fileBuf[1] === 0x4b &&
      fileBuf[2] === 0x03 &&
      fileBuf[3] === 0x04)
  ) {
    return unpackVaultZip(fileBuf);
  }
  return fileBuf.toString('utf8');
}

function peekBackupMetadata(filePath: string, password?: string): Partial<BackupFileInfo> {
  let raw: string;
  try {
    raw = readArchivePayload(filePath);
  } catch {
    return { encrypted: false, inspectable: false, recordCount: null, recordsByKind: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { encrypted: false, inspectable: false, recordCount: null, recordsByKind: {} };
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { format?: string }).format === 'spec-memo-encrypted-vault-v1'
  ) {
    if (!password || !password.trim()) {
      return {
        encrypted: true,
        inspectable: false,
        format: 'spec-memo-encrypted-vault-v1',
        recordCount: null,
        recordsByKind: {}
      };
    }
    try {
      const decrypted = decryptPayload(parsed as EncryptedVaultArchive, password.trim());
      const plain = JSON.parse(decrypted) as PlainVaultArchive;
      return { ...summarizePlainArchive(plain), encrypted: true, format: 'spec-memo-encrypted-vault-v1' };
    } catch {
      throw new Error('Decryption failed: Incorrect password or corrupted backup archive.');
    }
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as { format?: string }).format === 'spec-memo-vault-v1'
  ) {
    return summarizePlainArchive(parsed as PlainVaultArchive);
  }

  return { encrypted: false, inspectable: false, recordCount: null, recordsByKind: {} };
}

/**
 * Resolve a backup filename to an absolute path under backups/, rejecting traversal.
 */
export function resolveBackupPath(vaultRoot: string, filename: string): string {
  const raw = String(filename || '');
  if (!raw || /[/\\]/.test(raw) || raw.includes('..')) {
    throw new Error('Invalid backup filename');
  }
  const safeFn = path.basename(raw);
  if (safeFn !== raw) {
    throw new Error('Invalid backup filename');
  }
  if (!safeFn.endsWith('.zip') && !safeFn.endsWith('.json')) {
    throw new Error('Invalid backup filename');
  }
  const backupsDir = path.resolve(vaultRoot, 'backups');
  const fullPath = path.resolve(backupsDir, safeFn);
  if (!isPathInside(fullPath, backupsDir)) {
    throw new Error('Backup path escapes backups directory');
  }
  return fullPath;
}

interface RawVaultRecord {
  relativePath: string;
  content: string;
}

interface ExportedProject {
  projectId: string;
  metadata?: Record<string, unknown>;
  records: RawVaultRecord[];
}

interface VaultArchiveManifest {
  version: string;
  exportedAt: string;
  projects: string[];
  recordCount: number;
  /** Export intent: all projects vs a single projectId (not inferred from project count). */
  scope?: 'full' | 'project';
  recordsByKind?: Record<string, number>;
}

interface PlainVaultArchive {
  format: 'spec-memo-vault-v1';
  manifest: VaultArchiveManifest;
  vaultConfig?: VaultConfig;
  projects: ExportedProject[];
}

interface EncryptedVaultArchive {
  format: 'spec-memo-encrypted-vault-v1';
  cipher: 'aes-256-gcm';
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

/**
 * Encrypt a plaintext string using AES-256-GCM and PBKDF2 key derivation.
 */
function encryptPayload(plaintext: string, password: string): EncryptedVaultArchive {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 100000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: 'spec-memo-encrypted-vault-v1',
    cipher: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data: encrypted.toString('base64')
  };
}

/**
 * Decrypt an AES-256-GCM encrypted vault archive.
 */
function decryptPayload(archive: EncryptedVaultArchive, password: string): string {
  const salt = Buffer.from(archive.salt, 'hex');
  const iv = Buffer.from(archive.iv, 'hex');
  const authTag = Buffer.from(archive.authTag, 'hex');
  const ciphertext = Buffer.from(archive.data, 'base64');
  const iterations = archive.iterations || 100000;

  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed: Incorrect password or corrupted backup archive.');
  }
}

/**
 * Format timestamped backup filename adhering to pattern YYYY-MM-DD-HH-mm-ss-backup.zip
 */
export function formatBackupFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}-backup.zip`;
}

/**
 * Export vault projects and records into a portable archive bundle (optionally encrypted).
 */
export async function exportVault(options: ExportVaultOptions = {}): Promise<ExportVaultResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);

    const projectsDir = path.join(vaultRoot, 'projects');
    const exportedProjects: ExportedProject[] = [];
    const projectNames: string[] = [];
    let totalRecords = 0;
    const recordsByKind: Record<string, number> = {};

    const targetProject = options.projectId;

    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir);
      for (const entry of entries) {
        if (targetProject && entry !== targetProject) continue;

        const projPath = path.join(projectsDir, entry);
        if (!fs.statSync(projPath).isDirectory()) continue;

        projectNames.push(entry);

        let metadata: Record<string, unknown> | undefined;
        const metaPath = path.join(projPath, 'project.json');
        if (fs.existsSync(metaPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          } catch {
            // Ignore
          }
        }

        const records: RawVaultRecord[] = [];

        for (const dirName of RECORD_SUBDIRS) {
          const subDir = path.join(projPath, dirName);
          if (fs.existsSync(subDir)) {
            const files = fs.readdirSync(subDir);
            for (const file of files) {
              if (file.endsWith('.md') && !file.includes('.conflict.')) {
                const filePath = path.join(subDir, file);
                const relPath = `${dirName}/${file}`;
                try {
                  const content = fs.readFileSync(filePath, 'utf8');
                  assertNoSecrets(content, `export record ${relPath}`);
                  records.push({ relativePath: relPath, content });
                  const kind = kindFromRecord(relPath, content);
                  recordsByKind[kind] = (recordsByKind[kind] || 0) + 1;
                  totalRecords++;
                } catch (err: unknown) {
                  if (err instanceof Error && err.message.includes('Safety violation')) {
                    throw err;
                  }
                  throw new Error(`Failed to export record ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
        }

        exportedProjects.push({
          projectId: entry,
          metadata,
          records
        });
      }
    }

    const manifest: VaultArchiveManifest = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      projects: projectNames,
      recordCount: totalRecords,
      scope: targetProject ? 'project' : 'full',
      recordsByKind
    };

    let vaultConfig: VaultConfig | undefined;
    const configPath = path.join(vaultRoot, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        vaultConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        // Ignore
      }
    }

    const plainArchive: PlainVaultArchive = {
      format: 'spec-memo-vault-v1',
      manifest,
      vaultConfig,
      projects: exportedProjects
    };

    const plainString = JSON.stringify(plainArchive, null, 2);
    let outputContent: string;
    const isEncrypted = Boolean(options.password && options.password.trim().length > 0);

    if (isEncrypted) {
      const encryptedArchive = encryptPayload(plainString, options.password!.trim());
      outputContent = JSON.stringify(encryptedArchive, null, 2);
    } else {
      outputContent = plainString;
    }

    if (options.outputPath) {
      const resolvedOutput = path.resolve(options.outputPath);
      const outDir = path.dirname(resolvedOutput);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(resolvedOutput, outputContent, 'utf8');
    }

    return {
      vaultRoot,
      projectId: targetProject,
      outputPath: options.outputPath ? path.resolve(options.outputPath) : undefined,
      encrypted: isEncrypted,
      projectsCount: exportedProjects.length,
      recordsCount: totalRecords,
      manifest,
      payload: options.outputPath ? undefined : outputContent
    };
  });
}

/**
 * Import a vault archive bundle (plaintext or encrypted, ZIP or JSON) into the local vault.
 */
export async function importVault(options: ImportVaultOptions = {}): Promise<ImportVaultResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);

    let rawData: string;
    if (options.archivePath) {
      const resolvedPath = path.resolve(options.archivePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Vault archive file not found: ${resolvedPath}`);
      }
      const fileBuf = fs.readFileSync(resolvedPath);
      if (
        (fileBuf.length >= 4 &&
          fileBuf[0] === 0x50 &&
          fileBuf[1] === 0x4b &&
          fileBuf[2] === 0x03 &&
          fileBuf[3] === 0x04) ||
        resolvedPath.toLowerCase().endsWith('.zip')
      ) {
        rawData = unpackVaultZip(fileBuf);
      } else {
        rawData = fileBuf.toString('utf8');
      }
    } else if (options.payload) {
      rawData = options.payload;
    } else {
      throw new Error('Either archivePath or payload must be provided to import vault.');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawData);
    } catch {
      throw new Error('Invalid vault archive: File does not contain valid JSON.');
    }

    let plainArchive: PlainVaultArchive;

    if (
      parsedJson &&
      typeof parsedJson === 'object' &&
      (parsedJson as { format?: string }).format === 'spec-memo-encrypted-vault-v1'
    ) {
      if (!options.password || options.password.trim().length === 0) {
        throw new Error('Password required to decrypt and restore this encrypted vault archive.');
      }
      const decryptedString = decryptPayload(parsedJson as EncryptedVaultArchive, options.password.trim());
      try {
        plainArchive = JSON.parse(decryptedString) as PlainVaultArchive;
      } catch {
        throw new Error('Invalid decrypted payload structure.');
      }
    } else if (
      parsedJson &&
      typeof parsedJson === 'object' &&
      (parsedJson as { format?: string }).format === 'spec-memo-vault-v1'
    ) {
      plainArchive = parsedJson as PlainVaultArchive;
    } else {
      throw new Error('Unrecognized archive format. Expected spec-memo-vault-v1 or spec-memo-encrypted-vault-v1.');
    }

    if (plainArchive.vaultConfig && options.overwrite !== false) {
      const configPath = path.join(vaultRoot, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(plainArchive.vaultConfig, null, 2), 'utf8');
    }

    let restoredRecordsCount = 0;
    const restoredProjects: string[] = [];
    const projectsRoot = path.resolve(vaultRoot, 'projects');

    for (const project of plainArchive.projects) {
      const projId = assertValidProjectId(project.projectId, projectsRoot);
      const projDir = path.resolve(projectsRoot, projId);
      if (!fs.existsSync(projDir)) {
        fs.mkdirSync(projDir, { recursive: true });
      }

      if (project.metadata) {
        const metaPath = path.join(projDir, 'project.json');
        if (!fs.existsSync(metaPath) || options.overwrite !== false) {
          fs.writeFileSync(metaPath, JSON.stringify(project.metadata, null, 2), 'utf8');
        }
      }

      for (const record of project.records) {
        const targetPath = path.resolve(projDir, record.relativePath);
        if (!isPathInside(targetPath, path.resolve(projDir))) {
          throw new Error('Archive record path escapes project directory');
        }

        assertNoSecrets(record.content, 'imported archive record');
        const parsed = parseRecord(record.content);
        const validation = validateFrontmatter(parsed.frontmatter);
        if (!validation.success) {
          throw new Error(`Invalid archive record ${parsed.frontmatter.id}: ${validation.errors.join(', ')}`);
        }

        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        if (!fs.existsSync(targetPath) || options.overwrite !== false) {
          await upsertRecord({
            vaultRoot,
            projectId: project.projectId,
            kind: parsed.frontmatter.kind,
            slug: (parsed.frontmatter.slug as string) || undefined,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            allowDuplicate: parsed.frontmatter.kind !== 'trap'
          });
          restoredRecordsCount++;
        }
      }

      rebuildCompiledViews(project.projectId, vaultRoot);
      restoredProjects.push(project.projectId);
    }

    await rebuildIndex(vaultRoot);
    commitVaultChange('import vault archive', vaultRoot, restoredProjects.map((p) => path.join('projects', p)));

    return {
      vaultRoot,
      restoredProjectsCount: restoredProjects.length,
      restoredRecordsCount,
      restoredProjects,
      rebuiltFts: true
    };
  });
}

/**
 * Alias for importVault for semantic restoration operations.
 */
export const restoreVault = importVault;

/**
 * Complete database reset and file clear with mandatory pre-wipe timestamped backup.
 */
export async function resetVault(options: ResetVaultOptions = {}): Promise<ResetVaultResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);

    const backupsDir = options.backupDir || path.join(vaultRoot, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const backupFilename = formatBackupFilename();
    const backupPath = path.join(backupsDir, backupFilename);

    // 1. Mandatory Pre-Wipe Backup
    // Perform full export of the entire vault or target project before any modifications
    const exportRes = await exportVault({
      vaultRoot,
      projectId: options.all ? undefined : options.projectId,
      password: options.password
    });

    if (!exportRes.payload) {
      throw new Error('Pre-wipe backup failed: Export payload was empty.');
    }

    // Pack into ZIP archive
    const zipBuf = packVaultZip(exportRes.payload);
    fs.writeFileSync(backupPath, zipBuf);

    // Verify backup on disk
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error('Pre-wipe backup failed: Backup archive was not created on disk.');
    }

    let wipedProjectsCount = 0;
    let wipedRecordsCount = 0;

    if (options.projectId && !options.all) {
      // Single project reset
      const projDir = path.join(vaultRoot, 'projects', options.projectId);
      if (fs.existsSync(projDir)) {
        for (const dir of RECORD_SUBDIRS) {
          const sub = path.join(projDir, dir);
          if (fs.existsSync(sub)) {
            const files = fs.readdirSync(sub).filter((f) => f.endsWith('.md'));
            wipedRecordsCount += files.length;
          }
        }
        fs.rmSync(projDir, { recursive: true, force: true });
        wipedProjectsCount = 1;
      }
    } else {
      // Full vault reset: wipe all projects
      const projectsDir = path.join(vaultRoot, 'projects');
      if (fs.existsSync(projectsDir)) {
        const projs = fs.readdirSync(projectsDir);
        for (const p of projs) {
          const pDir = path.join(projectsDir, p);
          try {
            if (fs.statSync(pDir).isDirectory()) {
              wipedProjectsCount++;
              for (const dir of RECORD_SUBDIRS) {
                const sub = path.join(pDir, dir);
                if (fs.existsSync(sub)) {
                  const files = fs.readdirSync(sub).filter((f) => f.endsWith('.md'));
                  wipedRecordsCount += files.length;
                }
              }
            }
          } catch {
            // ignore
          }
        }
        fs.rmSync(projectsDir, { recursive: true, force: true });
      }

      // Drop SQLite database files
      try {
        const filesInVault = fs.readdirSync(vaultRoot);
        for (const f of filesInVault) {
          if (f.startsWith('memo.sqlite')) {
            try {
              fs.rmSync(path.join(vaultRoot, f), { force: true });
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }

      // Clear hybrid sync cursors / state if any
      const syncDir = path.join(vaultRoot, '.sync');
      if (fs.existsSync(syncDir)) {
        fs.rmSync(syncDir, { recursive: true, force: true });
      }
      const hybridState = path.join(vaultRoot, 'hybrid-state.json');
      if (fs.existsSync(hybridState)) {
        fs.rmSync(hybridState, { force: true });
      }
    }

    // Reinitialize empty vault structure and empty SQLite FTS5 database
    ensureVaultStructure(vaultRoot);
    await rebuildIndex(vaultRoot);

    commitVaultChange('reset vault', vaultRoot, ['projects']);

    return {
      ok: true,
      vaultRoot,
      projectId: options.all ? undefined : options.projectId,
      backupFilename,
      backupPath,
      wipedProjectsCount,
      wipedRecordsCount,
      rebuiltFts: true
    };
  });
}

/**
 * List all backup archives available in the vault's backups/ directory.
 * Enriches each entry with manifest metadata when the archive is readable without a password.
 */
export function listBackups(vaultRoot?: string, filters?: BackupListFilters): BackupFileInfo[] {
  const root = getVaultRoot(vaultRoot);
  const backupsDir = path.join(root, 'backups');
  if (!fs.existsSync(backupsDir)) {
    return [];
  }

  const entries = fs.readdirSync(backupsDir);
  const results: BackupFileInfo[] = [];

  for (const entry of entries) {
    if (entry.endsWith('.meta.json')) continue;
    if (entry.endsWith('.zip') || entry.endsWith('.json')) {
      const fullPath = path.join(backupsDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        let meta: Partial<BackupFileInfo> | undefined;
        const metaPath = `${fullPath}.meta.json`;
        try {
          if (fs.existsSync(metaPath) && fs.statSync(metaPath).mtimeMs >= stat.mtimeMs) {
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<BackupFileInfo>;
          }
        } catch {
          meta = undefined;
        }
        if (!meta) {
          try {
            meta = cachedPeekBackupMetadata(fullPath);
          } catch {
            meta = { encrypted: false, inspectable: false, recordCount: null, recordsByKind: {} };
          }
        }

        results.push({
          filename: entry,
          path: fullPath,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          isZip: entry.endsWith('.zip'),
          encrypted: meta.encrypted ?? false,
          inspectable: meta.inspectable,
          scope: meta.scope,
          projectIds: meta.projectIds,
          recordCount: meta.recordCount ?? null,
          recordsByKind: meta.recordsByKind || (meta.encrypted ? undefined : {}),
          format: meta.format
        });
      } catch {
        // ignore unreadable files
      }
    }
  }

  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return filterBackupList(results, filters);
}

/**
 * Apply inventory filters to a backup list (server-side GET query support).
 */
export function filterBackupList(items: BackupFileInfo[], filters?: BackupListFilters): BackupFileInfo[] {
  if (!filters) return items;
  return items.filter((b) => {
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!b.filename.toLowerCase().includes(q)) return false;
    }
    if (filters.scope && filters.scope !== 'all') {
      if (b.scope !== filters.scope) return false;
    }
    if (filters.projectId) {
      if (!b.projectIds || !b.projectIds.includes(filters.projectId)) return false;
    }
    if (typeof filters.encrypted === 'boolean') {
      if (Boolean(b.encrypted) !== filters.encrypted) return false;
    }
    if (filters.since) {
      if (b.createdAt < filters.since) return false;
    }
    if (filters.until) {
      if (b.createdAt > filters.until) return false;
    }
    if (typeof filters.minSize === 'number' && b.size < filters.minSize) return false;
    if (typeof filters.maxSize === 'number' && b.size > filters.maxSize) return false;
    if (filters.kinds && filters.kinds.length > 0) {
      const byKind = b.recordsByKind || {};
      for (const kind of filters.kinds) {
        if (!byKind[kind] || byKind[kind] <= 0) return false;
      }
    }
    return true;
  });
}

/**
 * Persist an export as a timestamped zip under $SPEC_MEMO_ROOT/backups/.
 */
export async function persistVaultBackup(options: PersistBackupOptions = {}): Promise<PersistBackupResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);
    const backupsDir = path.join(vaultRoot, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const exportRes = await exportVault({
      vaultRoot,
      projectId: options.projectId,
      password: options.password
    });

    if (!exportRes.payload) {
      throw new Error('Persist backup failed: Export payload was empty.');
    }

    const filename = formatBackupFilename();
    const backupPath = path.join(backupsDir, filename);
    const zipBuf = packVaultZip(exportRes.payload);
    fs.writeFileSync(backupPath, zipBuf);

    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error('Persist backup failed: Backup archive was not created on disk.');
    }

    const sidecarMeta: Partial<BackupFileInfo> = {
      scope: exportRes.manifest.scope,
      recordCount: exportRes.recordsCount,
      recordsByKind: exportRes.manifest.recordsByKind,
      projectIds: exportRes.manifest.projects.slice(),
      encrypted: exportRes.encrypted,
      inspectable: true,
      format: exportRes.encrypted ? 'spec-memo-encrypted-vault-v1' : 'spec-memo-vault-v1'
    };
    fs.writeFileSync(`${backupPath}.meta.json`, JSON.stringify(sidecarMeta), 'utf8');

    invalidateBackupMetaCache(backupPath);

    return {
      filename,
      size: zipBuf.length,
      recordCount: exportRes.recordsCount,
      projectIds: exportRes.manifest.projects.slice(),
      encrypted: exportRes.encrypted
    };
  });
}

/**
 * Delete a backup archive under backups/ only (never live vault records).
 */
export async function deleteBackup(
  filename: string,
  vaultRoot?: string
): Promise<{ ok: true; filename: string }> {
  const root = getVaultRoot(vaultRoot);
  return withVaultLock(root, async () => {
    const fullPath = resolveBackupPath(root, filename);
    if (!fs.existsSync(fullPath)) {
      const err = new Error(`Backup not found: ${path.basename(filename)}`);
      (err as Error & { code?: string }).code = 'BACKUP_NOT_FOUND';
      throw err;
    }
    fs.unlinkSync(fullPath);
    const metaPath = `${fullPath}.meta.json`;
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
    invalidateBackupMetaCache(fullPath);
    return { ok: true as const, filename: path.basename(fullPath) };
  });
}

/**
 * Inspect a backup archive for the details drawer (no vault mutation).
 */
export function inspectBackup(
  filename: string,
  options: { vaultRoot?: string; password?: string } = {}
): InspectBackupResult {
  const root = getVaultRoot(options.vaultRoot);
  const fullPath = resolveBackupPath(root, filename);
  if (!fs.existsSync(fullPath)) {
    const err = new Error(`Backup not found: ${path.basename(filename)}`);
    (err as Error & { code?: string }).code = 'BACKUP_NOT_FOUND';
    throw err;
  }
  const stat = fs.statSync(fullPath);
  const safeName = path.basename(fullPath);

  let meta: Partial<BackupFileInfo>;
  try {
    meta = cachedPeekBackupMetadata(fullPath, options.password);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Decryption failed') || msg.includes('Incorrect password')) {
      const e = new Error(msg);
      (e as Error & { code?: string }).code = 'BACKUP_DECRYPT_FAILED';
      throw e;
    }
    throw err;
  }

  if (meta.encrypted && meta.inspectable === false) {
    return {
      ok: true,
      filename: safeName,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      isZip: safeName.endsWith('.zip'),
      encrypted: true,
      inspectable: false,
      format: meta.format,
      recordCount: null,
      recordsByKind: {}
    };
  }

  return {
    ok: true,
    filename: safeName,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
    isZip: safeName.endsWith('.zip'),
    encrypted: Boolean(meta.encrypted),
    inspectable: meta.inspectable !== false,
    scope: meta.scope,
    projectIds: meta.projectIds,
    recordCount: meta.recordCount ?? null,
    recordsByKind: meta.recordsByKind || {},
    format: meta.format,
    manifest: meta.projectIds
      ? {
          version: '1.0',
          projects: meta.projectIds,
          recordCount: meta.recordCount ?? undefined
        }
      : undefined
  };
}
