"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

// Match the game's playable length (3–12) so auto-rotate never picks a
// word that the game itself can't accept downstream.
const WORD_LINE_PATTERN = /^[A-Za-z]{3,12}$/;

class SchedulerTickError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SchedulerTickError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

// Format an absolute Date instant into YYYY-MM-DD in the configured zone.
// Intl.DateTimeFormat handles DST jumps correctly — JS Date getters do not.
function dateInTimezone(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) {
    throw new SchedulerTickError(
      "TIMEZONE_FORMAT_FAILED",
      `Could not format date in timezone ${timezone}.`
    );
  }
  return `${y}-${m}-${d}`;
}

// Pick a deterministic index in [0, poolSize) from (seed || date|lang|commit).
// Truncation bias on a 32-bit hash modulo a small pool size is negligible
// for our pool sizes (thousands of entries) — well under any human-noticeable
// distribution skew. Using SHA-256 first 4 bytes keeps it cheap and stable.
function deterministicIndex(seedString, poolSize) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) return 0;
  const digest = nodeCrypto.createHash("sha256").update(seedString).digest();
  // Read 4 bytes BE → unsigned int → modulo pool size.
  const n = digest.readUInt32BE(0);
  return n % poolSize;
}

async function readAnswerPool(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw new SchedulerTickError(
      "ANSWER_POOL_READ_FAILED",
      `Failed to read answer pool ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
  // One word per line, trim, drop blanks, drop comments. Reject lines that
  // don't look like a word so we don't accidentally write junk into
  // word.json.
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!WORD_LINE_PATTERN.test(trimmed)) continue;
    out.push(trimmed.toUpperCase());
  }
  return out;
}

// Find the active provider commit for a language. Reads `data/languages.json`
// directly so the reconciler can run from `server.js` boot without depending
// on the LanguageRegistryStore singleton's load order.
function readActiveCommitForLang(languagesPath, lang) {
  let raw;
  try {
    raw = fs.readFileSync(languagesPath, "utf8");
  } catch (_err) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.languages)) return null;
  const entry = parsed.languages.find((row) => row && row.id === lang && row.enabled);
  if (!entry || !entry.provider) return null;
  return {
    variant: entry.provider.variant || lang,
    commit: entry.provider.commit || null
  };
}

function scheduledEntryFor(schedule, todayLocal, preferredLang) {
  if (!schedule || !Array.isArray(schedule.scheduled_words)) return null;
  const matchesToday = schedule.scheduled_words.filter((row) => row.date === todayLocal);
  if (matchesToday.length === 0) return null;
  // Prefer the language word.json already names; otherwise take the first
  // matching entry by language order. The schedule is sorted by lang asc
  // in normalizeSchedule, so this is deterministic.
  if (preferredLang) {
    const exact = matchesToday.find((row) => row.lang === preferredLang);
    if (exact) return exact;
  }
  return matchesToday[0];
}

async function pickAutoRotateWord({
  schedule,
  todayLocal,
  preferredLang,
  defaultLang,
  providersRoot,
  languagesPath,
  logger
}) {
  const lang = preferredLang || defaultLang;
  if (!lang) return null;
  const langInfo = readActiveCommitForLang(languagesPath, lang);
  if (!langInfo || !langInfo.commit) {
    logger?.warn?.(
      `[scheduler] auto-rotate skipped for ${todayLocal}: no active commit for lang=${lang}.`
    );
    return null;
  }
  const commitDir = path.join(providersRoot, langInfo.variant, langInfo.commit);
  const activePath = path.join(commitDir, "answer-pool-active.txt");
  const fallbackPath = path.join(commitDir, "answer-pool.txt");
  let pool = await readAnswerPool(activePath);
  if (pool.length === 0) {
    pool = await readAnswerPool(fallbackPath);
  }
  if (pool.length === 0) {
    logger?.warn?.(
      `[scheduler] auto-rotate skipped for ${todayLocal}: empty answer pool for lang=${lang}.`
    );
    return null;
  }
  const seed = schedule.auto_rotate_seed
    ? `${schedule.auto_rotate_seed}|${todayLocal}|${lang}|${langInfo.commit}`
    : `${todayLocal}|${lang}|${langInfo.commit}`;
  const idx = deterministicIndex(seed, pool.length);
  return { word: pool[idx], lang };
}

// Pure decision function — no I/O. Decides what (if anything) the
// reconciler should write, based on the current schedule, current
// word.json snapshot, and `now`. Splitting this out makes it trivially
// unit-testable across DST and TZ edge cases without filesystem fixtures.
function decideReconcile({ schedule, currentWordData, now, defaultLang }) {
  if (!schedule) {
    return { action: "noop", reason: "NO_SCHEDULE", todayLocal: null };
  }
  const todayLocal = dateInTimezone(now, schedule.timezone);
  const preferredLang =
    (currentWordData && typeof currentWordData.lang === "string" && currentWordData.lang)
    || defaultLang
    || null;

  // Manual-override precedence: a `POST /api/word` write that was AFTER our
  // last scheduler write for today wins until the next local-day rollover.
  // We detect this via word.json's lastScheduledFor: if it's set to today,
  // the most recent write was ours; if it's missing OR set to a previous
  // date, the most recent write was a manual override (or this is a fresh
  // install) and we should NOT clobber it as long as word.json's date
  // already matches today.
  if (
    currentWordData
    && currentWordData.date === todayLocal
    && currentWordData.lastScheduledFor !== todayLocal
  ) {
    return {
      action: "skip-manual-override",
      reason: "MANUAL_OVERRIDE_TODAY",
      todayLocal
    };
  }

  // Idempotency: if we already reconciled for today and word.json matches,
  // do nothing.
  const scheduled = scheduledEntryFor(schedule, todayLocal, preferredLang);
  if (scheduled) {
    if (
      currentWordData
      && currentWordData.date === todayLocal
      && currentWordData.word === scheduled.word
      && currentWordData.lang === scheduled.lang
      && currentWordData.lastScheduledFor === todayLocal
    ) {
      return { action: "noop", reason: "ALREADY_RECONCILED", todayLocal, scheduled };
    }
    return {
      action: "write-scheduled",
      todayLocal,
      scheduled,
      preferredLang
    };
  }

  if (schedule.auto_rotate) {
    return {
      action: "auto-rotate",
      todayLocal,
      preferredLang
    };
  }

  return {
    action: "noop",
    reason: "NO_SCHEDULED_ENTRY_AND_AUTO_ROTATE_OFF",
    todayLocal
  };
}

async function reconcileDailyWord({
  schedule,
  currentWordData,
  now = new Date(),
  defaultLang,
  providersRoot,
  languagesPath,
  saveWordData,
  recordReconcile,
  logger
}) {
  if (typeof saveWordData !== "function") {
    throw new SchedulerTickError(
      "INVALID_REQUEST",
      "saveWordData callback is required."
    );
  }
  const decision = decideReconcile({ schedule, currentWordData, now, defaultLang });
  let resolvedWord = null;
  let action = decision.action;

  if (action === "write-scheduled") {
    resolvedWord = decision.scheduled;
  } else if (action === "auto-rotate") {
    const picked = await pickAutoRotateWord({
      schedule,
      todayLocal: decision.todayLocal,
      preferredLang: decision.preferredLang,
      defaultLang,
      providersRoot,
      languagesPath,
      logger
    });
    if (!picked) {
      action = "noop";
      logger?.warn?.(
        `[scheduler] auto-rotate could not pick a word for ${decision.todayLocal}; leaving word.json untouched.`
      );
      // Only record once per local-date rollover. Recording every tick
      // would rewrite data/schedule.json once a minute even when
      // nothing changed, burning disk for no observability gain.
      if (typeof recordReconcile === "function" && schedule?.last_reconciled_for !== decision.todayLocal) {
        await recordReconcile({ date: decision.todayLocal, at: now.toISOString() });
      }
      return { action, todayLocal: decision.todayLocal, resolved: null };
    }
    // Idempotency: pickAutoRotateWord is deterministic, so the second
    // tick of the day picks the same word as the first. If word.json
    // already reflects today's pick, skip the write — otherwise we'd
    // burn a fresh updatedAt every minute even though nothing changed.
    if (
      currentWordData
      && currentWordData.word === picked.word
      && currentWordData.lang === picked.lang
      && currentWordData.date === decision.todayLocal
      && currentWordData.lastScheduledFor === decision.todayLocal
    ) {
      action = "noop";
      if (typeof recordReconcile === "function" && schedule?.last_reconciled_for !== decision.todayLocal) {
        await recordReconcile({ date: decision.todayLocal, at: now.toISOString() });
      }
      return {
        action,
        todayLocal: decision.todayLocal,
        reason: "AUTO_ROTATE_ALREADY_RECONCILED",
        resolved: null
      };
    }
    resolvedWord = { word: picked.word, lang: picked.lang };
  } else {
    // noop / skip-manual-override — only record when the local date
    // has rolled past the last recorded one (same write-amplification
    // guard as the auto-rotate noop above).
    if (
      decision.todayLocal
      && typeof recordReconcile === "function"
      && schedule?.last_reconciled_for !== decision.todayLocal
    ) {
      await recordReconcile({ date: decision.todayLocal, at: now.toISOString() });
    }
    return {
      action,
      todayLocal: decision.todayLocal,
      reason: decision.reason || null,
      resolved: null
    };
  }

  const newWordData = {
    word: resolvedWord.word,
    lang: resolvedWord.lang,
    date: decision.todayLocal,
    updatedAt: now.toISOString(),
    lastScheduledFor: decision.todayLocal
  };
  await saveWordData(newWordData);
  if (typeof recordReconcile === "function") {
    await recordReconcile({ date: decision.todayLocal, at: now.toISOString() });
  }
  logger?.log?.(
    `[scheduler] reconciled ${decision.todayLocal} → "${newWordData.word}" (${newWordData.lang}, action=${action}).`
  );
  return {
    action,
    todayLocal: decision.todayLocal,
    resolved: newWordData
  };
}

module.exports = {
  reconcileDailyWord,
  decideReconcile,
  dateInTimezone,
  deterministicIndex,
  pickAutoRotateWord,
  readAnswerPool,
  readActiveCommitForLang,
  SchedulerTickError
};
