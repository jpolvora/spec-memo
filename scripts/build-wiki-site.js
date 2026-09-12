#!/usr/bin/env node

/**
 * Build static HTML from the project wiki markdown tree.
 * Sync fs only; no network fetch; no npm markdown libraries.
 */

import fs from 'fs';
import path from 'path';

const SITE_BASE = 'https://jpolvora.github.io/spec-memo';

function normalizeLf(text) {
  return text.replace(/\r\n?/g, '\n');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPathInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep);
}

export function resolveWikiDir(repoRoot) {
  const configPath = path.join(repoRoot, '.agents', 'skills', 'ws-shared', 'config.json');
  let wikiRel = '.agents/specs/wiki';
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.plans?.wikiDir === 'string' && config.plans.wikiDir.trim()) {
        wikiRel = config.plans.wikiDir.trim();
      }
    } catch {
      // fall through to default
    }
  }
  const resolved = path.resolve(repoRoot, wikiRel);
  if (!isPathInside(repoRoot, resolved)) {
    throw new Error(`wikiDir escapes repo root: ${wikiRel}`);
  }
  return resolved;
}

function collectWikiPages(wikiDir) {
  const pages = [];
  const indexPath = path.join(wikiDir, 'index.wiki.md');
  if (!fs.existsSync(indexPath)) {
    return pages;
  }
  if (!isPathInside(wikiDir, indexPath)) {
    return pages;
  }
  pages.push({ sourcePath: indexPath, relKey: 'index.wiki.md', outRel: 'index.html', depth: 1 });

  let domainEntries = [];
  try {
    domainEntries = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch {
    return pages;
  }

  for (const entry of domainEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const domainDir = path.join(wikiDir, entry.name);
    if (!isPathInside(wikiDir, domainDir)) continue;

    let files = [];
    try {
      files = fs.readdirSync(domainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.endsWith('.md')) continue;
      if (file.name === 'sweep.state.json') continue;
      const sourcePath = path.join(domainDir, file.name);
      if (!isPathInside(wikiDir, sourcePath)) continue;
      const relKey = path.posix.join(entry.name, file.name);
      const outRel = path.posix.join(entry.name, file.name.replace(/\.md$/, '.html'));
      pages.push({ sourcePath, relKey, outRel, depth: 2 });
    }
  }

  return pages;
}

function rewriteLink(href, sourceRelKey, wikiDir) {
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(javascript|data):/i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('#')) {
    return trimmed;
  }

  const hashIdx = trimmed.indexOf('#');
  const pathPart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const fragment = hashIdx >= 0 ? trimmed.slice(hashIdx) : '';

  if (!pathPart) {
    return fragment || null;
  }

  let targetMd = pathPart;
  const isRootIndexWiki = /^(?:\.\/)?index\.wiki\.md$/i.test(pathPart);
  if (targetMd.endsWith('index.wiki.md')) {
    targetMd = targetMd.replace(/index\.wiki\.md$/, 'index.html');
  } else if (/\.md$/i.test(targetMd)) {
    targetMd = targetMd.replace(/\.md$/i, '.html');
  } else if (!/\.html$/i.test(targetMd)) {
    return null;
  }

  const sourceDir = sourceRelKey.includes('/')
    ? path.posix.dirname(sourceRelKey)
    : '';
  const joinDir = isRootIndexWiki ? '' : sourceDir;
  const targetRootRel = path.posix.normalize(path.posix.join(joinDir || '.', targetMd));
  if (targetRootRel === '..' || targetRootRel.startsWith('../')) {
    return null;
  }

  const resolvedSource = path.resolve(wikiDir, sourceRelKey.replace(/\//g, path.sep));
  const resolvedTarget = isRootIndexWiki
    ? path.resolve(wikiDir, 'index.html')
    : path.resolve(path.dirname(resolvedSource), targetMd.replace(/\//g, path.sep));
  if (!isPathInside(wikiDir, resolvedTarget)) {
    return null;
  }

  const sourceOutRel = sourceRelKey
    .replace(/index\.wiki\.md$/i, 'index.html')
    .replace(/\.md$/i, '.html');
  const rel = path.posix.relative(path.posix.dirname(sourceOutRel), targetRootRel);
  return (rel || path.posix.basename(targetRootRel)) + fragment;
}

function renderInline(text, sourceRelKey, wikiDir) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const linkMatch = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const label = escapeHtml(linkMatch[1]);
      const rewritten = rewriteLink(linkMatch[2], sourceRelKey, wikiDir);
      if (rewritten) {
        out += `<a href="${escapeHtml(rewritten)}">${label}</a>`;
      } else {
        out += escapeHtml(linkMatch[0]);
      }
      i += linkMatch[0].length;
      continue;
    }

    const codeMatch = text.slice(i).match(/^`([^`]+)`/);
    if (codeMatch) {
      out += `<code>${escapeHtml(codeMatch[1])}</code>`;
      i += codeMatch[0].length;
      continue;
    }

    const strongMatch = text.slice(i).match(/^(\*\*|__)(.+?)\1/);
    if (strongMatch) {
      out += `<strong>${escapeHtml(strongMatch[2])}</strong>`;
      i += strongMatch[0].length;
      continue;
    }

    const emMatch = text.slice(i).match(/^(\*|_)([^*_]+)\1/);
    if (emMatch) {
      out += `<em>${escapeHtml(emMatch[2])}</em>`;
      i += emMatch[0].length;
      continue;
    }

    const nextSpecial = text.slice(i).search(/[\[`*_]/);
    if (nextSpecial === -1) {
      out += escapeHtml(text.slice(i));
      break;
    }
    if (nextSpecial > 0) {
      out += escapeHtml(text.slice(i, i + nextSpecial));
      i += nextSpecial;
      continue;
    }
    out += escapeHtml(text[i]);
    i += 1;
  }
  return out;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function resolvePageHref(targetOutRel, currentOutRel, currentDepth) {
  if (currentDepth === 1) {
    return targetOutRel;
  }
  if (targetOutRel === 'index.html') {
    return '../index.html';
  }
  const currentDir = path.posix.dirname(currentOutRel);
  return path.posix.relative(currentDir, targetOutRel);
}

function collectDomainTopics(pages, wikiDir) {
  const domains = new Map();
  for (const page of pages) {
    if (page.depth === 1) continue;
    const domain = page.relKey.split('/')[0];
    if (!domains.has(domain)) {
      domains.set(domain, []);
    }
    const markdown = fs.readFileSync(page.sourcePath, 'utf8');
    const title = extractTitle(markdown, path.basename(page.relKey, '.md'));
    domains.get(domain).push({
      relKey: page.relKey,
      outRel: page.outRel,
      title,
      domain,
      feature: path.basename(page.relKey, '.md'),
    });
  }
  return domains;
}

function buildTocHtml(headings) {
  const items = headings.map((h, idx) => {
    return `    <li class="wiki-toc-item"><a href="#${escapeHtml(h.id)}"><span class="wiki-toc-number">${idx + 1}</span> <span class="wiki-toc-text">${escapeHtml(h.title)}</span></a></li>`;
  });
  return `<div class="wiki-toc-box" id="toc" role="navigation" aria-label="Table of contents">
  <div class="wiki-toc-header">
    <span class="wiki-toc-title">Contents</span>
    <button type="button" class="wiki-toc-toggle" id="wiki-toc-toggle" aria-expanded="true">[hide]</button>
  </div>
  <ol class="wiki-toc-list" id="wiki-toc-list">
${items.join('\n')}
  </ol>
</div>`;
}

function buildInfoboxHtml(page, title, markdown) {
  const domain = page.relKey.split('/')[0];
  const feature = path.basename(page.relKey, '.md');
  const cleanTitle = title.replace(/\s*\([^)]*\)/, '').trim();

  let specsText = '0001–0053';
  const provenanceMatch = markdown.match(/(?:synthesis of specs?|specs?)\s+([0-9,\s–-]+)/i);
  if (provenanceMatch) {
    specsText = 'Specs ' + provenanceMatch[1].trim().replace(/\.$/, '');
  }

  return `<aside class="wiki-infobox" aria-label="Feature specification details">
  <div class="wiki-infobox-header">
    <div class="wiki-infobox-title">${escapeHtml(cleanTitle)}</div>
    <div class="wiki-infobox-badge-wrap"><span class="wiki-infobox-badge">Domain: ${escapeHtml(domain)}</span></div>
  </div>
  <table class="wiki-infobox-table">
    <tbody>
      <tr>
        <th>Domain</th>
        <td><code>${escapeHtml(domain)}</code></td>
      </tr>
      <tr>
        <th>Feature</th>
        <td><code>${escapeHtml(feature)}</code></td>
      </tr>
      <tr>
        <th>Status</th>
        <td><span class="wiki-status-pill"><span class="wiki-status-dot"></span>Living Synthesis</span></td>
      </tr>
      <tr>
        <th>Contract</th>
        <td>Canonical Spec Wiki</td>
      </tr>
      <tr>
        <th>Provenance</th>
        <td>${escapeHtml(specsText)}</td>
      </tr>
      <tr>
        <th>Framework</th>
        <td>spec-memo</td>
      </tr>
      <tr>
        <th>Manager</th>
        <td><code>ws-wiki</code></td>
      </tr>
    </tbody>
  </table>
</aside>`;
}

function buildIndexInfoboxHtml(allPages) {
  const featurePages = allPages ? allPages.filter((p) => p.depth === 2) : [];
  const domainCount = new Set(featurePages.map((p) => p.relKey.split('/')[0])).size;
  return `<aside class="wiki-infobox" aria-label="Wiki overview">
  <div class="wiki-infobox-header">
    <div class="wiki-infobox-title">spec-memo Wiki</div>
    <div class="wiki-infobox-badge-wrap"><span class="wiki-infobox-badge">Domain Knowledge Base</span></div>
  </div>
  <table class="wiki-infobox-table">
    <tbody>
      <tr>
        <th>Scope</th>
        <td>Living Architecture</td>
      </tr>
      <tr>
        <th>Domains</th>
        <td>${domainCount} Active Domains</td>
      </tr>
      <tr>
        <th>Features</th>
        <td>${featurePages.length} Living Pages</td>
      </tr>
      <tr>
        <th>Contract</th>
        <td><code>*.spec.md</code> of Record</td>
      </tr>
      <tr>
        <th>Harness</th>
        <td>workflow-skills</td>
      </tr>
      <tr>
        <th>Manager</th>
        <td><code>ws-wiki</code></td>
      </tr>
    </tbody>
  </table>
</aside>`;
}

function renderSidebarHtml(domains, currentPage, homeHref, wikiHomeHref) {
  const domainOrder = ['foundation', 'curation', 'interfaces', 'connectivity', 'continuity', 'documentation'];
  const allDomainKeys = [...domains.keys()].sort((a, b) => {
    const idxA = domainOrder.indexOf(a);
    const idxB = domainOrder.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  const domainSections = [];
  for (const domain of allDomainKeys) {
    const topicList = domains.get(domain);
    const topicRows = [];
    for (const topic of topicList) {
      const href = resolvePageHref(topic.outRel, currentPage.outRel, currentPage.depth);
      const isActive = currentPage.outRel === topic.outRel;
      topicRows.push(`        <li class="wiki-nav-item${isActive ? ' active' : ''}">` +
        `<a href="${escapeHtml(href)}" class="wiki-nav-link${isActive ? ' active' : ''}" title="${escapeHtml(topic.title)}">` +
        `<span class="wiki-topic-marker">${isActive ? '▸' : '•'}</span>` +
        `<span class="wiki-nav-text">${escapeHtml(topic.title)}</span></a></li>`);
    }
    domainSections.push(`      <div class="wiki-domain-section" data-domain="${escapeHtml(domain)}">` +
      `\n        <div class="wiki-domain-header"><span class="wiki-domain-name">${escapeHtml(domain.toUpperCase())}</span><span class="wiki-domain-badge">${topicList.length}</span></div>` +
      `\n        <ul class="wiki-domain-topics">\n${topicRows.join('\n')}\n        </ul>\n      </div>`);
  }

  const githubSourceRel = currentPage.relKey === 'index.wiki.md'
    ? '.agents/specs/wiki/index.wiki.md'
    : `.agents/specs/wiki/${currentPage.relKey}`;
  const githubBlobUrl = `https://github.com/jpolvora/spec-memo/blob/master/${githubSourceRel}`;
  const githubHistoryUrl = `https://github.com/jpolvora/spec-memo/commits/master/${githubSourceRel}`;

  return `<aside class="wiki-sidebar" id="wiki-sidebar" aria-label="Wiki navigation">
  <div class="wiki-sidebar-inner">
    <div class="wiki-sidebar-brand-block">
      <a href="${escapeHtml(wikiHomeHref)}" class="wiki-sidebar-brand">
        <div class="wiki-sidebar-logo">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div class="wiki-sidebar-title-group">
          <span class="wiki-sidebar-main-title">SPEC-MEMO</span>
          <span class="wiki-sidebar-sub-title">Living Domain Wiki</span>
        </div>
      </a>
    </div>

    <div class="wiki-sidebar-filter-wrapper">
      <input type="text" id="wiki-filter-topics" class="wiki-filter-input" placeholder="Filter topics..." aria-label="Filter topics in sidebar">
    </div>

    <nav class="wiki-sidebar-sections">
      <div class="wiki-nav-group">
        <div class="wiki-nav-heading">Navigation</div>
        <ul class="wiki-nav-list">
          <li class="wiki-nav-item${currentPage.outRel === 'index.html' ? ' active' : ''}">
            <a href="${escapeHtml(wikiHomeHref)}" class="wiki-nav-link${currentPage.outRel === 'index.html' ? ' active' : ''}">
              <span class="wiki-nav-icon">📖</span><span class="wiki-nav-text">Main page</span>
            </a>
          </li>
          <li class="wiki-nav-item">
            <a href="${escapeHtml(homeHref)}" class="wiki-nav-link">
              <span class="wiki-nav-icon">🏠</span><span class="wiki-nav-text">Project Home</span>
            </a>
          </li>
          <li class="wiki-nav-item">
            <a href="https://github.com/jpolvora/spec-memo" target="_blank" rel="noopener" class="wiki-nav-link">
              <span class="wiki-nav-icon">🐙</span><span class="wiki-nav-text">GitHub Repository</span>
            </a>
          </li>
        </ul>
      </div>

      <div class="wiki-nav-group wiki-topics-group">
        <div class="wiki-nav-heading">Topics by Domain</div>
${domainSections.join('\n')}
      </div>

      <div class="wiki-nav-group">
        <div class="wiki-nav-heading">Tools</div>
        <ul class="wiki-nav-list">
          <li class="wiki-nav-item">
            <a href="${escapeHtml(wikiHomeHref)}" class="wiki-nav-link">
              <span class="wiki-nav-icon">🔗</span><span class="wiki-nav-text">What links here</span>
            </a>
          </li>
          <li class="wiki-nav-item">
            <a href="${escapeHtml(githubBlobUrl)}" target="_blank" rel="noopener" class="wiki-nav-link">
              <span class="wiki-nav-icon">📄</span><span class="wiki-nav-text">View Markdown</span>
            </a>
          </li>
          <li class="wiki-nav-item">
            <a href="${escapeHtml(githubHistoryUrl)}" target="_blank" rel="noopener" class="wiki-nav-link">
              <span class="wiki-nav-icon">⏳</span><span class="wiki-nav-text">Page History</span>
            </a>
          </li>
          <li class="wiki-nav-item">
            <button type="button" onclick="window.print()" class="wiki-nav-link wiki-nav-btn">
              <span class="wiki-nav-icon">🖨️</span><span class="wiki-nav-text">Print / PDF</span>
            </button>
          </li>
        </ul>
      </div>
    </nav>
  </div>
</aside>`;
}

function renderTopbarHtml(homeHref, wikiHomeHref) {
  return `<header class="wiki-topbar">
  <div class="wiki-topbar-left">
    <button type="button" class="wiki-menu-toggle" id="wiki-menu-toggle" aria-label="Toggle navigation menu" title="Toggle navigation">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="3" y1="6" x2="21" y2="6"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="3" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
    <a href="${escapeHtml(wikiHomeHref)}" class="wiki-topbar-brand">
      <span class="wiki-brand-logo-mark">W</span>
      <span class="wiki-brand-name">spec-memo <span class="wiki-brand-tag">Wiki</span></span>
    </a>
  </div>
  <div class="wiki-topbar-center">
    <div class="wiki-search-box">
      <svg class="wiki-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input type="search" id="wiki-search-input" placeholder="Search wiki topics..." aria-label="Search wiki topics">
    </div>
  </div>
  <div class="wiki-topbar-right">
    <a href="${escapeHtml(homeHref)}" class="wiki-topbar-link">Home</a>
    <a href="${escapeHtml(wikiHomeHref)}" class="wiki-topbar-link">Wiki Index</a>
    <a href="https://github.com/jpolvora/spec-memo" target="_blank" rel="noopener" class="wiki-topbar-link">GitHub</a>
    <button type="button" class="wiki-theme-toggle" id="wiki-theme-toggle" aria-label="Toggle dark/light theme" title="Toggle theme">
      <svg class="sun-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      <svg class="moon-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
  </div>
</header>`;
}

function renderTabsHtml(githubBlobUrl, githubHistoryUrl, githubEditUrl) {
  return `<div class="wiki-content-header-tabs">
  <div class="wiki-tabs-left">
    <span class="wiki-tab active">Article</span>
    <a href="https://github.com/jpolvora/spec-memo/tree/master/.agents/specs" target="_blank" rel="noopener" class="wiki-tab">Specifications</a>
  </div>
  <div class="wiki-tabs-right">
    <span class="wiki-tab active">Read</span>
    <a href="${escapeHtml(githubEditUrl)}" target="_blank" rel="noopener" class="wiki-tab" title="Edit this page on GitHub">Edit</a>
    <a href="${escapeHtml(githubHistoryUrl)}" target="_blank" rel="noopener" class="wiki-tab" title="View commit history on GitHub">View history</a>
  </div>
</div>`;
}

function renderMarkdown(markdown, sourceRelKey, wikiDir, page, allPages) {
  const lines = normalizeLf(markdown).split('\n');
  const htmlParts = [];
  const headings = [];
  const usedSlugs = new Map();
  let i = 0;
  let firstH2Index = -1;

  function generateSlug(raw) {
    const slug = slugify(raw);
    const count = usedSlugs.get(slug) || 0;
    usedSlugs.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  }

  const githubSourceRel = (sourceRelKey === 'index.wiki.md' || !sourceRelKey)
    ? '.agents/specs/wiki/index.wiki.md'
    : `.agents/specs/wiki/${sourceRelKey}`;
  const editUrl = `https://github.com/jpolvora/spec-memo/edit/master/${githubSourceRel}`;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const fenceLang = line.slice(3).trim();
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /^```/.test(lines[i])) i += 1;
      const code = escapeHtml(codeLines.join('\n'));
      if (fenceLang) {
        htmlParts.push(`<pre><code class="language-${escapeHtml(fenceLang)}">${code}</code></pre>`);
      } else {
        htmlParts.push(`<pre><code>${code}</code></pre>`);
      }
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];

      if (level === 1) {
        htmlParts.push(`<h1>${renderInline(headingText, sourceRelKey, wikiDir)}</h1>`);
        htmlParts.push(`<div class="wiki-tagline">From spec-memo Wiki, the living architecture &amp; domain knowledge base</div>`);
        if (page && page.depth === 2) {
          htmlParts.push(buildInfoboxHtml(page, headingText, markdown));
        } else if (page && page.depth === 1) {
          htmlParts.push(buildIndexInfoboxHtml(allPages || []));
        }
        i += 1;
        continue;
      }

      const cleanText = headingText
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_]/g, '')
        .trim();
      const slug = generateSlug(cleanText);

      if (level === 2) {
        headings.push({ level: 2, title: cleanText, id: slug });
        if (firstH2Index === -1) {
          firstH2Index = htmlParts.length;
        }
      }

      htmlParts.push(`<h${level} id="${escapeHtml(slug)}">${renderInline(headingText, sourceRelKey, wikiDir)} <span class="wiki-edit-section"><a href="${escapeHtml(editUrl)}" target="_blank" rel="noopener" title="Edit section: ${escapeHtml(cleanText)}">[edit]</a></span></h${level}>`);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ''), sourceRelKey, wikiDir)}</li>`);
        i += 1;
      }
      htmlParts.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ''), sourceRelKey, wikiDir)}</li>`);
        i += 1;
      }
      htmlParts.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^#{1,6}\s/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^```/.test(lines[i])) {
      paraLines.push(lines[i]);
      i += 1;
    }
    htmlParts.push(`<p>${renderInline(paraLines.join(' '), sourceRelKey, wikiDir)}</p>`);
  }

  if (headings.length >= 2 && firstH2Index !== -1) {
    const tocHtml = buildTocHtml(headings);
    htmlParts.splice(firstH2Index, 0, tocHtml);
  }

  return htmlParts.join('\n');
}

function extractTitle(markdown, fallback) {
  const match = normalizeLf(markdown).match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function buildDocument({ title, bodyHtml, depth, page, domains, allPages }) {
  const cssHref = depth === 1 ? '../assets/css/wiki.css' : '../../assets/css/wiki.css';
  const homeHref = depth === 1 ? '../' : '../../';
  const wikiHomeHref = depth === 1 ? 'index.html' : '../index.html';

  const githubSourceRel = page.relKey === 'index.wiki.md'
    ? '.agents/specs/wiki/index.wiki.md'
    : `.agents/specs/wiki/${page.relKey}`;
  const githubBlobUrl = `https://github.com/jpolvora/spec-memo/blob/master/${githubSourceRel}`;
  const githubHistoryUrl = `https://github.com/jpolvora/spec-memo/commits/master/${githubSourceRel}`;
  const githubEditUrl = `https://github.com/jpolvora/spec-memo/edit/master/${githubSourceRel}`;

  const sidebarHtml = renderSidebarHtml(domains, page, homeHref, wikiHomeHref);
  const topbarHtml = renderTopbarHtml(homeHref, wikiHomeHref);
  const tabsHtml = renderTabsHtml(githubBlobUrl, githubHistoryUrl, githubEditUrl);

  const pageDomain = page.depth === 2 ? page.relKey.split('/')[0] : '';
  const domainBreadcrumb = pageDomain ? ` · <span>${escapeHtml(pageDomain.toUpperCase())}</span>` : '';

  return normalizeLf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body class="wiki-page">
${topbarHtml}
<div class="wiki-layout">
${sidebarHtml}
  <main class="wiki-content-column">
    <nav class="wiki-chrome"><a href="${homeHref}">Home</a> · <a href="${wikiHomeHref}">Wiki</a>${domainBreadcrumb}</nav>
${tabsHtml}
    <article class="wiki-article wiki-toc">${bodyHtml}
      <div class="wiki-catlinks">
        <span class="wiki-catlinks-title">Categories:</span>
        <a href="${wikiHomeHref}">spec-memo</a>
        ${pageDomain ? ` · <a href="${wikiHomeHref}#domain-${escapeHtml(pageDomain)}">${escapeHtml(pageDomain.toUpperCase())}</a>` : ''}
        · <a href="${wikiHomeHref}">Living Architecture</a>
      </div>
    </article>
    <footer class="wiki-page-footer">
      <p>This living wiki page was synthesized from canonical specifications. Content is maintained under <a href="https://github.com/jpolvora/spec-memo">spec-memo</a>.</p>
    </footer>
  </main>
</div>
<script>
(function() {
  /* Theme initialization */
  var themeToggle = document.getElementById('wiki-theme-toggle');
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch(e) {}
  }
  try {
    var saved = localStorage.getItem('theme');
    if (saved) applyTheme(saved);
  } catch(e) {}
  if (themeToggle) {
    themeToggle.addEventListener('click', function() {
      var current = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
  }

  /* Table of Contents toggle */
  var tocToggle = document.getElementById('wiki-toc-toggle');
  var tocList = document.getElementById('wiki-toc-list');
  if (tocToggle && tocList) {
    tocToggle.addEventListener('click', function() {
      var isHidden = tocList.style.display === 'none';
      tocList.style.display = isHidden ? 'block' : 'none';
      tocToggle.textContent = isHidden ? '[hide]' : '[show]';
      tocToggle.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });
  }

  /* Left sidebar topic filter */
  var filterInput = document.getElementById('wiki-filter-topics');
  if (filterInput) {
    filterInput.addEventListener('input', function() {
      var q = filterInput.value.toLowerCase().trim();
      var sections = document.querySelectorAll('.wiki-domain-section');
      sections.forEach(function(sec) {
        var items = sec.querySelectorAll('.wiki-nav-item');
        var visible = 0;
        items.forEach(function(item) {
          var txt = item.textContent.toLowerCase();
          var match = !q || txt.includes(q);
          item.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        sec.style.display = visible > 0 ? '' : 'none';
      });
    });
  }

  /* Top search input sync with sidebar filter */
  var topSearch = document.getElementById('wiki-search-input');
  if (topSearch && filterInput) {
    topSearch.addEventListener('input', function() {
      filterInput.value = topSearch.value;
      filterInput.dispatchEvent(new Event('input'));
    });
  }

  /* Mobile menu drawer toggle */
  var menuToggle = document.getElementById('wiki-menu-toggle');
  var sidebar = document.getElementById('wiki-sidebar');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      sidebar.classList.toggle('open');
    });
    document.addEventListener('click', function(e) {
      if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== menuToggle) {
        sidebar.classList.remove('open');
      }
    });
  }
})();
</script>
</body>
</html>
`);
}

function listHtmlFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const walk = (current, relPrefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? path.posix.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        results.push(rel.replace(/\\/g, '/'));
      }
    }
  };
  walk(dir, '');
  return results.sort();
}

export function buildWikiSite({ repoRoot: _repoRoot, wikiDir, outDir, check = false }) {
  const staleReasons = [];
  const indexPath = path.join(wikiDir, 'index.wiki.md');

  if (!fs.existsSync(indexPath)) {
    return { skipped: true, pages: 0, sitemapLocs: [], staleReasons };
  }

  const pages = collectWikiPages(wikiDir);
  if (pages.length === 0) {
    return { skipped: true, pages: 0, sitemapLocs: [], staleReasons };
  }

  const domains = collectDomainTopics(pages, wikiDir);
  const generated = new Map();
  const sitemapLocs = [`${SITE_BASE}/wiki/`];

  for (const page of pages) {
    const markdown = fs.readFileSync(page.sourcePath, 'utf8');
    const title = extractTitle(markdown, path.basename(page.relKey, '.md'));
    const bodyHtml = renderMarkdown(markdown, page.relKey, wikiDir, page, pages);
    const html = buildDocument({ title, bodyHtml, depth: page.depth, page, domains, allPages: pages });
    generated.set(page.outRel, html);

    if (page.outRel !== 'index.html') {
      sitemapLocs.push(`${SITE_BASE}/wiki/${page.outRel}`);
    }
  }

  const expectedFiles = [...generated.keys()].sort();
  const existingFiles = listHtmlFiles(outDir);

  if (check) {
    for (const rel of expectedFiles) {
      const target = path.join(outDir, rel);
      if (!fs.existsSync(target)) {
        staleReasons.push(`docs/wiki missing ${rel}`);
        continue;
      }
      const onDisk = normalizeLf(fs.readFileSync(target, 'utf8'));
      const expected = generated.get(rel);
      if (onDisk !== expected) {
        staleReasons.push(`docs/wiki stale ${rel}`);
      }
    }
    for (const extra of existingFiles) {
      if (!expectedFiles.includes(extra)) {
        staleReasons.push(`docs/wiki extra ${extra}`);
      }
    }
    return { skipped: false, pages: expectedFiles.length, sitemapLocs, staleReasons };
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [rel, html] of generated.entries()) {
    const target = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, html, 'utf8');
  }

  for (const extra of existingFiles) {
    if (!expectedFiles.includes(extra)) {
      fs.unlinkSync(path.join(outDir, extra));
    }
  }

  return { skipped: false, pages: expectedFiles.length, sitemapLocs, staleReasons };
}

export function buildSitemapXml(sitemapLocs) {
  const fixed = [
    `${SITE_BASE}/`,
    `${SITE_BASE}/llms.txt`,
    'https://github.com/jpolvora/spec-memo',
  ];
  const locs = [...fixed];
  for (const loc of sitemapLocs) {
    if (!locs.includes(loc)) locs.push(loc);
  }

  const body = locs
    .map((loc) => `  <url>\n    <loc>${escapeHtml(loc)}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${loc.endsWith('/wiki/') ? '0.9' : loc.includes('/wiki/') ? '0.7' : '0.8'}</priority>\n  </url>`)
    .join('\n');

  return normalizeLf(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}
