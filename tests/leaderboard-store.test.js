const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LeaderboardStore,
  LeaderboardStoreError,
  createEmptyLeaderboardState,
  normalizeLeaderboardState,
  resolveMergeConflict
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

  test("prunes excess results per profile using date and updatedAt", async () => {
    const filePath = tempFilePath();
    const payload = {
      version: 1,
      updatedAt: isoAt(99),
      profiles: [
        {
          id: "p1",
          name: "PlayerOne",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        }
      ],
      resultsByProfile: {
        p1: {
          "2026-02-01|en|first": {
            date: "2026-02-01",
            won: true,
            attempts: 2,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(1)
          },
          "2026-02-01|en|second": {
            date: "2026-02-01",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2)
          },
          "2026-02-02|en|third": {
            date: "2026-02-02",
            won: false,
            attempts: null,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(3)
          },
          "2026-02-03|en|fourth": {
            date: "2026-02-03",
            won: true,
            attempts: 1,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(4)
          }
        }
      }
    };

    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new LeaderboardStore({
      filePath,
      maxProfiles: 10,
      maxResultsPerProfile: 3,
      logger: { warn: jest.fn() }
    });

    const snapshot = await store.getSnapshot();
    const profileResults = snapshot.resultsByProfile.p1;
    const resultKeys = Object.keys(profileResults).sort();

    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["p1"]);
    expect(resultKeys).toHaveLength(3);
    expect(resultKeys).not.toContain("2026-02-01|en|first");
    expect(resultKeys).toContain("2026-02-01|en|second");
    expect(resultKeys).toContain("2026-02-02|en|third");
    expect(resultKeys).toContain("2026-02-03|en|fourth");
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

  test("normalize helper treats pruned-profile results as pruning, not invalid content", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(10),
      profiles: [
        { id: "p1", name: "PlayerA", createdAt: isoAt(1), updatedAt: isoAt(1) },
        { id: "p2", name: "PlayerB", createdAt: isoAt(2), updatedAt: isoAt(2) },
        { id: "p3", name: "PlayerC", createdAt: isoAt(3), updatedAt: isoAt(3) }
      ],
      resultsByProfile: {
        p1: {
          "2026-02-01|en|alpha": {
            date: "2026-02-01",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(4)
          }
        }
      }
    };

    const normalized = normalizeLeaderboardState(payload, { maxProfiles: 2 });

    expect(normalized.hadInvalidContent).toBe(false);
    expect(normalized.wasPruned).toBe(true);
    expect(normalized.state.profiles.map((profile) => profile.id)).toEqual(["p2", "p3"]);
    expect(normalized.state.resultsByProfile.p1).toBeUndefined();
  });

  test("normalize helper rejects non-ISO timestamps, whitespace-normalized profiles, and coerced numbers", () => {
    const payload = {
      version: 1,
      updatedAt: "2/20/2026",
      profiles: [
        {
          id: " ava ",
          name: "Ava ",
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
            maxGuesses: "6",
            submissionCount: "1",
            updatedAt: isoAt(2)
          }
        }
      }
    };

    const normalized = normalizeLeaderboardState(payload);
    expect(normalized.hadInvalidContent).toBe(true);
    expect(normalized.state.updatedAt).toBe(new Date(0).toISOString());
    expect(normalized.state.profiles).toEqual([]);
    expect(normalized.state.resultsByProfile).toEqual({});
  });

  test("invalid retention options fall back to defaults", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(10),
      profiles: Array.from({ length: 21 }, (_, idx) => ({
        id: `p${idx + 1}`,
        name: `Player${String.fromCharCode(65 + (idx % 26))}`,
        createdAt: isoAt(idx + 1),
        updatedAt: isoAt(idx + 1)
      })),
      resultsByProfile: {}
    };

    const normalized = normalizeLeaderboardState(payload, {
      maxProfiles: 0,
      maxResultsPerProfile: 0
    });
    expect(normalized.state.profiles).toHaveLength(20);
    expect(normalized.wasPruned).toBe(true);
  });

  test("normalization rewrites profile rows with unknown properties", async () => {
    const filePath = tempFilePath();
    const warn = jest.fn();
    const payload = {
      version: 1,
      updatedAt: isoAt(5),
      profiles: [
        {
          id: "ava",
          name: "Ava",
          createdAt: isoAt(1),
          updatedAt: isoAt(1),
          extra: "drop-me"
        }
      ],
      resultsByProfile: {}
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new LeaderboardStore({ filePath, logger: { warn } });
    const snapshot = await store.getSnapshot();
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));

    expect(snapshot.profiles[0]).toEqual({
      id: "ava",
      name: "Ava",
      createdAt: isoAt(1),
      updatedAt: isoAt(1)
    });
    expect(persisted.profiles[0].extra).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test("normalization rejects unsafe profile IDs used as object keys", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(5),
      profiles: [
        {
          id: "__proto__",
          name: "Proto",
          createdAt: isoAt(1),
          updatedAt: isoAt(1)
        }
      ],
      resultsByProfile: {
        "__proto__": {
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

    const normalized = normalizeLeaderboardState(payload);
    expect(normalized.hadInvalidContent).toBe(true);
    expect(normalized.state.profiles).toEqual([]);
    expect(normalized.state.resultsByProfile).toEqual({});
  });

  test("normalization rewrites result rows with unknown properties", async () => {
    const filePath = tempFilePath();
    const warn = jest.fn();
    const payload = {
      version: 1,
      updatedAt: isoAt(5),
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
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2),
            extra: "drop-me"
          }
        }
      }
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new LeaderboardStore({ filePath, logger: { warn } });
    await store.getSnapshot();
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));

    expect(persisted.resultsByProfile.ava["2026-02-20|en|abcde"].extra).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test("normalization uses null-prototype maps for keyed state", () => {
    const payload = {
      version: 1,
      updatedAt: isoAt(10),
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
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: isoAt(2)
          }
        }
      }
    };

    const normalized = normalizeLeaderboardState(payload);
    expect(Object.getPrototypeOf(normalized.state.resultsByProfile)).toBeNull();
    expect(Object.getPrototypeOf(normalized.state.resultsByProfile.ava)).toBeNull();
  });

  test("fails load for unsupported on-disk schema version", async () => {
    const filePath = tempFilePath();
    const payload = {
      version: 2,
      updatedAt: isoAt(5),
      profiles: [],
      resultsByProfile: {},
      futureField: { keep: true }
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });

    await expect(store.getSnapshot()).rejects.toThrow("Unsupported leaderboard schema version: 2");
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(persisted.version).toBe(2);
    expect(persisted.futureField).toEqual({ keep: true });
  });
});

function buildResult(overrides = {}) {
  return {
    date: "2026-02-01",
    won: true,
    attempts: 4,
    maxGuesses: 6,
    submissionCount: 1,
    updatedAt: isoAt(40),
    ...overrides
  };
}

describe("resolveMergeConflict", () => {
  test("prefers higher submissionCount", () => {
    const left = buildResult({ submissionCount: 3 });
    const right = buildResult({ submissionCount: 1 });
    expect(resolveMergeConflict(left, right)).toBe(left);
    expect(resolveMergeConflict(right, left)).toBe(left);
  });

  test("prefers a winning result when submissionCount ties", () => {
    const won = buildResult({ submissionCount: 2, won: true, attempts: 4 });
    const lost = buildResult({ submissionCount: 2, won: false, attempts: null });
    expect(resolveMergeConflict(won, lost)).toBe(won);
    expect(resolveMergeConflict(lost, won)).toBe(won);
  });

  test("prefers fewer attempts when both wins tie on submissionCount", () => {
    const fast = buildResult({ submissionCount: 2, won: true, attempts: 3 });
    const slow = buildResult({ submissionCount: 2, won: true, attempts: 5 });
    expect(resolveMergeConflict(fast, slow)).toBe(fast);
    expect(resolveMergeConflict(slow, fast)).toBe(fast);
  });

  test("prefers newer updatedAt when everything else ties", () => {
    const newer = buildResult({ updatedAt: isoAt(50) });
    const older = buildResult({ updatedAt: isoAt(40) });
    expect(resolveMergeConflict(newer, older)).toBe(newer);
    expect(resolveMergeConflict(older, newer)).toBe(newer);
  });

  test("returns left on a complete tie (stable)", () => {
    const left = buildResult();
    const right = buildResult();
    expect(resolveMergeConflict(left, right)).toBe(left);
  });
});

describe("leaderboard-store: deleteProfile", () => {
  test("removes profile and all associated results atomically", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });

    await store.mutate((draft) => {
      draft.profiles.push({
        id: "p1",
        name: "Ava",
        createdAt: isoAt(1),
        updatedAt: isoAt(1)
      });
      draft.profiles.push({
        id: "p2",
        name: "Ben",
        createdAt: isoAt(2),
        updatedAt: isoAt(2)
      });
      draft.resultsByProfile.p1 = {
        "2026-02-01|en|abcde": buildResult()
      };
      draft.resultsByProfile.p2 = {
        "2026-02-01|en|abcde": buildResult()
      };
    });

    const snapshot = await store.deleteProfile("p1");

    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["p2"]);
    expect(snapshot.resultsByProfile.p1).toBeUndefined();
    expect(snapshot.resultsByProfile.p2).toBeDefined();

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(persisted.profiles.map((profile) => profile.id)).toEqual(["p2"]);
    expect(persisted.resultsByProfile.p1).toBeUndefined();
  });

  test("throws PROFILE_NOT_FOUND for unknown ids", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await expect(store.deleteProfile("missing")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND"
    });
  });

  test("rejects empty profile id", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await expect(store.deleteProfile("")).rejects.toBeInstanceOf(LeaderboardStoreError);
    await expect(store.deleteProfile("  ")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("leaderboard-store: mergeProfiles", () => {
  function seedTwoProfiles(store) {
    return store.mutate((draft) => {
      draft.profiles.push({
        id: "src",
        name: "Source",
        createdAt: isoAt(1),
        updatedAt: isoAt(1)
      });
      draft.profiles.push({
        id: "dst",
        name: "Target",
        createdAt: isoAt(2),
        updatedAt: isoAt(2)
      });
    });
  }

  function ensureResultBucket(draft, profileId) {
    if (!draft.resultsByProfile[profileId]) {
      draft.resultsByProfile[profileId] = Object.create(null);
    }
    return draft.resultsByProfile[profileId];
  }

  test("merges results, deletes source, and updates target updatedAt", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });
    await seedTwoProfiles(store);
    await store.mutate((draft) => {
      const src = ensureResultBucket(draft, "src");
      const dst = ensureResultBucket(draft, "dst");
      src["2026-02-01|en|abcde"] = buildResult({
        submissionCount: 1,
        attempts: 4,
        updatedAt: isoAt(40)
      });
      src["2026-02-02|en|fghij"] = buildResult({
        date: "2026-02-02",
        attempts: 3,
        updatedAt: isoAt(41)
      });
      dst["2026-02-03|en|klmno"] = buildResult({
        date: "2026-02-03",
        attempts: 5,
        updatedAt: isoAt(42)
      });
    });

    const snapshot = await store.mergeProfiles("src", "dst");

    expect(snapshot.profiles.map((profile) => profile.id)).toEqual(["dst"]);
    expect(snapshot.resultsByProfile.src).toBeUndefined();
    expect(Object.keys(snapshot.resultsByProfile.dst).sort()).toEqual([
      "2026-02-01|en|abcde",
      "2026-02-02|en|fghij",
      "2026-02-03|en|klmno"
    ]);
    const targetProfile = snapshot.profiles.find((profile) => profile.id === "dst");
    expect(targetProfile.updatedAt > isoAt(2)).toBe(true);
  });

  test("applies conflict policy on overlapping daily keys", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await seedTwoProfiles(store);
    await store.mutate((draft) => {
      const src = ensureResultBucket(draft, "src");
      const dst = ensureResultBucket(draft, "dst");
      src["2026-02-01|en|abcde"] = buildResult({
        submissionCount: 3,
        attempts: 5,
        won: true,
        updatedAt: isoAt(40)
      });
      dst["2026-02-01|en|abcde"] = buildResult({
        submissionCount: 1,
        attempts: 3,
        won: true,
        updatedAt: isoAt(50)
      });
    });

    const snapshot = await store.mergeProfiles("src", "dst");
    const merged = snapshot.resultsByProfile.dst["2026-02-01|en|abcde"];

    expect(merged.submissionCount).toBe(3);
    expect(merged.attempts).toBe(5);
    expect(merged.updatedAt).toBe(isoAt(40));
  });

  test("rejects merging into self and unknown profiles", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await seedTwoProfiles(store);

    await expect(store.mergeProfiles("src", "src")).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(store.mergeProfiles("", "dst")).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(store.mergeProfiles("src", "missing")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND"
    });
    await expect(store.mergeProfiles("missing", "dst")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND"
    });
  });

  test("does not persist anything when merge fails mid-mutation", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({ filePath, logger: { warn: jest.fn() } });
    await seedTwoProfiles(store);

    const snapshotBefore = await store.getSnapshot();

    await expect(store.mergeProfiles("src", "missing")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND"
    });

    const snapshotAfter = await store.getSnapshot();
    expect(snapshotAfter.profiles).toEqual(snapshotBefore.profiles);
    expect(snapshotAfter.resultsByProfile).toEqual(snapshotBefore.resultsByProfile);
  });
});

describe("leaderboard-store: setLimits", () => {
  test("raises maxProfiles and persists the new cap on subsequent mutate", async () => {
    const filePath = tempFilePath();
    const store = new LeaderboardStore({
      filePath,
      logger: { warn: jest.fn() },
      maxProfiles: 5
    });
    await store.getSnapshot();

    const next = store.setLimits({ maxProfiles: 10 });
    expect(next).toEqual({ maxProfiles: 10, maxResultsPerProfile: 400 });
  });

  test("rejects lowering maxProfiles below current profile count", async () => {
    const store = new LeaderboardStore({
      filePath: tempFilePath(),
      logger: { warn: jest.fn() },
      maxProfiles: 50
    });

    await store.mutate((draft) => {
      for (let i = 0; i < 3; i += 1) {
        draft.profiles.push({
          id: `p${i + 1}`,
          name: `Player${String.fromCharCode(65 + i)}`,
          createdAt: isoAt(i + 1),
          updatedAt: isoAt(i + 1)
        });
      }
    });

    expect(() => store.setLimits({ maxProfiles: 2 })).toThrow(/Cannot lower maxProfiles/);
    expect(store.maxProfiles).toBe(50);
  });

  test("rejects non-integer values", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await store.getSnapshot();

    expect(() => store.setLimits({ maxProfiles: "abc" })).toThrow(/positive integer/);
    expect(() => store.setLimits({ maxResultsPerProfile: 0 })).toThrow(/positive integer/);
  });

  test("validates both options before mutating either", async () => {
    const store = new LeaderboardStore({
      filePath: tempFilePath(),
      logger: { warn: jest.fn() },
      maxProfiles: 25,
      maxResultsPerProfile: 200
    });
    await store.getSnapshot();

    expect(() =>
      store.setLimits({ maxProfiles: 100, maxResultsPerProfile: 0 })
    ).toThrow(/positive integer/);
    expect(store.maxProfiles).toBe(25);
    expect(store.maxResultsPerProfile).toBe(200);

    expect(() =>
      store.setLimits({ maxProfiles: "bad", maxResultsPerProfile: 800 })
    ).toThrow(/positive integer/);
    expect(store.maxProfiles).toBe(25);
    expect(store.maxResultsPerProfile).toBe(200);

    const next = store.setLimits({ maxProfiles: 100, maxResultsPerProfile: 800 });
    expect(next).toEqual({ maxProfiles: 100, maxResultsPerProfile: 800 });
  });
});

describe("leaderboard-store: deleteProfile expectedName", () => {
  test("rejects with PROFILE_NAME_MISMATCH when stored name disagrees with caller", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await store.mutate((draft) => {
      draft.profiles.push({
        id: "p1",
        name: "Ava",
        createdAt: isoAt(1),
        updatedAt: isoAt(1)
      });
    });

    await expect(
      store.deleteProfile("p1", { expectedName: "Avery" })
    ).rejects.toMatchObject({ code: "PROFILE_NAME_MISMATCH" });

    const snapshot = await store.getSnapshot();
    expect(snapshot.profiles.find((profile) => profile.id === "p1")).toBeDefined();
  });

  test("succeeds when the expectedName matches", async () => {
    const store = new LeaderboardStore({ filePath: tempFilePath(), logger: { warn: jest.fn() } });
    await store.mutate((draft) => {
      draft.profiles.push({
        id: "p1",
        name: "Ava",
        createdAt: isoAt(1),
        updatedAt: isoAt(1)
      });
    });

    const snapshot = await store.deleteProfile("p1", { expectedName: "Ava" });
    expect(snapshot.profiles).toHaveLength(0);
  });
});
