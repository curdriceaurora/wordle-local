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
    const filePath = await makeTempFile(JSON.stringify({ version: 1 }));
    const before = Date.now();
    const result = await probeStoreFile(filePath);
    const elapsed = Date.now() - before;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  // Codex P2 on PR #216
  describe("expectExists semantics", () => {
    test("expectExists=false (default): ENOENT returns ok:true (pre-bootstrap)", async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-health-probe-"));
      TEMP_DIRS.push(dir);
      const filePath = path.join(dir, "missing.json");
      const result = await probeStoreFile(filePath, { expectExists: false });
      expect(result.ok).toBe(true);
      expect(result.note).toMatch(/pre-bootstrap/);
    });

    test("expectExists=true: ENOENT returns ok:false (file gone after load)", async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-health-probe-"));
      TEMP_DIRS.push(dir);
      const filePath = path.join(dir, "missing.json");
      const result = await probeStoreFile(filePath, { expectExists: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ENOENT/);
      expect(result.error).toMatch(/removed after load/);
    });

    test("expectExists=true: existing valid file is still healthy", async () => {
      const filePath = await makeTempFile(JSON.stringify({ version: 1 }));
      const result = await probeStoreFile(filePath, { expectExists: true });
      expect(result.ok).toBe(true);
    });
  });

  // Copilot on PR #216: error messages must not leak fs paths.
  describe("error sanitization", () => {
    test("fs error messages do NOT include the file path", async () => {
      // Passing a directory to readFile yields EISDIR with the path
      // in the raw message — verify it doesn't leak through.
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-health-probe-"));
      TEMP_DIRS.push(dir);
      const result = await probeStoreFile(dir);
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain(dir);
      // Error CODE is still surfaced for operator triage.
      expect(result.error).toMatch(/EISDIR|EACCES|store read\/parse failed/);
    });

    test("JSON parse errors don't reveal the path either", async () => {
      const filePath = await makeTempFile("{not valid");
      const result = await probeStoreFile(filePath);
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain(filePath);
    });
  });

  // Copilot on PR #216: timeout fires AbortController to cancel
  // the underlying fsp.readFile so threadpool I/O doesn't pile up.
  test("timeout cancels in-flight readFile via AbortController", async () => {
    let capturedSignal = null;
    const spy = jest.spyOn(fsp, "readFile").mockImplementation((_p, opts) => {
      capturedSignal = opts && opts.signal;
      return new Promise((_resolve, reject) => {
        if (capturedSignal) {
          capturedSignal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            err.code = "ABORT_ERR";
            reject(err);
          });
        }
      });
    });
    try {
      const result = await probeStoreFile("/tmp/whatever.json", { timeoutMs: 50 });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timeout/);
      expect(capturedSignal).toBeTruthy();
      expect(capturedSignal.aborted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
