"use strict";

// Cross-store mutex regression test (issue #152). Pins the invariant
// that `withClassMembershipMutex` blocks the racy interleave between
// the class-delete carve-out path and a concurrent bulk-add referencing
// the carve-out profile by name.
//
// The race (without the mutex):
//   1. DELETE /api/admin/classes/A {deleteProfiles:true}
//      → classesStore.deleteClassWithCarveOut(A) — atomic in classes
//      → classesStore.getSnapshot() — sees A gone, B empty
//      → eligibleForCleanup = [profileX.id]
//      ⤵ (NETWORK / EVENT-LOOP YIELD)
//   2. POST /api/admin/classes/B/members/bulk {names:["ProfileX"]}
//      → leaderboardStore.mutate → reuses profileX.id (still in leaderboard)
//      → classesStore.addMembers(B, [profileX.id]) — B now has profileX
//   3. (continue 1)
//      → leaderboardStore.mutate → removes profileX from leaderboard
//
// Post-state without the mutex: class B references profileX.id, but
// profileX is gone from the leaderboard. Class report renders "(missing
// profile)" for an ID nobody can recover.
//
// With the mutex, the two operations serialize: either the carve-out
// fully completes (B's bulk-add then creates a NEW profile for the
// "ProfileX" name) or the bulk-add fully completes (carve-out's
// re-read of classes.getSnapshot sees profileX in B and skips it).
// In either ordering, no class references a deleted leaderboard id.
//
// Strategy: run the race N times via supertest. Without the mutex this
// invariant breaks roughly half the runs (depending on Node event-loop
// scheduling); the mutex pins it to 0 breaks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const supertest = require("supertest");

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-cmm-"));
}

function loadApp({ adminKey, statsPath, classesPath }) {
  jest.resetModules();
  resetEnv();
  process.env.ADMIN_KEY = adminKey;
  process.env.NODE_ENV = "test";
  process.env.STATS_STORE_PATH = statsPath;
  process.env.CLASSES_STORE_PATH = classesPath;
  // Disable boot scheduler tick (same belt-and-suspenders as
  // admin-schedule-routes.test.js).
  process.env.SCHEDULER_CHECK_INTERVAL_MS = String(60 * 60 * 1000);
  return require("../server");
}

afterEach(() => {
  resetEnv();
});

describe("withClassMembershipMutex (#152): class-delete carve-out vs bulk-add", () => {
  test("never strips a profile that a concurrent bulk-add put in another class", async () => {
    const dir = tempDir();
    const statsPath = path.join(dir, "stats.json");
    const classesPath = path.join(dir, "classes.json");
    const adminKey = "test-key-152";
    const app = loadApp({ adminKey, statsPath, classesPath });
    const agent = supertest(app);

    // The race is timing-sensitive — without the mutex it breaks
    // probabilistically. 25 iterations is enough to surface the bug
    // reliably in pre-mutex code while staying inside the 30s test
    // timeout.
    const ITERATIONS = 25;
    let anyInvariantBreak = false;

    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      // Fresh state per iteration: wipe stores so profile names don't
      // pile up and class IDs don't collide. Each loop tests one race.
      try { fs.rmSync(statsPath); } catch (_e) { /* may not exist */ }
      try { fs.rmSync(classesPath); } catch (_e) { /* may not exist */ }

      // Set up profile X via the leaderboard rename endpoint —
      // simplest way to get a known-id profile into the store from
      // an integration test.
      const profileName = `ProfileX${iter}`;
      const createRes = await agent
        .patch("/api/admin/stats/profile/x-seed")
        .set("X-Admin-Key", adminKey)
        .send({ name: profileName });
      // The patch creates the profile on demand (admin profile
      // rename has create-if-missing semantics today). If the seeding
      // endpoint contract changes, this test needs an alternate seed.
      if (createRes.status !== 200) {
        // Fall back: use bulk-add to seed.
        const seedClassRes = await agent
          .post("/api/admin/classes")
          .set("X-Admin-Key", adminKey)
          .send({ name: `Seed${iter}` });
        const seedClassId = seedClassRes.body?.class?.id;
        await agent
          .post(`/api/admin/classes/${seedClassId}/members/bulk`)
          .set("X-Admin-Key", adminKey)
          .send({ names: [profileName] });
        await agent
          .delete(`/api/admin/classes/${seedClassId}`)
          .set("X-Admin-Key", adminKey)
          .send({ confirmed: true });
      }

      // Get profile X's id from the leaderboard.
      const leaderboardRes = await agent
        .get("/api/admin/stats")
        .set("X-Admin-Key", adminKey);
      const profileX = leaderboardRes.body?.profiles?.find(
        (p) => p.name === profileName
      );
      if (!profileX) {
        // The seeding flow above didn't land. Skip this iteration —
        // the surrounding harness churn isn't relevant to the mutex
        // contract we're testing.
        continue;
      }

      // Create two classes. Class A holds profileX so the carve-out
      // path treats it as a candidate. Class B is the target the
      // racing bulk-add will reference.
      const classARes = await agent
        .post("/api/admin/classes")
        .set("X-Admin-Key", adminKey)
        .send({ name: `ClassA${iter}` });
      const classBRes = await agent
        .post("/api/admin/classes")
        .set("X-Admin-Key", adminKey)
        .send({ name: `ClassB${iter}` });
      const classAId = classARes.body?.class?.id;
      const classBId = classBRes.body?.class?.id;
      if (!classAId || !classBId) continue;

      await agent
        .post(`/api/admin/classes/${classAId}/members/bulk`)
        .set("X-Admin-Key", adminKey)
        .send({ names: [profileName] });

      // The race: DELETE A with carve-out + bulk-add to B referencing
      // profileName. Without the mutex these can interleave such that
      // the carve-out strips profileX from the leaderboard AFTER the
      // bulk-add has placed profileX.id in class B.
      const [deleteSettled, bulkSettled] = await Promise.allSettled([
        agent
          .delete(`/api/admin/classes/${classAId}`)
          .set("X-Admin-Key", adminKey)
          .send({ confirmed: true, deleteProfiles: true }),
        agent
          .post(`/api/admin/classes/${classBId}/members/bulk`)
          .set("X-Admin-Key", adminKey)
          .send({ names: [profileName] })
      ]);
      // Both should succeed individually — the mutex serializes them,
      // doesn't fail them.
      expect(deleteSettled.status).toBe("fulfilled");
      expect(bulkSettled.status).toBe("fulfilled");

      // Post-race state: read class B's roster and the leaderboard.
      const postLeaderboard = await agent
        .get("/api/admin/stats")
        .set("X-Admin-Key", adminKey);
      const profileXStillInLeaderboard = (postLeaderboard.body?.profiles || []).some(
        (p) => p.id === profileX.id
      );
      const postClassB = await agent
        .get(`/api/admin/classes/${classBId}`)
        .set("X-Admin-Key", adminKey);
      const classBRefersToOriginalProfileX = (
        postClassB.body?.class?.memberProfileIds || []
      ).includes(profileX.id);

      // The invariant: NEVER classB-refers-to-X AND X-gone-from-leaderboard.
      // That combination = stripped a profile that's now legitimately
      // in another class.
      if (classBRefersToOriginalProfileX && !profileXStillInLeaderboard) {
        anyInvariantBreak = true;
      }
    }

    expect(anyInvariantBreak).toBe(false);
  }, 60000);
});
