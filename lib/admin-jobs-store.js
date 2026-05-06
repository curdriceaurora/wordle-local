const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_JOBS = 400;
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);
const JOB_ID_PATTERN = /^job-[a-f0-9-]{12,64}$/;
const JOB_STATUS_VALUES = new Set(["queued", "running", "succeeded", "failed", "canceled"]);

class AdminJobsStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AdminJobsStoreError";
    this.code = code;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createDefaultState() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function writeJsonAtomicSync(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) {
        throw renameErr;
      }
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_cleanupErr) {
      // Best effort cleanup.
    }
    throw new AdminJobsStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist admin jobs at ${filePath}.`,
      { cause: err }
    );
  }
}

function normalizeJob(rawJob) {
  if (!isObject(rawJob)) {
    return null;
  }

  const id = String(rawJob.id || "").trim();
  if (!JOB_ID_PATTERN.test(id)) {
    return null;
  }

  const type = String(rawJob.type || "").trim();
  if (type !== "provider-import") {
    return null;
  }

  const status = String(rawJob.status || "").trim();
  if (!JOB_STATUS_VALUES.has(status)) {
    return null;
  }

  const attempts = Number(rawJob.attempts);
  const maxAttempts = Number(rawJob.maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 0) {
    return null;
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    return null;
  }

  const requestedBy = String(rawJob.requestedBy || "").trim();
  if (!requestedBy) {
    return null;
  }

  const createdAt = String(rawJob.createdAt || "").trim();
  const updatedAt = String(rawJob.updatedAt || "").trim();
  if (!createdAt || !updatedAt) {
    return null;
  }

  if (!isObject(rawJob.request)) {
    return null;
  }

  const normalized = {
    id,
    type,
    status,
    attempts,
    maxAttempts,
    requestedBy,
    createdAt,
    updatedAt,
    startedAt: rawJob.startedAt || null,
    finishedAt: rawJob.finishedAt || null,
    request: clone(rawJob.request)
  };

  if (isObject(rawJob.artifacts)) {
    normalized.artifacts = clone(rawJob.artifacts);
  }
  if (isObject(rawJob.error)) {
    normalized.error = {
      code: String(rawJob.error.code || "").trim() || "UNKNOWN_ERROR",
      message: String(rawJob.error.message || "").trim() || "Import failed."
    };
  }

  return normalized;
}

function normalizeState(rawState, logger) {
  const fallback = createDefaultState();
  if (!isObject(rawState) || rawState.version !== SCHEMA_VERSION || !Array.isArray(rawState.jobs)) {
    logger.warn("Admin jobs file was invalid and has been reset.");
    return fallback;
  }

  const jobs = [];
  for (const entry of rawState.jobs) {
    const normalizedJob = normalizeJob(entry);
    if (!normalizedJob) {
      logger.warn("Admin jobs file contained invalid entries and was normalized.");
      continue;
    }
    jobs.push(normalizedJob);
  }

  jobs.sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });

  return {
    version: SCHEMA_VERSION,
    updatedAt: String(rawState.updatedAt || fallback.updatedAt),
    jobs
  };
}

class AdminJobsStore {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(__dirname, "..", "data", "admin-jobs.json"));
    this.maxJobs = Number.isInteger(options.maxJobs) && options.maxJobs > 0
      ? options.maxJobs
      : DEFAULT_MAX_JOBS;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }

    let state;
    if (!fs.existsSync(this.filePath)) {
      state = createDefaultState();
      writeJsonAtomicSync(this.filePath, state);
    } else {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        state = normalizeState(parsed, this.logger);
      } catch (err) {
        this.logger.warn("Admin jobs file is invalid JSON and has been reset.");
        state = createDefaultState();
      }
      writeJsonAtomicSync(this.filePath, state);
    }

    this.state = state;
    return clone(this.state);
  }

  async getSnapshot() {
    await this.load();
    return clone(this.state);
  }

  async list(options = {}) {
    await this.load();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
    const status = options.status ? String(options.status).trim() : "";

    const rows = this.state.jobs
      .filter((job) => !status || job.status === status)
      .slice()
      .sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.id.localeCompare(right.id);
        }
        return left.createdAt > right.createdAt ? -1 : 1;
      })
      .slice(0, limit);

    return clone(rows);
  }

  async getById(jobId) {
    await this.load();
    const normalizedId = String(jobId || "").trim();
    if (!normalizedId) {
      return null;
    }
    const found = this.state.jobs.find((job) => job.id === normalizedId);
    return found ? clone(found) : null;
  }

  async enqueueProviderImportJob(request, options = {}) {
    if (!isObject(request)) {
      throw new AdminJobsStoreError("INVALID_REQUEST", "request must be an object.");
    }

    const requestedBy = String(options.requestedBy || "admin").trim() || "admin";
    const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
      ? options.maxAttempts
      : 1;

    return this.#enqueueWrite(async () => {
      const nowIso = this.now().toISOString();
      const job = {
        id: `job-${nodeCrypto.randomUUID()}`,
        type: "provider-import",
        status: "queued",
        attempts: 0,
        maxAttempts,
        requestedBy,
        createdAt: nowIso,
        updatedAt: nowIso,
        startedAt: null,
        finishedAt: null,
        request: clone(request)
      };
      this.state.jobs.push(job);
      this.#pruneCompletedIfNeeded();
      await this.#persist();
      return clone(job);
    });
  }

  async recoverRunningJobs() {
    return this.#enqueueWrite(async () => {
      let mutated = false;
      const nowIso = this.now().toISOString();
      this.state.jobs.forEach((job) => {
        if (job.status === "running") {
          job.status = "queued";
          job.startedAt = null;
          job.finishedAt = null;
          job.updatedAt = nowIso;
          mutated = true;
        }
      });
      if (mutated) {
        await this.#persist();
      }
      return mutated;
    });
  }

  async claimNextQueuedJob() {
    return this.#enqueueWrite(async () => {
      const queued = this.state.jobs
        .filter((job) => job.status === "queued")
        .sort((left, right) => {
          if (left.createdAt === right.createdAt) {
            return left.id.localeCompare(right.id);
          }
          return left.createdAt.localeCompare(right.createdAt);
        })[0];

      if (!queued) {
        return null;
      }

      const nowIso = this.now().toISOString();
      queued.status = "running";
      queued.attempts += 1;
      queued.startedAt = nowIso;
      queued.finishedAt = null;
      queued.updatedAt = nowIso;
      delete queued.error;
      delete queued.artifacts;
      await this.#persist();
      return clone(queued);
    });
  }

  async markSucceeded(jobId, payload = {}) {
    return this.#enqueueWrite(async () => {
      const job = this.#requireJob(jobId);
      const nowIso = this.now().toISOString();
      job.status = "succeeded";
      job.updatedAt = nowIso;
      job.finishedAt = nowIso;
      if (isObject(payload.artifacts)) {
        job.artifacts = clone(payload.artifacts);
      }
      delete job.error;
      await this.#persist();
      return clone(job);
    });
  }

  async markFailed(jobId, error) {
    return this.#enqueueWrite(async () => {
      const job = this.#requireJob(jobId);
      const nowIso = this.now().toISOString();
      job.status = "failed";
      job.updatedAt = nowIso;
      job.finishedAt = nowIso;
      job.error = {
        code: String(error?.code || "UNKNOWN_ERROR").trim() || "UNKNOWN_ERROR",
        message: String(error?.message || "Import failed.").trim() || "Import failed."
      };
      await this.#persist();
      return clone(job);
    });
  }

  async updateJobRequest(jobId, patch) {
    if (!isObject(patch)) {
      throw new AdminJobsStoreError("INVALID_REQUEST", "patch must be an object.");
    }

    return this.#enqueueWrite(async () => {
      const job = this.#requireJob(jobId);
      if (job.status !== "queued") {
        throw new AdminJobsStoreError("INVALID_JOB_STATE", "Only queued jobs can be updated.");
      }
      job.request = {
        ...job.request,
        ...clone(patch)
      };
      job.updatedAt = this.now().toISOString();
      await this.#persist();
      return clone(job);
    });
  }

  #requireJob(jobId) {
    const normalizedId = String(jobId || "").trim();
    const job = this.state.jobs.find((entry) => entry.id === normalizedId);
    if (!job) {
      throw new AdminJobsStoreError("JOB_NOT_FOUND", "Job was not found.");
    }
    return job;
  }

  async #enqueueWrite(operation) {
    await this.load();
    const run = async () => operation();
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  #pruneCompletedIfNeeded() {
    if (this.state.jobs.length <= this.maxJobs) {
      return;
    }

    const completedIndexes = [];
    this.state.jobs.forEach((job, index) => {
      if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
        completedIndexes.push(index);
      }
    });

    while (this.state.jobs.length > this.maxJobs && completedIndexes.length > 0) {
      const removeIndex = completedIndexes.shift();
      this.state.jobs.splice(removeIndex, 1);
      for (let i = 0; i < completedIndexes.length; i += 1) {
        if (completedIndexes[i] > removeIndex) {
          completedIndexes[i] -= 1;
        }
      }
    }
  }

  async #persist() {
    this.state.updatedAt = this.now().toISOString();
    writeJsonAtomicSync(this.filePath, this.state);
  }
}

module.exports = {
  AdminJobsStore,
  AdminJobsStoreError,
  createDefaultState
};
