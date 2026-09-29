import type http from "node:http";

/** Fixed window for collapsing repeated unauthorized WARN blocks (us-87). */
export const UNAUTH_LOG_WINDOW_MS = 60_000;

export type UnauthLogAction = "full" | "rollup" | "suppress";

type Slot = {
  windowStart: number;
  count: number;
  fullLogged: boolean;
  rollupLogged: boolean;
};

const slots = new Map<string, Slot>();

/**
 * Decide whether to emit a full unauthorized WARN, a single rollup, or suppress.
 * Key typically `${subsystem}:${clientIp}`.
 */
export function decideUnauthorizedLog(
  clientKey: string,
  now = Date.now()
): { action: UnauthLogAction; totalInWindow: number; additionalAfterFirst: number } {
  let slot = slots.get(clientKey);
  if (!slot || now - slot.windowStart >= UNAUTH_LOG_WINDOW_MS) {
    slot = { windowStart: now, count: 0, fullLogged: false, rollupLogged: false };
    slots.set(clientKey, slot);
  }
  slot.count += 1;
  if (!slot.fullLogged) {
    slot.fullLogged = true;
    return { action: "full", totalInWindow: slot.count, additionalAfterFirst: 0 };
  }
  if (!slot.rollupLogged) {
    slot.rollupLogged = true;
    return {
      action: "rollup",
      totalInWindow: slot.count,
      additionalAfterFirst: slot.count - 1
    };
  }
  return {
    action: "suppress",
    totalInWindow: slot.count,
    additionalAfterFirst: slot.count - 1
  };
}

/** Test-only: clear in-memory windows between cases. */
export function resetUnauthorizedLogStateForTests(): void {
  slots.clear();
}

export function clientIpFromRequest(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

export function unauthorizedClientKey(subsystem: string, clientIp: string): string {
  return `${subsystem}:${clientIp}`;
}
