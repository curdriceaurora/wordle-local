const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LeaderboardStore,
  createEmptyLeaderboardState,
  normalizeLeaderboardState
} = require("../lib/leaderboard-store");

function tempFilePath(name = "leaderboard.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-leaderboard-"));
  return path.join(dir, name);
}

function isoAt(daysFromEpoch) {
  return new Date(daysFromEpoch * 24 * 60 * 60 * 1000).toISOString();
}

describe("leaderboard-store", () => {
  test("creates and persists empty state when file is missing", async () => {
    const filePath = tempFilePath();
    const warn = jest.fn();
    const store = new LeaderboardStore({ filePath, logger: { warn } });

    const snapshot = await store.getSnapshot();

    expect(snapshot).toEqual(createEmptyLeaderboardState());
    expect(fs.existsSync(filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(createEmptyLeaderboardState());
    expect(warn).not.toHaveBeenCalled();
  });

  test("recovers malformed JSON to empty state", async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");
    const warn = jest.fn();
    const store = new LeaderboardStore({ filePath, logger: { warn } });

    const snapshot = await store.getSnapshot();

    expect(snapshot).toEqual(createEmptyLeaderboardState());
    expect(warn).toHaveBeenCalled();
  });

  test("normalizes invalid rows and unknown profile results", async () => {
    const filePath = tempFilePath();
    const payload = {
      version: 1,
      updatedAt: isoAt(5),
      profiles: [
        {
          id: "ava",
          name: "Ava",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        },
        {
          id: "bad",
          name: "123",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        }
      ],
      resultsByProfile: {
        ava: {
          "2026-02-20|en|abcde": {
            date: "2026-02-20",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2)
          },
          "bad-key": {
            date: "2026-02-20",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2)
          }
        },
        unknown: {
          "2026-02-20|en|abcde": {
            date: "2026-02-20",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2)
          }
        }
      }
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });
    const snapshot = await store.getSnapshot();

    expect(snapshot.profiles).toHaveLength(1);
    expect(snapshot.profiles[0].id).toBe("ava");
    expect(Object.keys(snapshot.resultsByProfile)).toEqual(["ava"]);
    expect(Object.keys(snapshot.resultsByProfile.ava)).toEqual(["2026-02-20|en|abcde"]);
  });

  test("enforces retention limits", async () => {
    const filePath = tempFilePath();

    const profiles = Array.from({ length: 5 }, (_, idx) => ({
      id: `p${idx + 1}`,
      name: `Player${String.fromCharCode(65 + idx)}`,
      createdAt: isoAt(idx + 1),
      updatedAt: isoAt(idx + 1)
    }));

    const results = {};
    for (let i = 1; i <= 5; i += 1) {
      const date = `2026-02-${String(i).padStart(2, "0")}`;
      results[`${date}|en|abcde`] = {
        date,
        won: true,
        attempts: 2,
        maxGuesses: 6,
        submissionCount: 1,
        updatedAt: isoAt(i + 10)
      };
    }

    const payload = {
      version: 1,
      updatedAt: isoAt(99),
      profiles,
      resultsByProfile: {
        p1: results
      }
    };

    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new LeaderboardStore({
      filePath,
      maxProfiles: 2,
      maxResultsPerProfile: 3,
      logger: { warn: jest.fn() }
    });

    const snapshot = await store.getSnapshot();

    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["p4", "p5"]);
    expect(snapshot.resultsByProfile.p1).toBeUndefined();
  });

  test("serializes concurrent mutations without losing updates", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });

    await Promise.all([
      store.mutate((draft) => {
        draft.profiles.push({
          id: "ava",
          name: "Ava",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        });
        draft.resultsByProfile.ava = {};
      }),
      store.mutate((draft) => {
        draft.profiles.push({
          id: "ben",
          name: "Ben",
          createdAt: isoAt(2),
          updatedAt: isoAt(2)
        });
        draft.resultsByProfile.ben = {};
      })
    ]);

    const snapshot = await store.getSnapshot();
    expect(snapshot.profiles.map((profile) => profile.id).sort()).toEqual(["ava", "ben"]);

    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.profiles.map((profile) => profile.id).sort()).toEqual(["ava", "ben"]);
  });

  test("does not persist failed mutation", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });
    const before = await store.getSnapshot();

    await expect(
      store.mutate(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const after = await store.getSnapshot();
    expect(after).toEqual(before);
  });

  test("normalize helper enforces won/attempt relationship", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(2),
      profiles: [
        {
          id: "ava",
          name: "Ava",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        }
      ],
      resultsByProfile: {
        ava: {
          "2026-02-20|en|abcde": {
            date: "2026-02-20",
            won: true,
            attempts: null,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(3)
          }
        }
      }
    };

    const normalized = normalizeLeaderboardState(payload);
    expect(normalized.state.resultsByProfile.ava).toBeUndefined();
    expect(normalized.hadInvalidContent).toBe(true);
  });
});
