declare module '@cursor/sdk' {
  export interface CursorModelSelection {
    id: string;
    params?: Array<{ id: string; value: string }>;
  }
  export interface CursorAgentCreateOptions {
    apiKey?: string;
    model?: CursorModelSelection;
    local?: { cwd?: string };
    cloud?: {
      repos?: Array<{ url: string; startingRef?: string }> | [];
      metadata?: Record<string, string>;
    };
    [key: string]: unknown;
  }
  export interface CursorRunResult {
    status: 'finished' | 'error' | 'cancelled';
    result?: string;
    error?: { message?: string; code?: string };
  }
  export interface CursorRun {
    readonly id: string;
    readonly agentId: string;
    supports(operation: 'cancel'): boolean;
    cancel(): Promise<void>;
    wait(): Promise<CursorRunResult>;
  }
  export interface CursorAgentHandle {
    readonly agentId?: string;
    send(message: string): Promise<CursorRun>;
    [Symbol.asyncDispose](): Promise<void>;
  }
  export const Agent: {
    create(options: CursorAgentCreateOptions): CursorAgentHandle;
    prompt(message: string, options?: CursorAgentCreateOptions): Promise<CursorRunResult>;
    cancelRun(
      runId: string,
      options: { runtime: 'cloud'; agentId: string; apiKey?: string }
    ): Promise<void>;
    archive(agentId: string, options?: { apiKey?: string }): Promise<void>;
    delete(agentId: string, options?: { apiKey?: string }): Promise<void>;
    list(options: {
      runtime: 'cloud';
      apiKey?: string;
      includeArchived?: boolean;
      limit?: number;
      cursor?: string;
    }): Promise<{
      items: Array<{
        agentId: string;
        status?: 'running' | 'finished' | 'error';
        metadata?: Record<string, string>;
      }>;
      nextCursor?: string;
    }>;
  };
}
