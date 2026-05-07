const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  AdminJobsStore,
  AdminJobsStoreError,
  createDefaultState
} = require("../lib/admin-jobs-store");

const createdTempDirs = [];

function tempFilePath(name = "admin-jobs.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-admin-jobs-"));
  createdTempDirs.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
      // best-effort cleanup; CI runners reclaim /tmp anyway
    }
  }
});

function readState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildRequest(overrides = {}) {
  return {
    sourceType: "remote-fetch",
    variant: "en-US",
    commit: "0123456789abcdef0123456789abcdef01234567",
    filterMode: "denylist-only",
    expectedChecksums: {
      dic: "a".repeat(64),
      aff: "b".repeat(64)
    },
    ...overrides
  };
}

function createClock(initialMs = Date.UTC(2026, 0, 1)) {
  let cursor = initialMs;
  return {
    now: () => new Date(cursor),
    advance(ms = 1000) {
      cursor += ms;
      return cursor;
    },
    setTo(ms) {
      cursor = ms;
    }
  };
}

function silentLogger() {
  return { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
}

describe("admin-jobs-store: load and recovery", () => {
  test("creates default state file when missing", async () => {
    const filePath = tempFilePath();
    const store = new AdminJobsStore({ filePath, logger: silentLogger() });

    const snapshot = await store.getSnapshot();

    expect(snapshot).toEqual(createDefaultState());
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readState(filePath)).toEqual(createDefaultState());
  });

  test("resets state when file contains invalid JSON", async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");
    const logger = silentLogger();
    const store = new AdminJobsStore({ filePath, logger });

    const snapshot = await store.getSnapshot();

    expect(snapshot).toEqual(createDefaultState());
    expect(logger.warn).toHaveBeenCalled();
  });

  test("resets state when version is unexpected", async () => {
    const filePath = tempFilePath();
    writeState(filePath, { version: 99, updatedAt: new Date(0).toISOString(), jobs: [] });
    const logger = silentLogger();
    const store = new AdminJobsStore({ filePath, logger });

    const snapshot = await store.getSnapshot();

    expect(snapshot).toEqual(createDefaultState());
    expect(logger.warn).toHaveBeenCalled();
  });

  test("strips invalid job entries on load and warns", async () => {
    const filePath = tempFilePath();
    writeState(filePath, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      jobs: [
        {
          id: "not-a-job-id",
          type: "provider-import",
          status: "queued",
          attempts: 0,
          maxAttempts: 1,
          requestedBy: "admin",
          createdAt: new Date(1000).toISOString(),
          updatedAt: new Date(1000).toISOString(),
          request: buildRequest()
        },
        {
          id: "job-aaaaaaaaaaaa",
          type: "provider-import",
          status: "queued",
          attempts: 0,
          maxAttempts: 1,
          requestedBy: "admin",
          createdAt: new Date(2000).toISOString(),
          updatedAt: new Date(2000).toISOString(),
          request: buildRequest()
        }
      ]
    });
    const logger = silentLogger();
    const store = new AdminJobsStore({ filePath, logger });

    const snapshot = await store.getSnapshot();

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0].id).toBe("job-aaaaaaaaaaaa");
    expect(logger.warn).toHaveBeenCalled();
  });

  test("recovers running jobs to queued and persists across a fresh store", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const first = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    await first.enqueueProviderImportJob(buildRequest(), { requestedBy: "admin" });
    clock.advance();
    const claimed = await first.claimNextQueuedJob();
    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    expect(claimed.startedAt).toBeTruthy();

    const persisted = readState(filePath);
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.jobs[0].status).toBe("running");

    clock.advance();
    const second = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });
    const mutated = await second.recoverRunningJobs();

    expect(mutated).toBe(true);
    const recovered = await second.getById(claimed.id);
    expect(recovered.status).toBe("queued");
    expect(recovered.startedAt).toBeNull();
    expect(recovered.finishedAt).toBeNull();
    expect(recovered.attempts).toBe(1);

    const persistedAfterRecovery = readState(filePath);
    expect(persistedAfterRecovery.jobs[0].status).toBe("queued");
    expect(persistedAfterRecovery.jobs[0].finishedAt).toBeNull();

    const third = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });
    const reloaded = await third.getById(claimed.id);
    expect(reloaded.status).toBe("queued");
  });

  test("recoverRunningJobs is a no-op when nothing is running", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });
    await store.enqueueProviderImportJob(buildRequest(), { requestedBy: "admin" });

    const before = readState(filePath).updatedAt;
    const mutated = await store.recoverRunningJobs();
    const after = readState(filePath).updatedAt;

    expect(mutated).toBe(false);
    expect(after).toBe(before);
  });
});

describe("admin-jobs-store: enqueue and claim", () => {
  test("enqueueProviderImportJob produces a queued job with defaults and persists", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    const job = await store.enqueueProviderImportJob(buildRequest());

    expect(job.id).toMatch(/^job-/);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(1);
    expect(job.requestedBy).toBe("admin");
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.request).toEqual(buildRequest());

    const persisted = readState(filePath);
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.jobs[0].id).toBe(job.id);
  });

  test("enqueueProviderImportJob honors caller options", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });

    const job = await store.enqueueProviderImportJob(buildRequest(), {
      requestedBy: "operator-1",
      maxAttempts: 3
    });

    expect(job.requestedBy).toBe("operator-1");
    expect(job.maxAttempts).toBe(3);
  });

  test("enqueueProviderImportJob rejects non-object requests", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });

    await expect(store.enqueueProviderImportJob(null)).rejects.toBeInstanceOf(AdminJobsStoreError);
    await expect(store.enqueueProviderImportJob("not-an-object")).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  test("claimNextQueuedJob returns null when no jobs are queued", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    expect(await store.claimNextQueuedJob()).toBeNull();
  });

  test("claimNextQueuedJob picks the oldest queued job and increments attempts", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    const first = await store.enqueueProviderImportJob(buildRequest({ variant: "en-US" }));
    clock.advance();
    const second = await store.enqueueProviderImportJob(buildRequest({ variant: "en-GB" }));
    expect(first.createdAt < second.createdAt).toBe(true);

    clock.advance();
    const claimed = await store.claimNextQueuedJob();

    expect(claimed.id).toBe(first.id);
    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    expect(claimed.startedAt).toBeTruthy();
  });

  test("claimNextQueuedJob clears stale error and artifacts from prior attempts", async () => {
    const filePath = tempFilePath();
    writeState(filePath, {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      jobs: [
        {
          id: "job-aaaaaaaaaaaa",
          type: "provider-import",
          status: "queued",
          attempts: 1,
          maxAttempts: 3,
          requestedBy: "admin",
          createdAt: new Date(1000).toISOString(),
          updatedAt: new Date(2000).toISOString(),
          startedAt: null,
          finishedAt: null,
          request: buildRequest(),
          error: { code: "PIPELINE_FAILED", message: "Previous run failed" },
          artifacts: {
            commit: "f".repeat(40),
            sourceManifestPath: "stale/m.json",
            expandedFormsPath: "stale/e.txt",
            guessPoolPath: "stale/g.txt",
            answerPoolPath: "stale/a.txt"
          }
        }
      ]
    });
    const store = new AdminJobsStore({ filePath, logger: silentLogger() });

    const claimed = await store.claimNextQueuedJob();

    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(2);
    expect(claimed.error).toBeUndefined();
    expect(claimed.artifacts).toBeUndefined();
  });
});

describe("admin-jobs-store: status transitions", () => {
  test("markSucceeded stamps finishedAt, stores artifacts, and clears any prior error", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    const job = await store.enqueueProviderImportJob(buildRequest());
    clock.advance();
    await store.claimNextQueuedJob();

    clock.advance();
    const artifacts = {
      commit: "f".repeat(40),
      sourceManifestPath: "providers/en-US/abc/source-manifest.json",
      expandedFormsPath: "providers/en-US/abc/expanded.txt",
      guessPoolPath: "providers/en-US/abc/guess-pool.txt",
      answerPoolPath: "providers/en-US/abc/answer-pool.txt"
    };
    const succeeded = await store.markSucceeded(job.id, { artifacts });

    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.finishedAt).toBeTruthy();
    expect(succeeded.artifacts).toEqual(artifacts);
    expect(succeeded.error).toBeUndefined();
  });

  test("markFailed records error code and message and finalizes the job", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    const job = await store.enqueueProviderImportJob(buildRequest());
    clock.advance();
    await store.claimNextQueuedJob();

    clock.advance();
    const failed = await store.markFailed(job.id, {
      code: "CHECKSUM_MISMATCH",
      message: "DIC checksum did not match expected value"
    });

    expect(failed.status).toBe("failed");
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.error).toEqual({
      code: "CHECKSUM_MISMATCH",
      message: "DIC checksum did not match expected value"
    });
  });

  test("markFailed defaults to UNKNOWN_ERROR when no payload is supplied", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    const job = await store.enqueueProviderImportJob(buildRequest());
    await store.claimNextQueuedJob();

    const failed = await store.markFailed(job.id);

    expect(failed.error.code).toBe("UNKNOWN_ERROR");
    expect(failed.error.message).toBe("Import failed.");
  });

  test("markSucceeded and markFailed throw JOB_NOT_FOUND for unknown ids", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    const validArtifacts = {
      artifacts: {
        commit: "f".repeat(40),
        sourceManifestPath: "p/m.json",
        expandedFormsPath: "p/e.txt",
        guessPoolPath: "p/g.txt",
        answerPoolPath: "p/a.txt"
      }
    };
    await expect(store.markSucceeded("job-missing-1234", validArtifacts)).rejects.toMatchObject({
      code: "JOB_NOT_FOUND"
    });
    await expect(store.markFailed("job-missing-1234", { code: "X", message: "y" })).rejects.toMatchObject({
      code: "JOB_NOT_FOUND"
    });
  });
});

describe("admin-jobs-store: updateJobRequest", () => {
  test("merges the patch into the existing request when queued", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    const job = await store.enqueueProviderImportJob(buildRequest({ filterMode: "denylist-only" }));

    const updated = await store.updateJobRequest(job.id, { filterMode: "allowlist-required" });

    expect(updated.request.filterMode).toBe("allowlist-required");
    expect(updated.request.variant).toBe("en-US");
  });

  test("rejects updates once the job has left the queue", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    const job = await store.enqueueProviderImportJob(buildRequest());
    await store.claimNextQueuedJob();

    await expect(
      store.updateJobRequest(job.id, { filterMode: "allowlist-required" })
    ).rejects.toMatchObject({ code: "INVALID_JOB_STATE" });
  });

  test("rejects non-object patches and unknown ids", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    await store.enqueueProviderImportJob(buildRequest());

    await expect(store.updateJobRequest("any", null)).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(store.updateJobRequest("job-missing-1234", { variant: "en-GB" })).rejects.toMatchObject({
      code: "JOB_NOT_FOUND"
    });
  });
});

describe("admin-jobs-store: list and getById", () => {
  test("list returns newest jobs first and respects limit and status filters", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({ filePath, logger: silentLogger(), now: clock.now });

    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const job = await store.enqueueProviderImportJob(buildRequest({ variant: "en-US" }));
      ids.push(job.id);
      clock.advance();
    }
    await store.claimNextQueuedJob();
    clock.advance();
    await store.markSucceeded(ids[0], {
      artifacts: {
        commit: "f".repeat(40),
        sourceManifestPath: "p/m.json",
        expandedFormsPath: "p/e.txt",
        guessPoolPath: "p/g.txt",
        answerPoolPath: "p/a.txt"
      }
    });

    const recent = await store.list({ limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0].createdAt >= recent[1].createdAt).toBe(true);

    const succeeded = await store.list({ status: "succeeded" });
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].id).toBe(ids[0]);
  });

  test("getById returns a clone or null", async () => {
    const store = new AdminJobsStore({ filePath: tempFilePath(), logger: silentLogger() });
    const job = await store.enqueueProviderImportJob(buildRequest());

    const fetched = await store.getById(job.id);
    expect(fetched.id).toBe(job.id);
    fetched.status = "tampered";
    const refetched = await store.getById(job.id);
    expect(refetched.status).toBe("queued");

    expect(await store.getById("job-missing-1234")).toBeNull();
    expect(await store.getById("")).toBeNull();
  });
});

describe("admin-jobs-store: pruning", () => {
  test("prunes oldest completed jobs once maxJobs is exceeded but keeps queued and running", async () => {
    const filePath = tempFilePath();
    const clock = createClock();
    const store = new AdminJobsStore({
      filePath,
      logger: silentLogger(),
      now: clock.now,
      maxJobs: 3
    });

    const succeededArtifacts = {
      commit: "f".repeat(40),
      sourceManifestPath: "p/m.json",
      expandedFormsPath: "p/e.txt",
      guessPoolPath: "p/g.txt",
      answerPoolPath: "p/a.txt"
    };

    const succeededIds = [];
    for (let i = 0; i < 3; i += 1) {
      const job = await store.enqueueProviderImportJob(buildRequest());
      succeededIds.push(job.id);
      clock.advance();
      await store.claimNextQueuedJob();
      clock.advance();
      await store.markSucceeded(job.id, { artifacts: succeededArtifacts });
      clock.advance();
    }

    const running = await store.enqueueProviderImportJob(buildRequest({ variant: "en-GB" }));
    clock.advance();
    await store.claimNextQueuedJob();
    clock.advance();

    const queued = await store.enqueueProviderImportJob(buildRequest({ variant: "en-CA" }));
    clock.advance();

    const snapshot = await store.getSnapshot();
    expect(snapshot.jobs).toHaveLength(3);
    const statuses = snapshot.jobs.map((job) => job.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("queued");

    const ids = snapshot.jobs.map((job) => job.id);
    expect(ids).toContain(running.id);
    expect(ids).toContain(queued.id);

    const retainedSucceeded = snapshot.jobs.filter((job) => job.status === "succeeded");
    expect(retainedSucceeded).toHaveLength(1);
    const newestSucceededId = succeededIds[succeededIds.length - 1];
    expect(retainedSucceeded[0].id).toBe(newestSucceededId);
    expect(ids).not.toContain(succeededIds[0]);
    expect(ids).not.toContain(succeededIds[1]);
  });
});
