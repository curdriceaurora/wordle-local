"use strict";

const {
  computeNextFireAt,
  decideBootAction,
  DailyNotificationScheduler
} = require("../lib/daily-notification-scheduler");

describe("computeNextFireAt", () => {
  test("returns today at the configured time when it's still in the future", () => {
    const now = new Date("2026-05-09T12:00:00.000-04:00");
    const next = computeNextFireAt(now, "20:00");
    expect(next.getHours()).toBe(20);
    expect(next.getMinutes()).toBe(0);
    expect(next.toDateString()).toBe(now.toDateString());
  });

  test("returns tomorrow at the configured time when it's already passed today", () => {
    const now = new Date("2026-05-09T15:30:00.000-04:00");
    const next = computeNextFireAt(now, "00:00");
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    // Tomorrow.
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test("invalid HH:MM throws", () => {
    expect(() => computeNextFireAt(new Date(), "25:00")).toThrow();
    expect(() => computeNextFireAt(new Date(), "noon")).toThrow();
    expect(() => computeNextFireAt(new Date(), "")).toThrow();
  });

  test("midnight rolls to next day cleanly across DST", () => {
    // US/Eastern spring-forward: 2026-03-08 02:00 EST → 03:00 EDT.
    // After DST transition at 02:00, computing next fire from
    // 03:30 EDT for 00:00 should still give the next day's 00:00.
    const now = new Date("2026-03-08T03:30:00.000-04:00");
    const next = computeNextFireAt(now, "00:00");
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // Should be within 25 hours (allow one extra hour for DST slack).
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });
});

describe("decideBootAction", () => {
  test("returns no-recent-miss when today's window hasn't arrived yet", () => {
    const now = new Date("2026-05-09T08:00:00.000-04:00");
    expect(decideBootAction({
      now,
      localFireTime: "20:00",
      lastDailyFireAt: null,
      gracePeriodMinutes: 60
    })).toEqual({ action: "no-recent-miss" });
  });

  test("returns fire-now when window passed within grace and no fire yet today", () => {
    const now = new Date("2026-05-09T00:30:00.000-04:00");
    const result = decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: null,
      gracePeriodMinutes: 60
    });
    expect(result.action).toBe("fire-now");
    expect(result.missedAt).toBeTruthy();
  });

  test("returns skip when window passed beyond grace", () => {
    const now = new Date("2026-05-09T03:00:00.000-04:00");
    const result = decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: null,
      gracePeriodMinutes: 60
    });
    expect(result.action).toBe("skip");
  });

  test("returns no-recent-miss when today's window already fired", () => {
    const now = new Date("2026-05-09T12:00:00.000-04:00");
    expect(decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: "2026-05-09T00:01:00.000-04:00",
      gracePeriodMinutes: 60
    })).toEqual({ action: "no-recent-miss" });
  });

  test("yesterday's lastDailyFireAt does NOT count for today", () => {
    const now = new Date("2026-05-09T00:30:00.000-04:00");
    const result = decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: "2026-05-08T00:00:30.000-04:00",
      gracePeriodMinutes: 60
    });
    expect(result.action).toBe("fire-now");
  });
});

describe("DailyNotificationScheduler", () => {
  function buildHarness({ enabled = true, localFireTime = "00:00", initialNow, lastDailyFireAt = null } = {}) {
    const broadcastCalls = [];
    const stampCalls = [];
    const subscriptionStore = {
      getSnapshot: jest.fn(async () => ({ lastDailyFireAt })),
      stampLastDailyFire: jest.fn(async (...args) => { stampCalls.push(args); })
    };
    const notificationService = {
      broadcast: jest.fn(async (payload) => {
        broadcastCalls.push(payload);
        return { sent: 1, failed: 0, gone: 0, recipients: 1 };
      })
    };
    const sched = new DailyNotificationScheduler({
      subscriptionStore,
      notificationService,
      now: () => initialNow || new Date("2026-05-09T12:00:00.000-04:00"),
      logger: { warn: () => {}, error: () => {}, log: () => {} },
      getConfig: () => ({ enabled, localFireTime, gracePeriodMinutes: 60 }),
      buildPayload: () => ({ title: "T", body: "B", url: "/" })
    });
    return { sched, broadcastCalls, stampCalls, subscriptionStore, notificationService };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test("start() with notifications disabled: no broadcast, no timer", async () => {
    const { sched, notificationService } = buildHarness({ enabled: false });
    await sched.start();
    expect(notificationService.broadcast).not.toHaveBeenCalled();
    sched.shutdown();
  });

  test("start() during the grace window fires once, then arms next", async () => {
    const initialNow = new Date("2026-05-09T00:30:00.000-04:00");
    const { sched, broadcastCalls } = buildHarness({
      localFireTime: "00:00",
      initialNow
    });
    await sched.start();
    expect(broadcastCalls).toHaveLength(1);
    expect(broadcastCalls[0]).toEqual({ title: "T", body: "B", url: "/" });
    sched.shutdown();
  });

  test("start() outside grace skips and arms next", async () => {
    const initialNow = new Date("2026-05-09T03:00:00.000-04:00"); // 3h after window
    const { sched, broadcastCalls } = buildHarness({
      localFireTime: "00:00",
      initialNow
    });
    await sched.start();
    expect(broadcastCalls).toHaveLength(0);
    sched.shutdown();
  });

  test("fireOnce broadcasts and stamps lastDailyFireAt", async () => {
    const { sched, broadcastCalls, subscriptionStore } = buildHarness();
    await sched.fireOnce();
    expect(broadcastCalls).toHaveLength(1);
    expect(subscriptionStore.stampLastDailyFire).toHaveBeenCalled();
  });

  test("shutdown clears the timer and prevents further work", async () => {
    const { sched } = buildHarness();
    await sched.start();
    expect(sched.timer).toBeTruthy();
    sched.shutdown();
    expect(sched.timer).toBe(null);
    expect(sched.shutdownRequested).toBe(true);
  });
});
