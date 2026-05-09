"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  WebhookStore,
  generateSubscriptionId,
  generateSecret,
  redactSecret,
  normalizeSubscription,
  normalizeStore
} = require("../lib/webhook-store");

function tempPath(name = "webhooks.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-webhooks-"));
  return path.join(dir, name);
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

describe("webhook-store helpers", () => {
  test("generateSubscriptionId returns a 22-char base64url string", () => {
    const id = generateSubscriptionId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(20);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("generateSecret returns a 64-char hex string", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  test("redactSecret strips the secret field", () => {
    const sub = {
      id: "abc",
      url: "https://example.com",
      events: ["x.y"],
      enabled: true,
      secret: "deadbeef",
      maxAttempts: 5,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };
    const out = redactSecret(sub);
    expect(out.secret).toBeUndefined();
    expect(out.id).toBe("abc");
    // Original is not mutated
    expect(sub.secret).toBe("deadbeef");
  });

  test("normalizeSubscription rejects invalid URL scheme", () => {
    expect(() => normalizeSubscription({
      id: "abc",
      url: "ftp://bad.example.com",
      events: ["x.y"],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 5,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_URL" }));
  });

  test("normalizeSubscription rejects empty events array", () => {
    expect(() => normalizeSubscription({
      id: "abc",
      url: "https://example.com",
      events: [],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 5,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_EVENTS" }));
  });

  test("normalizeSubscription rejects events that don't match the pattern", () => {
    expect(() => normalizeSubscription({
      id: "abc",
      url: "https://example.com",
      events: ["UPPERCASE"],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 5,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_EVENTS" }));
  });

  test("normalizeSubscription deduplicates events", () => {
    const out = normalizeSubscription({
      id: "abc",
      url: "https://example.com",
      events: ["a.b", "a.b", "c.d"],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 5,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    });
    expect(out.events).toEqual(["a.b", "c.d"]);
  });

  test("normalizeSubscription rejects out-of-range maxAttempts", () => {
    expect(() => normalizeSubscription({
      id: "abc",
      url: "https://example.com",
      events: ["x.y"],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 0,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_MAX_ATTEMPTS" }));
    expect(() => normalizeSubscription({
      id: "abc",
      url: "https://example.com",
      events: ["x.y"],
      enabled: true,
      secret: "a".repeat(32),
      maxAttempts: 25,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    })).toThrow(expect.objectContaining({ code: "INVALID_MAX_ATTEMPTS" }));
  });

  test("normalizeStore drops duplicate ids and sorts by createdAt", () => {
    const out = normalizeStore({
      version: 1,
      updatedAt: "2026-05-08T00:00:00.000Z",
      subscriptions: [
        {
          id: "second",
          url: "https://b.example.com",
          events: ["x.y"],
          enabled: true,
          secret: "a".repeat(32),
          maxAttempts: 5,
          createdAt: "2026-05-08T00:00:00.000Z",
          updatedAt: "2026-05-08T00:00:00.000Z"
        },
        {
          id: "first",
          url: "https://a.example.com",
          events: ["x.y"],
          enabled: true,
          secret: "a".repeat(32),
          maxAttempts: 5,
          createdAt: "2026-05-07T00:00:00.000Z",
          updatedAt: "2026-05-07T00:00:00.000Z"
        },
        {
          id: "first",
          url: "https://duplicate.example.com",
          events: ["x.y"],
          enabled: true,
          secret: "a".repeat(32),
          maxAttempts: 5,
          createdAt: "2026-05-06T00:00:00.000Z",
          updatedAt: "2026-05-06T00:00:00.000Z"
        }
      ]
    });
    expect(out.subscriptions.map((s) => s.id)).toEqual(["first", "second"]);
    // first dedup-by-id wins (insertion order)
    expect(out.subscriptions[0].url).toBe("https://a.example.com");
  });
});

describe("WebhookStore CRUD", () => {
  let store;
  let filePath;

  beforeEach(() => {
    filePath = tempPath();
    store = new WebhookStore({ filePath, now: frozenNow(), defaultMaxAttempts: 5 });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  test("first load creates an empty store on disk", async () => {
    const snap = await store.load();
    expect(snap.subscriptions).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("create persists a new subscription with secret", async () => {
    const created = await store.create({
      url: "https://example.com/webhook",
      events: ["provider.import.completed"]
    });
    expect(created.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(created.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(created.maxAttempts).toBe(5);
    expect(created.enabled).toBe(true);
    const reloaded = new WebhookStore({ filePath });
    const snap = await reloaded.load();
    expect(snap.subscriptions).toHaveLength(1);
    expect(snap.subscriptions[0].id).toBe(created.id);
  });

  test("create rejects invalid URL", async () => {
    await expect(store.create({
      url: "not-a-url",
      events: ["a.b"]
    })).rejects.toThrow(expect.objectContaining({ code: "INVALID_URL" }));
  });

  test("update merges fields and bumps updatedAt", async () => {
    const created = await store.create({ url: "https://example.com", events: ["a.b"] });
    store.now = () => new Date("2026-05-09T00:00:00.000Z");
    const updated = await store.update(created.id, { enabled: false, label: "Test" });
    expect(updated.enabled).toBe(false);
    expect(updated.label).toBe("Test");
    expect(updated.updatedAt).toBe("2026-05-09T00:00:00.000Z");
    expect(updated.secret).toBe(created.secret); // unchanged
  });

  test("update with rotateSecret issues a fresh secret", async () => {
    const created = await store.create({ url: "https://example.com", events: ["a.b"] });
    const rotated = await store.update(created.id, { rotateSecret: true });
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.secret).toMatch(/^[a-f0-9]{64}$/);
  });

  test("update on missing id throws SUBSCRIPTION_NOT_FOUND", async () => {
    await expect(store.update("nonexistent", { enabled: false })).rejects.toThrow(
      expect.objectContaining({ code: "SUBSCRIPTION_NOT_FOUND" })
    );
  });

  test("remove drops the subscription", async () => {
    const a = await store.create({ url: "https://a.example", events: ["a.b"] });
    const b = await store.create({ url: "https://b.example", events: ["a.b"] });
    await store.remove(a.id);
    const snap = await store.load();
    expect(snap.subscriptions.map((s) => s.id)).toEqual([b.id]);
  });

  test("findEnabledForEvent filters by event and enabled flag", async () => {
    await store.create({ url: "https://a.example", events: ["a.b"] });
    await store.create({ url: "https://b.example", events: ["a.b", "c.d"], enabled: false });
    await store.create({ url: "https://c.example", events: ["c.d"] });
    const subs = await store.findEnabledForEvent("a.b");
    expect(subs).toHaveLength(1);
    expect(subs[0].url).toBe("https://a.example");
  });

  test("concurrent create + remove are serialized via commitQueue", async () => {
    const first = await store.create({ url: "https://a.example", events: ["a.b"] });
    const op1 = store.create({ url: "https://b.example", events: ["a.b"] });
    const op2 = store.remove(first.id);
    await Promise.all([op1, op2]);
    const snap = await store.load();
    expect(snap.subscriptions).toHaveLength(1);
    expect(snap.subscriptions[0].url).toBe("https://b.example");
  });

  test("reload picks up an out-of-band file edit", async () => {
    await store.create({ url: "https://a.example", events: ["a.b"] });
    const raw = JSON.parse(await fsp.readFile(filePath, "utf8"));
    raw.subscriptions[0].url = "https://changed.example";
    await fsp.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");
    const snap = await store.reload();
    expect(snap.subscriptions[0].url).toBe("https://changed.example");
  });
});
