"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const supertest = require("supertest");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-webhook-int-"));
}

function loadApp({ adminKey, dir, env = {} } = {}) {
  jest.resetModules();
  resetEnv();
  if (adminKey) {
    process.env.ADMIN_KEY = adminKey;
  } else {
    delete process.env.ADMIN_KEY;
  }
  process.env.NODE_ENV = "test";
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  if (dir) {
    process.env.WEBHOOKS_STORE_PATH = path.join(dir, "webhooks.json");
    process.env.WEBHOOK_DELIVERIES_STORE_PATH = path.join(dir, "webhook-deliveries.json");
    process.env.SCHEDULE_STORE_PATH = path.join(dir, "schedule.json");
    process.env.STATS_STORE_PATH = path.join(dir, "leaderboard.json");
    process.env.CLASSES_STORE_PATH = path.join(dir, "classes.json");
    process.env.ADMIN_JOBS_STORE_PATH = path.join(dir, "admin-jobs.json");
    process.env.APP_CONFIG_PATH = path.join(dir, "app-config.json");
  }
  process.env.WEBHOOKS_ENABLED = "true";
  process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS = "true";
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  return require("../server");
}

// Stub global.fetch so test deliveries never make a real outbound HTTP
// call. Real fetch would either time out (CI without egress) or worse,
// hit https://example.com/x for real. The stub returns 200 OK so the
// delivery row can be inspected as `succeeded` without the test
// depending on network.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: async () => ({ done: true }) }) }
  });
});

afterEach(() => {
  resetEnv();
  globalThis.fetch = originalFetch;
});

describe("GET /api/admin/webhooks", () => {
  test("returns an empty subscription list on first call", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app).get("/api/admin/webhooks");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.subscriptions).toEqual([]);
    expect(res.body.enabled).toBe(true);
  });

  test("requires admin key when configured", async () => {
    const dir = tempDir();
    const app = loadApp({ adminKey: "test-key", dir });
    const noKey = await supertest(app).get("/api/admin/webhooks");
    expect(noKey.status).toBe(401);
    const withKey = await supertest(app)
      .get("/api/admin/webhooks")
      .set("x-admin-key", "test-key");
    expect(withKey.status).toBe(200);
  });

  test("redacts secrets in list", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const create = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["a.b"] });
    expect(create.status).toBe(201);
    expect(create.body.subscription.secret).toMatch(/^[a-f0-9]{64}$/);
    const list = await supertest(app).get("/api/admin/webhooks");
    expect(list.body.subscriptions).toHaveLength(1);
    expect(list.body.subscriptions[0].secret).toBeUndefined();
  });
});

describe("POST /api/admin/webhooks", () => {
  test("returns the secret one-time on creation", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/admin/webhooks")
      .send({
        url: "https://example.com/x",
        events: ["provider.import.completed"],
        label: "My ops bot",
        maxAttempts: 3
      });
    expect(res.status).toBe(201);
    expect(res.body.subscription.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.subscription.label).toBe("My ops bot");
    expect(res.body.subscription.maxAttempts).toBe(3);
  });

  test("400 on invalid URL", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "not-a-url", events: ["a.b"] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_URL");
  });

  test("400 on empty events array", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com", events: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_EVENTS");
  });
});

describe("PATCH /api/admin/webhooks/:id", () => {
  test("toggling enabled does not return the secret", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["a.b"] });
    const id = created.body.subscription.id;
    const res = await supertest(app)
      .patch(`/api/admin/webhooks/${encodeURIComponent(id)}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.subscription.enabled).toBe(false);
    expect(res.body.subscription.secret).toBeUndefined();
  });

  test("rotateSecret reveals the new secret in the response", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["a.b"] });
    const original = created.body.subscription.secret;
    const id = created.body.subscription.id;
    const res = await supertest(app)
      .patch(`/api/admin/webhooks/${encodeURIComponent(id)}`)
      .send({ rotateSecret: true });
    expect(res.status).toBe(200);
    expect(res.body.subscription.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.subscription.secret).not.toBe(original);
  });

  test("404 on missing subscription", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .patch("/api/admin/webhooks/nonexistent")
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SUBSCRIPTION_NOT_FOUND");
  });
});

describe("DELETE /api/admin/webhooks/:id", () => {
  test("204 and cascades delivery rows", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["a.b"] });
    const id = created.body.subscription.id;
    const del = await supertest(app).delete(`/api/admin/webhooks/${encodeURIComponent(id)}`);
    expect(del.status).toBe(204);
    const list = await supertest(app).get("/api/admin/webhooks");
    expect(list.body.subscriptions).toEqual([]);
  });

  test("404 on missing subscription", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app).delete("/api/admin/webhooks/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/webhooks/:id/test", () => {
  test("queues a webhook.test delivery", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["webhook.test"] });
    const id = created.body.subscription.id;
    const res = await supertest(app).post(`/api/admin/webhooks/${encodeURIComponent(id)}/test`);
    expect(res.status).toBe(202);
    expect(res.body.deliveryId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("404 on missing subscription", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app).post("/api/admin/webhooks/nonexistent/test");
    expect(res.status).toBe(404);
  });

  test("409 with WEBHOOKS_DISABLED when WEBHOOKS_ENABLED=false", async () => {
    const dir = tempDir();
    const app = loadApp({ dir, env: { WEBHOOKS_ENABLED: "false" } });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["webhook.test"] });
    const id = created.body.subscription.id;
    const res = await supertest(app).post(`/api/admin/webhooks/${encodeURIComponent(id)}/test`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WEBHOOKS_DISABLED");
  });
});

describe("GET /api/admin/webhooks/:id/deliveries", () => {
  test("returns deliveries filtered to the subscription", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["webhook.test"] });
    const id = created.body.subscription.id;
    // Trigger a test delivery so there's something in the store. The
    // actual fetch will fail (we don't have a server listening at
    // example.com/x in tests), but the delivery row will exist.
    await supertest(app).post(`/api/admin/webhooks/${encodeURIComponent(id)}/test`);
    const res = await supertest(app).get(`/api/admin/webhooks/${encodeURIComponent(id)}/deliveries`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deliveries)).toBe(true);
    expect(res.body.deliveries.length).toBeGreaterThanOrEqual(1);
  });

  test("400 on invalid limit", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/admin/webhooks")
      .send({ url: "https://example.com/x", events: ["a.b"] });
    const id = created.body.subscription.id;
    const res = await supertest(app).get(`/api/admin/webhooks/${encodeURIComponent(id)}/deliveries?limit=abc`);
    expect(res.status).toBe(400);
  });
});
