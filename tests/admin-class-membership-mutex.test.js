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

const tempDirsToCleanup = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-cmm-"));
  tempDirsToCleanup.push(dir);
  return dir;
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
  /* Defang the per-key admin write rate limiter for this concurrency
     test — 25 iterations × ~6 admin writes each = 150 writes inside
     a few seconds, which trips the production write limit. Both
     ADMIN_WRITE_RATE_LIMIT_MAX (server.js:78) and the base
     RATE_LIMIT_MAX (server.js:68) need lifting. */
  process.env.RATE_LIMIT_MAX = "10000";
  process.env.RATE_LIMIT_WINDOW_MS = "60000";
  process.env.ADMIN_RATE_LIMIT_MAX = "10000";
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX = "10000";
  return require("../server");
}

afterEach(() => {
  resetEnv();
  // CodeRabbit nit on PR #200 — clean up tmp dirs allocated during the
  // test so /tmp/lhw-cmm-* doesn't accumulate over many CI runs.
  while (tempDirsToCleanup.length > 0) {
    const dir = tempDirsToCleanup.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
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
    // reliably in pre-mutex code while staying inside the 60s test
    // timeout.
    const ITERATIONS = 25;
    let anyInvariantBreak = false;
    let executedRaces = 0;

    /* Each iteration uses unique names (`ProfileX${iter}`,
       `ClassA${iter}`, etc.) so profiles + classes don't collide
       across iterations. The server module is loaded once outside
       the loop so in-memory state accumulates — that's intentional
       and the per-iteration unique naming dodges it. Copilot on
       PR #200. */

    /* Profile/class names use letter-only suffixes — the server's
       profile-name validator at `lib/profile-name.js` rejects digits
       (letters, spaces, apostrophes, hyphens only). 25 iterations fits
       into A-Y; the test asserts >= 20 races executed, leaving 5
       letters of slack if any iteration skips for unrelated reasons. */
    const letterSuffix = (i) => `Iter${String.fromCharCode(65 + i)}`;

    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      const tag = letterSuffix(iter);
      // Seed profile X via bulk-add into a throwaway class, then
      // delete the throwaway class (without `deleteProfiles`) so the
      // profile survives in the leaderboard.
      const profileName = `ProfileX ${tag}`;
      const seedClassRes = await agent
        .post("/api/admin/classes")
        .set("X-Admin-Key", adminKey)
        .send({ name: `Seed ${tag}` });
      const seedClassId = seedClassRes.body?.class?.id;
      if (!seedClassId) continue;
      await agent
        .post(`/api/admin/classes/${seedClassId}/members/bulk`)
        .set("X-Admin-Key", adminKey)
        .send({ names: [profileName] });
      await agent
        .delete(`/api/admin/classes/${seedClassId}`)
        .set("X-Admin-Key", adminKey)
        .send({ confirmed: true });

      const profilesRes = await agent
        .get("/api/admin/stats/profiles")
        .set("X-Admin-Key", adminKey);
      const profileX = (profilesRes.body?.profiles || []).find(
        (p) => p.name === profileName
      );
      if (!profileX) continue;

      // Create two classes. Class A holds profileX so the carve-out
      // path treats it as a candidate. Class B is the target the
      // racing bulk-add will reference.
      const classARes = await agent
        .post("/api/admin/classes")
        .set("X-Admin-Key", adminKey)
        .send({ name: `ClassA ${tag}` });
      const classBRes = await agent
        .post("/api/admin/classes")
        .set("X-Admin-Key", adminKey)
        .send({ name: `ClassB ${tag}` });
      const classAId = classARes.body?.class?.id;
      const classBId = classBRes.body?.class?.id;
      if (!classAId || !classBId) continue;

      const addToARes = await agent
        .post(`/api/admin/classes/${classAId}/members/bulk`)
        .set("X-Admin-Key", adminKey)
        .send({ names: [profileName] });
      if (addToARes.status !== 200) continue;

      // The race: DELETE A with carve-out + bulk-add to B referencing
      // profileName. Without the mutex these can interleave such that
      // the carve-out strips profileX from the leaderboard AFTER the
      // bulk-add has placed profileX.id in class B.
      executedRaces += 1;
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
        .get("/api/admin/stats/profiles")
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
    /* Reject vacuous passes — if every iteration skipped (seeding
       broke at some point), `anyInvariantBreak` stays false but
       nothing was actually tested. Insist that the bulk of
       iterations ran the race. Copilot + CodeRabbit on PR #200. */
    expect(executedRaces).toBeGreaterThanOrEqual(20);
  }, 60000);
});
