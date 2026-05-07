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

    // Non-delimiter character after a quoted field closes — must reject
    // rather than concatenating.
    const trailing = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ csv: "\"Carol\"x\r\n" });
    expect(trailing.status).toBe(400);
    expect(trailing.body.parseErrors[0].message).toMatch(/closing quote/);

    // Size-limit breach via CSV must surface as 413, matching the array
    // path — clients shouldn't have to inspect parseErrors to tell
    // "too large" from a true CSV syntax error.
    const lines = [];
    for (let i = 0; i < 600; i += 1) {
      lines.push(`Name${i}`);
    }
    const oversize = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ csv: `${lines.join("\r\n")}\r\n` });
    expect(oversize.status).toBe(413);
    expect(oversize.body.error).toMatch(/exceeded/);
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
    // Match the server's getLocalDateString helper (server-local calendar
    // date) so the report endpoint sees the same today value the test does
    // around UTC day boundaries.
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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

  test("missing-profile rows include the same aggregate fields as normal rows", async () => {
    const paths = makeTempState();

    // Pre-populate the classes file with a record that references a profile
    // id that doesn't exist in the leaderboard. The report endpoint should
    // surface this row as missing while preserving the same shape as
    // present rows (stable schema for JSON consumers).
    const ghostId = "profile-ghost-deadbeef";
    const classId = "class-aaaabbbbccccdddd";
    fs.writeFileSync(paths.classesPath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      classes: [
        {
          id: classId,
          name: "Schema Consistency",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          memberProfileIds: [ghostId]
        }
      ]
    }));

    const app = loadFreshApp("secret", paths);

    const report = await request(app)
      .get(`/api/admin/classes/${classId}/report?lang=en`)
      .set("x-admin-key", "secret");
    expect(report.status).toBe(200);

    const ghostRow = report.body.rows.find((row) => row.profileId === ghostId);
    expect(ghostRow).toBeDefined();
    expect(ghostRow.missing).toBe(true);
    // Aggregate keys must exist (even as 0/null) so JSON consumers see a
    // stable schema across missing and present rows.
    expect(ghostRow).toHaveProperty("wins", 0);
    expect(ghostRow).toHaveProperty("playedCount", 0);
    expect(ghostRow).toHaveProperty("winRate", null);
    expect(ghostRow).toHaveProperty("lastPlayedAt", null);
    expect(Array.isArray(ghostRow.days)).toBe(true);
    expect(ghostRow.days.every((day) => day.status === "no-profile")).toBe(true);
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

describe("Classes API: idempotent re-upload at capacity", () => {
  test("re-uploading the same roster at the per-class cap returns ok, not 409", async () => {
    const paths = makeTempState();
    // Configure the per-class cap to match the roster size so the first
    // upload puts the class exactly at the cap and the second upload is
    // a true re-upload of an at-cap roster.
    const app = loadFreshApp("secret", paths, {
      LEADERBOARD_MAX_PROFILES: "20",
      CLASSES_MAX_MEMBERS_PER_CLASS: "4"
    });

    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Capped" });
    const classId = cls.body.class.id;

    const names = ["Alice", "Bob", "Carol", "Dan"];
    const first = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names });
    expect(first.status).toBe(200);
    expect(first.body.classMemberCount).toBe(4);

    // Adding even one more name now must 409 — the class is at its cap.
    const overflow = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Eve"] });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toMatch(/per-class member cap/);

    // Re-uploading the SAME roster must not 409 even when the class is at
    // its cap — counting only net-new members.
    const second = await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names });
    expect(second.status).toBe(200);
    expect(second.body.classMemberCount).toBe(4);
    expect(second.body.addedToClass).toEqual([]);
  });

  test("rejects bulk-add with 409 when it would exceed host profile cap", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths, { LEADERBOARD_MAX_PROFILES: "5" });

    const a = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "First Cohort" });
    const aClassId = a.body.class.id;
    const fillRoster = await request(app)
      .post(`/api/admin/classes/${aClassId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Una", "Doi", "Tre", "Pat", "Cin"] });
    expect(fillRoster.status).toBe(200);
    expect(fillRoster.body.classMemberCount).toBe(5);

    const b = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Second Cohort" });
    const bClassId = b.body.class.id;
    const overflow = await request(app)
      .post(`/api/admin/classes/${bClassId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Sex", "Sept"] });
    expect(overflow.status).toBe(409);
    expect(overflow.body.error).toMatch(/host profile cap/);

    // The host stays at 5 — older profiles are NOT pruned to make room.
    const stored = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    expect(stored.profiles).toHaveLength(5);
    expect(stored.profiles.map((p) => p.name).sort()).toEqual(
      ["Cin", "Doi", "Pat", "Tre", "Una"]
    );

    // The First Cohort roster is intact — no member dropped to make room.
    const aDetail = await request(app)
      .get(`/api/admin/classes/${aClassId}`)
      .set("x-admin-key", "secret");
    expect(aDetail.body.members).toHaveLength(5);
  });
});

describe("Classes API: public profile creation cleanup", () => {
  test("non-admin /api/stats/profile reconciles classes when cap-pruning a class member", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths, { LEADERBOARD_MAX_PROFILES: "3" });

    // Create a class with three members to fill all host profile slots.
    const cls = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Cap Cohort" });
    const classId = cls.body.class.id;
    await request(app)
      .post(`/api/admin/classes/${classId}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Alpha", "Beta", "Gamma"] });

    const initial = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    expect(initial.profiles).toHaveLength(3);
    const initialIds = new Set(initial.profiles.map((p) => p.id));
    const initialNames = new Set(initial.profiles.map((p) => p.name));
    expect(initialNames).toEqual(new Set(["Alpha", "Beta", "Gamma"]));

    // Non-admin path: creating a 4th profile must evict one of the three
    // existing class members. The post-mutate reconciliation in
    // /api/stats/profile is responsible for dropping the dangling
    // reference in the class so detail/report don't surface a "(missing
    // profile)" row.
    const created = await request(app)
      .post("/api/stats/profile")
      .send({ name: "Public" });
    expect(created.status).toBe(200);

    const after = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    expect(after.profiles).toHaveLength(3);
    const afterIds = new Set(after.profiles.map((p) => p.id));
    expect(after.profiles.map((p) => p.name)).toContain("Public");

    // Exactly one of the original three IDs should have been evicted.
    const survivingFromOriginal = [...initialIds].filter((id) => afterIds.has(id));
    expect(survivingFromOriginal).toHaveLength(2);

    // The class roster should now only reference the surviving original
    // members — the evicted one is gone from the membership list.
    const detail = await request(app)
      .get(`/api/admin/classes/${classId}`)
      .set("x-admin-key", "secret");
    expect(detail.status).toBe(200);
    const memberIds = detail.body.members.map((m) => m.profileId);
    expect(memberIds.sort()).toEqual([...survivingFromOriginal].sort());
    // No "(missing profile)" rows — every member resolves.
    expect(detail.body.members.every((m) => m.name)).toBe(true);
  });
});

describe("Classes API: profile delete + merge cleanup", () => {
  test("deleting a profile pulls it out of every class membership", async () => {
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
      .send({ names: ["Ava", "Ben"] });
    await request(app)
      .post(`/api/admin/classes/${b.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Ava"] });

    const stored = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const ava = stored.profiles.find((p) => p.name === "Ava");

    const deleted = await request(app)
      .delete(`/api/admin/stats/profile/${ava.id}`)
      .set("x-admin-key", "secret")
      .send({ confirmed: true, confirmName: "Ava" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.classCleanupTouched).toBe(2);

    const aDetail = await request(app)
      .get(`/api/admin/classes/${a.body.class.id}`)
      .set("x-admin-key", "secret");
    expect(aDetail.body.members.map((m) => m.name)).toEqual(["Ben"]);
    const bDetail = await request(app)
      .get(`/api/admin/classes/${b.body.class.id}`)
      .set("x-admin-key", "secret");
    expect(bDetail.body.members).toEqual([]);
  });

  test("merging profiles transfers source memberships to target with dedup", async () => {
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
    // Source in A only, target in B only — source membership should
    // move to target after merge.
    await request(app)
      .post(`/api/admin/classes/${a.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Source"] });
    await request(app)
      .post(`/api/admin/classes/${b.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Target"] });

    const stored = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const source = stored.profiles.find((p) => p.name === "Source");
    const target = stored.profiles.find((p) => p.name === "Target");

    const merged = await request(app)
      .post(`/api/admin/stats/profile/${source.id}/merge`)
      .set("x-admin-key", "secret")
      .send({ targetProfileId: target.id, confirmed: true });
    expect(merged.status).toBe(200);
    expect(merged.body.classMembershipsTransferred).toEqual([a.body.class.id]);

    const aDetail = await request(app)
      .get(`/api/admin/classes/${a.body.class.id}`)
      .set("x-admin-key", "secret");
    expect(aDetail.body.members.map((m) => m.name)).toEqual(["Target"]);
    const bDetail = await request(app)
      .get(`/api/admin/classes/${b.body.class.id}`)
      .set("x-admin-key", "secret");
    expect(bDetail.body.members.map((m) => m.name)).toEqual(["Target"]);
  });

  test("merge dedupes when target already a member of the source's class", async () => {
    const paths = makeTempState();
    const app = loadFreshApp("secret", paths);

    const a = await request(app)
      .post("/api/admin/classes")
      .set("x-admin-key", "secret")
      .send({ name: "Class A" });
    await request(app)
      .post(`/api/admin/classes/${a.body.class.id}/members/bulk`)
      .set("x-admin-key", "secret")
      .send({ names: ["Source", "Target"] });

    const stored = JSON.parse(fs.readFileSync(paths.statsPath, "utf8"));
    const source = stored.profiles.find((p) => p.name === "Source");
    const target = stored.profiles.find((p) => p.name === "Target");

    const merged = await request(app)
      .post(`/api/admin/stats/profile/${source.id}/merge`)
      .set("x-admin-key", "secret")
      .send({ targetProfileId: target.id, confirmed: true });
    expect(merged.status).toBe(200);

    const aDetail = await request(app)
      .get(`/api/admin/classes/${a.body.class.id}`)
      .set("x-admin-key", "secret");
    // Source dropped, target retained — no duplicate.
    expect(aDetail.body.members.map((m) => m.name)).toEqual(["Target"]);
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
