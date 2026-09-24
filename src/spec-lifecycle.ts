import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SpecLifecycleWarning {
  slug: string;
  reason: string;
}

function frontmatterBlock(text: string): string {
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end < 0) return '';
  return text.slice(3, end);
}

function normSlug(s: string): string {
  return s.replace(/^\d{4}-/, '').toLowerCase();
}

/**
 * Generic lifecycle scan (AC25): warn when a shipped Done-log slug still looks
 * todo/open/draft, unless a machine-readable exception applies. Exceptions:
 * - index Archive row marks the slug wont-implement/deferred with an explicit
 *   exception token, or
 * - the spec frontmatter sets lifecycleException: true (or lifecycle: exception).
 * No hard-coded feature names.
 */
function archiveExceptionSlugs(indexText: string): Set<string> {
  const out = new Set<string>();
  const lines = indexText.split(/\r?\n/);
  let inArchive = false;
  for (const line of lines) {
    if (/^##\s+Archive/i.test(line)) { inArchive = true; continue; }
    if (inArchive && /^##\s+/.test(line)) break;
    if (!inArchive) continue;
    if (!line.includes('|')) continue;
    if (/wont-implement|will not implement|deferred|exception/i.test(line)) {
      const m = line.match(/([a-z0-9]+(?:-[a-z0-9]+)+)/gi);
      if (m) for (const s of m) {
        out.add(s.toLowerCase());
        out.add(normSlug(s));
      }
    }
  }
  return out;
}

function frontmatterException(raw: string): boolean {
  const fm = frontmatterBlock(raw);
  if (/(?:^|\n)\s*lifecycleException:\s*true/i.test(fm)) return true;
  if (/(?:^|\n)\s*lifecycle:\s*exception/i.test(fm)) return true;
  if (/(?:^|\n)\s*exception:\s*true/i.test(fm)) return true;
  return false;
}

export function scanSpecLifecycleDrift(productRoot: string): SpecLifecycleWarning[] {
  const indexPath = path.join(productRoot, '.agents', 'specs', 'index.PRD');
  if (!fs.existsSync(indexPath)) return [];
  const indexText = fs.readFileSync(indexPath, 'utf8');
  const warnings: SpecLifecycleWarning[] = [];
  const exceptions = archiveExceptionSlugs(indexText);

  const doneSlugs = new Set<string>();
  for (const line of indexText.split(/\r?\n/)) {
    const tableDone = line.match(/\|\s*\d+\s*\|\s*`?\[?`?([a-z0-9-]+)`?\]?/);
    if (line.includes('[x]') && tableDone) {
      doneSlugs.add(tableDone[1].replace(/[\[\]]/g, '').toLowerCase());
    }
    const specFile = line.match(/(\d{4}-[a-z0-9-]+)\.spec\.md/);
    if (line.includes('[x]') && specFile) {
      doneSlugs.add(specFile[1].toLowerCase());
      doneSlugs.add(normSlug(specFile[1]));
    }
  }

  // Done-log shipped slugs (generic table parse, no feature names).
  const shippedSlugs = new Set<string>();
  const doneLogIdx = indexText.search(/##\s+10\.\s*Done log/i);
  if (doneLogIdx >= 0) {
    const tail = indexText.slice(doneLogIdx).split(/\r?\n/);
    for (const line of tail) {
      if (/^##\s+/.test(line) && !/Done log/i.test(line)) break;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length >= 4 && cells[2] && /[a-z0-9-]/i.test(cells[2])) {
        const slugCell = cells[2].replace(/[`\[\]]/g, '').toLowerCase();
        if (slugCell && !/slug/i.test(slugCell) && !/^-+$/.test(slugCell)) {
          shippedSlugs.add(slugCell);
          shippedSlugs.add(normSlug(slugCell));
        }
      }
    }
  }

  const specsDir = path.join(productRoot, '.agents', 'specs');
  if (fs.existsSync(specsDir)) {
    for (const file of fs.readdirSync(specsDir)) {
      if (!file.endsWith('.spec.md')) continue;
      const slug = file.replace(/\.spec\.md$/, '');
      const key = slug.toLowerCase();
      const base = normSlug(slug);
      if (exceptions.has(key) || exceptions.has(base)) continue;
      const raw = fs.readFileSync(path.join(specsDir, file), 'utf8');
      if (frontmatterException(raw)) continue;
      const fm = frontmatterBlock(raw);
      const status = /(?:^|\n)status:\s*(\S+)/.exec(fm)?.[1];
      const issueState = /(?:^|\n)issueState:\s*(\S+)/.exec(fm)?.[1];
      const markedDone =
        doneSlugs.has(key) ||
        doneSlugs.has(base) ||
        new RegExp(`\\[x\\].*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(indexText);
      if (!markedDone) continue;
      if (status === 'draft') {
        warnings.push({ slug, reason: `shipped spec still has status: draft` });
      }
      if (issueState === 'open') {
        warnings.push({ slug, reason: `shipped spec still has issueState: open` });
      }
    }
  }

  // Generic shipped-but-todo check: any Done-log slug whose Next-specs row is
  // still `[ ]` todo and has no exception → warn (covers AC25 without naming).
  const nextStart = indexText.search(/##\s+8\.\s*Next specs/i);
  if (nextStart >= 0) {
    const tail = indexText.slice(nextStart).split(/\r?\n/);
    for (const line of tail) {
      if (/^##\s+/.test(line) && !/Next specs/i.test(line)) break;
      if (!line.includes('|') || !/\[\s\]/.test(line)) continue;
      const m = line.match(/\|\s*\d+\s*\|\s*`?\[?`?([a-z0-9-]+)`?\]?/i)
        || line.match(/([a-z0-9]+(?:-[a-z0-9]+)+)\.spec\.md/i);
      if (!m) continue;
      const rowSlug = m[1].toLowerCase();
      const base = normSlug(rowSlug);
      if (exceptions.has(rowSlug) || exceptions.has(base)) continue;
      if (shippedSlugs.has(rowSlug) || shippedSlugs.has(base)) {
        warnings.push({
          slug: rowSlug,
          reason: 'index Next specs still marks slug as todo while the Done log shows it shipped'
        });
      }
    }
  }

  return warnings;
}
