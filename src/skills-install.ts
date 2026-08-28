import * as fs from 'node:fs';
import * as path from 'node:path';
import { InstallSkillsOptions, InstallSkillsResult } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot } from './vault.js';
import { isPathInside } from './safety.js';
import { getPackageRoot } from './version.js';

export const ALLOWED_SKILLS = ['ws-memo', 'ws-session-tracking'] as const;
export type AllowedSkill = (typeof ALLOWED_SKILLS)[number];

const DEFAULT_SKILLS_ROOT = '.agents/skills';

function assertAllowedSkill(id: string): asserts id is AllowedSkill {
  if (!(ALLOWED_SKILLS as readonly string[]).includes(id)) {
    throw new Error(
      `Unknown skill id "${id}". Allowed: ${ALLOWED_SKILLS.join(', ')}.`
    );
  }
}

function packagedSkillDir(skillId: AllowedSkill, packageRoot = getPackageRoot()): string {
  return path.join(packageRoot, '.agents', 'skills', skillId);
}

/** Recursively list relative file paths under dir (posix separators). */
export function listRelativeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, relBase: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel.replace(/\\/g, '/'));
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

function treesIdentical(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(destDir)) return false;
  const srcFiles = listRelativeFiles(srcDir);
  const destFiles = listRelativeFiles(destDir);
  if (srcFiles.length !== destFiles.length) return false;
  if (srcFiles.join('\0') !== destFiles.join('\0')) return false;
  for (const rel of srcFiles) {
    const a = fs.readFileSync(path.join(srcDir, rel));
    const b = fs.readFileSync(path.join(destDir, rel));
    if (!a.equals(b)) return false;
  }
  return true;
}

function copyTree(srcDir: string, destDir: string): number {
  let bytes = 0;
  const files = listRelativeFiles(srcDir);
  for (const rel of files) {
    const from = path.join(srcDir, rel);
    const to = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const data = fs.readFileSync(from);
    fs.writeFileSync(to, data);
    bytes += data.length;
  }
  return bytes;
}

function removeTree(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy packaged runtime skill(s) into a consumer product `{skillsRoot}`.
 */
export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const vaultRoot = path.resolve(options.vaultRoot || getVaultRoot());
  const explicitRoot = options.productRoot?.trim();
  const cwdFallback = options.cwd?.trim();
  if (!explicitRoot && !cwdFallback) {
    throw new Error(
      'productRoot (or cwd) is required to install skills into a consumer product repository.'
    );
  }

  const productRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : resolveProjectIdentity(cwdFallback as string, { vaultRoot }).rootPath;

  if (productRoot === vaultRoot || isPathInside(productRoot, vaultRoot)) {
    throw new Error(
      `Safety violation (Default Deny): productRoot must not be the vault root or inside the vault (${vaultRoot}).`
    );
  }

  const skillsRootSeg = (options.skillsRoot || DEFAULT_SKILLS_ROOT).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!skillsRootSeg || skillsRootSeg.includes('..')) {
    throw new Error('skillsRoot must be a relative path without ".." segments.');
  }

  const skills = options.skills?.length ? options.skills : ['ws-memo'];
  const force = options.force === true;
  const packageRoot = options.packageRoot || getPackageRoot();
  const installed: InstallSkillsResult['installed'] = [];

  for (const skillId of skills) {
    assertAllowedSkill(skillId);
    const srcDir = packagedSkillDir(skillId, packageRoot);
    if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
      throw new Error(
        `Packaged skill "${skillId}" not found under ${srcDir}. Reinstall spec-memo or use a source checkout.`
      );
    }

    const destDir = path.resolve(productRoot, skillsRootSeg, skillId);
    if (!isPathInside(destDir, productRoot)) {
      throw new Error(
        `Safety violation (Default Deny): skill destination must be inside product repository (${productRoot}). Target: ${destDir}`
      );
    }
    const relCheck = path.relative(productRoot, destDir).replace(/\\/g, '/');
    if (relCheck === '.git' || relCheck.startsWith('.git/')) {
      throw new Error(
        `Safety violation (Default Deny): skill destination must not target .git. Target: ${destDir}`
      );
    }

    if (fs.existsSync(destDir)) {
      if (treesIdentical(srcDir, destDir)) {
        installed.push({
          skill: skillId,
          destination: path.relative(productRoot, destDir).replace(/\\/g, '/'),
          identical: true,
          bytesWritten: 0
        });
        continue;
      }
      if (!force) {
        throw new Error(
          `Destination skill already exists and differs: ${path.relative(productRoot, destDir).replace(/\\/g, '/')}. Pass force: true to overwrite.`
        );
      }
      removeTree(destDir);
    }

    fs.mkdirSync(destDir, { recursive: true });
    const bytesWritten = copyTree(srcDir, destDir);
    installed.push({
      skill: skillId,
      destination: path.relative(productRoot, destDir).replace(/\\/g, '/'),
      identical: false,
      bytesWritten
    });
  }

  return {
    productRoot: path.relative(process.cwd(), productRoot) === ''
      ? productRoot
      : productRoot,
    skillsRoot: skillsRootSeg,
    installed
  };
}
