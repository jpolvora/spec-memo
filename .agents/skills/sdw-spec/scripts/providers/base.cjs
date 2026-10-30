const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function assertSafeRef(ref, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(ref)) || String(ref).includes('..')) {
    throw new Error(`Invalid ${label} branch name "${ref}".`);
  }
}

/**
 * Base SCM Provider Contract
 */
class ScmProvider {
  constructor(options = {}) {
    this.options = options;
    this.executor = options.executor || this.defaultExecutor.bind(this);
  }

  defaultExecutor(command, execOptions = {}) {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...execOptions
    });
  }

  async fetchWorkItem(itemId) {
    throw new Error('fetchWorkItem must be implemented by provider.');
  }

  async queryWorkItems(query) {
    throw new Error('queryWorkItems must be implemented by provider.');
  }

  async createPullRequest(options = {}) {
    throw new Error('createPullRequest must be implemented by provider.');
  }

  async findActivePullRequest(options = {}) {
    throw new Error('findActivePullRequest must be implemented by provider.');
  }

  // Native watch capability: providers that can block until pull-request checks
  // settle override this instead of relying on caller-side timer polling.
  supportsNativeWatch() {
    return false;
  }

  async watchPrChecks(prNumber, options = {}) {
    throw new Error(`Native check watch is not supported by ${this.constructor.name} for PR ${prNumber}.`);
  }

  // Merge observation: whether the pull request reached the MERGED (completed)
  // state. Callers must not infer this from an accepted merge command.
  async isPullRequestMerged(prNumber) {
    return false;
  }

  async updatePullRequest(options = {}) {
    throw new Error('updatePullRequest must be implemented by provider.');
  }

  async listReviewThreads(prIdentifier) {
    throw new Error('listReviewThreads must be implemented by provider.');
  }

  async resolveReviewThread(options = {}) {
    throw new Error('resolveReviewThread must be implemented by provider.');
  }

  async checkPrStatus(prIdentifier) {
    throw new Error('checkPrStatus must be implemented by provider.');
  }

  async mergePullRequest(options = {}) {
    throw new Error('mergePullRequest must be implemented by provider.');
  }
}

/**
 * Helper to strip HTML tags and normalize whitespace
 */
function htmlToMarkdown(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Helper to extract acceptance criteria from description or raw text
 */
function assertResolutionComment(comment) {
  const normalized = String(comment || '')
    .replace(/<!--\s*resolution-reply\s*-->/gi, '')
    .replace(/^[\s`'"]+|[\s`'"]+$/g, '')
    .trim();
  if (!normalized || /^[0-9a-f]{4,64}$/i.test(normalized)) {
    throw new Error('A resolution comment must explain the fix and cannot be empty or a bare commit hash.');
  }
  return normalized;
}

/**
 * Helper to extract acceptance criteria from description or raw text
 */
function extractAcceptanceCriteria(text) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const acs = [];

  let inAcSection = false;
  for (const line of lines) {
    if (/^#+\s*acceptance\s*criteria\b/i.test(line)) {
      inAcSection = true;
      continue;
    }
    if (inAcSection && /^#+\s+[a-z0-9]/i.test(line)) {
      inAcSection = false;
    }

    if (inAcSection || /^-?\s*\[[ xX]\]\s*/.test(line) || /^-\s*AC\d+:\s*/i.test(line)) {
      const cleaned = line
        .replace(/^-\s*\[[ xX]\]\s*/, '')
        .replace(/^-\s*AC\d+:\s*/i, '')
        .replace(/^[-*+]\s+/, '')
        .trim();
      if (cleaned) {
        acs.push(cleaned);
      }
    }
  }

  return acs;
}

/**
 * GitHub Provider Implementation
 */
/**
 * Normalizes a CLI failure into a single Error message.
 * Every provider method used to repeat this two-line dance inline.
 */
function cliFailure(label, err) {
  const detail = err && err.stderr
    ? err.stderr.toString().trim()
    : (err && err.message) || String(err);
  return new Error(`${label} failed: ${detail}`);
}

module.exports = {
  ScmProvider,
  assertSafeRef,
  htmlToMarkdown,
  assertResolutionComment,
  extractAcceptanceCriteria,
  cliFailure
};
