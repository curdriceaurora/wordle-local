"use strict";

// A3 / #116: lock-in for the small-body Content-Length pre-check
// applied in server.js. The guard runs BEFORE express.json so that
// payloads way larger than a player API endpoint legitimately needs
// are rejected with 413 without burning CPU on JSON parsing. Sites
// the guard covers (`/api/stats/*`, `/api/challenges/*`,
// `/api/push/*`, `/api/notifications/*`) accept sub-KiB bodies in
// practice; the cap is 256 KiB so a future modest expansion has
// headroom before the guard fires.

const request = require("supertest");
const fs = require("node:fs");
const path = require("node:path");

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_WORD_DATA = fs.readFileSync(
  path.join(__dirname, "..", "data", "word.json"),
  "utf8"
);

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function loadApp() {
  delete require.cache[require.resolve("../server")];
  return require("../server");
}

afterEach(() => {
  // Restore data file (some tests may have touched it) and env.
  fs.writeFileSync(
    path.join(__dirname, "..", "data", "word.json"),
    ORIGINAL_WORD_DATA
  );
  resetEnv();
});

const COVERED_PATHS = [
  "/api/stats/result",
  "/api/challenges/something/sessions/x/guess",
  "/api/push/subscribe",
  "/api/notifications/broadcast"
];

const UNCOVERED_PATH = "/api/word"; // admin path (write); should NOT be size-limited by the small-body guard.

const OVERSIZED_BYTES = 300 * 1024; // > SMALL_BODY_LIMIT_BYTES (256 KiB)
const ALLOWED_BYTES = 100 * 1024; // < SMALL_BODY_LIMIT_BYTES

describe("small-body Content-Length guard", () => {
  for (const targetPath of COVERED_PATHS) {
    test(`POST ${targetPath} rejects 300 KiB body with 413`, async () => {
      process.env.RATE_LIMIT_MAX = "10000";
      process.env.RATE_LIMIT_WINDOW_MS = "60000";
      const app = loadApp();
      const oversized = "x".repeat(OVERSIZED_BYTES);
      const res = await request(app)
        .post(targetPath)
        .set("Content-Type", "application/json")
        .set("Content-Length", String(oversized.length))
        .send(oversized);
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/too large for this endpoint/i);
    });
  }

  test(`POST ${COVERED_PATHS[0]} accepts a 100 KiB body (under the limit) and falls through to handler validation`, async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const app = loadApp();
    // A 100 KiB body should NOT be rejected by the guard. The handler
    // itself will fail with 400/404 because the JSON shape is wrong,
    // but specifically NOT 413 (which is what the guard returns).
    const allowedBody = JSON.stringify({ junk: "x".repeat(ALLOWED_BYTES - 20) });
    const res = await request(app)
      .post(COVERED_PATHS[0])
      .set("Content-Type", "application/json")
      .send(allowedBody);
    expect(res.status).not.toBe(413);
  });

  test(`GET on a covered path is not affected by the guard`, async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const app = loadApp();
    // GET requests don't carry a body; the guard short-circuits.
    const res = await request(app).get(COVERED_PATHS[0]);
    expect(res.status).not.toBe(413);
  });

  test(`uncovered admin path ${UNCOVERED_PATH} still accepts payloads up to JSON_BODY_LIMIT`, async () => {
    process.env.RATE_LIMIT_MAX = "10000";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    process.env.ADMIN_KEY = "secret-test";
    const app = loadApp();
    const oversizedForSmallGuard = "x".repeat(OVERSIZED_BYTES);
    // Posting 300 KiB to /api/word should NOT trip the small-body
    // guard (it's not in SMALL_BODY_PATH_PREFIXES). It WILL fail with
    // 400 (bad JSON) or 401 (no admin key) downstream — but not 413.
    const res = await request(app)
      .post(UNCOVERED_PATH)
      .set("Content-Type", "application/json")
      .set("Content-Length", String(oversizedForSmallGuard.length))
      .send(oversizedForSmallGuard);
    expect(res.status).not.toBe(413);
  });
});
