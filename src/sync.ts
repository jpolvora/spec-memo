import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getVaultRoot, RECORD_SUBDIRS, initVault, withVaultLock, commitVaultChange } from "./vault.js";
import { getSubdirForKind, upsertRecord } from "./store.js";
import { parseRecord, serializeRecord, validateFrontmatter } from "./schema.js";
import { rebuildIndex } from "./indexer.js";
import { rebuildCompiledViews } from "./compiler.js";
import { getVaultProjectList, listProjectRecordsInternal } from "./canvas.js";
import { isPathInside, assertNoSecrets } from "./safety.js";
import { RecordFrontmatter, RecordKind } from "./types.js";

export interface ChangesetRecord {
  frontmatter: RecordFrontmatter;
  body: string;
  project: string;
}

export interface ChangesetDeletion {
  project: string;
  kind: RecordKind;
  id: string;
  slug: string;
}

export interface Changeset {
  schemaVersion: 1;
  generatedAt: string;
  sourceVaultRoot?: string;
  records: ChangesetRecord[];
  deletions?: ChangesetDeletion[];
}

export interface SyncResult {
  applied: number;
  skipped: number;
  conflicts: number;
  dryRun: boolean;
  recordsApplied: string[];
}

export interface ExportChangesetOptions {
  since?: string;
  projectId?: string;
}

export interface ApplyChangesetOptions {
  dryRun?: boolean;
  force?: boolean;
}

export function readSyncCursor(vaultRoot: string, peerVault: string): string | undefined {
  try {
    const hash = crypto.createHash("sha256").update(path.resolve(peerVault)).digest("hex").substring(0, 16);
    const cursorFile = path.join(vaultRoot, ".sync", "cursors", `${hash}.json`);
    if (fs.existsSync(cursorFile)) {
      const data = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      return data.lastSyncAt;
    }
  } catch {
    // Ignore read error
  }
  return undefined;
}

export function writeSyncCursor(vaultRoot: string, peerVault: string, cursor: string): void {
  try {
    const hash = crypto.createHash("sha256").update(path.resolve(peerVault)).digest("hex").substring(0, 16);
    const cursorDir = path.join(vaultRoot, ".sync", "cursors");
    if (!fs.existsSync(cursorDir)) {
      fs.mkdirSync(cursorDir, { recursive: true });
    }
    const cursorFile = path.join(cursorDir, `${hash}.json`);
    fs.writeFileSync(cursorFile, JSON.stringify({ peer: path.resolve(peerVault), lastSyncAt: cursor }, null, 2), "utf8");
  } catch {
    // Ignore write error
  }
}

export function exportChangeset(vaultRootInput?: string, options: ExportChangesetOptions = {}): Changeset {
  const vaultRoot = getVaultRoot(vaultRootInput);
  const projects = getVaultProjectList(vaultRoot);
  const records: ChangesetRecord[] = [];

  const targetProjects = options.projectId
    ? projects.filter((p: { id: string }) => p.id === options.projectId)
    : projects;

  for (const proj of targetProjects) {
    const projRecords = listProjectRecordsInternal(vaultRoot, proj.id);
    for (const rec of projRecords) {
      if (options.since) {
        const recordTime = new Date(rec.frontmatter.updated || rec.frontmatter.created).getTime();
        const sinceTime = new Date(options.since).getTime();
        if (!isNaN(sinceTime) && recordTime < sinceTime) {
          continue;
        }
      }
      records.push({
        frontmatter: rec.frontmatter,
        body: rec.body,
        project: proj.id
      });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    records
  };
}

export async function applyChangeset(
  vaultRootInput: string | undefined,
  changeset: Changeset,
  options: ApplyChangesetOptions = {}
): Promise<SyncResult> {
  const vaultRoot = getVaultRoot(vaultRootInput);
  return withVaultLock(vaultRoot, async () => {
    const dryRun = !!options.dryRun;
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;
    const recordsApplied: string[] = [];

    const touchedProjects = new Set<string>();

    for (const item of changeset.records) {
      const projId = item.project;
      touchedProjects.add(projId);

      const projDir = path.resolve(vaultRoot, "projects", projId);
      if (!isPathInside(projDir, path.resolve(vaultRoot, "projects"))) {
        throw new Error("Changeset project path escapes vault projects directory");
      }
      if (!dryRun && !fs.existsSync(projDir)) {
        initVault({ vaultRoot, projectId: projId, displayName: projId });
      }

      const kind = item.frontmatter.kind;
      const recId = item.frontmatter.id;
      const slug = String(item.frontmatter.slug || recId);
      const kindDir = path.join(projDir, getSubdirForKind(kind));
      const targetFilePath = path.resolve(kindDir, `${slug}.md`);

      if (!isPathInside(targetFilePath, projDir)) {
        throw new Error("Changeset record path escapes project directory");
      }

      assertNoSecrets(item.body, "synced changeset body");
      assertNoSecrets(item.frontmatter, "synced changeset frontmatter");
      const validation = validateFrontmatter(item.frontmatter);
      if (!validation.success) {
        throw new Error(`Invalid changeset record ${item.frontmatter.id}: ${validation.errors.join(", ")}`);
      }

      if (fs.existsSync(targetFilePath)) {
        const existingContent = fs.readFileSync(targetFilePath, "utf8");
        const existing = parseRecord(existingContent);

        const localTime = new Date(existing.frontmatter.updated || existing.frontmatter.created).getTime();
        const remoteTime = new Date(item.frontmatter.updated || item.frontmatter.created).getTime();

        if (existingContent === serializeRecord(item)) {
          skipped++;
          continue;
        }

        if (remoteTime > localTime || options.force) {
          if (!dryRun) {
            if (kind === "log") {
              const mergedSlug = `${slug}.remote.${Date.now()}`;
              await upsertRecord({
                vaultRoot,
                projectId: projId,
                kind,
                slug: mergedSlug,
                frontmatter: item.frontmatter,
                body: item.body
              });
            } else {
              await upsertRecord({
                vaultRoot,
                projectId: projId,
                kind,
                slug,
                frontmatter: item.frontmatter,
                body: item.body
              });
            }
          }
          applied++;
          recordsApplied.push(`${projId}/${kind}/${recId}`);
        } else if (remoteTime === localTime) {
          conflicts++;
          if (!dryRun) {
            const conflictPath = path.resolve(kindDir, `${slug}.conflict.${Date.now()}.md`);
            fs.writeFileSync(conflictPath, serializeRecord(item), "utf8");
          }
          recordsApplied.push(`${projId}/${kind}/${recId} (conflict-saved)`);
        } else {
          skipped++;
        }
      } else {
        if (!dryRun) {
          await upsertRecord({
            vaultRoot,
            projectId: projId,
            kind,
            slug,
            frontmatter: item.frontmatter,
            body: item.body,
            allowDuplicate: kind !== "trap"
          });
        }
        applied++;
        recordsApplied.push(`${projId}/${kind}/${recId}`);
      }
    }

    if (changeset.deletions && Array.isArray(changeset.deletions)) {
      for (const del of changeset.deletions) {
        const projDir = path.resolve(vaultRoot, "projects", del.project);
        const kindDir = path.join(projDir, getSubdirForKind(del.kind));
        const slug = del.slug || del.id;
        const targetPath = path.resolve(kindDir, `${slug}.md`);
        if (isPathInside(targetPath, projDir) && fs.existsSync(targetPath)) {
          if (!dryRun) {
            fs.unlinkSync(targetPath);
          }
          touchedProjects.add(del.project);
          applied++;
          recordsApplied.push(`${del.project}/${del.kind}/${del.id} (deleted)`);
        }
      }
    }

    if (!dryRun && applied > 0) {
      for (const projId of touchedProjects) {
        rebuildCompiledViews(projId, vaultRoot);
      }
      await rebuildIndex(vaultRoot);
      commitVaultChange(
        "sync changeset applied",
        vaultRoot,
        Array.from(touchedProjects).map((p) => path.join("projects", p))
      );
    }

    return {
      applied,
      skipped,
      conflicts,
      dryRun,
      recordsApplied
    };
  });
}

export async function syncVaults(
  sourceVaultInput: string,
  targetVaultInput: string,
  options: { twoWay?: boolean; since?: string; dryRun?: boolean } = {}
): Promise<{ forward: SyncResult; backward?: SyncResult }> {
  const sourceVault = getVaultRoot(sourceVaultInput);
  const targetVault = getVaultRoot(targetVaultInput);

  const [first, second] = sourceVault < targetVault ? [sourceVault, targetVault] : [targetVault, sourceVault];

  const doSync = async () => {
    // 1. Source -> Target
    const sinceForward = options.since ?? readSyncCursor(sourceVault, targetVault);
    const changesetForward = exportChangeset(sourceVault, { since: sinceForward });
    const forwardResult = await applyChangeset(targetVault, changesetForward, { dryRun: options.dryRun });
    if (!options.dryRun) {
      writeSyncCursor(sourceVault, targetVault, changesetForward.generatedAt);
    }

    let backwardResult: SyncResult | undefined;
    if (options.twoWay) {
      // 2. Target -> Source
      const sinceBackward = options.since ?? readSyncCursor(targetVault, sourceVault);
      const changesetBackward = exportChangeset(targetVault, { since: sinceBackward });
      backwardResult = await applyChangeset(sourceVault, changesetBackward, { dryRun: options.dryRun });
      if (!options.dryRun) {
        writeSyncCursor(targetVault, sourceVault, changesetBackward.generatedAt);
      }
    }

    return { forward: forwardResult, backward: backwardResult };
  };

  if (first === second) {
    return withVaultLock(first, doSync);
  }
  return withVaultLock(first, () => withVaultLock(second, doSync));
}
