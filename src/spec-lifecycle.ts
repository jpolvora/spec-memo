import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SpecLifecycleWarning {
  slug: string;
  reason: string;
}

const DEFERRED_TODO_SLUGS = new Set(['virtual-file-system-over-mcp', '0027-virtual-file-system-over-mcp']);

function frontmatterBlock(text: string): string {
  if (!text.startsWith('---')) return '';
  const end = text.indexOf('\n---', 3);
  if (end < 0) return '';
  return text.slice(3, end);
}

/**
 * Flag shipped Done-log / [x] index rows that still carry draft or issueState: open.
 * `virtual-file-system-over-mcp` is an explicit exception (genuinely unscheduled).
 */
export function scanSpecLifecycleDrift(productRoot: string): SpecLifecycleWarning[] {
  const indexPath = path.join(productRoot, '.agents', 'specs', 'index.PRD');
  if (!fs.existsSync(indexPath)) return [];
  const indexText = fs.readFileSync(indexPath, 'utf8');
  const warnings: SpecLifecycleWarning[] = [];

  const doneSlugs = new Set<string>();
  for (const line of indexText.split(/\r?\n/)) {
    const doneLink = line.match(/\[x\].*?`?([a-z0-9-]+)`?.*?\.spec\.md/i);
    const tableDone = line.match(/\|\s*\d+\s*\|\s*`?\[?`?([a-z0-9-]+)`?\]?/);
    if (line.includes('[x]') && tableDone) {
      doneSlugs.add(tableDone[1].replace(/[\[\]]/g, ''));
    }
    const specFile = line.match(/(\d{4}-[a-z0-9-]+)\.spec\.md/);
    if (line.includes('[x]') && specFile) {
      doneSlugs.add(specFile[1].replace(/^\d{4}-/, ''));
      doneSlugs.add(specFile[1]);
    }
    void doneLink;
  }

  const specsDir = path.join(productRoot, '.agents', 'specs');
  if (!fs.existsSync(specsDir)) return warnings;
  for (const file of fs.readdirSync(specsDir)) {
    if (!file.endsWith('.spec.md')) continue;
    const slug = file.replace(/\.spec\.md$/, '');
    if (DEFERRED_TODO_SLUGS.has(slug) || DEFERRED_TODO_SLUGS.has(slug.replace(/^\d{4}-/, ''))) {
      continue;
    }
    const raw = fs.readFileSync(path.join(specsDir, file), 'utf8');
    const fm = frontmatterBlock(raw);
    const status = /(?:^|\n)status:\s*(\S+)/.exec(fm)?.[1];
    const issueState = /(?:^|\n)issueState:\s*(\S+)/.exec(fm)?.[1];
    const markedDone =
      doneSlugs.has(slug) ||
      doneSlugs.has(slug.replace(/^\d{4}-/, '')) ||
      new RegExp(`\\[x\\].*${slug.replace(/^\d{4}-/, '')}`).test(indexText);
    if (!markedDone) continue;
    if (status === 'draft') {
      warnings.push({ slug, reason: `shipped spec still has status: draft` });
    }
    if (issueState === 'open') {
      warnings.push({ slug, reason: `shipped spec still has issueState: open` });
    }
  }

  if (/\[\s\][^\n]*status-ai-ops-logs/.test(indexText) && /AI Ops/.test(indexText)) {
    warnings.push({
      slug: 'status-ai-ops-logs',
      reason: 'index Next specs still marks status-ai-ops-logs as todo while the feature is shipped'
    });
  }

  return warnings;
}
