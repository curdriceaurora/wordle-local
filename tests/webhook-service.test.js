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

  test("nextBackoffMs uses schedule index and caps at last slot (jitter off for determinism)", () => {
    expect(nextBackoffMs(1, undefined, { jitter: false })).toBe(DEFAULT_BACKOFF_MS[0]);
    expect(nextBackoffMs(5, undefined, { jitter: false })).toBe(DEFAULT_BACKOFF_MS[4]);
    expect(nextBackoffMs(99, undefined, { jitter: false })).toBe(DEFAULT_BACKOFF_MS[4]);
  });

  // B6 / #125
  test("nextBackoffMs default applies 0-25% additive jitter", () => {
    const trials = 200;
    const observed = new Set();
    for (let i = 0; i < trials; i += 1) {
      const value = nextBackoffMs(1);
      expect(value).toBeGreaterThanOrEqual(DEFAULT_BACKOFF_MS[0]);
      expect(value).toBeLessThanOrEqual(Math.floor(DEFAULT_BACKOFF_MS[0] * 1.25));
      observed.add(value);
    }
    // Spread check: jitter should produce more than a single value
    // across 200 trials with 250 possible integer outcomes.
    expect(observed.size).toBeGreaterThan(20);
  });

  test("nextBackoffMs respects injected random()", () => {
    expect(nextBackoffMs(1, undefined, { random: () => 0 })).toBe(DEFAULT_BACKOFF_MS[0]);
    expect(nextBackoffMs(1, undefined, { random: () => 0.999999 })).toBe(
      DEFAULT_BACKOFF_MS[0] + Math.floor(DEFAULT_BACKOFF_MS[0] * 0.25 * 0.999999)
    );
  });

  test("nextBackoffMs jitterFraction=0 disables jitter even without jitter:false flag", () => {
    expect(nextBackoffMs(1, undefined, { jitterFraction: 0 })).toBe(DEFAULT_BACKOFF_MS[0]);
    expect(nextBackoffMs(3, undefined, { jitterFraction: 0 })).toBe(DEFAULT_BACKOFF_MS[2]);
  });

  // CR Major on PR #154
  test("nextBackoffMs clamps jitterFraction > 0.25 down to the 0–25% policy ceiling", () => {
    // Without the clamp, jitterFraction=1 would give base..2*base.
    // With it, the max possible is base + floor(base * 0.25 * 0.999...).
    const maxJittered = nextBackoffMs(1, undefined, {
      jitterFraction: 1,
      random: () => 0.999999
    });
    const expectedMax = DEFAULT_BACKOFF_MS[0] + Math.floor(DEFAULT_BACKOFF_MS[0] * 0.25 * 0.999999);
    expect(maxJittered).toBe(expectedMax);
    // Floor of the clamped range is just `base` (random=0).
    const minJittered = nextBackoffMs(1, undefined, {
      jitterFraction: 1,
      random: () => 0
    });
    expect(minJittered).toBe(DEFAULT_BACKOFF_MS[0]);
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
    "::",
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
    expect(out.url.hostname).toBe("10.0.0.1");
    expect(out.addresses).toBe(null);
  });

  test("assertOutboundUrlAllowed accepts public IP literal", async () => {
    const out = await assertOutboundUrlAllowed("https://1.1.1.1/x");
    expect(out.url.hostname).toBe("1.1.1.1");
    expect(out.addresses).toEqual([{ address: "1.1.1.1", family: 4 }]);
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

describe("Subscription edits between attempts", () => {
  test("retry honors a fresh URL after the operator edited the subscription mid-flight", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (calls.length === 1) {
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
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      // Bigger backoff so the update lands deterministically between
      // attempts instead of racing the timer.
      backoffSchedule: [200, 200, 200]
    });
    const sub = await subs.create({
      url: "https://old.example/",
      events: ["a.b"],
      maxAttempts: 3
    });
    await svc.emit("a.b", { foo: 1 });
    // Wait until the delivery row reaches `queued` with a scheduled
    // next-attempt — that's the retry timer phase, when an admin edit
    // is meant to be observed by the next executeOnce.
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "queued" && d.nextAttemptAt;
    });
    await subs.update(sub.id, { url: "https://new.example/" });
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "succeeded";
    }, { timeoutMs: 5000 });
    expect(calls).toEqual(["https://old.example/", "https://new.example/"]);
  });

  test("rotated secret is used for retries, not the original", async () => {
    const sigs = [];
    const fetchImpl = async (url, init) => {
      sigs.push(init.headers["x-webhook-signature"]);
      if (sigs.length === 1) {
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
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      backoffSchedule: [200, 200, 200]
    });
    const sub = await subs.create({
      url: "https://example.com/",
      events: ["a.b"],
      maxAttempts: 3
    });
    await svc.emit("a.b", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "queued" && d.nextAttemptAt;
    });
    await subs.update(sub.id, { rotateSecret: true });
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && d.status === "succeeded";
    }, { timeoutMs: 5000 });
    expect(sigs[0]).not.toBe(sigs[1]);
  });
});

describe("Persisted payload survives recovery", () => {
  test("recoverOnBoot uses the persisted payload, not an empty object", async () => {
    const bodies = [];
    const fetchImpl = async (url, init) => {
      bodies.push(init.body);
      return {
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({ fetchImpl });
    const sub = await subs.create({ url: "https://example.com/", events: ["a.b"] });
    // Manually persist a row that mimics what emit() writes pre-restart.
    const stuck = await deliveries.enqueue({
      subscriptionId: sub.id,
      event: "a.b",
      url: sub.url,
      payload: { reconstructed: true, n: 42 }
    });
    await deliveries.update(stuck.id, { status: "running", attempts: 1 });
    await svc.recoverOnBoot();
    await waitForCondition(async () => {
      const d = await deliveries.findById(stuck.id);
      return d && d.status === "succeeded";
    });
    const sent = JSON.parse(bodies[0]);
    expect(sent.payload).toEqual({ reconstructed: true, n: 42 });
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

// B6 / #125: aggregate retry-budget cap. The default is 16 concurrent
// retries in flight, configurable via WEBHOOK_MAX_CONCURRENT_RETRIES.
// When the cap is hit, scheduleDelivery({ isRetry: true }) marks the
// delivery as failed rather than queueing it.
describe("retry budget cap (B6 / #125)", () => {
  test("scheduleDelivery with isRetry=true counts against the cap", async () => {
    const { svc } = await buildService({ maxConcurrentRetries: 3 });
    expect(svc.retryInflightCount).toBe(0);
    // Long delay so the timers don't fire before we observe state.
    svc.scheduleDelivery("delivery-a", 60_000, null, { isRetry: true });
    svc.scheduleDelivery("delivery-b", 60_000, null, { isRetry: true });
    svc.scheduleDelivery("delivery-c", 60_000, null, { isRetry: true });
    expect(svc.retryInflightCount).toBe(3);
    svc.shutdown();
  });

  test("first-attempt schedules (isRetry omitted) do NOT count against the retry cap", async () => {
    const { svc } = await buildService({ maxConcurrentRetries: 2 });
    svc.scheduleDelivery("delivery-a", 60_000, null); // no isRetry → first-attempt
    svc.scheduleDelivery("delivery-b", 60_000, null);
    svc.scheduleDelivery("delivery-c", 60_000, null);
    expect(svc.retryInflightCount).toBe(0);
    svc.shutdown();
  });

  test("exceeding the budget marks the delivery as failed instead of scheduling", async () => {
    const fetchImpl = async () => ({
      status: 500,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) }
    });
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      maxConcurrentRetries: 1,
      // 60s backoff so the first delivery stays in the retry budget
      // while we issue the second one.
      backoffSchedule: [60_000]
    });
    const sub = await subs.create({
      url: "https://a.example/webhook",
      events: ["e"],
      maxAttempts: 3
    });
    await svc.emit("e", {});
    // Wait for first delivery to fail-and-schedule-retry.
    await waitForCondition(() => svc.retryInflightCount >= 1);
    expect(svc.retryInflightCount).toBe(1);
    // Issue a second emit; its first attempt also fails, would schedule
    // a retry — but the retry budget (=1) is already exhausted.
    await svc.emit("e", {});
    await waitForCondition(async () => {
      const recent = await deliveries.findRecent({ subscriptionId: sub.id, limit: 5 });
      return recent.some((d) => d.status === "failed" && /retry budget exhausted/.test(d.lastError || ""));
    });
    const recent = await deliveries.findRecent({ subscriptionId: sub.id, limit: 5 });
    const exhausted = recent.find((d) => /retry budget exhausted/.test(d.lastError || ""));
    expect(exhausted).toBeTruthy();
    expect(exhausted.status).toBe("failed");
    svc.shutdown();
  });

  test("a completing retry frees budget for the next one", async () => {
    const { svc } = await buildService({ maxConcurrentRetries: 1 });
    // Fast timer — let it fire so the counter decrements.
    svc.scheduleDelivery("first", 10, null, { isRetry: true });
    expect(svc.retryInflightCount).toBe(1);
    await waitForCondition(() => svc.retryInflightCount === 0, { timeoutMs: 1000 });
    expect(svc.retryInflightCount).toBe(0);
    // Now the budget is free again.
    svc.scheduleDelivery("second", 60_000, null, { isRetry: true });
    expect(svc.retryInflightCount).toBe(1);
    svc.shutdown();
  });

  // CR Major on PR #154
  test("constructor clamps maxConcurrentRetries > 256 down to the 256 ceiling", async () => {
    const { svc } = await buildService({ maxConcurrentRetries: 100_000 });
    expect(svc.maxConcurrentRetries).toBe(256);
    svc.shutdown();
  });

  // CR Major on PR #154: also enforce that the per-service jitterFraction
  // is clamped (not just the standalone helper).
  test("constructor clamps jitterFraction > 0.25 down to 0.25", async () => {
    const { svc } = await buildService({ jitterFraction: 0.9 });
    expect(svc.jitterFraction).toBe(0.25);
    svc.shutdown();
  });

  test("constructor clamps non-positive / non-integer maxConcurrentRetries to default", async () => {
    const { svc: svcNeg } = await buildService({ maxConcurrentRetries: -5 });
    expect(svcNeg.maxConcurrentRetries).toBe(16);
    svcNeg.shutdown();
    const { svc: svcNaN } = await buildService({ maxConcurrentRetries: NaN });
    expect(svcNaN.maxConcurrentRetries).toBe(16);
    svcNaN.shutdown();
    const { svc: svcStr } = await buildService({ maxConcurrentRetries: "8" });
    // Non-integer (string) falls back to default — caller must pass int.
    expect(svcStr.maxConcurrentRetries).toBe(16);
    svcStr.shutdown();
  });

  // Helper: seed a delivery in the persisted store with arbitrary
  // attempts/status to simulate a crash-recovered row. enqueue() always
  // creates with status=queued/attempts=0; update() advances state.
  async function seedDelivery(deliveries, sub, { attempts, nextAttemptAt, status } = {}) {
    const created = await deliveries.enqueue({
      subscriptionId: sub.id,
      event: "e",
      url: sub.url,
      nextAttemptAt: nextAttemptAt || undefined,
      payload: {}
    });
    if (attempts !== undefined || status) {
      await deliveries.update(created.id, {
        ...(attempts !== undefined ? { attempts } : {}),
        ...(status ? { status } : {})
      });
    }
    return created;
  }

  // Codex P2 + Copilot on PR #154
  test("recoverOnBoot counts persisted-retry deliveries against the budget", async () => {
    const { svc, subs, deliveries } = await buildService({
      maxConcurrentRetries: 2,
      // Far-future nextAttemptAt so the schedule doesn't fire and
      // unwind the budget before we observe.
      backoffSchedule: [60_000]
    });
    const sub = await subs.create({
      url: "https://a.example/",
      events: ["e"],
      maxAttempts: 5
    });
    const nowFar = new Date(Date.now() + 60_000).toISOString();
    await seedDelivery(deliveries, sub, { attempts: 2, nextAttemptAt: nowFar });
    await seedDelivery(deliveries, sub, { attempts: 2, nextAttemptAt: nowFar });
    await seedDelivery(deliveries, sub, { attempts: 2, nextAttemptAt: nowFar });
    expect(svc.retryInflightCount).toBe(0);
    await svc.recoverOnBoot();
    // Two get scheduled (budget=2); the third hits the budget cap
    // and is marked failed instead of scheduled.
    expect(svc.retryInflightCount).toBe(2);
    await waitForCondition(async () => {
      const all = (await deliveries.load()).deliveries;
      return all.some((d) => /retry budget exhausted/.test(d.lastError || "") && d.status === "failed");
    });
    const all = (await deliveries.load()).deliveries;
    const exhausted = all.find((d) => /retry budget exhausted/.test(d.lastError || ""));
    expect(exhausted).toBeTruthy();
    expect(exhausted.status).toBe("failed");
    // Copilot on PR #154: nextAttemptAt must be cleared when the
    // budget-exhaust path marks the row failed, not left as a
    // phantom future timestamp.
    expect(exhausted.nextAttemptAt === null || exhausted.nextAttemptAt === undefined || exhausted.nextAttemptAt === "").toBe(true);
    svc.shutdown();
  });

  test("recoverOnBoot treats first-attempt persisted deliveries (attempts=0) as NOT retries", async () => {
    const { svc, subs, deliveries } = await buildService({
      maxConcurrentRetries: 1,
      backoffSchedule: [60_000]
    });
    const sub = await subs.create({
      url: "https://a.example/",
      events: ["e"],
      maxAttempts: 5
    });
    // Fill the retry budget with a real retry (attempts=2).
    await seedDelivery(deliveries, sub, {
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
    });
    // And a first-attempt-scheduled row (attempts=0 — default from enqueue).
    await seedDelivery(deliveries, sub, {});
    await svc.recoverOnBoot();
    expect(svc.retryInflightCount).toBe(1); // only the attempts=2 row counted
    // The attempts=0 row should NOT have been marked failed —
    // first-attempt schedules bypass the retry budget entirely.
    const all = (await deliveries.load()).deliveries;
    const firstAttempt = all.find((d) => (d.attempts || 0) === 0);
    expect(firstAttempt).toBeTruthy();
    expect(firstAttempt.status).not.toBe("failed");
    svc.shutdown();
  });
});

// B6 / #125: jitter is on by default. Inject a deterministic random
// to exercise an exact backoff value; verify that the next-attempt
// timestamp written by executeOnce reflects the jittered delay.
describe("jitter applied to retry backoff (B6 / #125)", () => {
  test("retry backoff uses the WebhookService's injected random()", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return {
        status: 500,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => ({ done: true }) }) }
      };
    };
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      backoffSchedule: [1000],
      random: () => 0.5  // halfway through the jitter window
    });
    const sub = await subs.create({
      url: "https://example.com/",
      events: ["e"],
      maxAttempts: 5
    });
    const before = Date.now();
    await svc.emit("e", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && typeof d.nextAttemptAt === "string" && d.nextAttemptAt.length > 0;
    });
    const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
    const nextMs = new Date(d.nextAttemptAt).getTime();
    // random=0.5, jitterFraction=0.25, base=1000 → jitter = floor(1000 * 0.25 * 0.5) = 125.
    // nextAttemptAt should land ~before + 1125ms (give 1500ms slack
    // for I/O + timer scheduling).
    expect(nextMs - before).toBeGreaterThanOrEqual(1100);
    expect(nextMs - before).toBeLessThan(2600);
    expect(attempts).toBeGreaterThanOrEqual(1);
    svc.shutdown();
  });

  test("WebhookService respects jitterFraction=0 (deterministic backoff)", async () => {
    const fetchImpl = async () => ({
      status: 500,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) }
    });
    const { svc, subs, deliveries } = await buildService({
      fetchImpl,
      backoffSchedule: [777],
      jitterFraction: 0
    });
    const sub = await subs.create({
      url: "https://example.com/",
      events: ["e"],
      maxAttempts: 5
    });
    const before = Date.now();
    await svc.emit("e", {});
    await waitForCondition(async () => {
      const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
      return d && typeof d.nextAttemptAt === "string" && d.nextAttemptAt.length > 0;
    });
    const d = (await deliveries.findRecent({ subscriptionId: sub.id, limit: 1 }))[0];
    const delay = new Date(d.nextAttemptAt).getTime() - before;
    // With jitterFraction=0, backoff is exactly 777ms (plus I/O slack).
    expect(delay).toBeGreaterThanOrEqual(700);
    expect(delay).toBeLessThan(2500);
    svc.shutdown();
  });
});
