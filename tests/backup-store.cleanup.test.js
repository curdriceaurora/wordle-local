"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  findOrphanedRestoreDirs,
  cleanupOrphanedRestoreDirs,
  DEFAULT_ORPHAN_AGE_THRESHOLD_MS
} = require("../lib/backup-store.js");

// B5 / #124 — auto-cleanup of orphan restore staging/rollback dirs.
//
// These tests exercise the cleanupOrphanedRestoreDirs helper in
// isolation. The boot-path integration is covered indirectly: the
// helper is the load-bearing piece, and the boot wrapper in server.js
// is a straightforward call+log adapter.

async function makeTempDataRoot() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wordle-cleanup-test-"));
  const dataRoot = path.join(dir, "data");
  await fsp.mkdir(dataRoot, { recursive: true });
  return { dir, dataRoot };
}

async function makeOrphanDir(dataRoot, name, opts = {}) {
  const abs = path.join(dataRoot, name);
  await fsp.mkdir(abs, { recursive: false });
  // Drop a marker file inside so we can verify the dir was actually
  // removed (a "rm" that leaves a bare empty dir wouldn't fail the
  // test otherwise).
  await fsp.writeFile(path.join(abs, "marker.txt"), "orphan-content");
  if (opts.ageMs !== undefined && opts.ageMs !== null) {
    const when = new Date(Date.now() - opts.ageMs);
    await fsp.utimes(abs, when, when);
  }
  return abs;
}

describe("cleanupOrphanedRestoreDirs (B5 / #124)", () => {
  test("deletes dirs older than the threshold; preserves younger ones", async () => {
    const { dir, dataRoot } = await makeTempDataRoot();
    try {
      const oldStaging = await makeOrphanDir(dataRoot, ".restore-staging-old", {
        ageMs: 2 * 24 * 60 * 60 * 1000 // 2 days
      });
      const oldRollback = await makeOrphanDir(dataRoot, ".restore-rollback-old", {
        ageMs: 36 * 60 * 60 * 1000 // 36h
      });
      const freshStaging = await makeOrphanDir(dataRoot, ".restore-staging-fresh", {
        ageMs: 5 * 60 * 1000 // 5 minutes
      });

      const result = await cleanupOrphanedRestoreDirs(dataRoot, {
        ageThresholdMs: 24 * 60 * 60 * 1000
      });

      expect(result.cleaned.map((entry) => entry.name).sort()).toEqual([
        ".restore-rollback-old",
        ".restore-staging-old"
      ]);
      expect(result.retained.map((entry) => entry.name)).toEqual([".restore-staging-fresh"]);
      expect(result.errors).toEqual([]);

      // Concrete fs check.
      await expect(fsp.access(oldStaging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fsp.access(oldRollback)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fsp.access(freshStaging)).resolves.toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("threshold=0 deletes every orphan regardless of age", async () => {
    const { dir, dataRoot } = await makeTempDataRoot();
    try {
      await makeOrphanDir(dataRoot, ".restore-staging-a", { ageMs: 1000 });
      await makeOrphanDir(dataRoot, ".restore-rollback-b", { ageMs: 1000 });

      const result = await cleanupOrphanedRestoreDirs(dataRoot, { ageThresholdMs: 0 });
      expect(result.cleaned).toHaveLength(2);
      expect(result.retained).toEqual([]);
      const remaining = await findOrphanedRestoreDirs(dataRoot);
      expect(remaining).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("ENOENT dataRoot resolves to empty result (no orphans)", async () => {
    const result = await cleanupOrphanedRestoreDirs("/var/nope/wordle-test-nonexistent", {
      ageThresholdMs: 0
    });
    expect(result).toEqual({ cleaned: [], retained: [], errors: [] });
  });

  test("non-orphan directories under data/ are untouched", async () => {
    const { dir, dataRoot } = await makeTempDataRoot();
    try {
      // Real data dirs should never look like orphan candidates.
      await fsp.mkdir(path.join(dataRoot, "providers"), { recursive: true });
      await fsp.mkdir(path.join(dataRoot, "challenges"), { recursive: true });
      await fsp.writeFile(path.join(dataRoot, "leaderboard.json"), "{}");
      await makeOrphanDir(dataRoot, ".restore-staging-real-orphan", {
        ageMs: 48 * 60 * 60 * 1000
      });

      const result = await cleanupOrphanedRestoreDirs(dataRoot, { ageThresholdMs: 60 * 60 * 1000 });
      expect(result.cleaned.map((entry) => entry.name)).toEqual([
        ".restore-staging-real-orphan"
      ]);
      // Real data still there.
      await expect(fsp.access(path.join(dataRoot, "providers"))).resolves.toBeUndefined();
      await expect(fsp.access(path.join(dataRoot, "challenges"))).resolves.toBeUndefined();
      await expect(fsp.access(path.join(dataRoot, "leaderboard.json"))).resolves.toBeUndefined();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("uses now() override for deterministic age comparison", async () => {
    const { dir, dataRoot } = await makeTempDataRoot();
    try {
      await makeOrphanDir(dataRoot, ".restore-staging-x", { ageMs: 30 * 60 * 1000 });
      // ageThreshold=1h. Real now: would retain. now()=Date.now()+2h: would clean.
      const result = await cleanupOrphanedRestoreDirs(dataRoot, {
        ageThresholdMs: 60 * 60 * 1000,
        now: () => Date.now() + 2 * 60 * 60 * 1000
      });
      expect(result.cleaned.map((entry) => entry.name)).toEqual([".restore-staging-x"]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("partial failure is collected, not thrown", async () => {
    // CR Minor + Copilot on PR #153 caught that the previous shape
    // only asserted the response SHAPE on the success path. Now we
    // deterministically force one dir's rm to throw via jest.spyOn
    // on the shared fsp module. cleanupOrphanedRestoreDirs's internal
    // fsp.rm call sees the spy because Node's module cache returns
    // the same `node:fs/promises` instance to both the lib and the
    // test.
    const { dir, dataRoot } = await makeTempDataRoot();
    const goodName = ".restore-staging-good";
    const badName = ".restore-rollback-bad";
    const realRm = fsp.rm;
    const rmSpy = jest.spyOn(fsp, "rm").mockImplementation((target, opts) => {
      if (typeof target === "string" && target.endsWith(badName)) {
        const err = new Error("EACCES: permission denied (simulated)");
        err.code = "EACCES";
        return Promise.reject(err);
      }
      return realRm(target, opts);
    });
    try {
      await makeOrphanDir(dataRoot, goodName, { ageMs: 48 * 60 * 60 * 1000 });
      await makeOrphanDir(dataRoot, badName, { ageMs: 48 * 60 * 60 * 1000 });
      const result = await cleanupOrphanedRestoreDirs(dataRoot, { ageThresholdMs: 0 });

      // Function resolves (does not throw) even when one rm fails.
      // Good dir lands in `cleaned`; bad dir lands in `errors` with
      // the simulated message.
      expect(result.cleaned.map((entry) => entry.name)).toEqual([goodName]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].name).toBe(badName);
      expect(result.errors[0].message).toMatch(/permission denied/);
      expect(result.retained).toEqual([]);
    } finally {
      rmSpy.mockRestore();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test("default age threshold is 24h", () => {
    expect(DEFAULT_ORPHAN_AGE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
