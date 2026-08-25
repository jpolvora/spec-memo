import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import { ImportItem, ImportOptions, ImportResult, MemoRecord, RecordFrontmatter, RecordKind, RecordStatus } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { ensureProjectVault, getVaultRoot } from './vault.js';
import { upsertRecord, slugify } from './store.js';
import { rebuildCompiledViews } from './compiler.js';
import { rebuildIndex } from './indexer.js';

/**
 * Helper to safely read a file as utf-8.
 */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Extract title from Markdown content if not present in frontmatter.
 */
function extractTitleFromMarkdown(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim().replace(/^Specification\s*—\s*/i, '');
  }
  return null;
}

/**
 * Normalize legacy record status into valid RecordStatus.
 */
function normalizeRecordStatus(status: unknown): { status: RecordStatus; decisionStatus?: string } {
  if (typeof status !== 'string') {
    return { status: 'active' };
  }
  const s = status.toLowerCase();
  if (s === 'accepted' || s === 'proposed') {
    return { status: 'active', decisionStatus: s };
  }
  if (s === 'active' || s === 'paused' || s === 'shipped' || s === 'superseded' || s === 'archived') {
    return { status: s as RecordStatus };
  }
  return { status: 'active' };
}

/**
 * Import a legacy workflow tree (.agents/specs, memory/, plans/, changelog) into the external vault.
 */
export async function importWorkflowTree(options: ImportOptions = {}): Promise<ImportResult> {
  const vaultRoot = options.vaultRoot || getVaultRoot();
  const sourceRoot = options.from || options.productRoot || options.cwd || process.cwd();
  const identity = resolveProjectIdentity(sourceRoot, { vaultRoot });
  const projectId = options.projectId || identity.projectId;

  ensureProjectVault(identity, vaultRoot);

  const importedRecords: ImportItem[] = [];
  const skippedPaths: string[] = [];

  let importedSpecsCount = 0;
  let importedTrapsCount = 0;
  let importedDecisionsCount = 0;
  let importedPlansCount = 0;
  let importedLogsCount = 0;
  let importedStateCount = 0;
  let skippedFilesCount = 0;

  // Candidate directories for legacy specs
  const specDirCandidates = [
    path.join(sourceRoot, '.agents', 'specs'),
    path.join(sourceRoot, 'specs'),
    path.join(sourceRoot, '.spec-memo', 'specs')
  ];

  // Candidate directories for memory traps and decisions
  const memoryDirCandidates = [
    path.join(sourceRoot, 'memory'),
    path.join(sourceRoot, '.agents', 'memory'),
    path.join(sourceRoot, 'ws-shared', 'memory')
  ];

  // Candidate directories for plans
  const planDirCandidates = [
    path.join(sourceRoot, '.agents', 'plans'),
    path.join(sourceRoot, 'plans')
  ];

  // Candidate changelog files
  const changelogCandidates = [
    path.join(sourceRoot, 'CHANGELOG.md'),
    path.join(sourceRoot, '.agents', 'CHANGELOG.md'),
    path.join(sourceRoot, 'ws-shared', 'CHANGELOG.md')
  ];

  // 1. Import Specs
  for (const specsDir of specDirCandidates) {
    if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
      const files = fs.readdirSync(specsDir);
      for (const file of files) {
        if (file.endsWith('.spec.md') || (file.endsWith('.md') && !file.toLowerCase().includes('index.prd'))) {
          const filePath = path.join(specsDir, file);
          const rawContent = readFileSafe(filePath);
          if (!rawContent) continue;

          try {
            const parsed = matter(rawContent);
            const rawSlug =
              (parsed.data.slug as string) ||
              (parsed.data.id as string) ||
              file.replace(/\.spec\.md$/, '').replace(/\.md$/, '');
            const slug = slugify(rawSlug);
            const title =
              (parsed.data.title as string) ||
              extractTitleFromMarkdown(parsed.content) ||
              slug;

            const { status } = normalizeRecordStatus(parsed.data.status);

            const res = await upsertRecord({
              cwd: sourceRoot,
              projectId,
              vaultRoot,
              kind: 'spec',
              slug,
              frontmatter: {
                ...parsed.data,
                id: slug,
                title,
                status,
                source: 'imported'
              },
              body: parsed.content || rawContent,
              source: 'imported'
            });

            importedSpecsCount++;
            importedRecords.push({
              id: res.id,
              kind: 'spec',
              slug,
              sourcePath: filePath,
              vaultPath: res.path
            });
          } catch {
            skippedFilesCount++;
            skippedPaths.push(filePath);
          }
        }
      }
    }
  }

  // 2. Import Memory (Traps and Decisions)
  for (const memDir of memoryDirCandidates) {
    if (fs.existsSync(memDir) && fs.statSync(memDir).isDirectory()) {
      const files = fs.readdirSync(memDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;

        // Skip compiled MEMORY.md
        if (file.toLowerCase() === 'memory.md') {
          skippedFilesCount++;
          skippedPaths.push(path.join(memDir, file));
          continue;
        }

        const filePath = path.join(memDir, file);
        const rawContent = readFileSafe(filePath);
        if (!rawContent) continue;

        try {
          const parsed = matter(rawContent);
          const rawSlug =
            (parsed.data.slug as string) ||
            (parsed.data.id as string) ||
            file.replace(/\.md$/, '');
          const slug = slugify(rawSlug);
          const isDecision =
            parsed.data.kind === 'decision' ||
            slug.startsWith('adr-') ||
            slug.startsWith('decision-') ||
            /^[#\s]*(?:ADR|Architecture Decision)/i.test(parsed.content);

          const kind: RecordKind = isDecision ? 'decision' : 'trap';
          const title =
            (parsed.data.title as string) ||
            extractTitleFromMarkdown(parsed.content) ||
            slug;

          const { status, decisionStatus } = normalizeRecordStatus(parsed.data.status);
          const extraFm: Record<string, unknown> = {};
          if (decisionStatus) {
            extraFm.decisionStatus = decisionStatus;
          }

          const res = await upsertRecord({
            cwd: sourceRoot,
            projectId,
            vaultRoot,
            kind,
            slug,
            frontmatter: {
              ...parsed.data,
              ...extraFm,
              id: slug,
              title,
              status,
              source: 'imported'
            },
            body: parsed.content || rawContent,
            source: 'imported'
          });

          if (kind === 'decision') {
            importedDecisionsCount++;
          } else {
            importedTrapsCount++;
          }

          importedRecords.push({
            id: res.id,
            kind,
            slug,
            sourcePath: filePath,
            vaultPath: res.path
          });
        } catch {
          skippedFilesCount++;
          skippedPaths.push(filePath);
        }
      }
    }
  }

  // 3. Import Plans & State
  for (const plansDir of planDirCandidates) {
    if (fs.existsSync(plansDir) && fs.statSync(plansDir).isDirectory()) {
      const entries = fs.readdirSync(plansDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const planFolder = path.join(plansDir, entry.name);
          const slug = slugify(entry.name);
          const subFiles = fs.readdirSync(planFolder);

          // Find primary plan file
          const planFile =
            subFiles.find((f) => f.toLowerCase() === 'plan.md') ||
            subFiles.find((f) => f.toLowerCase() === 'implementation_plan.md') ||
            subFiles.find((f) => f.endsWith('.md') && !f.startsWith('.') && !f.toLowerCase().includes('state') && !f.toLowerCase().includes('log'));

          if (planFile) {
            const planFilePath = path.join(planFolder, planFile);
            const content = readFileSafe(planFilePath);
            if (content) {
              try {
                const parsed = matter(content);
                const title = (parsed.data.title as string) || extractTitleFromMarkdown(parsed.content) || `Plan: ${slug}`;
                const res = await upsertRecord({
                  cwd: sourceRoot,
                  projectId,
                  vaultRoot,
                  kind: 'plan',
                  slug,
                  frontmatter: {
                    ...parsed.data,
                    id: slug,
                    title,
                    status: normalizeRecordStatus(parsed.data.status).status,
                    source: 'imported'
                  },
                  body: parsed.content || content,
                  source: 'imported'
                });

                importedPlansCount++;
                importedRecords.push({
                  id: res.id,
                  kind: 'plan',
                  slug,
                  sourcePath: planFilePath,
                  vaultPath: res.path
                });
              } catch {
                skippedFilesCount++;
                skippedPaths.push(planFilePath);
              }
            }
          }

          // Check for state files
          const stateFile = subFiles.find(
            (f) =>
              f.toLowerCase() === '.state.md' ||
              f.toLowerCase() === 'state.md' ||
              f.toLowerCase() === 'run.json' ||
              f.toLowerCase() === 'state.json'
          );

          if (stateFile) {
            const stateFilePath = path.join(planFolder, stateFile);
            const stateContent = readFileSafe(stateFilePath);
            if (stateContent) {
              try {
                const stateSlug = `${slug}-state`;
                const res = await upsertRecord({
                  cwd: sourceRoot,
                  projectId,
                  vaultRoot,
                  kind: 'state',
                  slug: stateSlug,
                  frontmatter: {
                    id: stateSlug,
                    title: `State: ${slug}`,
                    relatedSlug: slug,
                    status: 'active',
                    source: 'imported'
                  },
                  body: stateContent,
                  source: 'imported'
                });

                importedStateCount++;
                importedRecords.push({
                  id: res.id,
                  kind: 'state',
                  slug: stateSlug,
                  sourcePath: stateFilePath,
                  vaultPath: res.path
                });
              } catch {
                skippedFilesCount++;
                skippedPaths.push(stateFilePath);
              }
            }
          }

          // Track skipped telemetry or temp files
          for (const sub of subFiles) {
            const lower = sub.toLowerCase();
            if (
              lower.endsWith('.jsonl') ||
              lower.endsWith('.tmp') ||
              lower.includes('telemetry') ||
              lower.startsWith('audit-') ||
              lower === '.runtime'
            ) {
              skippedFilesCount++;
              skippedPaths.push(path.join(planFolder, sub));
            }
          }
        }
      }
    }
  }

  // 4. Import Changelog / Logs
  for (const changelogFile of changelogCandidates) {
    if (fs.existsSync(changelogFile) && fs.statSync(changelogFile).isFile()) {
      const content = readFileSafe(changelogFile);
      if (content) {
        // Split by markdown headings: ## [Date] or ## [Slug]
        const rawSections = content.split(/^##\s+/m);
        const logSections = content.trim().startsWith('##')
          ? rawSections.filter((s) => s.trim().length > 0)
          : rawSections.slice(1).filter((s) => s.trim().length > 0);

        for (let i = 0; i < logSections.length; i++) {
          const sec = logSections[i].trim();
          if (!sec) continue;

          const firstLine = sec.split('\n')[0].trim();
          const logSlug = `log-${slugify(firstLine.slice(0, 30))}-${i + 1}`;

          try {
            const res = await upsertRecord({
              cwd: sourceRoot,
              projectId,
              vaultRoot,
              kind: 'log',
              slug: logSlug,
              frontmatter: {
                id: logSlug,
                title: firstLine,
                status: 'active',
                source: 'imported'
              },
              body: `## ${sec}`,
              source: 'imported'
            });

            importedLogsCount++;
            importedRecords.push({
              id: res.id,
              kind: 'log',
              slug: logSlug,
              sourcePath: changelogFile,
              vaultPath: res.path
            });
          } catch {
            // Ignore individual log parse failure
          }
        }
      }
    }
  }

  // Update compiled views and SQLite FTS index
  rebuildCompiledViews(projectId, vaultRoot);
  await rebuildIndex(vaultRoot);

  const totalImported = importedRecords.length;

  return {
    projectId,
    vaultRoot,
    importedSpecsCount,
    importedTrapsCount,
    importedDecisionsCount,
    importedPlansCount,
    importedLogsCount,
    importedStateCount,
    skippedFilesCount,
    totalImported,
    records: importedRecords,
    skippedPaths
  };
}
