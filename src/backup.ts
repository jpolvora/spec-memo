import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ExportVaultOptions,
  ExportVaultResult,
  ImportVaultOptions,
  ImportVaultResult,
  VaultConfig
} from './types.js';
import { getVaultRoot, ensureVaultStructure, withVaultLock, commitVaultChange } from './vault.js';
import { rebuildCompiledViews } from './compiler.js';
import { rebuildIndex } from './indexer.js';
import { isPathInside, assertNoSecrets } from './safety.js';
import { parseRecord, validateFrontmatter } from './schema.js';

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
 * Export vault projects and records into a portable archive bundle (optionally encrypted).
 */
export async function exportVault(options: ExportVaultOptions = {}): Promise<ExportVaultResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);

    const projectsDir = path.join(vaultRoot, 'projects');
    const exportedProjects: ExportedProject[] = [];
    const projectNames: string[] = [];
    let totalRecords = 0;

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
        const recordDirs = ['traps', 'decisions', 'specs', 'plans', 'logs', 'reviews', 'scratch'];

        for (const dirName of recordDirs) {
          const subDir = path.join(projPath, dirName);
          if (fs.existsSync(subDir)) {
            const files = fs.readdirSync(subDir);
            for (const file of files) {
              if (file.endsWith('.md') && !file.includes('.conflict.')) {
                const filePath = path.join(subDir, file);
                try {
                  const content = fs.readFileSync(filePath, 'utf8');
                  const relPath = `${dirName}/${file}`;
                  records.push({ relativePath: relPath, content });
                  totalRecords++;
                } catch {
                  // Ignore
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
      recordCount: totalRecords
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
 * Import a vault archive bundle (plaintext or encrypted) into the local vault.
 */
export async function importVault(options: ImportVaultOptions = {}): Promise<ImportVaultResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  return withVaultLock(vaultRoot, async () => {
    ensureVaultStructure(vaultRoot);

    let rawData: string;
    if (options.archivePath) {
      const resolvedPath = path.resolve(options.archivePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Vault archive file not found: ${resolvedPath}`);
      }
      rawData = fs.readFileSync(resolvedPath, 'utf8');
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
      const projDir = path.resolve(projectsRoot, project.projectId);
      if (!isPathInside(projDir, projectsRoot)) {
        throw new Error('Archive project path escapes vault projects directory');
      }
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
          fs.writeFileSync(targetPath, record.content, 'utf8');
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
