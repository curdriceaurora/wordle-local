"use strict";

// Concurrency-stress tests for lib/challenge-results-store.js.
//
// ChallengeResultsStore enforces TWO concurrency-sensitive invariants:
//
//   1. SINGLE-IN-FLIGHT per (challengeId, profileId): two concurrent
//      `/challenges/start` requests for the same user must NOT create
//      two parallel sessions. The store's `createSession` re-checks for
//      an existing in-flight session inside the commit closure (after
//      the route's findInFlight pre-check) and returns the existing
//      session as a resume if one is found. Without this atomic re-
//      check, both racers see `findIndex=-1`, both push a new session,
//      and the user ends up with two parallel timers/scores.
//
//   2. NO DROP-GUESS in transactionalUpdate: each call to
//      `transactionalUpdate(id, mutator)` reads-modifies-writes the
//      session atomically within the commitQueue. If two `/guess`
//      requests for the same session race, each one's mutator must
//      see the previous one's persisted result so guesses accumulate
//      instead of clobbering each other. This is the classic drop-
//      guess race that motivated the move from a load-mutate-save
//      pattern to commitQueue-serialized #commit.
//
// We test both directly with the fixture.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  ChallengeResultsStore
} = require("../lib/challenge-results-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-results-concurrency-"));
  return { dir, filePath: path.join(dir, "challenge-results.json") };
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function makeChallengeId() {
  return "c-test-001";
}

function makeProfileId() {
  return "p-test-001";
}

function basePuzzles() {
  // 3 puzzles, each unsolved with empty guesses; matches schema:
  //   index: int, word: 3–12 A-Z, guesses: array of A-Z strings,
  //   solved: bool. We'll mutate guesses[] via transactionalUpdate.
  return [
    { index: 0, word: "ALPHA", guesses: [], solved: false },
    { index: 1, word: "BETAS", guesses: [], solved: false },
    { index: 2, word: "GAMMA", guesses: [], solved: false }
  ];
}

describe("challenge-results-store: single-in-flight invariant under concurrency", () => {
  test("N parallel createSession for the same (challengeId, profileId) yield one session, rest resume", async () => {
    // Without the atomic re-check inside #commit, two concurrent
    // /start requests would both observe findInFlight=null and each
    // push a fresh session — leaving two parallel timers for the
    // same user. The re-check guarantees: first commit pushes one
    // session; every subsequent commit sees `existing` and returns
    // it as a resume.
    await runConcurrencyScenario({
      name: "challenge-results-store: parallel createSession same key",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ChallengeResultsStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }) =>
        store.createSession({
          challengeId: makeChallengeId(),
          profileId: makeProfileId(),
          profileName: "Tester",
          puzzles: basePuzzles()
        }),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          // Exactly one of N results must report resumed=false
          // (the winner). All others must report resumed=true.
          const winners = results.filter((r) => r.resumed === false);
          const resumers = results.filter((r) => r.resumed === true);
          if (winners.length !== 1) {
            throw new Error(
              `expected exactly 1 winner; got ${winners.length} ` +
                `(single-in-flight invariant broken: race created multiple sessions)`
            );
          }
          const expectedResumers = parallelism - 1;
          if (resumers.length !== expectedResumers) {
            throw new Error(
              `expected ${expectedResumers} resumers; got ${resumers.length}`
            );
          }
          // All resumers must point at the same session id as the winner.
          const winnerId = winners[0].session.id;
          for (const r of resumers) {
            if (r.session.id !== winnerId) {
              throw new Error(
                `resumer returned session ${r.session.id}, expected ${winnerId}`
              );
            }
          }
          // Final store state: exactly one session for that (challenge, profile).
          const snap = await store.getSnapshot();
          const matches = snap.sessions.filter(
            (s) => s.challengeId === makeChallengeId() && s.profileId === makeProfileId()
          );
          if (matches.length !== 1) {
            throw new Error(
              `expected exactly 1 session in store; got ${matches.length}`
            );
          }
          if (matches[0].status !== "in-progress") {
            throw new Error(
              `expected session.status="in-progress"; got ${matches[0].status}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  test("parallel createSession across DIFFERENT (challengeId, profileId) pairs each succeed", async () => {
    // Negative test for the same invariant: when the keys differ, the
    // single-in-flight check must NOT block. Each call creates its own
    // session.
    await runConcurrencyScenario({
      name: "challenge-results-store: parallel createSession distinct keys",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ChallengeResultsStore({ filePath, now: frozenNow() });
        await store.load();
        return { store, filePath, dir };
      },
      operation: async ({ store }, i) =>
        store.createSession({
          challengeId: makeChallengeId(),
          profileId: `p-${i}`,
          profileName: `Tester${i}`,
          puzzles: basePuzzles()
        }),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          // All N should be winners (resumed=false).
          const winners = results.filter((r) => r.resumed === false);
          if (winners.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} winners (all distinct keys); got ${winners.length}`
            );
          }
          // N unique session IDs.
          const ids = new Set(results.map((r) => r.session.id));
          if (ids.size !== parallelism) {
            throw new Error(
              `expected ${parallelism} unique session IDs; got ${ids.size}`
            );
          }
          // Final store: N sessions.
          const snap = await store.getSnapshot();
          if (snap.sessions.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} sessions in store; got ${snap.sessions.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("challenge-results-store: transactionalUpdate no-drop-guess", () => {
  test("N parallel transactionalUpdate appending to puzzles[0].guesses preserves all appends", async () => {
    // Each parallel call appends a unique guess to puzzles[0].guesses.
    // Without commitQueue serialization, two concurrent callers
    // would each clone the same baseline guesses array and each push
    // their own — the later write overwrites the earlier, losing
    // one guess (the classic drop-guess race). With it, every
    // appended guess survives.
    //
    // Parallelism capped at 10 because the puzzle schema enforces
    // guesses.length ≤ 12 — using the fixture's default 20 would
    // hit INVALID_PUZZLE on the 13th append for reasons unrelated
    // to the concurrency invariant. 10 parallel appends is still
    // a heavy contention test for the commit queue.
    //
    // `parallelismMax: 10` is the OPT-OUT for the env-driven stress
    // mode (CONCURRENCY_PARALLELISM=200). Without it, the env bump
    // would push fan-out past the schema cap and the test would
    // fail with INVALID_PUZZLE — masking the concurrency invariant
    // this test is meant to pin. See the harness's `parallelismMax`
    // option docs (Codex review on PR #109).
    const PARALLEL_APPENDS = 10;
    await runConcurrencyScenario({
      name: "challenge-results-store: parallel transactionalUpdate guess-append",
      parallelism: PARALLEL_APPENDS,
      parallelismMax: PARALLEL_APPENDS,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new ChallengeResultsStore({ filePath, now: frozenNow() });
        await store.load();
        const { session } = await store.createSession({
          challengeId: makeChallengeId(),
          profileId: makeProfileId(),
          profileName: "Tester",
          puzzles: basePuzzles()
        });
        return { store, sessionId: session.id, dir };
      },
      operation: async ({ store, sessionId }, i) => {
        // Each i picks a distinct 5-letter guess. We use AAAAA..TTTTT
        // (i % 26 letters) to stay within WORD_PATTERN.
        const ch = String.fromCharCode("A".charCodeAt(0) + (i % 26));
        const guess = ch.repeat(5);
        return store.transactionalUpdate(sessionId, (s) => {
          // Append guess to puzzle 0 unconditionally.
          const next = JSON.parse(JSON.stringify(s));
          next.puzzles[0].guesses.push(guess);
          return next;
        });
      },
      invariants: [
        async ({ store, sessionId }) => {
          const session = await store.findById(sessionId);
          if (!session) {
            throw new Error("session vanished mid-update");
          }
          const guesses = session.puzzles[0].guesses;
          if (guesses.length !== PARALLEL_APPENDS) {
            throw new Error(
              `expected ${PARALLEL_APPENDS} accumulated guesses; got ${guesses.length} ` +
                `(drop-guess race: commitQueue is not serializing transactionalUpdate)`
            );
          }
          // Every appended guess must survive (no duplicates, no skips).
          // The fixture's `i` ranges 0..PARALLEL_APPENDS-1, so we
          // expect the first N letters of the alphabet, each
          // repeated 5 times.
          const expected = Array.from(
            { length: PARALLEL_APPENDS },
            (_, i) => String.fromCharCode("A".charCodeAt(0) + i).repeat(5)
          ).sort();
          const actual = [...guesses].sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
              `guess content mismatch:\n  got     ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);

  // Identity-violation rejection paths for each of the three immutable
  // fields. Without this, a regression that allowed `id` or
  // `challengeId` mutations would still pass the legacy single-field
  // test — CodeRabbit caught this on PR #109 round 1.
  describe.each([
    ["id", "evil-id"],
    ["challengeId", "evil-challenge"],
    ["profileId", "evil-profile"]
  ])("transactionalUpdate rejects mutator output that changes %s", (field, evilValue) => {
    test("20 parallel violators all fail with INVALID_REQUEST; session unchanged", async () => {
      await runConcurrencyScenario({
        name: `challenge-results-store: parallel transactionalUpdate ${field}-violation`,
        parallelism: 20,
        setup: async () => {
          const { dir, filePath } = tempFilePath();
          const store = new ChallengeResultsStore({ filePath, now: frozenNow() });
          await store.load();
          const { session } = await store.createSession({
            challengeId: makeChallengeId(),
            profileId: makeProfileId(),
            profileName: "Tester",
            puzzles: basePuzzles()
          });
          return {
            store,
            sessionId: session.id,
            originalSession: session,
            dir
          };
        },
        operation: async ({ store, sessionId }) =>
          store.transactionalUpdate(sessionId, (s) => {
            const next = JSON.parse(JSON.stringify(s));
            next[field] = evilValue;
            return next;
          }),
        acceptableErrors: ["INVALID_REQUEST"],
        expectedSuccesses: 0,
        invariants: [
          async ({ store, sessionId, originalSession }, { errors, parallelism }) => {
            if (errors.length !== parallelism) {
              throw new Error(
                `expected ${parallelism} errors; got ${errors.length}`
              );
            }
            // Compare against the original session captured in
            // setup — each immutable field must be untouched.
            const session = await store.findById(sessionId);
            if (!session) throw new Error("session vanished");
            for (const immutable of ["id", "challengeId", "profileId"]) {
              if (session[immutable] !== originalSession[immutable]) {
                throw new Error(
                  `session.${immutable} mutated: got ${session[immutable]}, expected ${originalSession[immutable]}`
                );
              }
            }
            if (session.status !== "in-progress") {
              throw new Error(
                `session.status changed: got ${session.status}`
              );
            }
          }
        ],
        teardown: async ({ dir }) => cleanupDir(dir)
      });
    }, 60000);
  });
});
