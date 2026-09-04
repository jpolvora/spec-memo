#!/usr/bin/env node
/**
 * tsc does not copy .md. Ship src/wiki/template.md next to dist/wiki.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'wiki', 'template.md');
const destDir = path.join(root, 'dist', 'wiki');
const dest = path.join(destDir, 'template.md');

if (!fs.existsSync(src)) {
  console.error('copy-wiki-template: missing ' + src);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
