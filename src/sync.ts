import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getVaultRoot, RECORD_SUBDIRS, initVault, withVaultLock, commitVaultChange } from "./vault.js";
import { getSubdirForKind, upsertRecord } from "./store.js";
import { parseRecord, serializeRecord, validateFrontmatter } from "./schema.js";
import { rebuildIndex } from "./indexer.js";
import { rebuildCompiledViews } from "./compiler.js";
import { getVaultProjectList, listProjectRecordsInternal } from "./canvas.js";
import { isPathInside, assertNoSecrets, assertValidProjectId } from "./safety.js";
import { RecordFrontmatter, RecordKind, ConflictStrategy, ConflictRecordDetail } from "./types.js";

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
  autoMerged?: number;
  sidecarsCleaned?: number;
  conflictDetails?: ConflictRecordDetail[];
}

export interface ExportChangesetOptions {
  since?: string;
  projectId?: string;
}

export interface ApplyChangesetOptions {
  dryRun?: boolean;
  force?: boolean;
  prefer?: 'local' | 'remote';
  strategy?: ConflictStrategy;
  cleanSidecars?: boolean;
}

export function areBodiesSemanticallyEqual(bodyA: string, bodyB: string): boolean {
  const normA = (bodyA || "").replace(/\r\n/g, "\n").trim();
  const normB = (bodyB || "").replace(/\r\n/g, "\n").trim();
  return normA === normB;
}

export function mergeRecordMetadata(
  localFm: RecordFrontmatter,
  incomingFm: RecordFrontmatter
): RecordFrontmatter {
  const merged: RecordFrontmatter = { ...localFm, ...incomingFm };

  const localHits = Number(localFm.hits || 0);
  const incomingHits = Number(incomingFm.hits || 0);
  if (localHits > 0 || incomingHits > 0) {
    merged.hits = Math.max(localHits, incomingHits);
  }

  const localOcc = Number(localFm.occurrences || 1);
  const incomingOcc = Number(incomingFm.occurrences || 1);
  if (localOcc > 1 || incomingOcc > 1) {
    merged.occurrences = Math.max(localOcc, incomingOcc);
  }

  if (localFm.lastHit || incomingFm.lastHit) {
    const tLocal = localFm.lastHit ? new Date(localFm.lastHit).getTime() : 0;
    const tIncoming = incomingFm.lastHit ? new Date(incomingFm.lastHit).getTime() : 0;
    merged.lastHit = tIncoming >= tLocal ? incomingFm.lastHit : localFm.lastHit;
  }

  if (localFm.lastSeen || incomingFm.lastSeen) {
    const tLocal = localFm.lastSeen ? new Date(localFm.lastSeen).getTime() : 0;
    const tIncoming = incomingFm.lastSeen ? new Date(incomingFm.lastSeen).getTime() : 0;
    merged.lastSeen = tIncoming >= tLocal ? incomingFm.lastSeen : localFm.lastSeen;
  }

  const localTags = Array.isArray(localFm.tags) ? localFm.tags : [];
  const incomingTags = Array.isArray(incomingFm.tags) ? incomingFm.tags : [];
  if (localTags.length > 0 || incomingTags.length > 0) {
    merged.tags = Array.from(new Set([...localTags, ...incomingTags]));
  }

  const localPaths = Array.isArray(localFm.linkedPaths) ? localFm.linkedPaths : [];
  const incomingPaths = Array.isArray(incomingFm.linkedPaths) ? incomingFm.linkedPaths : [];
  if (localPaths.length > 0 || incomingPaths.length > 0) {
    merged.linkedPaths = Array.from(new Set([...localPaths, ...incomingPaths]));
  }

  if (localFm.status === "superseded" || incomingFm.status === "superseded") {
    merged.status = "superseded";
  } else if (localFm.status === "archived" && incomingFm.status === "archived") {
    merged.status = "archived";
  } else if (localFm.status === "active" || incomingFm.status === "active") {
    merged.status = "active";
  }
  // else: keep spread result (incoming precedence already applied above).

  const tLocalUp = new Date(localFm.updated || localFm.created).getTime();
  const tIncomingUp = new Date(incomingFm.updated || incomingFm.created).getTime();
  merged.updated = tIncomingUp >= tLocalUp ? incomingFm.updated : localFm.updated;

  return merged;
}

export interface CleanSidecarsOptions {
  prefer?: 'local' | 'remote';
  dryRun?: boolean;
  projectId?: string;
  journal?: Array<{ filePath: string; originalContent: string | null }>;
}

export interface CleanSidecarsResult {
  cleaned: number;
  retained: number;
  filesCleaned: string[];
  filesRetained: string[];
}

export function cleanConflictSidecars(
  vaultRootInput?: string,
  options: CleanSidecarsOptions = {}
): CleanSidecarsResult {
  const vaultRoot = getVaultRoot(vaultRootInput);
  const projectsDir = path.resolve(vaultRoot, "projects");
  if (!fs.existsSync(projectsDir)) {
    return { cleaned: 0, retained: 0, filesCleaned: [], filesRetained: [] };
  }

  let cleaned = 0;
  let retained = 0;
  const filesCleaned: string[] = [];
  const filesRetained: string[] = [];
  const journal = options.journal;
  const recordJournal = (filePath: string, originalContent: string | null): void => {
    if (!journal || options.dryRun) return;
    if (!journal.some((j) => j.filePath === filePath)) {
      journal.push({ filePath, originalContent });
    }
  };

  const targetProjects = options.projectId
    ? [options.projectId]
    : fs.readdirSync(projectsDir).filter((d) => {
        try {
          return fs.statSync(path.join(projectsDir, d)).isDirectory();
        } catch {
          return false;
        }
      });

  for (const projId of targetProjects) {
    const projDir = path.join(projectsDir, projId);
    if (!fs.existsSync(projDir)) continue;

    for (const subdir of Object.values(RECORD_SUBDIRS)) {
      const kindDir = path.join(projDir, subdir);
      if (!fs.existsSync(kindDir)) continue;

      const entries = fs.readdirSync(kindDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const conflictMatch = entry.match(/^(.+?)\.conflict(?:\..+?)?\.md$/);
        if (!conflictMatch) continue;

        const baseSlug = conflictMatch[1];
        const baseFilePath = path.join(kindDir, `${baseSlug}.md`);
        const sidecarFilePath = path.join(kindDir, entry);

        if (fs.existsSync(baseFilePath)) {
          let canClean = false;
          try {
            const baseContent = fs.readFileSync(baseFilePath, "utf8");
            const sidecarContent = fs.readFileSync(sidecarFilePath, "utf8");
            const baseRecord = parseRecord(baseContent);
            const sidecarRecord = parseRecord(sidecarContent);

            if (areBodiesSemanticallyEqual(baseRecord.body, sidecarRecord.body)) {
              if (!options.dryRun) {
                const mergedFm = mergeRecordMetadata(baseRecord.frontmatter, sidecarRecord.frontmatter);
                recordJournal(baseFilePath, baseContent);
                fs.writeFileSync(
                  baseFilePath,
                  serializeRecord({ frontmatter: mergedFm, body: baseRecord.body }),
                  "utf8"
                );
              }
              canClean = true;
            } else if (options.prefer === "local") {
              canClean = true;
            } else if (options.prefer === "remote") {
              if (!options.dryRun) {
                recordJournal(baseFilePath, baseContent);
                fs.copyFileSync(sidecarFilePath, baseFilePath);
              }
              canClean = true;
            }
          } catch {
            if (options.prefer === "local") {
              canClean = true;
            }
          }

          if (canClean) {
            if (!options.dryRun) {
              try {
                try {
                  recordJournal(sidecarFilePath, fs.readFileSync(sidecarFilePath, "utf8"));
                } catch {
                  recordJournal(sidecarFilePath, null);
                }
                fs.unlinkSync(sidecarFilePath);
              } catch {
                // Ignore unlink errors
              }
            }
            cleaned++;
            filesCleaned.push(`${projId}/${subdir}/${entry}`);
          } else {
            retained++;
            filesRetained.push(`${projId}/${subdir}/${entry}`);
          }
        } else {
          if (!options.dryRun) {
            try {
              try {
                recordJournal(sidecarFilePath, fs.readFileSync(sidecarFilePath, "utf8"));
              } catch {
                recordJournal(sidecarFilePath, null);
              }
              recordJournal(baseFilePath, null);
              fs.renameSync(sidecarFilePath, baseFilePath);
            } catch {
              // Ignore
            }
          }
          cleaned++;
          filesCleaned.push(`${projId}/${subdir}/${entry} (promoted)`);
        }
      }
    }
  }

  return { cleaned, retained, filesCleaned, filesRetained };
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

export function recordTombstone(
  vaultRoot: string,
  project: string,
  kind: RecordKind,
  id: string,
  slug: string
): void {
  try {
    const tombstonesDir = path.join(vaultRoot, ".sync", "tombstones");
    if (!fs.existsSync(tombstonesDir)) {
      fs.mkdirSync(tombstonesDir, { recursive: true });
    }
    const tombstoneFile = path.join(tombstonesDir, `${project}.json`);
    let tombstones: Array<ChangesetDeletion & { deletedAt: string }> = [];
    if (fs.existsSync(tombstoneFile)) {
      try {
        tombstones = JSON.parse(fs.readFileSync(tombstoneFile, "utf8"));
      } catch {
        tombstones = [];
      }
    }
    tombstones.push({
      project,
      kind,
      id,
      slug,
      deletedAt: new Date().toISOString()
    });
    fs.writeFileSync(tombstoneFile, JSON.stringify(tombstones, null, 2), "utf8");
  } catch {
    // Non-blocking
  }
}

export function collectTombstones(
  vaultRoot: string,
  since?: string,
  projectId?: string
): ChangesetDeletion[] {
  const result: ChangesetDeletion[] = [];
  try {
    const tombstonesDir = path.join(vaultRoot, ".sync", "tombstones");
    if (!fs.existsSync(tombstonesDir)) {
      return result;
    }
    const files = fs.readdirSync(tombstonesDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const proj = file.replace(/\.json$/, "");
      if (projectId && proj !== projectId) continue;
      const filePath = path.join(tombstonesDir, file);
      try {
        const list: Array<ChangesetDeletion & { deletedAt: string }> = JSON.parse(
          fs.readFileSync(filePath, "utf8")
        );
        for (const item of list) {
          if (since && new Date(item.deletedAt) <= new Date(since)) {
            continue;
          }
          result.push({
            project: item.project,
            kind: item.kind,
            id: item.id,
            slug: item.slug
          });
        }
      } catch {
        // Ignore unreadable
      }
    }
  } catch {
    // Ignore error
  }
  return result;
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

  const deletions = collectTombstones(vaultRoot, options.since, options.projectId);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    records,
    deletions: deletions.length > 0 ? deletions : undefined
  };
}

export async function applyChangeset(
  vaultRootInput: string | undefined,
  changeset: Changeset,
  options: ApplyChangesetOptions = {}
): Promise<SyncResult> {
  const vaultRoot = getVaultRoot(vaultRootInput);

  // Phase 1: Pre-execution validation across all records (AC9)
  const validatedRecords: Array<{
    projId: string;
    projDir: string;
    kind: import("./types.js").RecordKind;
    recId: string;
    slug: string;
    kindDir: string;
    targetFilePath: string;
    item: ChangesetRecord;
  }> = [];

  for (const item of changeset.records || []) {
    const projId = assertValidProjectId(item.project, path.resolve(vaultRoot, "projects"));
    const projDir = path.resolve(vaultRoot, "projects", projId);
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

    validatedRecords.push({
      projId,
      projDir,
      kind,
      recId,
      slug,
      kindDir,
      targetFilePath,
      item
    });
  }

  // Phase 2: Transactional Execution with Staging Rollback Journal (AC10, AC11, AC12)
  return withVaultLock(vaultRoot, async () => {
    const dryRun = !!options.dryRun;
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;
    let autoMerged = 0;
    const recordsApplied: string[] = [];
    const conflictDetails: ConflictRecordDetail[] = [];
    const touchedProjects = new Set<string>();
    const sidecarProjects = new Set<string>();

    const journal: Array<{ filePath: string; originalContent: string | null }> = [];

    try {
      for (const rec of validatedRecords) {
        const { projId, projDir, kind, recId, slug, kindDir, targetFilePath, item } = rec;
        touchedProjects.add(projId);

        if (!dryRun && !fs.existsSync(projDir)) {
          initVault({ vaultRoot, projectId: projId, displayName: projId });
        }

        if (fs.existsSync(targetFilePath)) {
          const existingContent = fs.readFileSync(targetFilePath, "utf8");
          const existing = parseRecord(existingContent);

          const localTime = new Date(existing.frontmatter.updated || existing.frontmatter.created).getTime();
          const remoteTime = new Date(item.frontmatter.updated || item.frontmatter.created).getTime();

          const bodiesMatch = areBodiesSemanticallyEqual(existing.body, item.body);

          // Record original for rollback journal before any modification
          if (!dryRun && !journal.some((j) => j.filePath === targetFilePath)) {
            journal.push({ filePath: targetFilePath, originalContent: existingContent });
          }

          if (bodiesMatch) {
            // Bodies are identical: check if frontmatter also matches
            const existingNormalizedFm = { ...(existing.frontmatter as Record<string, unknown>) };
            const incomingNormalizedFm = { ...(item.frontmatter as Record<string, unknown>) };
            delete existingNormalizedFm.hits;
            delete existingNormalizedFm.lastHit;
            delete incomingNormalizedFm.hits;
            delete incomingNormalizedFm.lastHit;

            if (!existingNormalizedFm.slug || existingNormalizedFm.slug === existingNormalizedFm.id) {
              delete existingNormalizedFm.slug;
            }
            if (!incomingNormalizedFm.slug || incomingNormalizedFm.slug === incomingNormalizedFm.id) {
              delete incomingNormalizedFm.slug;
            }

            const stableStringify = (obj: Record<string, unknown>): string => {
              const sorted: Record<string, unknown> = {};
              for (const key of Object.keys(obj).sort()) {
                if (obj[key] !== undefined) {
                  sorted[key] = obj[key];
                }
              }
              return JSON.stringify(sorted);
            };

            const fmIdentical = stableStringify(existingNormalizedFm) === stableStringify(incomingNormalizedFm);
            const hitsIdentical =
              Number(existing.frontmatter.hits || 0) === Number(item.frontmatter.hits || 0) &&
              existing.frontmatter.lastHit === item.frontmatter.lastHit;

            if (fmIdentical && hitsIdentical) {
              skipped++;
              continue;
            }

            // AC2 & AC3: Bodies match but metadata differs -> auto-merge metadata cleanly
            const mergedFm = mergeRecordMetadata(existing.frontmatter, item.frontmatter);
            if (!dryRun) {
              await upsertRecord({
                vaultRoot,
                projectId: projId,
                kind,
                slug,
                frontmatter: mergedFm,
                body: existing.body,
                allowDuplicate: kind !== "trap"
              });
            }
            applied++;
            autoMerged++;
            recordsApplied.push(`${projId}/${kind}/${recId} (auto-merged)`);
            continue;
          }

          // Bodies actually diverge! Determine conflict strategy
          const effectiveStrategy =
            options.prefer === "local"
              ? "local-wins"
              : options.prefer === "remote"
                ? "remote-wins"
                : options.strategy || (options.force ? "local-wins" : "smart-merge");

          if (effectiveStrategy === "local-wins") {
            // Local wins: existing local record is preserved; incoming remote record is skipped
            skipped++;
            recordsApplied.push(`${projId}/${kind}/${recId} (local-wins)`);
          } else if (effectiveStrategy === "remote-wins") {
            // Remote wins: incoming record overwrites
            if (!dryRun) {
              await upsertRecord({
                vaultRoot,
                projectId: projId,
                kind,
                slug,
                frontmatter: item.frontmatter,
                body: item.body
              });
            }
            applied++;
            recordsApplied.push(`${projId}/${kind}/${recId} (remote-wins)`);
          } else if (effectiveStrategy === "sidecar") {
            // Sidecar strategy: write single deterministic conflict sidecar for incoming
            conflicts++;
            if (!dryRun) {
              const conflictPath = path.resolve(kindDir, `${slug}.conflict.md`);
              if (!journal.some((j) => j.filePath === conflictPath)) {
                journal.push({
                  filePath: conflictPath,
                  originalContent: fs.existsSync(conflictPath) ? fs.readFileSync(conflictPath, "utf8") : null
                });
              }
              fs.writeFileSync(conflictPath, serializeRecord(item), "utf8");
            }
            conflictDetails.push({
              id: recId,
              kind,
              projectId: projId,
              category: "body_divergence",
              resolution: "sidecar-written",
              localTime: existing.frontmatter.updated || existing.frontmatter.created,
              remoteTime: item.frontmatter.updated || item.frontmatter.created
            });
            recordsApplied.push(`${projId}/${kind}/${recId} (conflict-saved)`);
          } else {
            // Smart-merge default strategy
            if (remoteTime > localTime) {
              // Remote is newer
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
              // True body conflict with identical timestamp: write single deterministic sidecar
              conflicts++;
              if (!dryRun) {
                // AC4: Write single deterministic ${slug}.conflict.md
                const conflictPath = path.resolve(kindDir, `${slug}.conflict.md`);
                if (!journal.some((j) => j.filePath === conflictPath)) {
                  journal.push({
                    filePath: conflictPath,
                    originalContent: fs.existsSync(conflictPath) ? fs.readFileSync(conflictPath, "utf8") : null
                  });
                }
                fs.writeFileSync(conflictPath, serializeRecord(item), "utf8");
              }
              conflictDetails.push({
                id: recId,
                kind,
                projectId: projId,
                category: "body_divergence",
                resolution: "sidecar-written",
                localTime: existing.frontmatter.updated || existing.frontmatter.created,
                remoteTime: item.frontmatter.updated || item.frontmatter.created
              });
              recordsApplied.push(`${projId}/${kind}/${recId} (conflict-saved)`);
            } else {
              // localTime > remoteTime: local is newer, preserve local
              skipped++;
            }
          }
        } else {
          // Record does not exist locally yet (new record)
          if (!dryRun && !journal.some((j) => j.filePath === targetFilePath)) {
            journal.push({ filePath: targetFilePath, originalContent: null });
          }
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
          const projId = assertValidProjectId(del.project, path.resolve(vaultRoot, "projects"));
          const projDir = path.resolve(vaultRoot, "projects", projId);
          const kindDir = path.join(projDir, getSubdirForKind(del.kind));
          const slug = del.slug || del.id;
          const targetPath = path.resolve(kindDir, `${slug}.md`);
          if (isPathInside(targetPath, projDir) && fs.existsSync(targetPath)) {
            if (!dryRun && !journal.some((j) => j.filePath === targetPath)) {
              journal.push({ filePath: targetPath, originalContent: fs.readFileSync(targetPath, "utf8") });
            }
            if (!dryRun) {
              fs.unlinkSync(targetPath);
              recordTombstone(vaultRoot, projId, del.kind, del.id, slug);
            }
            touchedProjects.add(projId);
            applied++;
            recordsApplied.push(`${projId}/${del.kind}/${del.id} (deleted)`);
          }
        }
      }

      let sidecarsCleaned = 0;
      if (options.cleanSidecars && !dryRun) {
        const cleanRes = cleanConflictSidecars(vaultRoot, { prefer: options.prefer, journal });
        sidecarsCleaned = cleanRes.cleaned;
        for (const f of cleanRes.filesCleaned) {
          const pid = f.split("/")[0];
          if (pid) sidecarProjects.add(pid);
        }
      }

      const projectsToRebuild = new Set<string>([...touchedProjects, ...sidecarProjects]);
      if (!dryRun && (applied > 0 || autoMerged > 0 || sidecarsCleaned > 0)) {
        for (const projId of projectsToRebuild) {
          rebuildCompiledViews(projId, vaultRoot);
        }
        await rebuildIndex(vaultRoot);
        commitVaultChange(
          "sync changeset applied",
          vaultRoot,
          Array.from(projectsToRebuild).map((p) => path.join("projects", p))
        );
      }

      // AC20: durable audit trail for body-divergence conflicts under subsystem sync-reconcile.
      if (!dryRun && conflictDetails.length > 0) {
        try {
          const { logErrorReport } = await import("./error-logger.js");
          for (const detail of conflictDetails) {
            logErrorReport(
              {
                level: "WARN",
                subsystem: "sync-reconcile",
                error: new Error(`Conflict ${detail.category}: ${detail.projectId}/${detail.kind}/${detail.id}`),
                context: { ...detail }
              },
              { vaultRoot }
            );
          }
        } catch {
          // Best-effort logging must never fail the apply
        }
      }

      return {
        applied,
        skipped,
        conflicts,
        dryRun,
        recordsApplied,
        autoMerged,
        sidecarsCleaned,
        conflictDetails: conflictDetails.length > 0 ? conflictDetails : undefined
      };
    } catch (err: unknown) {
      // AC11: Rollback all modified files from journal on failure
      if (!dryRun && journal.length > 0) {
        for (const entry of journal.reverse()) {
          try {
            if (entry.originalContent !== null) {
              fs.writeFileSync(entry.filePath, entry.originalContent, "utf8");
            } else if (fs.existsSync(entry.filePath)) {
              fs.unlinkSync(entry.filePath);
            }
          } catch {
            // Best effort rollback
          }
        }
        // FTS + compiled views were incrementally mutated during the loop
        // (upsertRecord indexes per write), so rebuild them best-effort from
        // restored markdown. doctor --rebuild remains the escape hatch.
        try {
          await rebuildIndex(vaultRoot);
          for (const projId of new Set<string>([...touchedProjects, ...sidecarProjects])) {
            rebuildCompiledViews(projId, vaultRoot);
          }
        } catch {
          // Best effort — rollback of markdown already completed above
        }
      }
      throw err;
    }
  });
}

export async function syncVaults(
  sourceVaultInput: string,
  targetVaultInput: string,
  options: {
    twoWay?: boolean;
    since?: string;
    dryRun?: boolean;
    prefer?: 'local' | 'remote';
    strategy?: ConflictStrategy;
    cleanSidecars?: boolean;
  } = {}
): Promise<{ forward: SyncResult; backward?: SyncResult }> {
  const sourceVault = getVaultRoot(sourceVaultInput);
  const targetVault = getVaultRoot(targetVaultInput);

  const [first, second] = sourceVault < targetVault ? [sourceVault, targetVault] : [targetVault, sourceVault];

  const doSync = async () => {
    // 1. Source -> Target
    const sinceForward = options.since ?? readSyncCursor(sourceVault, targetVault);
    const changesetForward = exportChangeset(sourceVault, { since: sinceForward });
    const forwardResult = await applyChangeset(targetVault, changesetForward, {
      dryRun: options.dryRun,
      prefer: options.prefer,
      strategy: options.strategy,
      cleanSidecars: options.cleanSidecars
    });
    if (!options.dryRun) {
      writeSyncCursor(sourceVault, targetVault, changesetForward.generatedAt);
    }

    let backwardResult: SyncResult | undefined;
    if (options.twoWay) {
      // 2. Target -> Source
      const sinceBackward = options.since ?? readSyncCursor(targetVault, sourceVault);
      const changesetBackward = exportChangeset(targetVault, { since: sinceBackward });
      backwardResult = await applyChangeset(sourceVault, changesetBackward, {
        dryRun: options.dryRun,
        prefer: options.prefer,
        strategy: options.strategy,
        cleanSidecars: options.cleanSidecars
      });
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
