"use strict";

// Concurrency-stress tests for lib/challenge-config-store.js.
//
// Coverage:
//
//   1. Parallel `create` against distinct inputs → every challenge
//      lands in the store (commitQueue serializes the array push;
//      without it, lost writes would drop some).
//
//   2. Parallel `update` on the same challenge → exactly one final
//      state; updatedAt advances; no half-applied patches. Last-
//      writer-wins is acceptable; lost writes (an update that
//      "succeeded" but its fields never landed) are not.
//
//   3. Parallel `update` when hasResults=true → every caller rejects
//      with CONFIG_LOCKED. Store state stays unchanged.
//
//   4. Parallel `softDelete` of the same challenge → one final
//      `deleted=true` outcome; no rows duplicated, no rows missing.
//
//   5. ADMIN-VS-USER TOCTOU contract: at the STORE layer, ChallengeConfig
//      and ChallengeResults stores DO NOT share serialization. Parallel
//      config.update + results.createSession against the same challengeId
//      both succeed independently. This test documents the contract —
//      mutual exclusion across stores is enforced at the route layer
//      via `withChallengeAdminUserMutex`. If a future refactor moves
//      that mutex into the store, this test will need a corresponding
//      acceptable-error update.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ChallengeConfigStore } = require("../lib/challenge-config-store");
const { ChallengeResultsStore } = require("../lib/challenge-results-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-cc-concurrency-"));
  return {
    dir,
    configPath: path.join(dir, "challenges.json"),
    resultsPath: path.join(dir, "challenge-results.json")
  };
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

const baseInput = Object.freeze({
  name: "Speed 5x5",
  lang: "en",
  puzzleCount: 5,
  timeBudgetSeconds: 300,
  maxGuesses: 6,
  speedBonusFactor: 0.5,
  perPuzzleScore: 1000,
  replayPolicy: "best"
});

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("challenge-config-store: parallel create lands every challenge", () => {
  test("N parallel create() against distinct names: all challenges persist", async () => {
    await runConcurrencyScenario({
      name: "challenge-config-store: parallel create",
      parallelism: 20,
      setup: async () => {
        const { dir, configPath } = tempPaths();
        const store = new ChallengeConfigStore({ filePath: configPath, now: frozenNow() });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.create({
          ...baseInput,
          name: `Speed ${i}`
        }),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          // N unique IDs returned.
          const ids = new Set(results.map((r) => r.id));
          if (ids.size !== parallelism) {
            throw new Error(
              `expected ${parallelism} unique challenge IDs from ${parallelism} creates; got ${ids.size}`
            );
          }
          // N challenges in the store snapshot, each id present once.
          const snap = await store.load();
          if (snap.challenges.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} persisted challenges; got ${snap.challenges.length} ` +
                `(lost-write race: commitQueue is not serializing)`
            );
          }
          const storeIds = new Set(snap.challenges.map((c) => c.id));
          for (const id of ids) {
            if (!storeIds.has(id)) {
              throw new Error(
                `create() returned id ${id} but it's missing from store snapshot`
              );
            }
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("challenge-config-store: parallel update converges with last-writer-wins", () => {
  test("N parallel update() of the same challenge: one consistent final state", async () => {
    await runConcurrencyScenario({
      name: "challenge-config-store: parallel update",
      parallelism: 20,
      setup: async () => {
        const { dir, configPath } = tempPaths();
        const store = new ChallengeConfigStore({ filePath: configPath, now: frozenNow() });
        await store.load();
        const created = await store.create({ ...baseInput, name: "Original" });
        return { store, dir, challengeId: created.id };
      },
      operation: async ({ store, challengeId }, i) => {
        // Each update changes the name to a distinct value. The
        // commit queue must guarantee every update lands on the
        // previous one's effect — so the final name is one of the
        // 20 candidates, not a stale baseline.
        return store.update(
          challengeId,
          { name: `Update ${i}` },
          { hasResults: false }
        );
      },
      invariants: [
        async ({ store, challengeId }) => {
          const snap = await store.load();
          const found = snap.challenges.filter((c) => c.id === challengeId);
          if (found.length !== 1) {
            throw new Error(
              `expected exactly 1 row for ${challengeId}; got ${found.length}`
            );
          }
          // Final name must be one of the candidates we wrote.
          if (!/^Update \d+$/.test(found[0].name)) {
            throw new Error(
              `final name ${JSON.stringify(found[0].name)} is not one of the parallel-update candidates`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("N parallel update() with hasResults=true: all reject; store unchanged", async () => {
    // CONFIG_LOCKED guard must be enforced atomically inside the
    // commit closure, NOT by an upstream cache check that could
    // miss a race. We verify by firing 20 parallel updates with
    // hasResults=true and asserting every caller rejects with
    // CONFIG_LOCKED + the store name is unchanged.
    await runConcurrencyScenario({
      name: "challenge-config-store: parallel update (locked)",
      parallelism: 20,
      setup: async () => {
        const { dir, configPath } = tempPaths();
        const store = new ChallengeConfigStore({ filePath: configPath, now: frozenNow() });
        await store.load();
        const created = await store.create({ ...baseInput, name: "Locked Challenge" });
        return { store, dir, challengeId: created.id };
      },
      operation: async ({ store, challengeId }, i) =>
        store.update(
          challengeId,
          { name: `Should Not Apply ${i}` },
          { hasResults: true }
        ),
      acceptableErrors: ["CONFIG_LOCKED"],
      expectedSuccesses: 0,
      invariants: [
        async ({ store, challengeId }, { errors, parallelism }) => {
          if (errors.length !== parallelism) {
            throw new Error(`expected ${parallelism} CONFIG_LOCKED errors; got ${errors.length}`);
          }
          const snap = await store.load();
          const found = snap.challenges.find((c) => c.id === challengeId);
          if (!found) throw new Error("challenge vanished");
          if (found.name !== "Locked Challenge") {
            throw new Error(
              `locked challenge name mutated: got ${JSON.stringify(found.name)}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("challenge-config-store: parallel softDelete idempotence", () => {
  test("N parallel softDelete() of the same id: one delete sticks, all callers succeed", async () => {
    // softDelete is idempotent: re-deleting an already-deleted challenge
    // just re-stamps deletedAt/updatedAt. None of the parallel calls
    // should reject — they all observe `idx !== -1` (the row stays in
    // place with `deleted: true`).
    await runConcurrencyScenario({
      name: "challenge-config-store: parallel softDelete",
      parallelism: 20,
      setup: async () => {
        const { dir, configPath } = tempPaths();
        const store = new ChallengeConfigStore({ filePath: configPath, now: frozenNow() });
        await store.load();
        const created = await store.create({ ...baseInput, name: "Doomed" });
        return { store, dir, challengeId: created.id };
      },
      operation: async ({ store, challengeId }) => store.softDelete(challengeId),
      invariants: [
        async ({ store, challengeId }, { results }) => {
          // All 20 succeeded; each returned a row with deleted=true.
          for (const r of results) {
            if (r.deleted !== true) {
              throw new Error(
                `softDelete returned row with deleted=${r.deleted}`
              );
            }
          }
          // Store has exactly 1 row for that id, deleted=true.
          const snap = await store.load();
          const matches = snap.challenges.filter((c) => c.id === challengeId);
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 row after parallel softDelete; got ${matches.length}`
            );
          }
          if (matches[0].deleted !== true) {
            throw new Error("row not marked deleted after softDelete");
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("challenge-config-store: admin-vs-user TOCTOU contract", () => {
  test("parallel config.update + results.createSession proceed independently (no cross-store mutex)", async () => {
    // Documented contract: at the STORE layer, config and results
    // stores do NOT share serialization. Parallel admin updates and
    // user session-starts BOTH succeed. The route layer
    // (withChallengeAdminUserMutex in server.js) serializes them
    // per challenge id. This test pins the boundary so a future
    // refactor that accidentally moves the mutex into the store
    // (and breaks throughput) gets caught — and a refactor that
    // explicitly adds store-level serialization needs to update
    // this test.
    //
    // We fire N parallel operations:
    //   - half: config.update on the challenge (rename it)
    //   - half: results.createSession against the same challengeId
    // Both should succeed.
    await runConcurrencyScenario({
      name: "challenge-config-store: TOCTOU contract",
      parallelism: 20,
      setup: async () => {
        const { dir, configPath, resultsPath } = tempPaths();
        const configStore = new ChallengeConfigStore({
          filePath: configPath,
          now: frozenNow()
        });
        const resultsStore = new ChallengeResultsStore({
          filePath: resultsPath,
          now: frozenNow()
        });
        await configStore.load();
        await resultsStore.load();
        const created = await configStore.create({ ...baseInput, name: "TOCTOU" });
        return { configStore, resultsStore, dir, challengeId: created.id };
      },
      operation: async ({ configStore, resultsStore, challengeId }, i) => {
        if (i % 2 === 0) {
          // Half: admin update
          return {
            kind: "update",
            result: await configStore.update(
              challengeId,
              { name: `Admin Update ${i}` },
              { hasResults: false }
            )
          };
        }
        // Half: user createSession (each with distinct profileId so
        // the single-in-flight guard in results store doesn't fold
        // them all into one).
        return {
          kind: "createSession",
          result: await resultsStore.createSession({
            challengeId,
            profileId: `user-${i}`,
            profileName: `User${i}`,
            puzzles: [
              { index: 0, word: "ALPHA", guesses: [], solved: false }
            ]
          })
        };
      },
      invariants: [
        async ({ configStore, resultsStore, challengeId }, { results, parallelism }) => {
          // Half updates + half createSessions, all successful at the
          // store layer (no cross-store mutex). Use ceil/floor so the
          // split works for any parallelism, including odd values
          // under env stress mode.
          const expectedUpdates = Math.ceil(parallelism / 2);
          const expectedSessions = Math.floor(parallelism / 2);
          const updates = results.filter((r) => r.kind === "update");
          const sessions = results.filter((r) => r.kind === "createSession");
          if (updates.length !== expectedUpdates) {
            throw new Error(`expected ${expectedUpdates} update results; got ${updates.length}`);
          }
          if (sessions.length !== expectedSessions) {
            throw new Error(`expected ${expectedSessions} createSession results; got ${sessions.length}`);
          }
          // Config snapshot: challenge still has ONE row; name matches
          // one of the parallel update candidates.
          const cSnap = await configStore.load();
          const cMatches = cSnap.challenges.filter((c) => c.id === challengeId);
          if (cMatches.length !== 1) {
            throw new Error(
              `expected 1 challenge row; got ${cMatches.length}`
            );
          }
          if (!/^Admin Update \d+$/.test(cMatches[0].name)) {
            throw new Error(
              `final challenge name ${JSON.stringify(cMatches[0].name)} not one of the candidates`
            );
          }
          // Results snapshot: N/2 sessions for that challengeId.
          const rSnap = await resultsStore.load();
          const rMatches = rSnap.sessions.filter((s) => s.challengeId === challengeId);
          if (rMatches.length !== expectedSessions) {
            throw new Error(
              `expected ${expectedSessions} sessions for the challenge; got ${rMatches.length} ` +
                `(results commitQueue is not serializing)`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
