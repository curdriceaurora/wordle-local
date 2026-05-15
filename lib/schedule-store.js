"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");
const { probeStoreFile } = require("./store-health-probe");

const DEFAULT_RETENTION_DAYS = 90;
const SCHEDULE_VERSION = 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Match the game's MIN_LEN=3 / MAX_LEN=12 in server.js so a scheduled
// word can actually be played through /api/guess. Accepting 1-, 2-, or
// 13–15-letter words would pass schedule validation but produce a
// /daily puzzle the rest of the API can't accept.
const WORD_PATTERN = /^[A-Z]{3,12}$/;
const LANG_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const NOTES_MAX_LENGTH = 200;
const RETENTION_MAX = 36500;
const TIMEZONE_MAX_LENGTH = 64;
const SEED_MAX_LENGTH = 128;
// Mirror admin-jobs-store.js — Windows surfaces these on rename-over-existing.
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class ScheduleStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ScheduleStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIanaTimezone(zone) {
  if (typeof zone !== "string" || !zone || zone.length > TIMEZONE_MAX_LENGTH) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (_err) {
    return false;
  }
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function buildDefaultSchedule({ timezone = "UTC", retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const tz = isIanaTimezone(timezone) ? timezone : "UTC";
  const retention = Number.isInteger(retentionDays) && retentionDays >= 0 && retentionDays <= RETENTION_MAX
    ? retentionDays
    : DEFAULT_RETENTION_DAYS;
  return {
    version: SCHEDULE_VERSION,
    updatedAt: nowIso(),
    timezone: tz,
    auto_rotate: false,
    retention_days: retention,
    scheduled_words: []
  };
}

function normalizeEntry(raw) {
  if (!isPlainObject(raw)) {
    throw new ScheduleStoreError("INVALID_ENTRY", "Entry must be an object.");
  }
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const word = typeof raw.word === "string" ? raw.word.trim().toUpperCase() : "";
  const lang = typeof raw.lang === "string" ? raw.lang.trim() : "";
  if (!DATE_PATTERN.test(date)) {
    throw new ScheduleStoreError(
      "INVALID_DATE",
      `Date must be YYYY-MM-DD; got "${raw.date}".`
    );
  }
  if (!WORD_PATTERN.test(word)) {
    throw new ScheduleStoreError(
      "INVALID_WORD",
      `Word must be 3–12 uppercase A-Z letters; got "${raw.word}".`
    );
  }
  if (!LANG_PATTERN.test(lang)) {
    throw new ScheduleStoreError(
      "INVALID_LANG",
      `Lang must match ^[a-z]{2}(-[A-Z]{2})?$; got "${raw.lang}".`
    );
  }
  const out = { date, word, lang };
  if (raw.notes !== undefined && raw.notes !== null && raw.notes !== "") {
    if (typeof raw.notes !== "string" || raw.notes.length > NOTES_MAX_LENGTH) {
      throw new ScheduleStoreError(
        "INVALID_NOTES",
        `Notes must be a string of at most ${NOTES_MAX_LENGTH} characters.`
      );
    }
    out.notes = raw.notes;
  }
  return out;
}

function normalizeSchedule(raw, options = {}) {
  // Lossless-ish normalization. Throws on shape violations the schema would
  // catch; coerces representable-but-loose values (uppercases word, drops
  // unknown top-level keys) so a hand-edited file or a write-side AJV pass
  // both produce the same on-disk format.
  if (!isPlainObject(raw)) {
    throw new ScheduleStoreError("INVALID_SCHEDULE", "Schedule must be an object.");
  }
  if (raw.version !== SCHEDULE_VERSION) {
    throw new ScheduleStoreError(
      "VERSION_UNSUPPORTED",
      `Schedule version ${raw.version} is not supported (expected ${SCHEDULE_VERSION}).`
    );
  }
  if (typeof raw.updatedAt !== "string" || !raw.updatedAt) {
    throw new ScheduleStoreError("INVALID_SCHEDULE", "updatedAt is required.");
  }
  if (!isIanaTimezone(raw.timezone)) {
    throw new ScheduleStoreError(
      "INVALID_TIMEZONE",
      `Timezone "${raw.timezone}" is not a recognised IANA zone.`
    );
  }
  if (typeof raw.auto_rotate !== "boolean") {
    throw new ScheduleStoreError("INVALID_SCHEDULE", "auto_rotate must be a boolean.");
  }
  if (
    !Number.isInteger(raw.retention_days)
    || raw.retention_days < 0
    || raw.retention_days > RETENTION_MAX
  ) {
    throw new ScheduleStoreError(
      "INVALID_SCHEDULE",
      `retention_days must be an integer between 0 and ${RETENTION_MAX}.`
    );
  }
  const rawList = Array.isArray(raw.scheduled_words) ? raw.scheduled_words : null;
  if (!rawList) {
    throw new ScheduleStoreError("INVALID_SCHEDULE", "scheduled_words must be an array.");
  }
  const seenKeys = new Set();
  const entries = [];
  for (const entry of rawList) {
    const normalized = normalizeEntry(entry);
    const key = `${normalized.date}|${normalized.lang}`;
    if (seenKeys.has(key)) {
      // On load (options.tolerateDuplicates) we keep the first occurrence
      // and warn so the operator can repair; on write we hard-reject.
      if (options.tolerateDuplicates) continue;
      throw new ScheduleStoreError(
        "DUPLICATE_ENTRY",
        `Duplicate (date, lang) tuple in scheduled_words: ${key}`
      );
    }
    seenKeys.add(key);
    entries.push(normalized);
  }
  entries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.lang.localeCompare(b.lang);
  });
  const out = {
    version: SCHEDULE_VERSION,
    updatedAt: raw.updatedAt,
    timezone: raw.timezone,
    auto_rotate: raw.auto_rotate,
    retention_days: raw.retention_days,
    scheduled_words: entries
  };
  if (typeof raw.auto_rotate_seed === "string" && raw.auto_rotate_seed.length <= SEED_MAX_LENGTH) {
    out.auto_rotate_seed = raw.auto_rotate_seed;
  }
  if (typeof raw.last_reconciled_at === "string" && raw.last_reconciled_at) {
    out.last_reconciled_at = raw.last_reconciled_at;
  }
  if (typeof raw.last_reconciled_for === "string" && DATE_PATTERN.test(raw.last_reconciled_for)) {
    out.last_reconciled_for = raw.last_reconciled_for;
  }
  return out;
}

async function writeJsonAtomic(filePath, payload) {
  // Mirror admin-jobs-store.js's atomic-write but async. The PID + UUID in
  // the temp filename means two server processes (or two concurrent calls)
  // can't collide on the temp path.
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) {
        throw renameErr;
      }
      // Windows rejects rename-over-existing; fall back to remove + retry.
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    }
  } catch (err) {
    try {
      await fsp.rm(tempPath, { force: true });
    } catch (_cleanupErr) {
      // best-effort
    }
    throw new ScheduleStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist schedule to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class ScheduleStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new ScheduleStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || defaultLogger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.defaultTimezone = isIanaTimezone(options.defaultTimezone)
      ? options.defaultTimezone
      : "UTC";
    this.defaultRetentionDays =
      Number.isInteger(options.defaultRetentionDays) && options.defaultRetentionDays >= 0
        ? options.defaultRetentionDays
        : DEFAULT_RETENTION_DAYS;
    this.state = null;
    // Single in-flight Promise that all #commit calls chain onto. Without
    // this, two near-simultaneous mutations (e.g. addEntry racing
    // setConfig) clone the same pre-mutation snapshot, each apply their
    // own updater, and whichever rename lands last wins on disk —
    // silently dropping the other. atomic-rename makes individual writes
    // durable but doesn't serialize concurrent writers.
    this.commitQueue = Promise.resolve();
    // Cached promise for the in-flight initial load. Concurrent first
    // callers (e.g. a GET /api/admin/schedule racing the boot reconcile,
    // or two parallel mutate calls before the file exists) would
    // otherwise each see ENOENT and each persist a fresh empty
    // schedule — and a default write that lands after a real commit
    // would clobber it. Sharing the loadPromise serializes the initial
    // disk read + default write so the second caller awaits the first's
    // result instead of duplicating work.
    this.loadPromise = null;
  }

  async load() {
    if (this.state) return cloneState(this.state);
    if (!this.loadPromise) {
      // Clear the cached promise on rejection so a transient disk-read
      // failure doesn't wedge every future load() call. Same pattern
      // LeaderboardStore/ClassesStore use.
      this.loadPromise = this.#loadInternal().catch((err) => {
        this.loadPromise = null;
        throw err;
      });
    }
    await this.loadPromise;
    return cloneState(this.state);
  }

  async #loadInternal() {
    let raw;
    try {
      raw = await fsp.readFile(this.filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const fresh = buildDefaultSchedule({
          timezone: this.defaultTimezone,
          retentionDays: this.defaultRetentionDays
        });
        fresh.updatedAt = this.now().toISOString();
        await writeJsonAtomic(this.filePath, fresh);
        this.state = fresh;
        return;
      }
      throw new ScheduleStoreError(
        "STORE_READ_FAILED",
        `Failed to read schedule from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Hard-fail per issue's locked decision — operator must repair manually
      // rather than silently overwriting a corrupt schedule.
      throw new ScheduleStoreError(
        "STORE_PARSE_FAILED",
        `Schedule file ${this.filePath} is not valid JSON: ${err.message}`,
        { cause: err }
      );
    }
    let state;
    try {
      state = normalizeSchedule(parsed, { tolerateDuplicates: true });
    } catch (err) {
      this.logger.warn?.(
        `[schedule] normalization rejected ${this.filePath}: ${err.message}`
      );
      throw err;
    }
    this.state = state;
  }

  async getSnapshot() {
    return this.load();
  }

  // B7 follow-up / #205 — see lib/store-health-probe.js.
  async healthCheck() {
    return probeStoreFile(this.filePath);
  }

  async reload() {
    // Drop the cached state so the next read pulls fresh content from
    // disk. Used by the backup/restore flow after data/schedule.json
    // is swapped — the in-memory cache must not outlive the on-disk
    // swap. Drain the commit queue AND any in-flight load before
    // nulling, otherwise a still-pending #loadInternal could race the
    // restore's reload and clobber the freshly-restored state.
    await this.commitQueue.catch(() => {});
    if (this.loadPromise) {
      await this.loadPromise.catch(() => {});
    }
    this.state = null;
    this.loadPromise = null;
    return this.load();
  }

  async #commit(updater) {
    // Chain onto commitQueue so two concurrent mutations execute
    // sequentially and each sees the previous one's effects. Errors
    // don't break the chain — failed commits don't poison subsequent
    // calls.
    const run = async () => {
      const current = this.state ? cloneState(this.state) : await this.load();
      const next = updater(current);
      next.updatedAt = this.now().toISOString();
      const finalState = normalizeSchedule(next);
      await writeJsonAtomic(this.filePath, finalState);
      this.state = finalState;
      return cloneState(this.state);
    };
    const next = this.commitQueue.then(run, run);
    this.commitQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async addEntry(entry, options = {}) {
    const normalized = normalizeEntry(entry);
    let replaced = false;
    let snapshot;
    await this.#commit((state) => {
      const existingIndex = state.scheduled_words.findIndex(
        (row) => row.date === normalized.date && row.lang === normalized.lang
      );
      if (existingIndex !== -1) {
        if (!options.overwrite) {
          throw new ScheduleStoreError(
            "DUPLICATE_ENTRY",
            `An entry already exists for ${normalized.date} (${normalized.lang}); pass overwrite=true to replace.`,
            { cause: { existing: state.scheduled_words[existingIndex] } }
          );
        }
        state.scheduled_words.splice(existingIndex, 1, normalized);
        replaced = true;
      } else {
        state.scheduled_words.push(normalized);
      }
      return state;
    });
    snapshot = cloneState(this.state);
    return { entry: normalized, replaced, schedule: snapshot };
  }

  async updateEntry(date, lang, patch) {
    if (!DATE_PATTERN.test(String(date))) {
      throw new ScheduleStoreError("INVALID_DATE", "Date must be YYYY-MM-DD.");
    }
    if (!LANG_PATTERN.test(String(lang))) {
      throw new ScheduleStoreError("INVALID_LANG", "Lang must match ^[a-z]{2}(-[A-Z]{2})?$.");
    }
    if (!isPlainObject(patch)) {
      throw new ScheduleStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    let updated;
    await this.#commit((state) => {
      const index = state.scheduled_words.findIndex(
        (row) => row.date === date && row.lang === lang
      );
      if (index === -1) {
        throw new ScheduleStoreError(
          "ENTRY_NOT_FOUND",
          `No entry for ${date} (${lang}).`
        );
      }
      const merged = {
        ...state.scheduled_words[index],
        ...(patch.word !== undefined ? { word: patch.word } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {})
      };
      // notes === "" or null → drop the field
      if (patch.notes === "" || patch.notes === null) delete merged.notes;
      updated = normalizeEntry(merged);
      state.scheduled_words.splice(index, 1, updated);
      return state;
    });
    return { entry: updated, schedule: cloneState(this.state) };
  }

  async removeEntry(date, lang) {
    if (!DATE_PATTERN.test(String(date))) {
      throw new ScheduleStoreError("INVALID_DATE", "Date must be YYYY-MM-DD.");
    }
    if (!LANG_PATTERN.test(String(lang))) {
      throw new ScheduleStoreError("INVALID_LANG", "Lang must match ^[a-z]{2}(-[A-Z]{2})?$.");
    }
    let removed = null;
    await this.#commit((state) => {
      const index = state.scheduled_words.findIndex(
        (row) => row.date === date && row.lang === lang
      );
      if (index === -1) {
        throw new ScheduleStoreError(
          "ENTRY_NOT_FOUND",
          `No entry for ${date} (${lang}).`
        );
      }
      removed = state.scheduled_words[index];
      state.scheduled_words.splice(index, 1);
      return state;
    });
    return { entry: removed, schedule: cloneState(this.state) };
  }

  async setConfig(patch) {
    if (!isPlainObject(patch)) {
      throw new ScheduleStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    if (patch.timezone !== undefined && !isIanaTimezone(patch.timezone)) {
      throw new ScheduleStoreError(
        "INVALID_TIMEZONE",
        `Timezone "${patch.timezone}" is not a recognised IANA zone.`
      );
    }
    if (patch.auto_rotate !== undefined && typeof patch.auto_rotate !== "boolean") {
      throw new ScheduleStoreError("INVALID_REQUEST", "auto_rotate must be boolean.");
    }
    if (
      patch.retention_days !== undefined
      && (
        !Number.isInteger(patch.retention_days)
        || patch.retention_days < 0
        || patch.retention_days > RETENTION_MAX
      )
    ) {
      throw new ScheduleStoreError(
        "INVALID_REQUEST",
        `retention_days must be an integer between 0 and ${RETENTION_MAX}.`
      );
    }
    if (
      patch.auto_rotate_seed !== undefined
      && patch.auto_rotate_seed !== null
      && (typeof patch.auto_rotate_seed !== "string" || patch.auto_rotate_seed.length > SEED_MAX_LENGTH)
    ) {
      throw new ScheduleStoreError(
        "INVALID_REQUEST",
        `auto_rotate_seed must be a string up to ${SEED_MAX_LENGTH} chars.`
      );
    }
    await this.#commit((state) => {
      if (patch.timezone !== undefined) state.timezone = patch.timezone;
      if (patch.auto_rotate !== undefined) state.auto_rotate = patch.auto_rotate;
      if (patch.retention_days !== undefined) state.retention_days = patch.retention_days;
      if (patch.auto_rotate_seed === null || patch.auto_rotate_seed === "") {
        delete state.auto_rotate_seed;
      } else if (patch.auto_rotate_seed !== undefined) {
        state.auto_rotate_seed = patch.auto_rotate_seed;
      }
      return state;
    });
    return cloneState(this.state);
  }

  async pruneBefore(cutoffDate) {
    if (!DATE_PATTERN.test(String(cutoffDate))) {
      throw new ScheduleStoreError("INVALID_DATE", "cutoffDate must be YYYY-MM-DD.");
    }
    let pruned = 0;
    await this.#commit((state) => {
      const before = state.scheduled_words.length;
      state.scheduled_words = state.scheduled_words.filter((row) => row.date >= cutoffDate);
      pruned = before - state.scheduled_words.length;
      return state;
    });
    return { pruned, schedule: cloneState(this.state) };
  }

  async recordReconcile({ date, at }) {
    if (!DATE_PATTERN.test(String(date))) {
      throw new ScheduleStoreError("INVALID_DATE", "date must be YYYY-MM-DD.");
    }
    await this.#commit((state) => {
      state.last_reconciled_for = date;
      state.last_reconciled_at = typeof at === "string" && at ? at : this.now().toISOString();
      return state;
    });
    return cloneState(this.state);
  }

}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  ScheduleStore,
  ScheduleStoreError,
  buildDefaultSchedule,
  normalizeSchedule,
  normalizeEntry,
  isIanaTimezone,
  SCHEDULE_VERSION,
  DEFAULT_RETENTION_DAYS,
  DATE_PATTERN,
  WORD_PATTERN,
  LANG_PATTERN
};
