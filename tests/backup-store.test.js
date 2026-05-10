const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");

const {
  BackupError,
  MANIFEST_VERSION,
  IN_SCOPE_FILES,
  buildManifest,
  createArchive,
  validateArchive,
  applyRestore,
  findOrphanedRestoreDirs,
  isPathSafe,
  sha256OfBuffer
} = require("../lib/backup-store.js");

// Each test gets its own temp project root populated with a minimal data/
// tree. Schemas are copied from the real repo so schema-digest checks have
// real bytes to hash; data files are tiny but schema-valid.

const REPO_ROOT = path.resolve(__dirname, "..");

async function copyFileFromRepo(rel, destProjectRoot) {
  const src = path.join(REPO_ROOT, rel);
  const dest = path.join(destProjectRoot, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

async function makeProjectRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-store-"));
  await fsp.mkdir(path.join(dir, "data"), { recursive: true });
  // Copy schemas (these get bundled in the archive and used for validation)
  for (const rel of [
    "data/leaderboard.schema.json",
    "data/languages.schema.json",
    "data/admin-jobs.schema.json",
    "data/app-config.schema.json",
    "data/classes.schema.json",
    "data/schedule.schema.json",
    "data/webhooks.schema.json",
    "data/webhook-deliveries.schema.json",
    "data/push-subscriptions.schema.json",
    "data/challenges.schema.json",
    "data/challenge-results.schema.json",
    "data/backup-manifest.schema.json"
  ]) {
    await copyFileFromRepo(rel, dir);
  }
  await fsp.mkdir(path.join(dir, "data", "providers"), { recursive: true });
  await copyFileFromRepo("data/providers/provider-import-manifest.schema.json", dir);
  // Minimal package.json so readAppVersion finds something
  await fsp.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "test-app", version: "0.0.0-test" })}\n`,
    "utf8"
  );
  // Schema-valid data files (only what each schema requires)
  await fsp.writeFile(
    path.join(dir, "data", "leaderboard.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      profiles: [],
      resultsByProfile: {}
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "admin-jobs.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      jobs: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "app-config.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      overrides: {}
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "classes.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      classes: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "schedule.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      timezone: "UTC",
      auto_rotate: false,
      retention_days: 90,
      scheduled_words: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "webhooks.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      subscriptions: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "webhook-deliveries.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deliveries: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "push-subscriptions.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastBroadcastAt: null,
      lastDailyFireAt: null,
      subscriptions: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "challenges.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      challenges: []
    }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "challenge-results.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessions: []
    }, null, 2)}\n`,
    "utf8"
  );
  // Borrow real languages.json — its schema is more involved
  await copyFileFromRepo("data/languages.json", dir);
  // Optional: word.json — schema-less, can be anything
  await fsp.writeFile(
    path.join(dir, "data", "word.json"),
    `${JSON.stringify({ word: "TESTS", date: "2026-01-01" })}\n`,
    "utf8"
  );
  return dir;
}

const tempRoots = [];
async function tempProject() {
  const dir = await makeProjectRoot();
  tempRoots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempRoots) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function exportArchiveToFile(projectRoot, options = {}) {
  const { archive } = createArchive({ projectRoot, ...options });
  const buf = await streamToBuffer(archive);
  const archivePath = path.join(projectRoot, `archive-${nodeCrypto.randomBytes(4).toString("hex")}.zip`);
  await fsp.writeFile(archivePath, buf);
  return { archivePath, bytes: buf.length };
}

describe("isPathSafe", () => {
  test.each([
    ["data/leaderboard.json", true],
    ["data/providers/en-US/abc/file.txt", true],
    ["manifest.json", true],
    ["", false],
    ["../etc/passwd", false],
    ["data/../../etc/passwd", false],
    ["/etc/passwd", false],
    ["data\\windows\\bad", false],
    ["data//double-slash", false],
    ["data/has spaces.json", false]
  ])("isPathSafe(%j) === %j", (input, expected) => {
    expect(isPathSafe(input)).toBe(expected);
  });
});

describe("sha256OfBuffer", () => {
  test("matches known vector for empty buffer", () => {
    expect(sha256OfBuffer(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("buildManifest", () => {
  test("includes every existing in-scope file with correct sha256 and bytes", async () => {
    const projectRoot = await tempProject();
    const manifest = await buildManifest({
      projectRoot,
      includeProviders: false,
      includeDictionaries: false
    });
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(manifest.appVersion).toBe("0.0.0-test");
    expect(manifest.optionalSets).toEqual([]);
    const inScopeEntries = manifest.files.filter((f) => IN_SCOPE_FILES.includes(f.path));
    // word.json + leaderboard + admin-jobs + app-config + classes + languages = 6
    expect(inScopeEntries).toHaveLength(IN_SCOPE_FILES.length);
    for (const entry of inScopeEntries) {
      const buf = await fsp.readFile(path.join(projectRoot, entry.path));
      expect(entry.bytes).toBe(buf.length);
      expect(entry.sha256).toBe(sha256OfBuffer(buf));
    }
  });

  test("includeProviders does not duplicate the diagnostic provider-import-manifest schema", async () => {
    const projectRoot = await tempProject();
    // Add a provider artifact alongside the schema that's already present
    // under data/providers/. Without dedup the diagnostic schema would
    // appear twice in the manifest (once as DIAGNOSTIC, once via the
    // providers walk), and restore would conflict on the staging path.
    const providerDir = path.join(projectRoot, "data/providers/en-US/abc123");
    await fsp.mkdir(providerDir, { recursive: true });
    await fsp.writeFile(path.join(providerDir, "en_US.dic"), "1\nWORLD\n", "utf8");
    const manifest = await buildManifest({
      projectRoot,
      includeProviders: true,
      includeDictionaries: false
    });
    const counts = new Map();
    for (const entry of manifest.files) {
      counts.set(entry.path, (counts.get(entry.path) || 0) + 1);
    }
    for (const [archivePath, count] of counts) {
      expect({ archivePath, count }).toEqual({ archivePath, count: 1 });
    }
    // The provider artifact is included with the providers tag;
    // the diagnostic schema is not double-tagged.
    const providerEntry = manifest.files.find(
      (entry) => entry.path === "data/providers/en-US/abc123/en_US.dic"
    );
    expect(providerEntry).toBeDefined();
    expect(providerEntry.optionalSet).toBe("providers");
    const schemaEntry = manifest.files.find(
      (entry) => entry.path === "data/providers/provider-import-manifest.schema.json"
    );
    expect(schemaEntry).toBeDefined();
    expect(schemaEntry.optionalSet).toBeUndefined();
  });

  test("attaches schema digest for files that have a schema", async () => {
    const projectRoot = await tempProject();
    const manifest = await buildManifest({
      projectRoot,
      includeProviders: false,
      includeDictionaries: false
    });
    const leaderboardEntry = manifest.files.find((f) => f.path === "data/leaderboard.json");
    expect(leaderboardEntry.schema).toBeDefined();
    expect(leaderboardEntry.schema.schemaPath).toBe("data/leaderboard.schema.json");
    expect(leaderboardEntry.schema.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createArchive + validateArchive round-trip", () => {
  test("happy path round-trip validates", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);
    const result = await validateArchive(archivePath, { projectRoot });
    expect(result.manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(result.fileChecks.every((entry) => entry.ok)).toBe(true);
  });
});

describe("validateArchive rejection cases", () => {
  test("rejects archive whose manifest version is unsupported", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);
    // Tamper: rebuild the zip with a manifest claiming version 999.
    const yauzl = require("yauzl");
    const archiver = require("archiver");
    const tamperedPath = `${archivePath}.tampered`;

    // Read all entries from the original.
    const entries = await new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on("entry", (entry) => {
          zip.openReadStream(entry, (e, rs) => {
            if (e) return reject(e);
            const chunks = [];
            rs.on("data", (c) => chunks.push(c));
            rs.on("end", () => {
              out.push({ name: entry.fileName, buf: Buffer.concat(chunks) });
              zip.readEntry();
            });
            rs.on("error", reject);
          });
        });
        zip.on("end", () => {
          zip.close();
          resolve(out);
        });
        zip.readEntry();
      });
    });

    const archive = archiver("zip");
    const out = fs.createWriteStream(tamperedPath);
    archive.pipe(out);
    for (const entry of entries) {
      if (entry.name === "manifest.json") {
        const manifest = JSON.parse(entry.buf.toString("utf8"));
        manifest.manifestVersion = 999;
        archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" });
      } else {
        archive.append(entry.buf, { name: entry.name });
      }
    }
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    await expect(
      validateArchive(tamperedPath, { projectRoot })
    ).rejects.toMatchObject({
      code: "MANIFEST_VERSION_UNSUPPORTED",
      details: expect.objectContaining({ expected: 1, got: 999 })
    });
  });

  test("rejects archive whose declared sha256 differs from entry bytes", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);
    // Tamper: rebuild zip with a leaderboard.json whose contents are
    // changed but the manifest still has the original sha256.
    const yauzl = require("yauzl");
    const archiver = require("archiver");
    const tamperedPath = `${archivePath}.tampered2`;
    const entries = await new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on("entry", (entry) => {
          zip.openReadStream(entry, (e, rs) => {
            if (e) return reject(e);
            const chunks = [];
            rs.on("data", (c) => chunks.push(c));
            rs.on("end", () => {
              out.push({ name: entry.fileName, buf: Buffer.concat(chunks) });
              zip.readEntry();
            });
            rs.on("error", reject);
          });
        });
        zip.on("end", () => {
          zip.close();
          resolve(out);
        });
        zip.readEntry();
      });
    });
    const archive = archiver("zip");
    const out = fs.createWriteStream(tamperedPath);
    archive.pipe(out);
    for (const entry of entries) {
      if (entry.name === "data/leaderboard.json") {
        // Pad the bytes — same length, different content
        const altered = Buffer.from(
          entry.buf.toString("utf8").replace("\"profiles\":", "\"profiles\":  ")
        );
        archive.append(altered, { name: entry.name });
      } else {
        archive.append(entry.buf, { name: entry.name });
      }
    }
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));
    await expect(
      validateArchive(tamperedPath, { projectRoot })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/SHA256_MISMATCH|BYTES_MISMATCH/)
    });
  });

  test("rejects archive that contains a path-traversal entry", async () => {
    // Defense in depth: even when the archive itself contains a malicious
    // entry path, the validator must reject before any extraction.
    // archiver sanitizes ".." on the way in, so the check that ultimately
    // fires here is the manifest/entry-set mismatch (the manifest claims
    // a path the archive doesn't actually carry under that name). The
    // pure isPathSafe unit tests above cover the post-yauzl path-safety
    // check directly.
    const projectRoot = await tempProject();
    const archiver = require("archiver");
    const archivePath = path.join(projectRoot, "evil.zip");
    const archive = archiver("zip");
    const out = fs.createWriteStream(archivePath);
    archive.pipe(out);
    archive.append(JSON.stringify({
      manifestVersion: 1,
      appVersion: "0.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      nodeId: "evil",
      files: [
        {
          path: "../etc/passwd",
          bytes: 4,
          sha256: sha256OfBuffer(Buffer.from("evil"))
        }
      ],
      optionalSets: []
    }, null, 2), { name: "manifest.json" });
    archive.append(Buffer.from("evil"), { name: "../etc/passwd" });
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    await expect(
      validateArchive(archivePath, { projectRoot })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/MANIFEST_INVALID|MANIFEST_MISMATCH|PATH_UNSAFE|ENTRY_MISSING/)
    });
  });

  test("rejects archive whose total uncompressed size exceeds totalMaxBytes", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);
    await expect(
      validateArchive(archivePath, { projectRoot, totalMaxBytes: 16 })
    ).rejects.toMatchObject({
      code: "ARCHIVE_TOO_LARGE"
    });
  });
});

describe("validateArchive security guards", () => {
  test("rejects manifest with optionalSet entry outside the allowed prefix", async () => {
    const projectRoot = await tempProject();
    const archiver = require("archiver");
    const archivePath = path.join(projectRoot, "evil-optional.zip");
    const archive = archiver("zip");
    const out = fs.createWriteStream(archivePath);
    archive.pipe(out);
    const evilBytes = Buffer.from("evil");
    archive.append(JSON.stringify({
      manifestVersion: 1,
      appVersion: "0.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      nodeId: "evil",
      files: [
        {
          path: "server.js",
          bytes: evilBytes.length,
          sha256: sha256OfBuffer(evilBytes),
          optionalSet: "providers"
        }
      ],
      optionalSets: ["providers"]
    }, null, 2), { name: "manifest.json" });
    archive.append(evilBytes, { name: "server.js" });
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    await expect(
      validateArchive(archivePath, { projectRoot })
    ).rejects.toMatchObject({
      code: "OPTIONAL_SET_PATH_INVALID"
    });
  });

  test("rejects archive with duplicate paths", async () => {
    const projectRoot = await tempProject();
    const archiver = require("archiver");
    const archivePath = path.join(projectRoot, "dup.zip");
    const archive = archiver("zip");
    const out = fs.createWriteStream(archivePath);
    archive.pipe(out);
    const buf = Buffer.from("{}");
    archive.append(JSON.stringify({
      manifestVersion: 1,
      appVersion: "0.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      nodeId: "dup",
      files: [
        { path: "data/word.json", bytes: buf.length, sha256: sha256OfBuffer(buf) },
        { path: "data/word.json", bytes: buf.length, sha256: sha256OfBuffer(buf) }
      ],
      optionalSets: []
    }, null, 2), { name: "manifest.json" });
    archive.append(buf, { name: "data/word.json" });
    archive.append(buf, { name: "data/word.json" });
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    await expect(
      validateArchive(archivePath, { projectRoot })
    ).rejects.toMatchObject({
      code: "MANIFEST_DUPLICATE_PATH"
    });
  });

  test("ignores explicit directory entries instead of rejecting them", async () => {
    const projectRoot = await tempProject();
    const archiver = require("archiver");
    const archivePath = path.join(projectRoot, "with-dirs.zip");
    const archive = archiver("zip");
    const out = fs.createWriteStream(archivePath);
    archive.pipe(out);
    // Build a normal manifest from the project, then append a stray
    // directory entry to the archive to verify it doesn't break validation.
    const manifest = await buildManifest({
      projectRoot,
      includeProviders: false,
      includeDictionaries: false
    });
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: "manifest.json" });
    for (const entry of manifest.files) {
      archive.file(path.join(projectRoot, entry.path), { name: entry.path });
    }
    archive.append("", { name: "data/providers/" });
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    const result = await validateArchive(archivePath, { projectRoot });
    expect(result.manifest.manifestVersion).toBe(1);
  });
});

describe("applyRestore happy path", () => {
  test("replaces in-scope files byte-equal to archive contents", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);

    const beforeLeaderboard = await fsp.readFile(
      path.join(projectRoot, "data/leaderboard.json"),
      "utf8"
    );

    // Mutate the live file so we can prove restore overwrites it.
    await fsp.writeFile(
      path.join(projectRoot, "data/leaderboard.json"),
      `${JSON.stringify({
        version: 1,
        updatedAt: "2026-12-31T00:00:00.000Z",
        profiles: [],
        resultsByProfile: {}
      })}\n`,
      "utf8"
    );

    const result = await applyRestore({ archivePath, projectRoot });
    expect(result.rolledBack).toBe(false);
    expect(result.restored).toContain("data/leaderboard.json");

    const afterLeaderboard = await fsp.readFile(
      path.join(projectRoot, "data/leaderboard.json"),
      "utf8"
    );
    expect(afterLeaderboard).toBe(beforeLeaderboard);

    const orphans = await findOrphanedRestoreDirs(path.join(projectRoot, "data"));
    expect(orphans).toEqual([]);
  });

  test("provider-inclusive restore preserves the diagnostic provider schema", async () => {
    // Phase 2.5's optional-root prune walks data/providers/** and
    // queues for deletion any file that's NOT in restorablePaths. The
    // diagnostic provider-import-manifest.schema.json lives under that
    // prefix but is intentionally not restorable — it's bundled as
    // read-only metadata. The prune must skip it so future schema
    // checks don't break.
    const projectRoot = await tempProject();
    // Add a provider artifact so providers are non-empty in the archive.
    const providerDir = path.join(projectRoot, "data/providers/en-US/abc123");
    await fsp.mkdir(providerDir, { recursive: true });
    await fsp.writeFile(path.join(providerDir, "en_US.dic"), "1\nWORLD\n", "utf8");

    const { archivePath } = await exportArchiveToFile(projectRoot, {
      includeProviders: true
    });

    const schemaAbs = path.join(projectRoot, "data/providers/provider-import-manifest.schema.json");
    expect(await fsp.access(schemaAbs).then(() => true, () => false)).toBe(true);

    const result = await applyRestore({ archivePath, projectRoot });
    expect(result.rolledBack).toBe(false);
    expect(result.removed).not.toContain("data/providers/provider-import-manifest.schema.json");

    // Schema file still on disk after the restore.
    expect(await fsp.access(schemaAbs).then(() => true, () => false)).toBe(true);
  });
});

describe("applyRestore rollback on mid-write failure", () => {
  test("rewinds renames when an in-flight rename throws", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);

    const beforeLeaderboard = await fsp.readFile(
      path.join(projectRoot, "data/leaderboard.json"),
      "utf8"
    );
    const beforeAdminJobs = await fsp.readFile(
      path.join(projectRoot, "data/admin-jobs.json"),
      "utf8"
    );

    // Spy on rename and throw on the Nth call. The applyRestore phase 3
    // does N renames per file (snapshot + swap), so picking call #5 lands
    // mid-batch. The exact number isn't fragile because the test checks
    // post-rollback state rather than which call threw.
    let callCount = 0;
    const realRename = fsp.rename.bind(fsp);
    const spy = jest.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      callCount += 1;
      if (callCount === 5) {
        const err = new Error("simulated EIO mid-restore");
        err.code = "EIO";
        throw err;
      }
      return realRename(from, to);
    });

    try {
      await expect(applyRestore({ archivePath, projectRoot })).rejects.toThrow(/simulated EIO/);
    } finally {
      spy.mockRestore();
    }

    // Live files should be byte-equal to their pre-restore state.
    const afterLeaderboard = await fsp.readFile(
      path.join(projectRoot, "data/leaderboard.json"),
      "utf8"
    );
    const afterAdminJobs = await fsp.readFile(
      path.join(projectRoot, "data/admin-jobs.json"),
      "utf8"
    );
    expect(afterLeaderboard).toBe(beforeLeaderboard);
    expect(afterAdminJobs).toBe(beforeAdminJobs);

    // Staging + rollback dirs are intentionally left in place on failure.
    const orphans = await findOrphanedRestoreDirs(path.join(projectRoot, "data"));
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    for (const orphan of orphans) {
      await fsp.rm(orphan.path, { recursive: true, force: true });
    }
  });
});

describe("applyRestore schema-drift rejection", () => {
  test("rejects when archive's bundled schema digest differs from current schema on disk", async () => {
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);
    // Modify the live schema after export — simulates a server upgrade
    // that changed the schema between archive creation and restore.
    const liveSchemaPath = path.join(projectRoot, "data/leaderboard.schema.json");
    const original = await fsp.readFile(liveSchemaPath, "utf8");
    const tampered = original.replace(/"version"/, "\"VERSION_RENAMED\"");
    await fsp.writeFile(liveSchemaPath, tampered, "utf8");
    await expect(
      applyRestore({ archivePath, projectRoot })
    ).rejects.toMatchObject({
      code: "SCHEMA_DRIFT"
    });
  });
});

describe("BackupError shape", () => {
  test("carries code + details", () => {
    const err = new BackupError("X_TEST", "boom", { foo: 1 });
    expect(err.code).toBe("X_TEST");
    expect(err.details).toEqual({ foo: 1 });
    expect(err.message).toBe("boom");
    expect(err.name).toBe("BackupError");
  });
});
