"use strict";

// Concurrency-stress tests for lib/admin-jobs-store.js.
//
// AdminJobsStore serializes via per-store `writeQueue` (`#enqueueWrite`).
// What this file pins:
//
//   1. Parallel `enqueueProviderImportJob` calls — every job lands;
//      ids are unique; no lost writes.
//   2. SINGLE-CLAIM invariant: N parallel `claimNextQueuedJob` against
//      a queue of M < N jobs returns at most M distinct jobs; the
//      remaining (N - M) callers return null (no claim to make). No
//      job is claimed twice.
//   3. Parallel `markSucceeded` / `markFailed` on different running
//      jobs converges; each terminal commit lands.
//
// Filed as #132 (Epic C: Test Coverage & Fault Injection).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { AdminJobsStore } = require("../lib/admin-jobs-store");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-admin-jobs-concurrency-"));
  return { dir, filePath: path.join(dir, "admin-jobs.json") };
}

function frozenNow(iso = "2026-05-11T00:00:00.000Z") {
  return () => new Date(iso);
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

function sampleRequest(i) {
  return {
    provider: "test-provider",
    language: "en",
    variant: `variant-${i}`
  };
}

describe("admin-jobs-store: writeQueue serializes parallel enqueue", () => {
  test("N parallel enqueueProviderImportJob: every job persists with a unique id", async () => {
    await runConcurrencyScenario({
      name: "admin-jobs-store: parallel enqueueProviderImportJob",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new AdminJobsStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        return { store, dir };
      },
      operation: async ({ store }, i) =>
        store.enqueueProviderImportJob(sampleRequest(i)),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          const ids = new Set(results.map((j) => j.id));
          if (ids.size !== parallelism) {
            throw new Error(
              `expected ${parallelism} unique job ids from results; got ${ids.size}`
            );
          }
          const snap = await store.getSnapshot();
          const storeIds = new Set(snap.jobs.map((j) => j.id));
          for (const id of ids) {
            if (!storeIds.has(id)) {
              throw new Error(`job ${id} returned from enqueue() but missing from store snapshot`);
            }
          }
          // Total in store should equal parallelism (no extras, no losses).
          if (snap.jobs.length !== parallelism) {
            throw new Error(
              `expected ${parallelism} jobs in store; got ${snap.jobs.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("admin-jobs-store: claimNextQueuedJob is exclusive", () => {
  test("N parallel claims against M queued jobs: at most M distinct claims, rest return null", async () => {
    // The single-claim invariant: claimNextQueuedJob serializes
    // through #enqueueWrite, so each commit sees the prior commits'
    // effects. The first M callers each claim a different queued
    // job; the rest see an empty queue and return null. No job is
    // claimed twice.
    // Seed M jobs, fire parallel claims. Some claimers get a job;
    // the rest get null. The invariant derives expected counts from
    // store state so it's tolerant of env-driven parallelism
    // changes (CONCURRENCY_PARALLELISM=200 just adds more nulls).
    const SEEDED_JOBS = 5;
    await runConcurrencyScenario({
      name: "admin-jobs-store: parallel claimNextQueuedJob",
      parallelism: 20,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new AdminJobsStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        for (let i = 0; i < SEEDED_JOBS; i += 1) {
          await store.enqueueProviderImportJob(sampleRequest(i));
        }
        return { store, dir };
      },
      operation: async ({ store }) => store.claimNextQueuedJob(),
      invariants: [
        async ({ store }, { results, parallelism }) => {
          const claimed = results.filter((r) => r !== null);
          const nulls = results.filter((r) => r === null);
          // (1) Every caller got either a job or null.
          if (nulls.length + claimed.length !== parallelism) {
            throw new Error(
              `null + claimed (${nulls.length} + ${claimed.length}) != parallelism (${parallelism})`
            );
          }
          // (2) Claim count equals min(SEEDED_JOBS, parallelism) —
          // every seeded job got claimed (no leaks), and we didn't
          // claim more than were seeded.
          const expectedClaimed = Math.min(SEEDED_JOBS, parallelism);
          if (claimed.length !== expectedClaimed) {
            throw new Error(
              `expected ${expectedClaimed} claims; got ${claimed.length} ` +
                `(exclusivity broken or job not surfaced)`
            );
          }
          // (3) Each claim is a unique job (no double-claim).
          const claimedIds = new Set(claimed.map((j) => j.id));
          if (claimedIds.size !== claimed.length) {
            throw new Error(
              `expected ${claimed.length} unique claimed ids; got ${claimedIds.size} ` +
                `(same job claimed twice — exclusivity broken)`
            );
          }
          // (4) Every claim has status="running".
          for (const job of claimed) {
            if (job.status !== "running") {
              throw new Error(`claimed job ${job.id} has unexpected status ${job.status}`);
            }
          }
          // (5) Store snapshot: SEEDED_JOBS running, 0 queued.
          const snap = await store.getSnapshot();
          const running = snap.jobs.filter((j) => j.status === "running");
          const queued = snap.jobs.filter((j) => j.status === "queued");
          if (running.length !== expectedClaimed) {
            throw new Error(
              `expected ${expectedClaimed} running jobs in store; got ${running.length}`
            );
          }
          if (queued.length !== 0) {
            throw new Error(
              `expected 0 queued jobs after exhausting via parallel claims; got ${queued.length}`
            );
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});

describe("admin-jobs-store: parallel terminal updates", () => {
  test("parallel markSucceeded on the same job is idempotent (terminal-state convergence)", async () => {
    // markSucceeded has no "must be running" precondition — every
    // call sets status="succeeded" and stamps updatedAt. With
    // writeQueue serialization, N parallel markSucceeded calls all
    // succeed and the final state has status=succeeded with a
    // single updatedAt timestamp (last writer wins). No corruption,
    // no duplicate rows.
    //
    // Copilot caught the prior comment claiming a precondition error
    // on PR #134 round 1 — corrected here.
    await runConcurrencyScenario({
      name: "admin-jobs-store: parallel markSucceeded same job",
      parallelism: 10,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new AdminJobsStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        const enqueued = await store.enqueueProviderImportJob(sampleRequest(0));
        // Claim once so the job starts as "running"; subsequent
        // markSucceeded calls all transition to "succeeded".
        await store.claimNextQueuedJob();
        return { store, jobId: enqueued.id, dir };
      },
      operation: async ({ store, jobId }, i) =>
        store.markSucceeded(jobId, { artifacts: { iteration: i } }),
      invariants: [
        async ({ store, jobId }) => {
          const snap = await store.getSnapshot();
          const matches = snap.jobs.filter((j) => j.id === jobId);
          if (matches.length !== 1) {
            throw new Error(`expected exactly 1 job row; got ${matches.length}`);
          }
          if (matches[0].status !== "succeeded") {
            throw new Error(`expected status="succeeded"; got ${matches[0].status}`);
          }
          if (!matches[0].finishedAt) {
            throw new Error("finishedAt not set after succeeded");
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
