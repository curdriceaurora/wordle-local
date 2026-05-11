"use strict";

// Property-based tests for the `normalize*` functions across every
// persisted store. Pins two universal invariants:
//
//   1. IDEMPOTENCE — `normalize(normalize(x))` deep-equals `normalize(x)`
//      for any input the first normalize accepts. If this fails, the
//      "canonical shape" contract is broken and every commit could
//      silently re-write state.
//
//   2. SCHEMA-VALIDITY — when normalize accepts an input, the output
//      validates against the store's published schema. The schema is
//      what the persisted file shape must satisfy; if normalize can
//      produce schema-INvalid output, the next load would reject the
//      file the previous commit wrote.
//
// Filed as #127 (Epic C: Test Coverage & Fault Injection).
// See `tests/helpers/arbitraries.js` for input generators.
//
// Configured: `{ numRuns: 50 }` per property × 2 properties × 8 stores
// = 800 normalize invocations / test run. Runtime < 1s in practice.
// 50 was chosen as a balance between coverage and run cost; raise via
// CONCURRENCY_REPEAT-style env-tuning if a follow-up wants more
// thorough sampling.

const fs = require("node:fs");
const path = require("node:path");

const fc = require("fast-check");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const arbitraries = require("./helpers/arbitraries");

const REPO_ROOT = path.resolve(__dirname, "..");

// Shared Ajv instance. addFormats supplies date-time / uri / etc.
// every schema in this repo expects. `strict: true` mirrors what
// `scripts/validate-schemas.js` enforces under `npm run schema:check`
// — using a different strictness here would let the property tests
// validate a slightly different interpretation of the schema than
// the repo's schema gate (Copilot caught the divergence on PR #133).
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

function loadSchema(relativePath) {
  const schemaJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
  );
  return ajv.compile(schemaJson);
}

// ---------- Store registry ----------
//
// Each entry binds a normalize function to its arbitrary + schema. The
// property runner below iterates the registry so adding a new store
// requires only one entry.
//
// `select` extracts the canonical persisted state from the normalize
// return. Most stores return the state directly (default identity).
// `classes-store` and `leaderboard-store` wrap the state in
// `{state, hadInvalidContent, wasPruned}` so callers can surface
// load-time diagnostics — we lift `state` out so idempotence +
// schema-validity properties run against the actual persisted shape.

const identity = (x) => x;
const lift = (x) => x.state;

const registry = [
  {
    name: "schedule-store: normalizeSchedule",
    normalize: require("../lib/schedule-store").normalizeSchedule,
    arbitrary: arbitraries.schedule,
    schema: loadSchema("data/schedule.schema.json"),
    select: identity
  },
  {
    name: "challenge-config-store: normalizeStore",
    normalize: require("../lib/challenge-config-store").normalizeStore,
    arbitrary: arbitraries.challengesStore,
    schema: loadSchema("data/challenges.schema.json"),
    select: identity
  },
  {
    name: "challenge-results-store: normalizeStore",
    normalize: require("../lib/challenge-results-store").normalizeStore,
    arbitrary: arbitraries.challengeResultsStore,
    schema: loadSchema("data/challenge-results.schema.json"),
    select: identity
  },
  {
    name: "webhook-store: normalizeStore",
    normalize: require("../lib/webhook-store").normalizeStore,
    arbitrary: arbitraries.webhookStore,
    schema: loadSchema("data/webhooks.schema.json"),
    select: identity
  },
  {
    name: "webhook-delivery-store: normalizeStore",
    normalize: require("../lib/webhook-delivery-store").normalizeStore,
    arbitrary: arbitraries.webhookDeliveryStore,
    schema: loadSchema("data/webhook-deliveries.schema.json"),
    select: identity
  },
  {
    name: "push-subscription-store: normalizeStore",
    normalize: require("../lib/push-subscription-store").normalizeStore,
    arbitrary: arbitraries.pushSubscriptionStore,
    schema: loadSchema("data/push-subscriptions.schema.json"),
    select: identity
  },
  {
    name: "classes-store: normalizeClassesState",
    normalize: require("../lib/classes-store").normalizeClassesState,
    arbitrary: arbitraries.classesState,
    schema: loadSchema("data/classes.schema.json"),
    select: lift
  },
  {
    name: "leaderboard-store: normalizeLeaderboardState",
    normalize: require("../lib/leaderboard-store").normalizeLeaderboardState,
    arbitrary: arbitraries.leaderboardState,
    schema: loadSchema("data/leaderboard.schema.json"),
    select: lift
  }
];

// Run each store's properties as its own describe block so jest output
// names a failing store directly. Errors during normalize itself
// (vs invariant violation) bubble up with arbitrary input → useful for
// arbitrary-tuning when failures land.

for (const entry of registry) {
  describe(entry.name, () => {
    test("idempotence: normalize(normalize(x)) === normalize(x)", () => {
      fc.assert(
        fc.property(entry.arbitrary, (rawInput) => {
          // No try/catch: the arbitrary is schema-valid by
          // construction and normalize must accept it. A throw
          // here is a bug to investigate, not a case to swallow.
          // Codex P2 + Copilot caught the prior `catch { return
          // true; }` pattern on PR #133 — silent skips made the
          // property vacuously pass on any arbitrary that
          // generated normalize-rejected input.
          const onceState = entry.select(entry.normalize(rawInput));
          const twiceState = entry.select(entry.normalize(onceState));
          // jest's `toEqual` does proper recursive structural
          // equality — order-independent for objects, order-sensitive
          // for arrays (correct for our canonical-shape contract).
          // Previously used `JSON.stringify(...) === JSON.stringify(...)`
          // which is order-dependent on object keys (Copilot caught
          // on PR #133).
          expect(twiceState).toEqual(onceState);
        }),
        { numRuns: 50 }
      );
    });

    test("schema-validity: normalize output passes the persisted schema", () => {
      fc.assert(
        fc.property(entry.arbitrary, (rawInput) => {
          const canonical = entry.select(entry.normalize(rawInput));
          const valid = entry.schema(canonical);
          if (!valid) {
            // Helpful diagnostic — show the schema errors plus the
            // first-300-chars of the output so failures are debuggable.
            const errs = (entry.schema.errors || [])
              .map((e) => `${e.instancePath || "/"}: ${e.message}`)
              .join("; ");
            const preview = JSON.stringify(canonical).slice(0, 300);
            throw new Error(
              `Schema violation: ${errs}\n  Output preview: ${preview}`
            );
          }
        }),
        { numRuns: 50 }
      );
    });
  });
}

// ---------- Smoke: arbitraries themselves produce valid shapes ----------

// If an arbitrary is mis-built we want to surface that as a fixture
// bug, not as a normalize bug. Generate one sample from each
// arbitrary and assert it's at least an object.
describe("arbitraries: smoke (each generator yields plain objects)", () => {
  for (const entry of registry) {
    test(`${entry.name}: arbitrary produces an object`, () => {
      const sample = fc.sample(entry.arbitrary, 1)[0];
      expect(typeof sample).toBe("object");
      expect(sample).not.toBeNull();
    });
  }
});
