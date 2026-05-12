"use strict";

// Historical P1 regression fixtures from PR #98 (C4 / #130).
//
// PR #98 introduced backup/restore. Reviewers caught a string of P1s
// during the review rounds. These tests pin the non-race ones — race-
// condition P1s from the same PR are covered by the Phase 3
// concurrency fixture (`tests/concurrency-fixture.test.js` and
// the per-store concurrency tests).
//
// Reproduction protocol: these tests are designed to fail when run
// against the PR-internal pre-fix commits (see the comment on each
// test below). Verification recipe:
//   git worktree add /tmp/wt-pre98 <pre-fix-sha>
//   cp tests/regression/p1-pr98-backup-fixtures.test.js \
//     /tmp/wt-pre98/tests/regression/
//   cd /tmp/wt-pre98 && node node_modules/.bin/jest \
//     tests/regression/p1-pr98-backup-fixtures.test.js
//   # Expect: tests fail.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const archiver = require("archiver");

const {
  validateArchive,
  buildManifest,
  sha256OfBuffer
} = require("../../lib/backup-store.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

async function tempProjectWithSchemas() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wordle-c4-pr98-"));
  await fsp.mkdir(path.join(dir, "data"), { recursive: true });
  const schemaFiles = [
    "data/backup-manifest.schema.json",
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
    "data/challenge-results.schema.json"
  ];
  for (const rel of schemaFiles) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(dir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.copyFile(src, dest);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return dir;
}

// Pins P1 from #98 (pre-fix commit 5fcaffc): "Reject duplicate
// archive paths before staging".
//
// Pre-fix symptom: validateArchive accepted an archive whose
// manifest listed the same `path` twice. Staging would then race
// the two rename ops with the second overwriting the first,
// deploying attacker-chosen content masked by a benign-looking
// first entry. Post-fix throws BackupError("MANIFEST_DUPLICATE_PATH").
describe("P1 fixture: PR #98 — duplicate archive paths rejected pre-stage", () => {
  test("validateArchive throws MANIFEST_DUPLICATE_PATH on a duplicate-path manifest", async () => {
    const projectRoot = await tempProjectWithSchemas();
    const archivePath = path.join(projectRoot, "evil-duplicate.zip");
    const archive = archiver("zip");
    const out = fs.createWriteStream(archivePath);
    archive.pipe(out);
    const evilContent = Buffer.from("evil");
    const evilSha = sha256OfBuffer(evilContent);
    archive.append(
      JSON.stringify({
        manifestVersion: 1,
        appVersion: "0.0.0",
        createdAt: "2026-01-01T00:00:00.000Z",
        nodeId: "test",
        files: [
          { path: "data/leaderboard.json", bytes: evilContent.length, sha256: evilSha },
          { path: "data/leaderboard.json", bytes: evilContent.length, sha256: evilSha }
        ],
        optionalSets: []
      }),
      { name: "manifest.json" }
    );
    archive.append(evilContent, { name: "data/leaderboard.json" });
    await archive.finalize();
    await new Promise((resolve) => out.on("close", resolve));

    await expect(validateArchive(archivePath, { projectRoot })).rejects.toMatchObject({
      code: "MANIFEST_DUPLICATE_PATH"
    });
  });
});

// Pins P1 from #98 (pre-fix commit 366ff7d): "Exclude diagnostic
// provider-import-manifest schema from provider set".
//
// Pre-fix symptom: buildManifest with includeProviders=true walked
// `data/providers/` and picked up
// `data/providers/provider-import-manifest.schema.json` (which was
// already in DIAGNOSTIC_SCHEMAS), producing a manifest listing the
// same path twice. That manifest then trips the duplicate-paths
// guard added by the sibling P1 above — backup BUILD fails before
// validation even runs. Post-fix excludes the diagnostic schema
// from the providers directory walk.
describe("P1 fixture: PR #98 — buildManifest excludes diagnostic provider schema from provider set", () => {
  test("buildManifest with includeProviders=true does not duplicate the diagnostic schema", async () => {
    const projectRoot = await tempProjectWithSchemas();
    const diagSchemaRel = "data/providers/provider-import-manifest.schema.json";
    await fsp.mkdir(path.join(projectRoot, "data", "providers"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, diagSchemaRel), JSON.stringify({ x: 1 }));
    const providerCommitDir = path.join(
      projectRoot,
      "data",
      "providers",
      "en-US",
      "0123456789abcdef0123456789abcdef01234567"
    );
    await fsp.mkdir(providerCommitDir, { recursive: true });
    await fsp.writeFile(path.join(providerCommitDir, "expanded-forms.txt"), "test\n");
    for (const rel of [
      "data/leaderboard.json",
      "data/languages.json",
      "data/admin-jobs.json",
      "data/app-config.json",
      "data/classes.json",
      "data/schedule.json",
      "data/webhooks.json",
      "data/webhook-deliveries.json",
      "data/push-subscriptions.json",
      "data/challenges.json",
      "data/challenge-results.json",
      "data/word.json"
    ]) {
      await fsp.writeFile(path.join(projectRoot, rel), "{}");
    }

    const manifest = await buildManifest({
      projectRoot,
      includeProviders: true,
      includeDictionaries: false
    });

    const matchingPaths = manifest.files.filter((entry) => entry.path === diagSchemaRel);
    expect(matchingPaths).toHaveLength(1);
  });
});
