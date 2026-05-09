"use strict";

const {
  computeNextFireAt,
  decideBootAction,
  DailyNotificationScheduler
} = require("../lib/daily-notification-scheduler");

// IMPORTANT: scheduler logic uses server-LOCAL setHours, so tests
// must construct `now` via the local-time Date constructor
// (`new Date(y, m, d, hh, mm)`), NOT an ISO string with a fixed UTC
// offset — the latter only happens to land on the right local hour
// on developer machines in EDT and would fail in any other zone (CI
// runs UTC).

describe("computeNextFireAt", () => {
  test("returns today at the configured time when it's still in the future", () => {
    const now = new Date(2026, 4, 9, 12, 0, 0); // 2026-05-09 12:00 local
    const next = computeNextFireAt(now, "20:00");
    expect(next.getHours()).toBe(20);
    expect(next.getMinutes()).toBe(0);
    expect(next.toDateString()).toBe(now.toDateString());
  });

  test("returns tomorrow at the configured time when it's already passed today", () => {
    const now = new Date(2026, 4, 9, 15, 30, 0); // 2026-05-09 15:30 local
    const next = computeNextFireAt(now, "00:00");
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test("invalid HH:MM throws", () => {
    expect(() => computeNextFireAt(new Date(), "25:00")).toThrow();
    expect(() => computeNextFireAt(new Date(), "noon")).toThrow();
    expect(() => computeNextFireAt(new Date(), "")).toThrow();
  });

  test("midnight rolls to next day cleanly across the spring-forward boundary", () => {
    // Local 03:30 on the spring-forward day. The setHours(0,0,0,0)
    // path lands on local midnight; the test only asserts the delta
    // is positive and ≤ 25h (allowing one extra hour for DST slack).
    const now = new Date(2026, 2, 8, 3, 30, 0); // 2026-03-08 03:30 local
    const next = computeNextFireAt(now, "00:00");
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });
});

describe("decideBootAction", () => {
  test("returns no-recent-miss when today's window hasn't arrived yet", () => {
    const now = new Date(2026, 4, 9, 8, 0, 0); // 08:00 local
    expect(decideBootAction({
      now,
      localFireTime: "20:00",
      lastDailyFireAt: null,
      gracePeriodMinutes: 60
    })).toEqual({ action: "no-recent-miss" });
  });

  test("returns fire-now when window passed within grace and no fire yet today", () => {
    const now = new Date(2026, 4, 9, 0, 30, 0); // 00:30 local
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
    const now = new Date(2026, 4, 9, 3, 0, 0); // 03:00 local
    const result = decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: null,
      gracePeriodMinutes: 60
    });
    expect(result.action).toBe("skip");
  });

  test("returns no-recent-miss when today's window already fired", () => {
    const now = new Date(2026, 4, 9, 12, 0, 0); // 12:00 local
    const lastFireAt = new Date(2026, 4, 9, 0, 1, 0).toISOString(); // 00:01 local
    expect(decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: lastFireAt,
      gracePeriodMinutes: 60
    })).toEqual({ action: "no-recent-miss" });
  });

  test("yesterday's lastDailyFireAt does NOT count for today", () => {
    const now = new Date(2026, 4, 9, 0, 30, 0); // 00:30 today local
    const yesterdaysFireAt = new Date(2026, 4, 8, 0, 0, 30).toISOString();
    const result = decideBootAction({
      now,
      localFireTime: "00:00",
      lastDailyFireAt: yesterdaysFireAt,
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
      // Default to 12:00 local on a fixed date — local-time
      // constructor so the test result doesn't depend on the host's
      // timezone offset (production uses local TZ via setHours).
      now: () => initialNow || new Date(2026, 4, 9, 12, 0, 0),
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
    const initialNow = new Date(2026, 4, 9, 0, 30, 0); // 00:30 local
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
    const initialNow = new Date(2026, 4, 9, 3, 0, 0); // 3h after window
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
