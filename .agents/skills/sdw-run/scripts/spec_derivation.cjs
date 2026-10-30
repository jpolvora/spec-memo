'use strict';

const fs = require('fs');
const path = require('path');

function isAgentReadySpec(content) {
  const hasYamlFm = /^---\s*\n[\s\S]*?\n---\s*\n?/.test(content);
  const hasAcceptanceCriteria = /##\s+Acceptance Criteria\b/i.test(content);
  const hasEarsPatterns = /^- AC\d+:\s*(?:The\s+.+\s+shall|When\s+.+,\s*the\s+.+\s+shall|While\s+.+,\s*the\s+.+\s+shall|Where\s+.+,\s*the\s+.+\s+shall|If\s+.+,\s*then\s+the\s+.+\s+shall)/im.test(content);
  const hasDor = /##\s+Definition of Ready\b/i.test(content);

  // If YAML frontmatter exists with EARS-pattern ACs, it is already agent-ready
  return hasYamlFm && hasAcceptanceCriteria && hasEarsPatterns && hasDor;
}

function deriveAgentSpec(humanSpecContent, options) {
  if (isAgentReadySpec(humanSpecContent)) {
    return {
      derivationNeeded: false,
      reason: 'Spec is already formatted with agent-ready EARS acceptance criteria and DoR.',
      specContent: humanSpecContent
    };
  }

  // Derive agentic spec from human-friendly text
  const titleMatch = humanSpecContent.match(/^#+\s+(.+)$/m) || [null, 'Derived Feature Specification'];
  const title = titleMatch[1].replace(/^[#\s]+/, '').trim();
  const slug = (options && options.slug) || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'feature';

  // Extract lines to detect stories or goals
  const lines = humanSpecContent.split('\n');
  const bullets = lines
    .map(l => l.trim())
    .filter(l => /^[-*]\s+/.test(l))
    .map(l => l.replace(/^[-*]\s+/, ''));

  const acList = [];
  if (bullets.length > 0) {
    bullets.forEach((bullet, idx) => {
      // Convert to EARS ubiquitous or event-driven
      let acText = bullet;
      if (!/shall/i.test(acText)) {
        acText = `The system shall satisfy requirement: ${bullet}`;
      } else if (!/^(The|When|While|Where|If)\b/i.test(acText)) {
        acText = `The system shall ${bullet.replace(/^[a-z]/, c => c.toLowerCase())}`;
      }
      acList.push(`- AC${idx + 1}: ${acText}`);
    });
  } else {
    acList.push(`- AC1: The system shall implement the technical scope described in the feature specification.`);
    acList.push(`- AC2: When execution runs, the system shall validate input integrity and handle failure scenarios.`);
  }

  const derived = `---
id: null
slug: ${slug}
title: "${title}"
source: local
specDate: ${new Date().toISOString().slice(0, 10)}
---

# Specification — ${title}

## Description

${humanSpecContent.trim()}

### Design Intent

Automated derivation from human-friendly source requirement into an agent-executable specification with structured acceptance criteria.

## Acceptance Criteria

${acList.join('\n')}

## Original Issue Context

${humanSpecContent.trim()}

## Notes

- Derived from human-authored input. Verify integration boundaries before task decomposition.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Unrelated system modifications | Scope is bounded strictly to the requested feature requirements |

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale | Confirmed |
|------------|----------------|-----------|-----------|
| Architecture alignment | Follow existing workspace standards | Ensures minimal divergence | y |
| Absent lifecycle dimensions | N/A because derived feature executes within existing component bounds | Local component feature | y |

## Definition of Ready (DoR)

| Readiness Item | Requirement | Verification Method |
|----------------|-------------|---------------------|
| Specification criteria | Atomic EARS ACs derived | Automated inspection |
| Project configuration | Workspace .sdw/ configuration is present | sdw-config check |

## Validation & Observation Notes

### Telemetry & Observable Signals

- Conformance check outputs and test execution traces.

### Negative & Failing Test Scenarios

- Rejection test case for invalid or malformed inputs before happy path execution.
`;

  return {
    derivationNeeded: true,
    reason: 'Derived agent-ready specification from human-friendly input.',
    specContent: derived
  };
}

module.exports = {
  isAgentReadySpec,
  deriveAgentSpec
};
