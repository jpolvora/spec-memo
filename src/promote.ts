import * as fs from 'node:fs';
import * as path from 'node:path';
import { PromoteOptions, PromoteResult } from './types.js';
import { getRecord } from './store.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot } from './vault.js';
import { serializeRecord } from './schema.js';
import { isPathInside } from './safety.js';

/**
 * Promote a vault record (e.g. decision, spec) into the consumer product repository.
 * Enforces a strict default-deny boundary: the target path MUST reside inside the product root.
 */
export async function promoteRecord(options: PromoteOptions): Promise<PromoteResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const projectId = options.projectId || identity.projectId;

  if (!options.destination || typeof options.destination !== 'string' || options.destination.trim().length === 0) {
    throw new Error('Destination path is required to promote a record into the product repository.');
  }

  const record = await getRecord({
    cwd: options.cwd,
    projectId,
    vaultRoot,
    id: options.id,
    kind: options.kind,
    slug: options.slug
  });

  if (!record) {
    const lookup = options.id || `${options.kind || ''}/${options.slug || ''}`;
    throw new Error(`Record not found for promotion: ${lookup}`);
  }

  // Resolve absolute destination path against product root
  const destClean = options.destination.trim();
  const resolvedTarget = path.isAbsolute(destClean)
    ? path.resolve(destClean)
    : path.resolve(identity.rootPath, destClean);

  // Strict default-deny: destination MUST be inside consumer product root
  if (!isPathInside(resolvedTarget, identity.rootPath)) {
    throw new Error(
      `Safety violation (Default Deny): Promote destination must be inside consumer product repository (${identity.rootPath}). Target: ${resolvedTarget}`
    );
  }

  // Check if file already exists
  if (fs.existsSync(resolvedTarget) && !options.force) {
    throw new Error(
      `Target destination already exists: ${destClean}. Specify force: true to overwrite existing files.`
    );
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Serialize record with YAML frontmatter and body
  const fileContent = serializeRecord({
    frontmatter: record.frontmatter,
    body: record.body
  });

  fs.writeFileSync(resolvedTarget, fileContent, 'utf8');
  const bytesWritten = Buffer.byteLength(fileContent, 'utf8');

  const relativeDest = path.relative(identity.rootPath, resolvedTarget).replace(/\\/g, '/');

  return {
    id: record.frontmatter.id,
    kind: record.frontmatter.kind,
    destination: relativeDest,
    targetPath: resolvedTarget,
    bytesWritten
  };
}
