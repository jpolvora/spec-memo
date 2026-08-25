import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord, serializeRecord, validateFrontmatter } from './schema.js';
import { RecordFrontmatter } from './types.js';

describe('Record Schema and Frontmatter Validation', () => {
  it('should validate valid frontmatter with all required fields', () => {
    const validFm: RecordFrontmatter = {
      id: 'trap-no-direct-eval',
      kind: 'trap',
      project: 'github.com-test-repo',
      status: 'active',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: 'agent',
      severity: 'critical',
      pathPatterns: ['src/**/*.ts']
    };

    const result = validateFrontmatter(validFm);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.id, 'trap-no-direct-eval');
      assert.equal(result.data.severity, 'critical');
    }
  });

  it('should fail validation when required fields are missing', () => {
    const invalidFm = {
      kind: 'trap',
      status: 'active'
    };

    const result = validateFrontmatter(invalidFm);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.includes('id')));
      assert.ok(result.errors.some((e) => e.includes('project')));
    }
  });

  it('should fail validation on invalid record kind or status', () => {
    const invalidFm = {
      id: 'test-1',
      kind: 'unknown-kind',
      project: 'proj-1',
      status: 'invalid-status',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: 'agent'
    };

    const result = validateFrontmatter(invalidFm);
    assert.equal(result.success, false);
  });

  it('should parse and serialize markdown records with YAML frontmatter', () => {
    const rawMarkdown = `---
id: trap-test-sample
kind: trap
project: proj-sample
status: active
created: 2026-08-23T12:00:00.000Z
updated: 2026-08-23T12:00:00.000Z
source: agent
severity: high
pathPatterns:
  - src/**/*.js
---

# Trap description

Do not use raw eval.
`;

    const record = parseRecord(rawMarkdown);
    assert.equal(record.frontmatter.id, 'trap-test-sample');
    assert.equal(record.frontmatter.severity, 'high');
    assert.equal(record.frontmatter.kind, 'trap');
    assert.ok(record.body.includes('Do not use raw eval'));

    const serialized = serializeRecord(record);
    assert.ok(serialized.startsWith('---'));
    assert.ok(serialized.includes('id: trap-test-sample'));
    assert.ok(serialized.includes('Do not use raw eval'));
  });
});
