"use strict";

// Pins the wiring of api/[...path].js — the Vercel serverless entrypoint
// added for PR #160's deploy preview. Verifies the pieces that aren't
// reused from routes/game.js or routes/meta.js (rate limit headers, JSON
// body-size + parse error handling, the STATIC_DEPLOY_ENDPOINT_MISSING
// 404 contract, and that x-powered-by is suppressed). Asked for by
// Copilot review on PR #160 so the Vercel-specific seams don't
// regress silently — the main Express app's test suite never touches
// this file.

const supertest = require("supertest");
const app = require("../api/[...path]");

describe("vercel api entrypoint", () => {
  describe("meta endpoint", () => {
    test("reports a single-language registry (English only)", async () => {
      const res = await supertest(app).get("/api/meta");
      expect(res.status).toBe(200);
      expect(res.body.languages).toHaveLength(1);
      expect(res.body.languages[0]).toMatchObject({
        id: "en",
        label: "English"
      });
      expect(res.body.defaultLang).toBe("en");
      expect(res.body.minLength).toBe(3);
      expect(res.body.maxLength).toBe(12);
    });

    test("exposes deploy-capability flags as false so the UI can hide broken links", async () => {
      const res = await supertest(app).get("/api/meta");
      // Front-end reads these flags and hides the matching nav links
      // (e.g. "Daily Word" → /daily 404s without persistent state).
      // If a flag goes missing here, the link reappears and clicking
      // it lands on 404 NOT_FOUND.
      expect(res.body.dailyWordEnabled).toBe(false);
      expect(res.body.leaderboardEnabled).toBe(false);
      expect(res.body.challengesEnabled).toBe(false);
      expect(res.body.notificationsEnabled).toBe(false);
    });
  });

  describe("gameplay endpoints", () => {
    test("POST /api/random returns a 3+-letter word and its encoded code", async () => {
      const res = await supertest(app)
        .post("/api/random")
        .set("Content-Type", "application/json")
        .send({ lang: "en", length: 5 });
      expect(res.status).toBe(200);
      expect(res.body.word).toMatch(/^[A-Z]{5}$/);
      expect(res.body.code).toMatch(/^[A-Z]{5}$/);
      expect(res.body.lang).toBe("en");
    });

    test("POST /api/encode round-trips through /api/guess", async () => {
      const encode = await supertest(app)
        .post("/api/encode")
        .set("Content-Type", "application/json")
        .send({ word: "HELLO", lang: "en" });
      expect(encode.status).toBe(200);
      expect(encode.body.code).toMatch(/^[A-Z]+$/);

      const guess = await supertest(app)
        .post("/api/guess")
        .set("Content-Type", "application/json")
        .send({ code: encode.body.code, guess: "HELLO", lang: "en" });
      expect(guess.status).toBe(200);
      expect(guess.body.isCorrect).toBe(true);
      expect(guess.body.result).toEqual([
        "correct",
        "correct",
        "correct",
        "correct",
        "correct"
      ]);
    });
  });

  describe("disabled / out-of-scope endpoints", () => {
    test("POST /api/stats/result returns 404 with the documented code", async () => {
      const res = await supertest(app)
        .post("/api/stats/result")
        .set("Content-Type", "application/json")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("STATIC_DEPLOY_ENDPOINT_MISSING");
      expect(typeof res.body.error).toBe("string");
    });

    test("GET /api/admin/runtime-config returns 404 with the documented code", async () => {
      const res = await supertest(app).get("/api/admin/runtime-config");
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("STATIC_DEPLOY_ENDPOINT_MISSING");
    });
  });

  describe("body parsing error handling", () => {
    test("malformed JSON returns 400 with the same wording as server.js", async () => {
      const res = await supertest(app)
        .post("/api/encode")
        .set("Content-Type", "application/json")
        .send("{not-json");
      expect(res.status).toBe(400);
      // Match server.js:3243 verbatim so the front-end's error copy is
      // identical between local/Docker and Vercel paths.
      expect(res.body.error).toBe("Request body must be valid JSON.");
    });

    test("oversize body (>32 KiB) returns 413 JSON, not Express HTML", async () => {
      const padded = JSON.stringify({ word: "HELLO", lang: "en", junk: "x".repeat(40 * 1024) });
      const res = await supertest(app)
        .post("/api/encode")
        .set("Content-Type", "application/json")
        .send(padded);
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/too large/i);
      // Front-end always parses res.json(); a stray HTML response would
      // crash with SyntaxError instead of giving the user a clean
      // toast.
      expect(res.headers["content-type"] || "").toMatch(/application\/json/);
    });
  });

  describe("hardening", () => {
    test("X-Powered-By is not advertised", async () => {
      const res = await supertest(app).get("/api/meta");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    test("rate-limit headers (RFC RateLimit-*) are exposed on responses", async () => {
      const res = await supertest(app).get("/api/meta");
      // express-rate-limit `standardHeaders: true` emits draft RFC
      // `RateLimit-*` headers (Limit / Remaining / Reset). If
      // standardHeaders gets dropped these go missing and clients can't
      // back off gracefully.
      expect(res.headers).toHaveProperty("ratelimit-limit");
      expect(res.headers).toHaveProperty("ratelimit-remaining");
    });
  });
});
