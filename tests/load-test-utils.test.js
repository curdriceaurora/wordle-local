"use strict";

const { parseArgs, percentile, summarize, round } = require("../scripts/load-test.js");

describe("percentile (C5 / #131)", () => {
  test("returns null for empty array", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test("returns the single value when array has one element", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });

  test("p50 of [1, 2, 3, 4, 5] is 3 (median)", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  test("p100 returns the max", () => {
    expect(percentile([10, 20, 30, 40, 50], 1.0)).toBe(50);
  });

  test("p0 returns the min", () => {
    expect(percentile([10, 20, 30, 40, 50], 0)).toBe(10);
  });

  test("interpolates linearly between adjacent ranks", () => {
    // 4 samples, p25: rank = 0.25 * 3 = 0.75 → between idx 0 and idx 1.
    // Interpolated: 10 + (20 - 10) * 0.75 = 17.5
    expect(percentile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5, 5);
  });

  test("clamps p > 1 to p = 1", () => {
    expect(percentile([1, 2, 3], 1.5)).toBe(3);
  });

  test("clamps p < 0 to p = 0", () => {
    expect(percentile([1, 2, 3], -0.5)).toBe(1);
  });
});

describe("summarize (C5 / #131)", () => {
  test("returns all-null on empty input", () => {
    expect(summarize([])).toEqual({
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null
    });
  });

  test("computes a sensible shape for a real-looking latency vector", () => {
    // Deterministic distribution (Copilot on PR #157 caught — random
    // samples make rare-tail flakes hard to reproduce). 100 samples:
    // 90% fast (3ms), 10% warm (25ms). Linear-interpolation
    // percentiles land cleanly on the cluster values; no
    // interpolation-edge surprises.
    const samples = [];
    for (let i = 0; i < 90; i += 1) samples.push(3);
    for (let i = 0; i < 10; i += 1) samples.push(25);
    const out = summarize(samples);
    expect(out.min).toBe(3);
    // p50: rank = 0.5 * 99 = 49.5; idx 49 and 50 both = 3 → 3
    expect(out.p50).toBe(3);
    // p95: rank = 0.95 * 99 = 94.05; idx 94 and 95 both = 25 → 25
    expect(out.p95).toBe(25);
    // p99: rank = 0.99 * 99 = 98.01; idx 98 and 99 both = 25 → 25
    expect(out.p99).toBe(25);
    expect(out.max).toBe(25);
    // mean = (90*3 + 10*25) / 100 = (270 + 250) / 100 = 5.2
    expect(out.mean).toBeCloseTo(5.2, 3);
  });

  test("sorts the input internally; does not mutate the caller's array", () => {
    const samples = [50, 10, 30, 20, 40];
    const before = samples.slice();
    summarize(samples);
    expect(samples).toEqual(before);
  });

  test("median of [1, 2, 3, 4] is 2.5 (interpolated)", () => {
    const out = summarize([1, 2, 3, 4]);
    expect(out.p50).toBe(2.5);
    expect(out.min).toBe(1);
    expect(out.max).toBe(4);
    expect(out.mean).toBe(2.5);
  });
});

describe("round (C5 / #131)", () => {
  test("returns null for null/undefined input", () => {
    expect(round(null)).toBeNull();
    expect(round(undefined)).toBeNull();
  });

  test("rounds to 2 decimals by default", () => {
    expect(round(3.14159)).toBe(3.14);
    expect(round(3.145)).toBeCloseTo(3.15, 5); // banker's-rounding edge tolerated
  });

  test("respects custom decimal count", () => {
    expect(round(1.23456789, 4)).toBe(1.2346);
    expect(round(1.23456789, 0)).toBe(1);
  });
});

describe("parseArgs (C5 / #131)", () => {
  test("defaults when no CLI args + no env", () => {
    const restoreUrl = process.env.BASE_URL;
    const restoreKey = process.env.ADMIN_KEY;
    delete process.env.BASE_URL;
    delete process.env.ADMIN_KEY;
    try {
      const args = parseArgs(["node", "load-test.js"]);
      expect(args).toMatchObject({
        baseUrl: "http://localhost:3000",
        scenario: "all",
        durationSec: 15,
        concurrency: 8,
        warmupSec: 2,
        adminKey: "",
        output: null
      });
    } finally {
      if (restoreUrl !== undefined) process.env.BASE_URL = restoreUrl;
      if (restoreKey !== undefined) process.env.ADMIN_KEY = restoreKey;
    }
  });

  test("CLI args override defaults", () => {
    const args = parseArgs([
      "node",
      "load-test.js",
      "--scenario=player-read",
      "--duration=30",
      "--concurrency=64",
      "--warmup=5",
      "--output=/tmp/baseline.json"
    ]);
    expect(args.scenario).toBe("player-read");
    expect(args.durationSec).toBe(30);
    expect(args.concurrency).toBe(64);
    expect(args.warmupSec).toBe(5);
    expect(args.output).toBe("/tmp/baseline.json");
  });

  test("BASE_URL env var is honored", () => {
    const restore = process.env.BASE_URL;
    process.env.BASE_URL = "https://example.com";
    try {
      const args = parseArgs(["node", "load-test.js"]);
      expect(args.baseUrl).toBe("https://example.com");
    } finally {
      if (restore === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = restore;
    }
  });

  test("ADMIN_KEY env var is honored", () => {
    const restore = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = "my-secret";
    try {
      const args = parseArgs(["node", "load-test.js"]);
      expect(args.adminKey).toBe("my-secret");
    } finally {
      if (restore === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = restore;
    }
  });

  test("negative duration clamps to 1 second floor (never zero)", () => {
    const args = parseArgs(["node", "load-test.js", "--duration=-5"]);
    expect(args.durationSec).toBe(1);
  });

  test("zero concurrency clamps to 1 (never zero)", () => {
    const args = parseArgs(["node", "load-test.js", "--concurrency=0"]);
    expect(args.concurrency).toBe(1);
  });

  // CR Major on PR #157
  test("concurrency clamps to 256 ceiling (unbounded values would destabilize)", () => {
    const args = parseArgs(["node", "load-test.js", "--concurrency=1024"]);
    expect(args.concurrency).toBe(256);
  });
});
