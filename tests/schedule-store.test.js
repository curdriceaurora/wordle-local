"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  ScheduleStore,
  ScheduleStoreError,
  buildDefaultSchedule,
  normalizeSchedule,
  normalizeEntry,
  isIanaTimezone
} = require("../lib/schedule-store");

function tempPath(name = "schedule.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-schedule-"));
  return path.join(dir, name);
}

function frozenNow(iso = "2026-05-08T00:00:00.000Z") {
  return () => new Date(iso);
}

describe("schedule-store helpers", () => {
  test("isIanaTimezone accepts known zones and rejects garbage", () => {
    expect(isIanaTimezone("America/New_York")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("Europe/London")).toBe(true);
    expect(isIanaTimezone("Not/A/Zone")).toBe(false);
    expect(isIanaTimezone("")).toBe(false);
    expect(isIanaTimezone(null)).toBe(false);
    expect(isIanaTimezone(123)).toBe(false);
  });

  test("buildDefaultSchedule returns a valid empty schedule", () => {
    const def = buildDefaultSchedule();
    expect(def.version).toBe(1);
    expect(def.timezone).toBe("UTC");
    expect(def.auto_rotate).toBe(false);
    expect(def.retention_days).toBe(90);
    expect(def.scheduled_words).toEqual([]);
    expect(typeof def.updatedAt).toBe("string");
  });

  test("normalizeEntry uppercases word, trims, and rejects shape violations", () => {
    expect(
      normalizeEntry({ date: "2026-05-08", word: "crane", lang: "en" })
    ).toEqual({ date: "2026-05-08", word: "CRANE", lang: "en" });
    expect(() =>
      normalizeEntry({ date: "5/8/2026", word: "crane", lang: "en" })
    ).toThrow(expect.objectContaining({ code: "INVALID_DATE" }));
    expect(() =>
      normalizeEntry({ date: "2026-05-08", word: "1234", lang: "en" })
    ).toThrow(expect.objectContaining({ code: "INVALID_WORD" }));
    expect(() =>
      normalizeEntry({ date: "2026-05-08", word: "crane", lang: "ENGLISH" })
    ).toThrow(expect.objectContaining({ code: "INVALID_LANG" }));
    expect(() =>
      normalizeEntry({
        date: "2026-05-08",
        word: "crane",
        lang: "en",
        notes: "x".repeat(201)
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_NOTES" }));
    // notes optional → undefined accepted
    expect(
      normalizeEntry({ date: "2026-05-08", word: "crane", lang: "en", notes: "" })
    ).toEqual({ date: "2026-05-08", word: "CRANE", lang: "en" });
  });

  test("normalizeSchedule sorts entries and rejects unknown timezone", () => {
    const out = normalizeSchedule({
      version: 1,
      updatedAt: "2026-05-01T00:00:00.000Z",
      timezone: "America/New_York",
      auto_rotate: false,
      retention_days: 90,
      scheduled_words: [
        { date: "2026-05-09", word: "BREAD", lang: "en" },
        { date: "2026-05-08", word: "CRANE", lang: "en" }
      ]
    });
    expect(out.scheduled_words.map((row) => row.date)).toEqual([
      "2026-05-08",
      "2026-05-09"
    ]);
    expect(() =>
      normalizeSchedule({
        version: 1,
        updatedAt: "2026-05-01T00:00:00.000Z",
        timezone: "Not/A/Zone",
        auto_rotate: false,
        retention_days: 90,
        scheduled_words: []
      })
    ).toThrow(expect.objectContaining({ code: "INVALID_TIMEZONE" }));
  });

  test("normalizeSchedule rejects unsupported version", () => {
    expect(() =>
      normalizeSchedule({
        version: 2,
        updatedAt: "2026-05-01T00:00:00.000Z",
        timezone: "UTC",
        auto_rotate: false,
        retention_days: 90,
        scheduled_words: []
      })
    ).toThrow(expect.objectContaining({ code: "VERSION_UNSUPPORTED" }));
  });

  test("normalizeSchedule rejects duplicates on write but tolerates on load", () => {
    const data = {
      version: 1,
      updatedAt: "2026-05-01T00:00:00.000Z",
      timezone: "UTC",
      auto_rotate: false,
      retention_days: 90,
      scheduled_words: [
        { date: "2026-05-08", word: "CRANE", lang: "en" },
        { date: "2026-05-08", word: "BREAD", lang: "en" }
      ]
    };
    expect(() => normalizeSchedule(data)).toThrow(expect.objectContaining({ code: "DUPLICATE_ENTRY" }));
    const loaded = normalizeSchedule(data, { tolerateDuplicates: true });
    expect(loaded.scheduled_words).toHaveLength(1);
    expect(loaded.scheduled_words[0].word).toBe("CRANE");
  });
});

describe("ScheduleStore", () => {
  test("creates default file on first load when missing", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({
      filePath,
      now: frozenNow(),
      defaultTimezone: "America/New_York"
    });
    const loaded = await store.load();
    expect(loaded.version).toBe(1);
    expect(loaded.timezone).toBe("America/New_York");
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(onDisk.timezone).toBe("America/New_York");
  });

  test("hard-fails on JSON parse error rather than overwriting", async () => {
    const filePath = tempPath();
    fs.writeFileSync(filePath, "not json", "utf8");
    const store = new ScheduleStore({ filePath });
    await expect(store.load()).rejects.toThrow(expect.objectContaining({ code: "STORE_PARSE_FAILED" }));
    expect(fs.readFileSync(filePath, "utf8")).toBe("not json");
  });

  test("addEntry rejects duplicates without overwrite, accepts with overwrite", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    const r1 = await store.addEntry({ date: "2026-05-08", word: "CRANE", lang: "en" });
    expect(r1.replaced).toBe(false);
    await expect(
      store.addEntry({ date: "2026-05-08", word: "BREAD", lang: "en" })
    ).rejects.toThrow(expect.objectContaining({ code: "DUPLICATE_ENTRY" }));
    const r2 = await store.addEntry(
      { date: "2026-05-08", word: "BREAD", lang: "en" },
      { overwrite: true }
    );
    expect(r2.replaced).toBe(true);
    expect(r2.entry.word).toBe("BREAD");
    const snapshot = await store.getSnapshot();
    expect(snapshot.scheduled_words).toHaveLength(1);
    expect(snapshot.scheduled_words[0].word).toBe("BREAD");
  });

  test("updateEntry partial-edits an existing row", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    await store.addEntry({ date: "2026-05-08", word: "CRANE", lang: "en", notes: "first" });
    const r = await store.updateEntry("2026-05-08", "en", { word: "BREAD" });
    expect(r.entry.word).toBe("BREAD");
    expect(r.entry.notes).toBe("first");
    // Empty notes drops the field.
    const r2 = await store.updateEntry("2026-05-08", "en", { notes: "" });
    expect(r2.entry.notes).toBeUndefined();
  });

  test("removeEntry deletes a matching row and 404s otherwise", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    await store.addEntry({ date: "2026-05-08", word: "CRANE", lang: "en" });
    const r = await store.removeEntry("2026-05-08", "en");
    expect(r.entry.word).toBe("CRANE");
    await expect(store.removeEntry("2026-05-08", "en")).rejects.toThrow(expect.objectContaining({ code: "ENTRY_NOT_FOUND" }));
  });

  test("setConfig validates each field independently", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    await store.setConfig({ auto_rotate: true, retention_days: 30 });
    const snap = await store.getSnapshot();
    expect(snap.auto_rotate).toBe(true);
    expect(snap.retention_days).toBe(30);
    await expect(store.setConfig({ timezone: "Not/A/Zone" })).rejects.toThrow(expect.objectContaining({ code: "INVALID_TIMEZONE" }));
    await expect(store.setConfig({ retention_days: -1 })).rejects.toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    await expect(store.setConfig({ auto_rotate: "yes" })).rejects.toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  test("pruneBefore drops past entries", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    await store.addEntry({ date: "2026-04-01", word: "EARLY", lang: "en" });
    await store.addEntry({ date: "2026-05-01", word: "MIDDY", lang: "en" });
    await store.addEntry({ date: "2026-06-01", word: "LATER", lang: "en" });
    const r = await store.pruneBefore("2026-05-01");
    expect(r.pruned).toBe(1);
    const snap = await store.getSnapshot();
    expect(snap.scheduled_words.map((row) => row.date)).toEqual(["2026-05-01", "2026-06-01"]);
  });

  test("recordReconcile bumps timestamps without touching scheduled_words", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow("2026-05-08T01:00:00Z") });
    await store.load();
    await store.addEntry({ date: "2026-05-08", word: "CRANE", lang: "en" });
    await store.recordReconcile({ date: "2026-05-08" });
    const snap = await store.getSnapshot();
    expect(snap.last_reconciled_for).toBe("2026-05-08");
    expect(typeof snap.last_reconciled_at).toBe("string");
    expect(snap.scheduled_words).toHaveLength(1);
  });

  test("atomic write: temp file is removed after successful rename", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    await store.addEntry({ date: "2026-05-08", word: "CRANE", lang: "en" });
    const dir = path.dirname(filePath);
    const stragglers = (await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  test("concurrent first load() calls share a single ENOENT default-write", async () => {
    // Without loadPromise serialization, two concurrent first callers
    // would each see ENOENT, each persist a fresh empty schedule, and
    // a default write that lands after a real commit could clobber it.
    // With the shared loadPromise both callers await the same first
    // disk write and end up with the same state object.
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    const [a, b] = await Promise.all([store.load(), store.load()]);
    expect(a).toEqual(b);
    expect(a.scheduled_words).toEqual([]);
    // No straggler temp files (would be a sign of two concurrent default-writes).
    const dir = path.dirname(filePath);
    const tmps = (await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });

  test("commits run sequentially even when fired concurrently", async () => {
    // Two concurrent mutations with the same pre-mutation in-memory
    // snapshot would, without commitQueue serialization, each clone the
    // same baseline and the later write would silently drop the earlier
    // one. Fire 5 addEntry calls in parallel and assert all 5 entries
    // land in the final state.
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    // The WORD_PATTERN is strict A-Z, so we vary the word body without
    // using digits. Five distinct A-Z words are enough to prove
    // serialization without overloading the test.
    const words = ["AAAAA", "BBBBB", "CCCCC", "DDDDD", "EEEEE"];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.addEntry({
          date: `2026-05-0${i + 1}`,
          word: words[i],
          lang: "en"
        })
      )
    );
    const snap = await store.getSnapshot();
    expect(snap.scheduled_words).toHaveLength(5);
    const dates = snap.scheduled_words.map((row) => row.date).sort();
    expect(dates).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05"
    ]);
  });

  test("ScheduleStoreError carries error code", async () => {
    const filePath = tempPath();
    const store = new ScheduleStore({ filePath, now: frozenNow() });
    await store.load();
    try {
      await store.addEntry({ date: "bad", word: "CRANE", lang: "en" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleStoreError);
      expect(err.code).toBe("INVALID_DATE");
    }
  });
});
