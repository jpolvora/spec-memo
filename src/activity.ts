import crypto from "node:crypto";
import { redactAbsolutePathsInText, redactSecretsInPayload } from "./safety.js";
import { ClientType, VaultClientInfo } from "./types.js";

export type ActivityEventType = "http" | "tool" | "system";
export type ActivityEventKind = "read" | "write" | "meta";

export interface ActivityEvent {
  id: string;
  seq: number;
  ts: string;
  type: ActivityEventType;
  kind: ActivityEventKind;
  ok: boolean;
  durationMs: number;
  summary: string;
  tool?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  projectId?: string;
  clientIp?: string;
  clientName?: string;
  clientType?: ClientType;
  operation?: string;
}

export type ActivityCaptureInput = {
  type: ActivityEventType;
  kind: ActivityEventKind;
  ok: boolean;
  durationMs: number;
  summary: string;
  tool?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  projectId?: string;
  clientIp?: string;
  clientName?: string;
  clientType?: ClientType;
  operation?: string;
};

export interface ActivityFilter {
  projectId?: string;
}

export interface ActivityBus {
  capture(input: ActivityCaptureInput): ActivityEvent | null;
  list(filter?: ActivityFilter): ActivityEvent[];
  subscribe(listener: (event: ActivityEvent) => void, filter?: ActivityFilter): () => void;
  registerClient(info: Partial<VaultClientInfo> & { ip: string }): VaultClientInfo;
  updateClientActivity(id: string, update: { operation?: string; projectId?: string; clientName?: string }): void;
  disconnectClient(id: string): void;
  listClients(): VaultClientInfo[];
  close(): void;
  readonly startedAt: number;
  readonly capacity: number;
}

function sanitizeString(value: string): string {
  const redacted = redactSecretsInPayload(value) as string;
  return redactAbsolutePathsInText(redacted).slice(0, 500);
}

function sanitizeEvent(input: ActivityCaptureInput): ActivityCaptureInput {
  return {
    ...input,
    summary: sanitizeString(input.summary),
    tool: input.tool ? sanitizeString(input.tool) : undefined,
    method: input.method ? sanitizeString(input.method) : undefined,
    path: input.path ? sanitizeString(input.path) : undefined,
    projectId: input.projectId ? sanitizeString(input.projectId) : undefined,
    clientIp: input.clientIp ? sanitizeString(input.clientIp) : undefined,
    clientName: input.clientName ? sanitizeString(input.clientName) : undefined,
    clientType: input.clientType,
    operation: input.operation ? sanitizeString(input.operation) : undefined
  };
}

export function eventMatchesProjectFilter(event: ActivityEvent, projectId?: string): boolean {
  if (!projectId) {
    return true;
  }
  return !event.projectId || event.projectId === projectId;
}

const MAX_CLIENT_REGISTRY = 100;

function trimClients(clients: Map<string, VaultClientInfo>): void {
  if (clients.size <= MAX_CLIENT_REGISTRY) return;
  const entries = Array.from(clients.entries()).sort(
    (a, b) => new Date(a[1].lastSeenAt).getTime() - new Date(b[1].lastSeenAt).getTime()
  );
  const toRemove = clients.size - MAX_CLIENT_REGISTRY;
  for (let i = 0; i < toRemove; i++) {
    clients.delete(entries[i][0]);
  }
}

export function createActivityBus(options: { capacity?: number } = {}): ActivityBus {
  const capacity = options.capacity ?? 200;
  const buffer: ActivityEvent[] = [];
  const clients = new Map<string, VaultClientInfo>();
  const subscribers = new Set<{
    listener: (event: ActivityEvent) => void;
    filter?: ActivityFilter;
  }>();
  let seq = 0;
  let closed = false;
  const startedAt = Date.now();

  function emit(event: ActivityEvent): void {
    for (const sub of subscribers) {
      if (eventMatchesProjectFilter(event, sub.filter?.projectId)) {
        try {
          sub.listener(event);
        } catch {
          // ignore subscriber errors
        }
      }
    }
  }

  return {
    startedAt,
    capacity,
    capture(input: ActivityCaptureInput): ActivityEvent | null {
      if (closed) {
        return null;
      }
      const clean = sanitizeEvent(input);
      seq += 1;
      const event: ActivityEvent = {
        id: `evt-${crypto.randomBytes(4).toString("hex")}`,
        seq,
        ts: new Date().toISOString(),
        type: clean.type,
        kind: clean.kind,
        ok: clean.ok,
        durationMs: Math.max(0, Math.round(clean.durationMs)),
        summary: clean.summary
      };
      if (clean.tool) event.tool = clean.tool;
      if (clean.method) event.method = clean.method;
      if (clean.path) event.path = clean.path;
      if (clean.statusCode != null) event.statusCode = clean.statusCode;
      if (clean.projectId) event.projectId = clean.projectId;
      if (clean.clientIp) event.clientIp = clean.clientIp;
      if (clean.clientName) event.clientName = clean.clientName;
      if (clean.clientType) event.clientType = clean.clientType;
      if (clean.operation) event.operation = clean.operation;

      buffer.push(event);
      if (buffer.length > capacity) {
        buffer.shift();
      }
      emit(event);
      return event;
    },
    list(filter?: ActivityFilter): ActivityEvent[] {
      return buffer.filter((e) => eventMatchesProjectFilter(e, filter?.projectId));
    },
    subscribe(listener: (event: ActivityEvent) => void, filter?: ActivityFilter): () => void {
      const entry = { listener, filter };
      subscribers.add(entry);
      return () => {
        subscribers.delete(entry);
      };
    },
    registerClient(info: Partial<VaultClientInfo> & { ip: string }): VaultClientInfo {
      const now = new Date().toISOString();
      const id = info.id || `${info.ip}::${info.clientName || 'client'}`;
      const existing = clients.get(id);
      const updated: VaultClientInfo = {
        id,
        ip: info.ip,
        clientName: info.clientName || existing?.clientName || 'MCP Client',
        clientType: info.clientType || existing?.clientType || 'direct-remote',
        userAgent: info.userAgent || existing?.userAgent,
        projectId: info.projectId || existing?.projectId,
        lastOperation: info.lastOperation || existing?.lastOperation,
        connectedAt: existing?.connectedAt || now,
        lastSeenAt: now,
        active: info.active !== false,
        requestCount: (existing?.requestCount || 0) + 1
      };
      clients.set(id, updated);
      trimClients(clients);
      return updated;
    },
    updateClientActivity(id: string, update: { operation?: string; projectId?: string; clientName?: string }): void {
      const existing = clients.get(id);
      if (existing) {
        if (update.operation) existing.lastOperation = update.operation;
        if (update.projectId) existing.projectId = update.projectId;
        if (update.clientName) existing.clientName = update.clientName;
        existing.lastSeenAt = new Date().toISOString();
        existing.requestCount = (existing.requestCount || 0) + 1;
        existing.active = true;
      }
    },
    disconnectClient(id: string): void {
      const existing = clients.get(id);
      if (existing) {
        existing.active = false;
        existing.lastSeenAt = new Date().toISOString();
        trimClients(clients);
      }
    },
    listClients(): VaultClientInfo[] {
      return Array.from(clients.values()).sort(
        (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      );
    },
    close(): void {
      closed = true;
      subscribers.clear();
      clients.clear();
    }
  };
}
