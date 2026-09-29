import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";
import {
  UNAUTH_LOG_MAX_SLOTS,
  UNAUTH_LOG_WINDOW_MS,
  clientIpFromRequest,
  decideUnauthorizedLog,
  resetUnauthorizedLogStateForTests,
  unauthorizedLogSlotCountForTests
} from "./auth-noise.js";

test("auth-noise throttle identity and bounds", async (t) => {
  t.afterEach(() => {
    resetUnauthorizedLogStateForTests();
  });

  await t.test("clientIpFromRequest prefers socket address and ignores X-Forwarded-For", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.99, 10.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as http.IncomingMessage;
    assert.equal(clientIpFromRequest(req), "127.0.0.1");
  });

  await t.test("decideUnauthorizedLog emits full then one rollup then suppress", () => {
    const t0 = 1_000_000;
    assert.equal(decideUnauthorizedLog("sse:127.0.0.1", t0).action, "full");
    assert.equal(decideUnauthorizedLog("sse:127.0.0.1", t0 + 1).action, "rollup");
    assert.equal(decideUnauthorizedLog("sse:127.0.0.1", t0 + 2).action, "suppress");
    assert.equal(decideUnauthorizedLog("sse:127.0.0.1", t0 + 3).additionalAfterFirst, 3);
  });

  await t.test("new window after UNAUTH_LOG_WINDOW_MS emits full again", () => {
    const t0 = 2_000_000;
    assert.equal(decideUnauthorizedLog("status:127.0.0.1", t0).action, "full");
    assert.equal(
      decideUnauthorizedLog("status:127.0.0.1", t0 + UNAUTH_LOG_WINDOW_MS).action,
      "full"
    );
  });

  await t.test("slot map never exceeds UNAUTH_LOG_MAX_SLOTS", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < UNAUTH_LOG_MAX_SLOTS + 50; i++) {
      decideUnauthorizedLog(`flood:${i}`, t0 + i);
    }
    assert.ok(unauthorizedLogSlotCountForTests() <= UNAUTH_LOG_MAX_SLOTS);
  });
});
