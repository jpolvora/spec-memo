import test from "node:test";
import assert from "node:assert";
import { createActivityBus, eventMatchesProjectFilter } from "./activity.js";

test("Activity Event Bus", async (t) => {
  await t.test("capture assigns monotonic seq and emits to subscribers", () => {
    const bus = createActivityBus({ capacity: 200 });
    const seen: number[] = [];
    bus.subscribe((ev) => seen.push(ev.seq));

    const first = bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 5,
      summary: "search traps",
      tool: "search"
    });
    const second = bus.capture({
      type: "http",
      kind: "meta",
      ok: true,
      durationMs: 2,
      summary: "GET /health 200",
      method: "GET",
      path: "/health",
      statusCode: 200
    });

    assert.ok(first);
    assert.ok(second);
    assert.strictEqual(first!.seq, 1);
    assert.strictEqual(second!.seq, 2);
    assert.deepStrictEqual(seen, [1, 2]);
    bus.close();
  });

  await t.test("list and subscribe honor project filter inclusion rules", () => {
    const bus = createActivityBus({ capacity: 50 });
    bus.capture({
      type: "tool",
      kind: "write",
      ok: true,
      durationMs: 1,
      summary: "upsert trap",
      tool: "upsert",
      projectId: "proj-a"
    });
    bus.capture({
      type: "http",
      kind: "meta",
      ok: true,
      durationMs: 1,
      summary: "GET /health 200",
      method: "GET",
      path: "/health",
      statusCode: 200
    });
    bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "search other",
      tool: "search",
      projectId: "proj-b"
    });

    const filtered = bus.list({ projectId: "proj-a" });
    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.some((e) => e.projectId === "proj-a"));
    assert.ok(filtered.some((e) => e.type === "http" && !e.projectId));

    const subSeen: string[] = [];
    bus.subscribe((e) => subSeen.push(e.summary), { projectId: "proj-a" });
    bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "another proj-a",
      projectId: "proj-a"
    });
    bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "proj-b only",
      projectId: "proj-b"
    });
    assert.deepStrictEqual(subSeen, ["another proj-a"]);
    bus.close();
  });

  await t.test("ring buffer drops oldest while seq continues", () => {
    const bus = createActivityBus({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      bus.capture({
        type: "system",
        kind: "meta",
        ok: true,
        durationMs: 0,
        summary: `event-${i}`
      });
    }
    const list = bus.list();
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0].summary, "event-2");
    assert.strictEqual(list[2].seq, 5);
    bus.close();
  });

  await t.test("close rejects further captures", () => {
    const bus = createActivityBus();
    bus.close();
    assert.strictEqual(bus.capture({
      type: "system",
      kind: "meta",
      ok: true,
      durationMs: 0,
      summary: "after close"
    }), null);
  });

  await t.test("sanitizes absolute paths in summary", () => {
    const bus = createActivityBus();
    const ev = bus.capture({
      type: "tool",
      kind: "read",
      ok: true,
      durationMs: 1,
      summary: "read C:\\Users\\secret\\vault\\trap.md"
    });
    assert.ok(ev);
    assert.ok(!ev!.summary.includes("C:\\Users"));
    assert.ok(ev!.summary.includes("[path]"));
    bus.close();
  });

  await t.test("eventMatchesProjectFilter helper", () => {
    assert.strictEqual(eventMatchesProjectFilter({ projectId: "a" } as any, undefined), true);
    assert.strictEqual(eventMatchesProjectFilter({ projectId: "a" } as any, "a"), true);
    assert.strictEqual(eventMatchesProjectFilter({} as any, "a"), true);
    assert.strictEqual(eventMatchesProjectFilter({ projectId: "b" } as any, "a"), false);
  });

  await t.test("tracks and updates vault clients", () => {
    const bus = createActivityBus();
    const client = bus.registerClient({
      id: "client-1",
      ip: "192.168.1.50",
      clientName: "Cursor IDE",
      clientType: "direct-remote",
      projectId: "spec-memo",
      lastOperation: "bootstrap"
    });

    assert.strictEqual(client.id, "client-1");
    assert.strictEqual(client.ip, "192.168.1.50");
    assert.strictEqual(client.clientName, "Cursor IDE");
    assert.strictEqual(client.clientType, "direct-remote");
    assert.strictEqual(client.active, true);
    assert.strictEqual(client.requestCount, 1);

    bus.updateClientActivity("client-1", {
      operation: "mcp:upsert",
      projectId: "spec-memo"
    });

    const list = bus.listClients();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].lastOperation, "mcp:upsert");
    assert.strictEqual(list[0].requestCount, 2);
    assert.strictEqual(list[0].active, true);

    bus.disconnectClient("client-1");
    const afterDisconnect = bus.listClients();
    assert.strictEqual(afterDisconnect[0].active, false);

    bus.close();
  });
});
