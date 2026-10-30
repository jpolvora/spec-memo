'use strict';

const fs = require('fs');
const path = require('path');

const DECISION_DIMENSIONS = [
  {
    name: 'input_validation',
    question: 'How should invalid or malformed inputs be handled?',
    check: (content) => /invalid|malformed|bounds|validation|sanitiz/i.test(content),
    options: [
      '(Recommended) Fail-fast with descriptive error message and non-zero exit code',
      'Ignore invalid input and continue with safe defaults',
      'Prompt user interactively to correct the input'
    ]
  },
  {
    name: 'error_recovery',
    question: 'What strategy should be used when an unrecoverable failure occurs in a task?',
    check: (content) => /unrecoverable|failure|fallback|abort|rollback/i.test(content),
    options: [
      '(Recommended) Persist failure state to run state file and halt execution immediately',
      'Roll back changes to base commit and exit',
      'Skip the failing task and proceed to next task'
    ]
  },
  {
    name: 'concurrency_and_ordering',
    question: 'How should task execution ordering be scheduled?',
    check: (content) => /concurrency|parallel|paralel|sequential|ordering|dependency|single execution unit/i.test(content),
    options: [
      '(Recommended) Execute sequentially by default, parallelizing only independent DAG tasks',
      'Execute all tasks sequentially without parallelization',
      'Execute all tasks concurrently with independent workers'
    ]
  },
  {
    name: 'state_persistence',
    question: 'Where should session state be persisted across runs?',
    check: (content) => /\.sdw\/state|state file|session state|\.state\.json/i.test(content),
    options: [
      '(Recommended) Persist to .sdw/state/{runId}.state.json',
      'Store ephemeral state in memory without writing to disk',
      'Persist state to repo root .state.json'
    ]
  }
];

function looksLikeProjectPath(rawToken) {
  const token = String(rawToken || '').replace(/^[("'`\[]+/, '').replace(/[)"'`\],.;:]+$/, '');
  if (!token) return null;
  if (/\s/.test(token)) return null;
  if (token.includes('*') || token.includes('{') || token.includes('<') || token.includes('>')) return null;
  if (/^(https?:|git@)/i.test(token)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(token)) return null;
  if (token.startsWith('/') || token.startsWith('-') || token.startsWith('~')) return null;
  const normalized = token.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.includes('/')) return null;
  if (!/\.[a-zA-Z0-9]{1,6}$/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

function extractTargetFiles(specContent) {
  if (!specContent) return [];
  const files = new Set();
  const push = (raw) => {
    const candidate = looksLikeProjectPath(raw);
    if (candidate) files.add(candidate);
  };

  // Backticked spans hold either one path or a command line that names paths.
  for (const match of specContent.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1].trim();
    push(span);
    for (const token of span.split(/\s+/)) push(token);
  }
  // Fenced code blocks hold CLI contracts and path templates.
  for (const match of specContent.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const token of match[1].split(/\s+/)) push(token);
  }
  return Array.from(files);
}

/**
 * A `New files` note declares paths the author intends to create. The
 * declaration is a promise, not a check: the path is carried into the plan even
 * though it does not exist yet.
 */
function extractDeclaredNewFiles(specContent) {
  const files = new Set();
  const collect = (text) => {
    for (const match of String(text || '').matchAll(/`([^`\n]+)`/g)) {
      for (const token of match[1].trim().split(/\s+/)) {
        const candidate = looksLikeProjectPath(token);
        if (candidate) files.add(candidate);
      }
    }
  };
  let mode = null;
  for (const line of String(specContent || '').split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      mode = /^new files\b/i.test(heading[1].trim()) ? 'section' : null;
      if (mode) collect(line);
      continue;
    }
    if (/^\s*(?:[-*+]\s+)?New files\b/i.test(line)) {
      mode = 'inline';
      collect(line);
      continue;
    }
    if (mode === 'section') {
      collect(line);
      continue;
    }
    if (mode === 'inline') {
      if (!line.trim()) {
        mode = null;
      } else if (/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line) || /^\s+\S/.test(line)) {
        collect(line);
      } else {
        mode = null;
      }
    }
  }
  return [...files];
}

function extractArchitecturalApproach(specContent) {
  if (!specContent) return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
  const designIntentMatch = specContent.match(/### Design Intent\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (designIntentMatch && designIntentMatch[1].trim()) {
    return designIntentMatch[1].trim().split('\n')[0].trim();
  }
  const descMatch = specContent.match(/## Description\s*\r?\n([\s\S]*?)(?=\r?\n### |\r?\n## |\r?\n$)/);
  if (descMatch && descMatch[1].trim()) {
    return descMatch[1].trim().split('\n')[0].trim();
  }
  return 'Implement canonical architecture conforming strictly to specification acceptance criteria.';
}

function extractTestPlan(specContent) {
  if (!specContent) return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
  const negMatch = specContent.match(/### Negative & Failing Test Scenarios\s*\r?\n([\s\S]*?)(?=\r?\n## |\r?\n$)/);
  if (negMatch && negMatch[1].trim()) {
    return negMatch[1].trim().split('\n')[0].replace(/^[-*+]\s+/, '').trim();
  }
  return 'Execute native automated test suite verifying all acceptance criteria and negative failure scenarios.';
}

function generateRefinementBlueprint(specContent, options = {}) {
  // Only paths the specification names, plus the files it declares new. A
  // pathless specification resolves no target file here: the planner falls back
  // to a verified bucket or refuses, and never synthesizes `skills/<slug>/...`
  // from the slug.
  let targetFiles = options.targetFiles || extractTargetFiles(specContent);
  if (!targetFiles || targetFiles.length === 0) {
    targetFiles = extractDeclaredNewFiles(specContent);
  }

  return {
    targetFiles,
    architecturalApproach: extractArchitecturalApproach(specContent),
    testPlan: extractTestPlan(specContent)
  };
}

function analyzeSpecificationGaps(specContent, options = {}) {
  const gaps = [];

  for (const dim of DECISION_DIMENSIONS) {
    const covered = dim.check(specContent);
    if (!covered) {
      gaps.push({
        dimension: dim.name,
        question: dim.question,
        options: dim.options,
        defaultChoice: dim.options[0]
      });
    }
  }

  const blueprint = generateRefinementBlueprint(specContent, options);

  return {
    hasGaps: gaps.length > 0,
    gapsCount: gaps.length,
    gaps,
    blueprint,
    decisionTreeWalk: {
      totalDimensionsChecked: DECISION_DIMENSIONS.length,
      coveredDimensions: DECISION_DIMENSIONS.length - gaps.length
    }
  };
}

function applyDecision(specContent, dimension, chosenOption) {
  const decisionNote = `\n<!-- Decision Gate: [${dimension}] -> ${chosenOption} -->\n`;
  if (specContent.includes('## Assumptions & Open Questions')) {
    return specContent.replace(
      '## Assumptions & Open Questions',
      `## Assumptions & Open Questions\n| ${dimension} | ${chosenOption.replace(/^\(Recommended\)\s*/, '')} | Grilling decision confirmed | y |\n`
    );
  }
  return specContent + decisionNote;
}

module.exports = {
  DECISION_DIMENSIONS,
  analyzeSpecificationGaps,
  applyDecision,
  generateRefinementBlueprint,
  extractDeclaredNewFiles,
  extractTargetFiles
};
