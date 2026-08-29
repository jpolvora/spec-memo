#!/usr/bin/env node
/**
 * Keep packaged runtime skill frontmatter `version` equal to package.json version.
 * Runs on prebuild so bump + build / prepare / pretest stay aligned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-skill-versions: invalid package.json version: ${version}`);
  process.exit(1);
}

const skills = ['ws-memo', 'ws-session-tracking'];
let changed = 0;
for (const skill of skills) {
  const skillPath = path.join(root, '.agents', 'skills', skill, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`sync-skill-versions: missing ${skillPath}`);
    process.exit(1);
  }
  const before = fs.readFileSync(skillPath, 'utf8');
  if (!/^version:\s*.+$/m.test(before)) {
    console.error(`sync-skill-versions: no version: line in ${skillPath}`);
    process.exit(1);
  }
  const after = before.replace(/^version:\s*.+$/m, `version: ${version}`);
  if (after !== before) {
    fs.writeFileSync(skillPath, after);
    changed += 1;
    console.log(`sync-skill-versions: ${skill} → ${version}`);
  } else {
    console.log(`sync-skill-versions: ${skill} already ${version}`);
  }
}
if (changed === 0) {
  // still exit 0 — idempotent
}
