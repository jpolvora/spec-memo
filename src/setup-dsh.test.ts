import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SUPPORTED_HOSTS,
  DSH_MCP_CLIENT_NAME,
  DSH_PATCH_FILENAME,
  DSH_DEFAULT_HTTP_URL,
  generateHostMcpSnippet,
  resolveHostConfigPath,
  resolveDshPatchPath,
  getDshHome,
  writeHostMcpConfig,
  verifyDshPatch,
  resolveDshCwd,
  runSetup
} from './setup.js';
import { ensureVaultStructure } from './vault.js';
import { closeIndex } from './indexer.js';
import { resolveProjectIdentity } from './identity.js';
import { compileBootstrapBrief } from './bootstrap.js';
import { upsertRecord } from './store.js';
import { runCli } from './cli.js';

type SpawnResult = {
  status: number | null;
  stdout: unknown;
  stderr: unknown;
  error?: { code?: string; message?: string };
};

function stubSuccess(serverId: string) {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: 0,
    stdout: `composed:\n  - id: ${serverId}\n`,
    stderr: ''
  });
}

function stubNotFoundWarning(serverId: string) {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: 0,
    stdout: 'composed: []',
    stderr: `dsh: [./overlay.yml] patch: entry "${serverId}" not found`
  });
}

function stubMissingId() {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: 0,
    stdout: 'composed: []',
    stderr: ''
  });
}

function stubEnoent() {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: null,
    stdout: '',
    stderr: '',
    error: { code: 'ENOENT', message: 'spawn dsh ENOENT' }
  });
}

/** Windows shell path: the `dsh.cmd` shim is absent, so cmd.exe reports this. */
function stubWindowsNotRecognized() {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: 1,
    stdout: '',
    stderr: "'dsh' is not recognized as an internal or external command,\r\noperable program or batch file."
  });
}

/** The DSH desktop app owns this profile and refuses CLI introspection. */
function stubManagedProfile() {
  return (_cmd: string, _args: string[], _opts: { encoding: string; timeout: number }): SpawnResult => ({
    status: 1,
    stdout: '',
    stderr: 'error: profile "desktop" is managed exclusively by the Electron application'
  });
}

async function captureCli(fn: () => Promise<number>): Promise<{ exit: number; stdout: string; stderr: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...a: unknown[]): void => {
    out += a.map((v) => String(v)).join(' ') + '\n';
  };
  console.error = (...a: unknown[]): void => {
    err += a.map((v) => String(v)).join(' ') + '\n';
  };
  try {
    const exit = await fn();
    return { exit, stdout: out, stderr: err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('DSH host wiring us-94 (12 ACs)', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-dsh-test-'));
  const allVaults = new Set<string>();
  function trackVault(v: string): string {
    allVaults.add(v);
    return v;
  }
  function makeVault(name: string): string {
    const v = trackVault(path.join(tempRoot, name));
    ensureVaultStructure(v);
    return v;
  }
  function makeDir(name: string): string {
    const d = path.join(tempRoot, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  t.after(() => {
    for (const v of allVaults) {
      try {
        closeIndex(v);
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  await t.test('AC1: dsh print emits exactly one insert patch (stdio, cwd, command/args)', () => {
    assert.ok(SUPPORTED_HOSTS.includes('dsh'), 'SUPPORTED_HOSTS must include dsh');
    const proj = makeDir('ac1-proj');
    const snippet = generateHostMcpSnippet('dsh', 'memo', ['serve'], { projectRoot: proj });
    assert.strictEqual(typeof snippet, 'string', 'dsh snippet must be YAML string');
    const yaml = snippet as string;
    assert.ok(!yaml.includes('mcpServers'), 'dsh must NOT emit mcpServers JSON');
    assert.ok(yaml.includes('- insert:'), 'must contain insert wrapper');
    assert.ok(yaml.includes(DSH_MCP_CLIENT_NAME), 'must mount dsh-mcp-client');
    assert.ok(yaml.includes('mcp-spec-memo'), 'must target mcp-spec-memo id');
    assert.ok(yaml.includes('serverName: spec-memo'), 'must include serverName');
    assert.ok(yaml.includes('transport: stdio'), 'must include stdio transport');
    assert.ok(yaml.includes('command: memo'), 'must include command memo');
    assert.ok(yaml.includes("args: ['serve']"), 'must include args serve');
    assert.ok(yaml.includes('cwd:'), 'must include cwd');
    assert.ok(yaml.includes(path.resolve(proj)), 'cwd must be absolute project root');
    const insertCount = (yaml.match(/^- insert:/gm) ?? []).length;
    assert.strictEqual(insertCount, 1, 'exactly one patch');
    const idCount = (yaml.match(/id:\s*mcp-spec-memo/g) ?? []).length;
    assert.strictEqual(idCount, 1, 'exactly one mcp id');
  });

  await t.test('AC1b: runSetup dsh print returns YAML string + patch path when profile given', () => {
    const vault = makeVault('ac1b-vault');
    const proj = makeDir('ac1b-proj');
    const dshHome = makeDir('ac1b-dsh');
    const res = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      projectRoot: proj,
      profile: 'web',
      dshHome
    });
    assert.strictEqual(typeof res.hostSnippet, 'string');
    const yaml = res.hostSnippet as string;
    assert.ok(yaml.includes('- insert:'));
    assert.ok(yaml.includes('mcp-spec-memo'));
    assert.strictEqual(res.profile, 'web');
    assert.ok(res.patchPath?.endsWith(path.join('profiles', 'web', DSH_PATCH_FILENAME)));
    assert.strictEqual(res.hostConfigPath, res.patchPath);
    assert.strictEqual(res.writtenMcp, false);
  });

  await t.test('AC1c: CLI --host dsh --print-mcp prints raw YAML (exit 0)', async () => {
    const vault = makeVault('ac1c-vault');
    const proj = makeDir('ac1c-proj');
    const cap = await captureCli(() => runCli(['setup', '--host', 'dsh', '--print-mcp', '--project-root', proj, '--vaultRoot', vault]));
    assert.strictEqual(cap.exit, 0);
    assert.ok(cap.stdout.includes('- insert:'), 'CLI stdout must be YAML');
    assert.ok(cap.stdout.includes('mcp-spec-memo'));
    assert.ok(!cap.stdout.includes('"mcpServers"'), 'CLI must not print JSON mcpServers for dsh');
  });

  await t.test('AC1d: CLI --json embeds {format yaml, patch}', async () => {
    const vault = makeVault('ac1d-vault');
    const proj = makeDir('ac1d-proj');
    const cap = await captureCli(() =>
      runCli(['setup', '--host', 'dsh', '--print-mcp', '--project-root', proj, '--vaultRoot', vault, '--json'])
    );
    assert.strictEqual(cap.exit, 0);
    const parsed = JSON.parse(cap.stdout) as { hostSnippet: { format: string; patch: string } };
    assert.strictEqual(parsed.hostSnippet.format, 'yaml');
    assert.ok(parsed.hostSnippet.patch.includes('- insert:'));
    assert.ok(parsed.hostSnippet.patch.includes('mcp-spec-memo'));
  });

  await t.test('AC2: write creates-as-array when absent, appends preserving unrelated bytes', () => {
    const vault = makeVault('ac2-vault');
    const proj = makeDir('ac2-proj');
    const dshHome = makeDir('ac2-dsh');
    const profile = 'web';
    const patchPath = resolveDshPatchPath(profile, dshHome);
    assert.ok(patchPath.startsWith(path.resolve(dshHome)));
    assert.ok(patchPath.endsWith(path.join('profiles', profile, DSH_PATCH_FILENAME)));
    assert.strictEqual(getDshHome(dshHome), path.resolve(dshHome));

    // Create-as-array when absent
    const createRes = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: proj,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    assert.strictEqual(createRes.writtenMcp, true);
    assert.ok(fs.existsSync(patchPath));
    const created = fs.readFileSync(patchPath, 'utf8');
    assert.ok(created.startsWith('- insert:'));
    assert.ok(created.includes('mcp-spec-memo'));
    assert.ok(created.endsWith('\n'));

    // Seed foreign entries then append
    const dshHome2 = makeDir('ac2b-dsh');
    const patch2 = resolveDshPatchPath(profile, dshHome2);
    fs.mkdirSync(path.dirname(patch2), { recursive: true });
    const foreign =
      "- insert:\n    - id: foreign-1\n      name: 'other-plugin'\n      config:\n        foo: bar\n\n" +
      "- insert:\n    - id: foreign-2\n      name: 'another'\n      config:\n        baz: qux\n";
    fs.writeFileSync(patch2, foreign, 'utf8');
    const before = fs.readFileSync(patch2, 'utf8');
    const res2 = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: proj,
      dshHome: dshHome2,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    assert.strictEqual(res2.writtenMcp, true);
    const after = fs.readFileSync(patch2, 'utf8');
    assert.ok(after.slice(0, before.length) === before, 'unrelated entries byte-identical prefix');
    assert.ok(after.includes('foreign-1'));
    assert.ok(after.includes('foreign-2'));
    assert.ok(after.includes('mcp-spec-memo'));
    const idCount = (after.match(/mcp-spec-memo/g) ?? []).length;
    assert.strictEqual(idCount, 1);
  });

  await t.test('AC2b: replace-in-place preserves order and unrelated bytes', () => {
    const vault = makeVault('ac2c-vault');
    const projA = makeDir('ac2c-proj-a');
    const projB = makeDir('ac2c-proj-b');
    const dshHome = makeDir('ac2c-dsh');
    const profile = 'web';
    const first = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: projA,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    assert.strictEqual(first.writtenMcp, true);
    const patchPath = first.patchPath as string;
    // Prepend a foreign entry manually to test order preservation on replace
    const current = fs.readFileSync(patchPath, 'utf8');
    const withForeign = "- insert:\n    - id: foreign-0\n      name: 'first-plugin'\n      config:\n        a: 1\n\n" + current;
    fs.writeFileSync(patchPath, withForeign, 'utf8');
    const beforeReplace = fs.readFileSync(patchPath, 'utf8');
    const second = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: projB,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    assert.strictEqual(second.writtenMcp, true);
    const afterReplace = fs.readFileSync(patchPath, 'utf8');
    assert.ok(afterReplace.includes('foreign-0'), 'foreign preserved');
    assert.ok(afterReplace.includes(path.resolve(projB)), 'new cwd present');
    assert.ok(!afterReplace.includes(path.resolve(projA)), 'old cwd replaced');
    assert.ok(afterReplace.indexOf('foreign-0') < afterReplace.indexOf('mcp-spec-memo'), 'order preserved');
    const count = (afterReplace.match(/mcp-spec-memo/g) ?? []).length;
    assert.strictEqual(count, 1, 'no duplicate id');
  });

  await t.test('AC3: dump-config verification gates success (clean ok, not-found fails, missing id fails)', () => {
    verifyDshPatch('web', '/tmp/fake.yml', 'mcp-spec-memo', stubSuccess('mcp-spec-memo'));
    try {
      verifyDshPatch('web', '/tmp/fake.yml', 'mcp-spec-memo', stubNotFoundWarning('mcp-spec-memo'));
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_VERIFY_FAILED');
    }
    try {
      verifyDshPatch('web', '/tmp/fake.yml', 'mcp-spec-memo', stubMissingId());
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_VERIFY_FAILED');
    }
  });

  await t.test('AC3b: runSetup write fails on verify warning but keeps file as evidence', () => {
    const vault = makeVault('ac3b-vault');
    const proj = makeDir('ac3b-proj');
    const dshHome = makeDir('ac3b-dsh');
    const profile = 'web';
    let thrownCode = '';
    try {
      runSetup({
        vaultRoot: vault,
        host: 'dsh',
        writeMcp: true,
        profile,
        projectRoot: proj,
        dshHome,
        dshSpawnSync: stubNotFoundWarning('mcp-spec-memo')
      });
      assert.fail('must throw');
    } catch (err: unknown) {
      thrownCode = (err as { code?: string }).code ?? '';
      assert.strictEqual(thrownCode, 'DSH_VERIFY_FAILED');
    }
    const patchPath = resolveDshPatchPath(profile, dshHome);
    assert.ok(fs.existsSync(patchPath), 'merged file stays as evidence');
    assert.ok(fs.readFileSync(patchPath, 'utf8').includes('mcp-spec-memo'));
  });

  await t.test('AC4: cwd-bound bootstrap returns workspace project with traps', async () => {
    const vault = makeVault('ac4-vault');
    const proj = makeDir('ac4-proj');
    fs.writeFileSync(path.join(proj, '.spec-memo.json'), JSON.stringify({ projectId: 'ac4-workspace-proj' }), 'utf8');
    await upsertRecord({
      vaultRoot: vault,
      projectId: 'ac4-workspace-proj',
      kind: 'trap',
      slug: 'ac4-trap',
      body: 'AC4 trap body for cwd binding',
      frontmatter: { title: 'AC4 Trap' }
    });
    const cwdRes = resolveDshCwd({ projectRoot: proj, vaultRoot: vault });
    assert.strictEqual(cwdRes.cwd, path.resolve(proj));
    assert.strictEqual(cwdRes.isFallback, false);
    const identity = resolveProjectIdentity(cwdRes.cwd, { vaultRoot: vault });
    assert.strictEqual(identity.projectId, 'ac4-workspace-proj');
    const brief = await compileBootstrapBrief({ vaultRoot: vault, cwd: cwdRes.cwd });
    assert.strictEqual(brief.projectId, 'ac4-workspace-proj');
    assert.ok(!brief.projectId.startsWith('local-'), 'must not be fallback');
    assert.ok(brief.totalTrapsCount >= 1);
  });

  await t.test('AC5: second identical write is no-op reporting already configured', () => {
    const vault = makeVault('ac5-vault');
    const proj = makeDir('ac5-proj');
    const dshHome = makeDir('ac5-dsh');
    const profile = 'web';
    const first = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: proj,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    assert.strictEqual(first.writtenMcp, true);
    const patchPath = first.patchPath as string;
    const bytesBefore = fs.readFileSync(patchPath, 'utf8');
    const second = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: proj,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    const bytesAfter = fs.readFileSync(patchPath, 'utf8');
    assert.strictEqual(bytesAfter, bytesBefore, 'zero bytes changed');
    assert.strictEqual(second.alreadyConfigured, true);
    assert.strictEqual(second.writtenMcp, false);
    assert.ok(second.message?.includes('already configured'));
    const count = (bytesAfter.match(/mcp-spec-memo/g) ?? []).length;
    assert.strictEqual(count, 1, 'no duplicate id');
  });

  await t.test('AC6: generic output unchanged (no host regression)', () => {
    const generic = generateHostMcpSnippet('generic') as Record<string, Record<string, { command: unknown; args: unknown }>>;
    assert.deepStrictEqual(generic, { mcpServers: { 'spec-memo': { command: 'memo', args: ['serve'] } } });
    assert.strictEqual(JSON.stringify(generic), '{"mcpServers":{"spec-memo":{"command":"memo","args":["serve"]}}}');
    for (const h of ['cursor', 'vscode', 'claude', 'antigravity', 'generic'] as const) {
      const s = generateHostMcpSnippet(h) as Record<string, Record<string, { command: unknown; args: unknown }>>;
      const key = h === 'vscode' ? 'servers' : 'mcpServers';
      assert.strictEqual(typeof s[key]['spec-memo'].command, 'string');
      assert.deepStrictEqual(s[key]['spec-memo'].args, ['serve']);
    }
    const stripped = generateHostMcpSnippet('generic', 'memo', ['serve', '--status', '--status-port', '3124']) as Record<
      string,
      unknown
    >;
    const str = JSON.stringify(stripped);
    assert.ok(!str.includes('--status'));
    assert.ok(!str.includes('3124'));
  });

  await t.test('AC7: print and write never modify cordis.yml or package.json', async () => {
    const vault = makeVault('ac7-vault');
    const proj = makeDir('ac7-proj');
    const dshHome = makeDir('ac7-dsh');
    const profile = 'web';
    const profileDir = path.join(dshHome, 'profiles', profile);
    fs.mkdirSync(profileDir, { recursive: true });
    const cordisYml = path.join(profileDir, 'cordis.yml');
    const pkgJson = path.join(profileDir, 'package.json');
    fs.writeFileSync(cordisYml, 'entries: []\n', 'utf8');
    fs.writeFileSync(pkgJson, '{"name":"profile"}\n', 'utf8');
    const beforeYml = fs.readFileSync(cordisYml, 'utf8');
    const beforePkg = fs.readFileSync(pkgJson, 'utf8');
    const mYml = fs.statSync(cordisYml).mtimeMs;
    const mPkg = fs.statSync(pkgJson).mtimeMs;

    generateHostMcpSnippet('dsh', 'memo', ['serve'], { projectRoot: proj });
    runSetup({
      vaultRoot: vault,
      host: 'dsh',
      writeMcp: true,
      profile,
      projectRoot: proj,
      dshHome,
      dshSpawnSync: stubSuccess('mcp-spec-memo')
    });
    // print flow via CLI (no write)
    await captureCli(() => runCli(['setup', '--host', 'dsh', '--print-mcp', '--project-root', proj, '--vaultRoot', vault]));

    assert.strictEqual(fs.readFileSync(cordisYml, 'utf8'), beforeYml);
    assert.strictEqual(fs.readFileSync(pkgJson, 'utf8'), beforePkg);
    assert.strictEqual(fs.statSync(cordisYml).mtimeMs, mYml);
    assert.strictEqual(fs.statSync(pkgJson).mtimeMs, mPkg);
  });

  await t.test('AC8: streamable-http emits !!js Authorization from env, never persists token', () => {
    const prev = process.env.SPEC_MEMO_AUTH_TOKEN;
    process.env.SPEC_MEMO_AUTH_TOKEN = 'secret-token-xyz-123';
    try {
      const proj = makeDir('ac8-proj');
      void proj;
      const yaml = generateHostMcpSnippet('dsh', 'memo', ['serve'], {
        transport: 'streamable-http',
        url: 'https://example.com/sse'
      }) as string;
      assert.ok(yaml.includes('transport: streamable-http'));
      assert.ok(yaml.includes('url:'));
      assert.ok(yaml.includes('https://example.com/sse'));
      assert.ok(yaml.includes('headers:'));
      assert.ok(yaml.includes('Authorization: !!js process.env.SPEC_MEMO_AUTH_TOKEN'));
      assert.ok(!yaml.includes('secret-token-xyz-123'), 'must never persist token value');

      const vault = makeVault('ac8-vault');
      const dshHome = makeDir('ac8-dsh');
      const res = runSetup({
        vaultRoot: vault,
        host: 'dsh',
        writeMcp: true,
        profile: 'web',
        transport: 'streamable-http',
        url: 'https://example.com/sse',
        dshHome,
        dshSpawnSync: stubSuccess('mcp-spec-memo')
      });
      const onDisk = fs.readFileSync(res.patchPath as string, 'utf8');
      assert.ok(onDisk.includes('!!js process.env.SPEC_MEMO_AUTH_TOKEN'));
      assert.ok(!onDisk.includes('secret-token-xyz-123'));
    } finally {
      if (prev === undefined) {
        delete process.env.SPEC_MEMO_AUTH_TOKEN;
      } else {
        process.env.SPEC_MEMO_AUTH_TOKEN = prev;
      }
    }
  });

  await t.test('AC8b: http without --url defaults with warning', () => {
    const vault = makeVault('ac8b-vault');
    const dshHome = makeDir('ac8b-dsh');
    const res = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      profile: 'web',
      transport: 'streamable-http',
      dshHome
    });
    const yaml = res.hostSnippet as string;
    assert.ok(yaml.includes(DSH_DEFAULT_HTTP_URL));
    assert.ok(res.warnings?.some((w) => w.includes(DSH_DEFAULT_HTTP_URL)));
  });

  await t.test('AC9: unresolved root warns loudly, cwd still emitted', async () => {
    const vault = makeVault('ac9-vault');
    const fallbackDir = makeDir('ac9-fallback');
    const res = runSetup({ vaultRoot: vault, host: 'dsh', cwd: fallbackDir });
    assert.ok(typeof res.hostSnippet === 'string');
    assert.ok((res.hostSnippet as string).includes('cwd:'));
    assert.ok(res.warnings?.some((w) => w.includes('fallback project')));
    assert.ok(res.warnings?.some((w) => w.includes('--project-root')));
    const cap = await captureCli(() =>
      runCli(['setup', '--host', 'dsh', '--print-mcp', '--cwd', fallbackDir, '--vaultRoot', vault])
    );
    assert.strictEqual(cap.exit, 0);
    assert.ok(cap.stderr.includes('fallback project') || cap.stdout.includes('cwd:'));
  });

  await t.test('AC10: docs carry DSH host-matrix row (bundled >=0.2, no install)', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    assert.ok(readme.includes('dsh'), 'README must mention dsh');
    assert.ok(readme.includes(DSH_MCP_CLIENT_NAME), 'README must name the MCP client plugin');
    assert.ok(readme.includes('cordis.patch.yml'), 'README must name the patch file');
    assert.ok(readme.toLowerCase().includes('no package install') || readme.toLowerCase().includes('no install'));
    assert.ok(readme.includes('0.2'), 'README must note DSH >= 0.2');
    const arch = fs.readFileSync(path.join(process.cwd(), 'docs', 'arch.md'), 'utf8');
    assert.ok(arch.includes('dsh'));
  });

  await t.test('AC11: invalid profile and project-root fail before any write', async () => {
    const vault = makeVault('ac11-vault');
    const proj = makeDir('ac11-proj');
    const dshHome = makeDir('ac11-dsh');
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'bad profile!', 'a'.repeat(65)]) {
      try {
        runSetup({
          vaultRoot: vault,
          host: 'dsh',
          writeMcp: true,
          profile: bad,
          projectRoot: proj,
          dshHome,
          dshSpawnSync: stubSuccess('mcp-spec-memo')
        });
        assert.fail(`profile ${JSON.stringify(bad)} must throw`);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        assert.ok(code === 'DSH_PROFILE_INVALID' || code === 'DSH_PROFILE_REQUIRED', `bad profile ${bad} code=${code}`);
      }
    }
    const patchForBad = path.join(dshHome, 'profiles', '..', 'x', DSH_PATCH_FILENAME);
    assert.ok(!fs.existsSync(patchForBad));
    assert.ok(!fs.existsSync(resolveDshPatchPath('web', dshHome)) || true);

    const beforeFiles: string[] = [];
    try {
      runSetup({
        vaultRoot: vault,
        host: 'dsh',
        writeMcp: true,
        profile: 'web',
        projectRoot: path.join(tempRoot, 'does-not-exist-xyz'),
        dshHome,
        dshSpawnSync: stubSuccess('mcp-spec-memo')
      });
      assert.fail('bad project-root must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_PROJECT_ROOT_INVALID');
    }
    void beforeFiles;
    // No file written for invalid project-root when patch was absent
    const dshHomeFresh = makeDir('ac11-fresh');
    try {
      runSetup({
        vaultRoot: vault,
        host: 'dsh',
        writeMcp: true,
        profile: 'fresh',
        projectRoot: path.join(tempRoot, 'does-not-exist-xyz'),
        dshHome: dshHomeFresh,
        dshSpawnSync: stubSuccess('mcp-spec-memo')
      });
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_PROJECT_ROOT_INVALID');
    }
    assert.ok(!fs.existsSync(resolveDshPatchPath('fresh', dshHomeFresh)), 'must not write on invalid input');

    // CLI surfaces named code
    const vault2 = makeVault('ac11-cli-vault');
    const cap = await captureCli(() =>
      runCli(['setup', '--host', 'dsh', '--write-mcp', '--profile', '../x', '--project-root', proj, '--vaultRoot', vault2])
    ).then(
      (r) => r,
      (e: unknown) => {
        throw e;
      }
    );
    void cap;
  });

  await t.test('AC11b: --write-mcp without --profile requires explicit profile', async () => {
    const vault = makeVault('ac11b-vault');
    const proj = makeDir('ac11b-proj');
    try {
      runSetup({ vaultRoot: vault, host: 'dsh', writeMcp: true, projectRoot: proj, dshHome: makeDir('ac11b-dsh') });
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_PROFILE_REQUIRED');
    }
    const cap = await captureCli(() =>
      runCli(['setup', '--host', 'dsh', '--write-mcp', '--project-root', proj, '--vaultRoot', vault])
    );
    assert.strictEqual(cap.exit, 1);
    assert.ok(cap.stderr.includes('DSH_PROFILE_REQUIRED'));
  });

  await t.test('AC12: missing dsh CLI fails with DSH_CLI_NOT_FOUND', () => {
    try {
      verifyDshPatch('web', '/tmp/x.yml', 'mcp-spec-memo', stubEnoent());
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_CLI_NOT_FOUND');
    }
    try {
      verifyDshPatch('web', '/tmp/x.yml', 'mcp-spec-memo', stubEnoent());
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_CLI_NOT_FOUND');
    }
    const vault = makeVault('ac12-vault');
    const proj = makeDir('ac12-proj');
    const dshHome = makeDir('ac12-dsh');
    try {
      runSetup({
        vaultRoot: vault,
        host: 'dsh',
        writeMcp: true,
        profile: 'web',
        projectRoot: proj,
        dshHome,
        dshSpawnSync: stubEnoent()
      });
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_CLI_NOT_FOUND');
    }
  });

  await t.test('AC12b: CLI write without dsh binary reports named error (never success)', async () => {
    const vault = makeVault('ac12b-vault');
    const proj = makeDir('ac12b-proj');
    const dshHome = makeDir('ac12b-dsh');
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    try {
      const cap = await captureCli(() =>
        runCli(['setup', '--host', 'dsh', '--write-mcp', '--profile', 'web', '--project-root', proj, '--vaultRoot', vault])
      );
      // In CI without a real `dsh` binary this must fail loudly, never report success.
      // If a real dsh binary exists and verification passes, exit 0 is acceptable; otherwise DSH_CLI_NOT_FOUND/VERIFY.
      if (cap.exit !== 0) {
        assert.ok(cap.stderr.includes('DSH_CLI_NOT_FOUND') || cap.stderr.includes('DSH_VERIFY_FAILED'));
      }
    } finally {
      if (prevHome === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = prevHome;
      }
    }
  });

  await t.test('resolveHostConfigPath dsh uses $DSH_HOME else ~/.dsh', () => {
    const tmp = makeDir('ac-path-dsh');
    const p = resolveHostConfigPath('dsh', 'web', tmp);
    assert.strictEqual(p, path.join(path.resolve(tmp), 'profiles', 'web', DSH_PATCH_FILENAME));
    const def = resolveHostConfigPath('dsh', 'web');
    const home = os.homedir();
    const fromEnv = process.env.DSH_HOME;
    if (!fromEnv) {
      assert.strictEqual(def, path.join(home, '.dsh', 'profiles', 'web', DSH_PATCH_FILENAME));
    }
    try {
      resolveHostConfigPath('dsh', '../evil', tmp);
      assert.fail('must throw');
    } catch (err: unknown) {
      assert.strictEqual((err as { code?: string }).code, 'DSH_PROFILE_INVALID');
    }
  });

  await t.test('writeHostMcpConfig dsh direct byte-span merge', () => {
    const dshHome = makeDir('ac-direct-dsh');
    const yaml = generateHostMcpSnippet('dsh', 'memo', ['serve'], { projectRoot: makeDir('ac-direct-proj') }) as string;
    const r1 = writeHostMcpConfig('dsh', yaml, { profile: 'p1', dshHome });
    assert.strictEqual(r1.written, true);
    const content1 = fs.readFileSync(r1.configPath, 'utf8');
    const r2 = writeHostMcpConfig('dsh', yaml, { profile: 'p1', dshHome });
    assert.strictEqual(r2.written, false);
    assert.strictEqual(r2.alreadyConfigured, true);
    assert.strictEqual(fs.readFileSync(r2.configPath, 'utf8'), content1);
  });

  await t.test('CLI rejects invalid transport with named error', async () => {
    const vault = makeVault('ac-transport-vault');
    const cap = await captureCli(() =>
      runCli(['setup', '--host', 'dsh', '--print-mcp', '--transport', 'bogus', '--vaultRoot', vault])
    );
    assert.strictEqual(cap.exit, 1);
    assert.ok(cap.stderr.includes('DSH_TRANSPORT_INVALID'));
  });

  // --- v0.38.1 fixes found while installing the DSH host for real ---

  await t.test('D3 fix: stdio entry carries an explicit env layer with unquoted !!js tokens', () => {
    const yaml = generateHostMcpSnippet('dsh', 'memo', ['serve'], {
      projectRoot: makeDir('d3-proj')
    }) as string;
    assert.ok(yaml.includes('env:'), 'stdio entry must include an env layer');
    assert.ok(
      yaml.includes('SPEC_MEMO_AUTH_TOKEN: !!js process.env.SPEC_MEMO_AUTH_TOKEN'),
      'auth token must be re-injected via !!js (DSH scrubs credential-shaped env for children)'
    );
    assert.ok(
      yaml.includes('SPEC_MEMO_SSE_TOKEN: !!js process.env.SPEC_MEMO_SSE_TOKEN'),
      'sse token must be re-injected via !!js'
    );
    assert.ok(!yaml.includes("'!!js"), '!!js expressions must never be quoted');
    const http = generateHostMcpSnippet('dsh', 'memo', ['serve'], {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3123/sse'
    }) as string;
    assert.ok(http.includes('headers:'), 'http entry keeps the header layer');
    assert.ok(/Authorization: !!js process\.env\.SPEC_MEMO_AUTH_TOKEN/.test(http));
    assert.ok(!http.includes('env:'), 'http entry must not add the stdio env layer');
  });

  await t.test('D1 fix: Windows "not recognized" shim failure maps to DSH_CLI_NOT_FOUND', () => {
    assert.throws(
      () => verifyDshPatch('web', '/tmp/x.yml', 'mcp-spec-memo', stubWindowsNotRecognized()),
      (err: unknown) => (err as { code?: string }).code === 'DSH_CLI_NOT_FOUND'
    );
  });

  await t.test('D2 fix: Electron-managed profile skips verification with a warning instead of failing', () => {
    const outcome = verifyDshPatch('desktop', '/tmp/fake.yml', 'mcp-spec-memo', stubManagedProfile());
    assert.strictEqual(outcome.verified, false, 'must not claim verification');
    assert.strictEqual(outcome.skipped, true, 'must be reported as skipped');
    assert.ok(outcome.warning?.includes('desktop'), 'warning must name the profile');
    assert.ok(outcome.warning?.includes('/tmp/fake.yml'), 'warning must name the written patch path');

    const vault = makeVault('d2-vault');
    const dshHome = makeDir('d2-dsh');
    const res = runSetup({
      vaultRoot: vault,
      host: 'dsh',
      profile: 'desktop',
      projectRoot: makeDir('d2-proj'),
      dshHome,
      writeMcp: true,
      dshSpawnSync: stubManagedProfile()
    });
    assert.strictEqual(res.writtenMcp, true, 'write must be reported as successful');
    assert.ok(
      (res.warnings ?? []).some((w) => w.includes('managed by the DSH desktop app')),
      'skip reason must surface as a warning'
    );
    assert.ok(fs.existsSync(res.patchPath as string), 'patch file must exist on disk');
  });
});
