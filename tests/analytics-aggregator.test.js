"use strict";

const { aggregate, SUPPORTED_WINDOWS } = require("../lib/analytics-aggregator");

const FIXED_GENERATED_AT = "2026-05-07T12:00:00.000Z";

function makeProfile(id, name, createdAt = "2026-04-01T12:00:00Z") {
  return {
    id,
    name,
    createdAt,
    updatedAt: createdAt
  };
}

function makeResult({
  date,
  lang = "en",
  code = "base",
  won,
  attempts,
  maxGuesses = 6,
  submissionCount = 1,
  updatedAt
}) {
  return {
    key: `${date}|${lang}|${code}`,
    entry: {
      date,
      won,
      attempts: won ? attempts : null,
      maxGuesses,
      submissionCount,
      updatedAt: updatedAt || `${date}T12:00:00.000Z`
    }
  };
}

function emptySnapshot() {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    profiles: [],
    resultsByProfile: {}
  };
}

function snapshotWith(profiles, resultsByProfile) {
  return {
    version: 1,
    updatedAt: "2026-05-07T12:00:00.000Z",
    profiles,
    resultsByProfile
  };
}

describe("analytics-aggregator", () => {
  describe("aggregate() empty snapshot", () => {
    test("returns zeroed summary and empty distributions", () => {
      const out = aggregate(emptySnapshot(), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      expect(out.window).toBe("7d");
      expect(out.generatedAt).toBe(FIXED_GENERATED_AT);
      expect(out.summary).toEqual({
        dau: 0,
        wau: 0,
        gamesInWindow: 0,
        winRate: 0,
        avgAttempts: 0,
        replayRate: 0,
        profileCount: 0
      });
      expect(out.series.dailyActive).toHaveLength(7);
      expect(out.series.dailyActive[0]).toEqual({ date: "2026-05-01", value: 0 });
      expect(out.series.dailyActive[6]).toEqual({ date: "2026-05-07", value: 0 });
      expect(out.series.dailyGames).toHaveLength(7);
      expect(out.series.profileGrowth).toHaveLength(7);
      expect(out.distributions.attempts).toHaveLength(12); // 1..10 + 11+ + dnf
      expect(out.distributions.languageMix).toEqual([]);
      expect(out.distributions.hourOfDay).toHaveLength(24);
      // Every hour bucket present, all zero.
      expect(out.distributions.hourOfDay.every((h) => h.value === 0)).toBe(true);
    });
  });

  describe("aggregate() sparse fixture", () => {
    test("counts wins, DAU, and attempts buckets", () => {
      const r1 = makeResult({ date: "2026-05-07", won: true, attempts: 3 });
      const r2 = makeResult({ date: "2026-05-06", won: true, attempts: 5 });
      const r3 = makeResult({ date: "2026-05-05", won: false });
      const profiles = [makeProfile("p1", "Alice"), makeProfile("p2", "Bob")];
      const results = {
        p1: { [r1.key]: r1.entry, [r2.key]: r2.entry },
        p2: { [r3.key]: r3.entry }
      };

      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });

      expect(out.summary.gamesInWindow).toBe(3);
      expect(out.summary.dau).toBe(1); // only p1 played today
      expect(out.summary.wau).toBe(2); // both played in last 7d
      expect(out.summary.profileCount).toBe(2);
      expect(out.summary.winRate).toBeCloseTo(2 / 3, 4);
      expect(out.summary.avgAttempts).toBeCloseTo(4, 3);
      // p1 has 2 games; p2 has 1; replay rate = 1 of 2 active = 0.5
      expect(out.summary.replayRate).toBeCloseTo(0.5, 4);

      const attemptByBucket = Object.fromEntries(
        out.distributions.attempts.map((row) => [row.bucket, row.value])
      );
      expect(attemptByBucket["3"]).toBe(1);
      expect(attemptByBucket["5"]).toBe(1);
      expect(attemptByBucket.dnf).toBe(1);
    });
  });

  describe("aggregate() dense fixture", () => {
    test("daily series sums match across the window", () => {
      const profiles = [
        makeProfile("p1", "Alice", "2026-04-01T12:00:00Z"),
        makeProfile("p2", "Bob", "2026-04-15T12:00:00Z"),
        makeProfile("p3", "Carol", "2026-05-04T12:00:00Z")
      ];
      const results = { p1: {}, p2: {}, p3: {} };
      const dates = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07"];
      for (const date of dates) {
        const r1 = makeResult({ date, lang: "en", won: true, attempts: 4 });
        const r2 = makeResult({ date, lang: "es", won: false });
        results.p1[r1.key] = r1.entry;
        results.p2[r2.key] = r2.entry;
      }
      // p3 only plays today
      const today = makeResult({ date: "2026-05-07", lang: "en", won: true, attempts: 2 });
      results.p3[today.key] = today.entry;

      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });

      expect(out.summary.gamesInWindow).toBe(15); // 7*2 + 1
      expect(out.summary.dau).toBe(3);
      expect(out.summary.wau).toBe(3);
      const dailyActiveTotal = out.series.dailyActive.reduce((sum, e) => sum + e.value, 0);
      expect(dailyActiveTotal).toBe(15); // each day 2 active, except today 3 = 6+6+3 — wait
      // Actually: 6 days × 2 active + 1 day × 3 active = 12 + 3 = 15
      const langMix = Object.fromEntries(out.distributions.languageMix.map((row) => [row.lang, row.value]));
      expect(langMix.en).toBe(8); // 7 from p1 + 1 from p3
      expect(langMix.es).toBe(7);

      // profile growth: cumulative createdAt <= each day
      const growthByDay = Object.fromEntries(out.series.profileGrowth.map((g) => [g.date, g.value]));
      expect(growthByDay["2026-05-01"]).toBe(2); // p1 + p2
      expect(growthByDay["2026-05-04"]).toBe(3); // + p3
      expect(growthByDay["2026-05-07"]).toBe(3);
    });
  });

  describe("aggregate() window controls", () => {
    test("30d window yields 30 day labels", () => {
      const out = aggregate(emptySnapshot(), {
        window: "30d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      expect(out.series.dailyActive).toHaveLength(30);
      expect(out.series.dailyActive[0].date).toBe("2026-04-08");
      expect(out.series.dailyActive[29].date).toBe("2026-05-07");
    });

    test("all window starts at earliest result date", () => {
      const r1 = makeResult({ date: "2026-04-29", won: true, attempts: 4 });
      const profiles = [makeProfile("p1", "Alice", "2026-04-29T12:00:00Z")];
      const results = { p1: { [r1.key]: r1.entry } };

      const out = aggregate(snapshotWith(profiles, results), {
        window: "all",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      expect(out.series.dailyActive[0].date).toBe("2026-04-29");
      expect(out.series.dailyActive[out.series.dailyActive.length - 1].date).toBe("2026-05-07");
    });

    test("rejects unknown window", () => {
      expect(() =>
        aggregate(emptySnapshot(), { window: "90d", today: "2026-05-07", tz: "UTC" })
      ).toThrow(/unsupported window/);
    });

    test("rejects missing today", () => {
      expect(() =>
        aggregate(emptySnapshot(), { window: "7d", tz: "UTC" })
      ).toThrow(/today/);
    });

    test("SUPPORTED_WINDOWS export is frozen", () => {
      expect(SUPPORTED_WINDOWS).toEqual(["7d", "30d", "all"]);
      expect(Object.isFrozen(SUPPORTED_WINDOWS)).toBe(true);
    });
  });

  describe("aggregate() determinism", () => {
    test("same input produces identical output", () => {
      const r1 = makeResult({ date: "2026-05-06", won: true, attempts: 3 });
      const profiles = [makeProfile("p1", "Alice")];
      const results = { p1: { [r1.key]: r1.entry } };
      const opts = { window: "7d", today: "2026-05-07", tz: "UTC", generatedAt: FIXED_GENERATED_AT };
      const a = aggregate(snapshotWith(profiles, results), opts);
      const b = aggregate(snapshotWith(profiles, results), opts);
      expect(a).toEqual(b);
    });
  });

  describe("aggregate() leap-day boundary", () => {
    test("includes 2024-02-29 in a window straddling the leap day", () => {
      const r1 = makeResult({ date: "2024-02-29", won: true, attempts: 4 });
      const profiles = [makeProfile("p1", "Alice", "2024-02-01T12:00:00Z")];
      const results = { p1: { [r1.key]: r1.entry } };
      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2024-03-04",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      expect(out.series.dailyActive.find((d) => d.date === "2024-02-29")).toBeDefined();
      expect(out.summary.gamesInWindow).toBe(1);
    });
  });

  describe("aggregate() timezone bucketing", () => {
    test("hour-of-day uses operator timezone, not UTC", () => {
      // 2026-05-07T03:30:00Z is 22:30 the previous day in America/New_York (EDT).
      // We're testing that the hour bucket honors tz, so this UTC time should
      // land in the 23-bucket when tz is America/New_York.
      const r1 = makeResult({
        date: "2026-05-07",
        won: true,
        attempts: 3,
        updatedAt: "2026-05-07T03:30:00Z"
      });
      const profiles = [makeProfile("p1", "Alice")];
      const results = { p1: { [r1.key]: r1.entry } };
      const tzOut = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "America/New_York",
        generatedAt: FIXED_GENERATED_AT
      });
      const utcOut = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      const peakHour = (out) =>
        out.distributions.hourOfDay.findIndex((h) => h.value > 0);
      expect(peakHour(utcOut)).toBe(3);
      expect(peakHour(tzOut)).toBe(23);
    });

    test("invalid tz falls back without throwing", () => {
      const r1 = makeResult({ date: "2026-05-07", won: true, attempts: 3 });
      const profiles = [makeProfile("p1", "Alice")];
      const results = { p1: { [r1.key]: r1.entry } };
      expect(() =>
        aggregate(snapshotWith(profiles, results), {
          window: "7d",
          today: "2026-05-07",
          tz: "Not/A/RealZone",
          generatedAt: FIXED_GENERATED_AT
        })
      ).not.toThrow();
    });
  });

  describe("aggregate() attempts bucketing for higher maxGuesses", () => {
    test("submissionCount > 1 on a single row counts as a replay", () => {
      // /api/stats/result merges replays of the same daily into a single
      // row + submissionCount. Counting rows alone would report this
      // profile as not having replayed, deflating replay rate to 0.
      const profiles = [makeProfile("p1", "Alice"), makeProfile("p2", "Bob")];
      const replayed = makeResult({
        date: "2026-05-07",
        won: true,
        attempts: 4
      });
      replayed.entry.submissionCount = 5; // five attempts at same puzzle
      const single = makeResult({ date: "2026-05-07", won: true, attempts: 3 });
      const results = {
        p1: { [replayed.key]: replayed.entry },
        p2: { [single.key]: single.entry }
      };
      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      // p1 replayed (5 submissions); p2 didn't. 1 of 2 active = 0.5.
      expect(out.summary.replayRate).toBeCloseTo(0.5, 4);
    });

    test("wins with attempts > 10 land in the 11+ overflow bucket", () => {
      const profiles = [makeProfile("p1", "Alice")];
      const r1 = makeResult({ date: "2026-05-07", won: true, attempts: 11, maxGuesses: 12 });
      const r2 = makeResult({ date: "2026-05-06", won: true, attempts: 25, maxGuesses: 30 });
      const results = { p1: { [r1.key]: r1.entry, [r2.key]: r2.entry } };
      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      const byBucket = Object.fromEntries(
        out.distributions.attempts.map((row) => [row.bucket, row.value])
      );
      expect(byBucket["11+"]).toBe(2);
      // Histogram totals must still equal gamesInWindow.
      const total = Object.values(byBucket).reduce((sum, v) => sum + v, 0);
      expect(total).toBe(out.summary.gamesInWindow);
    });

    test("wins with attempts 7-10 land in their own bucket", () => {
      const profiles = [makeProfile("p1", "Alice")];
      const results = {
        p1: {
          [makeResult({ date: "2026-05-07", won: true, attempts: 8, maxGuesses: 10 }).key]:
            makeResult({ date: "2026-05-07", won: true, attempts: 8, maxGuesses: 10 }).entry,
          [makeResult({ date: "2026-05-06", won: true, attempts: 10, maxGuesses: 10 }).key]:
            makeResult({ date: "2026-05-06", won: true, attempts: 10, maxGuesses: 10 }).entry
        }
      };
      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      const byBucket = Object.fromEntries(
        out.distributions.attempts.map((row) => [row.bucket, row.value])
      );
      expect(byBucket["8"]).toBe(1);
      expect(byBucket["10"]).toBe(1);
      // Histogram values should sum to total wins (no silent drops).
      const total = Object.values(byBucket).reduce((sum, v) => sum + v, 0);
      expect(total).toBe(out.summary.gamesInWindow);
    });
  });

  describe("aggregate() profile-growth date conversion", () => {
    test("treats createdAt as server-local, not UTC slice", () => {
      // Profile was created locally at 2024-06-15 (whatever server tz).
      // We synthesize an ISO that, when parsed and converted via server
      // local Date methods, falls on that day; the aggregator should
      // place this profile in the 2024-06-15 growth bucket regardless
      // of how the ISO's UTC slice would read.
      const localDate = new Date(2024, 5, 15, 12, 0, 0); // local June 15
      const profiles = [makeProfile("p1", "Alice", localDate.toISOString())];
      const out = aggregate(snapshotWith(profiles, {}), {
        window: "7d",
        today: "2024-06-15",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      const lastDay = out.series.profileGrowth[out.series.profileGrowth.length - 1];
      expect(lastDay.date).toBe("2024-06-15");
      expect(lastDay.value).toBe(1);
    });
  });

  describe("aggregate() malformed entries", () => {
    test("skips daily keys that don't match the pattern", () => {
      const profiles = [makeProfile("p1", "Alice")];
      const results = {
        p1: {
          "not-a-valid-key": { date: "?", won: true },
          "2026-05-07|en|base": {
            date: "2026-05-07",
            won: true,
            attempts: 3,
            maxGuesses: 6,
            submissionCount: 1,
            updatedAt: "2026-05-07T12:00:00.000Z"
          }
        }
      };
      const out = aggregate(snapshotWith(profiles, results), {
        window: "7d",
        today: "2026-05-07",
        tz: "UTC",
        generatedAt: FIXED_GENERATED_AT
      });
      expect(out.summary.gamesInWindow).toBe(1);
    });

    test("rejects non-object snapshot", () => {
      expect(() => aggregate(null, { window: "7d", today: "2026-05-07" })).toThrow();
      expect(() => aggregate(42, { window: "7d", today: "2026-05-07" })).toThrow();
    });
  });
});
