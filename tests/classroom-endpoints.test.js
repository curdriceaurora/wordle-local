const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-classroom-"));
  tempDirsToClean.push(dir);
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
  return { statsPath, classesPath, adminJobsPath, appConfigPath };
}

function loadFreshApp(adminKey, paths) {
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
    } catch (_err) {
      // best effort
    }
  }
  tempDirsToClean.length = 0;
});

describe("Classes API: CRUD", () => {
  test("requires admin key for all class endpoints", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const list = await request(app).get("/api/admin/classes");
    expect(list.status).toBe(401);
    const create = await request(app).post("/api/admin/classes").send({ name: "X" });
    expect(create.status).toBe(401);
  });

  test("creates, lists, updates, archives, and deletes a class", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const created = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "  Period 1 Math  " });
    expect(created.status).toBe(201);
    expect(created.body.class.name).toBe("Period 1 Math");
    expect(created.body.class.archivedAt).toBeNull();
    const classId = created.body.class.id;

    const list = await request(app)
      .get("/api/admin/classes")
      .set("x-admin-key", "secret");
    expect(list.status).toBe(200);
    expect(list.body.classes).toHaveLength(1);
    expect(list.body.classes[0].memberCount).toBe(0);

    const renamed = await request(app)
      .patch(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({ name: "Math 101" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.class.name).toBe("Math 101");

    const archived = await request(app)
      .patch(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.class.archivedAt).toBeTruthy();

    // Default list excludes archived.
    const visibleAfterArchive = await request(app)
      .get("/api/admin/classes")
      .set("x-admin-key", "secret");
    expect(visibleAfterArchive.body.classes).toHaveLength(0);
    const allAfterArchive = await request(app)
      .get("/api/admin/classes?includeArchived=true")
      .set("x-admin-key", "secret");
    expect(allAfterArchive.body.classes).toHaveLength(1);

    const deleted = await request(app)
      .delete(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({ confirmed: true });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedClassId).toBe(classId);
  });

  test("rejects duplicate class names case-insensitively", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const first = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Section A" });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "section a" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already uses that name/);
  });

  test("delete requires confirmed=true", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const created = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Safe" });
    const classId = created.body.class.id;

    const noConfirm = await request(app)
      .delete(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({});
    expect(noConfirm.status).toBe(400);

    const ok = await request(app)
      .delete(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({ confirmed: true });
    expect(ok.status).toBe(200);
  });
});

describe("Classes API: bulk member add", () => {
  test("bulk-add resolves names to existing or new profiles, idempotent on rerun", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Algebra" });
    const classId = cls.body.class.id;

    // Pre-create one profile via /api/stats/profile so we can verify reuse.
    const ava = await request(app).post("/api/stats/profile").send({ name: "Ava" });
    expect(ava.status).toBe(200);
    const avaId = ava.body.playerId;

    const first = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Ava", "Ben", "Cal", "ben"] });
    expect(first.status).toBe(200);
    expect(first.body.classMemberCount).toBe(3);
    expect(first.body.reusedProfileIds).toContain(avaId);
    expect(first.body.createdProfileIds).toHaveLength(2);
    expect(first.body.addedToClass).toHaveLength(3);

    // Rerun the same roster — class membership should not grow.
    const second = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Ava", "Ben", "Cal"] });
    expect(second.status).toBe(200);
    expect(second.body.classMemberCount).toBe(3);
    expect(second.body.addedToClass).toEqual([]);
  });

  test("bulk-add accepts CSV input and rejects malformed CSV", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "CSV Class" });
    const classId = cls.body.class.id;

    // Quoted-but-simple, plus one with internal apostrophe (valid name char).
    const csv = "Alice\r\n\"Bob\"\r\n\"O'Hara\"\r\n";
    const ok = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ csv });
    expect(ok.status).toBe(200);
    expect(ok.body.classMemberCount).toBe(3);

    const bad = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ csv: "Alice,\"unbalanced" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/parsed/);
  });

  test("bulk-add to archived class is rejected with 409", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Old" });
    const classId = cls.body.class.id;
    await request(app)
      .patch(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret")
      .send({ archived: true });

    const result = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Alice"] });
    expect(result.status).toBe(409);
  });
});

describe("Classes API: delete carve-out", () => {
  test("deleteProfiles=true only removes profiles not present in any other non-archived class", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const a = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Class A" });
    const b = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Class B" });

    await request(app)
      .post(`/api/admin/classes/${a.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Shared", "OnlyInA"] });
    await request(app)
      .post(`/api/admin/classes/${b.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Shared", "OnlyInB"] });

    const deleted = await request(app)
      .delete(`/api/admin/classes/${a.body.class.id}`)
      .set("x-admin-key", "secret")
      .send({ confirmed: true, deleteProfiles: true });
    expect(deleted.status).toBe(200);
    // OnlyInA should be deleted; Shared remains because Class B (active) still references it.
    expect(deleted.body.deletedProfileIds).toHaveLength(1);

    // Confirm via leaderboard.
    const stored = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const names = stored.profiles.map((profile) => profile.name).sort();
    expect(names).toEqual(["OnlyInB", "Shared"]);
  });
});

describe("Classes API: report and CSV", () => {
  function todayLocalIso() {
    return new Date().toISOString().slice(0, 10);
  }

  test("returns JSON report aggregating per-day status", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Reporting" });
    const classId = cls.body.class.id;

    await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Ava", "Ben"] });

    const stats = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const ava = stats.profiles.find((p) => p.name === "Ava");
    expect(ava).toBeDefined();
    const today = todayLocalIso();
    await request(app).post("/api/stats/result").send({
      profileId: ava.id,
      dailyKey: `${today}|en|abcde`,
      won: true,
      attempts: 4,
      maxGuesses: 6
    });

    const report = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en`)
      .set("x-admin-key", "secret");
    expect(report.status).toBe(200);
    expect(report.body.from).toBe(today);
    expect(report.body.to).toBe(today);
    const avaRow = report.body.rows.find((row) => row.name === "Ava");
    expect(avaRow.days[0].status).toBe("won");
    expect(avaRow.days[0].attempts).toBe(4);
    const benRow = report.body.rows.find((row) => row.name === "Ben");
    expect(benRow.days[0].status).toBe("not-started");
  });

  test("returns CSV format with proper headers and BOM toggle", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "CSV Report" });
    const classId = cls.body.class.id;
    await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Alice"] });

    const today = todayLocalIso();
    const csvResponse = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en&format=csv&from=${today}&to=${today}`)
      .set("x-admin-key", "secret");
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers["content-type"]).toMatch(/text\/csv/);
    expect(csvResponse.headers["content-disposition"]).toMatch(/class-.*\.csv/);
    expect(csvResponse.text).toMatch(/profile_id,profile_name,lang,/);
    expect(csvResponse.text).toMatch(/Alice/);
    // No BOM by default.
    expect(csvResponse.text.charCodeAt(0)).not.toBe(0xfeff);

    const csvWithBom = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en&format=csv&bom=true`)
      .set("x-admin-key", "secret");
    expect(csvWithBom.status).toBe(200);
    expect(csvWithBom.text.charCodeAt(0)).toBe(0xfeff);
  });

  test("rejects out-of-bounds date range and missing lang", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Boundary" });
    const classId = cls.body.class.id;

    const noLang = await request(app)
      .get(`/api/admin/classes/${classId}/report`)
      .set("x-admin-key", "secret");
    expect(noLang.status).toBe(400);

    const unknownLang = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=zz`)
      .set("x-admin-key", "secret");
    expect(unknownLang.status).toBe(400);
    expect(unknownLang.body.error).toMatch(/not registered/);

    const badFrom = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en&from=not-a-date`)
      .set("x-admin-key", "secret");
    expect(badFrom.status).toBe(400);
    expect(badFrom.body.error).toMatch(/from/);

    const tooLong = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en&from=2026-01-01&to=2027-01-01`)
      .set("x-admin-key", "secret");
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/cap/);

    const inverted = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en&from=2026-02-10&to=2026-02-01`)
      .set("x-admin-key", "secret");
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toMatch(/before/);
  });
});

describe("Classes API: member removal", () => {
  test("removes a single member and reports updated count", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Remove Single" });
    const classId = cls.body.class.id;
    await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Ava", "Ben"] });

    const stats = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const ava = stats.profiles.find((p) => p.name === "Ava");

    const result = await request(app)
      .delete(`/api/admin/classes/${classId}/members/${ava.id}`)
      .set("x-admin-key", "secret");
    expect(result.status).toBe(200);
    expect(result.body.class.memberCount).toBe(1);

    const detail = await request(app)
      .get(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret");
    expect(detail.body.members.map((m) => m.name)).toEqual(["Ben"]);
  });

  test("returns 404 when removing a non-member", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);
    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Empty" });
    const classId = cls.body.class.id;
    const result = await request(app)
      .delete(`/api/admin/classes/${classId}/members/profile-missing`)
      .set("x-admin-key", "secret");
    expect(result.status).toBe(404);
  });
});
