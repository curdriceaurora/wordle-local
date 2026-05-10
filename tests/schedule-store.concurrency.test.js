"use strict";

// Concurrency-stress tests for lib/schedule-store.js.
//
// ScheduleStore serializes via per-store commitQueue (Promise chain).
// Without that queue, two near-simultaneous mutations clone the same
// pre-mutation state, each apply their own updater locally, and
// whichever writeJsonAtomic rename lands LAST silently drops the
// other's update. atomic-rename makes individual writes durable but
// does not serialize concurrent writers.
//
// What we test here:
//   1. Parallel addEntry against DIFFERENT date+lang keys all land —
//      proves commitQueue actually serializes (drop-write race
//      would lose entries).
//   2. Parallel mixed mutators (addEntry + setConfig) against the
//      same store all land — proves commitQueue is store-wide, not
//      per-method.
//   3. Parallel addEntry against the SAME date+lang produces a
//      deterministic outcome: exactly one wins, the rest see
//      DUPLICATE_ENTRY (without overwrite=true). Proves the
//      duplicate-detection re-check inside the commit closure works
//      under concurrency.
//   4. Parallel updateEntry against the same row converges to a
//      single final value (last-writer-wins is acceptable; lost
//      writes are not — every commit must run, even if the previous
//      one overwrites it).
//   5. Parallel addEntry + removeEntry against the same row: never
//      leaves the store in an inconsistent (half-removed) state.
//
// Anti-flake: run with `CONCURRENCY_REPEAT=100` to surface any
// timing-dependent bug before merge. See tests/helpers/
// concurrency-fixture.js for the harness contract.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  ScheduleStore,
  normalizeSchedule
} = require("../lib/schedule-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath(name = "schedule.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-schedule-concurrency-"));
  return { dir, filePath: path.join(dir, name) };
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

// Build a date-of-month string for a given index (0–30). The store's
// WORD_PATTERN requires A-Z only, so we vary the word per index using
// a stable A-Z mapping (A..T covers indices 0..19; for stress
// parallelism >20 we'd need a longer alphabet, but the default
// fixture parallelism is 20 so this is sufficient).
function entryForIndex(i) {
  const day = String(i + 1).padStart(2, "0");
  const ch = String.fromCharCode("A".charCodeAt(0) + (i % 26));
  return {
    date: `2026-05-${day}`,
    word: ch.repeat(5),
    lang: "en"
  };
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("schedule-store: commitQueue serializes parallel writers", () => {
  test("addEntry × N parallel against distinct keys: all entries persist", async () => {
    // Without commitQueue serialization, the N parallel addEntry calls
    // clone the same pre-mutation snapshot, each push their own
    // entry to that local array, and whichever rename lands last
    // overwrites the others — typically only 1–3 entries survive
    // out of N. With the queue, all N land.
    //
    // parallelismMax: 26 because entryForIndex(i) cycles A..Z words
    // (i % 26) — at i=26 we'd push duplicate (date, lang, word)
    // triples that the schedule schema rejects as duplicates within
    // the same date. The date side caps at 31 (May has 31 days),
    // but 26 is the tighter cap. This is a correctness ceiling, not
    // a contention dial; env CONCURRENCY_PARALLELISM stress mode
    // can't push it higher without breaking the test premise.
    await runConcurrencyScenario({
      name: "schedule-store: parallel addEntry (distinct keys)",
      parallelism: 20,
      parallelismMax: 26,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) => store.addEntry(entryForIndex(i)),
      invariants: [
        async ({ store }, { parallelism }) => {
          const snap = await store.getSnapshot();
          if (snap.scheduled_words.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} entries in final snapshot; got ${snap.scheduled_words.length} ` +
                `(lost-write race — commitQueue is not serializing)`
            );
          }
          // Every parallel index must be represented exactly once.
          const dates = snap.scheduled_words.map((r) => r.date).sort();
          const expected = Array.from(
            { length: parallelism },
            (_, i) => entryForIndex(i).date
          ).sort();
          if (JSON.stringify(dates) !== JSON.stringify(expected)) {
            throw new Error(
              `dates mismatch:\n  got     ${JSON.stringify(dates)}\n  expected ${JSON.stringify(expected)}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("mixed mutators (addEntry + setConfig) all land — queue is store-wide", async () => {
    await runConcurrencyScenario({
      name: "schedule-store: mixed addEntry + setConfig",
      parallelism: 20,
      parallelismMax: 26, // same A..Z cycle constraint as the prior test
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) => {
        // Half do addEntry, half do setConfig. If commitQueue is
        // per-method instead of per-store, the two halves would
        // interleave on the same baseline and one half would lose
        // writes.
        if (i % 2 === 0) return store.addEntry(entryForIndex(i));
        // setConfig with auto_rotate_seed flips a string field. We
        // toggle between two distinct seeds so a lost-write can be
        // detected by checking the final seed is one of the
        // expected values (not a stale empty/default).
        return store.setConfig({
          auto_rotate_seed: i % 4 === 1 ? `seed-A-${i}` : `seed-B-${i}`
        });
      },
      invariants: [
        async ({ store }, { parallelism }) => {
          const snap = await store.getSnapshot();
          // addEntry runs on even-i (parallelism/2 ± 1 for odd
          // parallelism); use Math.ceil to capture i=0 inclusive.
          const expectedAdds = Math.ceil(parallelism / 2);
          if (snap.scheduled_words.length !== expectedAdds) {
            throw new Error(
              `expected ${expectedAdds} addEntry rows to persist; got ${snap.scheduled_words.length}`
            );
          }
          // Final auto_rotate_seed must be one of the odd-i values.
          // We don't care which one wins (last-writer-wins on the
          // config slot), but we DO care that the field exists and
          // matches the pattern.
          if (
            !snap.auto_rotate_seed
            || !/^seed-[AB]-\d+$/.test(snap.auto_rotate_seed)
          ) {
            throw new Error(
              `expected auto_rotate_seed to be a setConfig value; got ${JSON.stringify(snap.auto_rotate_seed)}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("schedule-store: duplicate-detection under concurrency", () => {
  test("parallel addEntry against the SAME key: exactly one succeeds, rest see DUPLICATE_ENTRY", async () => {
    // 20 calls all targeting the same date+lang. The commit closure
    // checks `findIndex` AFTER the previous commit lands, so the
    // first commit pushes the entry and every subsequent commit
    // sees `existingIndex !== -1` → throws DUPLICATE_ENTRY (because
    // overwrite=false). The serialized chain guarantees this
    // outcome — without it, two callers could both findIndex=-1
    // and both push, leaving the store with duplicates.
    await runConcurrencyScenario({
      name: "schedule-store: parallel addEntry (same key)",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }) =>
        store.addEntry({ date: "2026-05-08", word: "ALPHA", lang: "en" }),
      acceptableErrors: ["DUPLICATE_ENTRY"],
      expectedSuccesses: 1,
      invariants: [
        async ({ store }, { errors, parallelism }) => {
          // All but one caller must have lost the race with DUPLICATE_ENTRY.
          const expectedLosers = parallelism - 1;
          if (errors.length !== expectedLosers) {
            throw new Error(
              `expected ${expectedLosers} losers with DUPLICATE_ENTRY; got ${errors.length}`
            );
          }
          // Final state must contain exactly one row for that key.
          const snap = await store.getSnapshot();
          const matches = snap.scheduled_words.filter(
            (r) => r.date === "2026-05-08" && r.lang === "en"
          );
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 row for 2026-05-08/en; got ${matches.length} ` +
                `(duplicate-detection re-check is racy)`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("schedule-store: updateEntry convergence", () => {
  test("parallel updateEntry on the same row: final state is consistent (last-writer-wins)", async () => {
    // Seed one row, then fire N parallel updates against it. Each
    // call replaces only `word`, so a lost-write race would still
    // produce a one-row final state with one of the candidate
    // words — meaning this test ALONE cannot distinguish a
    // serialized commit chain from a broken one. Codex flagged
    // this on PR #109 round 1.
    //
    // The actual proof of commit-queue serialization for
    // schedule-store lives in the "addEntry × N parallel against
    // distinct keys" test above: lost writes are directly
    // observable there because each commit appends a UNIQUE row
    // and a dropped commit drops a row.
    //
    // This test still earns its keep as a CONSISTENCY check: under
    // arbitrary interleavings, the final state must be (a) exactly
    // one row, (b) with a valid candidate word, (c) passing the
    // store's own normalize. A buggy implementation that left two
    // rows or a malformed word would fail here.
    await runConcurrencyScenario({
      name: "schedule-store: parallel updateEntry",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await store.load();
        await store.addEntry({ date: "2026-05-08", word: "ZEROS", lang: "en" });
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) => {
        const ch = String.fromCharCode("A".charCodeAt(0) + (i % 26));
        return store.updateEntry("2026-05-08", "en", { word: ch.repeat(5) });
      },
      invariants: [
        async ({ store }) => {
          const snap = await store.getSnapshot();
          const matches = snap.scheduled_words.filter(
            (r) => r.date === "2026-05-08" && r.lang === "en"
          );
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 row; got ${matches.length} (commit chain corrupted state)`
            );
          }
          // The winner's word must be one of the A-Z candidates we wrote.
          // (Operation cycles i % 26 → A..Z; under env stress > 26 the
          // mapping wraps and any A-Z 5-letter word becomes valid.)
          const winner = matches[0].word;
          if (!/^[A-Z]{5}$/.test(winner)) {
            throw new Error(
              `winning word ${JSON.stringify(winner)} is not one of the parallel-update candidates`
            );
          }
          // Sanity: still passes its own normalize.
          expect(() => normalizeSchedule(snap)).not.toThrow();
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("parallel addEntry + removeEntry on the same key: no half-removed state", async () => {
    // This is the dropped-write race: a half-baked implementation
    // could land an `addEntry` after a `removeEntry` whose snapshot
    // doesn't include the add — leaving the entry "removed" from
    // the rollback's perspective but "added" in the next commit's
    // baseline. With commitQueue, every commit sees the previous's
    // effect; the final outcome must be either "row present" or
    // "row absent", never "row exists but normalize rejects".
    await runConcurrencyScenario({
      name: "schedule-store: addEntry vs removeEntry",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await store.load();
        // Seed so removeEntry can find a target on iter 0.
        await store.addEntry({ date: "2026-05-08", word: "INITS", lang: "en" });
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) => {
        if (i % 2 === 0) {
          // remove may throw ENTRY_NOT_FOUND if a prior remove
          // already happened — that's expected, not a bug.
          return store.removeEntry("2026-05-08", "en");
        }
        // add may throw DUPLICATE_ENTRY if a prior add already
        // happened without an intervening remove — also expected.
        return store.addEntry({ date: "2026-05-08", word: "ALPHA", lang: "en" });
      },
      acceptableErrors: ["ENTRY_NOT_FOUND", "DUPLICATE_ENTRY"],
      // We don't constrain expectedSuccesses — the count depends on
      // the exact interleaving. We just require zero unexpected
      // errors and a consistent final state.
      expectedSuccesses: (summary) => summary.parallelism - summary.errors.length,
      invariants: [
        async ({ store }) => {
          const snap = await store.getSnapshot();
          const matches = snap.scheduled_words.filter(
            (r) => r.date === "2026-05-08" && r.lang === "en"
          );
          // Either 0 (final op was a remove) or 1 (final op was an add).
          if (matches.length > 1) {
            throw new Error(
              `expected 0 or 1 rows; got ${matches.length} — duplicate landed`
            );
          }
          if (matches.length === 1) {
            if (!["INITS", "ALPHA"].includes(matches[0].word)) {
              throw new Error(
                `unexpected word survived: ${JSON.stringify(matches[0].word)}`
              );
            }
          }
          expect(() => normalizeSchedule(snap)).not.toThrow();
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("schedule-store: load() ENOENT race", () => {
  test("first parallel load() calls share a single default-write — no stragglers", async () => {
    // Without the loadPromise serialization, two concurrent first
    // callers each see ENOENT, each persist a fresh empty schedule,
    // and a default write that lands after a real commit would
    // clobber it. The single loadPromise serializes the initial
    // read + default-write so both callers await the same write.
    await runConcurrencyScenario({
      name: "schedule-store: parallel first load()",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        // Deliberately do NOT pre-load — every call below is a first call.
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        return { store, filePath, dir };
      },
      operation: async ({ store }) => store.load(),
      invariants: [
        async ({ filePath }, { results }) => {
          // All callers must get identical content shape.
          for (const r of results) {
            if (r.scheduled_words.length !== 0) {
              throw new Error("load() returned non-empty scheduled_words on cold start");
            }
            if (r.version !== 1) {
              throw new Error(`load() returned unexpected version: ${r.version}`);
            }
          }
          // No straggler temp files (would prove two concurrent
          // writeJsonAtomic default-writes raced).
          const dir = path.dirname(filePath);
          const dirContents = await fsp.readdir(dir);
          const stragglers = dirContents.filter((n) => n.endsWith(".tmp"));
          if (stragglers.length > 0) {
            throw new Error(
              `expected no .tmp stragglers; found ${stragglers.length}: ${stragglers.join(", ")}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
