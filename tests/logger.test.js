"use strict";

const {
  createLogger,
  createNoopLogger,
  resolveLevel,
  sanitizeFieldValue,
  LEVELS
} = require("../lib/logger");

function captureWriter() {
  const lines = [];
  const stream = { write: (line) => lines.push(line) };
  return { lines, stream };
}

function lastRecord(lines) {
  return JSON.parse(lines[lines.length - 1]);
}

describe("resolveLevel", () => {
  test("falls back to info on unknown / empty input", () => {
    expect(resolveLevel(undefined)).toBe(LEVELS.info);
    expect(resolveLevel("")).toBe(LEVELS.info);
    expect(resolveLevel("nope")).toBe(LEVELS.info);
  });
  test("matches known levels case-insensitively", () => {
    expect(resolveLevel("debug")).toBe(LEVELS.debug);
    expect(resolveLevel("DEBUG")).toBe(LEVELS.debug);
    expect(resolveLevel("warn")).toBe(LEVELS.warn);
    expect(resolveLevel("error")).toBe(LEVELS.error);
    expect(resolveLevel("silent")).toBe(LEVELS.silent);
  });
  test("trims whitespace", () => {
    expect(resolveLevel("  warn  ")).toBe(LEVELS.warn);
  });
});

describe("sanitizeFieldValue", () => {
  test("passes through primitives", () => {
    expect(sanitizeFieldValue("s")).toBe("s");
    expect(sanitizeFieldValue(42)).toBe(42);
    expect(sanitizeFieldValue(true)).toBe(true);
    expect(sanitizeFieldValue(null)).toBe(null);
  });
  test("stringifies bigint", () => {
    expect(sanitizeFieldValue(BigInt(10))).toBe("10");
  });
  test("drops functions and symbols", () => {
    expect(sanitizeFieldValue(() => {})).toBe(undefined);
    expect(sanitizeFieldValue(Symbol("x"))).toBe(undefined);
  });
  test("Error -> {message, name, stack}", () => {
    const err = new Error("boom");
    err.name = "TestError";
    const out = sanitizeFieldValue(err);
    expect(out.message).toBe("boom");
    expect(out.name).toBe("TestError");
    expect(typeof out.stack).toBe("string");
  });
  test("nested objects are walked", () => {
    const out = sanitizeFieldValue({ a: 1, b: { c: "x", fn: () => {} } });
    expect(out).toEqual({ a: 1, b: { c: "x" } });
  });
  test("arrays are walked", () => {
    expect(sanitizeFieldValue([1, "x", () => {}, null])).toEqual([1, "x", undefined, null]);
  });
});

describe("createLogger emit", () => {
  test("writes a JSON line with ts/level/msg", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("schedule.commit", { storeId: "abc", durationMs: 12 });
    const rec = lastRecord(out.lines);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("schedule.commit");
    expect(rec.storeId).toBe("abc");
    expect(rec.durationMs).toBe(12);
    expect(typeof rec.ts).toBe("string");
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("info+ written to stdout; warn+ written to stderr", () => {
    const stdout = captureWriter();
    const stderr = captureWriter();
    const logger = createLogger({
      level: "debug",
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(stdout.lines.map((l) => JSON.parse(l).msg)).toEqual(["d", "i"]);
    expect(stderr.lines.map((l) => JSON.parse(l).msg)).toEqual(["w", "e"]);
  });

  test("LOG_LEVEL=warn suppresses debug + info", () => {
    const out = captureWriter();
    const stderr = captureWriter();
    const logger = createLogger({
      level: "warn",
      stdout: out.stream,
      stderr: stderr.stream
    });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(out.lines).toHaveLength(0);
    expect(stderr.lines.map((l) => JSON.parse(l).msg)).toEqual(["w", "e"]);
  });

  test("silent level emits nothing", () => {
    const out = captureWriter();
    const logger = createLogger({
      level: "silent",
      stdout: out.stream,
      stderr: out.stream
    });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(out.lines).toHaveLength(0);
  });

  test("reserved field names cannot be overridden by caller", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("normal", { ts: "FAKE", level: "FAKE", msg: "FAKE", extra: 1 });
    const rec = lastRecord(out.lines);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("normal");
    expect(rec.ts).not.toBe("FAKE");
    expect(rec.extra).toBe(1);
  });

  test("Error in fields is captured as {message, name, stack}", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    const err = new Error("disk full");
    logger.error("commit.failed", { error: err });
    const rec = lastRecord(out.lines);
    expect(rec.error.message).toBe("disk full");
    expect(typeof rec.error.stack).toBe("string");
  });

  test("coerces non-string msg to string", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info(42);
    expect(lastRecord(out.lines).msg).toBe("42");
  });

  test("missing field bag is fine", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("bare");
    expect(lastRecord(out.lines).msg).toBe("bare");
  });

  test("array as second arg is JSON-stringified into msg (console-compatible behavior)", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("x", ["a", "b"]);
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe('x ["a","b"]');
    expect(rec.level).toBe("info");
  });
});

describe("createNoopLogger", () => {
  test("methods exist and are callable", () => {
    const noop = createNoopLogger();
    expect(() => {
      noop.debug("x");
      noop.info("y");
      noop.warn("z");
      noop.error("w");
    }).not.toThrow();
  });
});

describe("variadic console-compatible shape", () => {
  test("logger.warn('X:', err) captures the Error in fields.error", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    const err = new Error("boom");
    logger.warn("scheduler tick failed:", err);
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe("scheduler tick failed:");
    expect(rec.error.message).toBe("boom");
    expect(typeof rec.error.stack).toBe("string");
  });

  test("logger.error(err) alone uses the error message as msg", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.error(new Error("disk full"));
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe("disk full");
    expect(rec.error.message).toBe("disk full");
  });

  test("logger.info('a', 'b', err) concatenates strings into msg, captures Error", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    const err = new Error("nope");
    logger.info("step", "1", err);
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe("step 1");
    expect(rec.error.message).toBe("nope");
  });

  test("logger.warn('x', err1, err2) collects multiple Errors into errors array", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.warn("two failures:", new Error("a"), new Error("b"));
    const rec = lastRecord(out.lines);
    expect(Array.isArray(rec.errors)).toBe(true);
    expect(rec.errors).toHaveLength(2);
    expect(rec.errors[0].message).toBe("a");
    expect(rec.errors[1].message).toBe("b");
  });

  test("structured shape (msg, {fields}) still works (2-arg, object second)", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("structured", { keyA: 1, keyB: "two" });
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe("structured");
    expect(rec.keyA).toBe(1);
    expect(rec.keyB).toBe("two");
  });
});
