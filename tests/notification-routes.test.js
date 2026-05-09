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
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-notify-int-"));
}

function loadApp({ adminKey, dir, env = {} } = {}) {
  jest.resetModules();
  resetEnv();
  if (adminKey) process.env.ADMIN_KEY = adminKey;
  else delete process.env.ADMIN_KEY;
  process.env.NODE_ENV = "test";
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  if (dir) {
    process.env.PUSH_SUBSCRIPTIONS_STORE_PATH = path.join(dir, "push.json");
    process.env.APP_CONFIG_PATH = path.join(dir, "app-config.json");
    process.env.SCHEDULE_STORE_PATH = path.join(dir, "schedule.json");
    process.env.STATS_STORE_PATH = path.join(dir, "leaderboard.json");
    process.env.CLASSES_STORE_PATH = path.join(dir, "classes.json");
    process.env.ADMIN_JOBS_STORE_PATH = path.join(dir, "admin-jobs.json");
  }
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  return require("../server");
}

afterEach(() => {
  resetEnv();
});

describe("GET /api/notifications/vapid-public-key", () => {
  test("returns 503 before VAPID is provisioned", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app).get("/api/notifications/vapid-public-key");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("VAPID_MISSING");
  });

  test("returns the public key once provisioned (post-startServer)", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    // Provision VAPID via the boot path. We invoke startServer with a
    // listener stub so it doesn't actually bind a port.
    const stubListener = (port, host, cb) => { if (cb) setImmediate(cb); return { close: () => {} }; };
    await app.startServer(stubListener);
    const res = await supertest(app).get("/api/notifications/vapid-public-key");
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe("string");
    expect(res.body.publicKey.length).toBeGreaterThan(80);
    expect(res.body.publicKey.length).toBeLessThan(200);
    // privateKey must NEVER appear in the response.
    expect(res.body.privateKey).toBeUndefined();
    app.stopSchedulerInterval();
    app.dailyNotificationScheduler.shutdown();
  });
});

describe("POST /api/notifications/subscribe", () => {
  test("creates a subscription with hashed id", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        keys: { p256dh: "p", auth: "a" }
      });
    expect(res.status).toBe(201);
    expect(res.body.endpointHash).toMatch(/^[a-f0-9]{16}$/);
  });

  test("400 on invalid endpoint", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "http://insecure.example", keys: { p256dh: "p", auth: "a" } });
    expect(res.status).toBe(400);
  });

  test("dedupes by endpoint", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const r1 = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "https://example.com/p", keys: { p256dh: "p1", auth: "a1" } });
    const r2 = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "https://example.com/p", keys: { p256dh: "p2", auth: "a2" } });
    expect(r1.body.endpointHash).toBe(r2.body.endpointHash);
  });
});

describe("DELETE /api/notifications/subscribe/:endpointHash", () => {
  test("204 on existing row", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "https://example.com/p", keys: { p256dh: "p", auth: "a" } });
    const del = await supertest(app)
      .delete(`/api/notifications/subscribe/${encodeURIComponent(created.body.endpointHash)}`);
    expect(del.status).toBe(204);
  });

  test("204 on missing row (idempotent)", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const del = await supertest(app).delete("/api/notifications/subscribe/" + "0".repeat(16));
    expect(del.status).toBe(204);
  });

  test("400 on malformed hash", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const del = await supertest(app).delete("/api/notifications/subscribe/not-hex");
    expect(del.status).toBe(400);
  });
});

describe("GET /api/admin/notifications/subscriptions", () => {
  test("requires admin key when configured", async () => {
    const dir = tempDir();
    const app = loadApp({ adminKey: "test-key", dir });
    const noKey = await supertest(app).get("/api/admin/notifications/subscriptions");
    expect(noKey.status).toBe(401);
    const withKey = await supertest(app)
      .get("/api/admin/notifications/subscriptions")
      .set("x-admin-key", "test-key");
    expect(withKey.status).toBe(200);
  });

  test("returns count + timestamps; rows include only opaque hashes", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "https://example.com/p", keys: { p256dh: "p", auth: "a" } });
    const res = await supertest(app).get("/api/admin/notifications/subscriptions");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.endpointHash).toMatch(/^[a-f0-9]{16}$/);
    // Raw endpoint must NEVER appear in admin responses.
    expect(row.endpoint).toBeUndefined();
    expect(row.keys).toBeUndefined();
  });
});

describe("POST /api/admin/notifications/broadcast", () => {
  test("400 on missing title", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/admin/notifications/broadcast")
      .send({ body: "x" });
    expect(res.status).toBe(400);
  });

  test("400 rejects absolute non-relative URLs", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app)
      .post("/api/admin/notifications/broadcast")
      .send({ title: "T", body: "B", url: "https://malicious.example/" });
    expect(res.status).toBe(400);
  });

  test("dryRun returns recipient count without sending", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const sub = await supertest(app)
      .post("/api/notifications/subscribe")
      .send({ endpoint: "https://example.com/p", keys: { p256dh: "p", auth: "a" } });
    expect(sub.status).toBe(201);
    const res = await supertest(app)
      .post("/api/admin/notifications/broadcast")
      .send({ title: "Hi", body: "Test", url: "/", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.result.recipients).toBe(1);
  });
});

describe("VAPID private key never leaks", () => {
  test("private key is absent from /api/meta", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const stubListener = (port, host, cb) => { if (cb) setImmediate(cb); return { close: () => {} }; };
    await app.startServer(stubListener);
    const res = await supertest(app).get("/api/meta");
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("privateKey");
    expect(json).not.toContain("pushKeys");
    app.stopSchedulerInterval();
    app.dailyNotificationScheduler.shutdown();
  });

  test("private key is absent from /api/admin/notifications/subscriptions", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const stubListener = (port, host, cb) => { if (cb) setImmediate(cb); return { close: () => {} }; };
    await app.startServer(stubListener);
    const res = await supertest(app).get("/api/admin/notifications/subscriptions");
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("privateKey");
    expect(json).not.toContain("pushKeys");
    app.stopSchedulerInterval();
    app.dailyNotificationScheduler.shutdown();
  });
});
