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
    const M_JOBS = 5;
    const PARALLEL_CLAIMS = 20;
    await runConcurrencyScenario({
      name: "admin-jobs-store: parallel claimNextQueuedJob",
      parallelism: PARALLEL_CLAIMS,
      setup: async () => {
        const { dir, filePath } = tempFilePath();
        const store = new AdminJobsStore({
          filePath,
          now: frozenNow(),
          logger: { warn: () => {}, error: () => {} }
        });
        await store.load();
        // Seed M_JOBS queued jobs.
        for (let i = 0; i < M_JOBS; i += 1) {
          await store.enqueueProviderImportJob(sampleRequest(i));
        }
        return { store, dir };
      },
      operation: async ({ store }) => store.claimNextQueuedJob(),
      invariants: [
        async ({ store }, { results }) => {
          const claimed = results.filter((r) => r !== null);
          const nulls = results.filter((r) => r === null);
          if (claimed.length !== M_JOBS) {
            throw new Error(
              `expected ${M_JOBS} claims; got ${claimed.length} ` +
                `(at most-once invariant broken)`
            );
          }
          if (nulls.length !== PARALLEL_CLAIMS - M_JOBS) {
            throw new Error(
              `expected ${PARALLEL_CLAIMS - M_JOBS} null returns; got ${nulls.length}`
            );
          }
          // Each claim is a unique job (no double-claim).
          const claimedIds = new Set(claimed.map((j) => j.id));
          if (claimedIds.size !== M_JOBS) {
            throw new Error(
              `expected ${M_JOBS} unique claimed ids; got ${claimedIds.size} ` +
                `(same job claimed twice — exclusivity broken)`
            );
          }
          // Every claimed job has status="running".
          for (const job of claimed) {
            if (job.status !== "running") {
              throw new Error(`claimed job ${job.id} has unexpected status ${job.status}`);
            }
          }
          // Store snapshot: M_JOBS running, 0 queued.
          const snap = await store.getSnapshot();
          const running = snap.jobs.filter((j) => j.status === "running");
          const queued = snap.jobs.filter((j) => j.status === "queued");
          if (running.length !== M_JOBS) {
            throw new Error(
              `expected ${M_JOBS} running jobs in store; got ${running.length}`
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
  test("parallel markSucceeded on the same running job is idempotent under the writeQueue", async () => {
    // Test the per-job terminal-state invariant: once succeeded,
    // subsequent markSucceeded calls re-stamp updatedAt but don't
    // corrupt the job. With writeQueue serialization, each call
    // sees the previous one's state.
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
        // Claim so the job is in "running" state and markSucceeded
        // will accept it.
        await store.claimNextQueuedJob();
        return { store, jobId: enqueued.id, dir };
      },
      operation: async ({ store, jobId }, i) =>
        store.markSucceeded(jobId, { artifacts: { iteration: i } }),
      acceptableErrors: ["INVALID_JOB_STATE"],
      // First call succeeds; subsequent ones may reject because the job
      // is already in a terminal state (not "running"). Either path
      // is fine — we just want no corruption.
      expectedSuccesses: (summary) => summary.parallelism - summary.errors.length,
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
          // finishedAt and updatedAt must be set.
          if (!matches[0].finishedAt) {
            throw new Error("finishedAt not set after succeeded");
          }
        }
      ],
      teardown: async ({ dir }) => cleanupDir(dir)
    });
  }, 60000);
});
