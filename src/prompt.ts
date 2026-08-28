import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  ActivityReportResult,
  DerivedRuleCandidate,
  DeriveRulesResult,
  ExportStoryResult,
  MemoRecord,
  PaginatedResult,
  PromptOptions,
  PromptRecordResult,
  RecordFrontmatter,
  SessionDeliverable,
  SessionResult
} from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultProjects, getVaultRoot, withVaultLock, withVaultLockSync } from './vault.js';
import { getRecord, listProjectRecords, upsertRecord } from './store.js';
import { extractRulesFromPrompts, formatDerivedRulesForExport } from './rules-engine.js';
import { assertAllowedIdeRulePromote, assertNotInProductRoot, redactSecretsInPayload } from './safety.js';
import { searchIndex } from './indexer.js';
import { parseRecord } from './schema.js';

export function generatePromptId(sessionId?: string, turn?: number): string {
  if (sessionId && turn != null) {
    return `prompt-${sessionId}-t${turn}`;
  }
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `prompt-${ts}-${rand}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateSessionId(): string {
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `session-${ts}-${rand}`;
}

export async function recordPromptTurn(options: PromptOptions): Promise<PromptRecordResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const cwd = options.cwd || process.cwd();
  let projectId = options.projectId;

  if (!projectId) {
    const identity = resolveProjectIdentity(cwd, { vaultRoot });
    projectId = identity.projectId;
  }

  const rawBody = options.body;
  if (!rawBody || typeof rawBody !== 'string' || !rawBody.trim()) {
    throw new Error("Parameter 'body' must be a non-empty string for prompt record.");
  }
  const body = (redactSecretsInPayload(rawBody) as string).trim();
  const sessionId = options.sessionId;

  // Allocate turn + write under one vault lock so concurrent session turns cannot collide
  // on deterministic ids (`prompt-{sessionId}-t{N}`). withVaultLock is reentrant with upsertRecord.
  return withVaultLock(vaultRoot, async () => {
    let turn = options.turn;
    if (sessionId && turn == null) {
      const existing = listSessionPromptRecords(vaultRoot, projectId!, sessionId);
      const maxTurn = existing.reduce(
        (max, r) => Math.max(max, Number(r.frontmatter.turn) || 0),
        0
      );
      turn = maxTurn + 1;
    }

    const id = options.id || generatePromptId(sessionId, turn);
    const now = new Date().toISOString();

    const fm: Partial<RecordFrontmatter> = {
      id,
      kind: 'prompt',
      project: projectId,
      status: 'active',
      created: now,
      updated: now,
      source: 'agent',
      ide: options.ide || 'generic',
      model: options.model,
      agent: options.agent,
      sessionId: options.sessionId,
      turn: turn,
      taskSlug: options.taskSlug,
      client: options.client,
      billable: options.billable !== undefined ? Boolean(options.billable) : true,
      branch: options.branch,
      gitSha: options.gitSha,
      linkedPaths: options.linkedPaths,
      tags: options.tags
    };

    const res = await upsertRecord({
      kind: 'prompt',
      slug: id,
      frontmatter: fm,
      body: body.trim(),
      cwd,
      vaultRoot,
      projectId
    });

    return {
      id: res.id,
      path: res.path,
      created: now,
      turn: turn,
      sessionId: options.sessionId,
      projectId: projectId!
    };
  });
}

export async function startSessionRecord(options: PromptOptions): Promise<SessionResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const cwd = options.cwd || process.cwd();
  let projectId = options.projectId;

  if (!projectId) {
    const identity = resolveProjectIdentity(cwd, { vaultRoot });
    projectId = identity.projectId;
  }

  const sessionId = options.sessionId || generateSessionId().replace(/^session-/, '');
  const id = options.id || `session-${sessionId}`;

  return withVaultLock(vaultRoot, async () => {
    const existing = await getRecord({ id, kind: 'session', cwd, vaultRoot, projectId });
    if (existing?.frontmatter.status === 'completed') {
      throw new Error(
        `Cannot restart completed session '${sessionId}'. Start a new sessionId.`
      );
    }

    const now = new Date().toISOString();
    const startTime = options.since || now;

    const fm: Partial<RecordFrontmatter> = {
      id,
      kind: 'session',
      project: projectId,
      status: 'active',
      created: existing?.frontmatter.created || now,
      updated: now,
      source: 'agent',
      sessionId,
      startTime,
      taskSlug: options.taskSlug,
      client: options.client,
      billable: options.billable !== undefined ? Boolean(options.billable) : true,
      summary: options.body || `Active session ${sessionId}`
    };

    const body = options.body || `# Session ${sessionId}\n\nTask: ${options.taskSlug || 'unspecified'}\nStarted: ${startTime}`;

    const res = await upsertRecord({
      kind: 'session',
      slug: id,
      frontmatter: fm,
      body,
      cwd,
      vaultRoot,
      projectId
    });

    return {
      id: res.id,
      sessionId,
      projectId,
      status: 'active',
      startTime,
      taskSlug: options.taskSlug,
      client: options.client,
      billable: fm.billable ?? true,
      summary: fm.summary,
      path: res.path
    };
  });
}

export async function endSessionRecord(options: PromptOptions): Promise<SessionResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const cwd = options.cwd || process.cwd();
  let projectId = options.projectId;

  if (!projectId) {
    const identity = resolveProjectIdentity(cwd, { vaultRoot });
    projectId = identity.projectId;
  }

  const sessionId = options.sessionId;
  if (!sessionId) {
    throw new Error("Parameter 'sessionId' is required to end a session.");
  }

  // Merge deliverables under vault lock so concurrent session_end cannot drop entries (TOCTOU).
  return withVaultLock(vaultRoot, async () => {
    const id = options.id || `session-${sessionId}`;
    const existing = await getRecord({
      id,
      kind: 'session',
      cwd,
      vaultRoot,
      projectId
    });

    if (!existing) {
      throw new Error(
        `Cannot end session '${sessionId}': no session record found. Call session_start first.`
      );
    }

    const now = new Date().toISOString();
    const endTime = options.until || now;
    const startTime = (existing.frontmatter.startTime as string) || (existing.frontmatter.created as string) || now;

    // Never reuse PromptOptions.limit (pagination) as duration — compute from timestamps only.
    let durationMinutes: number | undefined;
    if (startTime) {
      const diffMs = new Date(endTime).getTime() - new Date(startTime).getTime();
      durationMinutes = Number.isFinite(diffMs) ? Math.max(0, Math.round(diffMs / 60000)) : 0;
    }

    const existingDeliverables = (existing.frontmatter.deliverables as SessionDeliverable[]) || [];
    const mergedDeliverables = [...existingDeliverables];
    if (options.deliverables && Array.isArray(options.deliverables)) {
      for (const d of options.deliverables) {
        if (!mergedDeliverables.some((ex) => ex.url === d.url && ex.sha === d.sha && ex.type === d.type)) {
          mergedDeliverables.push(d);
        }
      }
    }

    const summary = options.body || (existing.frontmatter.summary as string) || `Completed session ${sessionId}`;

    const fm: Partial<RecordFrontmatter> = {
      ...(existing.frontmatter || {}),
      id,
      kind: 'session',
      project: projectId,
      status: 'completed',
      updated: now,
      sessionId,
      startTime,
      endTime,
      durationMinutes: durationMinutes ?? 0,
      taskSlug: options.taskSlug || (existing.frontmatter.taskSlug as string),
      client: options.client || (existing.frontmatter.client as string),
      billable: options.billable !== undefined ? Boolean(options.billable) : (existing.frontmatter.billable as boolean ?? true),
      deliverables: mergedDeliverables,
      summary
    };

    const body = `# Session ${sessionId} — Completed
- **Status:** Completed
- **Task:** ${fm.taskSlug || 'unspecified'}
- **Start:** ${startTime}
- **End:** ${endTime}
- **Duration:** ${durationMinutes} minutes
- **Billable:** ${fm.billable ? 'Yes' : 'No'}
- **Deliverables:** ${mergedDeliverables.length > 0 ? mergedDeliverables.map((d) => `[${d.type.toUpperCase()}] ${d.title || d.url || d.sha}`).join(', ') : 'None'}

## Summary
${summary}
`;

    const res = await upsertRecord({
      kind: 'session',
      slug: id,
      frontmatter: fm,
      body,
      cwd,
      vaultRoot,
      projectId
    });

    return {
      id: res.id,
      sessionId,
      projectId,
      status: 'completed',
      startTime,
      endTime,
      durationMinutes,
      taskSlug: fm.taskSlug,
      client: fm.client,
      billable: fm.billable ?? true,
      deliverables: mergedDeliverables,
      summary,
      path: res.path
    };
  });
}

function listSessionPromptRecords(vaultRoot: string, projectId: string, sessionId: string): MemoRecord[] {
  const records = listProjectRecords(vaultRoot, projectId);
  return records
    .filter((r) => r.frontmatter.kind === 'prompt' && r.frontmatter.sessionId === sessionId)
    .sort((a, b) => {
      const turnA = Number(a.frontmatter.turn) || 0;
      const turnB = Number(b.frontmatter.turn) || 0;
      if (turnA !== turnB) return turnA - turnB;
      return (a.frontmatter.created || '').localeCompare(b.frontmatter.created || '');
    });
}

export function getSessionTurns(options: {
  sessionId: string;
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
}): MemoRecord[] {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  let projectId = options.projectId;
  if (!projectId) {
    const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
    projectId = identity.projectId;
  }
  return listSessionPromptRecords(vaultRoot, projectId, options.sessionId);
}

export async function exportSessionStory(options: {
  sessionId: string;
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  outputPath?: string;
}): Promise<ExportStoryResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  let projectId = options.projectId;
  if (!projectId) {
    const identity = resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot });
    projectId = identity.projectId;
  }

  const turns = listSessionPromptRecords(vaultRoot, projectId, options.sessionId);
  const sessionRecord = await getRecord({
    id: `session-${options.sessionId}`,
    kind: 'session',
    cwd: options.cwd,
    vaultRoot,
    projectId
  });

  const sessionFm = sessionRecord?.frontmatter;
  const taskSlug = sessionFm?.taskSlug || 'unspecified';
  const client = sessionFm?.client || 'default';
  const startTime = sessionFm?.startTime || (turns[0]?.frontmatter.created) || 'unknown';
  const endTime = sessionFm?.endTime || (turns[turns.length - 1]?.frontmatter.created) || 'in-progress';
  const duration = sessionFm?.durationMinutes ? `${sessionFm.durationMinutes} min` : 'active';
  const deliverables = (sessionFm?.deliverables as SessionDeliverable[]) || [];

  let md = `# Intent & Conversation Story — Session \`${options.sessionId}\`

<!-- AUTO-GENERATED BY spec-memo -->
- **Project:** \`${projectId}\`
- **Task Slug:** \`${taskSlug}\`
- **Client:** \`${client}\`
- **Start Time:** \`${startTime}\` | **End Time:** \`${endTime}\` | **Duration:** \`${duration}\`
- **Total Turns:** \`${turns.length}\`
`;

  if (deliverables.length > 0) {
    md += `\n### Deliverables\n`;
    for (const d of deliverables) {
      md += `- **[${d.type.toUpperCase()}]** ${d.title || ''} ${d.url ? `([Link](${d.url}))` : ''} ${d.sha ? `\`${d.sha}\`` : ''}\n`;
    }
  }

  md += `\n---\n\n## Chronological Turn Log\n\n`;

  if (turns.length === 0) {
    md += `*No prompt turns recorded for session \`${options.sessionId}\`.*\n`;
  } else {
    for (const t of turns) {
      const fm = t.frontmatter;
      const turnNum = fm.turn != null ? fm.turn : '?';
      const ide = (fm.ide || 'generic').toUpperCase();
      const model = fm.model ? ` | **Model:** \`${fm.model}\`` : '';
      const agent = fm.agent ? ` | **Role:** \`${fm.agent}\`` : '';
      const created = fm.created || '';

      md += `### Turn #${turnNum} — \`${ide}\`${model}${agent}\n`;
      md += `*Timestamp: ${created}* | *Record ID: \`${fm.id}\`*\n\n`;
      md += `${t.body}\n\n---\n\n`;
    }
  }

  let writtenPath: string | undefined = undefined;
  if (options.outputPath) {
    const cwd = options.cwd || process.cwd();
    const resolvedOut = path.resolve(cwd, options.outputPath);
    assertNotInProductRoot(resolvedOut, cwd);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, md, 'utf8');
    writtenPath = resolvedOut;
  }

  return {
    sessionId: options.sessionId,
    projectId,
    turnsCount: turns.length,
    markdown: md,
    outputPath: writtenPath
  };
}

function applyPromptMetadataFilters(allPrompts: MemoRecord[], options: PromptOptions): MemoRecord[] {
  let filtered = allPrompts;
  if (options.ide) {
    const ideLower = options.ide.toLowerCase();
    filtered = filtered.filter((p) => (p.frontmatter.ide as string || '').toLowerCase() === ideLower);
  }
  if (options.model) {
    const modelLower = options.model.toLowerCase();
    filtered = filtered.filter((p) => (p.frontmatter.model as string || '').toLowerCase().includes(modelLower));
  }
  if (options.agent) {
    const agentLower = options.agent.toLowerCase();
    filtered = filtered.filter((p) => (p.frontmatter.agent as string || '').toLowerCase().includes(agentLower));
  }
  if (options.sessionId) {
    filtered = filtered.filter((p) => p.frontmatter.sessionId === options.sessionId);
  }
  if (options.taskSlug) {
    filtered = filtered.filter((p) => p.frontmatter.taskSlug === options.taskSlug);
  }
  if (options.client) {
    filtered = filtered.filter((p) => p.frontmatter.client === options.client);
  }
  if (options.billable !== undefined) {
    filtered = filtered.filter((p) => Boolean(p.frontmatter.billable) === Boolean(options.billable));
  }
  if (options.since) {
    const sinceTime = new Date(options.since).getTime();
    filtered = filtered.filter((p) => new Date(p.frontmatter.created).getTime() >= sinceTime);
  }
  if (options.until) {
    const untilTime = new Date(options.until).getTime();
    filtered = filtered.filter((p) => new Date(p.frontmatter.created).getTime() <= untilTime);
  }
  if (options.tags && options.tags.length > 0) {
    filtered = filtered.filter((p) => {
      const tags = (p.frontmatter.tags as string[]) || [];
      return options.tags!.every((t) => tags.includes(t));
    });
  }
  return filtered;
}

function paginatePrompts(
  allPrompts: MemoRecord[],
  options: PromptOptions,
  sortMode: 'date' | 'fts' = 'date'
): PaginatedResult<MemoRecord> {
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const offset = Math.max(0, options.offset || 0);
  let sorted = allPrompts;

  if (sortMode === 'date') {
    const sortOrder = options.sort || 'date-desc';
    if (sortOrder === 'date-asc') {
      sorted = [...allPrompts].sort((a, b) => (a.frontmatter.created || '').localeCompare(b.frontmatter.created || ''));
    } else {
      sorted = [...allPrompts].sort((a, b) => (b.frontmatter.created || '').localeCompare(a.frontmatter.created || ''));
    }
  }

  const total = sorted.length;
  const items = sorted.slice(offset, offset + limit);
  return {
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
    items
  };
}

/** Metadata-filter list (no FTS). Prefer searchPrompts when a query is present. */
export function listPrompts(options: PromptOptions): PaginatedResult<MemoRecord> {
  const vaultRoot = getVaultRoot(options.vaultRoot);

  const projectIds = options.crossProject
    ? getVaultProjects(vaultRoot).map((p) => p.id)
    : options.projectId
      ? [options.projectId]
      : [resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot }).projectId];

  let allPrompts: MemoRecord[] = [];
  for (const pid of projectIds) {
    const records = listProjectRecords(vaultRoot, pid);
    const prompts = records.filter((r) => r.frontmatter.kind === 'prompt');
    allPrompts.push(...prompts);
  }

  allPrompts = applyPromptMetadataFilters(allPrompts, options);
  return paginatePrompts(allPrompts, options, 'date');
}

/**
 * FTS5 search over prompt records (AC21/AC22/AC28).
 * FTS-only for the search path — no substring fallback (interview Q2).
 */
export function searchPrompts(options: PromptOptions): PaginatedResult<MemoRecord> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const rawQuery = (options.query || '').trim();
  if (!rawQuery) {
    return paginatePrompts([], options, 'fts');
  }

  const hits = searchIndex({
    query: rawQuery,
    kinds: ['prompt'],
    status: 'active',
    projectId: options.crossProject ? undefined : options.projectId,
    crossProject: options.crossProject,
    cwd: options.cwd,
    vaultRoot,
    tags: options.tags,
    limit: 2000,
    sort: options.sort === 'relevance' ? 'relevance' : 'updated'
  });

  const records: MemoRecord[] = [];
  for (const hit of hits) {
    try {
      if (!hit.filepath || !fs.existsSync(hit.filepath)) continue;
      const record = parseRecord(fs.readFileSync(hit.filepath, 'utf8'), hit.filepath);
      if (record.frontmatter.kind === 'prompt') {
        records.push(record);
      }
    } catch {
      // Skip unreadable / corrupt hits
    }
  }

  const filtered = applyPromptMetadataFilters(records, options);
  // Preserve FTS hit order (relevance/updated from indexer)
  return paginatePrompts(filtered, options, 'fts');
}

export function listSessions(options: PromptOptions): PaginatedResult<MemoRecord> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const offset = Math.max(0, options.offset || 0);

  const projectIds = options.crossProject
    ? getVaultProjects(vaultRoot).map((p) => p.id)
    : options.projectId
      ? [options.projectId]
      : [resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot }).projectId];

  let allSessions: MemoRecord[] = [];
  for (const pid of projectIds) {
    const records = listProjectRecords(vaultRoot, pid);
    const sessions = records.filter((r) => r.frontmatter.kind === 'session');
    allSessions.push(...sessions);
  }

  if (options.client) {
    allSessions = allSessions.filter((s) => s.frontmatter.client === options.client);
  }
  if (options.taskSlug) {
    allSessions = allSessions.filter((s) => s.frontmatter.taskSlug === options.taskSlug);
  }
  if (options.since) {
    const sinceTime = new Date(options.since).getTime();
    allSessions = allSessions.filter((s) => new Date(s.frontmatter.startTime as string || s.frontmatter.created).getTime() >= sinceTime);
  }
  if (options.until) {
    const untilTime = new Date(options.until).getTime();
    allSessions = allSessions.filter((s) => new Date(s.frontmatter.startTime as string || s.frontmatter.created).getTime() <= untilTime);
  }

  allSessions.sort((a, b) => (b.frontmatter.created || '').localeCompare(a.frontmatter.created || ''));

  const total = allSessions.length;
  const items = allSessions.slice(offset, offset + limit);
  const hasMore = offset + limit < total;

  return {
    total,
    limit,
    offset,
    hasMore,
    items
  };
}

export async function deriveRulesFromPrompts(options: {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  sessionId?: string;
  saveTraps?: boolean;
  promote?: string;
  format?: 'cursor' | 'copilot' | 'claude' | 'gemini' | 'markdown';
}): Promise<DeriveRulesResult> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const cwd = options.cwd || process.cwd();
  let projectId = options.projectId;

  if (!projectId) {
    const identity = resolveProjectIdentity(cwd, { vaultRoot });
    projectId = identity.projectId;
  }

  let prompts: MemoRecord[];
  if (options.sessionId) {
    prompts = listSessionPromptRecords(vaultRoot, projectId, options.sessionId);
  } else {
    prompts = listProjectRecords(vaultRoot, projectId).filter((r) => r.frontmatter.kind === 'prompt');
  }

  const rules = extractRulesFromPrompts(prompts);
  const savedTraps: Array<{ id: string; title: string; path: string }> = [];

  if (options.saveTraps) {
    for (const rule of rules) {
      if (rule.confidence >= 0.8) {
        const trapId = `trap-derived-${slugify(rule.ruleTitle).slice(0, 40)}`;
        const res = await upsertRecord({
          kind: 'trap',
          slug: trapId,
          frontmatter: {
            id: trapId,
            title: rule.ruleTitle,
            severity: 'high',
            tags: ['derived-rule', rule.category],
            source: 'agent'
          },
          body: rule.suggestedBody,
          cwd,
          vaultRoot,
          projectId
        });
        savedTraps.push({ id: trapId, title: rule.ruleTitle, path: res.path });
      }
    }
  }

  let promotedPath: string | undefined = undefined;
  if (options.promote) {
    const dest = path.resolve(cwd, options.promote);
    assertAllowedIdeRulePromote(dest, cwd, vaultRoot);
    const formatted = formatDerivedRulesForExport(rules, options.format || 'markdown');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, formatted, 'utf8');
    promotedPath = dest;
  }

  return {
    projectId,
    sessionId: options.sessionId,
    scannedPromptsCount: prompts.length,
    rules,
    savedTraps: savedTraps.length > 0 ? savedTraps : undefined,
    promotedPath
  };
}

export function generateActivityReport(options: {
  cwd?: string;
  projectId?: string;
  vaultRoot?: string;
  since?: string;
  until?: string;
  client?: string;
  crossProject?: boolean;
}): ActivityReportResult {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const projectIds = options.crossProject
    ? getVaultProjects(vaultRoot).map((p) => p.id)
    : options.projectId
      ? [options.projectId]
      : [resolveProjectIdentity(options.cwd || process.cwd(), { vaultRoot }).projectId];

  const sessions: ActivityReportResult['sessions'] = [];
  let totalDurationMinutes = 0;
  let totalPrompts = 0;
  const byClient: Record<string, { totalHours: number; sessionCount: number }> = {};
  const byProject: Record<string, { totalHours: number; sessionCount: number }> = {};

  const sinceTime = options.since ? new Date(options.since).getTime() : 0;
  const untilTime = options.until ? new Date(options.until).getTime() : Number.MAX_SAFE_INTEGER;

  for (const pid of projectIds) {
    const records = listProjectRecords(vaultRoot, pid);
    const sessionRecords = records.filter((r) => r.frontmatter.kind === 'session');
    const promptRecords = records.filter((r) => r.frontmatter.kind === 'prompt');

    for (const pr of promptRecords) {
      const created = new Date(String(pr.frontmatter.created || '')).getTime();
      if (Number.isFinite(created) && (created < sinceTime || created > untilTime)) {
        continue;
      }
      if (options.client) {
        const pc = (pr.frontmatter.client as string) || 'internal';
        if (pc.toLowerCase() !== options.client.toLowerCase()) {
          continue;
        }
      }
      totalPrompts += 1;
    }

    for (const sr of sessionRecords) {
      const fm = sr.frontmatter;
      const client = (fm.client as string) || 'internal';
      if (options.client && client.toLowerCase() !== options.client.toLowerCase()) {
        continue;
      }

      const stStr = (fm.startTime as string) || (fm.created as string);
      const stTime = new Date(stStr).getTime();
      if (stTime < sinceTime || stTime > untilTime) {
        continue;
      }

      const dur = Number(fm.durationMinutes) || 0;
      const billable = fm.billable !== undefined ? Boolean(fm.billable) : true;

      sessions.push({
        id: String(fm.id),
        sessionId: String(fm.sessionId || fm.id),
        projectId: pid,
        client,
        taskSlug: fm.taskSlug as string,
        startTime: stStr,
        endTime: fm.endTime as string,
        durationMinutes: dur,
        billable,
        deliverables: fm.deliverables as SessionDeliverable[],
        summary: fm.summary as string
      });

      if (billable) {
        totalDurationMinutes += dur;
        const hours = Math.round((dur / 60) * 100) / 100;

        if (!byClient[client]) {
          byClient[client] = { totalHours: 0, sessionCount: 0 };
        }
        byClient[client].totalHours = Math.round((byClient[client].totalHours + hours) * 100) / 100;
        byClient[client].sessionCount += 1;

        if (!byProject[pid]) {
          byProject[pid] = { totalHours: 0, sessionCount: 0 };
        }
        byProject[pid].totalHours = Math.round((byProject[pid].totalHours + hours) * 100) / 100;
        byProject[pid].sessionCount += 1;
      }
    }
  }

  sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));

  const totalBillableHours = Math.round((totalDurationMinutes / 60) * 100) / 100;

  return {
    since: options.since,
    until: options.until,
    client: options.client,
    projectId: options.projectId,
    totalDurationMinutes,
    totalBillableHours,
    totalSessions: sessions.length,
    totalPrompts,
    sessions,
    byClient,
    byProject
  };
}
