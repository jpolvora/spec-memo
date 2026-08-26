import crypto from "node:crypto";
import { redactAbsolutePathsInText, redactSecretsInPayload } from "./safety.js";

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
};

export interface ActivityFilter {
  projectId?: string;
}

export interface ActivityBus {
  capture(input: ActivityCaptureInput): ActivityEvent | null;
  list(filter?: ActivityFilter): ActivityEvent[];
  subscribe(listener: (event: ActivityEvent) => void, filter?: ActivityFilter): () => void;
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
    projectId: input.projectId ? sanitizeString(input.projectId) : undefined
  };
}

export function eventMatchesProjectFilter(event: ActivityEvent, projectId?: string): boolean {
  if (!projectId) {
    return true;
  }
  return !event.projectId || event.projectId === projectId;
}

export function createActivityBus(options: { capacity?: number } = {}): ActivityBus {
  const capacity = options.capacity ?? 200;
  const buffer: ActivityEvent[] = [];
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
    close(): void {
      closed = true;
      subscribers.clear();
    }
  };
}
