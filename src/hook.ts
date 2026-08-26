import * as fs from 'node:fs';
import * as path from 'node:path';

export const BLOCKED_WORKFLOW_PATTERNS = [
  /^\.agents\/plans\//i,
  /(^|\/)MEMORY\.md$/i,
  /(^|\/)memory\/.*\.md$/i
];

export const ALLOWED_PRODUCT_DOCS = [
  'README.md',
  'PRODUCT.PRD',
  'FEATURES.md',
  'PLAN.md',
  'AGENTS.md',
  'GEMINI.md',
  '.agents/specs/index.PRD'
];

/**
 * AC1 & AC3: Test if a staged path is a blocked workflow artifact vs allowed product file.
 */
export function isBlockedWorkflowPath(filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  // Express allowed product docs
  if (ALLOWED_PRODUCT_DOCS.includes(normPath)) {
    return false;
  }

  return BLOCKED_WORKFLOW_PATTERNS.some((pattern) => pattern.test(normPath));
}

/**
 * AC2 & AC4: Shell script content for git pre-commit hook with bypass check.
 */
export function generatePreCommitHookScript(): string {
  return `#!/bin/sh
# spec-memo pre-commit write-block hook

if [ "$SKIP_MEMO_HOOK" = "1" ]; then
  exit 0
fi

STAGED_FILES=$(git diff --cached --name-only)
BLOCKED=0

for file in $STAGED_FILES; do
  case "$file" in
    .agents/plans/*|*/MEMORY.md|MEMORY.md|*/memory/*.md)
      case "$file" in
        README.md|PRODUCT.PRD|FEATURES.md|PLAN.md|AGENTS.md|GEMINI.md|.agents/specs/index.PRD)
          ;;
        *)
          echo "ERROR: spec-memo blocked staged workflow artifact: $file"
          echo "Workflow memory and plans must be saved to spec-memo vault using MCP / memo CLI, not committed in product git."
          echo "To override in emergency, use: SKIP_MEMO_HOOK=1 git commit or git commit --no-verify"
          BLOCKED=1
          ;;
      esac
      ;;
  esac
done

if [ "$BLOCKED" -eq 1 ]; then
  exit 1
fi
`;
}

/**
 * Install pre-commit hook into target git repository.
 */
export function installPreCommitHook(targetRepoPath: string = process.cwd()): { installed: boolean; path: string } {
  const gitHooksDir = path.join(targetRepoPath, '.git', 'hooks');
  if (!fs.existsSync(gitHooksDir)) {
    fs.mkdirSync(gitHooksDir, { recursive: true });
  }

  const hookPath = path.join(gitHooksDir, 'pre-commit');
  const scriptContent = generatePreCommitHookScript();

  const hookMarker = 'spec-memo pre-commit write-block hook';
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (!existing.includes(hookMarker)) {
      fs.copyFileSync(hookPath, `${hookPath}.spec-memo.bak`);
    }
  }

  fs.writeFileSync(hookPath, scriptContent, { mode: 0o755 });

  return {
    installed: true,
    path: hookPath
  };
}
