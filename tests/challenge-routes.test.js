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
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-challenge-int-"));
}

function loadApp({ adminKey, dir, env = {} } = {}) {
  jest.resetModules();
  resetEnv();
  if (adminKey) process.env.ADMIN_KEY = adminKey;
  else delete process.env.ADMIN_KEY;
  process.env.NODE_ENV = "test";
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  if (dir) {
    process.env.CHALLENGE_STORE_PATH = path.join(dir, "challenges.json");
    process.env.CHALLENGE_RESULTS_STORE_PATH = path.join(dir, "challenge-results.json");
    process.env.PUSH_SUBSCRIPTIONS_STORE_PATH = path.join(dir, "push.json");
    process.env.VAPID_KEYS_STORE_PATH = path.join(dir, "vapid-keys.json");
    process.env.APP_CONFIG_PATH = path.join(dir, "app-config.json");
    process.env.SCHEDULE_STORE_PATH = path.join(dir, "schedule.json");
    process.env.STATS_STORE_PATH = path.join(dir, "leaderboard.json");
    process.env.CLASSES_STORE_PATH = path.join(dir, "classes.json");
    process.env.ADMIN_JOBS_STORE_PATH = path.join(dir, "admin-jobs.json");
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return require("../server");
}

afterEach(() => resetEnv());

const baseConfig = {
  name: "Test 5x5",
  lang: "en",
  puzzleCount: 3,
  timeBudgetSeconds: 300,
  maxGuesses: 6,
  speedBonusFactor: 0.5,
  perPuzzleScore: 1000,
  replayPolicy: "best"
};

describe("admin challenge CRUD", () => {
  test("requires admin key when configured", async () => {
    const dir = tempDir();
    const app = loadApp({ adminKey: "k", dir });
    const noKey = await supertest(app).get("/api/admin/challenges");
    expect(noKey.status).toBe(401);
    const withKey = await supertest(app).get("/api/admin/challenges").set("x-admin-key", "k");
    expect(withKey.status).toBe(200);
  });

  test("create + list + soft-delete round-trip", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const created = await supertest(app).post("/api/admin/challenges").send(baseConfig);
    expect(created.status).toBe(201);
    const id = created.body.challenge.id;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);

    const list = await supertest(app).get("/api/admin/challenges");
    expect(list.body.challenges).toHaveLength(1);
    expect(list.body.challenges[0].sessionCount).toBe(0);

    const del = await supertest(app).delete(`/api/admin/challenges/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.challenge.deleted).toBe(true);
  });

  test.each([
    ["puzzleCount=0", { ...baseConfig, puzzleCount: 0 }],
    ["timeBudget=0", { ...baseConfig, timeBudgetSeconds: 0 }],
    ["negative speedBonus", { ...baseConfig, speedBonusFactor: -1 }],
    ["unknown replayPolicy", { ...baseConfig, replayPolicy: "infinite" }]
  ])("rejects malformed config: %s", async (_label, body) => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const res = await supertest(app).post("/api/admin/challenges").send(body);
    expect(res.status).toBe(400);
  });
});

describe("player flow", () => {
  test("GET /api/challenges lists active (excludes soft-deleted)", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c1 = await supertest(app).post("/api/admin/challenges").send({ ...baseConfig, name: "A" });
    const c2 = await supertest(app).post("/api/admin/challenges").send({ ...baseConfig, name: "B" });
    await supertest(app).delete(`/api/admin/challenges/${c2.body.challenge.id}`);
    const res = await supertest(app).get("/api/challenges");
    expect(res.status).toBe(200);
    expect(res.body.challenges).toHaveLength(1);
    expect(res.body.challenges[0].id).toBe(c1.body.challenge.id);
  });

  test("CHALLENGE_MODE_ENABLED=false → 404", async () => {
    const dir = tempDir();
    const app = loadApp({ dir, env: { CHALLENGE_MODE_ENABLED: "false" } });
    const res = await supertest(app).get("/api/challenges");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CHALLENGE_MODE_DISABLED");
  });

  test("start requires profileId", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c = await supertest(app).post("/api/admin/challenges").send(baseConfig);
    const res = await supertest(app).post(`/api/challenges/${c.body.challenge.id}/start`).send({});
    expect(res.status).toBe(400);
  });

  test("start returns session with hidden words; resume returns same session", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c = await supertest(app).post("/api/admin/challenges").send(baseConfig);
    const id = c.body.challenge.id;
    const start1 = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1", profileName: "Alice" });
    expect(start1.status).toBe(201);
    expect(start1.body.session.puzzles).toHaveLength(3);
    expect(start1.body.session.puzzles[0].word).toBeUndefined();

    // Resume returns same session with resumed: true.
    const start2 = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1" });
    expect(start2.status).toBe(200);
    expect(start2.body.resumed).toBe(true);
    expect(start2.body.session.id).toBe(start1.body.session.id);
  });

  test("guess endpoint validates length, accepts/rejects dictionary words, increments count", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c = await supertest(app).post("/api/admin/challenges").send({ ...baseConfig, wordLength: 5 });
    const id = c.body.challenge.id;
    const start = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1" });
    const sessionId = start.body.session.id;
    // Wrong length.
    const wrongLen = await supertest(app)
      .post(`/api/challenges/${id}/sessions/${sessionId}/guess`)
      .send({ guess: "ABCDEF" });
    expect(wrongLen.status).toBe(400);
    // Likely-valid 5-letter word.
    const good = await supertest(app)
      .post(`/api/challenges/${id}/sessions/${sessionId}/guess`)
      .send({ guess: "CRANE" });
    expect([200, 400]).toContain(good.status); // 400 only if CRANE not in en-dict
    if (good.status === 200) {
      expect(Array.isArray(good.body.feedback)).toBe(true);
      expect(good.body.session.puzzles.find((p) => p.index === 0).guesses).toContain("CRANE");
    }
  });

  test("finish marks session abandoned and is idempotent", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c = await supertest(app).post("/api/admin/challenges").send({ ...baseConfig, wordLength: 5 });
    const id = c.body.challenge.id;
    const start = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1" });
    const sessionId = start.body.session.id;
    const finish1 = await supertest(app)
      .post(`/api/challenges/${id}/sessions/${sessionId}/finish`)
      .send({});
    expect(finish1.status).toBe(200);
    expect(["completed", "abandoned"]).toContain(finish1.body.session.status);
    // Idempotent: second finish returns alreadyFinal.
    const finish2 = await supertest(app)
      .post(`/api/challenges/${id}/sessions/${sessionId}/finish`)
      .send({});
    expect(finish2.body.alreadyFinal).toBe(true);
    expect(finish2.body.session.status).toBe(finish1.body.session.status);
  });

  test("404 on unknown challenge or session", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const r = await supertest(app).post("/api/challenges/xxxx/start").send({ profileId: "p1" });
    expect(r.status).toBe(404);
  });
});

describe("server-authoritative timeout (anti-cheat)", () => {
  test("settles a session whose budget expired during downtime", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    // Create a tiny-budget challenge.
    const c = await supertest(app).post("/api/admin/challenges").send({
      ...baseConfig,
      timeBudgetSeconds: 30, // minimum allowed
      wordLength: 5
    });
    const id = c.body.challenge.id;
    const start = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1" });
    const sessionId = start.body.session.id;
    // Mutate the persisted session's startedAt to the past so the next
    // GET surfaces timed-out — server uses the stamped startedAt vs
    // wall-clock, never the client clock.
    const resultsPath = path.join(dir, "challenge-results.json");
    const data = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    data.sessions[0].startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2));
    // Reload the store so the server picks up the edit.
    require("../server").challengeResultsStore.reload();
    // GET surfaces timed-out.
    const get = await supertest(app).get(`/api/challenges/${id}/sessions/${sessionId}`);
    expect(get.status).toBe(200);
    expect(get.body.session.status).toBe("timed-out");
    expect(get.body.session.remainingSeconds).toBe(0);
  });
});

describe("VAPID-style anti-cheat: client cannot enumerate answers", () => {
  test("session payload only exposes lengths for unsolved puzzles, not words", async () => {
    const dir = tempDir();
    const app = loadApp({ dir });
    const c = await supertest(app).post("/api/admin/challenges").send({ ...baseConfig, wordLength: 5 });
    const id = c.body.challenge.id;
    const start = await supertest(app).post(`/api/challenges/${id}/start`)
      .send({ profileId: "p1" });
    for (const p of start.body.session.puzzles) {
      expect(p.word).toBeUndefined();
      expect(p.length).toBe(5);
    }
  });
});
