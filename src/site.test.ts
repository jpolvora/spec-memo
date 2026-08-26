import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPackageRoot, getPackageVersion } from './version.js';
import { TOOL_NAMES } from './types.js';

describe('Website and GitHub Pages deploy pipeline', () => {
  const root = getPackageRoot();
  const pkgVersion = getPackageVersion();
  const docsDir = path.join(root, 'docs');
  const indexHtmlPath = path.join(docsDir, 'index.html');
  const buildScriptPath = path.join(root, 'scripts', 'build-site.js');

  it('docs directory contains all required GitHub Pages static assets', () => {
    assert.ok(fs.existsSync(indexHtmlPath), 'docs/index.html must exist');
    assert.ok(fs.existsSync(path.join(docsDir, 'styles.css')), 'docs/styles.css must exist');
    assert.ok(fs.existsSync(path.join(docsDir, 'app.js')), 'docs/app.js must exist');
    assert.ok(fs.existsSync(path.join(docsDir, '.nojekyll')), 'docs/.nojekyll must exist');
    assert.ok(fs.existsSync(path.join(docsDir, 'robots.txt')), 'docs/robots.txt must exist');
    assert.ok(fs.existsSync(path.join(docsDir, 'sitemap.xml')), 'docs/sitemap.xml must exist');
    assert.ok(fs.existsSync(path.join(docsDir, 'llms.txt')), 'docs/llms.txt must exist');
  });

  it('docs/index.html displays the canonical package.json version in badge and footer', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    assert.ok(
      html.includes(`v${pkgVersion}`),
      `docs/index.html must contain the current package version v${pkgVersion}`
    );
    assert.ok(
      html.includes(`<span class="footer-version">v${pkgVersion}</span>`),
      `docs/index.html footer must display v${pkgVersion}`
    );
  });

  it('docs/index.html documents all 10 MCP tools', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf-8');
    for (const toolName of TOOL_NAMES) {
      assert.ok(
        html.includes(toolName),
        `docs/index.html must document MCP tool "${toolName}"`
      );
    }
  });

  it('node scripts/build-site.js --check succeeds with exit code 0 when in sync', () => {
    const output = execFileSync('node', [buildScriptPath, '--check'], {
      cwd: root,
      encoding: 'utf-8'
    });
    assert.ok(
      output.includes(`Check passed: site version matches package.json (v${pkgVersion})`),
      `Expected check confirmation in output, got: ${output}`
    );
  });

  it('docs/llms.txt contains the canonical package.json version', () => {
    const llmsContent = fs.readFileSync(path.join(docsDir, 'llms.txt'), 'utf-8');
    assert.ok(
      llmsContent.includes(`spec-memo v${pkgVersion}`),
      `docs/llms.txt must contain "spec-memo v${pkgVersion}"`
    );
  });

  it('.github/workflows/deploy-site.yml exists and defines GitHub Pages deploy step', () => {
    const wfPath = path.join(root, '.github', 'workflows', 'deploy-site.yml');
    assert.ok(fs.existsSync(wfPath), '.github/workflows/deploy-site.yml must exist');
    const wf = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(wf.includes('actions/deploy-pages@v5') || wf.includes('deploy-pages'));
    assert.ok(wf.includes('upload-pages-artifact'));
    assert.ok(wf.includes('node scripts/build-site.js --check'));
  });
});
