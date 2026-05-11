"use strict";

// Fault-injection tests against the persisted-state stores (#129).
//
// What this covers per store:
//   - schedule-store:
//     * commit-time `writeJsonAtomic` ENOSPC surfaces a typed error;
//       state is NOT corrupted (next read sees prior state).
//     * EACCES on initial load surfaces STORE_READ_FAILED (not a
//       silent corruption).
//   - challenge-config-store:
//     * commit-time ENOSPC same contract.
//   - webhook-store:
//     * rename-fail mid-commit (simulating a torn atomic rename).
//
// Covers the contract documented in `lib/locks.md` and `docs/admin-
// security-checklist.md` — stores must FAIL CLOSED on I/O errors:
// throw a typed error, leave on-disk state untouched, leave in-
// memory state at the prior committed value. No half-writes, no
// silent corruption.
//
// Each scenario installs the harness, runs the store op, asserts
// both the thrown error code AND a post-fault read showing the
// store recovered to a consistent state.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ScheduleStore } = require("../lib/schedule-store");
const { ChallengeConfigStore } = require("../lib/challenge-config-store");
const { ChallengeResultsStore } = require("../lib/challenge-results-store");
const { WebhookStore } = require("../lib/webhook-store");
const { WebhookDeliveryStore } = require("../lib/webhook-delivery-store");
const { PushSubscriptionStore } = require("../lib/push-subscription-store");
const { AdminJobsStore } = require("../lib/admin-jobs-store");
const { ClassesStore } = require("../lib/classes-store");
const { LeaderboardStore } = require("../lib/leaderboard-store");

const { installFaultyFs } = require("./helpers/fs-faulty");

function tempFilePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-fs-fault-"));
  return { dir, filePath: path.join(dir, name) };
}

function frozenNow(iso = "2026-05-11T00:00:00.000Z") {
  return () => new Date(iso);
}

async function cleanup(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

describe("schedule-store: fault-injection", () => {
  test("ENOSPC during commit surfaces a typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("schedule.json");
    try {
      const store = new ScheduleStore({ filePath, now: frozenNow() });
      await store.load();
      // Successful commit so there's a "prior" state to compare against.
      await store.addEntry({ date: "2026-05-08", word: "ALPHA", lang: "en" });
      const beforeFault = await store.getSnapshot();
      expect(beforeFault.scheduled_words).toHaveLength(1);

      // Install ENOSPC fault on the next writeFile. The store's
      // writeJsonAtomic helper writes to a `.tmp` path first and then
      // renames; either failure should surface a typed error.
      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        // ScheduleStore's `writeJsonAtomic` catches fs-level errors
        // and rethrows as a `ScheduleStoreError` with code
        // `STORE_WRITE_FAILED` (preserving the original under
        // `.cause`). Callers branch on the typed code; the raw
        // ENOSPC stays available via `.cause.code` if observability
        // needs it. (Copilot + CodeRabbit caught the prior comment
        // that incorrectly claimed the underlying error surfaced
        // directly — PR #135.)
        await expect(
          store.addEntry({ date: "2026-05-09", word: "BETAS", lang: "en" })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      // After the fault, the store's in-memory state is unchanged
      // (the prior commit is the most recent). A fresh load from
      // disk shows only the original row, never the half-applied one.
      const inMemory = await store.getSnapshot();
      expect(inMemory.scheduled_words).toHaveLength(1);
      expect(inMemory.scheduled_words[0].word).toBe("ALPHA");

      const reloadedFromDisk = JSON.parse(await fsp.readFile(filePath, "utf8"));
      expect(reloadedFromDisk.scheduled_words).toHaveLength(1);
      expect(reloadedFromDisk.scheduled_words[0].word).toBe("ALPHA");

      // The store is still usable after the fault clears — a fresh
      // addEntry succeeds and updates both memory and disk.
      await store.addEntry({ date: "2026-05-10", word: "GAMMA", lang: "en" });
      const recovered = await store.getSnapshot();
      expect(recovered.scheduled_words.map((r) => r.word).sort()).toEqual([
        "ALPHA",
        "GAMMA"
      ]);
    } finally {
      await cleanup(dir);
    }
  });

  test("EACCES on initial load surfaces STORE_READ_FAILED", async () => {
    const { dir, filePath } = tempFilePath("schedule.json");
    try {
      // Pre-seed the file so it exists, then make reads fail.
      await fsp.writeFile(filePath, JSON.stringify({ version: 1 }), "utf8");
      const fault = installFaultyFs({
        readFile: {
          failOnce: { code: "EACCES", message: "permission denied (synthetic)" }
        }
      });
      try {
        const store = new ScheduleStore({ filePath, now: frozenNow() });
        await expect(store.load()).rejects.toMatchObject({
          code: "STORE_READ_FAILED"
        });
      } finally {
        fault.restore();
      }
    } finally {
      await cleanup(dir);
    }
  });
});

describe("challenge-config-store: fault-injection", () => {
  test("ENOSPC during commit surfaces a typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("challenges.json");
    try {
      const store = new ChallengeConfigStore({ filePath, now: frozenNow() });
      await store.load();
      const baseInput = {
        name: "First",
        lang: "en",
        puzzleCount: 5,
        timeBudgetSeconds: 300,
        maxGuesses: 6,
        speedBonusFactor: 0.5,
        perPuzzleScore: 1000,
        replayPolicy: "best"
      };
      await store.create(baseInput);
      expect((await store.load()).challenges).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.create({ ...baseInput, name: "Second" })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      // Prior state untouched on disk + in memory.
      const inMemory = await store.load();
      expect(inMemory.challenges).toHaveLength(1);
      expect(inMemory.challenges[0].name).toBe("First");

      const reloaded = JSON.parse(await fsp.readFile(filePath, "utf8"));
      expect(reloaded.challenges).toHaveLength(1);
      expect(reloaded.challenges[0].name).toBe("First");
    } finally {
      await cleanup(dir);
    }
  });
});

describe("challenge-results-store: fault-injection", () => {
  test("ENOSPC during createSession surfaces typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("challenge-results.json");
    try {
      const store = new ChallengeResultsStore({ filePath, now: frozenNow() });
      await store.load();
      // Seed one session so there's prior state.
      await store.createSession({
        challengeId: "c-alpha",
        profileId: "p-alpha",
        puzzles: [{ index: 0, word: "ALPHA", guesses: [], solved: false }]
      });
      expect((await store.load()).sessions).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.createSession({
            challengeId: "c-beta",
            profileId: "p-beta",
            puzzles: [{ index: 0, word: "BETAS", guesses: [], solved: false }]
          })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      // Prior state survives.
      const inMemory = await store.load();
      expect(inMemory.sessions).toHaveLength(1);
      const reloaded = JSON.parse(await fsp.readFile(filePath, "utf8"));
      expect(reloaded.sessions).toHaveLength(1);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("webhook-store: fault-injection", () => {
  test("rename failure mid-commit surfaces a typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("webhooks.json");
    try {
      const store = new WebhookStore({ filePath, now: frozenNow() });
      await store.load();
      await store.create({
        url: "https://example.com/first",
        events: ["daily.posted"],
        enabled: true
      });
      expect((await store.getSnapshot()).subscriptions).toHaveLength(1);

      const fault = installFaultyFs({
        rename: {
          failOnce: { code: "ENOSPC", message: "rename failed (synthetic)" }
        }
      });
      try {
        await expect(
          store.create({
            url: "https://example.com/second",
            events: ["daily.posted"],
            enabled: true
          })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      // After a failed atomic-rename, the destination file MUST
      // still reflect the prior committed state (writeJsonAtomic
      // writes to .tmp and only renames at the end). No torn write.
      const snap = await store.getSnapshot();
      expect(snap.subscriptions).toHaveLength(1);
      expect(snap.subscriptions[0].url).toBe("https://example.com/first");

      const reloaded = JSON.parse(await fsp.readFile(filePath, "utf8"));
      expect(reloaded.subscriptions).toHaveLength(1);
      expect(reloaded.subscriptions[0].url).toBe("https://example.com/first");

      // Recovery: a fresh create works after the fault clears.
      await store.create({
        url: "https://example.com/third",
        events: ["daily.posted"],
        enabled: true
      });
      expect((await store.getSnapshot()).subscriptions).toHaveLength(2);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("webhook-delivery-store: fault-injection", () => {
  test("ENOSPC during enqueue surfaces typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("webhook-deliveries.json");
    try {
      const store = new WebhookDeliveryStore({ filePath, now: frozenNow() });
      await store.load();
      await store.enqueue({
        subscriptionId: "sub-1",
        event: "daily.posted",
        url: "https://example.com/sink",
        payload: { ok: true }
      });
      expect((await store.getSnapshot()).deliveries).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.enqueue({
            subscriptionId: "sub-2",
            event: "daily.posted",
            url: "https://example.com/sink",
            payload: {}
          })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      const inMemory = await store.getSnapshot();
      expect(inMemory.deliveries).toHaveLength(1);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("push-subscription-store: fault-injection", () => {
  test("ENOSPC during upsert surfaces typed error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("push-subscriptions.json");
    try {
      const store = new PushSubscriptionStore({ filePath, now: frozenNow() });
      await store.load();
      await store.upsert({
        endpoint: "https://push.example.com/first",
        keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
      });
      expect((await store.getSnapshot()).subscriptions).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.upsert({
            endpoint: "https://push.example.com/second",
            keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) }
          })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      const inMemory = await store.getSnapshot();
      expect(inMemory.subscriptions).toHaveLength(1);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("admin-jobs-store: fault-injection", () => {
  test("ENOSPC (sync) during enqueue surfaces typed error; finding: in-memory state leaks", async () => {
    // admin-jobs-store persists via `fs.writeFileSync` (not the async
    // `fsp.writeFile` other stores use). The harness's sync-method
    // support covers this — the fault fires on the SYNC writeFileSync
    // call inside the store's #persist path.
    //
    // FINDING discovered by C3 — admin-jobs-store's `#enqueueWrite`
    // lacks the snapshot-restore wrapper that `classes-store.js` has
    // (lines 614-641). When `writeJsonAtomicSync` throws, the
    // already-pushed in-memory job stays in `this.state.jobs` even
    // though disk wasn't updated. Other stores either:
    //   - Use a draft + assign-after-persist pattern (leaderboard).
    //   - Wrap with clone-snapshot try/catch (classes).
    //
    // This test asserts the CURRENT behavior (jobs leak to in-memory)
    // and a follow-up task is filed to apply the classes-store
    // rollback pattern to admin-jobs-store. Once that lands, this
    // test's last assertion will need to change from
    // `toHaveLength(2)` back to `toHaveLength(1)`.
    const { dir, filePath } = tempFilePath("admin-jobs.json");
    try {
      const store = new AdminJobsStore({ filePath, now: frozenNow() });
      await store.load();
      await store.enqueueProviderImportJob({ provider: "test", language: "en" });
      expect((await store.getSnapshot()).jobs).toHaveLength(1);

      const fault = installFaultyFs({
        writeFileSync: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.enqueueProviderImportJob({ provider: "test", language: "es" })
        ).rejects.toMatchObject({ code: "STORE_WRITE_FAILED" });
      } finally {
        fault.restore();
      }

      // ON-DISK state preserved (the atomic-rename means the .tmp
      // write failed, so the destination file still reflects the
      // prior commit).
      const reloaded = JSON.parse(await fsp.readFile(filePath, "utf8"));
      expect(reloaded.jobs).toHaveLength(1);
      expect(reloaded.jobs[0].request.language).toBe("en");

      // IN-MEMORY state LEAKS — known issue, pending rollback fix.
      // The 2nd job was already pushed to `this.state.jobs` before
      // #persist failed; no snapshot-restore wrapper recovers it.
      const inMemory = await store.getSnapshot();
      expect(inMemory.jobs).toHaveLength(2);
    } finally {
      await cleanup(dir);
    }
  });
});

describe("classes-store: fault-injection", () => {
  test("ENOSPC during createClass surfaces an error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("classes.json");
    try {
      const store = new ClassesStore({
        filePath,
        now: frozenNow(),
        logger: { warn: () => {}, error: () => {} }
      });
      await store.load();
      await store.createClass("First");
      expect((await store.getSnapshot()).classes).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        // classes-store + leaderboard-store don't wrap fs errors into
        // STORE_WRITE_FAILED — they let the raw ENOSPC propagate. We
        // only assert the rejection + state preservation, not a
        // specific code. This is the actual contract today; if a
        // future refactor harmonizes error wrapping across stores,
        // tighten the assertion then.
        await expect(store.createClass("Second")).rejects.toThrow();
      } finally {
        fault.restore();
      }

      // Prior state preserved.
      const inMemory = await store.getSnapshot();
      expect(inMemory.classes).toHaveLength(1);
      expect(inMemory.classes[0].name).toBe("First");
    } finally {
      await cleanup(dir);
    }
  });
});

describe("leaderboard-store: fault-injection", () => {
  test("ENOSPC during mutate surfaces an error; prior state preserved", async () => {
    const { dir, filePath } = tempFilePath("leaderboard.json");
    try {
      const store = new LeaderboardStore({
        filePath,
        now: frozenNow(),
        logger: { warn: () => {}, error: () => {} }
      });
      await store.load();
      await store.mutate((draft) => {
        draft.profiles.push({
          id: "alpha",
          name: "Alpha",
          createdAt: "2026-05-11T00:00:00.000Z",
          updatedAt: "2026-05-11T00:00:00.000Z"
        });
      });
      expect((await store.getSnapshot()).profiles).toHaveLength(1);

      const fault = installFaultyFs({
        writeFile: {
          failOnce: { code: "ENOSPC", message: "disk full (synthetic)" }
        }
      });
      try {
        await expect(
          store.mutate((draft) => {
            draft.profiles.push({
              id: "beta",
              name: "Beta",
              createdAt: "2026-05-11T00:00:00.000Z",
              updatedAt: "2026-05-11T00:00:00.000Z"
            });
          })
        ).rejects.toThrow();
      } finally {
        fault.restore();
      }

      const inMemory = await store.getSnapshot();
      expect(inMemory.profiles).toHaveLength(1);
      expect(inMemory.profiles[0].id).toBe("alpha");
    } finally {
      await cleanup(dir);
    }
  });
});
