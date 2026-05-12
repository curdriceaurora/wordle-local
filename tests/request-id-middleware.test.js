"use strict";

const express = require("express");
const request = require("supertest");

const {
  createRequestIdMiddleware,
  isValidExternalId,
  mintRequestId,
  ID_REGEX
} = require("../lib/request-id-middleware");
const { getRequestId } = require("../lib/request-context");
const { createLogger } = require("../lib/logger");

describe("isValidExternalId", () => {
  test("accepts a plain UUID v4", () => {
    expect(isValidExternalId("3f29c1a2-2c01-4d2e-9c6e-4f4e1b2a8c30")).toBe(true);
  });
  test("accepts a 26-char ULID", () => {
    expect(isValidExternalId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
  });
  test("rejects too-short, too-long, empty, or non-string", () => {
    expect(isValidExternalId("short")).toBe(false);
    expect(isValidExternalId("")).toBe(false);
    expect(isValidExternalId(undefined)).toBe(false);
    expect(isValidExternalId(null)).toBe(false);
    expect(isValidExternalId(42)).toBe(false);
    expect(isValidExternalId("x".repeat(129))).toBe(false);
  });
  test("rejects header-injection / control chars", () => {
    expect(isValidExternalId("abcdefgh\nX-Injected: yes")).toBe(false);
    expect(isValidExternalId("abcdefgh<script>")).toBe(false);
    expect(isValidExternalId("abcdefgh/../etc")).toBe(false);
  });
  test("ID_REGEX is exported for downstream consumers", () => {
    expect(ID_REGEX).toBeInstanceOf(RegExp);
  });
});

describe("mintRequestId", () => {
  test("produces a UUID-shaped ID that passes our own validator", () => {
    const id = mintRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(isValidExternalId(id)).toBe(true);
  });
  test("two calls produce different IDs", () => {
    expect(mintRequestId()).not.toBe(mintRequestId());
  });
});

function makeApp({ extraMiddleware } = {}) {
  const app = express();
  app.use(createRequestIdMiddleware());
  if (extraMiddleware) app.use(extraMiddleware);
  app.get("/ok", (req, res) => {
    res.json({ ok: true, observedId: req.id, alsId: getRequestId() });
  });
  app.get("/err", (req, res) => {
    res.status(500).json({ error: "boom" });
  });
  app.get("/forbidden", (req, res) => {
    res.status(403).json({ error: "no", code: "FORBIDDEN" });
  });
  app.get("/data", (req, res) => {
    // 200 with NO `error` field — should NOT gain a requestId field.
    res.status(200).json({ data: [1, 2, 3] });
  });
  app.get("/already-stamped", (req, res) => {
    // Caller already supplied requestId — middleware should not overwrite.
    res.status(500).json({ error: "x", requestId: "caller-supplied" });
  });
  return app;
}

describe("createRequestIdMiddleware", () => {
  test("mints an ID when no header is supplied", async () => {
    const app = makeApp();
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(isValidExternalId(res.headers["x-request-id"])).toBe(true);
    expect(res.body.observedId).toBe(res.headers["x-request-id"]);
  });

  test("respects a valid incoming X-Request-ID header", async () => {
    const app = makeApp();
    const incoming = "01HMTRACE0123456789ABCDEFG";
    const res = await request(app).get("/ok").set("X-Request-ID", incoming);
    expect(res.headers["x-request-id"]).toBe(incoming);
    expect(res.body.observedId).toBe(incoming);
  });

  test("replaces an invalid incoming ID with a fresh one (charset rejection)", async () => {
    const app = makeApp();
    // `/` is a valid HTTP header byte but fails the strict ID charset
    // ([A-Za-z0-9._:-]) — superagent would refuse to even send a
    // literal newline, so we exercise the charset path via a path
    // separator instead, which is still a realistic injection shape.
    const res = await request(app).get("/ok").set("X-Request-ID", "bad/value/0123");
    expect(res.headers["x-request-id"]).not.toBe("bad/value/0123");
    expect(isValidExternalId(res.headers["x-request-id"])).toBe(true);
  });

  test("replaces a too-short incoming ID with a fresh one", async () => {
    const app = makeApp();
    const res = await request(app).get("/ok").set("X-Request-ID", "abc");
    expect(res.headers["x-request-id"]).not.toBe("abc");
    expect(isValidExternalId(res.headers["x-request-id"])).toBe(true);
  });

  test("ID is visible via AsyncLocalStorage inside the handler", async () => {
    const app = makeApp();
    const res = await request(app).get("/ok").set("X-Request-ID", "01HMTRACE0123456789ABCDEFG");
    expect(res.body.alsId).toBe("01HMTRACE0123456789ABCDEFG");
  });

  test("two concurrent requests get different IDs and don't cross streams", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([
      request(app).get("/ok"),
      request(app).get("/ok")
    ]);
    expect(a.body.observedId).not.toBe(b.body.observedId);
    expect(a.body.alsId).toBe(a.body.observedId);
    expect(b.body.alsId).toBe(b.body.observedId);
  });

  test("4xx/5xx error envelopes are decorated with requestId", async () => {
    const app = makeApp();
    const res = await request(app).get("/err");
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "boom" });
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  test("403 with a `code` field still gets the requestId added", async () => {
    const app = makeApp();
    const res = await request(app).get("/forbidden");
    expect(res.body).toMatchObject({ error: "no", code: "FORBIDDEN" });
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  test("2xx responses are NOT decorated", async () => {
    const app = makeApp();
    const res = await request(app).get("/data");
    expect(res.body).toEqual({ data: [1, 2, 3] });
    expect(res.body.requestId).toBeUndefined();
  });

  test("caller-supplied requestId in body is not overwritten", async () => {
    const app = makeApp();
    const res = await request(app).get("/already-stamped");
    expect(res.body.requestId).toBe("caller-supplied");
  });

  test("uppercase X-REQUEST-ID header is honored (case-insensitive)", async () => {
    const app = makeApp();
    const incoming = "01HMTRACE0123456789ABCDEFG";
    const res = await request(app).get("/ok").set("x-REQUEST-id", incoming);
    expect(res.headers["x-request-id"]).toBe(incoming);
  });
});

describe("end-to-end: failure response requestId matches the emitted log line (acceptance test)", () => {
  test("logger.error inside a failing handler tags the log with the same requestId echoed to the client", async () => {
    const lines = [];
    const stream = { write: (line) => lines.push(line) };
    const logger = createLogger({ level: "info", stdout: stream, stderr: stream });

    const app = express();
    app.use(createRequestIdMiddleware());
    app.get("/explode", (req, res) => {
      logger.error("handler.failed", { reason: "test-induced", err: new Error("kaboom") });
      res.status(500).json({ error: "Internal failure." });
    });

    const incoming = "01HMTRACE0123456789ABCDEFG";
    const res = await request(app).get("/explode").set("X-Request-ID", incoming);

    expect(res.status).toBe(500);
    expect(res.headers["x-request-id"]).toBe(incoming);
    expect(res.body.requestId).toBe(incoming);

    const errorLines = lines.map((l) => JSON.parse(l)).filter((r) => r.msg === "handler.failed");
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0].requestId).toBe(incoming);
    expect(errorLines[0].reason).toBe("test-induced");
    expect(errorLines[0].err.message).toBe("kaboom");
  });
});
