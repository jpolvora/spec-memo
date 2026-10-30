'use strict';

// Legacy entrypoint retained for backward compatibility.
// Step 7 review authority is `sdw-code-review`; this module delegates to it.
// See skills/sdw-code-review/scripts/sdw_code_review.cjs (sole review authority).

const path = require('path');

let codeReview = null;
try {
  codeReview = require('../../sdw-code-review/scripts/sdw_code_review.cjs');
} catch (e) {
  codeReview = null;
}

function getFilesToReview(baseCommit, projectRoot) {
  const root = projectRoot || process.cwd();
  if (codeReview && typeof codeReview.getChangedFiles === 'function') {
    try {
      return codeReview.getChangedFiles({ projectRoot: root, base: baseCommit || null });
    } catch (e) {}
  }
  return [];
}

function runAutomatedReview(options) {
  const projectRoot = (options && options.projectRoot) || process.cwd();
  const baseOpt = (options && (options.base || options.baseCommit)) || null;
  if (codeReview) {
    try {
      const resolved = baseOpt
        ? { base: baseOpt, source: 'explicit' }
        : codeReview.resolveBaseRef({ projectRoot });
      const files = codeReview.getChangedFiles({ projectRoot, base: resolved.base });
      const detailed = codeReview.analyzeChangedFiles(projectRoot, resolved.base, files);
      const errorCount = detailed.filter(f => f.severity === 'critical').length;
      const warningCount = detailed.filter(f => f.severity === 'warning').length;
      const passed = errorCount === 0 && warningCount === 0;
      return {
        passed,
        errorCount,
        warningCount,
        totalFindings: detailed.length,
        findings: detailed.map(d => ({
          file: d.file,
          severity: d.severity === 'critical' ? 'error' : d.severity,
          rule: d.rule,
          message: d.message,
          fixable: d.fixable
        })),
        summary: passed
          ? (warningCount === 0 ? 'Code review passed with zero findings.' : `Code review passed with ${warningCount} advisory warnings.`)
          : `Code review failed with ${errorCount} blocking errors.`
      };
    } catch (e) {
      return {
        passed: false,
        errorCount: 1,
        warningCount: 0,
        totalFindings: 0,
        findings: [],
        summary: e && e.message ? e.message : 'Code review failed.',
        error: e && e.message ? e.message : String(e)
      };
    }
  }
  return {
    passed: false,
    errorCount: 1,
    warningCount: 0,
    totalFindings: 0,
    findings: [],
    summary: 'sdw-code-review module unavailable.',
    error: 'sdw-code-review module unavailable.'
  };
}

function applyAutoFixes(findings, projectRoot) {
  if (codeReview && typeof codeReview.applyAutoFixes === 'function') {
    return codeReview.applyAutoFixes(findings, projectRoot || process.cwd());
  }
  return [];
}

module.exports = {
  getFilesToReview,
  runAutomatedReview,
  applyAutoFixes
};
