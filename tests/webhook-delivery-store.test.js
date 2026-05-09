"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  WebhookDeliveryStore,
  generateDeliveryId,
  normalizeDelivery,
  STATUSES
} = require("../lib/webhook-delivery-store");

function tempPath(name = "webhook-deliveries.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-deliv-"));
  return path.join(dir, name);
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

describe("webhook-delivery-store helpers", () => {
  test("generateDeliveryId returns a base64url id", () => {
    const id = generateDeliveryId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeGreaterThanOrEqual(20);
  });

  test("STATUSES contains all expected values", () => {
    expect(STATUSES).toEqual(["queued", "running", "succeeded", "failed", "canceled"]);
  });

  test("normalizeDelivery rejects invalid status", () => {
    expect(() => normalizeDelivery({
      id: "abc",
      subscriptionId: "sub1",
      event: "a.b",
      status: "weird",
      attempts: 0,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_DELIVERY" }));
  });

  test("normalizeDelivery clamps responseSnippet", () => {
    const out = normalizeDelivery({
      id: "abc",
      subscriptionId: "sub1",
      event: "a.b",
      status: "succeeded",
      attempts: 1,
      responseSnippet: "x".repeat(8000),
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    });
    expect(out.responseSnippet.length).toBe(4096);
  });
});

describe("WebhookDeliveryStore", () => {
  let store;
  let filePath;

  beforeEach(() => {
    filePath = tempPath();
    store = new WebhookDeliveryStore({ filePath, now: frozenNow(), historyMax: 5 });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  test("enqueue creates a queued row", async () => {
    const delivery = await store.enqueue({
      subscriptionId: "sub1",
      event: "a.b",
      url: "https://example.com"
    });
    expect(delivery.status).toBe("queued");
    expect(delivery.attempts).toBe(0);
    expect(delivery.subscriptionId).toBe("sub1");
    expect(delivery.event).toBe("a.b");
    expect(delivery.url).toBe("https://example.com");
  });

  test("update moves to running with attempts and clears nextAttemptAt", async () => {
    const d = await store.enqueue({ subscriptionId: "sub1", event: "a.b" });
    const updated = await store.update(d.id, {
      status: "running",
      attempts: 1,
      nextAttemptAt: null
    });
    expect(updated.status).toBe("running");
    expect(updated.attempts).toBe(1);
    expect(updated.nextAttemptAt).toBeUndefined();
  });

  test("retention cap evicts oldest deliveries when count exceeds max", async () => {
    let now = new Date("2026-05-08T00:00:00.000Z");
    store.now = () => now;
    for (let i = 0; i < 8; i++) {
      now = new Date(now.getTime() + 1000);
      await store.enqueue({ subscriptionId: "sub1", event: `evt.${i}` });
    }
    const snap = await store.load();
    expect(snap.deliveries).toHaveLength(5); // historyMax
    // The oldest 3 (evt.0, evt.1, evt.2) should be evicted.
    const remainingEvents = snap.deliveries.map((d) => d.event);
    expect(remainingEvents).toEqual(["evt.3", "evt.4", "evt.5", "evt.6", "evt.7"]);
  });

  test("findRecent reverses order so newest comes first", async () => {
    let now = new Date("2026-05-08T00:00:00.000Z");
    store.now = () => now;
    for (let i = 0; i < 3; i++) {
      now = new Date(now.getTime() + 1000);
      await store.enqueue({ subscriptionId: "sub1", event: `evt.${i}` });
    }
    const recent = await store.findRecent({ subscriptionId: "sub1", limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0].event).toBe("evt.2");
    expect(recent[1].event).toBe("evt.1");
  });

  test("findRecent filters by status and event", async () => {
    const d1 = await store.enqueue({ subscriptionId: "sub1", event: "a.b" });
    const d2 = await store.enqueue({ subscriptionId: "sub1", event: "c.d" });
    await store.update(d1.id, { status: "succeeded" });
    await store.update(d2.id, { status: "failed" });
    const succeeded = await store.findRecent({ subscriptionId: "sub1", status: "succeeded" });
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].id).toBe(d1.id);
    const cd = await store.findRecent({ subscriptionId: "sub1", event: "c.d" });
    expect(cd).toHaveLength(1);
    expect(cd[0].id).toBe(d2.id);
  });

  test("findRecoverable returns running and queued only", async () => {
    const queued = await store.enqueue({ subscriptionId: "sub1", event: "a.b" });
    const running = await store.enqueue({ subscriptionId: "sub1", event: "c.d" });
    const succeeded = await store.enqueue({ subscriptionId: "sub1", event: "e.f" });
    await store.update(running.id, { status: "running" });
    await store.update(succeeded.id, { status: "succeeded" });
    const recoverable = await store.findRecoverable();
    const ids = recoverable.map((d) => d.id).sort();
    expect(ids).toEqual([queued.id, running.id].sort());
  });

  test("deleteForSubscription removes only that subscription's rows", async () => {
    await store.enqueue({ subscriptionId: "sub1", event: "a.b" });
    await store.enqueue({ subscriptionId: "sub1", event: "c.d" });
    await store.enqueue({ subscriptionId: "sub2", event: "a.b" });
    const removed = await store.deleteForSubscription("sub1");
    expect(removed).toBe(2);
    const snap = await store.load();
    expect(snap.deliveries).toHaveLength(1);
    expect(snap.deliveries[0].subscriptionId).toBe("sub2");
  });

  test("update clears lastError when patch is empty string", async () => {
    const d = await store.enqueue({ subscriptionId: "sub1", event: "a.b" });
    const e1 = await store.update(d.id, { lastError: "Boom" });
    expect(e1.lastError).toBe("Boom");
    const e2 = await store.update(d.id, { lastError: "" });
    expect(e2.lastError).toBeUndefined();
  });
});
