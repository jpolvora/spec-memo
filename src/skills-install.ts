import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InstallSkillsOptions, InstallSkillsResult, InstallSkillsInstalledRow } from './types.js';
import { resolveProjectIdentity } from './identity.js';
import { getVaultRoot } from './vault.js';
import { isPathInside } from './safety.js';
import { getPackageRoot } from './version.js';
import {
  getInstallPreflight,
  normalizeInstallHosts,
  InstallHost,
  InstallPreflight,
  ConflictPolicy
} from './install-wizard.js';

export const ALLOWED_SKILLS = ['ws-memo', 'ws-session-tracking'] as const;
export type AllowedSkill = (typeof ALLOWED_SKILLS)[number];

const DEFAULT_SKILLS_ROOT = '.agents/skills';

export type GlobalSkillTargetKind = 'agents' | 'antigravity' | 'codex' | 'opencode' | 'claude';

export interface GlobalSkillTarget {
  kind: GlobalSkillTargetKind;
  /** Absolute skills directory (…/skills). */
  root: string;
}

export interface SkillInstallTarget {
  kind: GlobalSkillTargetKind | 'local';
  root: string;
  labelRoot: string;
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

function isPackagedSkillTree(skillId: AllowedSkill, dir: string): boolean {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return false;
  try {
    const body = fs.readFileSync(skillFile, 'utf8');
    return body.includes(`name: ${skillId}`) && /^version:\s*\S+/m.test(body);
  } catch {
    return false;
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
export function resolveGlobalSkillTargets(
  homeDir = os.homedir(),
  hosts?: InstallHost[]
): {
  targets: GlobalSkillTarget[];
  skipped: Array<{ kind: GlobalSkillTargetKind; path: string; reason: string }>;
} {
  const home = path.resolve(homeDir);
  const agentsRoot = path.join(home, '.agents', 'skills');
  const targets: GlobalSkillTarget[] = hosts === undefined
    ? [{ kind: 'agents', root: agentsRoot }]
    : [];
  const skipped: Array<{ kind: GlobalSkillTargetKind; path: string; reason: string }> = [];

  if (hosts === undefined) {
    const geminiConfig = path.join(home, '.gemini', 'config');
    const antigravityRoot = path.join(geminiConfig, 'skills');
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

  const roots: Record<InstallHost, GlobalSkillTarget> = {
    cursor: { kind: 'agents', root: path.join(home, '.agents', 'skills') },
    antigravity: { kind: 'antigravity', root: path.join(home, '.gemini', 'config', 'skills') },
    codex: { kind: 'codex', root: path.join(home, '.codex', 'skills') },
    opencode: { kind: 'opencode', root: path.join(home, '.config', 'opencode', 'skills') },
    claude: { kind: 'claude', root: path.join(home, '.claude', 'skills') }
  };
  const seen = new Set<string>();
  for (const host of hosts) {
    const target = roots[host];
    if (!target || seen.has(target.root)) continue;
    seen.add(target.root);
    targets.push(target);
  }
  return { targets, skipped };
}

export function resolveSkillInstallTargets(options: {
  scope: 'local' | 'global';
  productRoot?: string;
  cwd?: string;
  homeDir?: string;
  skillsRoot?: string;
  hosts?: string[];
}): SkillInstallTarget[] {
  const hosts = options.hosts
    ? normalizeInstallHosts(options.hosts, { allowAll: true })
    : undefined;
  if (options.scope === 'global') {
    const resolved = resolveGlobalSkillTargets(
      options.homeDir?.trim() || os.homedir(),
      hosts
    );
    return resolved.targets.map((target) => ({
      kind: target.kind,
      root: target.root,
      labelRoot: target.root
    }));
  }

  const explicitRoot = options.productRoot?.trim();
  const productRoot = explicitRoot
    ? path.resolve(explicitRoot)
    : resolveProjectIdentity(options.cwd?.trim() || process.cwd()).rootPath;
  const skillsRoot = (options.skillsRoot || DEFAULT_SKILLS_ROOT)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const targets: SkillInstallTarget[] = [{
    kind: 'local',
    root: path.resolve(productRoot, skillsRoot),
    labelRoot: skillsRoot
  }];
  if (!hosts) return targets;

  const hostRoots: Record<InstallHost, string> = {
    cursor: path.join(productRoot, '.cursor', 'skills'),
    antigravity: path.join(productRoot, '.gemini', 'config', 'skills'),
    codex: path.join(productRoot, '.codex', 'skills'),
    opencode: path.join(productRoot, '.opencode', 'skills'),
    claude: path.join(productRoot, '.claude', 'skills')
  };
  const seen = new Set(targets.map((target) => path.resolve(target.root)));
  for (const host of hosts) {
    const root = path.resolve(hostRoots[host]);
    if (seen.has(root)) continue;
    seen.add(root);
    targets.push({
      kind: 'local',
      root,
      labelRoot: path.relative(productRoot, root).replace(/\\/g, '/')
    });
  }
  return targets;
}

function installOneSkill(options: {
  skillId: AllowedSkill;
  srcDir: string;
  destDir: string;
  force: boolean;
  conflictPolicy?: ConflictPolicy;
  dryRun?: boolean;
  destinationLabel: string;
  target?: GlobalSkillTargetKind | 'local';
}): InstallSkillsInstalledRow {
  const {
    skillId,
    srcDir,
    destDir,
    force,
    conflictPolicy,
    dryRun,
    destinationLabel,
    target
  } = options;

  if (!fs.existsSync(destDir) && dryRun) {
    return {
      skill: skillId,
      destination: destinationLabel,
      identical: false,
      bytesWritten: 0,
      status: 'preview',
      ...(target ? { target } : {})
    };
  }

  if (fs.existsSync(destDir)) {
    if (treesIdentical(srcDir, destDir)) {
      return {
        skill: skillId,
        destination: destinationLabel,
        identical: true,
        bytesWritten: 0,
        status: 'unchanged',
        ...(target ? { target } : {})
      };
    }
    if (dryRun) {
      return {
        skill: skillId,
        destination: destinationLabel,
        identical: false,
        bytesWritten: 0,
        status: 'preview',
        ...(target ? { target } : {})
      };
    }
    if (conflictPolicy === 'skip') {
      return {
        skill: skillId,
        destination: destinationLabel,
        identical: false,
        bytesWritten: 0,
        status: 'skipped',
        ...(target ? { target } : {})
      };
    }
    if (conflictPolicy === 'update' && !isPackagedSkillTree(skillId, destDir)) {
      return {
        skill: skillId,
        destination: destinationLabel,
        identical: false,
        bytesWritten: 0,
        status: 'refused',
        ...(target ? { target } : {})
      };
    }
    if (!force && conflictPolicy !== 'force' && conflictPolicy !== 'update') {
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
    status: 'installed',
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
  const global = options.scope ? options.scope === 'global' : options.global === true;
  const scope = global ? 'global' : 'local';
  const hosts = options.hosts?.length
    ? normalizeInstallHosts(options.hosts, { allowAll: true })
    : undefined;
  const conflictPolicy =
    options.conflictPolicy ||
    (force ? 'force' : undefined);
  const dryRun = options.dryRun === true;
  const preflight = options.preflight || getInstallPreflight();
  const permissionGated = options.scope !== undefined ||
    options.hosts !== undefined ||
    options.conflictPolicy !== undefined;

  if (permissionGated && options.confirm !== true && !dryRun) {
    throw new Error('Skill installation requires explicit confirmation (confirm: true or --yes).');
  }
  if (!dryRun && !preflight.ok && !force) {
    throw new Error(
      `${preflight.warning || 'Unable to resolve an invocable memo command.'} Pass --force only after explicit confirmation to install anyway.`
    );
  }

  const skillIds: AllowedSkill[] = [];
  for (const skillId of skills) {
    assertAllowedSkill(skillId);
    skillIds.push(skillId);
    const srcDir = packagedSkillDir(skillId, packageRoot);
    if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
      throw new Error(
        `Packaged skill "${skillId}" not found under ${srcDir}. Reinstall spec-memo or use a source checkout.`
      );
    }
  }

  if (global) {
    const homeDir = options.homeDir?.trim() || os.homedir();
    const resolved = resolveGlobalSkillTargets(homeDir, hosts);
    const { targets, skipped } = resolved;
    const installed: InstallSkillsInstalledRow[] = [];

    for (const target of targets) {
      for (const skillId of skillIds) {
        const srcDir = packagedSkillDir(skillId, packageRoot);
        const destDir = path.join(target.root, skillId);
        assertDestDoesNotOverlapVault(destDir, vaultRoot);
        installed.push(
          installOneSkill({
            skillId,
            srcDir,
            destDir,
            force,
            conflictPolicy,
            dryRun,
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
      status: dryRun ? 'preview' : 'applied',
      scope,
      hosts,
      conflictPolicy,
      preflight,
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

  const targetRoots = resolveSkillInstallTargets({
    scope: 'local',
    productRoot,
    skillsRoot: skillsRootSeg,
    hosts
  });
  const installed: InstallSkillsInstalledRow[] = [];

  for (const target of targetRoots) {
    for (const skillId of skillIds) {
    const srcDir = packagedSkillDir(skillId, packageRoot);
    const destDir = path.resolve(target.root, skillId);
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
        conflictPolicy,
        dryRun,
        destinationLabel,
        target: 'local'
      })
    );
    }
  }

  return {
    mode: 'local',
    productRoot,
    skillsRoot: skillsRootSeg,
    installed,
    status: dryRun ? 'preview' : 'applied',
    scope,
    hosts,
    conflictPolicy,
    preflight
  };
}
