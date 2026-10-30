'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ScmProvider,
  assertSafeRef,
  assertResolutionComment,
  extractAcceptanceCriteria,
  cliFailure
} = require('./base.cjs');

class GitHubProvider extends ScmProvider {
  async fetchWorkItem(itemId) {
    if (!itemId || !/^\d+$/.test(String(itemId).trim())) {
      throw new Error(`Item identifier must be a valid numeric ID for GitHub fetchWorkItem: ${itemId}`);
    }

    try {
      const safeId = String(itemId).trim();
      const cmd = `gh issue view ${safeId} --json number,title,body,url,state,labels`;
      const stdout = this.executor(cmd);
      const data = JSON.parse(stdout);

      const body = data.body || '';
      const acceptanceCriteria = extractAcceptanceCriteria(body);
      const labels = Array.isArray(data.labels) ? data.labels.map(l => (typeof l === 'string' ? l : l.name)) : [];

      return {
        id: String(data.number || safeId),
        title: data.title || '',
        description: body,
        acceptanceCriteria,
        source: 'github',
        url: data.url || `https://github.com/issues/${safeId}`,
        state: (data.state || 'open').toLowerCase(),
        tags: labels
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to retrieve issue #${itemId}: ${errMsg}`);
    }
  }

  async queryWorkItems(query = {}) {
    try {
      const stateFlag = query.state ? `--state ${String(query.state).replace(/[^a-zA-Z]/g, '')}` : '';
      const limit = query.limit && /^\d+$/.test(String(query.limit)) ? query.limit : 20;
      const limitFlag = `--limit ${limit}`;
      const cmd = `gh issue list ${stateFlag} ${limitFlag} --json number,title,body,url,state,labels`.trim().replace(/\s+/g, ' ');
      const stdout = this.executor(cmd);
      const items = JSON.parse(stdout);

      return items.map(data => {
        const body = data.body || '';
        return {
          id: String(data.number),
          title: data.title || '',
          description: body,
          acceptanceCriteria: extractAcceptanceCriteria(body),
          source: 'github',
          url: data.url || '',
          state: (data.state || 'open').toLowerCase(),
          tags: Array.isArray(data.labels) ? data.labels.map(l => (typeof l === 'string' ? l : l.name)) : []
        };
      });
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to query issues: ${errMsg}`);
    }
  }

  async findActivePullRequest(options = {}) {
    const { head, base } = options;
    if (!head) throw new Error('head branch is required for GitHub findActivePullRequest.');
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    const baseFlag = base ? `--base "${base}"` : '';
    const checkCmd = `gh pr list --head "${head}" ${baseFlag} --state open --json number,url,title,headRefName,baseRefName`;
    const stdout = this.executor(checkCmd);
    const existing = JSON.parse(stdout || '[]');
    if (Array.isArray(existing) && existing.length > 0) {
      const pr = existing[0];
      return {
        number: String(pr.number),
        url: pr.url,
        head: pr.headRefName || head,
        base: pr.baseRefName || (base || 'main'),
        title: pr.title || '',
        state: 'open'
      };
    }
    return null;
  }

  async createPullRequest(options = {}) {
    const { title, body = '', head, base, draft = false, dryRun = false } = options;
    if (!title || !head) {
      throw new Error('title and head branch are required for GitHub createPullRequest.');
    }
    assertSafeRef(head, 'head');
    if (base) assertSafeRef(base, 'base');

    try {
      const activePr = await this.findActivePullRequest({ head, base });
      if (activePr) {
        return {
          number: activePr.number,
          url: activePr.url,
          head: activePr.head,
          base: activePr.base,
          title: activePr.title || title,
          reused: true,
          dryRun: Boolean(dryRun)
        };
      }
    } catch (err) {
      if (!dryRun) {
        throw new Error(`Unable to verify existing pull request before creation: ${err.message}`);
      }
    }

    if (dryRun) {
      return {
        number: null,
        url: null,
        head,
        base: base || 'main',
        title,
        body,
        reused: false,
        dryRun: true,
        command: `gh pr create --head "${head}" ${base ? `--base "${base}"` : ''} --title "${title}"`
      };
    }

    let tempBodyFile = null;
    try {
      let bodyArg = '';
      if (body) {
        const tmpDir = os.tmpdir();
        tempBodyFile = path.join(tmpDir, `sdw-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(tempBodyFile, body, 'utf8');
        bodyArg = `--body-file "${tempBodyFile.replace(/\\/g, '/')}"`;
      }
      const baseArg = base ? `--base "${base}"` : '';
      const draftArg = draft ? '--draft' : '';
      const cleanTitle = title.replace(/["`$\\]/g, '\\$&');
      const cmd = `gh pr create --head "${head}" ${baseArg} --title "${cleanTitle}" ${bodyArg} ${draftArg}`.trim().replace(/\s+/g, ' ');
      const prUrl = this.executor(cmd).trim();

      const numMatch = prUrl.match(/\/pull\/(\d+)/);
      const prNumber = numMatch ? numMatch[1] : null;

      return {
        number: prNumber ? String(prNumber) : null,
        url: prUrl,
        head,
        base: base || 'main',
        title,
        reused: false,
        dryRun: false
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      const alreadyExistsMatch = errMsg.match(/already exists:\s*(https:\/\/[^\s]+)/i);
      if (alreadyExistsMatch) {
        const existingUrl = alreadyExistsMatch[1];
        const numMatch = existingUrl.match(/\/pull\/(\d+)/);
        return {
          number: numMatch ? String(numMatch[1]) : null,
          url: existingUrl,
          head,
          base: base || 'main',
          title,
          reused: true,
          dryRun: false
        };
      }
      throw new Error(`GitHub SCM Provider failed to create PR: ${errMsg}`);
    } finally {
      if (tempBodyFile && fs.existsSync(tempBodyFile)) {
        try { fs.unlinkSync(tempBodyFile); } catch (e) {}
      }
    }
  }

  async updatePullRequest(options = {}) {
    const { prNumber, title, body, appendBody = true, dryRun = false } = options;
    if (!prNumber) {
      throw new Error('prNumber is required for GitHub updatePullRequest.');
    }

    if (dryRun) {
      return {
        number: String(prNumber),
        updated: true,
        dryRun: true
      };
    }

    let finalBody = body;
    if (appendBody && body) {
      try {
        const viewCmd = `gh pr view ${prNumber} --json body`;
        const viewOut = JSON.parse(this.executor(viewCmd) || '{}');
        const currentBody = viewOut.body || '';
        if (currentBody && !currentBody.includes(body.trim())) {
          finalBody = `${currentBody.trim()}\n\n---\n\n${body.trim()}`;
        } else if (currentBody) {
          finalBody = currentBody;
        }
      } catch (e) {
        throw new Error(`Failed to read existing pull request #${prNumber} description for append: ${e.message}`);
      }
    }

    let tempBodyFile = null;
    try {
      let bodyArg = '';
      if (finalBody) {
        const tmpDir = os.tmpdir();
        tempBodyFile = path.join(tmpDir, `sdw-pr-update-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(tempBodyFile, finalBody, 'utf8');
        bodyArg = `--body-file "${tempBodyFile.replace(/\\/g, '/')}"`;
      }
      const titleArg = title ? `--title "${title.replace(/["`$\\]/g, '\\$&')}"` : '';
      if (bodyArg || titleArg) {
        this.executor(`gh pr edit ${prNumber} ${titleArg} ${bodyArg}`.trim());
      }
      return {
        number: String(prNumber),
        updated: true,
        dryRun: false
      };
    } catch (err) {
      const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
      throw new Error(`GitHub SCM Provider failed to update PR: ${errMsg}`);
    } finally {
      if (tempBodyFile && fs.existsSync(tempBodyFile)) {
        try { fs.unlinkSync(tempBodyFile); } catch (e) {}
      }
    }
  }

  async checkPrStatus(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for GitHub checkPrStatus.');
    }
    try {
      const cmd = `gh pr checks ${prIdentifier} --json name,state,bucket,link`;
      let stdout = '';
      try {
        stdout = this.executor(cmd);
      } catch (execErr) {
        // gh pr checks exits with 1 (failing) or 8 (pending), but still emits valid JSON on stdout.
        const output = execErr && execErr.stdout
          ? (typeof execErr.stdout === 'string' ? execErr.stdout : execErr.stdout.toString('utf8'))
          : '';
        const stderr = execErr && execErr.stderr
          ? (typeof execErr.stderr === 'string' ? execErr.stderr : execErr.stderr.toString('utf8'))
          : '';
        const message = execErr && execErr.message ? String(execErr.message) : '';
        if (output.trim()) {
          stdout = output;
        } else if (/no checks reported/i.test(stderr) || /no checks reported/i.test(message)) {
          // The branch has no check runs yet (for example between a push and workflow scheduling).
          stdout = '[]';
        } else {
          throw execErr;
        }
      }
      let checks = [];
      try {
        checks = JSON.parse(stdout || '[]');
      } catch (parseErr) {
        const lines = (stdout || '').split('\n').filter(l => l.trim());
        checks = lines.map(line => {
          const parts = line.split(/\s+/);
          return { name: parts[0] || 'check', state: parts[1] || 'unknown', bucket: parts[1] || 'unknown' };
        });
      }
      const pendingStates = new Set(['pending', 'in_progress', 'queued', 'waiting']);
      const failedStates = new Set([
        'fail',
        'failure',
        'cancelled',
        'cancel',
        'timed_out',
        'action_required',
        'startup_failure'
      ]);
      const checkState = c => String(c.state || '').toLowerCase();
      const checkBucket = c => String(c.bucket || '').toLowerCase();

      const pendingCount = checks.filter(c => pendingStates.has(checkState(c)) || pendingStates.has(checkBucket(c))).length;
      // A cancelled check is not a passing check: count it as failed so allPassed cannot become true.
      const failedCount = checks.filter(c => failedStates.has(checkState(c)) || failedStates.has(checkBucket(c))).length;
      const allPassed = checks.length > 0 && pendingCount === 0 && failedCount === 0;

      return {
        checks,
        allPassed,
        pendingCount,
        failedCount,
        completed: checks.length > 0 && pendingCount === 0
      };
    } catch (err) {
      throw cliFailure('GitHub checkPrStatus', err);
    }
  }

  // Native capability: `gh run watch <run-id> --exit-status` blocks until the
  // Actions run behind the PR checks finishes and reports the outcome. Probed
  // once from the CLI help so an older gh falls back to caller polling.
  supportsNativeWatch() {
    if (this._nativeWatchSupport !== undefined) return this._nativeWatchSupport;
    try {
      const help = String(this.executor('gh run watch --help') || '');
      this._nativeWatchSupport = help.includes('--exit-status');
    } catch (e) {
      this._nativeWatchSupport = false;
    }
    return this._nativeWatchSupport;
  }

  async watchPrChecks(prIdentifier, options = {}) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for GitHub watchPrChecks.');
    }
    if (!this.supportsNativeWatch()) {
      throw new Error('GitHub CLI does not support native run watch.');
    }
    const seconds = Math.max(1, Number(options.intervalSeconds) || 10);
    let checks = [];
    try {
      checks = JSON.parse(this.executor(`gh pr checks ${prIdentifier} --json name,state,link`) || '[]');
    } catch (e) {
      // `gh pr checks` exits non-zero while checks are pending/failing but still
      // prints the JSON payload on stdout.
      const output = e && e.stdout ? String(e.stdout) : '';
      try {
        checks = output.trim() ? JSON.parse(output) : [];
      } catch (parseErr) {
        checks = [];
      }
    }
    const runIds = [];
    for (const check of Array.isArray(checks) ? checks : []) {
      const match = String(check.link || '').match(/\/actions\/runs\/(\d+)/);
      if (match && !runIds.includes(match[1])) runIds.push(match[1]);
    }
    if (runIds.length === 0) {
      throw new Error('no Actions run is associated with the pull request checks yet');
    }
    const watched = [];
    for (const runId of runIds) {
      try {
        this.executor(`gh run watch ${runId} --exit-status --interval ${seconds}`);
        watched.push({ runId, ok: true });
      } catch (watchErr) {
        // A failing run exits non-zero; the caller re-reads the PR state next.
        watched.push({ runId, ok: false, reason: watchErr.message });
      }
    }
    return JSON.stringify(watched);
  }

  // Merge observation: a merge command that was only accepted (queue,
  // auto-merge pending, blocked by branch rules) must not be treated as merged.
  async isPullRequestMerged(prIdentifier) {
    if (!prIdentifier) return false;
    try {
      const state = String(this.executor(`gh pr view ${prIdentifier} --json state --jq .state`) || '').trim();
      return state.toUpperCase() === 'MERGED';
    } catch (e) {
      return false;
    }
  }

  async listReviewThreads(prIdentifier) {
    if (!prIdentifier) {
      throw new Error('prIdentifier is required for GitHub listReviewThreads.');
    }

    // Attempt GraphQL first for native threads and PRRT_ IDs
    try {
      const repoOut = this.executor('gh repo view --json owner,name');
      const repoData = JSON.parse(repoOut || '{}');
      const owner = repoData.owner ? (repoData.owner.login || repoData.owner) : null;
      const name = repoData.name;
      if (owner && name) {
        let tempGqlFile = null;
        try {
          const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 50) { nodes { id isResolved path line comments(first: 50) { nodes { id databaseId body author { login } createdAt } } } } } } }`;
          const payload = JSON.stringify({
            query,
            variables: {
              owner,
              name,
              number: Number(prIdentifier)
            }
          });
          const tmpDir = os.tmpdir();
          tempGqlFile = path.join(tmpDir, `sdw-gql-list-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          fs.writeFileSync(tempGqlFile, payload, 'utf8');

          const stdout = this.executor(`gh api graphql --input "${tempGqlFile.replace(/\\/g, '/')}"`);
          const data = JSON.parse(stdout || '{}');
          const rawThreads = data.data && data.data.repository && data.data.repository.pullRequest && data.data.repository.pullRequest.reviewThreads && data.data.repository.pullRequest.reviewThreads.nodes;
          if (Array.isArray(rawThreads)) {
            const threads = rawThreads.map(t => {
              const comments = (t.comments && t.comments.nodes ? t.comments.nodes : []).map(c => ({
                id: String(c.id),
                databaseId: c.databaseId ? String(c.databaseId) : null,
                body: c.body || '',
                author: c.author ? c.author.login : 'unknown',
                createdAt: c.createdAt || ''
              }));
              // GitHub's isResolved is authoritative. A resolution reply marker does not
              // resolve the thread for branch protection, so it must not be treated as resolved.
              return {
                id: String(t.id),
                path: t.path,
                line: t.line,
                isResolved: Boolean(t.isResolved),
                comments
              };
            });
            return {
              threads,
              activeCount: threads.filter(t => !t.isResolved).length
            };
          }
        } finally {
          if (tempGqlFile && fs.existsSync(tempGqlFile)) {
            try { fs.unlinkSync(tempGqlFile); } catch (e) {}
          }
        }
      }
    } catch (gqlErr) {
      // Fallback to REST comments
    }

    try {
      const cmd = `gh api repos/:owner/:repo/pulls/${prIdentifier}/comments`;
      const stdout = this.executor(cmd);
      const comments = JSON.parse(stdout || '[]');
      
      const threadMap = new Map();
      for (const c of comments) {
        const threadId = c.in_reply_to_id ? String(c.in_reply_to_id) : String(c.id);
        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, {
            id: threadId,
            path: c.path,
            line: c.line,
            isResolved: false,
            comments: []
          });
        }
        threadMap.get(threadId).comments.push({
          id: String(c.id),
          databaseId: String(c.id),
          body: c.body,
          author: c.user ? c.user.login : 'unknown',
          createdAt: c.created_at
        });
      }

      // REST comments do not expose review-thread resolution state. Keep them active so the
      // caller never reports convergence from a marker that branch protection does not honor.
      const threads = Array.from(threadMap.values());
      const activeCount = threads.filter(t => !t.isResolved).length;

      return {
        threads,
        activeCount
      };
    } catch (err) {
      throw cliFailure('GitHub listReviewThreads', err);
    }
  }

  async resolveReviewThread(options = {}) {
    const { prNumber, threadId, commentId, comment, model, dryRun = false } = options;
    assertResolutionComment(comment);

    if (dryRun) {
      return {
        resolved: true,
        dryRun: true,
        threadId: threadId || commentId,
        comment
      };
    }

    const note = model ? `${comment}\n\n---\nLLM model: ${model}` : comment;
    // Idempotent: cmdResolveThread already prefixes the marker, so only add it when absent.
    const bodyWithMarker = comment.includes('<!-- resolution-reply -->') ? note : `<!-- resolution-reply -->\n${note}`;

    try {
      if (threadId && String(threadId).startsWith('PRRT_')) {
        let tempGqlFile = null;
        try {
          const mutation = `mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }`;
          const payload = JSON.stringify({
            query: mutation,
            variables: {
              threadId: String(threadId),
              body: bodyWithMarker
            }
          });
          const tmpDir = os.tmpdir();
          tempGqlFile = path.join(tmpDir, `sdw-gql-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
          fs.writeFileSync(tempGqlFile, payload, 'utf8');

          const stdout = this.executor(`gh api graphql --input "${tempGqlFile.replace(/\\/g, '/')}"`);
          let response = {};
          try {
            response = JSON.parse(stdout || '{}');
          } catch (parseErr) {
            throw new Error(`GitHub resolveReviewThread returned invalid JSON: ${parseErr.message}`);
          }
          if (Array.isArray(response.errors) && response.errors.length > 0) {
            const messages = response.errors.map(e => (e && e.message) || JSON.stringify(e)).join('; ');
            throw new Error(`GraphQL mutation failed: ${messages}`);
          }
          const confirmed = response.data
            && response.data.resolveReviewThread
            && response.data.resolveReviewThread.thread
            && response.data.resolveReviewThread.thread.isResolved === true;
          if (!confirmed) {
            throw new Error('GitHub resolveReviewThread mutation did not confirm resolution.');
          }
          return {
            resolved: true,
            dryRun: false,
            threadId,
            comment: bodyWithMarker
          };
        } finally {
          if (tempGqlFile && fs.existsSync(tempGqlFile)) {
            try { fs.unlinkSync(tempGqlFile); } catch (e) {}
          }
        }
      }

      const targetId = commentId || threadId;
      if (!targetId || !prNumber) {
        throw new Error('prNumber and either threadId or commentId are required to reply/resolve.');
      }
      if (!/^\d+$/.test(String(prNumber)) || !/^\d+$/.test(String(targetId))) {
        throw new Error('prNumber and commentId must be numeric for the GitHub REST reply endpoint.');
      }
      let replyFile = null;
      try {
        replyFile = path.join(os.tmpdir(), `sdw-rest-reply-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(replyFile, JSON.stringify({ body: bodyWithMarker }), 'utf8');
        this.executor(`gh api repos/:owner/:repo/pulls/${prNumber}/comments/${targetId}/replies --input "${replyFile.replace(/\\/g, '/')}"`);
      } finally {
        if (replyFile && fs.existsSync(replyFile)) {
          try { fs.unlinkSync(replyFile); } catch (e) {}
        }
      }
      // A REST reply cannot resolve a GitHub review thread. Report the truth so the
      // convergence loop does not mark the PR as delivered while branch protection blocks it.
      return {
        resolved: false,
        dryRun: false,
        threadId: String(targetId),
        comment: bodyWithMarker,
        reason: 'GitHub REST replies cannot resolve a review thread; a PRRT_ thread id is required.'
      };
    } catch (err) {
      throw cliFailure('GitHub resolveReviewThread', err);
    }
  }

  /**
   * Merges a pull request with the GitHub CLI. Callers treat the outcome as
   * advisory: permissions and branch protection are outside this contract.
   */
  async mergePullRequest(options = {}) {
    const { prNumber, method = 'merge', deleteBranch = false, dryRun = false } = options;
    if (!prNumber) {
      throw new Error('prNumber is required to merge a GitHub pull request.');
    }
    if (!/^\d+$/.test(String(prNumber))) {
      throw new Error(`prNumber must be numeric for GitHub merge: ${prNumber}`);
    }
    const strategy = method === 'squash' ? '--squash' : (method === 'rebase' ? '--rebase' : '--merge');
    if (dryRun) {
      return { merged: true, dryRun: true, prNumber: Number(prNumber), method };
    }
    const deleteFlag = deleteBranch ? ' --delete-branch' : '';
    try {
      this.executor(`gh pr merge ${prNumber} ${strategy}${deleteFlag}`);
      return { merged: true, dryRun: false, prNumber: Number(prNumber), method };
    } catch (err) {
      throw cliFailure('GitHub mergePullRequest', err);
    }
  }
}

/**
 * Azure DevOps Provider Implementation
 */
module.exports = { GitHubProvider };
