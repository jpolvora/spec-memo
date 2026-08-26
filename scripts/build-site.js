#!/usr/bin/env node

/**
 * Regenerate / synchronize docs/ website assets from package.json and repository state.
 *
 * Version contract (single source of truth = package.json):
 * - Default: stamp footer, header badge, and metadata from package.json.version (no bump). Safe for CI.
 * - --bump: patch-bump package.json, then stamp docs.
 * - --check: verify that docs/index.html footer matches package.json.version without modifying.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const shouldBump = args.includes('--bump');
const shouldCheck = args.includes('--check');
const unknownArgs = args.filter((arg) => !['--bump', '--check'].includes(arg));

if (unknownArgs.length || (shouldBump && shouldCheck)) {
  console.error('Usage: node scripts/build-site.js [--bump|--check]');
  process.exit(1);
}

// 1. Read package.json
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const currentVersion = pkg.version;
let siteVersion = currentVersion;

if (shouldBump) {
  const versionParts = currentVersion.split('.').map(Number);
  if (versionParts.length !== 3 || versionParts.some((n) => Number.isNaN(n))) {
    console.error(`Invalid package.json version "${currentVersion}" (expected x.y.z)`);
    process.exit(1);
  }
  versionParts[2] += 1;
  siteVersion = versionParts.join('.');
  pkg.version = siteVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Bumping package.json version: ${currentVersion} -> ${siteVersion}`);
} else {
  console.log(`Using package.json version: ${siteVersion}`);
}

// 2. Read and update docs/index.html
const indexPath = path.join(root, 'docs', 'index.html');
if (!fs.existsSync(indexPath)) {
  if (shouldCheck) {
    console.error('docs/index.html does not exist');
    process.exit(1);
  }
  console.log('docs/index.html not found yet. Run after initial file creation.');
  process.exit(0);
}

let html = fs.readFileSync(indexPath, 'utf-8');

if (/^(?:<{7}|={7}|>{7})/m.test(html)) {
  console.error('docs/index.html contains merge-conflict markers');
  process.exit(1);
}

// Extract current footer version from HTML
const footerMatch = html.match(/v(\d+\.\d+\.\d+)/);
const currentHtmlVersion = footerMatch ? footerMatch[1] : null;

// Stamp version in badge, og:description/meta, and footer
html = html.replace(
  /<span class="([^"]*version-badge[^"]*)"([^>]*)>v\d+\.\d+\.\d+<\/span>/g,
  `<span class="$1"$2>v${siteVersion}</span>`
);

html = html.replace(
  /<span class="footer-version">v\d+\.\d+\.\d+<\/span>/g,
  `<span class="footer-version">v${siteVersion}</span>`
);

// Stamp version in footer line
html = html.replace(
  /(<span class="footer-copy">[\s\S]*?&mdash;\s*)v\d+\.\d+\.\d+(\s*&mdash;[\s\S]*?<\/span>)/,
  `$1v${siteVersion}$2`
);

html = html.replace(/\r\n?/g, '\n');

const currentDiskHtml = fs.readFileSync(indexPath, 'utf-8').replace(/\r\n?/g, '\n');
const hasChanges = currentDiskHtml !== html;

if (shouldCheck) {
  if (currentHtmlVersion !== siteVersion || hasChanges) {
    console.error(
      `Version mismatch: docs/index.html (v${currentHtmlVersion}) != package.json (v${siteVersion}). Run: npm run build:site`
    );
    process.exit(1);
  }
  const llmsPath = path.join(root, 'docs', 'llms.txt');
  if (fs.existsSync(llmsPath)) {
    const llms = fs.readFileSync(llmsPath, 'utf-8');
    const llmsMatch = llms.match(/spec-memo\s+v(\d+\.\d+\.\d+)/);
    if (!llmsMatch || llmsMatch[1] !== siteVersion) {
      console.error(
        `Version mismatch: docs/llms.txt (v${llmsMatch?.[1] ?? 'missing'}) != package.json (v${siteVersion}). Run: npm run build:site`
      );
      process.exit(1);
    }
  }
  console.log(`Check passed: site version matches package.json (v${siteVersion})`);
  process.exit(0);
}

if (hasChanges) {
  fs.writeFileSync(indexPath, html, 'utf-8');
  console.log(`Updated docs/index.html with version v${siteVersion}`);
} else {
  console.log(`docs/index.html already up to date with version v${siteVersion}`);
}

// 3. Update docs/llms.txt if present
const llmsPath = path.join(root, 'docs', 'llms.txt');
if (fs.existsSync(llmsPath)) {
  let llmsContent = fs.readFileSync(llmsPath, 'utf-8');
  llmsContent = llmsContent.replace(
    /(spec-memo\s+v)\d+\.\d+\.\d+/g,
    `$1${siteVersion}`
  );
  fs.writeFileSync(llmsPath, llmsContent, 'utf-8');
  console.log(`Updated docs/llms.txt with version v${siteVersion}`);
}
