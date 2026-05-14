"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const request = require("supertest");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  });
  Object.assign(process.env, ORIGINAL_ENV);
}

function loadApp() {
  jest.resetModules();
  resetEnv();
  process.env.NODE_ENV = "test";
  // Minimal data paths so server can start cleanly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csp-test-"));
  process.env.LEADERBOARD_STORE_PATH = path.join(tmp, "leaderboard.json");
  process.env.CLASSES_STORE_PATH = path.join(tmp, "classes.json");
  return require("../server");
}

afterEach(resetEnv);

describe("Content-Security-Policy header", () => {
  let app;
  beforeAll(() => { app = loadApp(); });

  test("GET / includes CSP header", async () => {
    const res = await request(app).get("/");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  test("GET /admin includes CSP header", async () => {
    const res = await request(app).get("/admin");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  test("CSP default-src is self", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    expect(csp).toMatch(/default-src 'self'/);
  });

  test("CSP has no unsafe-eval", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  test("CSP style-src has no unsafe-inline", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    // Verify style-src directive does not contain 'unsafe-inline'.
    // This confirms classroom-report.html styles were extracted to admin.css.
    const styleSrc = csp.split(";").find((d) => d.trim().startsWith("style-src"));
    expect(styleSrc).toBeDefined();
    expect(styleSrc).not.toMatch(/unsafe-inline/);
  });

  test("CSP object-src is none", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    expect(csp).toMatch(/object-src 'none'/);
  });
});
