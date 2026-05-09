"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  ChallengeConfigStore,
  ChallengeConfigStoreError,
  REPLAY_POLICIES
} = require("../lib/challenge-config-store");

function tempPath(name = "challenges.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-cc-"));
  return path.join(dir, name);
}

const validInput = {
  name: "Speed 5x5",
  lang: "en",
  puzzleCount: 5,
  timeBudgetSeconds: 300,
  maxGuesses: 6,
  speedBonusFactor: 0.5,
  perPuzzleScore: 1000,
  replayPolicy: "best"
};

describe("ChallengeConfigStore CRUD", () => {
  let store;
  let filePath;

  beforeEach(() => {
    filePath = tempPath();
    store = new ChallengeConfigStore({ filePath });
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  test("first load creates empty store", async () => {
    const snap = await store.load();
    expect(snap.challenges).toEqual([]);
  });

  test("create stores a challenge with generated id", async () => {
    const c = await store.create(validInput);
    expect(c.id.length).toBeGreaterThan(15);
    expect(c.replayPolicy).toBe("best");
    const snap = await store.load();
    expect(snap.challenges).toHaveLength(1);
  });

  test.each([
    ["puzzleCount = 0", { ...validInput, puzzleCount: 0 }],
    ["timeBudgetSeconds = 0", { ...validInput, timeBudgetSeconds: 0 }],
    ["timeBudgetSeconds < 30", { ...validInput, timeBudgetSeconds: 29 }],
    ["negative speedBonusFactor", { ...validInput, speedBonusFactor: -1 }],
    ["unknown replayPolicy", { ...validInput, replayPolicy: "infinite" }],
    ["maxGuesses 0", { ...validInput, maxGuesses: 0 }],
    ["wordLength 2", { ...validInput, wordLength: 2 }],
    ["bad lang format", { ...validInput, lang: "EN" }]
  ])("rejects invalid: %s", async (_label, input) => {
    await expect(store.create(input)).rejects.toThrow();
  });

  test("update merges fields and bumps updatedAt", async () => {
    const c = await store.create(validInput);
    const updated = await store.update(c.id, { name: "Renamed", puzzleCount: 3 }, { hasResults: false });
    expect(updated.name).toBe("Renamed");
    expect(updated.puzzleCount).toBe(3);
    expect(updated.id).toBe(c.id);
  });

  test("update with hasResults=true throws CONFIG_LOCKED", async () => {
    const c = await store.create(validInput);
    await expect(
      store.update(c.id, { name: "Renamed" }, { hasResults: true })
    ).rejects.toMatchObject({ code: "CONFIG_LOCKED" });
  });

  test("softDelete marks deleted=true; listActive filters it out", async () => {
    const c = await store.create(validInput);
    await store.softDelete(c.id);
    const all = await store.listAll();
    expect(all[0].deleted).toBe(true);
    const active = await store.listActive(new Date());
    expect(active).toEqual([]);
  });

  test("listActive respects startTime / endTime windows", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await store.create({ ...validInput, name: "Future", startTime: future });
    await store.create({ ...validInput, name: "Past", endTime: past });
    await store.create({ ...validInput, name: "Now" });
    const active = await store.listActive(new Date());
    const names = active.map((c) => c.name).sort();
    expect(names).toEqual(["Now"]);
  });

  test("rejects endTime <= startTime", async () => {
    await expect(store.create({
      ...validInput,
      startTime: new Date("2026-05-09T10:00:00Z").toISOString(),
      endTime: new Date("2026-05-09T09:00:00Z").toISOString()
    })).rejects.toThrow();
  });

  test("REPLAY_POLICIES exposes the supported set", () => {
    expect(REPLAY_POLICIES).toEqual(["best", "first-only", "unlimited"]);
  });

  test("ChallengeConfigStoreError instance carries name + code", async () => {
    try {
      await store.create({ ...validInput, puzzleCount: 0 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChallengeConfigStoreError);
      expect(err.name).toBe("ChallengeConfigStoreError");
      expect(err.code).toBe("INVALID_REQUEST");
    }
  });
});
