"use strict";

// Concurrency-fixture coverage NOTE for the synchronous-API stores
// listed in #132 (Epic C6).
//
// `app-config-store`, `language-registry-store`, and `vapid-store`
// expose sync-only APIs:
//   - `loadSync`, `reloadSync`, `getSnapshotSync`
//   - `replaceOverridesSync`, `updateSync`, `setLanguageEnabledSync`
//   - `ensureKeysSync`, `getKeysSync`
//
// Sync functions on Node.js's single-threaded event loop never
// interleave at instruction granularity — once a sync call starts,
// no other JS runs until it returns. Two callers invoking
// `replaceOverridesSync` "in parallel" actually serialize at the
// language level. There is no commit-queue / lock primitive to
// stress because there is no async window to race.
//
// What CAN go wrong (and is covered by example-based unit tests in
// the per-store test files):
//   - Caller misuse: two callers reading a snapshot, both mutating
//     locally, then both calling the sync write — last-writer-wins,
//     but that's a caller-responsibility pattern, not a concurrency
//     invariant the store itself promises to enforce.
//   - File-system races with an external process (out of scope).
//
// Verification that the sync-API has no observable race: this file
// exercises `app-config-store` in a tight loop and confirms there's
// no observable reentrancy or shared-state bug. The same logic
// applies to `language-registry-store` and `vapid-store` —
// reciprocal tests for each are not added because the language-
// level "no interleave" guarantee is the same, and per-store
// example-based unit tests in
// `tests/{language-registry,vapid-store}.test.js` (if added) would
// cover their specific shape.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { AppConfigStore } = require("../lib/app-config-store");

function tempFilePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-sync-concurrency-"));
  return { dir, filePath: path.join(dir, name) };
}

async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("sync stores: no concurrency window to stress", () => {
  test("app-config-store: 100 sequential replaceOverridesSync calls converge to last patch", async () => {
    const { dir, filePath } = tempFilePath("app-config.json");
    try {
      const store = new AppConfigStore({ filePath });
      store.loadSync();
      let lastResult;
      for (let i = 0; i < 100; i += 1) {
        // leaderboardMaxProfiles is bounded 1..1000 by normalizeLimits.
        lastResult = store.replaceOverridesSync({
          limits: { leaderboardMaxProfiles: 100 + i }
        });
      }
      // Final state reflects the last patch (no torn writes, no
      // observable corruption from 100 sync calls in a row).
      const expectedMax = 100 + 99;
      expect(lastResult.overrides.limits.leaderboardMaxProfiles).toBe(expectedMax);
      // Re-load from disk to confirm the on-disk state matches.
      const reloaded = new AppConfigStore({ filePath });
      reloaded.loadSync();
      const snap = reloaded.getSnapshotSync();
      expect(snap.overrides.limits.leaderboardMaxProfiles).toBe(expectedMax);
    } finally {
      await cleanupDir(dir);
    }
  });
});
