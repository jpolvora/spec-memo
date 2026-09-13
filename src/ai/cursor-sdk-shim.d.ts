declare module '@cursor/sdk' {
  export interface CursorModelSelection {
    id: string;
    params?: Array<{ id: string; value: string }>;
  }
  export interface CursorAgentCreateOptions {
    apiKey?: string;
    model?: CursorModelSelection;
    local?: { cwd?: string };
    cloud?: { repos?: Array<{ url: string; startingRef?: string }> | [] };
    [key: string]: unknown;
  }
  export interface CursorRunResult {
    status: 'finished' | 'error' | 'cancelled';
    result?: string;
    error?: { message: string; code?: string };
  }
  export const Agent: {
    create(options: CursorAgentCreateOptions): Promise<unknown>;
    prompt(message: string, options?: CursorAgentCreateOptions): Promise<CursorRunResult>;
  };
}
