'use strict';

/**
 * SCM provider contract: facade over the per-provider implementations.
 *
 * Provider implementations live in ./providers/ so each CLI adapter stays
 * reviewable on its own; this module keeps the public surface stable:
 * ScmProvider, GitHubProvider, AzureDevOpsProvider, createScmProvider,
 * resolveScmProvider, checkScmCapability, extractAcceptanceCriteria,
 * htmlToMarkdown, assertResolutionComment, plus the shared plumbing helpers.
 */

const { execSync } = require('child_process');

const {
  ScmProvider,
  assertSafeRef,
  htmlToMarkdown,
  assertResolutionComment,
  extractAcceptanceCriteria,
  cliFailure
} = require('./providers/base.cjs');
const { GitHubProvider } = require('./providers/github.cjs');
const { AzureDevOpsProvider } = require('./providers/ado.cjs');

function createScmProvider(providerName, options = {}) {
  const norm = String(providerName || '').toLowerCase().trim();
  if (norm === 'github' || norm === 'gh') {
    return new GitHubProvider(options);
  }
  if (norm === 'azure-devops' || norm === 'ado' || norm === 'azure_devops' || norm === 'az') {
    return new AzureDevOpsProvider(options);
  }
  throw new Error(`Unsupported SCM provider: "${providerName}". Supported providers are 'github' and 'azure-devops'.`);
}

/**
 * Resolves SCM provider from explicit options or workspace configuration (AC1, AC7, AC8)
 */
function resolveScmProvider({ config, explicit } = {}) {
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const norm = String(explicit).toLowerCase().trim();
    if (norm === 'github' || norm === 'gh') {
      return { provider: 'github', name: 'github', resolvedFrom: 'explicit', disabled: false };
    }
    if (norm === 'ado' || norm === 'azure-devops' || norm === 'azure_devops' || norm === 'az') {
      return { provider: 'ado', name: 'ado', resolvedFrom: 'explicit', disabled: false };
    }
    if (norm === 'none') {
      return { provider: 'none', name: 'none', resolvedFrom: 'explicit', disabled: true };
    }
    throw new Error(`Invalid SCM provider "${explicit}". Allowed values are 'none', 'ado', 'github'.`);
  }

  if (config && config.scmProvider !== undefined && config.scmProvider !== null) {
    const norm = String(config.scmProvider).toLowerCase().trim();
    if (norm === 'github' || norm === 'ado' || norm === 'none') {
      return { provider: norm, name: norm, resolvedFrom: 'config', disabled: norm === 'none' };
    }
    throw new Error(`Invalid SCM provider "${config.scmProvider}". Allowed values are 'none', 'ado', 'github'.`);
  }

  return { provider: 'none', name: 'none', resolvedFrom: 'default', disabled: true };
}

/**
 * Checks CLI presence and authentication for the configured SCM provider (AC10, AC11, AC16)
 */
function checkScmCapability(providerName, options = {}) {
  const norm = String(providerName || '').toLowerCase().trim();
  if (norm === 'none') {
    return { provider: 'none', bin: null, installed: false, authenticated: false, available: false, error: null, reason: 'SCM provider is disabled (none)' };
  }

  const bin = (norm === 'github' || norm === 'gh') ? 'gh' : ((norm === 'ado' || norm === 'az' || norm === 'azure-devops' || norm === 'azure_devops') ? 'az' : null);
  if (!bin) {
    return { provider: norm, bin: null, installed: false, authenticated: false, available: false, error: `Unsupported SCM provider "${providerName}".` };
  }

  const executor = options.executor || ((cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));

  let installed = false;
  try {
    const probeCmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const out = executor(probeCmd);
    installed = Boolean(out && out.trim());
  } catch (e) {
    installed = false;
  }

  if (!installed) {
    return {
      provider: norm,
      bin,
      installed: false,
      authenticated: false,
      available: false,
      error: `CLI "${bin}" is not installed or not found on PATH.`
    };
  }

  let authenticated = false;
  try {
    const authCmd = bin === 'gh' ? 'gh auth status' : 'az account show';
    executor(authCmd);
    authenticated = true;
  } catch (e) {
    authenticated = false;
  }

  return {
    provider: norm,
    bin,
    installed: true,
    authenticated,
    available: authenticated,
    error: authenticated ? null : `CLI "${bin}" is not authenticated. Please run "${bin === 'gh' ? 'gh auth login' : 'az login'}".`
  };
}

module.exports = {
  ScmProvider,
  GitHubProvider,
  AzureDevOpsProvider,
  createScmProvider,
  resolveScmProvider,
  checkScmCapability,
  extractAcceptanceCriteria,
  htmlToMarkdown,
  assertResolutionComment
};


module.exports = {
  ScmProvider,
  GitHubProvider,
  AzureDevOpsProvider,
  createScmProvider,
  resolveScmProvider,
  checkScmCapability,
  extractAcceptanceCriteria,
  htmlToMarkdown,
  assertResolutionComment,
  cliFailure,
  assertSafeRef
};
