"use strict";

// Concurrency-stress tests for lib/leaderboard-store.js.
//
// LeaderboardStore serializes via per-store `writeQueue` (a Promise
// chain in `#enqueueWrite`). Without that queue, two near-simultaneous
// mutations would each clone the same in-memory baseline, apply their
// own changes, and whichever atomic-rename lands last would silently
// drop the other.
//
// What this file pins:
//   1. Parallel `mutate` against distinct profile ids — every commit
//      lands; no lost writes.
//   2. Parallel `replace` calls converge to a single consistent state
//      (last-writer-wins on disk; no half-written file).
//   3. Parallel `mutate` + `deleteProfile` on the same profile — the
//      delete either wins (profile absent) or loses (profile still
//      present) but the store never ends up with a half-removed row.
//   4. Parallel `mutate` on the SAME profile (concurrent score
//      updates) — every mutation runs in order; the final state
//      reflects whichever mutation landed last.
//
// Filed as #132 (Epic C: Test Coverage & Fault Injection).
// See `tests/helpers/concurrency-fixture.js` for the harness contract.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  LeaderboardStore,
  createEmptyLeaderboardState
} = require("../lib/leaderboard-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-leaderboard-concurrency-"));
  return { dir, filePath: path.join(dir, "leaderboard.json") };
}

function frozenNow(iso = "2026-05-11T00:00:00.000Z") {
  return () => new Date(iso);
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// Build a profile with a schema-valid name. Schema:
//   `^[A-Za-z][A-Za-z '\\-]*$` (max 24 chars). No digits.
// We map i to a unique alphabetic-only suffix (a, b, ..., aa, ab, ...).
function indexToAlphaSuffix(i) {
  let out = "";
  let n = i;
  do {
    out = String.fromCharCode("a".charCodeAt(0) + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function makeProfile(i) {
  const suffix = indexToAlphaSuffix(i);
  return {
    id: `p-${suffix}`,
    name: `Tester-${suffix}`,
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z"
  };
}

describe("leaderboard-store: writeQueue serializes parallel mutators", () => {
  test("N parallel mutate calls adding distinct profiles: all profiles persist", async () => {
    await runConcurrencyScenario({
      name: "leaderboard-store: parallel mutate (distinct profiles)",
      parallelism: 20,
      // Profile cap is 200 by default — well above our N.
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new LeaderboardStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.mutate((draft) => {
          draft.profiles.push(makeProfile(i));
        }),
      invariants: [
        async ({ store }, { parallelism }) => {
          const snap = await store.getSnapshot();
          if (snap.profiles.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} profiles; got ${snap.profiles.length} ` +
                `(lost-write race — writeQueue is not serializing)`
            );
          }
          // Every parallel index should be represented exactly once.
          const ids = snap.profiles.map((p) => p.id).sort();
          const expected = Array.from({ length: parallelism }, (_, i) => makeProfile(i).id).sort();
          if (JSON.stringify(ids) !== JSON.stringify(expected)) {
            throw new Error(
              `profile id set mismatch:\n  got      ${JSON.stringify(ids)}\n  expected ${JSON.stringify(expected)}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("parallel replace: consistent final state, no half-written file", async () => {
    // Each replace overwrites the entire state with a different
    // profile list. Last-writer-wins is acceptable (no specific
    // winner is correct); what matters is that the final state
    // matches one of the candidates exactly (not a torn write).
    await runConcurrencyScenario({
      name: "leaderboard-store: parallel replace",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new LeaderboardStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) => {
        const next = createEmptyLeaderboardState();
        next.profiles.push(makeProfile(i));
        return store.replace(next);
      },
      invariants: [
        async ({ store, filePath }) => {
          const snap = await store.getSnapshot();
          if (snap.profiles.length !== 1) {
            throw new Error(
              `expected exactly 1 profile after parallel replace; got ${snap.profiles.length} ` +
                `(replace is not atomic)`
            );
          }
          // The profile must be one of the candidates (id like "p-000".."p-019").
          if (!/^p-[a-z]+$/.test(snap.profiles[0].id)) {
            throw new Error(`final profile id ${snap.profiles[0].id} doesn't match expected pattern`);
          }
          // On-disk content must parse + match the in-memory snapshot
          // (no partially-written file).
          const onDisk = JSON.parse(await fsp.readFile(filePath, "utf8"));
          if (onDisk.profiles.length !== 1 || onDisk.profiles[0].id !== snap.profiles[0].id) {
            throw new Error("on-disk state diverges from in-memory snapshot");
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("leaderboard-store: mutate races with deleteProfile", () => {
  test("parallel mutate + deleteProfile on the same id: no half-removed state", async () => {
    // Half the operations re-add a profile, half delete it. The
    // commitQueue ensures every commit sees the previous one's
    // effect. The final state must be EITHER "profile present"
    // (last op was a mutate-add) OR "profile absent" (last op was
    // a delete). It must never be "profile present but corrupt".
    const TARGET_ID = "target";
    await runConcurrencyScenario({
      name: "leaderboard-store: mutate vs deleteProfile",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new LeaderboardStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        await store.mutate((draft) => {
          draft.profiles.push({
            id: TARGET_ID,
            name: "Target",
            createdAt: "2026-05-11T00:00:00.000Z",
            updatedAt: "2026-05-11T00:00:00.000Z"
          });
        });
        return { store, dir };
      },
      operation: async ({ store }, i) => {
        if (i % 2 === 0) {
          // Re-add (or no-op if already present). Use mutate so we
          // don't trip a single-target constraint.
          return store.mutate((draft) => {
            if (!draft.profiles.some((p) => p.id === TARGET_ID)) {
              draft.profiles.push({
                id: TARGET_ID,
                name: "Target",
                createdAt: "2026-05-11T00:00:00.000Z",
                updatedAt: "2026-05-11T00:00:00.000Z"
              });
            }
          });
        }
        // Delete; may throw PROFILE_NOT_FOUND if prior delete already ran.
        return store.deleteProfile(TARGET_ID);
      },
      acceptableErrors: ["PROFILE_NOT_FOUND"],
      expectedSuccesses: (summary) => summary.parallelism - summary.errors.length,
      invariants: [
        async ({ store }) => {
          const snap = await store.getSnapshot();
          const matches = snap.profiles.filter((p) => p.id === TARGET_ID);
          if (matches.length > 1) {
            throw new Error(
              `expected 0 or 1 target rows; got ${matches.length} (duplicate landed)`
            );
          }
          if (matches.length === 1 && matches[0].name !== "Target") {
            throw new Error(`profile corrupted: name = ${matches[0].name}`);
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("leaderboard-store: same-profile concurrent mutate", () => {
  test("N parallel mutate on the same profile name: every commit chains, final consistent", async () => {
    // Each mutation updates the profile's `name` to a unique value.
    // Without writeQueue serialization, multiple mutations would
    // clone the same baseline and one would clobber the others.
    // With it, the final state has exactly one profile with a name
    // matching one of the candidates.
    await runConcurrencyScenario({
      name: "leaderboard-store: parallel mutate same profile",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new LeaderboardStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        await store.mutate((draft) => {
          draft.profiles.push({
            id: "alpha",
            name: "Initial",
            createdAt: "2026-05-11T00:00:00.000Z",
            updatedAt: "2026-05-11T00:00:00.000Z"
          });
        });
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.mutate((draft) => {
          const profile = draft.profiles.find((p) => p.id === "alpha");
          if (profile) {
            // Schema allows only letters/spaces/hyphens/quotes in names
            // (no digits) — alphabetic-only suffix keeps every commit
            // schema-valid.
            profile.name = `Updated-${indexToAlphaSuffix(i)}`;
          }
        }),
      invariants: [
        async ({ store }) => {
          const snap = await store.getSnapshot();
          const matches = snap.profiles.filter((p) => p.id === "alpha");
          if (matches.length !== 1) {
            throw new Error(`expected exactly 1 profile; got ${matches.length}`);
          }
          if (!/^Updated-[a-z]+$/.test(matches[0].name)) {
            throw new Error(
              `final name ${JSON.stringify(matches[0].name)} not one of the parallel-update candidates`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
