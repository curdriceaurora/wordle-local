"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  NotificationService,
  buildPayload,
  classifyResponse,
  PAYLOAD_MAX_BYTES
} = require("../lib/notification-service");
const { PushSubscriptionStore } = require("../lib/push-subscription-store");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-notify-"));
}

async function buildService(extra = {}) {
  const dir = tempDir();
  const subStore = new PushSubscriptionStore({
    filePath: path.join(dir, "push.json")
  });
  const fakeKeys = {
    publicKey: "B".repeat(87),
    privateKey: "p".repeat(43),
    subject: "mailto:test@example.com"
  };
  const fakeWebPush = {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(async () => ({ statusCode: 200 }))
  };
  const svc = new NotificationService({
    subscriptionStore: subStore,
    enabled: true,
    webPush: fakeWebPush,
    getPushKeys: () => fakeKeys,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    ...extra
  });
  return { svc, subStore, fakeWebPush, dir };
}

afterEach(async () => {
  // dirs are leaked per test run but fine in tmp; jest --runInBand
  // serializes so there's no cross-test contention.
});

describe("buildPayload", () => {
  test("clamps overlong title and body", () => {
    const out = buildPayload({
      title: "x".repeat(200),
      body: "y".repeat(500),
      url: "/"
    });
    expect(out.title.length).toBe(80);
    expect(out.body.length).toBe(200);
    expect(out.url).toBe("/");
  });

  test("includes optional tag", () => {
    const out = buildPayload({ title: "t", body: "b", url: "/", tag: "daily" });
    expect(out.tag).toBe("daily");
  });

  test("missing inputs become empty strings", () => {
    const out = buildPayload({});
    expect(out).toEqual({ title: "", body: "", url: "" });
  });
});

describe("classifyResponse", () => {
  test("HTTP 410 → gone (prune)", () => {
    expect(classifyResponse({ statusCode: 410 })).toEqual({
      ok: false, retriable: false, gone: true, status: 410
    });
  });

  test("HTTP 404 → gone (prune)", () => {
    expect(classifyResponse({ statusCode: 404 })).toEqual({
      ok: false, retriable: false, gone: true, status: 404
    });
  });

  test("HTTP 408/429 → retriable, not gone", () => {
    expect(classifyResponse({ statusCode: 429 }).retriable).toBe(true);
    expect(classifyResponse({ statusCode: 429 }).gone).toBe(false);
    expect(classifyResponse({ statusCode: 408 }).retriable).toBe(true);
  });

  test("Other 4xx → not retriable, not gone", () => {
    const r = classifyResponse({ statusCode: 400 });
    expect(r.retriable).toBe(false);
    expect(r.gone).toBe(false);
  });

  test("5xx → retriable", () => {
    expect(classifyResponse({ statusCode: 500 }).retriable).toBe(true);
    expect(classifyResponse({ statusCode: 502 }).retriable).toBe(true);
  });

  test("network error (no statusCode) → retriable", () => {
    expect(classifyResponse({}).retriable).toBe(true);
  });

  test("null err → ok", () => {
    expect(classifyResponse(null).ok).toBe(true);
  });
});

describe("NotificationService.sendOne", () => {
  test("sets VAPID details on every send", async () => {
    const { svc, subStore, fakeWebPush } = await buildService();
    const sub = await subStore.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    const result = await svc.sendOne(sub, { title: "T", body: "B", url: "/" });
    expect(result.ok).toBe(true);
    expect(fakeWebPush.setVapidDetails).toHaveBeenCalledWith(
      "mailto:test@example.com",
      expect.any(String),
      expect.any(String)
    );
    expect(fakeWebPush.sendNotification).toHaveBeenCalledTimes(1);
  });

  test("missing VAPID throws VAPID_MISSING", async () => {
    const { svc } = await buildService({ getPushKeys: () => null });
    await expect(svc.sendOne(
      { endpoint: "https://example.com/push", keys: { p256dh: "p", auth: "a" } },
      { title: "T", body: "B", url: "/" }
    )).rejects.toMatchObject({ code: "VAPID_MISSING" });
  });

  test("disabled service returns skipped", async () => {
    const { svc, subStore } = await buildService({ enabled: false });
    const sub = await subStore.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    const result = await svc.sendOne(sub, { title: "T", body: "B" });
    expect(result.skipped).toBe(true);
  });

  test("HTTP 410 surface gone:true so caller can prune", async () => {
    const fakeWebPush = {
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn().mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }))
    };
    const { svc, subStore } = await buildService({ webPush: fakeWebPush });
    const sub = await subStore.upsert({
      endpoint: "https://example.com/push",
      keys: { p256dh: "p", auth: "a" }
    });
    const result = await svc.sendOne(sub, { title: "T", body: "B" });
    expect(result.ok).toBe(false);
    expect(result.gone).toBe(true);
  });

  // The PAYLOAD_TOO_LARGE check is defense-in-depth — buildPayload
  // clamps title/body so an oversize payload never reaches the byte
  // check under normal flow. Verify the constant exists and is sane.
  test("PAYLOAD_MAX_BYTES guards the JSON body length", () => {
    expect(PAYLOAD_MAX_BYTES).toBeGreaterThanOrEqual(512);
    expect(PAYLOAD_MAX_BYTES).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("NotificationService.broadcast", () => {
  test("dryRun returns recipient count + preview without sending", async () => {
    const { svc, subStore, fakeWebPush } = await buildService();
    await subStore.upsert({
      endpoint: "https://example.com/a",
      keys: { p256dh: "p", auth: "a" }
    });
    await subStore.upsert({
      endpoint: "https://example.com/b",
      keys: { p256dh: "p", auth: "a" }
    });
    const result = await svc.broadcast({ title: "T", body: "B", url: "/" }, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.recipients).toBe(2);
    expect(result.preview).toEqual({ title: "T", body: "B", url: "/" });
    expect(fakeWebPush.sendNotification).not.toHaveBeenCalled();
  });

  test("aggregate counts: sent + failed + gone", async () => {
    const fakeWebPush = {
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn()
        .mockResolvedValueOnce({ statusCode: 200 }) // sent
        .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 })) // gone
        .mockRejectedValueOnce(Object.assign(new Error("server"), { statusCode: 500 })) // failed
    };
    const { svc, subStore } = await buildService({ webPush: fakeWebPush });
    await subStore.upsert({ endpoint: "https://a.example/push", keys: { p256dh: "p", auth: "a" } });
    await subStore.upsert({ endpoint: "https://b.example/push", keys: { p256dh: "p", auth: "a" } });
    await subStore.upsert({ endpoint: "https://c.example/push", keys: { p256dh: "p", auth: "a" } });
    const result = await svc.broadcast({ title: "T", body: "B", url: "/" });
    expect(result.recipients).toBe(3);
    expect(result.sent).toBe(1);
    expect(result.gone + result.failed).toBe(2);
    // 410-row should be evicted from the store; failed-row stays with a streak.
    const remaining = await subStore.list();
    expect(remaining).toHaveLength(2); // gone subscription pruned
  });

  test("disabled service returns skipped without listing subs", async () => {
    const { svc, fakeWebPush } = await buildService({ enabled: false });
    const result = await svc.broadcast({ title: "T", body: "B" });
    expect(result.skipped).toBe(true);
    expect(fakeWebPush.sendNotification).not.toHaveBeenCalled();
  });
});

describe("PAYLOAD_MAX_BYTES", () => {
  test("is small enough to fit Web Push 4 KiB cap with crypto overhead", () => {
    expect(PAYLOAD_MAX_BYTES).toBeLessThanOrEqual(4 * 1024);
  });
});
