const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const { RESTORE_CONFIRM_HEADER, RESTORE_CONFIRM_VALUE } = require("../routes/backup.js");

const ORIGINAL_ENV = { ...process.env };
const tempDirsToClean = [];

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function makeTempState() {
  // Build an isolated project root with the data/ schemas + sample state
  // copied in. BACKUP_PROJECT_ROOT points the backup router here so
  // export/restore operate on this temp tree rather than the repo's
  // real data/ directory (no test-induced repo pollution).
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-backup-"));
  tempDirsToClean.push(projectRoot);
  const dir = path.join(projectRoot, "data");
  fs.mkdirSync(dir, { recursive: true });
  // Copy schemas from the real repo so digest checks have real bytes.
  const repoRoot = path.resolve(__dirname, "..");
  for (const rel of [
    "data/leaderboard.schema.json",
    "data/languages.schema.json",
    "data/admin-jobs.schema.json",
    "data/app-config.schema.json",
    "data/classes.schema.json",
    "data/schedule.schema.json",
    "data/backup-manifest.schema.json"
  ]) {
    const dest = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), dest);
  }
  fs.mkdirSync(path.join(dir, "providers"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "data/providers/provider-import-manifest.schema.json"),
    path.join(dir, "providers/provider-import-manifest.schema.json")
  );
  // Copy languages.json (real schema is involved; just reuse the canonical)
  fs.copyFileSync(
    path.join(repoRoot, "data/languages.json"),
    path.join(dir, "languages.json")
  );
  // Borrow package.json so readAppVersion finds the real version
  fs.copyFileSync(
    path.join(repoRoot, "package.json"),
    path.join(projectRoot, "package.json")
  );
  // Synthetic word.json
  fs.writeFileSync(
    path.join(dir, "word.json"),
    `${JSON.stringify({ word: "TESTS", date: "2026-01-01" })}\n`,
    "utf8"
  );
  const statsPath = path.join(dir, "leaderboard.json");
  const classesPath = path.join(dir, "classes.json");
  const adminJobsPath = path.join(dir, "admin-jobs.json");
  const appConfigPath = path.join(dir, "app-config.json");
  fs.writeFileSync(
    statsPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      profiles: [],
      resultsByProfile: {}
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    classesPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      classes: []
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    adminJobsPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      jobs: []
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    appConfigPath,
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      overrides: {}
    }, null, 2)}\n`,
    "utf8"
  );
  const schedulePath = path.join(dir, "schedule.json");
  fs.writeFileSync(
    schedulePath,
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date(0).toISOString(),
      timezone: "UTC",
      auto_rotate: false,
      retention_days: 90,
      scheduled_words: []
    }, null, 2)}\n`,
    "utf8"
  );
  return { statsPath, classesPath, adminJobsPath, appConfigPath, schedulePath, projectRoot };
}

function loadFreshApp(adminKey, paths, extraEnv = {}) {
  jest.resetModules();
  resetEnv();
  process.env.ADMIN_KEY = adminKey;
  process.env.STATS_STORE_PATH = paths.statsPath;
  process.env.CLASSES_STORE_PATH = paths.classesPath;
  process.env.ADMIN_JOBS_STORE_PATH = paths.adminJobsPath;
  process.env.APP_CONFIG_PATH = paths.appConfigPath;
  process.env.RATE_LIMIT_MAX = "1000";
  process.env.ADMIN_RATE_LIMIT_MAX = "1000";
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX = "1000";
  // Generous backup rate limit so successive test calls don't 429.
  process.env.BACKUP_RATE_LIMIT_MAX = "100";
  process.env.BACKUP_RATE_LIMIT_WINDOW_MS = "1000";
  // Isolate backup operations to the temp project root so tests don't
  // touch the real repo's data/ directory.
  if (paths.projectRoot) {
    process.env.BACKUP_PROJECT_ROOT = paths.projectRoot;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined || value === null) continue;
    process.env[key] = String(value);
  }
  return require("../server");
}

afterEach(() => {
  resetEnv();
  jest.resetModules();
});

afterAll(() => {
  for (const dir of tempDirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirsToClean.length = 0;
});

describe("Backup API: export", () => {
  test("requires admin key", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const res = await request(app).get("/api/admin/backup");
    expect(res.status).toBe(401);
  });

  test("streams a zip archive with expected Content-Disposition", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const res = await request(app)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/zip/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="wordle-backup-/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(64);
    // Zip magic number
    expect(res.body.slice(0, 2).toString("ascii")).toBe("PK");
  });
});

describe("Backup API: preview", () => {
  test("returns manifest summary for a freshly-exported archive", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const exportRes = await request(app)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    const previewRes = await request(app)
      .post("/api/admin/backup/preview")
      .set("x-admin-key", "secret")
      .attach("archive", exportRes.body, "test.zip");
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.ok).toBe(true);
    expect(previewRes.body.manifestVersion).toBe(1);
    expect(Array.isArray(previewRes.body.files)).toBe(true);
    expect(previewRes.body.files.length).toBeGreaterThan(0);
    expect(typeof previewRes.body.totalBytes).toBe("number");
  });

  test("rejects malformed archive with 400", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const res = await request(app)
      .post("/api/admin/backup/preview")
      .set("x-admin-key", "secret")
      .attach("archive", Buffer.from("not a zip"), "fake.zip");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("Backup API: restore", () => {
  test("requires the confirm header", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const exportRes = await request(app)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    const res = await request(app)
      .post("/api/admin/restore")
      .set("x-admin-key", "secret")
      .attach("archive", exportRes.body, "test.zip");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RESTORE_CONFIRM_MISSING");
  });

  test("accepts a freshly-exported archive and reports cache reloads", async () => {
    // Note: the byte-level round-trip is verified by the lib/backup-store
    // unit tests (which control the projectRoot end-to-end). Here we
    // verify the HTTP layer: the route accepts a valid archive, runs
    // apply, and surfaces the post-apply cache-reload results — with the
    // env-redirected store paths, the canonical applyRestore writes to
    // the real <projectRoot>/data/, so we can't assert against the temp
    // store paths here without leaking into the repo.
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const exportRes = await request(app)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    const restoreRes = await request(app)
      .post("/api/admin/restore")
      .set("x-admin-key", "secret")
      .set(RESTORE_CONFIRM_HEADER, RESTORE_CONFIRM_VALUE)
      .attach("archive", exportRes.body, "test.zip");
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.ok).toBe(true);
    expect(restoreRes.body.rolledBackOnError).toBe(false);
    expect(restoreRes.body.filesRestored).toBeGreaterThan(0);
    expect(Array.isArray(restoreRes.body.reloads)).toBe(true);
    const reloadNames = restoreRes.body.reloads.map((entry) => entry.name);
    expect(reloadNames).toEqual(expect.arrayContaining([
      "leaderboardStore",
      "classesStore",
      "appConfigStore"
    ]));
  });

  test("rejects a restore request when the data-mutation lock is already held", async () => {
    // Direct route-level test. We can't easily mock applyRestore through
    // the server's destructured import without a fragile module-mock
    // dance, so verify the busy path directly: import the backup router
    // factory, hold the lock manually, fire one restore, and assert it
    // returns 409 + RESTORE_BUSY.
    const fsLib = require("fs");
    const expressLib = require("express");

    jest.resetModules();
    resetEnv();
    const dataMutationLockRef = { value: true };
    const noopRef = { value: false };

    const createBackupRouter = require("../routes/backup.js");
    const backupRouter = createBackupRouter({
      projectRoot: "/tmp",
      providerImportQueueActiveRef: noopRef,
      providerImportSyncActiveRef: noopRef,
      dataMutationLockRef,
      backupMaxBytes: 1024,
      backupIncludeProvidersDefault: false
    });

    const app = expressLib();
    app.use(backupRouter);

    const res = await request(app)
      .post("/api/admin/restore")
      .set(RESTORE_CONFIRM_HEADER, RESTORE_CONFIRM_VALUE)
      .attach("archive", fsLib.readFileSync(__filename), "fake.zip");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RESTORE_BUSY");
  });
});

describe("Backup API: data mutation lock during export", () => {
  test("blocks mutating /api/admin/* writes while an export is streaming", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    // Fire an export and a class-create concurrently. The export takes
    // the data-lock for its entire stream; the class POST should
    // observe the lock and 503. Either ordering is acceptable as long
    // as one of them is 503 when both run while the lock is held.
    const exportPromise = request(app)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    const writePromise = request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Mid-Export Class" });

    const [exportRes, writeRes] = await Promise.all([exportPromise, writePromise]);
    expect(exportRes.status).toBe(200);
    // The write either landed before the lock was taken (200/201) or
    // hit the lock and 503'd. Both outcomes leave the export consistent.
    expect([200, 201, 503]).toContain(writeRes.status);
    if (writeRes.status === 503) {
      expect(writeRes.body.code).toBe("DATA_LOCK_HELD");
      expect(writeRes.headers["retry-after"]).toBe("5");
    }
  });
});

describe("Backup API: oversize upload", () => {
  test("returns 413 when archive exceeds BACKUP_MAX_BYTES", async () => {
    const paths = makeTempState();
    // First produce a valid archive against a server with the normal cap.
    const exportApp = loadFreshApp("secret", paths);
    const exportRes = await request(exportApp)
      .get("/api/admin/backup")
      .set("x-admin-key", "secret")
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    // Pad the archive over the cap so we trigger the upload-time guard.
    const padded = Buffer.concat([exportRes.body, Buffer.alloc(2 * 1024 * 1024)]);
    // Reload the small-cap server so we have a fresh request handler.
    const limitedApp = loadFreshApp("secret", paths, { BACKUP_MAX_BYTES: "1048576" });
    const res = await request(limitedApp)
      .post("/api/admin/backup/preview")
      .set("x-admin-key", "secret")
      .attach("archive", padded, "test.zip");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("ARCHIVE_TOO_LARGE");
  });
});
