#!/usr/bin/env node
"use strict";

// Server load baseline test (C5 / #131).
//
// Drives a running wordle-local server against three scenarios —
// player-read, admin-auth (read-only — exercises the admin auth +
// rate-limit stack without performing real writes), and mixed —
// and reports RPS + latency percentiles. Self-contained: no
// autocannon / wrk / k6 dependency. Uses Node's built-in `http(s)`
// module + the Performance API.
//
// Usage
// -----
//
//   # Start the server in one terminal:
//   ADMIN_KEY=secret REQUIRE_ADMIN_KEY=true PORT=3000 node server.js
//
//   # In another terminal:
//   BASE_URL=http://localhost:3000 ADMIN_KEY=secret \
//     node scripts/load-test.js
//
//   # Or run just one scenario:
//   BASE_URL=http://localhost:3000 ADMIN_KEY=secret \
//     node scripts/load-test.js --scenario=player-read --duration=10
//
// Args
// ----
//
//   --scenario=<name>      One of: player-read, admin-auth, mixed, all
//                          (default: all)
//   --duration=<seconds>   How long each scenario runs (default: 15)
//   --concurrency=<N>      Concurrent in-flight requests per scenario
//                          (default: 8)
//   --warmup=<seconds>     Discard latency samples from the first N
//                          seconds to let JIT settle (default: 2)
//   --output=<path>        Write the JSON report to a file in addition
//                          to stdout (default: stdout only)
//
// Env
// ---
//
//   BASE_URL         — server URL (default http://localhost:3000)
//   ADMIN_KEY        — admin key for admin-auth + mixed scenarios
//
// Output shape
// ------------
//
//   {
//     "summary": { "totalRequests", "totalDurationMs", "wallStart", "wallEnd" },
//     "scenarios": [
//       {
//         "name": "player-read",
//         "requests": 1234,
//         "errors": 0,
//         "errorRate": 0.0,
//         "durationMs": 15003,
//         "rps": 82.3,
//         "latencyMs": {
//           "min": 1.2,
//           "p50": 4.1,
//           "p95": 12.7,
//           "p99": 28.4,
//           "max": 105.2,
//           "mean": 5.8
//         },
//         "statusCodes": { "200": 1230, "503": 4 }
//       },
//       ...
//     ]
//   }
//
// Out of scope (per #131):
//
//   - Distributed load (single-machine only).
//   - Stress-to-failure (this is a baseline, not a breaking-point test).
//   - Cross-version comparison harness (operator records baselines per
//     reference machine + records in docs).

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

// Use a keep-alive agent so the test measures HANDLER latency in
// steady state rather than the TCP handshake cost on every request.
// Real clients (browsers, fetch, axios, curl with -K) reuse
// connections; the baseline should match. Cap the per-host socket
// pool at the highest --concurrency we expect; that's 256 (CLI
// clamp), so size accordingly.
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });

const DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:3000",
  scenario: "all",
  durationSec: 15,
  concurrency: 8,
  warmupSec: 2
});

function parseArgs(argv) {
  const args = { ...DEFAULTS, adminKey: process.env.ADMIN_KEY || "", output: null };
  if (process.env.BASE_URL) args.baseUrl = process.env.BASE_URL;
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case "scenario":
        args.scenario = String(value);
        break;
      case "duration":
        args.durationSec = Math.max(1, Number(value) | 0);
        break;
      case "concurrency":
        // Clamp to [1, 256] (CR Major on PR #157 — unbounded
        // concurrency would spawn excessive workers and destabilize
        // baseline runs). 256 matches the HTTP agent's maxSockets
        // declared above; setting concurrency higher than that has
        // diminishing returns anyway.
        args.concurrency = Math.max(1, Math.min(256, Number(value) | 0));
        break;
      case "warmup":
        args.warmupSec = Math.max(0, Number(value) | 0);
        break;
      case "output":
        args.output = String(value);
        break;
      default:
        // Unknown flag; ignore rather than fail so the harness is
        // forgiving across versions.
        break;
    }
  }
  return args;
}

// Percentile from a presorted array of numbers. p in [0, 1].
// Uses linear interpolation between adjacent ranks (the same method
// numpy's `interpolation='linear'` uses).
function percentile(sortedSamples, p) {
  if (sortedSamples.length === 0) return null;
  if (sortedSamples.length === 1) return sortedSamples[0];
  const clamped = Math.max(0, Math.min(1, p));
  const rank = clamped * (sortedSamples.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedSamples[lo];
  const frac = rank - lo;
  return sortedSamples[lo] + (sortedSamples[hi] - sortedSamples[lo]) * frac;
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function summarize(latencySamples) {
  if (latencySamples.length === 0) {
    return { min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  }
  const sorted = latencySamples.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    min: round(sorted[0], 3),
    p50: round(percentile(sorted, 0.5), 3),
    p95: round(percentile(sorted, 0.95), 3),
    p99: round(percentile(sorted, 0.99), 3),
    max: round(sorted[sorted.length - 1], 3),
    mean: round(sum / sorted.length, 3)
  };
}

// Single-shot HTTP request. Returns { latencyMs, status, error }.
// Designed to never throw — errors are captured in the result.
//
// CR Major on PR #157: a per-request timeout is required so a
// stalled socket doesn't hang a worker past the scenario deadline.
// 10s is generous for any of our healthy endpoints; if the server
// is hanging, errorRate will spike and the operator should
// investigate rather than have the test compensate.
const REQUEST_TIMEOUT_MS = 10_000;

function makeRequest(target, options = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    function finalize(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }
    // Copilot on PR #157 caught: the doc comment says "never throws"
    // but `new URL(target)` and `http(s).request(...)` construction
    // both throw synchronously on bad input — which would reject the
    // promise and abort the whole scenario instead of being counted
    // in `errors`. Catching here keeps the contract.
    let url;
    let lib;
    let agent;
    try {
      url = new URL(target);
      lib = url.protocol === "https:" ? https : http;
      agent = url.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
    } catch (err) {
      finalize({
        latencyMs: performance.now() - startedAt,
        status: 0,
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
    let req;
    try {
      req = lib.request(
      {
        method: options.method || "GET",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: options.headers || {},
        agent,
        timeout: REQUEST_TIMEOUT_MS
      },
      (res) => {
        // Drain the body so the connection can be reused (keep-alive).
        res.resume();
        res.on("end", () => {
          finalize({
            latencyMs: performance.now() - startedAt,
            status: res.statusCode,
            error: null
          });
        });
        res.on("error", (err) => {
          finalize({
            latencyMs: performance.now() - startedAt,
            status: res.statusCode || 0,
            error: err.message
          });
        });
      }
    );
    } catch (err) {
      // http.request can throw synchronously on malformed options
      // (e.g., invalid header chars). Close the same path as a
      // network error.
      finalize({
        latencyMs: performance.now() - startedAt,
        status: 0,
        error: err && err.message ? err.message : String(err)
      });
      return;
    }
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", (err) => {
      finalize({
        latencyMs: performance.now() - startedAt,
        status: 0,
        error: err.message
      });
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Returns a function that emits the NEXT request to fire for the
// given scenario. The harness calls it on a tight loop per worker.
//
// Endpoint choice rationale (Codex P2 + Copilot + CR on PR #157):
//
// - player-read hits PUBLIC endpoints only. `/api/word` looked like
//   the obvious target but is admin-protected (`requireAdminAccess`,
//   see server.js:3657), so running the recommended
//   `REQUIRE_ADMIN_KEY=true` config would record 401s instead of
//   exercising the player path. `/api/meta` and
//   `/api/stats/leaderboard` are both public.
//
// - admin-auth (renamed from admin-write — Copilot caught: we never
//   POST any writes; we just hit admin-gated GETs to exercise the
//   admin auth gate + admin rate-limit stack). True admin writes
//   would need a body crafted for each endpoint; deferred.
function buildRequestFactory(scenarioName, args) {
  const { baseUrl, adminKey } = args;
  const adminHeaders = adminKey ? { "x-admin-key": adminKey } : {};
  switch (scenarioName) {
    case "player-read":
      return () => {
        const pick = Math.random();
        if (pick < 0.5) {
          return { url: `${baseUrl}/api/meta?lang=en`, options: { method: "GET" } };
        }
        return {
          url: `${baseUrl}/api/stats/leaderboard?lang=en&range=weekly`,
          options: { method: "GET" }
        };
      };
    case "admin-auth": {
      if (!adminKey) {
        throw new Error(
          "admin-auth scenario requires ADMIN_KEY env var; got empty. Set it or run --scenario=player-read."
        );
      }
      return () => {
        const pick = Math.random();
        if (pick < 0.5) {
          return {
            url: `${baseUrl}/api/admin/providers`,
            options: { method: "GET", headers: adminHeaders }
          };
        }
        return {
          url: `${baseUrl}/api/admin/jobs`,
          options: { method: "GET", headers: adminHeaders }
        };
      };
    }
    case "mixed": {
      // CR Major on PR #157: do not silently downgrade `mixed` to
      // pure player-read when ADMIN_KEY is missing — that produces a
      // misleading "mixed" baseline that doesn't reflect the
      // intended 10:1 read:admin ratio.
      if (!adminKey) {
        throw new Error(
          "mixed scenario requires ADMIN_KEY env var; got empty. Set it or run --scenario=player-read."
        );
      }
      const playerRead = buildRequestFactory("player-read", args);
      const adminAuth = buildRequestFactory("admin-auth", args);
      // Copilot on PR #157 caught: `0.91` yields a 10.1:1 ratio.
      // The exact 10:1 cutoff is 10/11 (~0.9090909). Using the
      // expression directly so the intent is grep-able.
      const PLAYER_READ_CUTOFF = 10 / 11;
      return () => {
        const pick = Math.random();
        if (pick < PLAYER_READ_CUTOFF) return playerRead();
        return adminAuth();
      };
    }
    default:
      throw new Error(`Unknown scenario: ${scenarioName}`);
  }
}

async function runScenario(scenarioName, args) {
  const requestFactory = buildRequestFactory(scenarioName, args);
  const latencies = [];
  const statusCodes = Object.create(null);
  let errors = 0;
  let requests = 0;
  const warmupDeadline = performance.now() + args.warmupSec * 1000;
  const endDeadline = performance.now() + (args.warmupSec + args.durationSec) * 1000;
  const startWall = Date.now();
  async function worker() {
    while (performance.now() < endDeadline) {
      const { url, options } = requestFactory();
      const result = await makeRequest(url, options);
      requests += 1;
      if (result.error || result.status === 0) errors += 1;
      statusCodes[result.status || "error"] = (statusCodes[result.status || "error"] || 0) + 1;
      // Discard samples from the warmup window.
      if (performance.now() >= warmupDeadline) {
        latencies.push(result.latencyMs);
      }
    }
  }
  const startedAt = performance.now();
  const workers = [];
  for (let i = 0; i < args.concurrency; i += 1) workers.push(worker());
  await Promise.all(workers);
  const durationMs = performance.now() - startedAt;
  const samplesDurationMs = Math.max(0, durationMs - args.warmupSec * 1000);
  const sampledRequests = latencies.length;
  return {
    name: scenarioName,
    requests,
    sampledRequests,
    errors,
    errorRate: requests === 0 ? 0 : round(errors / requests, 4),
    durationMs: round(durationMs, 1),
    samplesDurationMs: round(samplesDurationMs, 1),
    warmupSec: args.warmupSec,
    concurrency: args.concurrency,
    rps: samplesDurationMs > 0 ? round((sampledRequests / samplesDurationMs) * 1000, 1) : null,
    latencyMs: summarize(latencies),
    statusCodes,
    wallStart: new Date(startWall).toISOString(),
    wallEnd: new Date().toISOString()
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const scenariosToRun =
    args.scenario === "all" ? ["player-read", "admin-auth", "mixed"] : [args.scenario];
  const wallStart = Date.now();
  const report = {
    summary: {
      baseUrl: args.baseUrl,
      durationSec: args.durationSec,
      warmupSec: args.warmupSec,
      concurrency: args.concurrency,
      wallStart: new Date(wallStart).toISOString()
    },
    scenarios: []
  };
  for (const name of scenariosToRun) {
    try {
      const result = await runScenario(name, args);
      report.scenarios.push(result);
    } catch (err) {
      report.scenarios.push({
        name,
        skipped: true,
        reason: err && err.message ? err.message : String(err)
      });
    }
  }
  report.summary.wallEnd = new Date().toISOString();
  // Codex P2 on PR #157: if ANY scenario was skipped due to a
  // configuration failure (missing ADMIN_KEY for admin-auth/mixed),
  // exit non-zero so a release-checklist or CI step doesn't silently
  // pass a partial baseline. The skipped scenario is still recorded
  // in the report for debugging.
  const skippedCount = report.scenarios.filter((s) => s.skipped).length;
  if (skippedCount > 0) {
    report.summary.skippedCount = skippedCount;
    process.stderr.write(
      `load-test: ${skippedCount} scenario(s) skipped — see report.scenarios[].reason. Exiting non-zero.\n`
    );
  }
  const text = JSON.stringify(report, null, 2);
  process.stdout.write(text + "\n");
  if (args.output) {
    fs.writeFileSync(args.output, text + "\n");
  }
  // CR Major on PR #157: destroy the keep-alive agents so their
  // lingering sockets don't keep the event loop alive after main()
  // returns. Without this, node exits cleanly anyway (the agents'
  // socket idle timer eventually fires) but `node ... | head` and
  // similar invocations would block longer than they should.
  HTTP_AGENT.destroy();
  HTTPS_AGENT.destroy();
  if (skippedCount > 0) {
    process.exitCode = 2;
  }
}

// Library exports (for tests). When the script is executed directly,
// the `require.main === module` check fires main(). The exports let
// `tests/load-test-utils.test.js` exercise the pure helpers without
// spinning up a server.
module.exports = { parseArgs, percentile, summarize, round };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`load-test failed: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
