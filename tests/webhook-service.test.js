"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const nodeCrypto = require("node:crypto");

const {
  WebhookService,
  signPayload,
  parseRetryAfterHeader,
  classifyHttpStatus,
  isPrivateIPv4,
  isPrivateIPv6,
  assertOutboundUrlAllowed,
  nextBackoffMs,
  DEFAULT_BACKOFF_MS
} = require("../lib/webhook-service");

const { WebhookStore } = require("../lib/webhook-store");
const { WebhookDeliveryStore } = require("../lib/webhook-delivery-store");

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-svc-"));
  return {
    dir,
    subs: path.join(dir, "webhooks.json"),
    deliveries: path.join(dir, "webhook-deliveries.json")
  };
}

async function buildService(extra = {}) {
  const paths = tempPaths();
  const subs = new WebhookStore({ filePath: paths.subs });
  const deliveries = new WebhookDeliveryStore({ filePath: paths.deliveries });
  const svc = new WebhookService({
    subscriptionStore: subs,
    deliveryStore: deliveries,
    enabled: true,
    backoffSchedule: [10, 20, 30],
    timeoutMs: 500,
    fetchImpl: extra.fetchImpl,
    allowPrivateNetworks: true,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    ...extra
  });
  return { svc, subs, deliveries, dir: paths.dir };
}

async function waitForCondition(predicate, { timeoutMs = 1500, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForCondition timed out");
}

describe("signature + helper functions", () => {
  test("signPayload produces deterministic HMAC-SHA-256", () => {
    const sig = signPayload("hello", "secret");
    const expected = nodeCrypto.createHmac("sha256", "secret").update("hello").digest("hex");
    expect(sig).toBe(`sha256=${expected}`);
  });

  test("parseRetryAfterHeader parses numeric seconds", () => {
    expect(parseRetryAfterHeader("30", new Date())).toBe(30000);
    expect(parseRetryAfterHeader("0", new Date())).toBe(0);
  });

  test("parseRetryAfterHeader parses HTTP-date and clamps negatives to 0", () => {
    const now = new Date("2026-05-08T00:00:00.000Z");
    const future = new Date("2026-05-08T00:00:30.000Z").toUTCString();
    expect(parseRetryAfterHeader(future, now)).toBe(30000);
    const past = new Date("2026-05-07T00:00:00.000Z").toUTCString();
    expect(parseRetryAfterHeader(past, now)).toBe(0);
  });

  test("parseRetryAfterHeader returns null for unparseable values", () => {
    expect(parseRetryAfterHeader("not-a-date", new Date())).toBe(null);
    expect(parseRetryAfterHeader("", new Date())).toBe(null);
    expect(parseRetryAfterHeader(null, new Date())).toBe(null);
  });

  test("classifyHttpStatus categorises 2xx success, 4xx non-retriable, 5xx retriable", () => {
    expect(classifyHttpStatus(200)).toEqual({ ok: true, retriable: false });
    expect(classifyHttpStatus(204)).toEqual({ ok: true, retriable: false });
    expect(classifyHttpStatus(400)).toEqual({ ok: false, retriable: false });
    expect(classifyHttpStatus(404)).toEqual({ ok: false, retriable: false });
    expect(classifyHttpStatus(408)).toEqual({ ok: false, retriable: true });
    expect(classifyHttpStatus(429)).toEqual({ ok: false, retriable: true });
    expect(classifyHttpStatus(500)).toEqual({ ok: false, retriable: true });
    expect(classifyHttpStatus(502)).toEqual({ ok: false, retriable: true });
  });

  test("nextBackoffMs uses schedule index and caps at last slot", () => {
    expect(nextBackoffMs(1)).toBe(DEFAULT_BACKOFF_MS[0]);
    expect(nextBackoffMs(5)).toBe(DEFAULT_BACKOFF_MS[4]);
    expect(nextBackoffMs(99)).toBe(DEFAULT_BACKOFF_MS[4]);
  });
});

describe("SSRF guard (isPrivateIPv4 / isPrivateIPv6 / assertOutboundUrlAllowed)", () => {
  test.each([
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0"
  ])("isPrivateIPv4 flags %s as private", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "172.15.0.1",
    "11.0.0.0"
  ])("isPrivateIPv4 accepts %s as public", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });

  test.each([
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00::1",
    "::ffff:127.0.0.1"
  ])("isPrivateIPv6 flags %s as private", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  test.each([
    "2606:4700::1",
    "2001:4860:4860::8888"
  ])("isPrivateIPv6 accepts %s as public", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });

  test("assertOutboundUrlAllowed rejects ftp://", async () => {
    await expect(assertOutboundUrlAllowed("ftp://example.com")).rejects.toThrow(
      expect.objectContaining({ code: "INVALID_URL" })
    );
  });

  test("assertOutboundUrlAllowed rejects literal private IPv4 by default", async () => {
    await expect(assertOutboundUrlAllowed("http://10.0.0.1/webhook")).rejects.toThrow(
      expect.objectContaining({ code: "PRIVATE_ADDRESS_BLOCKED" })
    );
  });

  test("assertOutboundUrlAllowed permits any address when allowPrivateNetworks=true", async () => {
    const out = await assertOutboundUrlAllowed("http://10.0.0.1/webhook", { allowPrivateNetworks: true });
    expect(out.hostname).toBe("10.0.0.1");
  });

  test("assertOutboundUrlAllowed accepts public IP literal", async () => {
    const out = await assertOutboundUrlAllowed("https://1.1.1.1/x");
    expect(out.hostname).toBe("1.1.1.1");
  });
});

describe("WebhookService.emit + executeOnce", () => {
  test("emit signs the payload and POSTs to the subscription URL", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({
      url: "https://example.com/webhook",
      events: ["test.event"]
    });
    await svc.emit("test.event", { foo: "bar" });
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "succeeded";
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers;
    expect(headers["x-webhook-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers["x-webhook-event"]).toBe("test.event");
    expect(headers["x-webhook-attempt"]).toBe("1");
    const body = JSON.parse(calls[0].init.body);
    expect(body.event).toBe("test.event");
    expect(body.payload).toEqual({ foo: "bar" });
    // Verify signature
    const expectedSig = signPayload(calls[0].init.body, sub.secret);
    expect(headers["x-webhook-signature"]).toBe(expectedSig);
  });

  test("emit only delivers to subscriptions enabled for this event", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    await subs.create({ url: "https://a.example/", events: ["test.event"] });
    await subs.create({ url: "https://b.example/", events: ["other.event"] });
    await subs.create({ url: "https://c.example/", events: ["test.event"], enabled: false });
    await svc.emit("test.event", {});
    await waitForCondition(async () => {
      const all = (await deliveries.load()).deliveries;
      return all.length === 1 && all[0].status === "succeeded";
    });
    expect(calls).toEqual(["https://a.example/"]);
  });

  test("retriable HTTP 500 schedules a retry, then succeeds on the second attempt", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 500,
          headers: { get: () => null },
          body: { getReader: () => ({ read: async () => ({ done: true }) }) }
        };
      }
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({
      url: "https://example.com/webhook",
      events: ["test.event"],
      maxAttempts: 3
    });
    await svc.emit("test.event", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "succeeded";
    });
    expect(attempts).toBe(2);
  });

  test("non-retriable HTTP 400 marks delivery as failed without retrying", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return {
        status: 400,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({
      url: "https://example.com/webhook",
      events: ["test.event"],
      maxAttempts: 3
    });
    await svc.emit("test.event", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "failed";
    });
    expect(attempts).toBe(1);
  });

  test("hitting maxAttempts marks delivery as failed", async () => {
    const fetchImpl = async () => ({
      status: 500,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) }
    });
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({
      url: "https://example.com/webhook",
      events: ["test.event"],
      maxAttempts: 2
    });
    await svc.emit("test.event", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "failed";
    });
    const final = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
    expect(final.attempts).toBe(2);
    expect(final.lastError).toMatch(/HTTP 500/);
  });

  test("disabled service does not enqueue any deliveries", async () => {
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) }
    });
    const { svc, subs, deliveries } = await buildService({ fetchImpl, enabled: false });
    await subs.create({ url: "https://example.com/", events: ["test.event"] });
    const out = await svc.emit("test.event", {});
    expect(out).toEqual([]);
    const all = (await deliveries.load()).deliveries;
    expect(all).toEqual([]);
  });

  test("Retry-After header inflates the backoff", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 429,
        headers: {
          get: (name) => (name.toLowerCase() === "retry-after" ? "1" : null)
        },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      backoffSchedule: [10, 10, 10] // small, but Retry-After=1 (1000ms) should win
    });
    const sub = await subs.create({
      url: "https://example.com/webhook",
      events: ["test.event"],
      maxAttempts: 2
    });
    await svc.emit("test.event", {});
    // First attempt is immediate; second is delayed by ~1000ms (Retry-After).
    // After both fail (429 → 429), status should be `failed`. We just check
    // that the delivery eventually fails AND that calls reached maxAttempts.
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "failed";
    }, { timeoutMs: 5000 });
    expect(calls).toBe(2);
  });
});

describe("WebhookService.recoverOnBoot", () => {
  test("requeues `running` deliveries left over from a crash", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({ url: "https://example.com/", events: ["a.b"] });
    // Manually create a stuck `running` delivery.
    const stuck = await deliveries.enqueue({ subscriptionId: sub.id, event: "a.b" });
    await deliveries.update(stuck.id, { status: "running", attempts: 1 });
    const recovered = await svc.recoverOnBoot();
    expect(recovered).toBe(1);
    await waitForCondition(async () => {
      const d = await deliveries.findById(stuck.id);
      return d && d.status === "succeeded";
    });
    expect(calls).toBe(1);
  });

  test("schedules `queued` deliveries with persisted nextAttemptAt", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({ url: "https://example.com/", events: ["a.b"] });
    const queued = await deliveries.enqueue({
      subscriptionId: sub.id,
      event: "a.b",
      nextAttemptAt: new Date(Date.now() - 1000).toISOString() // already due
    });
    const recovered = await svc.recoverOnBoot();
    expect(recovered).toBe(1);
    await waitForCondition(async () => {
      const d = await deliveries.findById(queued.id);
      return d && d.status === "succeeded";
    });
    expect(calls).toBe(1);
  });

  test("disabled service skips recovery", async () => {
    const { svc } = await buildService({ enabled: false });
    expect(await svc.recoverOnBoot()).toBe(0);
  });
});

describe("WebhookService.retryDelivery", () => {
  test("requeues a failed delivery and marks it queued before send", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({ url: "https://example.com/", events: ["a.b"] });
    const d = await deliveries.enqueue({ subscriptionId: sub.id, event: "a.b" });
    await deliveries.update(d.id, { status: "failed", lastError: "Boom" });
    const retried = await svc.retryDelivery(d.id);
    expect(retried.status).toBe("queued");
    await waitForCondition(async () => {
      const x = await deliveries.findById(d.id);
      return x && x.status === "succeeded";
    });
    expect(calls).toBe(1);
  });

  test("non-failed delivery is returned unchanged", async () => {
    const { svc, subs, deliveries } = await buildService();
    const sub = await subs.create({ url: "https://example.com/", events: ["a.b"] });
    const d = await deliveries.enqueue({ subscriptionId: sub.id, event: "a.b" });
    await deliveries.update(d.id, { status: "succeeded" });
    const retried = await svc.retryDelivery(d.id);
    expect(retried.status).toBe("succeeded");
  });
});

describe("WebhookService.shutdown", () => {
  test("clears scheduled timers and prevents further work", async () => {
    const fetchImpl = async () => {
      throw new Error("should not have been called");
    };
    const { svc, subs } = await buildService({ fetchImpl, backoffSchedule: [60_000] });
    await subs.create({ url: "https://example.com/", events: ["a.b"] });
    // Schedule a delivery far enough out that it won't fire before shutdown.
    svc.scheduleDelivery("nonexistent-id", 60_000, { event: "a.b", payload: {} });
    expect(svc.scheduledTimers.size).toBeGreaterThan(0);
    svc.shutdown();
    expect(svc.scheduledTimers.size).toBe(0);
    expect(svc.shutdownRequested).toBe(true);
  });
});
