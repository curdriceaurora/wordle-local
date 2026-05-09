"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  reconcileDailyWord,
  decideReconcile,
  dateInTimezone,
  deterministicIndex,
  readAnswerPool
} = require("../lib/scheduler-tick");

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-tick-"));
  fs.mkdirSync(path.join(root, "data", "providers"), { recursive: true });
  return root;
}

function seedAnswerPool(projectRoot, variant, commit, words, fileName = "answer-pool-active.txt") {
  const dir = path.join(projectRoot, "data", "providers", variant, commit);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), words.join("\n") + "\n", "utf8");
  return path.join(projectRoot, "data", "providers");
}

function seedLanguages(projectRoot, languages) {
  const file = path.join(projectRoot, "data", "languages.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, languages }, null, 2),
    "utf8"
  );
  return file;
}

function makeSchedule(overrides = {}) {
  return {
    version: 1,
    updatedAt: "2026-05-01T00:00:00.000Z",
    timezone: "UTC",
    auto_rotate: false,
    retention_days: 90,
    scheduled_words: [],
    ...overrides
  };
}

describe("dateInTimezone", () => {
  test("converts an instant to the local YYYY-MM-DD in arbitrary zones", () => {
    // 2026-05-08T03:30:00Z is May 7 23:30 in America/New_York (EDT, UTC-4)
    const instant = new Date("2026-05-08T03:30:00Z");
    expect(dateInTimezone(instant, "UTC")).toBe("2026-05-08");
    expect(dateInTimezone(instant, "America/New_York")).toBe("2026-05-07");
    // 2026-05-08T03:30:00Z is May 8 13:30 in Pacific/Kiritimati (UTC+14)
    expect(dateInTimezone(instant, "Pacific/Kiritimati")).toBe("2026-05-08");
  });

  test("DST forward in America/New_York (2026-03-08 02:00 → 03:00)", () => {
    // 2026-03-08T07:00:00Z is 02:00 EST (just before spring forward) which
    // becomes 03:00 EDT — the local date is March 8 either way.
    expect(dateInTimezone(new Date("2026-03-08T07:00:00Z"), "America/New_York"))
      .toBe("2026-03-08");
    expect(dateInTimezone(new Date("2026-03-08T08:00:00Z"), "America/New_York"))
      .toBe("2026-03-08");
  });

  test("DST backward in America/New_York (2026-11-01 02:00 → 01:00)", () => {
    // 2026-11-01T05:00:00Z is 01:00 EDT (just before fall back), which
    // repeats as 01:00 EST. The local date stays Nov 1 throughout.
    expect(dateInTimezone(new Date("2026-11-01T05:00:00Z"), "America/New_York"))
      .toBe("2026-11-01");
    expect(dateInTimezone(new Date("2026-11-01T06:00:00Z"), "America/New_York"))
      .toBe("2026-11-01");
  });
});

describe("deterministicIndex", () => {
  test("same seed maps to same index", () => {
    const a = deterministicIndex("2026-05-08|en|abc", 100);
    const b = deterministicIndex("2026-05-08|en|abc", 100);
    expect(a).toBe(b);
  });

  test("different seeds map to (likely) different indices", () => {
    const a = deterministicIndex("2026-05-08|en|abc", 1000);
    const b = deterministicIndex("2026-05-09|en|abc", 1000);
    expect(a).not.toBe(b);
  });

  test("returns 0 for empty pool", () => {
    expect(deterministicIndex("seed", 0)).toBe(0);
  });
});

describe("readAnswerPool", () => {
  test("reads one word per line, drops blanks and comments", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-pool-"));
    const file = path.join(dir, "pool.txt");
    fs.writeFileSync(
      file,
      "# comment\n\nCRANE\nbread\n\n# another\nspeak\nnotaword!\n",
      "utf8"
    );
    const out = await readAnswerPool(file);
    expect(out).toEqual(["CRANE", "BREAD", "SPEAK"]);
  });

  test("returns empty array on missing file", async () => {
    const out = await readAnswerPool("/nonexistent/answer-pool.txt");
    expect(out).toEqual([]);
  });
});

describe("decideReconcile", () => {
  test("noop when no schedule provided", () => {
    expect(decideReconcile({ schedule: null, now: new Date() }))
      .toMatchObject({ action: "noop", reason: "NO_SCHEDULE" });
  });

  test("write-scheduled when there is a matching today entry and word.json is stale", () => {
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const out = decideReconcile({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en"
    });
    expect(out.action).toBe("write-scheduled");
    expect(out.scheduled.word).toBe("CRANE");
    expect(out.todayLocal).toBe("2026-05-08");
  });

  test("noop when word.json already matches (idempotent)", () => {
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const out = decideReconcile({
      schedule,
      currentWordData: {
        word: "CRANE",
        lang: "en",
        date: "2026-05-08",
        updatedAt: "2026-05-08T01:00:00Z",
        lastScheduledFor: "2026-05-08"
      },
      now: new Date("2026-05-08T12:00:00Z")
    });
    expect(out.action).toBe("noop");
    expect(out.reason).toBe("ALREADY_RECONCILED");
  });

  test("skip-manual-override when word.json is for today but lastScheduledFor isn't today", () => {
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const out = decideReconcile({
      schedule,
      // word.json was just written by POST /api/word — date matches today
      // but no lastScheduledFor, meaning the manual write is the most
      // recent action.
      currentWordData: {
        word: "MANUAL",
        lang: "en",
        date: "2026-05-08",
        updatedAt: "2026-05-08T11:00:00Z"
      },
      now: new Date("2026-05-08T12:00:00Z")
    });
    expect(out.action).toBe("skip-manual-override");
  });

  test("auto-rotate when no scheduled entry and auto_rotate is on", () => {
    const schedule = makeSchedule({ auto_rotate: true });
    const out = decideReconcile({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en"
    });
    expect(out.action).toBe("auto-rotate");
  });

  test("noop when no scheduled entry and auto_rotate is off", () => {
    const schedule = makeSchedule();
    const out = decideReconcile({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z")
    });
    expect(out.action).toBe("noop");
    expect(out.reason).toBe("NO_SCHEDULED_ENTRY_AND_AUTO_ROTATE_OFF");
  });

  test("language preference: scheduled entries for word.json's lang win over fallback", () => {
    const schedule = makeSchedule({
      scheduled_words: [
        { date: "2026-05-08", word: "BUEN", lang: "es" },
        { date: "2026-05-08", word: "CRANE", lang: "en" }
      ]
    });
    const out = decideReconcile({
      schedule,
      currentWordData: { word: "OLD", lang: "es", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en"
    });
    expect(out.action).toBe("write-scheduled");
    expect(out.scheduled.lang).toBe("es");
    expect(out.scheduled.word).toBe("BUEN");
  });
});

describe("reconcileDailyWord", () => {
  test("writes the scheduled word and bumps last_reconciled_for", async () => {
    const projectRoot = tempProject();
    const languagesPath = seedLanguages(projectRoot, [
      { id: "en", enabled: true, provider: { variant: "en-US", commit: "abc" } }
    ]);
    const writes = [];
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const reconcileEvents = [];
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData: async (data) => { writes.push(data); },
      recordReconcile: async (info) => { reconcileEvents.push(info); }
    });
    expect(result.action).toBe("write-scheduled");
    expect(writes).toHaveLength(1);
    expect(writes[0].word).toBe("CRANE");
    expect(writes[0].date).toBe("2026-05-08");
    expect(writes[0].lastScheduledFor).toBe("2026-05-08");
    expect(reconcileEvents).toEqual([
      { date: "2026-05-08", at: "2026-05-08T12:00:00.000Z" }
    ]);
  });

  test("idempotent: no write when word.json already matches", async () => {
    const writes = [];
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "CRANE",
        lang: "en",
        date: "2026-05-08",
        updatedAt: "2026-05-08T01:00:00Z",
        lastScheduledFor: "2026-05-08"
      },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("noop");
    expect(writes).toHaveLength(0);
  });

  test("manual override (today date, no lastScheduledFor) is left alone", async () => {
    const writes = [];
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "MANUAL",
        lang: "en",
        date: "2026-05-08",
        updatedAt: "2026-05-08T11:00:00Z"
      },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("skip-manual-override");
    expect(writes).toHaveLength(0);
  });

  test("auto-rotate noops on the second tick of the same day", async () => {
    const projectRoot = tempProject();
    seedAnswerPool(projectRoot, "en-US", "abc", ["APPLE", "BERRY", "CHIRP"]);
    const languagesPath = seedLanguages(projectRoot, [
      { id: "en", enabled: true, provider: { variant: "en-US", commit: "abc" } }
    ]);
    const schedule = makeSchedule({ auto_rotate: true });
    const writes = [];
    let currentWord = { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" };
    const saveWordData = async (data) => {
      currentWord = data;
      writes.push(data);
    };
    // First tick: writes the auto-rotate pick.
    const r1 = await reconcileDailyWord({
      schedule,
      currentWordData: currentWord,
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData
    });
    expect(r1.action).toBe("auto-rotate");
    expect(writes).toHaveLength(1);
    // Second tick on same day: should noop because the write would be
    // identical and we'd otherwise burn a fresh updatedAt every minute.
    const r2 = await reconcileDailyWord({
      schedule,
      currentWordData: currentWord,
      now: new Date("2026-05-08T13:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData
    });
    expect(r2.action).toBe("noop");
    expect(r2.reason).toBe("AUTO_ROTATE_ALREADY_RECONCILED");
    expect(writes).toHaveLength(1);
  });

  test("auto-rotate picks deterministically from the answer pool", async () => {
    const projectRoot = tempProject();
    seedAnswerPool(projectRoot, "en-US", "abc", ["APPLE", "BERRY", "CHIRP", "DREAM", "ELITE"]);
    const languagesPath = seedLanguages(projectRoot, [
      { id: "en", enabled: true, provider: { variant: "en-US", commit: "abc" } }
    ]);
    const schedule = makeSchedule({ auto_rotate: true });
    const writesA = [];
    const writesB = [];
    await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData: async (data) => { writesA.push(data); }
    });
    await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T13:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData: async (data) => { writesB.push(data); }
    });
    expect(writesA[0].word).toBe(writesB[0].word);
    expect(["APPLE", "BERRY", "CHIRP", "DREAM", "ELITE"]).toContain(writesA[0].word);
  });

  test("auto-rotate falls back to answer-pool.txt when active is missing", async () => {
    const projectRoot = tempProject();
    seedAnswerPool(projectRoot, "en-US", "abc", ["FALLB"], "answer-pool.txt");
    const languagesPath = seedLanguages(projectRoot, [
      { id: "en", enabled: true, provider: { variant: "en-US", commit: "abc" } }
    ]);
    const schedule = makeSchedule({ auto_rotate: true });
    const writes = [];
    await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(writes[0].word).toBe("FALLB");
  });

  test("auto-rotate skips silently when no answer pool exists", async () => {
    const projectRoot = tempProject();
    const languagesPath = seedLanguages(projectRoot, [
      { id: "en", enabled: true, provider: { variant: "en-US", commit: "abc" } }
    ]);
    const schedule = makeSchedule({ auto_rotate: true });
    const writes = [];
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-07", updatedAt: "2026-05-07T12:00:00Z" },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: path.join(projectRoot, "data", "providers"),
      languagesPath,
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("noop");
    expect(writes).toHaveLength(0);
  });

  test("rejects malformed pool entries that fall outside playable length", async () => {
    // Words 1-, 2-, 13-letter etc. should be filtered out by
    // readAnswerPool since the game can't accept them downstream.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-pool-len-"));
    const file = path.join(dir, "pool.txt");
    fs.writeFileSync(
      file,
      "AB\nABC\nABCDEFGHIJKLM\nCRANE\nBREAD\n",
      "utf8"
    );
    const out = await readAnswerPool(file);
    expect(out).toEqual(["ABC", "CRANE", "BREAD"]);
  });

  test("manual override with date=null is recognised", async () => {
    // POST /api/word with no body.date writes word.json with date=null.
    // The override gate must yield to it for the rest of the day even
    // though date doesn't equal serverToday — earlier code required a
    // string match and silently overwrote null-date manual writes.
    const writes = [];
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "CRANE", lang: "en" }]
    });
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "MANUAL",
        lang: "en",
        date: null,
        updatedAt: "2026-05-08T11:00:00Z"
        // no lastScheduledFor → manual write
      },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("skip-manual-override");
    expect(writes).toHaveLength(0);
  });

  test("null-date manual override expires at the next server-local midnight", async () => {
    // Operator did POST /api/word yesterday with no body.date. Today
    // the scheduler should reclaim ownership instead of treating the
    // null-date write as eternally fresh. Round-8's first attempt at
    // honoring null-date overrides made them never expire; this fix
    // uses updatedAt's server-local date as the effective day.
    const writes = [];
    const schedule = makeSchedule({
      scheduled_words: [{ date: "2026-05-08", word: "TODAY", lang: "en" }]
    });
    // Manual write was 24h+ ago by server-local clock.
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "MANUAL",
        lang: "en",
        date: null,
        updatedAt: "2026-05-07T11:00:00Z"
        // no lastScheduledFor → manual write
      },
      now: new Date("2026-05-08T12:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("write-scheduled");
    expect(writes).toHaveLength(1);
    expect(writes[0].word).toBe("TODAY");
  });

  test("scheduler-owned write for a previous schedule-local day is not treated as manual", async () => {
    // Pacific/Kiritimati is +14 from UTC. At 2026-05-08T11:00Z the
    // server is still on 2026-05-08 but the schedule already rolled
    // to 2026-05-09. The previous scheduler write has
    // lastScheduledFor=2026-05-08 (not "today" in schedule terms);
    // earlier code mis-classified that as a manual override and
    // skipped writing for the new schedule day. The fix: presence of
    // lastScheduledFor means scheduler ownership, regardless of value.
    const writes = [];
    const schedule = makeSchedule({
      timezone: "Pacific/Kiritimati",
      scheduled_words: [
        { date: "2026-05-08", word: "OLDER", lang: "en" },
        { date: "2026-05-09", word: "NEWER", lang: "en" }
      ]
    });
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "OLDER",
        lang: "en",
        date: "2026-05-08",
        updatedAt: "2026-05-08T01:00:00Z",
        lastScheduledFor: "2026-05-08"
      },
      now: new Date("2026-05-08T11:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("write-scheduled");
    expect(writes).toHaveLength(1);
    expect(writes[0].word).toBe("NEWER");
    expect(writes[0].lastScheduledFor).toBe("2026-05-09");
  });

  test("server-day rollover refreshes word.json.date even if schedule day didn't roll", async () => {
    // America/Los_Angeles is UTC-7. At 2026-05-08T07:30Z it's still
    // 2026-05-08 in LA but UTC just rolled to 2026-05-08 from
    // 2026-05-07. word.json from yesterday has date=2026-05-07
    // (server-local at write time) and lastScheduledFor=2026-05-07
    // (schedule-local). The schedule's entry for 2026-05-07 is still
    // "today" in LA but /daily compares against server-local
    // 2026-05-08 and would 404. The reconciler must rewrite to
    // refresh word.json.date.
    //
    // Wait — this test as written can't actually exercise the pure
    // server-day rollover because the schedule entry is still keyed
    // to "yesterday" from server's POV. The clearer scenario is
    // when the schedule entry IS for the new schedule-local day but
    // server day already rolled. Let's set that up: schedule entry
    // for 2026-05-08 (= today in LA at 03:00Z), and word.json
    // already reflects it but with date=2026-05-08 from when the
    // server was also on 2026-05-08; now suppose we tick later when
    // both zones agree. Idempotency should hold.
    //
    // The simplest test of "date refresh on stale-but-matching pick"
    // is: word.json.word matches scheduled.word, lastScheduledFor
    // matches todayLocal, but date differs from serverToday → write.
    const writes = [];
    const schedule = makeSchedule({
      timezone: "America/Los_Angeles",
      scheduled_words: [{ date: "2026-05-07", word: "CRANE", lang: "en" }]
    });
    // 2026-05-08T03:00Z = 2026-05-07 20:00 PDT → today in LA is May 7.
    const now = new Date("2026-05-08T03:00:00Z");
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: {
        word: "CRANE",
        lang: "en",
        date: "2026-05-06", // STALE server-local date
        updatedAt: "2026-05-06T18:00:00Z",
        lastScheduledFor: "2026-05-07"
      },
      now,
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    expect(result.action).toBe("write-scheduled");
    expect(writes).toHaveLength(1);
    expect(writes[0].word).toBe("CRANE");
    // The new write has the current server-local date.
    const expectedServerDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(writes[0].date).toBe(expectedServerDate);
  });

  test("word.json.date is server-local even when schedule TZ differs", async () => {
    // Schedule TZ is set to America/New_York but the test runner's
    // server-local zone is whatever Node sees. We need word.json.date
    // to reflect the server-local date so /daily's date gate (which
    // also uses server-local) lets the puzzle through. lastScheduledFor
    // should still reflect the schedule TZ for idempotency.
    const writes = [];
    const schedule = makeSchedule({
      timezone: "America/New_York",
      scheduled_words: [{ date: "2026-05-07", word: "CRANE", lang: "en" }]
    });
    const now = new Date("2026-05-08T03:30:00Z"); // May 7 23:30 EDT, May 8 03:30 UTC
    await reconcileDailyWord({
      schedule,
      currentWordData: { word: "OLD", lang: "en", date: "2026-05-06", updatedAt: "2026-05-06T12:00:00Z" },
      now,
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData: async (data) => { writes.push(data); }
    });
    // word.json.date matches server-local — getFullYear/Month/Date on
    // the Date instance. The expected value depends on the runner's
    // zone, so we compute it here the same way and compare.
    const expectedServerDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(writes[0].date).toBe(expectedServerDate);
    // lastScheduledFor still reflects the schedule's TZ — May 7 in NY,
    // not May 8 in UTC.
    expect(writes[0].lastScheduledFor).toBe("2026-05-07");
  });

  test("DST-forward day still triggers exactly one write", async () => {
    // 2026-03-08 is the DST-forward day in America/New_York. The reconciler
    // ticking at 03:30 EDT (07:30Z) and again at 04:00 EDT (08:00Z) should
    // see the same local date and write only once.
    const writes = [];
    const schedule = makeSchedule({
      timezone: "America/New_York",
      scheduled_words: [{ date: "2026-03-08", word: "SPRNG", lang: "en" }]
    });
    let currentWord = { word: "OLD", lang: "en", date: "2026-03-07", updatedAt: "2026-03-07T12:00:00Z" };
    const saveWordData = async (data) => {
      currentWord = data;
      writes.push(data);
    };
    let lastReconciledFor = null;
    const recordReconcile = async ({ date }) => { lastReconciledFor = date; };
    await reconcileDailyWord({
      schedule,
      currentWordData: currentWord,
      now: new Date("2026-03-08T07:30:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData,
      recordReconcile
    });
    await reconcileDailyWord({
      schedule,
      currentWordData: currentWord,
      now: new Date("2026-03-08T08:00:00Z"),
      defaultLang: "en",
      providersRoot: "/dev/null",
      languagesPath: "/dev/null",
      saveWordData,
      recordReconcile
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].date).toBe("2026-03-08");
    expect(lastReconciledFor).toBe("2026-03-08");
  });
});
