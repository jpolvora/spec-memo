import * as fs from 'node:fs';
import { MemoRecord, RecordFrontmatter, TrapLayer } from './types.js';
import { parseRecord } from './schema.js';

export const TRAP_LAYERS: readonly TrapLayer[] = [
  'application',
  'domain',
  'web',
  'infrastructure',
  'tests',
  'devops',
  'other'
];

const LAYER_ALIASES: Record<string, TrapLayer> = {
  application: 'application',
  domain: 'domain',
  web: 'web',
  infrastructure: 'infrastructure',
  tests: 'tests',
  devops: 'devops',
  other: 'other',
  front: 'web',
  frontend: 'web',
  back: 'application',
  backend: 'application',
  infra: 'infrastructure',
  na: 'other',
  'n/a': 'other',
  none: 'other'
};

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

export function parseBodyField(body: string, field: string): string | undefined {
  const re = new RegExp(`\\*\\*${field}\\*\\*:\\s*\`?([^\\n\`]+)\`?`, 'i');
  const match = body.match(re);
  return match ? match[1].trim() : undefined;
}

function layerToken(raw: string): string {
  return raw.replace(/`/g, '').split('/')[0].trim().toLowerCase();
}

export function isSecurityLabel(raw: string): boolean {
  const token = layerToken(raw);
  return token === 'security' || token === 'segurança' || token === 'seguranca';
}

export function aliasLayer(raw: string): TrapLayer | undefined {
  return LAYER_ALIASES[layerToken(raw)];
}

export function occurrenceOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const value = Number(fm.occurrences);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

export function lastSeenOf(fm: RecordFrontmatter | Record<string, unknown>): string {
  const lastSeen = fm.lastSeen;
  if (typeof lastSeen === 'string' && lastSeen) return lastSeen;
  const updated = fm.updated;
  if (typeof updated === 'string' && updated) return updated;
  return typeof fm.created === 'string' ? fm.created : '';
}

/** Retrieval hit count; missing ranks as 0 (orthogonal to occurrences). */
export function hitCountOf(fm: RecordFrontmatter | Record<string, unknown>): number {
  const value = Number(fm.hits);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function lastHitOf(fm: RecordFrontmatter | Record<string, unknown>): string | undefined {
  const lastHit = fm.lastHit;
  if (typeof lastHit === 'string' && lastHit) return lastHit;
  return undefined;
}

export function compareHitsSearch(
  a: { hits?: number; lastHit?: string | null; updated?: string; id: string },
  b: { hits?: number; lastHit?: string | null; updated?: string; id: string }
): number {
  const hitsDiff = (b.hits ?? 0) - (a.hits ?? 0);
  if (hitsDiff !== 0) return hitsDiff;
  const lastCmp = String(b.lastHit || '').localeCompare(String(a.lastHit || ''));
  if (lastCmp !== 0) return lastCmp;
  const upd = String(b.updated || '').localeCompare(String(a.updated || ''));
  if (upd !== 0) return upd;
  return String(a.id).localeCompare(String(b.id));
}

export function compareTrapRank(a: MemoRecord, b: MemoRecord): number {
  const occ = occurrenceOf(b.frontmatter) - occurrenceOf(a.frontmatter);
  if (occ !== 0) return occ;
  const seen = lastSeenOf(b.frontmatter).localeCompare(lastSeenOf(a.frontmatter));
  if (seen !== 0) return seen;
  const sev =
    (SEVERITY_WEIGHT[String(b.frontmatter.severity || 'medium')] || 0) -
    (SEVERITY_WEIGHT[String(a.frontmatter.severity || 'medium')] || 0);
  if (sev !== 0) return sev;
  return String(a.frontmatter.id).localeCompare(String(b.frontmatter.id));
}

export function applyTrapClassification(
  frontmatter: Partial<RecordFrontmatter>,
  body: string
): { layer?: string; module?: string; tags?: string[] } {
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
  const fmLayer = typeof frontmatter.layer === 'string' ? frontmatter.layer : undefined;
  const bodyLayer = parseBodyField(body, 'Layer');

  let layer: string | undefined;
  if (fmLayer && isSecurityLabel(fmLayer)) {
    if (!tags.includes('security')) tags.push('security');
    layer = (bodyLayer && aliasLayer(bodyLayer)) || 'other';
  } else if (fmLayer && aliasLayer(fmLayer)) {
    layer = aliasLayer(fmLayer);
  } else if (fmLayer) {
    layer = fmLayer;
  } else if (bodyLayer && isSecurityLabel(bodyLayer)) {
    if (!tags.includes('security')) tags.push('security');
    layer = 'other';
  } else if (bodyLayer && aliasLayer(bodyLayer)) {
    layer = aliasLayer(bodyLayer);
  } else {
    layer = 'other';
  }

  const moduleRaw =
    typeof frontmatter.module === 'string' && frontmatter.module.trim()
      ? frontmatter.module.trim()
      : parseBodyField(body, 'Module');

  return {
    layer,
    module: moduleRaw || undefined,
    tags: tags.length > 0 ? tags : undefined
  };
}

export function extractRule(body: string, label: string): string {
  const bullet = body.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, 'i'));
  if (bullet) return bullet[1].trim();
  const heading = body.match(new RegExp(`##\\s+${label}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i'));
  if (heading) return heading[1].trim();
  return '';
}

export function formatAsSkill(records: MemoRecord[]): string {
  const groups = new Map<string, MemoRecord[]>();
  for (const record of records) {
    const classified = applyTrapClassification(record.frontmatter, record.body);
    const layer = String(classified.layer || 'other');
    const list = groups.get(layer) || [];
    list.push(record);
    groups.set(layer, list);
  }

  let md = `# Recurring traps

<!-- Generated by spec-memo promote (skill format) -->

Load this skill before coding in the owner project. Follow each DO NOT / INSTEAD DO so repeated traps do not recur.

`;

  for (const [layer, traps] of groups) {
    md += `## ${layer}\n\n`;
    for (const trap of traps) {
      const title = trap.frontmatter.title || trap.frontmatter.id;
      const occurrences = occurrenceOf(trap.frontmatter);
      const doNot = extractRule(trap.body, 'DO NOT') || '(not specified)';
      const instead = extractRule(trap.body, 'INSTEAD DO') || '(not specified)';
      md += `### ${title}\n\n`;
      md += `- **occurrences:** ${occurrences}\n`;
      md += `- **DO NOT:** ${doNot}\n`;
      md += `- **INSTEAD DO:** ${instead}\n\n`;
    }
  }

  return md;
}

export function rankActiveTraps(
  records: MemoRecord[],
  options: { layer?: string; limit?: number } = {}
): MemoRecord[] {
  let traps = records.filter(
    (record) => record.frontmatter.kind === 'trap' && record.frontmatter.status === 'active'
  );
  if (options.layer) {
    const normalized = aliasLayer(options.layer) ?? options.layer;
    traps = traps.filter((record) => {
      const classified = applyTrapClassification(record.frontmatter, record.body);
      const trapLayer = record.frontmatter.layer || classified.layer;
      return trapLayer === normalized;
    });
  }
  traps.sort(compareTrapRank);
  const limit = options.limit && options.limit > 0 ? options.limit : 10;
  return traps.slice(0, limit);
}

export function enrichHitFromFile(filepath: string): {
  occurrences: number;
  lastSeen?: string;
  layer?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
} {
  try {
    if (!filepath || !fs.existsSync(filepath)) {
      return { occurrences: 1 };
    }
    const record = parseRecord(fs.readFileSync(filepath, 'utf8'), filepath);
    const classified = applyTrapClassification(record.frontmatter, record.body);
    return {
      occurrences: occurrenceOf(record.frontmatter),
      lastSeen: lastSeenOf(record.frontmatter),
      layer: (record.frontmatter.layer || classified.layer) as TrapLayer | undefined,
      severity: record.frontmatter.severity
    };
  } catch {
    return { occurrences: 1 };
  }
}

export function compareSearchHits(
  a: {
    occurrences?: number;
    lastSeen?: string;
    severity?: string;
    updated?: string;
    id: string;
  },
  b: {
    occurrences?: number;
    lastSeen?: string;
    severity?: string;
    updated?: string;
    id: string;
  }
): number {
  const occ = (b.occurrences || 1) - (a.occurrences || 1);
  if (occ !== 0) return occ;
  const seenA = a.lastSeen || a.updated || '';
  const seenB = b.lastSeen || b.updated || '';
  const seen = seenB.localeCompare(seenA);
  if (seen !== 0) return seen;
  const sev =
    (SEVERITY_WEIGHT[b.severity || 'medium'] || 0) - (SEVERITY_WEIGHT[a.severity || 'medium'] || 0);
  if (sev !== 0) return sev;
  return a.id.localeCompare(b.id);
}
