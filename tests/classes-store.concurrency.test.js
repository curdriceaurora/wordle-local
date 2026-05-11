"use strict";

// Concurrency-stress tests for lib/classes-store.js.
//
// ClassesStore serializes via per-store `writeQueue` (`#enqueueWrite`).
// Same pattern as leaderboard-store and admin-jobs-store: every async
// mutation chains onto the queue so two parallel writes never clone
// the same baseline and clobber each other.
//
// What this file pins:
//   1. Parallel `createClass` with distinct names — every class lands;
//      no lost writes.
//   2. Parallel `createClass` with the SAME name — exactly one wins;
//      rest reject with DUPLICATE_NAME atomically (the duplicate
//      check inside the commit closure must run on the prior-commit
//      state, not a stale snapshot).
//   3. Parallel `addMembers` + `removeMember` on the same class — no
//      half-removed membership; final state is internally consistent.
//
// Filed as #132 (Epic C: Test Coverage & Fault Injection).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ClassesStore } = require("../lib/classes-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-classes-concurrency-"));
  return { dir, filePath: path.join(dir, "classes.json") };
}

function frozenNow(iso = "2026-05-11T00:00:00.000Z") {
  return () => new Date(iso);
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

// Build a profile id (1-64 chars, no whitespace per profileId rules
// in the schema). Uses `toString()` not `padStart` so the id format
// scales with i — Copilot caught the prior `padStart(3, "0")` would
// have broken under env CONCURRENCY_PARALLELISM>=1000.
function makeProfileId(i) {
  return `profile-${i}`;
}

describe("classes-store: writeQueue serializes parallel createClass", () => {
  test("N parallel createClass with distinct names: every class persists", async () => {
    await runConcurrencyScenario({
      name: "classes-store: parallel createClass (distinct names)",
      // ClassesStore.DEFAULT_MAX_CLASSES is 200. `parallelismMax`
      // clamps env stress mode so we don't trip
      // MAX_CLASSES_REACHED (Copilot caught the wrong cap value
      // in the prior comment on PR #134 round 1).
      parallelism: 20,
      parallelismMax: 200,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ClassesStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.createClass(`Class-${String.fromCharCode(65 + (i % 26))}-${i}`),
      invariants: [
        async ({ store }, { parallelism }) => {
          const snap = await store.getSnapshot();
          if (snap.classes.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} classes; got ${snap.classes.length} ` +
                `(lost-write race — writeQueue is not serializing)`
            );
          }
          // Every id is unique.
          const ids = new Set(snap.classes.map((c) => c.id));
          if (ids.size !== parallelism) {
            throw new Error(`expected ${parallelism} unique ids; got ${ids.size}`);
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("N parallel createClass with the SAME name: exactly one wins, rest reject DUPLICATE_NAME", async () => {
    // The duplicate-name check is inside the commit closure, so
    // the second-and-later commits see the prior state with the
    // class already present and reject. Without the writeQueue,
    // two callers could both observe "no duplicate" and both push.
    await runConcurrencyScenario({
      name: "classes-store: parallel createClass (same name)",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ClassesStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }) => store.createClass("Shared Name"),
      acceptableErrors: ["DUPLICATE_NAME"],
      expectedSuccesses: 1,
      invariants: [
        async ({ store }, { errors, parallelism }) => {
          if (errors.length !== parallelism - 1) {
            throw new Error(
              `expected ${parallelism - 1} losers with DUPLICATE_NAME; got ${errors.length}`
            );
          }
          const snap = await store.getSnapshot();
          const matches = snap.classes.filter(
            (c) => c.name.toLowerCase() === "shared name"
          );
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 class with name "Shared Name"; got ${matches.length} ` +
                `(duplicate-check race)`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("classes-store: membership mutations under concurrency", () => {
  test("parallel addMembers + removeMember on a shared id pool: no half-removed state", async () => {
    // Codex P2 PR #134 round 1: the prior version added profile-i
    // for even i and removed profile-i for odd i, so removes always
    // failed with MEMBER_NOT_FOUND and never actually raced a
    // successful add. We now seed a SHARED POOL of ids in setup
    // and both halves operate on that pool — adds may be no-ops
    // (id already present), removes may succeed OR fail. Either
    // way the add+remove race is genuinely exercised.
    const POOL_SIZE = 5; // ids picked deterministically per i
    await runConcurrencyScenario({
      name: "classes-store: addMembers vs removeMember (shared pool)",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ClassesStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        const created = await store.createClass("Mixed Class");
        // Seed all POOL_SIZE ids so initial removes can succeed.
        await store.addMembers(
          created.id,
          Array.from({ length: POOL_SIZE }, (_, k) => makeProfileId(k))
        );
        return { store, classId: created.id, dir };
      },
      operation: async ({ store, classId }, i) => {
        const profile = makeProfileId(i % POOL_SIZE);
        if (i % 2 === 0) {
          // Add: re-add (no-op if still present) or restore after
          // a prior remove won the race.
          return store.addMembers(classId, [profile]);
        }
        // Remove: may succeed (id present) or fail (prior remove won).
        return store.removeMember(classId, profile);
      },
      acceptableErrors: ["MEMBER_NOT_FOUND"],
      expectedSuccesses: (summary) => summary.parallelism - summary.errors.length,
      invariants: [
        async ({ store, classId }) => {
          const snap = await store.getSnapshot();
          const cls = snap.classes.find((c) => c.id === classId);
          if (!cls) throw new Error("class disappeared");
          // No duplicate profile ids.
          const ids = cls.memberProfileIds;
          if (new Set(ids).size !== ids.length) {
            throw new Error(
              `duplicate profile ids in member list: ${JSON.stringify(ids)}`
            );
          }
          // Every id matches the makeProfileId(i) format (no torn writes).
          for (const id of ids) {
            if (!/^profile-\d+$/.test(id)) {
              throw new Error(`malformed profile id in member list: ${id}`);
            }
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("classes-store: parallel updateClass converges", () => {
  test("parallel updateClass on the same class: final state has one of the candidate names", async () => {
    // Same class-of-bug as the challenge-config-store/schedule-store
    // single-field replace tests: last-writer-wins is visible whether
    // or not commits are serialized. We pin consistency here
    // (exactly one class row remains, name matches a candidate); the
    // strong commit-queue proof for this store lives in the
    // "parallel createClass (distinct names)" test above.
    await runConcurrencyScenario({
      name: "classes-store: parallel updateClass",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ClassesStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        const created = await store.createClass("Initial Name");
        return { store, classId: created.id, dir };
      },
      operation: async ({ store, classId }, i) =>
        store.updateClass(classId, { name: `Renamed ${String.fromCharCode(65 + (i % 26))}` }),
      invariants: [
        async ({ store, classId }) => {
          const snap = await store.getSnapshot();
          const cls = snap.classes.find((c) => c.id === classId);
          if (!cls) throw new Error("class disappeared");
          if (!/^Renamed [A-Z]$/.test(cls.name)) {
            throw new Error(
              `final name ${JSON.stringify(cls.name)} not one of the parallel-update candidates`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
