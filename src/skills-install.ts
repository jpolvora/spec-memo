import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstallSkillsOptions, InstallSkillsResult, InstallSkillsInstalledRow } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot } from './vault.js';
import { isPathInside } from './safety.js';
import { getPackageRoot } from './version.js';

export const ALLOWED_SKILLS = ['ws-memo', 'ws-session-tracking'] as const;
export type AllowedSkill = (typeof ALLOWED_SKILLS)[number];

const DEFAULT_SKILLS_ROOT = '.agents/skills';

export type GlobalSkillTargetKind = 'agents' | 'antigravity';

export interface GlobalSkillTarget {
  kind: GlobalSkillTargetKind;
  /** Absolute skills directory (…/skills). */
  root: string;
}

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

/** destDir must not be the vault, inside the vault, or a parent of the vault (force wipe). */
function assertDestDoesNotOverlapVault(destDir: string, vaultRoot: string): void {
  if (
    destDir === vaultRoot ||
    isPathInside(destDir, vaultRoot) ||
    isPathInside(vaultRoot, destDir)
  ) {
    throw new Error(
      `Safety violation (Default Deny): skill destination must not overlap the vault (${vaultRoot}). Target: ${destDir}`
    );
  }
}

/**
 * Resolve global install roots.
 * - Always include `$HOME/.agents/skills` (created on write).
 * - Include `$HOME/.gemini/config/skills` only when Antigravity/Gemini config tree exists.
 */
export function resolveGlobalSkillTargets(homeDir = os.homedir()): {
  targets: GlobalSkillTarget[];
  skipped: Array<{ kind: GlobalSkillTargetKind; path: string; reason: string }>;
} {
  const home = path.resolve(homeDir);
  const agentsRoot = path.join(home, '.agents', 'skills');
  const geminiConfig = path.join(home, '.gemini', 'config');
  const antigravityRoot = path.join(geminiConfig, 'skills');

  const targets: GlobalSkillTarget[] = [{ kind: 'agents', root: agentsRoot }];
  const skipped: Array<{ kind: GlobalSkillTargetKind; path: string; reason: string }> = [];

  if (fs.existsSync(antigravityRoot) || fs.existsSync(geminiConfig)) {
    targets.push({ kind: 'antigravity', root: antigravityRoot });
  } else {
    skipped.push({
      kind: 'antigravity',
      path: antigravityRoot,
      reason: 'Antigravity/Gemini config root not found; skipped'
    });
  }

  return { targets, skipped };
}

function installOneSkill(options: {
  skillId: AllowedSkill;
  srcDir: string;
  destDir: string;
  force: boolean;
  destinationLabel: string;
  target?: GlobalSkillTargetKind | 'local';
}): InstallSkillsInstalledRow {
  const { skillId, srcDir, destDir, force, destinationLabel, target } = options;

  if (fs.existsSync(destDir)) {
    if (treesIdentical(srcDir, destDir)) {
      return {
        skill: skillId,
        destination: destinationLabel,
        identical: true,
        bytesWritten: 0,
        ...(target ? { target } : {})
      };
    }
    if (!force) {
      throw new Error(
        `Destination skill already exists and differs: ${destinationLabel}. Pass force: true to overwrite.`
      );
    }
    removeTree(destDir);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const bytesWritten = copyTree(srcDir, destDir);
  return {
    skill: skillId,
    destination: destinationLabel,
    identical: false,
    bytesWritten,
    ...(target ? { target } : {})
  };
}

/**
 * Copy packaged runtime skill(s) into a consumer product `{skillsRoot}`,
 * or with `global: true` into `$HOME/.agents/skills` (+ Antigravity if present).
 */
export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const vaultRoot = path.resolve(options.vaultRoot || getVaultRoot());
  const skills = options.skills?.length ? options.skills : ['ws-memo', 'ws-session-tracking'];
  const force = options.force === true;
  const packageRoot = options.packageRoot || getPackageRoot();
  const global = options.global === true;

  for (const skillId of skills) {
    assertAllowedSkill(skillId);
    const srcDir = packagedSkillDir(skillId, packageRoot);
    if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
      throw new Error(
        `Packaged skill "${skillId}" not found under ${srcDir}. Reinstall spec-memo or use a source checkout.`
      );
    }
  }

  if (global) {
    const homeDir = options.homeDir?.trim() || os.homedir();
    const { targets, skipped } = resolveGlobalSkillTargets(homeDir);
    const installed: InstallSkillsInstalledRow[] = [];

    for (const target of targets) {
      if (target.root === vaultRoot || isPathInside(target.root, vaultRoot)) {
        throw new Error(
          `Safety violation (Default Deny): global skills root must not be the vault root or inside the vault (${vaultRoot}).`
        );
      }

      for (const skillId of skills) {
        assertAllowedSkill(skillId);
        const srcDir = packagedSkillDir(skillId, packageRoot);
        const destDir = path.join(target.root, skillId);
        assertDestDoesNotOverlapVault(destDir, vaultRoot);
        installed.push(
          installOneSkill({
            skillId,
            srcDir,
            destDir,
            force,
            destinationLabel: destDir.replace(/\\/g, '/'),
            target: target.kind
          })
        );
      }
    }

    return {
      mode: 'global',
      productRoot: path.resolve(homeDir),
      skillsRoot: 'global',
      installed,
      skippedTargets: skipped.length ? skipped : undefined
    };
  }

  const explicitRoot = options.productRoot?.trim();
  const cwdFallback = options.cwd?.trim();
  if (!explicitRoot && !cwdFallback) {
    throw new Error(
      'productRoot (or cwd) is required to install skills into a consumer product repository. Pass global: true for $HOME/.agents/skills.'
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

  const installed: InstallSkillsInstalledRow[] = [];

  for (const skillId of skills) {
    assertAllowedSkill(skillId);
    const srcDir = packagedSkillDir(skillId, packageRoot);
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
    assertDestDoesNotOverlapVault(destDir, vaultRoot);

    const destinationLabel = path.relative(productRoot, destDir).replace(/\\/g, '/');
    installed.push(
      installOneSkill({
        skillId,
        srcDir,
        destDir,
        force,
        destinationLabel,
        target: 'local'
      })
    );
  }

  return {
    mode: 'local',
    productRoot,
    skillsRoot: skillsRootSeg,
    installed
  };
}
