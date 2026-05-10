"use strict";

// Concurrency-stress tests for lib/backup-store.js.
//
// Backup-store is a free-function module — it does NOT internally
// serialize. The lock contract is owned by the caller (server.js holds
// `restoreInProgressRef` to keep applyRestore mutually exclusive). What
// THIS test must prove is that the read-side surface (`buildManifest`,
// `validateArchive`, `sha256OfFile`) is race-free: N parallel calls to
// the same artifact must each succeed and produce identical output,
// with no file-descriptor leaks, no half-read manifests, no yauzl
// stateful-cursor confusion.
//
// We also pin down the documented serialization contract for
// `applyRestore`: a manually-serialized chain of N restores against the
// same projectRoot is idempotent. Without restoreInProgressRef-style
// caller serialization, applyRestore is NOT safe to run in parallel —
// see lib/locks.md "restoreInProgressRef" section.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const nodeCrypto = require("node:crypto");

const {
  buildManifest,
  createArchive,
  validateArchive,
  applyRestore,
  sha256OfFile,
  sha256OfBuffer
} = require("../lib/backup-store.js");

const { runConcurrencyScenario } = require("./helpers/concurrency-fixture");

const REPO_ROOT = path.resolve(__dirname, "..");

async function copyFileFromRepo(rel, destProjectRoot) {
  const src = path.join(REPO_ROOT, rel);
  const dest = path.join(destProjectRoot, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

// Build a tiny but schema-valid temp projectRoot. Mirrors the layout in
// tests/backup-store.test.js — kept inline rather than imported because
// we want this file to stand alone and not couple to that suite's
// internals.
async function makeProjectRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lhw-backup-concurrency-"));
  await fsp.mkdir(path.join(dir, "data"), { recursive: true });
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
  await fsp.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "test-app", version: "0.0.0-test" })}\n`,
    "utf8"
  );
  // Tiny schema-valid state files.
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
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", jobs: [] }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "app-config.json"),
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", overrides: {} }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "classes.json"),
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", classes: [] }, null, 2)}\n`,
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
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", subscriptions: [] }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "webhook-deliveries.json"),
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", deliveries: [] }, null, 2)}\n`,
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
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", challenges: [] }, null, 2)}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(dir, "data", "challenge-results.json"),
    `${JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", sessions: [] }, null, 2)}\n`,
    "utf8"
  );
  await copyFileFromRepo("data/languages.json", dir);
  await fsp.writeFile(
    path.join(dir, "data", "word.json"),
    `${JSON.stringify({ word: "TESTS", date: "2026-01-01" })}\n`,
    "utf8"
  );
  return dir;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function exportArchiveToFile(projectRoot) {
  const { archive } = createArchive({ projectRoot });
  const buf = await streamToBuffer(archive);
  const archivePath = path.join(
    projectRoot,
    `archive-${nodeCrypto.randomBytes(4).toString("hex")}.zip`
  );
  await fsp.writeFile(archivePath, buf);
  return { archivePath, bytes: buf.length };
}

function manifestFingerprint(manifest) {
  // Stable fingerprint = manifestVersion + sorted (path, sha256, bytes)
  // tuples. updatedAt + createdAt are dropped because two snapshots
  // taken seconds apart will differ only there. We want to detect
  // STATE divergence between parallel callers, not clock skew.
  const sortedFiles = [...manifest.files]
    .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({
    version: manifest.manifestVersion,
    files: sortedFiles
  });
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

describe("backup-store: parallel read paths are race-free", () => {
  test("buildManifest: 20 parallel callers against the same projectRoot agree on fingerprint", async () => {
    const projectRoot = await tempProject();
    await runConcurrencyScenario({
      name: "backup-store: parallel buildManifest",
      setup: () => ({ projectRoot }),
      operation: async ({ projectRoot: root }) =>
        buildManifest({ projectRoot: root, includeProviders: false, includeDictionaries: false }),
      invariants: [
        async (_ctx, { results }) => {
          const fingerprints = new Set(results.map(manifestFingerprint));
          if (fingerprints.size !== 1) {
            throw new Error(
              `expected all 20 manifests to have identical fingerprint; got ${fingerprints.size} distinct values`
            );
          }
        }
      ]
    });
  }, 30000);

  test("validateArchive: 20 parallel callers against the same archive each succeed identically", async () => {
    // Build the archive ONCE outside setup. Each iter inside the
    // fixture re-runs validateArchive against this same on-disk
    // artifact; that's the contended scenario in production (admin
    // viewing manifest preview while another admin starts a restore).
    const projectRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(projectRoot);

    await runConcurrencyScenario({
      name: "backup-store: parallel validateArchive",
      setup: () => ({ archivePath, projectRoot }),
      operation: async ({ archivePath: ap, projectRoot: pr }) =>
        validateArchive(ap, { projectRoot: pr }),
      invariants: [
        async (_ctx, { results }) => {
          // Each validateArchive returns { manifest, ... }. The
          // manifest fingerprint must be identical across all 20.
          const fingerprints = new Set(
            results.map((r) => manifestFingerprint(r.manifest))
          );
          if (fingerprints.size !== 1) {
            throw new Error(
              `expected all 20 validations to produce the same manifest fingerprint; got ${fingerprints.size} distinct values`
            );
          }
        }
      ]
    });
  }, 30000);

  test("sha256OfFile: 20 parallel callers on the same file all return the same digest", async () => {
    const projectRoot = await tempProject();
    const filePath = path.join(projectRoot, "data", "leaderboard.json");
    const buf = await fsp.readFile(filePath);
    const expectedDigest = sha256OfBuffer(buf);

    await runConcurrencyScenario({
      name: "backup-store: parallel sha256OfFile",
      setup: () => ({ filePath }),
      operation: async ({ filePath: fp }) => sha256OfFile(fp),
      invariants: [
        async (_ctx, { results }) => {
          const unique = new Set(results);
          if (unique.size !== 1) {
            throw new Error(
              `expected one unique digest across 20 readers; got ${unique.size}`
            );
          }
          if (!unique.has(expectedDigest)) {
            throw new Error(
              `parallel readers returned digest ${[...unique][0]}, expected ${expectedDigest}`
            );
          }
        }
      ]
    });
  }, 30000);
});

describe("backup-store: applyRestore serialization contract", () => {
  test("serialized applyRestore chain is idempotent against the same archive", async () => {
    // applyRestore is NOT internally serialized — that's the caller's
    // job (restoreInProgressRef in server.js). This test pins the
    // documented invariant: a sequential chain of N restores against
    // the same archive leaves the projectRoot in the same state as
    // the archive's source. We chain via reduce() to guarantee
    // sequential execution — the fixture's Promise.allSettled fan-out
    // would intentionally race and corrupt data, which is the
    // behavior `restoreInProgressRef` exists to prevent.
    const sourceRoot = await tempProject();
    const { archivePath } = await exportArchiveToFile(sourceRoot);
    const targetRoot = await tempProject();
    // Pre-mutate the target so we can confirm restore overwrites it.
    await fsp.writeFile(
      path.join(targetRoot, "data", "word.json"),
      `${JSON.stringify({ word: "DIRTY", date: "2099-12-31" })}\n`,
      "utf8"
    );

    // Sequential chain of 5 restores. If applyRestore were truly
    // idempotent and well-isolated, this would converge after 1
    // call; running 5 in a row exercises the staging+rollback dir
    // lifecycle and the partial-restore-orphan cleanup paths.
    let chain = Promise.resolve();
    const calls = 5;
    for (let i = 0; i < calls; i += 1) {
      chain = chain.then(() =>
        applyRestore({
          archivePath,
          projectRoot: targetRoot,
          logger: { warn: () => {}, error: () => {}, info: () => {} }
        })
      );
    }
    await chain;

    // Final state should match the archive source.
    const restored = JSON.parse(
      await fsp.readFile(path.join(targetRoot, "data", "word.json"), "utf8")
    );
    expect(restored).toEqual({ word: "TESTS", date: "2026-01-01" });

    // No leftover staging/rollback directories (otherwise the next
    // restore would inherit orphans).
    const dataChildren = await fsp.readdir(path.join(targetRoot, "data"));
    const orphans = dataChildren.filter((name) =>
      name.startsWith(".restore-staging-") || name.startsWith(".restore-rollback-")
    );
    expect(orphans).toEqual([]);
  }, 60000);
});

// Sanity check: confirm the temp project files actually exist and
// readable so the parallel reads above had something to read. Catches
// fixture skeleton bugs where the project root is empty and
// `parallel` callers all return identical empty manifests.
describe("backup-store: temp project sanity", () => {
  test("project root has every in-scope file written", async () => {
    const projectRoot = await tempProject();
    const manifest = await buildManifest({
      projectRoot,
      includeProviders: false,
      includeDictionaries: false
    });
    expect(manifest.files.length).toBeGreaterThan(5);
    for (const entry of manifest.files) {
      const abs = path.join(projectRoot, entry.path);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });
});
