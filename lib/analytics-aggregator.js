"use strict";

const DAILY_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})\|([^|]+)\|([^|]+)$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORTED_WINDOWS = Object.freeze(["7d", "30d", "all"]);
// Server's MAX_GUESSES is 10. The classic Wordle uses 6, but operators can
// configure puzzles up to MAX_GUESSES; without buckets 7–10, those wins
// would still flow through gamesInWindow / winsInWindow / avgAttempts but
// disappear from the histogram, so the bars wouldn't add up to the totals.
// `/api/stats/result` doesn't currently cap attempts at MAX_GUESSES — only
// requires a positive integer — so we also keep an overflow bucket "11+"
// for any wins above 10. The DNF bucket catches losses (won === false).
const ATTEMPT_BUCKETS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const ATTEMPT_OVERFLOW_BUCKET = "11+";

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function parseDailyKey(dailyKey) {
  if (!isString(dailyKey)) return null;
  const match = dailyKey.match(DAILY_KEY_PATTERN);
  if (!match) return null;
  return { date: match[1], lang: match[2], code: match[3] };
}

function todayDate(today) {
  if (!isString(today) || !DATE_PATTERN.test(today)) {
    throw new Error("aggregate(): `today` must be a YYYY-MM-DD string.");
  }
  return today;
}

function shiftDate(dateStr, deltaDays) {
  // Operate purely on the ISO date string so we don't drag a JS Date timezone
  // into bucketing math. Date keys come from daily-result strings that were
  // already authored in operator local time; we treat them as opaque labels.
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 24 * 60 * 60 * 1000;
  const out = new Date(ms);
  const yy = out.getUTCFullYear();
  const mm = String(out.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(out.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function windowStartDate(today, windowName, earliestDate) {
  if (windowName === "all") {
    return earliestDate || today;
  }
  const days = windowName === "7d" ? 6 : 29;
  return shiftDate(today, -days);
}

function listDateRange(start, end) {
  // No iteration cap — shiftDate is deterministic and the loop terminates
  // when cursor > end. The earlier 4000-day cap silently truncated "all"
  // windows on long-running instances (>~11 years) which then under-counted
  // some series buckets. If start ever exceeds end we just return [].
  const out = [];
  let cursor = start;
  while (cursor <= end) {
    out.push(cursor);
    cursor = shiftDate(cursor, 1);
  }
  return out;
}

function isWithinWindow(dateStr, startDate, endDate) {
  return dateStr >= startDate && dateStr <= endDate;
}

function clampHourBucket(value) {
  if (!Number.isInteger(value) || value < 0 || value > 23) return null;
  return value;
}

// Convert an ISO timestamp into a YYYY-MM-DD string in the server's local
// timezone — matching the convention `getLocalDateString` uses when the
// game writes daily-key dates. Slicing the raw ISO would give the UTC
// date and skew profile growth / earliest-date math by a day in any
// non-UTC server zone (e.g. a profile created at 23:30 PDT on May 7
// stores as 2026-05-08T06:30:00Z; UTC slice says May 8 but the rest of
// the aggregator's date math says May 7).
function serverLocalDateFromIso(isoTimestamp) {
  if (!isString(isoTimestamp)) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildHourFormatter(tz) {
  // Intl.DateTimeFormat with the configured timeZone gives the
  // operator-local hour for an ISO timestamp authored in any zone. The
  // documented contract for invalid zones is "fall back to UTC", so we
  // pin timeZone explicitly in the catch path — the previous omission
  // silently used the runtime-local zone, making bucketing
  // non-deterministic across hosts.
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: tz
    });
  } catch (_err) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC"
    });
  }
}

function hourFromIsoWithFormatter(isoTimestamp, formatter) {
  if (!isString(isoTimestamp) || !ISO_TIMESTAMP_PATTERN.test(isoTimestamp)) {
    return null;
  }
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour");
  if (!hourPart) return null;
  const hour = Number(hourPart.value);
  return clampHourBucket(hour);
}

function pickEarliestDate(snapshot) {
  let earliest = null;
  const profilesById = snapshot.resultsByProfile || {};
  for (const profileId of Object.keys(profilesById)) {
    const entries = profilesById[profileId];
    if (!entries || typeof entries !== "object") continue;
    for (const dailyKey of Object.keys(entries)) {
      const parsed = parseDailyKey(dailyKey);
      if (!parsed) continue;
      if (earliest === null || parsed.date < earliest) {
        earliest = parsed.date;
      }
    }
  }
  for (const profile of snapshot.profiles || []) {
    if (!profile) continue;
    const profileDate = serverLocalDateFromIso(profile.createdAt);
    if (!profileDate || !DATE_PATTERN.test(profileDate)) continue;
    if (earliest === null || profileDate < earliest) earliest = profileDate;
  }
  return earliest;
}

function emptyAggregate({ window, generatedAt, dateRange, profileCountTotal }) {
  return {
    window,
    generatedAt,
    summary: {
      dau: 0,
      wau: 0,
      gamesInWindow: 0,
      winRate: 0,
      avgAttempts: 0,
      replayRate: 0,
      profileCount: profileCountTotal
    },
    series: {
      dailyActive: dateRange.map((date) => ({ date, value: 0 })),
      dailyGames: dateRange.map((date) => ({ date, value: 0 })),
      profileGrowth: dateRange.map((date) => ({ date, value: 0 }))
    },
    distributions: {
      attempts: ATTEMPT_BUCKETS.map((bucket) => ({ bucket: String(bucket), value: 0 })).concat([
        { bucket: ATTEMPT_OVERFLOW_BUCKET, value: 0 },
        { bucket: "dnf", value: 0 }
      ]),
      languageMix: [],
      hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 }))
    }
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aggregate(snapshot, options = {}) {
  if (!isPlainObject(snapshot)) {
    throw new Error("aggregate(): snapshot must be an object.");
  }
  const windowName = options.window || "7d";
  if (!SUPPORTED_WINDOWS.includes(windowName)) {
    throw new Error(`aggregate(): unsupported window "${windowName}".`);
  }
  const today = todayDate(options.today);
  const tz = isString(options.tz) ? options.tz : "UTC";
  const generatedAt = isString(options.generatedAt) ? options.generatedAt : new Date().toISOString();

  const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
  const profileCountTotal = profiles.length;
  const earliest = pickEarliestDate(snapshot);
  const startDate = windowStartDate(today, windowName, earliest);
  const dateRange = listDateRange(startDate, today);
  // One Intl formatter per aggregate call. Constructing one per row was
  // showing up as a hot-path cost on dense fixtures.
  const hourFormatter = buildHourFormatter(tz);

  if (profileCountTotal === 0) {
    return emptyAggregate({
      window: windowName,
      generatedAt,
      dateRange,
      profileCountTotal
    });
  }

  // WAU baseline is always a 7-day rolling window ending today, even when
  // the active window is 30d/all — the metric definition is "weekly active
  // users", not "active in the selected window". DAU is the count for today.
  const wauStart = shiftDate(today, -6);

  const dailyActiveMap = new Map(dateRange.map((date) => [date, new Set()]));
  const dailyGamesMap = new Map(dateRange.map((date) => [date, 0]));
  const wauProfiles = new Set();
  const profilesActiveInWindow = new Set();
  const profileGameCounts = new Map();
  const langMix = new Map();
  const attemptHistogram = new Map(ATTEMPT_BUCKETS.map((bucket) => [String(bucket), 0]));
  attemptHistogram.set(ATTEMPT_OVERFLOW_BUCKET, 0);
  attemptHistogram.set("dnf", 0);
  const hourHistogram = Array.from({ length: 24 }, () => 0);

  let gamesInWindow = 0;
  let winsInWindow = 0;
  let attemptsSumOfWins = 0;
  let dauTodayProfiles = new Set();

  const resultsByProfile = isPlainObject(snapshot.resultsByProfile) ? snapshot.resultsByProfile : {};
  for (const profileId of Object.keys(resultsByProfile)) {
    const entries = resultsByProfile[profileId];
    if (!isPlainObject(entries)) continue;
    for (const dailyKey of Object.keys(entries)) {
      const parsed = parseDailyKey(dailyKey);
      if (!parsed) continue;
      const entry = entries[dailyKey];
      if (!isPlainObject(entry)) continue;

      // WAU: rolling 7d ending today, regardless of selected window.
      if (parsed.date >= wauStart && parsed.date <= today) {
        wauProfiles.add(profileId);
      }

      if (!isWithinWindow(parsed.date, startDate, today)) continue;

      // In-window per-day buckets.
      const activeSet = dailyActiveMap.get(parsed.date);
      if (activeSet) activeSet.add(profileId);
      dailyGamesMap.set(parsed.date, (dailyGamesMap.get(parsed.date) || 0) + 1);

      gamesInWindow += 1;
      profilesActiveInWindow.add(profileId);
      // /api/stats/result merges replays of the same daily puzzle into a
      // single dailyKey row by incrementing submissionCount, so we use
      // that counter (≥1) — a profile that replays the same puzzle 5
      // times has submissionCount=5 on one row, but should still count
      // as having replayed. Counting just rows would miss them entirely.
      const submissionCount = Number.isInteger(entry.submissionCount) && entry.submissionCount > 0
        ? entry.submissionCount
        : 1;
      profileGameCounts.set(
        profileId,
        (profileGameCounts.get(profileId) || 0) + submissionCount
      );
      langMix.set(parsed.lang, (langMix.get(parsed.lang) || 0) + 1);

      if (parsed.date === today) {
        dauTodayProfiles.add(profileId);
      }

      // Histogram totals must always equal gamesInWindow. Anything that
      // increments the games counter must also increment exactly one
      // bucket; the two malformed paths (non-boolean won, or won=true
      // with a non-positive-integer attempts) fall back to "dnf" so the
      // invariant holds even on a corrupted snapshot row.
      if (entry.won === true) {
        winsInWindow += 1;
        if (Number.isInteger(entry.attempts) && entry.attempts >= 1) {
          attemptsSumOfWins += entry.attempts;
          // Bucket the attempt count — `/api/stats/result` accepts any
          // positive integer, so anything beyond MAX_GUESSES (10) lands
          // in the overflow bucket rather than getting silently dropped.
          const bucketKey = ATTEMPT_BUCKETS.includes(entry.attempts)
            ? String(entry.attempts)
            : ATTEMPT_OVERFLOW_BUCKET;
          attemptHistogram.set(bucketKey, attemptHistogram.get(bucketKey) + 1);
        } else {
          // Win without a usable attempts count — treat as DNF so the
          // histogram total stays equal to gamesInWindow.
          attemptHistogram.set("dnf", attemptHistogram.get("dnf") + 1);
        }
      } else if (entry.won === false) {
        attemptHistogram.set("dnf", attemptHistogram.get("dnf") + 1);
      } else {
        // entry.won is null / undefined / non-boolean — also DNF so the
        // game we already counted lands somewhere in the histogram.
        attemptHistogram.set("dnf", attemptHistogram.get("dnf") + 1);
      }

      const hour = hourFromIsoWithFormatter(entry.updatedAt, hourFormatter);
      if (hour !== null) {
        hourHistogram[hour] += 1;
      }
    }
  }

  // Profile growth: cumulative count of profiles whose createdAt date is on
  // or before each day in the window. Both lists are date-sorted ascending,
  // so a single cursor advancing through profileCreations as we walk
  // dateRange gives us O(days + profiles) instead of O(days × profiles).
  const profileCreations = profiles
    .map((profile) => serverLocalDateFromIso(profile.createdAt))
    .filter((created) => created && DATE_PATTERN.test(created))
    .sort();
  let creationsCursor = 0;
  let cumulative = 0;
  const profileGrowth = dateRange.map((date) => {
    while (
      creationsCursor < profileCreations.length
      && profileCreations[creationsCursor] <= date
    ) {
      cumulative += 1;
      creationsCursor += 1;
    }
    return { date, value: cumulative };
  });

  const replayCandidates = [...profileGameCounts.values()];
  const replayProfiles = replayCandidates.filter((count) => count > 1).length;

  const winRate = gamesInWindow === 0 ? 0 : winsInWindow / gamesInWindow;
  const avgAttempts = winsInWindow === 0 ? 0 : attemptsSumOfWins / winsInWindow;
  const replayRate = profilesActiveInWindow.size === 0
    ? 0
    : replayProfiles / profilesActiveInWindow.size;

  const dailyActive = dateRange.map((date) => ({
    date,
    value: dailyActiveMap.get(date)?.size || 0
  }));
  const dailyGames = dateRange.map((date) => ({
    date,
    value: dailyGamesMap.get(date) || 0
  }));

  const languageMix = [...langMix.entries()]
    .map(([lang, value]) => ({ lang, value }))
    .sort((a, b) => (b.value - a.value) || a.lang.localeCompare(b.lang));

  const attemptDistribution = ATTEMPT_BUCKETS.map((bucket) => ({
    bucket: String(bucket),
    value: attemptHistogram.get(String(bucket))
  }));
  attemptDistribution.push({
    bucket: ATTEMPT_OVERFLOW_BUCKET,
    value: attemptHistogram.get(ATTEMPT_OVERFLOW_BUCKET)
  });
  attemptDistribution.push({ bucket: "dnf", value: attemptHistogram.get("dnf") });

  const hourOfDay = hourHistogram.map((value, hour) => ({ hour, value }));

  return {
    window: windowName,
    generatedAt,
    summary: {
      dau: dauTodayProfiles.size,
      wau: wauProfiles.size,
      gamesInWindow,
      winRate: Number(winRate.toFixed(4)),
      avgAttempts: Number(avgAttempts.toFixed(3)),
      replayRate: Number(replayRate.toFixed(4)),
      profileCount: profileCountTotal
    },
    series: {
      dailyActive,
      dailyGames,
      profileGrowth
    },
    distributions: {
      attempts: attemptDistribution,
      languageMix,
      hourOfDay
    }
  };
}

module.exports = {
  aggregate,
  SUPPORTED_WINDOWS
};
