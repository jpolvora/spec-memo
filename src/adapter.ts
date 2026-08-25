import { compileBootstrapBrief } from './bootstrap.js';
import { upsertRecord, appendEvent, UpsertResult } from './store.js';
import { getVaultRoot } from './vault.js';
import { BootstrapBrief, AppendResult } from './types.js';

export interface RecordTrapInput {
  scenario: string;
  doNot: string;
  insteadDo: string;
  pathPatterns?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
  layer?: string;
  module?: string;
}

export class MemoryAdapter {
  constructor(private vaultRoot: string = getVaultRoot()) {}

  /**
   * AC1: Session bootstrap loading path-relevant traps within 8 KB budget
   */
  async readMemoryBootstrap(cwd: string, query?: string): Promise<BootstrapBrief> {
    return compileBootstrapBrief({
      cwd,
      query,
      vaultRoot: this.vaultRoot
    });
  }

  /**
   * AC2: Anti-regression trap recording using upsert engine
   */
  async updateMemoryTrap(cwd: string, trap: RecordTrapInput): Promise<UpsertResult> {
    const slug = `trap-${trap.scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
    const body = `## Scenario\n${trap.scenario}\n\n## DO NOT\n${trap.doNot}\n\n## INSTEAD DO\n${trap.insteadDo}\n`;

    return upsertRecord({
      cwd,
      vaultRoot: this.vaultRoot,
      kind: 'trap',
      slug,
      frontmatter: {
        title: trap.scenario,
        pathPatterns: trap.pathPatterns || [],
        severity: trap.severity || 'medium',
        layer: trap.layer,
        module: trap.module,
        tags: trap.tags || []
      },
      body
    });
  }

  /**
   * AC3: Task completion changelog appending using write-only append log engine
   */
  async updateMemoryLog(cwd: string, logMessage: string, details?: Record<string, unknown>): Promise<AppendResult> {
    return appendEvent({
      cwd,
      vaultRoot: this.vaultRoot,
      event: logMessage,
      details
    });
  }
}
