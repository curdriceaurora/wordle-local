"use strict";

// Self-tests for tests/helpers/concurrency-fixture.js.
//
// The fixture is itself a piece of code that's about to gate the
// reliability of every downstream concurrency test. If it has a bug
// — silently swallows errors, mis-counts successes, doesn't run
// invariants — every store test downstream is a lie. Lock down the
// harness behavior before any store relies on it.

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  runConcurrencyScenario,
  _internal: { makeErrorPredicate, formatError }
} = require("./helpers/concurrency-fixture");

// Fixture SELF-tests assert specific iteration counts and parallelism
// values. The fixture's CONCURRENCY_REPEAT / CONCURRENCY_PARALLELISM
// env vars are designed to override per-spec values for the 100×
// anti-flake gate that wraps STORE tests; for the fixture's own
// self-tests those overrides would corrupt the contract. We isolate
// the env at file scope so the gate can be run across all
// concurrency tests without breaking the fixture's own suite.
let envBackup;
beforeEach(() => {
  envBackup = {
    repeat: process.env.CONCURRENCY_REPEAT,
    parallelism: process.env.CONCURRENCY_PARALLELISM
  };
  delete process.env.CONCURRENCY_REPEAT;
  delete process.env.CONCURRENCY_PARALLELISM;
});
afterEach(() => {
  if (envBackup.repeat === undefined) delete process.env.CONCURRENCY_REPEAT;
  else process.env.CONCURRENCY_REPEAT = envBackup.repeat;
  if (envBackup.parallelism === undefined) delete process.env.CONCURRENCY_PARALLELISM;
  else process.env.CONCURRENCY_PARALLELISM = envBackup.parallelism;
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-concurrency-fixture-"));
}

async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("concurrency-fixture: helper internals", () => {
  test("makeErrorPredicate matches by code", () => {
    const isAcceptable = makeErrorPredicate(["DUPLICATE_ENTRY", "ALREADY_RUNNING"]);
    expect(isAcceptable({ code: "DUPLICATE_ENTRY" })).toBe(true);
    expect(isAcceptable({ code: "ALREADY_RUNNING" })).toBe(true);
    expect(isAcceptable({ code: "OTHER" })).toBe(false);
    expect(isAcceptable(new Error("plain error"))).toBe(false);
    expect(isAcceptable(null)).toBe(false);
  });

  test("makeErrorPredicate accepts a predicate alongside codes", () => {
    const isAcceptable = makeErrorPredicate([
      "DUPLICATE_ENTRY",
      (err) => err && /not.found/i.test(err.message || "")
    ]);
    expect(isAcceptable({ code: "DUPLICATE_ENTRY" })).toBe(true);
    expect(isAcceptable(new Error("ENTRY NOT FOUND"))).toBe(true);
    expect(isAcceptable(new Error("something else"))).toBe(false);
  });

  test("makeErrorPredicate accepts a bare predicate function", () => {
    const isAcceptable = makeErrorPredicate((err) => err && err.code === "OK");
    expect(isAcceptable({ code: "OK" })).toBe(true);
    expect(isAcceptable({ code: "NOT_OK" })).toBe(false);
  });

  test("makeErrorPredicate defaults to never-accept on empty/garbage input", () => {
    expect(makeErrorPredicate([])({ code: "ANYTHING" })).toBe(false);
    expect(makeErrorPredicate(null)({ code: "ANYTHING" })).toBe(false);
    expect(makeErrorPredicate(undefined)({ code: "ANYTHING" })).toBe(false);
  });

  test("formatError renders codes + messages, handles falsy/non-object", () => {
    expect(formatError({ code: "ABC", message: "hello" })).toBe("[ABC] hello");
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError(null)).toBe("(falsy error)");
    expect(formatError(undefined)).toBe("(falsy error)");
    expect(formatError("string-error")).toBe("string-error");
    expect(formatError(42)).toBe("42");
  });
});

describe("concurrency-fixture: required-args validation", () => {
  test("rejects missing setup", async () => {
    await expect(
      runConcurrencyScenario({ name: "x", operation: () => 1 })
    ).rejects.toThrow(/setup\(\) is required/);
  });

  test("rejects missing operation", async () => {
    await expect(
      runConcurrencyScenario({ name: "x", setup: () => ({}) })
    ).rejects.toThrow(/operation\(\) is required/);
  });

  test("rejects non-object spec", async () => {
    await expect(runConcurrencyScenario(null)).rejects.toThrow(/spec is required/);
    await expect(runConcurrencyScenario(undefined)).rejects.toThrow(/spec is required/);
  });
});

describe("concurrency-fixture: happy-path behavior", () => {
  test("runs `parallelism` operations and reports them all as successes", async () => {
    const ops = [];
    await runConcurrencyScenario({
      name: "all-succeed",
      parallelism: 10,
      setup: () => ({}),
      operation: async (_ctx, i) => {
        ops.push(i);
        return i;
      },
      invariants: [
        async (_ctx, { results, errors, parallelism }) => {
          expect(parallelism).toBe(10);
          expect(results).toHaveLength(10);
          expect(errors).toHaveLength(0);
          expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        }
      ]
    });
    expect(ops).toHaveLength(10);
  });

  test("defaults parallelism to 20 when unspecified", async () => {
    let invariantSeenParallelism = null;
    await runConcurrencyScenario({
      name: "default-parallelism",
      setup: () => ({}),
      operation: async () => "ok",
      invariants: [
        async (_ctx, { parallelism }) => {
          invariantSeenParallelism = parallelism;
        }
      ]
    });
    expect(invariantSeenParallelism).toBe(20);
  });

  test("env CONCURRENCY_PARALLELISM overrides per-spec value", async () => {
    const prev = process.env.CONCURRENCY_PARALLELISM;
    process.env.CONCURRENCY_PARALLELISM = "3";
    try {
      let seen = null;
      await runConcurrencyScenario({
        name: "env-override",
        parallelism: 50,
        setup: () => ({}),
        operation: async () => "ok",
        invariants: [
          async (_ctx, { parallelism }) => {
            seen = parallelism;
          }
        ]
      });
      expect(seen).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.CONCURRENCY_PARALLELISM;
      else process.env.CONCURRENCY_PARALLELISM = prev;
    }
  });

  test("repeat re-runs setup/operation/teardown each iteration", async () => {
    const setupCalls = [];
    const opCalls = [];
    const teardownCalls = [];
    await runConcurrencyScenario({
      name: "repeat-cycles",
      parallelism: 2,
      repeat: 3,
      setup: () => {
        const tag = setupCalls.length;
        setupCalls.push(tag);
        return { tag };
      },
      operation: async (ctx) => {
        opCalls.push(ctx.tag);
        return ctx.tag;
      },
      teardown: (ctx) => {
        teardownCalls.push(ctx.tag);
      }
    });
    expect(setupCalls).toEqual([0, 1, 2]);
    // 2 ops × 3 iterations = 6
    expect(opCalls).toHaveLength(6);
    expect(teardownCalls).toEqual([0, 1, 2]);
  });
});

describe("concurrency-fixture: error handling", () => {
  test("fails when any operation rejects with a non-acceptable error", async () => {
    await expect(
      runConcurrencyScenario({
        name: "unexpected-error",
        parallelism: 4,
        setup: () => ({}),
        operation: async (_ctx, i) => {
          if (i === 2) {
            const e = new Error("boom");
            e.code = "BOOM";
            throw e;
          }
          return i;
        }
      })
    ).rejects.toThrow(/1 unexpected error\(s\)[\s\S]*\[BOOM\] boom/);
  });

  test("tolerates errors whose code is in acceptableErrors", async () => {
    let invariantResults = null;
    let invariantErrors = null;
    await runConcurrencyScenario({
      name: "acceptable-errors",
      parallelism: 4,
      setup: () => ({}),
      operation: async (_ctx, i) => {
        if (i % 2 === 0) {
          const e = new Error(`dupe ${i}`);
          e.code = "DUPLICATE_ENTRY";
          throw e;
        }
        return i;
      },
      acceptableErrors: ["DUPLICATE_ENTRY"],
      invariants: [
        async (_ctx, { results, errors }) => {
          invariantResults = results;
          invariantErrors = errors;
        }
      ]
    });
    expect(invariantResults).toHaveLength(2);
    expect(invariantErrors).toHaveLength(2);
    expect(invariantErrors.every((e) => e.code === "DUPLICATE_ENTRY")).toBe(true);
  });

  test("captures synchronous throws inside operation without crashing the harness", async () => {
    let invariantResults = null;
    let invariantErrors = null;
    await runConcurrencyScenario({
      name: "sync-throw",
      parallelism: 3,
      setup: () => ({}),
      operation: (_ctx, i) => {
        // Note: not `async` — and the body throws synchronously. The
        // fixture must wrap operation() in Promise.resolve().then(...)
        // so this becomes a rejection, not a crash before
        // Promise.allSettled registers the other tasks.
        if (i === 0) throw Object.assign(new Error("sync-boom"), { code: "SYNC_BOOM" });
        return i;
      },
      acceptableErrors: ["SYNC_BOOM"],
      invariants: [
        async (_ctx, { results, errors }) => {
          invariantResults = results;
          invariantErrors = errors;
        }
      ]
    });
    expect(invariantResults).toEqual([1, 2]);
    expect(invariantErrors).toHaveLength(1);
    expect(invariantErrors[0].code).toBe("SYNC_BOOM");
  });

  test("expectedSuccesses=N enforces an exact success count", async () => {
    // Single-in-flight invariant simulation: 4 calls fire, exactly 1
    // should "win" (return value), the other 3 should reject with a
    // race-loss error that's been declared acceptable.
    await runConcurrencyScenario({
      name: "single-in-flight",
      parallelism: 4,
      setup: () => ({ winner: null }),
      operation: async (ctx) => {
        if (ctx.winner === null) {
          ctx.winner = "claimed";
          return "won";
        }
        const e = new Error("already running");
        e.code = "ALREADY_RUNNING";
        throw e;
      },
      acceptableErrors: ["ALREADY_RUNNING"],
      expectedSuccesses: 1
    });
  });

  test("expectedSuccesses mismatch fails with a clear message", async () => {
    await expect(
      runConcurrencyScenario({
        name: "wrong-count",
        parallelism: 3,
        setup: () => ({}),
        operation: async () => "ok",
        expectedSuccesses: 1
      })
    ).rejects.toThrow(/expected 1 successful op\(s\) but got 3/);
  });

  test("invariant assertion failure surfaces with context tag", async () => {
    await expect(
      runConcurrencyScenario({
        name: "invariant-fail",
        parallelism: 2,
        setup: () => ({}),
        operation: async () => 1,
        invariants: [
          async () => {
            throw new Error("nope");
          }
        ]
      })
    ).rejects.toThrow(/invariant-fail[\s\S]*invariant failed — nope/);
  });
});

describe("concurrency-fixture: teardown semantics", () => {
  test("teardown runs even when the operation phase fails", async () => {
    const dir = tempDir();
    const teardownCalls = [];
    await expect(
      runConcurrencyScenario({
        name: "teardown-on-fail",
        parallelism: 2,
        setup: () => ({ dir }),
        operation: async () => {
          const e = new Error("unexpected");
          e.code = "UNEXPECTED";
          throw e;
        },
        teardown: (ctx) => {
          teardownCalls.push(ctx.dir);
        }
      })
    ).rejects.toThrow(/unexpected/i);
    expect(teardownCalls).toEqual([dir]);
    await cleanup(dir);
  });

  test("teardown runs even when an invariant fails", async () => {
    const teardownCalls = [];
    await expect(
      runConcurrencyScenario({
        name: "teardown-on-invariant-fail",
        parallelism: 1,
        setup: () => ({ tag: "x" }),
        operation: async () => 1,
        invariants: [
          async () => {
            throw new Error("nope");
          }
        ],
        teardown: (ctx) => {
          teardownCalls.push(ctx.tag);
        }
      })
    ).rejects.toThrow(/invariant failed/);
    expect(teardownCalls).toEqual(["x"]);
  });

  test("teardown error is surfaced when the run succeeded", async () => {
    await expect(
      runConcurrencyScenario({
        name: "teardown-error",
        parallelism: 1,
        setup: () => ({}),
        operation: async () => 1,
        teardown: () => {
          throw new Error("teardown-boom");
        }
      })
    ).rejects.toThrow(/teardown-boom/);
  });

  test("teardown error is suppressed when the run already failed", async () => {
    // The original failure must win; the teardown error must not mask it.
    await expect(
      runConcurrencyScenario({
        name: "double-fail",
        parallelism: 1,
        setup: () => ({}),
        operation: async () => {
          const e = new Error("primary");
          e.code = "PRIMARY";
          throw e;
        },
        teardown: () => {
          throw new Error("teardown-secondary");
        }
      })
    ).rejects.toThrow(/primary/);
  });
});

describe("concurrency-fixture: integration smoke against a tiny in-memory store", () => {
  // A miniature store that intentionally has a race: it commits state
  // without a lock so concurrent writes lose updates. We verify the
  // fixture surfaces the bad behavior, then confirm a fixed version
  // passes.

  function makeRacyStore() {
    let state = { items: [] };
    return {
      async add(value) {
        const snapshot = state.items.slice();
        // Yield to the event loop so two concurrent `add` calls each
        // capture the SAME pre-mutation snapshot, then the later
        // write clobbers the earlier one.
        await new Promise((resolve) => setImmediate(resolve));
        snapshot.push(value);
        state = { items: snapshot };
      },
      snapshot() {
        return { items: state.items.slice() };
      }
    };
  }

  function makeSerializedStore() {
    let state = { items: [] };
    let queue = Promise.resolve();
    return {
      async add(value) {
        const run = async () => {
          await new Promise((resolve) => setImmediate(resolve));
          state = { items: state.items.concat([value]) };
        };
        const next = queue.then(run, run);
        queue = next.then(
          () => undefined,
          () => undefined
        );
        return next;
      },
      snapshot() {
        return { items: state.items.slice() };
      }
    };
  }

  test("surfaces lost-write race on an intentionally racy store", async () => {
    await expect(
      runConcurrencyScenario({
        name: "racy-store",
        parallelism: 10,
        setup: () => ({ store: makeRacyStore() }),
        operation: async ({ store }, i) => store.add(i),
        invariants: [
          async ({ store }) => {
            const snap = store.snapshot();
            // Racy store loses writes; this assertion will fail and
            // the fixture must propagate that failure.
            if (snap.items.length !== 10) {
              throw new Error(
                `expected 10 items, got ${snap.items.length} (lost-write race detected)`
              );
            }
          }
        ]
      })
    ).rejects.toThrow(/lost-write race/);
  });

  test("passes on a properly-serialized store", async () => {
    await runConcurrencyScenario({
      name: "serialized-store",
      parallelism: 10,
      setup: () => ({ store: makeSerializedStore() }),
      operation: async ({ store }, i) => store.add(i),
      invariants: [
        async ({ store }, { results }) => {
          const snap = store.snapshot();
          if (snap.items.length !== 10) {
            throw new Error(`expected 10 items, got ${snap.items.length}`);
          }
          if (results.length !== 10) {
            throw new Error(`expected 10 results, got ${results.length}`);
          }
        }
      ]
    });
  });
});
