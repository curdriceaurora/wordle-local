"use strict";

// Unit tests for lib/store-health-probe.js (B7 follow-up / #205).
// Each store's healthCheck() delegates here; this file pins the
// helper's contract directly with real filesystem operations.

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  probeStoreFile,
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS
} = require("../lib/store-health-probe");

const TEMP_DIRS = [];

afterAll(async () => {
  await Promise.all(
    TEMP_DIRS.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
});

async function makeTempFile(contents) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-health-probe-"));
  TEMP_DIRS.push(dir);
  const filePath = path.join(dir, "store.json");
  await fsp.writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("probeStoreFile", () => {
  test("returns ok:true for a valid JSON file", async () => {
    const filePath = await makeTempFile(JSON.stringify({ version: 1, items: [] }));
    const result = await probeStoreFile(filePath);
    expect(result).toEqual({ ok: true });
  });

  test("returns ok:true with pre-bootstrap note for ENOENT", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-health-probe-"));
    TEMP_DIRS.push(dir);
    const filePath = path.join(dir, "never-created.json");
    const result = await probeStoreFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/pre-bootstrap/);
  });

  test("returns ok:false with parse error for malformed JSON", async () => {
    const filePath = await makeTempFile("{ not valid json");
    const result = await probeStoreFile(filePath);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    // Node's JSON parser error messages vary across versions; match
    // a stable substring.
    expect(result.error).toMatch(/JSON|Unexpected/i);
  });

  test("returns ok:false with parse error for empty file", async () => {
    const filePath = await makeTempFile("");
    const result = await probeStoreFile(filePath);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JSON|empty/i);
  });

  test("returns ok:false on non-string filePath", async () => {
    const result = await probeStoreFile(null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty or not a string/);
  });

  test("returns ok:false on empty filePath", async () => {
    const result = await probeStoreFile("");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty or not a string/);
  });

  test("honors a per-call timeoutMs override (mock-driven)", async () => {
    // Force the readFile path to hang by spying on fsp.readFile to
    // return a never-resolving promise. The timeout branch should
    // then win the race.
    const spy = jest.spyOn(fsp, "readFile").mockImplementation(() => new Promise(() => {}));
    try {
      const before = Date.now();
      const result = await probeStoreFile("/tmp/anything.json", { timeoutMs: 50 });
      const elapsed = Date.now() - before;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/health probe timeout/);
      // Should land near the 50 ms cap, definitely under the 2 s
      // default — proves the override is being honored.
      expect(elapsed).toBeLessThan(500);
    } finally {
      spy.mockRestore();
    }
  });

  test("DEFAULT_HEALTH_PROBE_TIMEOUT_MS is 2000", () => {
    expect(DEFAULT_HEALTH_PROBE_TIMEOUT_MS).toBe(2000);
  });

  test("probe doesn't keep the event loop alive past resolution", async () => {
    // Regression test for the timer.unref() — without it, a fast
    // probe would still leave a 2s timer pending. We can't directly
    // observe handle counts in Jest, but we can verify the promise
    // settles immediately (well under the 2s default timeout).
    const filePath = await makeTempFile(JSON.stringify({ version: 1 }));
    const before = Date.now();
    const result = await probeStoreFile(filePath);
    const elapsed = Date.now() - before;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
