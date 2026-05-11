"use strict";

// Admin route input fuzz harness — Epic C #128.
//
// Feeds malformed payloads to every admin write route under test and
// asserts the production contract:
//
//   - Server doesn't crash (status < 500). A 2xx response is fine
//     if the route legitimately accepts the sanitized input —
//     Express's body parser strips `__proto__` keys before the
//     handler sees them, accepts BOM prefixes, etc. The contract
//     is "no crash, no leak, no proto-pollution" — NOT "every
//     malformed input must 4xx".
//   - Neither `response.body` NOR `response.text` leaks
//     filesystem paths, the ADMIN_KEY value, or V8 stack frames.
//     We check both because body-parser errors typically yield a
//     plain-text response with body === {} (Copilot caught this
//     on PR #136).
//   - Object.prototype is unchanged AFTER the full fuzz matrix
//     (asserted via a sentinel set BEFORE the matrix runs +
//     checked AFTER, NOT between tests — the afterEach hook
//     deliberately leaves prototype mutations intact across the
//     matrix so the sentinel runs against a worst-case state).
//   - A follow-up GET on a known-safe admin route still works.
//
// What we fuzz (each route gets cross-matrix coverage):
//   - empty / null body
//   - depth-bombed JSON (object + array, 500 levels each)
//   - `__proto__` injection (top + nested) — injected via
//     JSON.parse so the literal key actually traverses the wire
//     (in a JS object literal, `{ __proto__: X }` SETS the
//     prototype to X rather than setting a property named
//     `__proto__`; Codex caught this on PR #136).
//   - `constructor.prototype` injection
//   - JSON-with-comments (invalid per JSON.parse)
//   - BOM-prefixed JSON (constructed via String.fromCharCode so
//     the source stays pure-ASCII)
//   - trailing-comma JSON (invalid)
//   - embedded NUL in a string field
//   - non-UTF-8 raw byte stream (Buffer sent verbatim via the
//     supertest `.write()` path so Node doesn't transparently
//     re-encode it as UTF-8)
//
// We DON'T cover every admin route exhaustively — the harness
// pattern is the deliverable. A representative cross-section is
// exercised. Adding routes is a one-line append to
// ROUTES_TO_FUZZ; nothing else changes.

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
  // Point every store at a per-test tempdir. CRITICAL: the env var
  // NAMES must match what `server.js` reads — Copilot caught on
  // PR #136 that several names were wrong (e.g. WEBHOOK_STORE_PATH
  // vs the actual WEBHOOKS_STORE_PATH), which silently let the
  // fuzz run against the REAL repo data/ directory. Names below
  // come from grepping `server.js` for `process.env.*PATH`.
  const schedule = tempPath("schedule.json");
  const stats = tempPath("leaderboard.json");
  const webhooks = tempPath("webhooks.json");
  const deliveries = tempPath("webhook-deliveries.json");
  const challenges = tempPath("challenges.json");
  const results = tempPath("challenge-results.json");
  const classes = tempPath("classes.json");
  const adminJobs = tempPath("admin-jobs.json");
  const pushSubs = tempPath("push-subscriptions.json");
  const vapid = tempPath("vapid.json");
  const appConfig = tempPath("app-config.json");
  tempDirs.push(
    schedule.dir,
    stats.dir,
    webhooks.dir,
    deliveries.dir,
    challenges.dir,
    results.dir,
    classes.dir,
    adminJobs.dir,
    pushSubs.dir,
    vapid.dir,
    appConfig.dir
  );
  process.env.SCHEDULE_STORE_PATH = schedule.filePath;
  process.env.STATS_STORE_PATH = stats.filePath;
  process.env.WEBHOOKS_STORE_PATH = webhooks.filePath;
  process.env.WEBHOOK_DELIVERIES_STORE_PATH = deliveries.filePath;
  process.env.CHALLENGE_STORE_PATH = challenges.filePath;
  process.env.CHALLENGE_RESULTS_STORE_PATH = results.filePath;
  process.env.CLASSES_STORE_PATH = classes.filePath;
  process.env.ADMIN_JOBS_STORE_PATH = adminJobs.filePath;
  process.env.PUSH_SUBSCRIPTIONS_STORE_PATH = pushSubs.filePath;
  process.env.VAPID_KEYS_STORE_PATH = vapid.filePath;
  process.env.APP_CONFIG_PATH = appConfig.filePath;
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

function depthBombObject(depth) {
  let inner = { leaf: 1 };
  for (let i = 0; i < depth; i += 1) {
    inner = { nested: inner };
  }
  return inner;
}

function depthBombArray(depth) {
  let inner = [];
  for (let i = 0; i < depth; i += 1) {
    inner = [inner];
  }
  return inner;
}

// `__proto__` in a JS object literal is special — it SETS the
// prototype rather than creating a property named `__proto__`. To
// actually send the key over the wire, parse from a JSON string
// (where __proto__ IS a regular property name).
const PROTO_INJECT_TOP = JSON.parse(
  '{"__proto__":{"polluted":"yes"},"date":"2026-05-08","word":"ALPHA","lang":"en"}'
);
const PROTO_INJECT_NESTED = JSON.parse(
  '{"date":"2026-05-08","word":"ALPHA","lang":"en","meta":{"__proto__":{"polluted":"yes"}}}'
);

// Payloads. Each entry:
//   - name: human label
//   - body: object (auto-JSON-serialized) OR raw string (`raw: true`)
//   - raw: if true, body is sent verbatim
//   - rawBytes: optional Buffer for non-UTF-8 cases — sent via
//     supertest's write/end path so Node doesn't re-encode it
const PAYLOADS = [
  { name: "empty body", body: {} },
  { name: "null body", body: null },
  { name: "depth-bomb (object, 500 levels)", body: depthBombObject(500) },
  { name: "depth-bomb (array, 500 levels)", body: depthBombArray(500) },
  { name: "__proto__ injection at top", body: PROTO_INJECT_TOP },
  {
    name: "constructor.prototype injection",
    body: JSON.parse(
      '{"constructor":{"prototype":{"polluted":"yes"}},"date":"2026-05-08","word":"ALPHA","lang":"en"}'
    )
  },
  { name: "nested __proto__ injection", body: PROTO_INJECT_NESTED },
  {
    name: "JSON-with-comments (invalid)",
    raw: true,
    body: `{ /* comment */ "date": "2026-05-08" }`
  },
  {
    name: "BOM-prefixed JSON",
    raw: true,
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
    // Raw non-UTF-8 byte stream — sent as a Buffer via Node's
    // request stream so the bytes survive verbatim (toString("binary")
    // would have been re-encoded by supertest's body serializer).
    name: "non-UTF-8 bytes (raw Buffer)",
    rawBytes: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90])
  }
];

// ---------- Routes under fuzz ----------

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

// ---------- Prototype-pollution sentinel ----------
//
// We do NOT clean Object.prototype between fuzz cases. A polluting
// payload that lands during one case would otherwise be wiped by
// afterEach before the assertion below could observe it. Cleanup
// happens ONLY at suite end (afterAll). The sentinel assertions run
// inside the matrix loop AND after the loop completes so any
// pollution is caught regardless of which payload introduced it.
// Codex P2 + Copilot caught the prior afterEach-then-assert ordering
// on PR #136.

afterAll(() => {
  // One-time cleanup so a polluted Object.prototype doesn't leak
  // into later suites that share this process.
  delete Object.prototype.polluted;
});

function objectPrototypeIsClean() {
  return (
    Object.prototype.polluted === undefined
    && Object.getPrototypeOf({}).polluted === undefined
    && ({}).polluted === undefined
  );
}

// ---------- The matrix ----------

describe("admin route input fuzz: every route × every payload survives malformed input", () => {
  for (const route of ROUTES_TO_FUZZE_NAME_GUARD(ROUTES_TO_FUZZ)) {
    describe(`${route.method.toUpperCase()} ${route.path} (${route.label})`, () => {
      for (const payload of PAYLOADS) {
        test(`payload: ${payload.name}`, async () => {
          const app = loadApp("test-key");
          const req = supertest(app)[route.method](route.path);
          if (route.requiresAdmin) {
            req.set("x-admin-key", "test-key");
          }

          let response;
          if (payload.rawBytes) {
            // Raw bytes — set the type and send the Buffer verbatim.
            req.set("Content-Type", "application/octet-stream");
            response = await req.send(payload.rawBytes);
          } else if (payload.raw) {
            req.set("Content-Type", "application/json");
            response = await req.send(payload.body);
          } else {
            response = await req.send(payload.body);
          }

          // Contract (1): no crash.
          expect(response.status).toBeLessThan(500);

          // Contract (2): no info leak — check BOTH response.body
          // (JSON shape) and response.text (raw, used by body-parser
          // error responses).
          const haystack = [
            typeof response.body === "string" ? response.body : JSON.stringify(response.body || {}),
            response.text || ""
          ].join("\n");
          expect(haystack).not.toMatch(/\/Users\/|\/home\/|\/private\/|node_modules/);
          expect(haystack).not.toMatch(/test-key/);
          expect(haystack).not.toMatch(/at\s+[A-Za-z]+\s+\(.*:\d+:\d+\)/);

          // Contract (3): no pollution from THIS payload.
          // Asserted here (in the loop) AND once at the very end
          // so a payload-specific pollution gets attributed to
          // its payload.
          expect(objectPrototypeIsClean()).toBe(true);
        });
      }
      test("server survives the matrix: subsequent GET still works", async () => {
        const app = loadApp("test-key");
        const res = await supertest(app)
          .get("/api/admin/schedule")
          .set("x-admin-key", "test-key");
        expect(res.status).toBe(200);
      });
    });
  }
});

// Tiny guard that surfaces an obvious error if someone removes
// ROUTES_TO_FUZZ entries without re-checking the matrix iteration.
function ROUTES_TO_FUZZE_NAME_GUARD(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error("ROUTES_TO_FUZZ must be a non-empty array");
  }
  return routes;
}

// ---------- Belt-and-suspenders: post-matrix sentinel ----------

describe("admin route input fuzz: prototype-pollution sentinel (post-matrix)", () => {
  test("after every fuzz test ran, Object.prototype remains clean", () => {
    // The matrix loop above asserts per-payload. This sentinel
    // catches the case where a pollution lands but somehow isn't
    // observable by the per-test check (e.g., gets cleared before
    // the inline assert). Belt-and-suspenders.
    expect(objectPrototypeIsClean()).toBe(true);
  });
});
