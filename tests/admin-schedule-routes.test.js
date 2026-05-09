"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const request = require("node:http").request;
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

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-sched-int-"));
  return path.join(dir, name);
}

function loadApp({ adminKey, schedulePath, statsPath }) {
  jest.resetModules();
  resetEnv();
  if (adminKey) {
    process.env.ADMIN_KEY = adminKey;
  } else {
    delete process.env.ADMIN_KEY;
  }
  process.env.NODE_ENV = "test";
  if (schedulePath) process.env.SCHEDULE_STORE_PATH = schedulePath;
  if (statsPath) process.env.STATS_STORE_PATH = statsPath;
  // Disable the scheduler interval driver: it would tick mid-test and fight
  // with our hand-driven HTTP calls. We still want the boot reconcile to
  // run because some tests check that data/word.json reflects the
  // schedule's state at boot.
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  return require("../server");
}

afterEach(() => {
  resetEnv();
});

// Avoid pulling in supertest for the whole file via destructuring import —
// it's already been loaded above.
void request;

describe("GET /api/admin/schedule", () => {
  test("returns the default schedule on first boot when no file exists", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app).get("/api/admin/schedule");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      auto_rotate: false,
      retention_days: 90,
      scheduled_words: []
    });
    // Default file is created on first read.
    expect(fs.existsSync(schedulePath)).toBe(true);
  });

  test("requires admin key when configured", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ adminKey: "test-key", schedulePath });
    const noKey = await supertest(app).get("/api/admin/schedule");
    expect(noKey.status).toBe(401);
    const withKey = await supertest(app)
      .get("/api/admin/schedule")
      .set("x-admin-key", "test-key");
    expect(withKey.status).toBe(200);
  });
});

describe("POST /api/admin/schedule/entries", () => {
  test("201 on add, 200 with replaced=true on overwrite, 409 on conflict without overwrite", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const r1 = await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "2026-05-08", word: "CRANE", lang: "en" });
    expect(r1.status).toBe(201);
    expect(r1.body.replaced).toBe(false);

    const r2 = await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "2026-05-08", word: "BREAD", lang: "en" });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe("DUPLICATE_ENTRY");

    const r3 = await supertest(app)
      .post("/api/admin/schedule/entries?overwrite=true")
      .send({ date: "2026-05-08", word: "BREAD", lang: "en" });
    expect(r3.status).toBe(200);
    expect(r3.body.replaced).toBe(true);
    expect(r3.body.entry.word).toBe("BREAD");
  });

  test("400 on shape violation", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "yesterday", word: "CRANE", lang: "en" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE");
  });
});

describe("PUT /api/admin/schedule/entries/:date/:lang", () => {
  test("partial update returns the merged entry", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "2026-05-08", word: "CRANE", lang: "en", notes: "first" });
    const res = await supertest(app)
      .put("/api/admin/schedule/entries/2026-05-08/en")
      .send({ word: "BREAD" });
    expect(res.status).toBe(200);
    expect(res.body.entry.word).toBe("BREAD");
    expect(res.body.entry.notes).toBe("first");
  });

  test("404 on missing entry", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app)
      .put("/api/admin/schedule/entries/2026-05-08/en")
      .send({ word: "BREAD" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ENTRY_NOT_FOUND");
  });
});

describe("DELETE /api/admin/schedule/entries/:date/:lang", () => {
  test("204 on success, 404 when missing", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "2026-05-08", word: "CRANE", lang: "en" });
    const r1 = await supertest(app).delete("/api/admin/schedule/entries/2026-05-08/en");
    expect(r1.status).toBe(204);
    const r2 = await supertest(app).delete("/api/admin/schedule/entries/2026-05-08/en");
    expect(r2.status).toBe(404);
  });
});

describe("PUT /api/admin/schedule/config", () => {
  test("updates auto_rotate, retention_days, timezone independently", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app)
      .put("/api/admin/schedule/config")
      .send({ auto_rotate: true, retention_days: 30, timezone: "America/New_York" });
    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({
      auto_rotate: true,
      retention_days: 30,
      timezone: "America/New_York"
    });
  });

  test("400 on invalid timezone", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app)
      .put("/api/admin/schedule/config")
      .send({ timezone: "Not/A/Zone" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_TIMEZONE");
  });
});

describe("POST /api/admin/schedule/prune", () => {
  test("removes entries older than retention_days from today", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    // Set retention to 1 day so almost everything in the past prunes.
    await supertest(app)
      .put("/api/admin/schedule/config")
      .send({ retention_days: 1 });
    await supertest(app)
      .post("/api/admin/schedule/entries")
      .send({ date: "2020-01-01", word: "OLD", lang: "en" });
    const res = await supertest(app).post("/api/admin/schedule/prune");
    expect(res.status).toBe(200);
    expect(res.body.pruned).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/admin/schedule/reconcile", () => {
  test("returns the reconcile decision for the current state", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const res = await supertest(app).post("/api/admin/schedule/reconcile");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toBeDefined();
    expect(typeof res.body.result.action).toBe("string");
  });
});

describe("audit logging", () => {
  test("emits a [schedule] log line for each write", async () => {
    const schedulePath = tempPath("schedule.json");
    const app = loadApp({ schedulePath });
    const captured = [];
    const origLog = console.log;
    console.log = (msg) => {
      const str = typeof msg === "string" ? msg : String(msg);
      if (str.includes("[schedule]")) captured.push(str);
    };
    try {
      await supertest(app)
        .post("/api/admin/schedule/entries")
        .send({ date: "2026-05-08", word: "CRANE", lang: "en" });
    } finally {
      console.log = origLog;
    }
    expect(captured.some((line) => line.includes("entries.add"))).toBe(true);
  });
});
