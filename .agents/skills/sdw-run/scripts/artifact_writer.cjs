'use strict';

const fs = require('fs');
const path = require('path');
const stateManager = require('./state_manager.cjs');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function ensureArtifactDir(targetRoot, specSlug, runId, existingArtifactsDir) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  let absDir;
  if (existingArtifactsDir) {
    absDir = path.isAbsolute(existingArtifactsDir) ? existingArtifactsDir : path.resolve(root, existingArtifactsDir);
  } else {
    const stateDir = stateManager.resolveStateDir(root);
    absDir = path.join(stateDir, specSlug, runId);
  }

  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true });
  }
  return absDir;
}

function writeArtifactSafely(targetRoot, runId, stepNum, filePath, content) {
  const root = targetRoot ? path.resolve(targetRoot) : process.cwd();
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    const relPath = normalizePath(path.relative(root, filePath));
    console.log(`[Step ${stepNum}: Artifact] Persisted artifact to ${relPath}`);
    return relPath;
  } catch (err) {
    console.warn(`[sdw-run] Warning: Failed to persist step ${stepNum} artifact: ${err.message}`);
    try {
      stateManager.recordWarning(root, runId, stepNum, `Artifact persistence warning: Failed to persist step ${stepNum} artifact: ${err.message}`);
    } catch (e) {}
    return null;
  }
}

function writeStep2Artifact(options) {
  const { targetRoot, specSlug, runId, grillingResult, effectiveSpecContent, artifactsDir } = options;
  try {
    const absDir = ensureArtifactDir(targetRoot, specSlug, runId, artifactsDir);
    const fileName = `${specSlug}-step-2.md`;
    const filePath = path.join(absDir, fileName);

    const now = new Date().toISOString();
    let md = `# Step 2 Artifact: Refinement Result\n\n`;
    md += `- **Specification Slug:** ${specSlug}\n`;
    md += `- **Run ID:** ${runId}\n`;
    md += `- **Step:** 2 (Refinement)\n`;
    md += `- **Status:** completed\n`;
    md += `- **Generated At:** ${now}\n\n`;

    // Decision Gaps & Resolutions
    md += `## Decision Gaps & Resolutions\n\n`;
    const gaps = (grillingResult && grillingResult.gaps) || [];
    if (gaps.length > 0) {
      md += `| Dimension | Question | Resolution | Source |\n`;
      md += `|---|---|---|---|\n`;
      for (const g of gaps) {
        const resolution = g.defaultChoice || g.chosenOption || 'Applied recommended default';
        md += `| ${g.dimension} | ${g.question} | ${resolution.replace(/\|/g, '\\|')} | Recommended default |\n`;
      }
      md += `\n`;
    } else {
      md += `Clean check: all decision dimensions covered. No gaps required resolution.\n\n`;
    }

    // Decision Tree Walk Summary
    md += `## Decision Tree Walk\n\n`;
    const walk = (grillingResult && grillingResult.decisionTreeWalk) || {};
    md += `- **Total Dimensions Checked:** ${walk.totalDimensionsChecked || 3}\n`;
    md += `- **Covered Dimensions:** ${walk.coveredDimensions || 3}\n`;
    md += `- **Gaps Resolved:** ${gaps.length}\n\n`;

    // Technical Blueprint
    if (grillingResult && grillingResult.blueprint) {
      md += `## Technical Blueprint\n\n`;
      md += `- **Architectural Approach:** ${grillingResult.blueprint.architecturalApproach || 'Standard implementation'}\n`;
      md += `- **Test Plan:** ${grillingResult.blueprint.testPlan || 'Standard automated testing'}\n`;
      md += `- **Target Files:**\n`;
      (grillingResult.blueprint.targetFiles || []).forEach(f => {
        md += `  - \`${f}\`\n`;
      });
      md += `\n`;
    }

    // Refined Spec Snapshot
    md += `## Refined Spec Snapshot\n\n`;
    md += `\`\`\`markdown\n`;
    md += (effectiveSpecContent || '').trim() + `\n`;
    md += `\`\`\`\n`;

    return writeArtifactSafely(targetRoot, runId, 2, filePath, md);
  } catch (err) {
    console.warn(`[sdw-run] Warning: Failed to persist step 2 artifact: ${err.message}`);
    stateManager.recordWarning(targetRoot, runId, 2, `Artifact persistence warning: ${err.message}`);
    return null;
  }
}

function writeStep3Artifact(options) {
  const { targetRoot, specSlug, runId, dagPlan, artifactsDir } = options;
  try {
    const absDir = ensureArtifactDir(targetRoot, specSlug, runId, artifactsDir);
    const fileName = `${specSlug}-step-3.md`;
    const filePath = path.join(absDir, fileName);

    const now = new Date().toISOString();
    let md = `# Step 3 Artifact: DAG Plan\n\n`;
    md += `- **Specification Slug:** ${specSlug}\n`;
    md += `- **Run ID:** ${runId}\n`;
    md += `- **Step:** 3 (DAG Generation)\n`;
    md += `- **Status:** completed\n`;
    md += `- **Generated At:** ${now}\n\n`;

    // Complexity Analysis
    md += `## Complexity Analysis\n\n`;
    const comp = (dagPlan && dagPlan.complexity) || {};
    md += `- **Level:** ${comp.level || 'simple'}\n`;
    md += `- **Acceptance Criteria Count:** ${comp.acCount || (dagPlan && dagPlan.tasks ? dagPlan.tasks.length : 0)}\n`;
    md += `- **Detected Touchpoints:** ${(comp.touchpoints && comp.touchpoints.length > 0) ? comp.touchpoints.join(', ') : 'none'}\n\n`;

    // Task Decomposition
    md += `## Task Decomposition\n\n`;
    const tasks = (dagPlan && dagPlan.tasks) || [];
    if (tasks.length > 0) {
      md += `| Task ID | Title | Dependencies | Covered ACs | Target Files |\n`;
      md += `|---|---|---|---|---|\n`;
      for (const t of tasks) {
        const deps = (t.dependencies && t.dependencies.length > 0) ? t.dependencies.join(', ') : 'none';
        const acs = (t.coveredAcs && t.coveredAcs.length > 0) ? t.coveredAcs.join(', ') : 'all';
        const targets = (t.targetFiles && t.targetFiles.length > 0) ? t.targetFiles.map(f => `\`${f}\``).join('<br>') : 'inferred';
        md += `| ${t.id} | ${t.title} | ${deps} | ${acs} | ${targets} |\n`;
      }
      md += `\n`;
    }

    // Task Context Prompts
    md += `## Task Context Prompts\n\n`;
    for (const t of tasks) {
      md += `### Context Prompt: \`${t.id}\` — ${t.title}\n\n`;
      md += `\`\`\`markdown\n`;
      md += (t.contextPrompt || '').trim() + `\n`;
      md += `\`\`\`\n\n`;
    }

    return writeArtifactSafely(targetRoot, runId, 3, filePath, md);
  } catch (err) {
    console.warn(`[sdw-run] Warning: Failed to persist step 3 artifact: ${err.message}`);
    stateManager.recordWarning(targetRoot, runId, 3, `Artifact persistence warning: ${err.message}`);
    return null;
  }
}

function writeStep5Artifact(options) {
  const { targetRoot, specSlug, runId, scoreReport, dagPlan, touchedFiles, artifactsDir } = options;
  try {
    const absDir = ensureArtifactDir(targetRoot, specSlug, runId, artifactsDir);
    const fileName = `${specSlug}-step-5.md`;
    const filePath = path.join(absDir, fileName);

    const now = new Date().toISOString();
    let md = `# Step 5 Artifact: Preliminary Implementation Report\n\n`;
    md += `- **Specification Slug:** ${specSlug}\n`;
    md += `- **Run ID:** ${runId}\n`;
    md += `- **Step:** 5 (Conformance Scoring)\n`;
    md += `- **Status:** ${scoreReport && scoreReport.passed ? 'completed' : 'reimplementation_needed'}\n`;
    md += `- **Generated At:** ${now}\n\n`;

    // Implementation Summary
    md += `## Implementation Summary\n\n`;
    const tasks = (dagPlan && dagPlan.tasks) || [];
    md += `- **Prepared Tasks:** ${tasks.length}\n`;
    if (tasks.length > 0) {
      tasks.forEach(t => {
        md += `  - [${t.id}] ${t.title}\n`;
      });
    }

    md += `- **Touched Files:**\n`;
    const files = touchedFiles || (scoreReport && scoreReport.touchedFiles) || [];
    if (files.length > 0) {
      files.forEach(f => {
        md += `  - \`${f}\`\n`;
      });
    } else {
      md += `  - (none recorded)\n`;
    }
    md += `\n`;

    // Conformance Score
    md += `## Conformance Score\n\n`;
    const report = scoreReport || {};
    md += `- **Score:** ${report.score !== undefined ? report.score : 0}/10\n`;
    md += `- **Required Score:** ${report.minScore !== undefined ? report.minScore : 8}/10\n`;
    md += `- **Result:** ${report.passed ? 'PASSED' : 'FAILED'}\n`;
    md += `- **Total Acceptance Criteria:** ${report.totalAcs || 0}\n`;
    md += `- **Verified Acceptance Criteria:** ${report.verifiedCount || 0}\n`;
    md += `- **Failing Acceptance Criteria:** ${report.failingCount || 0}\n\n`;

    // Verified Acceptance Criteria
    md += `## Verified Acceptance Criteria\n\n`;
    const verified = (report.verifiedAcs || []);
    if (verified.length > 0) {
      md += `| ID | Description | Linked Tasks / Evidence |\n`;
      md += `|---|---|---|\n`;
      for (const v of verified) {
        const linkStr = (v.evidencePaths && v.evidencePaths.length > 0)
          ? v.evidencePaths.join(', ')
          : ((v.taskIds && v.taskIds.length > 0) ? v.taskIds.join(', ') : 'Accepted task evidence');
        md += `| ${v.id} | ${v.text ? v.text.replace(/\|/g, '\\|') : ''} | ${linkStr} |\n`;
      }
      md += `\n`;
    } else {
      md += `No criteria verified.\n\n`;
    }

    // Failing Acceptance Criteria
    md += `## Failing Acceptance Criteria\n\n`;
    const failing = (report.failingAcs || []);
    if (failing.length > 0) {
      md += `| ID | Description | Reason |\n`;
      md += `|---|---|---|\n`;
      for (const f of failing) {
        const reason = f.reason || (f.missingKeywords && f.missingKeywords.length > 0 ? f.missingKeywords.join(', ') : 'Not matched');
        md += `| ${f.id} | ${f.text ? f.text.replace(/\|/g, '\\|') : ''} | ${reason} |\n`;
      }
      md += `\n`;
    } else {
      md += `Clean conformance: 0 failing criteria.\n\n`;
    }

    // Feedback
    md += `## Feedback\n\n`;
    md += (report.feedback || (report.passed ? 'All acceptance criteria successfully verified.' : 'Re-implementation required.')).trim() + `\n`;

    return writeArtifactSafely(targetRoot, runId, 5, filePath, md);
  } catch (err) {
    console.warn(`[sdw-run] Warning: Failed to persist step 5 artifact: ${err.message}`);
    stateManager.recordWarning(targetRoot, runId, 5, `Artifact persistence warning: ${err.message}`);
    return null;
  }
}

// Second-pass refinement report: written for both outcomes, including "no change".
function writeRefineReport(options) {
  const {
    targetRoot, specSlug, runId, artifactsDir, specPath,
    baseCommit, outcome, deliveryCommit, score, summary, acIds
  } = options;
  try {
    const absDir = ensureArtifactDir(targetRoot, specSlug, runId, artifactsDir);
    const filePath = path.join(absDir, `${specSlug}-refine.md`);
    const changed = outcome === 'changed';
    let md = `# Second Pass Refinement Report — ${specSlug}\n\n`;
    md += `- **Run ID:** ${runId}\n`;
    md += `- **Specification:** ${specPath ? normalizePath(specPath) : '(not recorded)'}\n`;
    md += `- **Mode:** second pass (refinement)\n`;
    md += `- **Base commit:** ${baseCommit || '(not recorded)'}\n`;
    md += `- **Outcome:** ${changed ? 'changed' : 'no change'}\n`;
    md += `- **Delivery commit:** ${deliveryCommit || '(none)'}\n`;
    md += `- **Conformance score:** ${score === null || score === undefined ? '(not re-scored)' : `${score}/10`}\n\n`;
    md += `## Files Changed\n`;
    const files = Array.isArray(options.filesChanged) ? options.filesChanged : [];
    md += files.length > 0 ? files.map(f => `- \`${normalizePath(f)}\`\n`).join('') : '- (none)\n';
    md += `\n## Refinement Summary\n`;
    md += `${summary ? String(summary).trim() : '(no worker summary recorded)'}\n\n`;
    md += `## Acceptance Criteria (must keep holding)\n`;
    const criteria = Array.isArray(acIds) ? acIds : [];
    md += criteria.length > 0 ? criteria.map(id => `- ${id}\n`).join('') : '- (none recorded)\n';
    return writeArtifactSafely(targetRoot, runId, 6, filePath, md);
  } catch (err) {
    console.warn(`[sdw-run] Warning: Failed to persist refinement report: ${err.message}`);
    return null;
  }
}

module.exports = {
  ensureArtifactDir,
  writeStep2Artifact,
  writeStep3Artifact,
  writeStep5Artifact,
  writeRefineReport
};
