"use strict";

// Daily web-push fire scheduler. Computes the next midnight (or
// configured local time) using server-local timezone, fires once,
// then re-arms from wall-clock — never additive `+24h` so DST
// transitions and clock skew don't drift the schedule.

class DailyNotificationSchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DailyNotificationSchedulerError";
    this.code = code;
  }
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHhMm(localFireTime) {
  if (typeof localFireTime !== "string" || !HHMM_PATTERN.test(localFireTime)) {
    throw new DailyNotificationSchedulerError(
      "INVALID_REQUEST",
      `localFireTime must be HH:MM 24h; got ${localFireTime}.`
    );
  }
  const [hh, mm] = localFireTime.split(":").map(Number);
  return { hh, mm };
}

// Returns the next absolute wall-clock Date the scheduler should fire.
// If the configured time has already passed today, schedule for
// tomorrow. Pure function; tests pass a fixed `now` to verify.
function computeNextFireAt(now, localFireTime) {
  const { hh, mm } = parseHhMm(localFireTime);
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

// Decides whether a missed fire (e.g. server was down at the
// configured time and is just coming back up) should fire late or be
// skipped. Returns:
//   { action: "fire-now", missedAt }   — within grace; fire late
//   { action: "skip", missedAt }       — outside grace; skip
//   { action: "no-recent-miss" }       — nothing missed, schedule next
// `lastDailyFireAt` is the persisted timestamp of the most recent
// successful fire (null on a fresh install).
function decideBootAction({
  now,
  localFireTime,
  lastDailyFireAt,
  gracePeriodMinutes = 60
}) {
  const { hh, mm } = parseHhMm(localFireTime);
  const todayFire = new Date(now);
  todayFire.setHours(hh, mm, 0, 0);
  // If today's fire window hasn't arrived yet, nothing was missed.
  if (todayFire.getTime() > now.getTime()) {
    return { action: "no-recent-miss" };
  }
  // Today's fire window has passed. Was it already fired?
  if (lastDailyFireAt) {
    const lastMs = new Date(lastDailyFireAt).getTime();
    if (Number.isFinite(lastMs) && lastMs >= todayFire.getTime()) {
      return { action: "no-recent-miss" };
    }
  }
  // Window passed and we haven't fired since today's window. Decide
  // by the grace period: if we're within grace, fire late.
  const minutesSinceWindow = (now.getTime() - todayFire.getTime()) / 60000;
  if (minutesSinceWindow <= gracePeriodMinutes) {
    return { action: "fire-now", missedAt: todayFire.toISOString() };
  }
  return { action: "skip", missedAt: todayFire.toISOString() };
}

class DailyNotificationScheduler {
  constructor(options = {}) {
    if (!options.notificationService) {
      throw new DailyNotificationSchedulerError(
        "INVALID_REQUEST",
        "notificationService is required."
      );
    }
    if (!options.subscriptionStore) {
      throw new DailyNotificationSchedulerError(
        "INVALID_REQUEST",
        "subscriptionStore is required."
      );
    }
    this.notificationService = options.notificationService;
    this.subscriptionStore = options.subscriptionStore;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    // Operator-facing config accessors so admin-edits at runtime take
    // effect on the next re-arm without a restart.
    this.getConfig = typeof options.getConfig === "function"
      ? options.getConfig
      : () => ({ enabled: true, localFireTime: "00:00", gracePeriodMinutes: 60 });
    // Payload builder so the scheduler doesn't hard-code copy. The
    // server passes a builder that pulls the active daily word.
    this.buildPayload = typeof options.buildPayload === "function"
      ? options.buildPayload
      : () => ({
        title: "Today's Wordle is ready",
        body: "Open the app to play today's puzzle.",
        url: "/"
      });
    this.timer = null;
    this.nextFireAt = null;
    this.shutdownRequested = false;
  }

  async start() {
    this.shutdownRequested = false;
    const cfg = this.getConfig() || {};
    if (cfg.enabled === false) {
      this.logger.log?.("[notify] scheduler started in disabled mode — polling for re-enable.");
      // Still arm the disabled-state poll so toggling notifications
      // on at runtime resumes daily fires within ~60s. Without this
      // re-arm, the scheduler would stay dormant until a process
      // restart, breaking the "takes effect without restart" promise.
      this.armNext();
      return;
    }
    // On boot: check if a recent fire was missed. If it was within
    // grace, fire now. Otherwise skip and re-arm to tomorrow.
    const lastDailyFireAt = (await this.subscriptionStore.getSnapshot()).lastDailyFireAt;
    const decision = decideBootAction({
      now: this.now(),
      localFireTime: cfg.localFireTime || "00:00",
      lastDailyFireAt,
      gracePeriodMinutes: cfg.gracePeriodMinutes ?? 60
    });
    if (decision.action === "fire-now") {
      this.logger.log?.(`[notify] firing missed window from ${decision.missedAt}.`);
      await this.fireOnce();
    } else if (decision.action === "skip") {
      this.logger.log?.(`[notify] skipping missed window from ${decision.missedAt} (outside ${cfg.gracePeriodMinutes ?? 60}-minute grace).`);
    }
    this.armNext();
  }

  armNext() {
    if (this.shutdownRequested) return;
    const cfg = this.getConfig() || {};
    if (cfg.enabled === false) {
      // Re-check periodically so toggling on doesn't require a restart.
      this.timer = setTimeout(() => this.armNext(), 60_000);
      if (typeof this.timer.unref === "function") this.timer.unref();
      return;
    }
    const nowDate = this.now();
    const next = computeNextFireAt(nowDate, cfg.localFireTime || "00:00");
    this.nextFireAt = next;
    const delay = Math.max(0, next.getTime() - nowDate.getTime());
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.fireOnce();
      } catch (err) {
        this.logger.error?.("[notify] daily fire failed:", err);
      }
      // Always re-arm — next-fire is recomputed from wall clock so a
      // long-running process can never drift.
      this.armNext();
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async fireOnce() {
    const cfg = this.getConfig() || {};
    if (cfg.enabled === false) return { skipped: true, reason: "disabled" };
    const payload = await Promise.resolve(this.buildPayload());
    const result = await this.notificationService.broadcast(payload);
    await this.subscriptionStore.stampLastDailyFire().catch((err) => {
      this.logger.warn?.("[notify] could not stamp lastDailyFireAt:", err.message);
    });
    return result;
  }

  shutdown() {
    this.shutdownRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  DailyNotificationScheduler,
  DailyNotificationSchedulerError,
  computeNextFireAt,
  decideBootAction
};
