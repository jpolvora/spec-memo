import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectSecrets,
  assertNoSecrets,
  assertNotInProductRoot,
  isPathInside,
  scanPayloadForSecrets,
  sanitizeToolOutput
} from './safety.js';
import { upsertRecord, appendEvent } from './store.js';
import { closeIndex } from './indexer.js';

describe('Safety Engine: Secret Redaction & Product-Tree Guard', () => {
  let tempDir: string;
  let vaultRoot: string;
  let productRepo: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-memo-safety-test-'));
    vaultRoot = path.join(tempDir, 'vault');
    productRepo = path.join(tempDir, 'product-repo');
    fs.mkdirSync(productRepo, { recursive: true });
    // Simulate git repository
    fs.mkdirSync(path.join(productRepo, '.git'), { recursive: true });
  });

  afterEach(() => {
    closeIndex();
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  describe('detectSecrets & scanPayloadForSecrets', () => {
    it('should detect PEM private keys in text', () => {
      const pemHeader = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
      const pemFooter = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
      const pem = `${pemHeader}\nMIIEowIBAAKCAQEA0Y3y1234567890abcdefghijklmnopqrstuvwxyz\n${pemFooter}`;
      const res = detectSecrets(pem);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('Private Key (PEM block)') || res.matches.includes('Private Key Header'));
    });

    it('should detect AWS Access Keys', () => {
      const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
      const text = `AWS_ACCESS_KEY_ID = ${awsKey}`;
      const res = detectSecrets(text);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('AWS Access Key ID'));
    });

    it('should detect GitHub Personal Access Tokens', () => {
      const ghToken = ['ghp', '123456789012345678901234567890123456'].join('_');
      const text = `Authorization token: ${ghToken}`;
      const res = detectSecrets(text);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('GitHub Personal Access Token'));
    });

    it('should detect generic API key assignments', () => {
      const text = 'api_key' + ': "secret_custom_val_1234567890abcdef"';
      const res = detectSecrets(text);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('Generic API Key / Secret Assignment'));
    });

    it('should detect Bearer tokens with long credential hashes', () => {
      const jwtToken = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0'].join('.');
      const text = ['Authorization:', 'Bearer', jwtToken].join(' ');
      const res = detectSecrets(text);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('Bearer Token Header'));
    });

    it('should pass clean markdown content without false positives', () => {
      const cleanText = `# User Documentation

This guide describes how to configure the authentication layer.
You should provide your token via environment variables rather than hardcoding it.
`;
      const res = detectSecrets(cleanText);
      assert.strictEqual(res.hasSecret, false);
      assert.strictEqual(res.matches.length, 0);
    });

    it('should recursively scan frontmatter objects', () => {
      const ghToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
      const obj = {
        title: 'Auth Config',
        tags: ['auth'],
        nested: {
          token: ghToken
        }
      };
      const res = scanPayloadForSecrets(obj);
      assert.strictEqual(res.hasSecret, true);
      assert.ok(res.matches.includes('GitHub Personal Access Token'));
    });
  });

  describe('assertNotInProductRoot & isPathInside', () => {
    it('should identify when a path is inside a product root', () => {
      const insidePath = path.join(productRepo, '.agents', 'plans', 'slice-1.md');
      assert.strictEqual(isPathInside(insidePath, productRepo), true);
    });

    it('should identify when a path is outside a product root', () => {
      const outsidePath = path.join(vaultRoot, 'projects', 'my-proj', 'plans', 'slice-1.md');
      assert.strictEqual(isPathInside(outsidePath, productRepo), false);
    });

    it('should throw when attempting write inside product repository', () => {
      const insidePath = path.join(productRepo, 'MEMORY.md');
      assert.throws(
        () => assertNotInProductRoot(insidePath, productRepo, true),
        /Safety violation: Attempted to write memory record inside consumer product repository/
      );
    });

    it('should allow write when target path is in vault outside product repository', () => {
      const outsidePath = path.join(vaultRoot, 'projects', 'test', 'traps', 't1.md');
      assert.doesNotThrow(() => assertNotInProductRoot(outsidePath, productRepo, true, vaultRoot));
    });

    it('should allow write when productRoot is the vaultRoot or inside vaultRoot', () => {
      const vaultPath = path.join(vaultRoot, 'projects', 'test', 'traps', 't1.md');
      // When productRoot is vaultRoot
      assert.doesNotThrow(() => assertNotInProductRoot(vaultPath, vaultRoot, false, vaultRoot));
      // When productRoot is inside vaultRoot
      const vaultSubdir = path.join(vaultRoot, 'projects', 'test');
      assert.doesNotThrow(() => assertNotInProductRoot(vaultPath, vaultSubdir, false, vaultRoot));
    });
  });

  describe('assertAllowedIdeRulePromote', () => {
    it('allows .cursor/rules and refuses arbitrary src paths', async () => {
      const { assertAllowedIdeRulePromote } = await import('./safety.js');
      const cursorRule = path.join(productRepo, '.cursor', 'rules', 'derived.mdc');
      assert.doesNotThrow(() => assertAllowedIdeRulePromote(cursorRule, productRepo, vaultRoot));
      assert.doesNotThrow(() =>
        assertAllowedIdeRulePromote(path.join(productRepo, 'CLAUDE.md'), productRepo, vaultRoot)
      );
      assert.throws(
        () => assertAllowedIdeRulePromote(path.join(productRepo, 'src', 'evil.ts'), productRepo, vaultRoot),
        /allowlisted IDE rule path/
      );
    });

    it('refuses promote destinations outside the product repository', async () => {
      const { assertAllowedIdeRulePromote } = await import('./safety.js');
      const outside = path.join(os.tmpdir(), 'spec-memo-other-repo', 'src', 'injected.ts');
      assert.throws(
        () => assertAllowedIdeRulePromote(outside, productRepo, vaultRoot),
        /must resolve inside the product repository/
      );
    });

    it('refuses vault root as product cwd for promote', async () => {
      const { assertAllowedIdeRulePromote } = await import('./safety.js');
      const dest = path.join(productRepo, 'CLAUDE.md');
      assert.throws(
        () => assertAllowedIdeRulePromote(dest, vaultRoot, vaultRoot),
        /vault root is not valid|consumer product repository/
      );
      assert.throws(
        () => assertAllowedIdeRulePromote(path.join(vaultRoot, 'evil.md'), productRepo, vaultRoot),
        /not the vault|must target the product/
      );
    });
  });

  describe('Integration with Store (upsertRecord & appendEvent)', () => {
    it('should reject upsertRecord with secret PEM block in body', async () => {
      const pemHeader = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
      const pemFooter = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
      await assert.rejects(
        async () => {
          await upsertRecord({
            vaultRoot,
            cwd: productRepo,
            kind: 'scratch',
            slug: 'secret-test',
            body: `\n# Private Key Backup\n${pemHeader}\nMIIEowIBAAKCAQEA0Y3y1234567890abcdefghijklmnopqrstuvwxyz\n${pemFooter}\n`
          });
        },
        /Safety violation: Secret detected/
      );
    });

    it('should reject upsertRecord with token in frontmatter', async () => {
      const ghToken = ['ghp', '123456789012345678901234567890123456'].join('_');
      await assert.rejects(
        async () => {
          await upsertRecord({
            vaultRoot,
            cwd: productRepo,
            kind: 'scratch',
            slug: 'secret-fm-test',
            frontmatter: {
              title: 'Secret FM',
              secretKey: ghToken
            },
            body: 'Clean body'
          });
        },
        /Safety violation: Secret detected/
      );
    });

    it('should reject appendEvent with secret in log payload', async () => {
      const awsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
      await assert.rejects(
        async () => {
          await appendEvent({
            vaultRoot,
            cwd: productRepo,
            event: `Deployed with AWS_ACCESS_KEY_ID=${awsKey}`,
            kind: 'log'
          });
        },
        /Safety violation: Secret detected/
      );
    });

    it('should successfully store clean records outside product repository without creating any product files', async () => {
      const res = await upsertRecord({
        vaultRoot,
        cwd: productRepo,
        kind: 'trap',
        slug: 'safe-trap',
        frontmatter: {
          title: 'Clean Trap',
          severity: 'high'
        },
        body: 'Safe anti-regression trap description.'
      });

      assert.ok(res.path.startsWith(vaultRoot));
      assert.strictEqual(fs.existsSync(res.path), true);

      // Verify productRepo has ZERO created files in its working tree
      const productFiles = fs.readdirSync(productRepo).filter((f) => f !== '.git');
      assert.strictEqual(productFiles.length, 0);
    });
  });

  it('sanitizeToolOutput redacts secrets and strips vault paths', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const out = sanitizeToolOutput({
      path: '/home/user/.spec-memo/projects/p/traps/t.md',
      filepath: '/home/user/.spec-memo/projects/p/traps/t.md',
      vaultPath: '/home/user/.spec-memo/projects/p/traps/t.md',
      vaultRoot: '/home/user/.spec-memo',
      dbPath: '/home/user/.spec-memo/memo.sqlite',
      absolutePath: '/home/user/product/.agents/plans/foo.md',
      body: `token=${token}`,
      error: 'Safety violation inside /home/user/product/src/store.ts',
      winError: 'Failed at C:/Users/name/.spec-memo/projects/123/traps/t1.md',
      winBackslash: 'Failed at C:\\Users\\name\\.spec-memo\\projects\\123\\traps\\t1.md',
      fileUri: 'Failed at file:///C:/Users/name/.spec-memo/projects/123/traps/t1.md'
    }) as {
      path?: string;
      filepath?: string;
      vaultPath?: string;
      vaultRoot?: string;
      dbPath?: string;
      absolutePath?: string;
      body: string;
      error: string;
      winError: string;
      winBackslash: string;
      fileUri: string;
    };
    assert.equal(out.path, undefined);
    assert.equal(out.filepath, undefined);
    assert.equal(out.vaultPath, undefined);
    assert.equal(out.vaultRoot, undefined);
    assert.equal(out.dbPath, undefined);
    assert.equal(out.absolutePath, undefined);
    assert.match(out.body, /\[REDACTED:GitHub Personal Access Token\]/);
    assert.doesNotMatch(out.body, /ghp_/);
    assert.doesNotMatch(out.error, /\/home\/user/);
    assert.doesNotMatch(out.winError, /C:\/Users/);
    assert.doesNotMatch(out.winBackslash, /C:\\Users/);
    assert.doesNotMatch(out.fileUri, /C:\/Users/);
  });
});
