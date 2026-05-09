"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  PushSubscriptionStore,
  endpointHashOf,
  normalizeSubscription,
  normalizeStore,
  ENDPOINT_HASH_PATTERN
} = require("../lib/push-subscription-store");

function tempPath(name = "push-subscriptions.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-pss-"));
  return path.join(dir, name);
}

function frozenNow(iso = "2026-05-09T00:00:00.000Z") {
  return () => new Date(iso);
}

describe("push-subscription-store helpers", () => {
  test("endpointHashOf is 16 lowercase hex chars and stable", () => {
    const a = endpointHashOf("https://fcm.googleapis.com/fcm/send/abc");
    const b = endpointHashOf("https://fcm.googleapis.com/fcm/send/abc");
    expect(a).toBe(b);
    expect(ENDPOINT_HASH_PATTERN.test(a)).toBe(true);
  });

  test("endpointHashOf differs per endpoint", () => {
    const a = endpointHashOf("https://fcm.googleapis.com/fcm/send/abc");
    const b = endpointHashOf("https://fcm.googleapis.com/fcm/send/xyz");
    expect(a).not.toBe(b);
  });

  test("normalizeSubscription rejects non-https endpoint", () => {
    expect(() => normalizeSubscription({
      endpointHash: endpointHashOf("http://insecure.example"),
      endpoint: "http://insecure.example",
      keys: { p256dh: "x", auth: "y" },
      createdAt: "2026-05-09T00:00:00.000Z"
    })).toThrow();
  });

  test("normalizeSubscription rejects mismatched endpointHash", () => {
    expect(() => normalizeSubscription({
      endpointHash: "a".repeat(16),
      endpoint: "https://example.com/p",
      keys: { p256dh: "x", auth: "y" },
      createdAt: "2026-05-09T00:00:00.000Z"
    })).toThrow(/does not match/);
  });

  test("normalizeStore drops rows with duplicate canonical endpointHashes", () => {
    // Two rows with the same endpoint will produce the same expected
    // hash; the second is dropped on dedupe even when the inputs
    // claim different (mismatched) hashes — but we can only test the
    // dedupe path with VALID inputs now, so use the same endpoint.
    const sharedHash = endpointHashOf("https://example.com/a");
    const out = normalizeStore({
      version: 1,
      updatedAt: "2026-05-09T00:00:00.000Z",
      lastBroadcastAt: null,
      lastDailyFireAt: null,
      subscriptions: [
        {
          endpointHash: sharedHash,
          endpoint: "https://example.com/a",
          keys: { p256dh: "k1", auth: "a1" },
          createdAt: "2026-05-09T00:00:00.000Z"
        },
        {
          endpointHash: sharedHash,
          endpoint: "https://example.com/a",
          keys: { p256dh: "k2", auth: "a2" },
          createdAt: "2026-05-09T00:00:01.000Z"
        }
      ]
    });
    expect(out.subscriptions).toHaveLength(1);
    expect(out.subscriptions[0].keys.p256dh).toBe("k1"); // first wins
  });
});

describe("PushSubscriptionStore CRUD", () => {
  let store;
  let filePath;

  beforeEach(() => {
    filePath = tempPath();
    store = new PushSubscriptionStore({ filePath, now: frozenNow() });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  test("first load creates an empty store", async () => {
    const snap = await store.load();
    expect(snap.subscriptions).toEqual([]);
    expect(snap.lastBroadcastAt).toBeNull();
    expect(snap.lastDailyFireAt).toBeNull();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("upsert dedupes by endpoint", async () => {
    const sub1 = await store.upsert({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p1", auth: "a1" }
    });
    const sub2 = await store.upsert({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p2", auth: "a2" }
    });
    expect(sub1.endpointHash).toBe(sub2.endpointHash);
    const snap = await store.load();
    expect(snap.subscriptions).toHaveLength(1);
    expect(snap.subscriptions[0].keys.p256dh).toBe("p2"); // updated
  });

  test("upsert rejects http:// endpoints", async () => {
    await expect(store.upsert({
      endpoint: "http://insecure.example/push",
      keys: { p256dh: "p", auth: "a" }
    })).rejects.toThrow();
  });

  test("upsert rejects missing keys", async () => {
    await expect(store.upsert({
      endpoint: "https://example.com/push",
      keys: {}
    })).rejects.toThrow();
  });

  test("removeByHash deletes the row", async () => {
    const sub = await store.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    const removed = await store.removeByHash(sub.endpointHash);
    expect(removed.endpointHash).toBe(sub.endpointHash);
    const snap = await store.load();
    expect(snap.subscriptions).toEqual([]);
  });

  test("removeByHash on missing row is a no-op", async () => {
    const removed = await store.removeByHash("0".repeat(16));
    expect(removed).toBeNull();
  });

  test("markFailure with gone:true prunes immediately", async () => {
    const sub = await store.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    await store.markFailure(sub.endpointHash, { gone: true });
    const snap = await store.load();
    expect(snap.subscriptions).toEqual([]);
  });

  test("markFailure increments streak; markSuccess clears it", async () => {
    const sub = await store.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    await store.markFailure(sub.endpointHash);
    await store.markFailure(sub.endpointHash);
    let row = await store.findByHash(sub.endpointHash);
    expect(row.failureStreak).toBe(2);
    expect(row.firstFailureAt).toBeTruthy();
    await store.markSuccess(sub.endpointHash);
    row = await store.findByHash(sub.endpointHash);
    expect(row.failureStreak).toBeUndefined();
    expect(row.firstFailureAt).toBeUndefined();
    expect(row.lastSuccessAt).toBeTruthy();
  });

  test("pruneStale evicts rows whose first failure is older than the cutoff", async () => {
    const oldNow = new Date("2026-04-01T00:00:00.000Z");
    store.now = () => oldNow;
    const oldSub = await store.upsert({
      endpoint: "https://example.com/old",
      keys: { p256dh: "p", auth: "a" }
    });
    await store.markFailure(oldSub.endpointHash);
    const recentNow = new Date("2026-05-09T00:00:00.000Z");
    store.now = () => recentNow;
    const newSub = await store.upsert({
      endpoint: "https://example.com/new",
      keys: { p256dh: "p", auth: "a" }
    });
    await store.markFailure(newSub.endpointHash);
    const removed = await store.pruneStale();
    expect(removed).toEqual([oldSub.endpointHash]);
    const snap = await store.load();
    expect(snap.subscriptions.map((s) => s.endpointHash)).toEqual([newSub.endpointHash]);
  });

  test("stampLastBroadcast and stampLastDailyFire persist", async () => {
    const at = new Date("2026-05-09T12:00:00.000Z");
    await store.stampLastBroadcast(at);
    await store.stampLastDailyFire(at);
    const snap = await store.load();
    expect(snap.lastBroadcastAt).toBe(at.toISOString());
    expect(snap.lastDailyFireAt).toBe(at.toISOString());
  });
});
