import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FeedbackOptions,
  FeedbackResult,
  FeedbackType,
  MemoRecord,
  RecordFrontmatter
} from './types.js';
import { serializeRecord, parseRecord } from './schema.js';
import {
  getVaultRoot,
  withVaultLock,
  commitVaultChange,
  RECORD_SUBDIRS,
  getVaultProjects
} from './vault.js';
import { resolveProjectIdentity } from './identity.js';
import { openIndex, indexRecord } from './indexer.js';
import { rebuildCompiledViews } from './compiler.js';
import { helpfulCountOf, staleCountOf } from './salience.js';
import { recordTelemetry } from './telemetry.js';

export const FEEDBACK_TYPES: readonly FeedbackType[] = [
  'helpful',
  'not_helpful',
  'stale',
  'wrong'
];

function scanProjectForRecord(
  vaultRoot: string,
  projectId: string,
  recordId: string
): { record: MemoRecord; filePath: string; projectId: string } | null {
  const projectDir = path.join(vaultRoot, 'projects', projectId);
  if (!fs.existsSync(projectDir)) return null;

  for (const sub of RECORD_SUBDIRS) {
    const direct = path.join(projectDir, sub, `${recordId}.md`);
    if (fs.existsSync(direct)) {
      try {
        const record = parseRecord(fs.readFileSync(direct, 'utf8'), direct);
        return { record, filePath: direct, projectId };
      } catch {
        return null;
      }
    }
  }

  for (const sub of RECORD_SUBDIRS) {
    const dir = path.join(projectDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md') || file.includes('.conflict.')) continue;
      const filePath = path.join(dir, file);
      try {
        const record = parseRecord(fs.readFileSync(filePath, 'utf8'), filePath);
        if (String(record.frontmatter.id) === recordId) {
          return { record, filePath, projectId };
        }
      } catch {
        // skip
      }
    }
  }
  return null;
}

function findRecordFile(
  vaultRoot: string,
  recordId: string,
  primaryProjectId: string,
  hintProjectId?: string
): { record: MemoRecord; filePath: string; projectId: string } | null {
  const matches: Array<{ record: MemoRecord; filePath: string; projectId: string }> = [];
  const seenPaths = new Set<string>();

  const tryCollect = (projectId: string | undefined) => {
    if (!projectId) return;
    const found = scanProjectForRecord(vaultRoot, projectId, recordId);
    if (found && !seenPaths.has(found.filePath)) {
      seenPaths.add(found.filePath);
      matches.push(found);
    }
  };

  tryCollect(hintProjectId);
  tryCollect(primaryProjectId);
  for (const p of getVaultProjects(vaultRoot)) {
    tryCollect(p.id);
  }

  if (matches.length !== 1) return null;
  return matches[0];
}

export async function submitMemoryFeedback(options: FeedbackOptions): Promise<FeedbackResult> {
  const started = performance.now();
  const id = typeof options.id === 'string' ? options.id.trim() : '';
  const feedback = options.feedback;

  if (!id) {
    throw new Error("Parameter 'id' is required for feedback.");
  }
  if (!feedback || !FEEDBACK_TYPES.includes(feedback)) {
    throw new Error(
      `Invalid feedback type '${String(feedback)}'. Allowed: ${FEEDBACK_TYPES.join(', ')}.`
    );
  }

  const vaultRoot = options.vaultRoot || getVaultRoot();
  const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
  const primaryProjectId = options.projectId || identity.projectId;

  return withVaultLock(vaultRoot, async () => {
    const found = findRecordFile(vaultRoot, id, primaryProjectId, options.projectId);
    if (!found) {
      throw new Error(`Record not found: ${id}`);
    }

    const now = new Date().toISOString();
    let helpful = helpfulCountOf(found.record.frontmatter);
    let stale = staleCountOf(found.record.frontmatter);

    if (feedback === 'helpful') {
      helpful += 1;
    } else if (feedback === 'stale' || feedback === 'wrong') {
      stale += 1;
    }

    const nextFm: RecordFrontmatter = {
      ...found.record.frontmatter,
      helpfulCount: helpful,
      staleCount: stale,
      lastFeedback: now
    };

    if (feedback === 'helpful') {
      nextFm.lastHit = now;
    }

    const content = serializeRecord({ frontmatter: nextFm, body: found.record.body });
    fs.writeFileSync(found.filePath, content, 'utf8');

    try {
      const db = openIndex(vaultRoot);
      indexRecord(db, { frontmatter: nextFm, body: found.record.body }, found.filePath);
    } catch {
      // non-blocking FTS
    }

    rebuildCompiledViews(found.projectId, vaultRoot);
    commitVaultChange(`memory-feedback ${feedback}`, vaultRoot, [
      path.join('projects', found.projectId)
    ]);

    recordTelemetry({
      category: 'mcp_tool',
      operation: 'memory_feedback',
      durationMs: performance.now() - started,
      success: true,
      projectId: found.projectId,
      vaultRoot,
      metadata: {
        recordId: id,
        feedback,
        helpfulCount: helpful,
        staleCount: stale,
        comment: options.comment || undefined
      }
    });

    return {
      id,
      feedback,
      helpfulCount: helpful,
      staleCount: stale,
      lastFeedback: now,
      projectId: found.projectId
    };
  });
}
