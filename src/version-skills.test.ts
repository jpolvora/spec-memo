import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp.js';
import { TOOL_NAMES } from './types.js';
import { executeTool } from './tools.js';
import { checkVersion, getPackageVersion, isSemverNewer } from './version.js';
import { installSkills, listRelativeFiles } from './skills-install.js';
import { getPackageRoot } from './version.js';
import { runCli } from './cli.js';

describe('check_version and install_skills', () => {
  it('registers 11 MCP tools including check_version and install_skills', async () => {
    assert.equal(TOOL_NAMES.length, 11);
    assert.ok(TOOL_NAMES.includes('check_version'));
    assert.ok(TOOL_NAMES.includes('install_skills'));
    assert.ok(TOOL_NAMES.includes('prompt'));

    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    assert.equal(toolsResult.tools.length, 11);
    const names = toolsResult.tools.map((t) => t.name);
    assert.ok(names.includes('check_version'));
    assert.ok(names.includes('install_skills'));
    assert.ok(names.includes('prompt'));

    await client.close();
    await server.close();
  });

  it('check_version returns payload and soft-fails when latest lookup is offline', async () => {
    const current = getPackageVersion();
    const offline = await checkVersion({
      fetchLatest: async () => null
    });
    assert.equal(offline.current, current);
    assert.equal(offline.latest, null);
    assert.equal(offline.updateAvailable, 'unknown');
    assert.equal(offline.source, 'offline');

    const viaTool = await executeTool('check_version', {});
    assert.equal(viaTool.isError, undefined);
    const data = viaTool.data as {
      current: string;
      latest: string | null;
      updateAvailable: boolean | 'unknown';
      source: string;
    };
    assert.equal(data.current, current);
    assert.ok(data.source === 'npm' || data.source === 'offline');
    assert.ok(
      data.updateAvailable === true ||
        data.updateAvailable === false ||
        data.updateAvailable === 'unknown'
    );
  });

  it('check_version sets updateAvailable from semver when latest is known', async () => {
    assert.equal(isSemverNewer('0.3.0', '0.2.0'), true);
    assert.equal(isSemverNewer('0.2.0', '0.2.0'), false);
    assert.equal(isSemverNewer('0.1.9', '0.2.0'), false);

    const current = getPackageVersion();
    const newer = await checkVersion({
      fetchLatest: async () => '99.0.0'
    });
    assert.equal(newer.current, current);
    assert.equal(newer.latest, '99.0.0');
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.source, 'npm');

    const same = await checkVersion({
      fetchLatest: async () => current
    });
    assert.equal(same.updateAvailable, false);
  });

  it('install_skills copies ws-memo into a temp product root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-'));
    const productRoot = path.join(tmp, 'consumer');
    fs.mkdirSync(productRoot, { recursive: true });
    // minimal git remote so identity binds
    const gitDir = path.join(productRoot, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[remote "origin"]\n\turl = https://github.com/example/consumer.git\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    try {
      const result = await installSkills({
        productRoot,
        packageRoot: getPackageRoot()
      });
      assert.equal(result.installed.length, 2);
      assert.equal(result.installed[0].skill, 'ws-memo');
      assert.equal(result.installed[1].skill, 'ws-session-tracking');
      assert.equal(result.installed[0].identical, false);
      const dest = path.join(productRoot, result.installed[0].destination);
      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
      assert.ok(listRelativeFiles(dest).length >= 2);

      // idempotent identical reinstall
      const again = await installSkills({
        productRoot,
        packageRoot: getPackageRoot()
      });
      assert.equal(again.installed[0].identical, true);
      assert.equal(again.installed[0].bytesWritten, 0);
      assert.equal(again.installed[1].identical, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills refuses overwrite without force and allows force', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-force-'));
    const productRoot = path.join(tmp, 'consumer');
    fs.mkdirSync(productRoot, { recursive: true });
    const gitDir = path.join(productRoot, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[remote "origin"]\n\turl = https://github.com/example/consumer2.git\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    const destSkill = path.join(productRoot, '.agents', 'skills', 'ws-memo');
    fs.mkdirSync(destSkill, { recursive: true });
    fs.writeFileSync(path.join(destSkill, 'SKILL.md'), '# diverged consumer edit\n');

    try {
      await assert.rejects(
        () =>
          installSkills({
            productRoot,
            packageRoot: getPackageRoot()
          }),
        /force/i
      );
      assert.equal(fs.readFileSync(path.join(destSkill, 'SKILL.md'), 'utf8'), '# diverged consumer edit\n');

      const forced = await installSkills({
        productRoot,
        force: true,
        packageRoot: getPackageRoot()
      });
      assert.equal(forced.installed[0].identical, false);
      const body = fs.readFileSync(path.join(destSkill, 'SKILL.md'), 'utf8');
      assert.ok(body.includes('ws-memo'));
      assert.notEqual(body, '# diverged consumer edit\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills refuses vault root as product destination', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-vault-'));
    const vaultRoot = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(vaultRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, 'config.json'),
      JSON.stringify({ version: '0.2.0', projects: {} })
    );

    try {
      await assert.rejects(
        () =>
          installSkills({
            productRoot: vaultRoot,
            vaultRoot,
            packageRoot: getPackageRoot()
          }),
        /vault/i
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills --global refuses destinations that overlap the vault', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-global-vault-'));
    const home = path.join(tmp, 'home');
    const vaultRoot = path.join(home, '.agents', 'skills', 'ws-memo');
    fs.mkdirSync(path.join(vaultRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, 'config.json'),
      JSON.stringify({ version: '0.11.0', projects: {} })
    );
    try {
      await assert.rejects(
        () =>
          installSkills({
            global: true,
            homeDir: home,
            vaultRoot,
            packageRoot: getPackageRoot(),
            force: true
          }),
        /vault/i
      );
      assert.ok(fs.existsSync(path.join(vaultRoot, 'config.json')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills --global refuses when the vault sits inside destDir', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-global-nested-vault-'));
    const home = path.join(tmp, 'home');
    const destDir = path.join(home, '.agents', 'skills', 'ws-memo');
    const vaultRoot = path.join(destDir, 'nested-vault');
    fs.mkdirSync(path.join(vaultRoot, 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, 'config.json'),
      JSON.stringify({ version: '0.11.0', projects: {} })
    );
    try {
      await assert.rejects(
        () =>
          installSkills({
            global: true,
            homeDir: home,
            vaultRoot,
            packageRoot: getPackageRoot(),
            force: true
          }),
        /overlap the vault/i
      );
      assert.ok(fs.existsSync(path.join(vaultRoot, 'config.json')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills copies ws-session-tracking into a temp product root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-st-'));
    const productRoot = path.join(tmp, 'consumer');
    fs.mkdirSync(productRoot, { recursive: true });
    const gitDir = path.join(productRoot, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[remote "origin"]\n\turl = https://github.com/example/consumer.git\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    try {
      const result = await installSkills({
        productRoot,
        skills: ['ws-session-tracking'],
        packageRoot: getPackageRoot()
      });
      assert.equal(result.installed.length, 1);
      assert.equal(result.installed[0].skill, 'ws-session-tracking');
      const dest = path.join(productRoot, result.installed[0].destination);
      assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills fails closed on unknown skill ids', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-unknown-'));
    const productRoot = path.join(tmp, 'consumer');
    fs.mkdirSync(productRoot, { recursive: true });
    try {
      await assert.rejects(
        () =>
          installSkills({
            productRoot,
            skills: ['not-a-real-skill'],
            packageRoot: getPackageRoot()
          }),
        /Unknown skill/
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills --global installs to agents and antigravity when present', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-global-'));
    const home = path.join(tmp, 'home');
    const agentsSkills = path.join(home, '.agents', 'skills');
    const geminiConfig = path.join(home, '.gemini', 'config');
    const antiSkills = path.join(geminiConfig, 'skills');
    fs.mkdirSync(geminiConfig, { recursive: true });

    try {
      const result = await installSkills({
        global: true,
        homeDir: home,
        packageRoot: getPackageRoot(),
        force: true
      });
      assert.equal(result.mode, 'global');
      assert.equal(result.installed.length, 4);
      assert.ok(result.installed.every((r) => r.target === 'agents' || r.target === 'antigravity'));
      assert.ok(fs.existsSync(path.join(agentsSkills, 'ws-memo', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(agentsSkills, 'ws-session-tracking', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(antiSkills, 'ws-memo', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(antiSkills, 'ws-session-tracking', 'SKILL.md')));
      assert.equal(result.skippedTargets, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('install_skills --global skips antigravity when config missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-skills-global-skip-'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });

    try {
      const result = await installSkills({
        global: true,
        homeDir: home,
        packageRoot: getPackageRoot(),
        force: true
      });
      assert.equal(result.mode, 'global');
      assert.equal(result.installed.length, 2);
      assert.ok(result.installed.every((r) => r.target === 'agents'));
      assert.ok(result.skippedTargets?.some((s) => s.kind === 'antigravity'));
      assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'ws-memo', 'SKILL.md')));
      assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('packaged skill versions match package.json version', () => {
    const version = getPackageVersion();
    const root = getPackageRoot();
    for (const skill of ['ws-memo', 'ws-session-tracking']) {
      const text = fs.readFileSync(path.join(root, '.agents', 'skills', skill, 'SKILL.md'), 'utf8');
      const m = text.match(/^version:\s*(.+)$/m);
      assert.ok(m, `${skill} missing version frontmatter`);
      assert.equal(m![1].trim(), version, `${skill} version must match package.json`);
    }
  });

  it('CLI check-version --json and install-skills --json work', async () => {
    let captured = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured += args.join(' ') + '\n';
    };
    try {
      const code = await runCli(['check-version', '--json']);
      assert.equal(code, 0);
      const parsed = JSON.parse(captured.trim());
      assert.ok(parsed.current);
      assert.ok('latest' in parsed);
      assert.ok('updateAvailable' in parsed);
      assert.ok(parsed.source === 'npm' || parsed.source === 'offline');
    } finally {
      console.log = origLog;
    }
  });
});
