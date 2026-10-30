'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function isGitTracked(root, rel) {
  try {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, encoding: 'utf8', stdio: 'ignore' });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Validates task evidence against canonical SDW task evidence schema (Spec 015).
 * 
 * @param {object} evidence - Parsed evidence JSON object
 * @param {object} options - Validation context:
 *   - expectedTaskId {string}: Expected DAG task ID
 *   - specAcs {string[]|object[]}: Known AC IDs from specification
 *   - projectRoot {string}: Root directory of project
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvidence(evidence, options = {}) {
  const errors = [];

  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, errors: ['Evidence must be a JSON object.'] };
  }

  const { expectedTaskId, specAcs, projectRoot, allowEmptyFilesChanged } = options;
  const root = projectRoot ? path.resolve(projectRoot) : process.cwd();

  // 1. taskId
  if (!evidence.taskId || typeof evidence.taskId !== 'string') {
    errors.push('Missing or invalid "taskId": must be a non-empty string.');
  } else if (expectedTaskId && evidence.taskId !== expectedTaskId) {
    errors.push(`"taskId" mismatch: expected "${expectedTaskId}", got "${evidence.taskId}".`);
  }

  // 2. acIds
  const validAcIds = new Set();
  if (Array.isArray(specAcs)) {
    for (const a of specAcs) {
      if (typeof a === 'string') {
        validAcIds.add(a.trim());
      } else if (a && typeof a.id === 'string') {
        validAcIds.add(a.id.trim());
      }
    }
  }

  if (!Array.isArray(evidence.acIds) || evidence.acIds.length === 0) {
    errors.push('"acIds" must be a non-empty array of acceptance criterion identifiers.');
  } else {
    for (const acId of evidence.acIds) {
      if (typeof acId !== 'string' || acId.trim().length === 0) {
        errors.push(`Invalid AC ID in "acIds": must be a non-empty string.`);
      } else if (validAcIds.size > 0 && !validAcIds.has(acId.trim())) {
        errors.push(`Unknown acceptance criterion "${acId}": not found in specification.`);
      }
    }
  }

  // 3. filesChanged (a second-pass refinement may honestly change nothing)
  if (!Array.isArray(evidence.filesChanged) || (evidence.filesChanged.length === 0 && !allowEmptyFilesChanged)) {
    errors.push(allowEmptyFilesChanged
      ? '"filesChanged" must be an array of project-relative file paths.'
      : '"filesChanged" must be a non-empty array of project-relative file paths.');
  } else {
    for (const relPath of evidence.filesChanged) {
      if (typeof relPath !== 'string' || relPath.trim().length === 0) {
        errors.push(`Invalid file path in "filesChanged": must be a non-empty string.`);
        continue;
      }

      const normalized = normalizePath(relPath.trim());

      // Absolute path check (POSIX leading / or Windows C:/)
      if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
        errors.push(`File path "${relPath}" must be relative to the project root, not absolute.`);
        continue;
      }

      // Traversal check
      const segments = normalized.split('/');
      if (segments.includes('..')) {
        errors.push(`File path "${relPath}" must not contain path traversal ("..").`);
        continue;
      }

      // .git directory check
      if (segments[0] === '.git') {
        errors.push(`File path "${relPath}" cannot reference files inside ".git/".`);
        continue;
      }

      // Existence check on disk
      const absPath = path.resolve(root, normalized);
      // Ensure resolved path is strictly inside project root
      const relativeToRoot = path.relative(root, absPath);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        errors.push(`File path "${relPath}" resolves outside of project root.`);
        continue;
      }

      if (!fs.existsSync(absPath)) {
        if (isGitTracked(root, normalized)) {
          continue;
        }
        errors.push(`File "${relPath}" listed in "filesChanged" does not exist on disk.`);
      }
    }
  }

  // 4. tests (optional, can be empty array for non-testable tasks per AC16)
  if ('tests' in evidence && evidence.tests !== undefined && evidence.tests !== null) {
    if (!Array.isArray(evidence.tests)) {
      errors.push('"tests" must be an array when provided.');
    } else {
      const allowedStatuses = ['passed', 'failed', 'skipped'];
      evidence.tests.forEach((t, idx) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push(`Test entry at index ${idx} must be an object.`);
          return;
        }
        if (!t.name || typeof t.name !== 'string' || t.name.trim().length === 0) {
          errors.push(`Test entry at index ${idx} must contain a non-empty "name".`);
        }
        if (!t.status || typeof t.status !== 'string' || !allowedStatuses.includes(t.status)) {
          errors.push(`Test entry at index ${idx} has invalid status "${t.status}": must be one of ${allowedStatuses.join(', ')}.`);
        }
        if ('command' in t && t.command !== null && typeof t.command !== 'string') {
          errors.push(`Test entry at index ${idx} "command" must be a string if provided.`);
        }
      });
    }
  }

  // 5. summary
  if (!evidence.summary || typeof evidence.summary !== 'string' || evidence.summary.trim().length === 0) {
    errors.push('"summary" must be a non-empty string.');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? evidence : null
  };
}

/**
 * Reads and validates a task evidence JSON file from disk.
 * 
 * @param {string} evidenceFilePath - Path to evidence JSON file
 * @param {object} options - Validation options
 * @returns {{ valid: boolean, errors: string[], data: object|null }}
 */
function validateEvidenceFile(evidenceFilePath, options = {}) {
  const root = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const absPath = path.isAbsolute(evidenceFilePath) ? evidenceFilePath : path.resolve(root, evidenceFilePath);

  if (!fs.existsSync(absPath)) {
    return {
      valid: false,
      errors: [`Evidence file does not exist: "${normalizePath(evidenceFilePath)}".`],
      data: null
    };
  }

  let parsed = null;
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to parse evidence JSON file: ${err.message}.`],
      data: null
    };
  }

  const result = validateEvidence(parsed, options);
  return {
    valid: result.valid,
    errors: result.errors,
    data: parsed
  };
}

module.exports = {
  validateEvidence,
  validateEvidenceFile
};
