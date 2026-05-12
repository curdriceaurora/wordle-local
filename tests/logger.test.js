"use strict";

const {
  createLogger,
  createNoopLogger,
  resolveLevel,
  sanitizeFieldValue,
  LEVELS
} = require("../lib/logger");
const { runWithRequestId } = require("../lib/request-context");

function captureWriter() {
  const lines = [];
  const stream = { write: (line) => lines.push(line) };
  return { lines, stream };
}

function lastRecord(lines) {
  if (lines.length === 0) throw new Error("No records emitted");
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

  test("cycle detection: object that references itself becomes '[circular]'", () => {
    const obj = {};
    obj.self = obj;
    const out = sanitizeFieldValue(obj);
    expect(out.self).toBe("[circular]");
  });

  test("cycle detection: array that contains itself becomes '[circular]'", () => {
    const arr = [];
    arr.push(arr);
    const out = sanitizeFieldValue(arr);
    expect(out).toEqual(["[circular]"]);
  });

  test("cycle detection: cross-object cycles handled (a -> b -> a)", () => {
    const a = { name: "a" };
    const b = { name: "b", parent: a };
    a.child = b;
    const out = sanitizeFieldValue(a);
    expect(out.name).toBe("a");
    expect(out.child.name).toBe("b");
    expect(out.child.parent).toBe("[circular]");
  });
});

describe("logger smoke through createLogger with cyclic field bag", () => {
  test("does not stack-overflow on circular field input", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    const obj = { name: "loop" };
    obj.self = obj;
    expect(() => logger.info("cyclic field", obj)).not.toThrow();
    const rec = lastRecord(out.lines);
    expect(rec.msg).toBe("cyclic field");
    expect(rec.self).toBe("[circular]");
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
  test("methods exist and are callable (including log alias)", () => {
    const noop = createNoopLogger();
    expect(() => {
      noop.debug("x");
      noop.info("y");
      noop.log("alias for info");
      noop.warn("z");
      noop.error("w");
    }).not.toThrow();
  });
});

describe("log alias on createLogger", () => {
  test("logger.log emits at info level (backward-compat with console)", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.log("via log alias");
    const rec = lastRecord(out.lines);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("via log alias");
  });
});

describe("requestId auto-attachment via AsyncLocalStorage (B3 / #122)", () => {
  test("requestId from ALS lands on the emitted record", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    runWithRequestId("req-abc-001", () => {
      logger.info("schedule.commit", { storeId: "S1" });
    });
    const rec = lastRecord(out.lines);
    expect(rec.requestId).toBe("req-abc-001");
    expect(rec.storeId).toBe("S1");
  });

  test("no requestId attached when outside any request context", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    logger.info("bootstrap", { stage: "load" });
    const rec = lastRecord(out.lines);
    expect(rec.requestId).toBeUndefined();
    expect(rec.stage).toBe("load");
  });

  test("caller-supplied requestId in fields overrides the ALS value", () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    runWithRequestId("ambient", () => {
      logger.info("xfer", { requestId: "explicit-override", payload: 1 });
    });
    const rec = lastRecord(out.lines);
    expect(rec.requestId).toBe("explicit-override");
    expect(rec.payload).toBe(1);
  });

  test("logs emitted via concurrent ALS contexts keep their own requestId", async () => {
    const out = captureWriter();
    const logger = createLogger({ level: "info", stdout: out.stream, stderr: out.stream });
    await Promise.all([
      new Promise((resolve) => {
        runWithRequestId("alpha", () => {
          setImmediate(() => {
            logger.info("from-alpha");
            resolve();
          });
        });
      }),
      new Promise((resolve) => {
        runWithRequestId("beta", () => {
          setImmediate(() => {
            logger.info("from-beta");
            resolve();
          });
        });
      })
    ]);
    const recs = out.lines.map((l) => JSON.parse(l));
    const alpha = recs.find((r) => r.msg === "from-alpha");
    const beta = recs.find((r) => r.msg === "from-beta");
    expect(alpha.requestId).toBe("alpha");
    expect(beta.requestId).toBe("beta");
  });

  test("warn/error inside a request scope also pick up requestId", () => {
    const out = captureWriter();
    const stderr = captureWriter();
    const logger = createLogger({
      level: "debug",
      stdout: out.stream,
      stderr: stderr.stream
    });
    runWithRequestId("req-trace", () => {
      logger.warn("noisy");
      logger.error("oops");
    });
    const recs = stderr.lines.map((l) => JSON.parse(l));
    expect(recs.every((r) => r.requestId === "req-trace")).toBe(true);
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
