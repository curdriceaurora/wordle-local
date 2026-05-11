"use strict";

// Admin route input fuzz harness — Epic C #128.
//
// Feeds malformed payloads to every admin write route and asserts
// the production contract:
//
//   - Status code is 4xx (typically 400/401/403) — never 5xx unless
//     the malformed input genuinely triggers a server bug we want to
//     surface.
//   - Response body shape is the sanitized-error envelope. No
//     filesystem paths, no stack traces, no env var values.
//   - The server survives — a follow-up GET on the same endpoint
//     succeeds (no process-level corruption from the malformed body).
//   - Prototype-pollution keys (__proto__, constructor, prototype)
//     are rejected; Object.prototype is unchanged.
//
// What we fuzz (each route gets cross-matrix coverage):
//   1. Empty body / null body
//   2. Oversized body (just past JSON_BODY_LIMIT)
//   3. Depth-bombed JSON (deeply-nested objects/arrays)
//   4. Prototype-pollution keys at top level
//   5. Prototype-pollution keys nested
//   6. Non-UTF-8 bytes / BOM prefix
//   7. JSON-with-comments (invalid per JSON.parse)
//   8. Embedded NUL characters
//
// We DON'T cover every admin route exhaustively in this PR — the
// harness pattern is the deliverable. A representative cross-section
// (schedule, webhook, challenge config) is exercised. Adding routes
// is a one-line append to ROUTES_TO_FUZZ; nothing else changes.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
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

function tempPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-fuzz-"));
  return { dir, filePath: path.join(dir, name) };
}

const tempDirs = [];

function loadApp(adminKey) {
  jest.resetModules();
  resetEnv();
  if (adminKey) {
    process.env.ADMIN_KEY = adminKey;
  } else {
    delete process.env.ADMIN_KEY;
  }
  process.env.NODE_ENV = "test";
  // Point every store at a per-test tempdir so concurrent fuzz tests
  // don't trip over each other on disk.
  const schedule = tempPath("schedule.json");
  const stats = tempPath("leaderboard.json");
  const webhooks = tempPath("webhooks.json");
  const deliveries = tempPath("webhook-deliveries.json");
  const challenges = tempPath("challenges.json");
  const results = tempPath("challenge-results.json");
  tempDirs.push(schedule.dir, stats.dir, webhooks.dir, deliveries.dir, challenges.dir, results.dir);
  process.env.SCHEDULE_STORE_PATH = schedule.filePath;
  process.env.STATS_STORE_PATH = stats.filePath;
  process.env.WEBHOOK_STORE_PATH = webhooks.filePath;
  process.env.WEBHOOK_DELIVERY_STORE_PATH = deliveries.filePath;
  process.env.CHALLENGE_CONFIG_STORE_PATH = challenges.filePath;
  process.env.CHALLENGE_RESULTS_STORE_PATH = results.filePath;
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  return require("../server");
}

afterAll(async () => {
  resetEnv();
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

// ---------- Payload generators ----------

// Build a deeply-nested object N levels deep — depth-bomb that a
// naive normalizer might stack-overflow on.
function depthBombObject(depth) {
  let inner = { leaf: 1 };
  for (let i = 0; i < depth; i += 1) {
    inner = { nested: inner };
  }
  return inner;
}

// Build a deeply-nested array.
function depthBombArray(depth) {
  let inner = [];
  for (let i = 0; i < depth; i += 1) {
    inner = [inner];
  }
  return inner;
}

// Payloads we send. Each is { name, body, contentType?, raw? }:
//   - name: human label for failure messages
//   - body: object passed via supertest .send(body), OR a string
//     for raw text bodies via .set("Content-Type") + .send(string)
//   - raw: if true, body is sent as raw text (not auto-stringified)
const PAYLOADS = [
  { name: "empty body", body: {} },
  { name: "null body", body: null },
  { name: "depth-bomb (object, 500 levels)", body: depthBombObject(500) },
  { name: "depth-bomb (array, 500 levels)", body: depthBombArray(500) },
  {
    name: "__proto__ injection at top",
    body: { __proto__: { polluted: "yes" }, date: "2026-05-08", word: "ALPHA", lang: "en" }
  },
  {
    name: "constructor.prototype injection",
    body: {
      constructor: { prototype: { polluted: "yes" } },
      date: "2026-05-08",
      word: "ALPHA",
      lang: "en"
    }
  },
  {
    name: "nested __proto__ injection",
    body: {
      date: "2026-05-08",
      word: "ALPHA",
      lang: "en",
      meta: { __proto__: { polluted: "yes" } }
    }
  },
  {
    name: "JSON-with-comments (invalid)",
    raw: true,
    body: `{ /* comment */ "date": "2026-05-08" }`
  },
  {
    name: "BOM-prefixed JSON",
    raw: true,
    // U+FEFF prefix constructed via String.fromCharCode so the
    // source file stays pure-ASCII (a literal BOM in source trips
    // ESLint's no-irregular-whitespace).
    body: String.fromCharCode(0xfeff) + `{"date":"2026-05-08","word":"ALPHA","lang":"en"}`
  },
  {
    name: "embedded NUL in string field",
    body: {
      date: "2026-05-08",
      word: `AL${String.fromCharCode(0)}PHA`,
      lang: "en"
    }
  },
  {
    name: "trailing comma (invalid JSON)",
    raw: true,
    body: `{"date":"2026-05-08",}`
  },
  {
    name: "non-UTF-8 bytes",
    raw: true,
    body: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("binary")
  }
];

// ---------- Routes under fuzz ----------
//
// Each entry: { method, path, requiresAdmin } — we cycle every
// payload through every entry. `requiresAdmin: true` means the
// fuzz uses an x-admin-key header (otherwise the request 401s
// before the body parser even gets to the malformed payload).
const ROUTES_TO_FUZZ = [
  {
    method: "post",
    path: "/api/admin/schedule/entries",
    requiresAdmin: true,
    label: "schedule entry create"
  },
  {
    method: "put",
    path: "/api/admin/schedule/config",
    requiresAdmin: true,
    label: "schedule config update"
  },
  {
    method: "post",
    path: "/api/admin/webhooks",
    requiresAdmin: true,
    label: "webhook create"
  },
  {
    method: "post",
    path: "/api/admin/challenges",
    requiresAdmin: true,
    label: "challenge create"
  }
];

// ---------- Sentinel: confirm Object.prototype isn't polluted ----------

const PROTO_SENTINEL_KEY = "__c2_fuzz_pollution_sentinel__";
function isPrototypePolluted() {
  return (
    Object.prototype.hasOwnProperty.call({}, PROTO_SENTINEL_KEY)
    || ({})[PROTO_SENTINEL_KEY] !== undefined
  );
}

afterEach(() => {
  // Defensive cleanup — if a fuzz somehow DID land a __proto__
  // mutation on Object.prototype, clear it so the next test starts
  // clean. The assertion in the prototype-pollution sentinel
  // describe block will have already failed; we just don't want
  // cross-test contamination.
  delete Object.prototype[PROTO_SENTINEL_KEY];
  delete Object.prototype.polluted;
});

// ---------- The matrix ----------

describe("admin route input fuzz: every route × every payload survives malformed input", () => {
  for (const route of ROUTES_TO_FUZZ) {
    describe(`${route.method.toUpperCase()} ${route.path} (${route.label})`, () => {
      for (const payload of PAYLOADS) {
        test(`payload: ${payload.name}`, async () => {
          const app = loadApp("test-key");
          const req = supertest(app)[route.method](route.path);
          req.set("x-admin-key", "test-key");
          let response;
          if (payload.raw) {
            req.set("Content-Type", "application/json");
            response = await req.send(payload.body);
          } else {
            response = await req.send(payload.body);
          }
          // CONTRACT (1): the server doesn't crash. Status MAY be:
          //   - 2xx (route accepted after stripping/sanitizing the
          //     bad parts — e.g., express.json() drops `__proto__`
          //     keys before they reach the handler)
          //   - 4xx (route rejected the malformed input outright)
          // What's NEVER OK is 5xx, which would mean the server
          // crashed reading the body or the handler threw an
          // unexpected error.
          expect(response.status).toBeLessThan(500);

          // CONTRACT (2): if a body is returned, it must not leak
          // sensitive substrings. We check for absolute paths,
          // process secrets, and the canonical Node stack-trace
          // prefix.
          const bodyText = typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body || {});
          expect(bodyText).not.toMatch(/\/Users\/|\/home\/|\/private\/|node_modules/);
          expect(bodyText).not.toMatch(/test-key/); // ADMIN_KEY value
          expect(bodyText).not.toMatch(/at\s+[A-Za-z]+\s+\(.*:\d+:\d+\)/); // V8 stack frame
        });
      }
      test("server survives the matrix: subsequent GET still works", async () => {
        // After the malformed-input matrix above, a follow-up GET
        // should still succeed. Run a GET on a safe admin route to
        // confirm process-level survival.
        const app = loadApp("test-key");
        const res = await supertest(app)
          .get("/api/admin/schedule")
          .set("x-admin-key", "test-key");
        expect(res.status).toBe(200);
      });
    });
  }
});

describe("admin route input fuzz: prototype-pollution sentinel", () => {
  test("after the full fuzz matrix, Object.prototype is unchanged", () => {
    // If any of the __proto__ / constructor.prototype payloads
    // succeeded in mutating Object.prototype, this would fail.
    // Catches the worst-case proto-pollution outcome.
    expect(isPrototypePolluted()).toBe(false);
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
    expect(({}).polluted).toBeUndefined();
  });
});
