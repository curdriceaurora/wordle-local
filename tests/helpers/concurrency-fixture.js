"use strict";

// Concurrency scenario harness.
//
// Drives N parallel invocations of an `operation` against a store/service,
// then runs a list of caller-provided invariants on the resulting state.
// Designed to surface the kind of races that single-threaded tests miss:
//   - lost writes when two mutators clone the same baseline
//   - drop-{guess,update} when commitQueue is bypassed
//   - duplicate state when a single-in-flight invariant is racy
//   - slot-claim ownership confusion (mutex vs counter)
//
// Background: the #98–#106 campaign produced 18 P1s, most clustered in
// shared-state code (locks, slots, ordering, drop-X races). Most would
// have surfaced in a Promise.all of N=20 against real disk — not mocks.
// This fixture standardises that pattern so each store gets the same
// quality of stress without copy-paste.
//
// USAGE
//   const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");
//
//   test("schedule-store survives parallel addEntry", async () => {
//     await runConcurrencyScenario({
//       name: "schedule-store: parallel addEntry",
//       setup: async () => {
//         const filePath = tempPath();
//         const store = new ScheduleStore({ filePath, now: frozenNow() });
//         await store.load();
//         return { store, filePath };
//       },
//       operation: async ({ store }, i) =>
//         store.addEntry({
//           date: `2026-05-${String(i + 1).padStart(2, "0")}`,
//           word: "AAAAA",
//           lang: "en"
//         }),
//       invariants: [
//         async ({ store }) => {
//           const snap = await store.getSnapshot();
//           expect(snap.scheduled_words).toHaveLength(20);
//         }
//       ],
//       teardown: async ({ filePath }) => {
//         await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
//       }
//     });
//   });
//
// OPTIONS (all but `setup`/`operation` optional)
//
//   name            — human label; surfaces in failure messages.
//   parallelism     — fan-out count (default 20). Override via env
//                     CONCURRENCY_PARALLELISM. Stress mode: 200. When
//                     a test has a correctness-derived ceiling (e.g.,
//                     a schema cap on the underlying op), use
//                     `parallelismMax` to declare it.
//   parallelismMax  — optional hard upper bound on effective parallelism.
//                     If set, CONCURRENCY_PARALLELISM is CLAMPED to
//                     min(env, parallelismMax). Use this when an
//                     env-driven stress bump above N would violate a
//                     correctness invariant of the underlying API
//                     (e.g., challenge-results-store appends >12
//                     guesses → INVALID_PUZZLE, unrelated to the
//                     concurrency invariant under test). Default:
//                     Infinity (env override unconstrained).
//   repeat          — full setup→run→teardown cycles (default 1). Override
//                     via env CONCURRENCY_REPEAT. Used for anti-flake
//                     validation (100×) before a fixture user lands.
//   setup()         — builds the per-iteration context. Returns whatever
//                     opaque `ctx` the operation/invariants/teardown need.
//   operation(ctx,i)— single op. Called `parallelism` times in parallel
//                     with i = 0..parallelism-1. May resolve or reject;
//                     rejections are partitioned into `errors`.
//   acceptableErrors— either (a) array of error-`code` strings + predicate
//                     functions, or (b) a single predicate `(err) => bool`.
//                     Matching errors are tolerated; unmatched errors fail
//                     the scenario with a context-rich message.
//   expectedSuccesses — number, or `(summary, ctx) => number`. Default:
//                       `parallelism - errors.length` (i.e., as many as
//                       didn't error). Use to assert single-in-flight
//                       invariants: e.g., expectedSuccesses = 1 paired
//                       with acceptableErrors: ["ALREADY_RUNNING"].
//   invariants      — array of async (ctx, summary) => void. Throwers fail
//                     the scenario. `summary` = { results, errors,
//                     parallelism, iter, repeat }.
//   teardown(ctx)   — cleanup. Called whenever setup() returned a ctx
//                     — even if operation/invariants throw. NOT called
//                     if setup() itself rejected (no ctx to hand back).
//                     Teardown errors are surfaced only if the run
//                     itself succeeded (otherwise the run-error wins).
//
// EXECUTION MODEL
//   - Operations launch via `Promise.allSettled` — a single rejection
//     does NOT short-circuit the rest. Catching real-store rejections
//     is essential: most stores throw on drop-X races, and we want to
//     count those drops, not bail on the first one.
//   - All ops are wrapped in `Promise.resolve().then(...)` to ensure
//     every invocation hits the microtask queue before any runs to
//     completion. Without this, a synchronous-throwing operation
//     would throw before Promise.allSettled has a chance to register
//     and the whole fixture would crash.
//   - Real disk only. The fixture itself doesn't allocate temp dirs —
//     the caller's setup() owns that. Mocks won't surface the
//     #commit / commitQueue races we care about.
//
// ANTI-FLAKE VALIDATION
//   Before merging a new scenario, run `CONCURRENCY_REPEAT=100 npm test
//   -- <scenario-file>` and confirm zero failures. Document the run in
//   the PR description. A scenario that flakes at 100× is not allowed
//   to land — fix the test, fix the store, or both. We hold the bar at
//   100× because:
//     - We've seen P1s reproduce 1-in-30 in real campaigns.
//     - Flake at the fixture level destroys trust in the suite.
//     - 100 iters × ~5–50ms each is still <10s — cheap enough that the
//       cost of the gate is negligible.

const PARALLELISM_DEFAULT = 20;
const REPEAT_DEFAULT = 1;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeErrorPredicate(acceptableErrors) {
  if (typeof acceptableErrors === "function") return acceptableErrors;
  if (!Array.isArray(acceptableErrors) || acceptableErrors.length === 0) {
    return () => false;
  }
  const codes = new Set();
  const predicates = [];
  for (const entry of acceptableErrors) {
    if (typeof entry === "string") codes.add(entry);
    else if (typeof entry === "function") predicates.push(entry);
    // Anything else is silently ignored — the alternative is a fixture
    // that crashes mid-scenario on a typo'd option, which is worse than
    // a test that fails on a real error.
  }
  return (err) => {
    if (err && typeof err.code === "string" && codes.has(err.code)) return true;
    for (const p of predicates) {
      if (p(err)) return true;
    }
    return false;
  };
}

function formatError(err) {
  if (err === null || err === undefined) return "(falsy error)";
  if (err && typeof err === "object") {
    const code = typeof err.code === "string" ? err.code : null;
    const msg = err.message || String(err);
    return code ? `[${code}] ${msg}` : msg;
  }
  return String(err);
}

// Wrap operation invocation in Promise.resolve().then(...) so a
// synchronous throw inside `operation` is captured as a rejection
// rather than propagating out of the Array.from before
// Promise.allSettled gets a chance to settle the other tasks.
function invokeOperation(operation, ctx, i) {
  return Promise.resolve().then(() => operation(ctx, i));
}

async function runConcurrencyScenario(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("[concurrency-fixture] runConcurrencyScenario(spec): spec is required");
  }
  const name = typeof spec.name === "string" && spec.name ? spec.name : "concurrency-scenario";
  if (typeof spec.setup !== "function") {
    throw new Error(`[concurrency-fixture] ${name}: setup() is required`);
  }
  if (typeof spec.operation !== "function") {
    throw new Error(`[concurrency-fixture] ${name}: operation() is required`);
  }

  const specParallelism = typeof spec.parallelism === "number" && spec.parallelism > 0
    ? spec.parallelism
    : PARALLELISM_DEFAULT;
  const parallelismMax = typeof spec.parallelismMax === "number" && spec.parallelismMax > 0
    ? spec.parallelismMax
    : Infinity;
  // env CONCURRENCY_PARALLELISM bumps the default upward for stress
  // mode. Clamp to spec.parallelismMax so a test with a correctness-
  // derived ceiling (e.g., the schema-cap on per-puzzle guesses) can
  // opt out of the stress bump without disabling the env override
  // entirely. Codex flagged this on PR #109: without the clamp,
  // CONCURRENCY_PARALLELISM=200 would surface schema-cap errors that
  // have nothing to do with the concurrency invariant under test.
  const envParallelism = envInt("CONCURRENCY_PARALLELISM", specParallelism);
  const parallelism = Math.min(envParallelism, parallelismMax);
  const repeat = envInt(
    "CONCURRENCY_REPEAT",
    typeof spec.repeat === "number" && spec.repeat > 0 ? spec.repeat : REPEAT_DEFAULT
  );

  const isAcceptable = makeErrorPredicate(spec.acceptableErrors || []);
  const invariants = Array.isArray(spec.invariants) ? spec.invariants : [];

  for (let iter = 0; iter < repeat; iter += 1) {
    const ctx = await spec.setup();
    let runSucceeded = false;
    let teardownErrorToRethrow = null;
    try {
      const settled = await Promise.allSettled(
        Array.from({ length: parallelism }, (_, i) => invokeOperation(spec.operation, ctx, i))
      );
      const results = [];
      const errors = [];
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
        else errors.push(s.reason);
      }

      // Partition errors into expected (acceptable) vs unexpected. Any
      // unexpected error fails the scenario immediately with a sample of
      // up to 3 errors — enough to debug without flooding the log.
      const unexpectedErrors = errors.filter((e) => !isAcceptable(e));
      if (unexpectedErrors.length > 0) {
        const sample = unexpectedErrors.slice(0, 3).map(formatError).join("\n  - ");
        const moreNote =
          unexpectedErrors.length > 3
            ? `\n  ...and ${unexpectedErrors.length - 3} more`
            : "";
        throw new Error(
          `[concurrency-fixture] ${name} (iter ${iter + 1}/${repeat}, parallelism=${parallelism}): ` +
            `${unexpectedErrors.length} unexpected error(s):\n  - ${sample}${moreNote}`
        );
      }

      const summary = Object.freeze({ results, errors, parallelism, iter, repeat });
      let expectedCount;
      if (typeof spec.expectedSuccesses === "function") {
        expectedCount = spec.expectedSuccesses(summary, ctx);
      } else if (typeof spec.expectedSuccesses === "number") {
        expectedCount = spec.expectedSuccesses;
      } else {
        expectedCount = parallelism - errors.length;
      }
      if (results.length !== expectedCount) {
        throw new Error(
          `[concurrency-fixture] ${name} (iter ${iter + 1}/${repeat}, parallelism=${parallelism}): ` +
            `expected ${expectedCount} successful op(s) but got ${results.length} ` +
            `(errors: ${errors.length}, all acceptable)`
        );
      }

      for (const invariant of invariants) {
        try {
          await invariant(ctx, summary);
        } catch (invErr) {
          // Wrap so the user gets BOTH their original assertion message
          // AND the scenario context. Most invariant errors come from
          // jest expect() calls — those already format well; we just
          // prepend the scenario tag.
          const tag = `[concurrency-fixture] ${name} (iter ${iter + 1}/${repeat}, parallelism=${parallelism})`;
          if (invErr && typeof invErr === "object" && invErr.message) {
            invErr.message = `${tag}: invariant failed — ${invErr.message}`;
          }
          throw invErr;
        }
      }

      runSucceeded = true;
    } finally {
      // Capture any teardown error here but DO NOT throw from inside
      // the finally — ESLint rightly rejects throws from finally
      // because they mask the in-flight throw from the try block.
      // We stash and rethrow after the finally has settled.
      if (typeof spec.teardown === "function") {
        try {
          await spec.teardown(ctx);
        } catch (teardownErr) {
          if (runSucceeded) {
            teardownErrorToRethrow = teardownErr;
          } else if (process.env.CONCURRENCY_VERBOSE) {
            // Original failure wins — log the suppressed teardown
            // error only when explicitly opted in.
            console.warn(
              `[concurrency-fixture] ${name}: teardown error suppressed (run already failing): ${teardownErr.message || teardownErr}`
            );
          }
        }
      }
    }
    // Rethrow OUTSIDE the finally so an in-flight error from the try
    // block isn't masked by a follow-on teardown failure. The
    // `runSucceeded` gate above ensures we only reach here on
    // success — if the run failed, that throw already exited the
    // function before this point.
    if (teardownErrorToRethrow) throw teardownErrorToRethrow;
  }
}

module.exports = {
  runConcurrencyScenario,
  // Exported for tests of the fixture itself.
  _internal: {
    makeErrorPredicate,
    formatError,
    PARALLELISM_DEFAULT,
    REPEAT_DEFAULT
  }
};
