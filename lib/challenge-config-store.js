"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");
const { probeStoreFile } = require("./store-health-probe");

const STORE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LANG_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const NAME_MAX = 80;
const PUZZLE_COUNT_MIN = 1;
const PUZZLE_COUNT_MAX = 50;
const TIME_BUDGET_MIN = 30;
const TIME_BUDGET_MAX = 7200;
const MAX_GUESSES_MIN = 1;
const MAX_GUESSES_MAX = 12;
const WORD_LENGTH_MIN = 3;
const WORD_LENGTH_MAX = 12;
const PER_PUZZLE_SCORE_MAX = 10000;
const SPEED_BONUS_FACTOR_MAX = 100;
const REPLAY_POLICIES = Object.freeze(["best", "first-only", "unlimited"]);
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class ChallengeConfigStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ChallengeConfigStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generateChallengeId() {
  return nodeCrypto.randomBytes(16).toString("base64url");
}

function clampString(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function normalizeChallenge(raw, { fillDefaults = false, now = () => new Date() } = {}) {
  if (!isPlainObject(raw)) {
    throw new ChallengeConfigStoreError("INVALID_REQUEST", "Challenge must be an object.");
  }
  const out = {};
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", `Invalid challenge id: ${raw.id}`);
    }
    out.id = raw.id;
  } else if (fillDefaults) {
    out.id = generateChallengeId();
  } else {
    throw new ChallengeConfigStoreError("INVALID_REQUEST", "id is required.");
  }
  const name = clampString(raw.name, NAME_MAX);
  if (!name) {
    throw new ChallengeConfigStoreError("INVALID_REQUEST", `name must be 1–${NAME_MAX} characters.`);
  }
  out.name = name;
  if (typeof raw.lang !== "string" || !LANG_PATTERN.test(raw.lang)) {
    throw new ChallengeConfigStoreError("INVALID_REQUEST", `Invalid lang: ${raw.lang}`);
  }
  out.lang = raw.lang;
  if (!Number.isInteger(raw.puzzleCount) || raw.puzzleCount < PUZZLE_COUNT_MIN || raw.puzzleCount > PUZZLE_COUNT_MAX) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `puzzleCount must be an integer between ${PUZZLE_COUNT_MIN} and ${PUZZLE_COUNT_MAX}.`
    );
  }
  out.puzzleCount = raw.puzzleCount;
  if (!Number.isInteger(raw.timeBudgetSeconds) || raw.timeBudgetSeconds < TIME_BUDGET_MIN || raw.timeBudgetSeconds > TIME_BUDGET_MAX) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `timeBudgetSeconds must be an integer between ${TIME_BUDGET_MIN} and ${TIME_BUDGET_MAX}.`
    );
  }
  out.timeBudgetSeconds = raw.timeBudgetSeconds;
  if (!Number.isInteger(raw.maxGuesses) || raw.maxGuesses < MAX_GUESSES_MIN || raw.maxGuesses > MAX_GUESSES_MAX) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `maxGuesses must be an integer between ${MAX_GUESSES_MIN} and ${MAX_GUESSES_MAX}.`
    );
  }
  out.maxGuesses = raw.maxGuesses;
  if (raw.wordLength !== undefined && raw.wordLength !== null) {
    if (!Number.isInteger(raw.wordLength) || raw.wordLength < WORD_LENGTH_MIN || raw.wordLength > WORD_LENGTH_MAX) {
      throw new ChallengeConfigStoreError(
        "INVALID_REQUEST",
        `wordLength must be an integer between ${WORD_LENGTH_MIN} and ${WORD_LENGTH_MAX}.`
      );
    }
    out.wordLength = raw.wordLength;
  }
  const speedBonus = Number(raw.speedBonusFactor);
  if (!Number.isFinite(speedBonus) || speedBonus < 0 || speedBonus > SPEED_BONUS_FACTOR_MAX) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `speedBonusFactor must be a finite number between 0 and ${SPEED_BONUS_FACTOR_MAX}.`
    );
  }
  out.speedBonusFactor = speedBonus;
  if (!Number.isInteger(raw.perPuzzleScore) || raw.perPuzzleScore < 0 || raw.perPuzzleScore > PER_PUZZLE_SCORE_MAX) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `perPuzzleScore must be an integer between 0 and ${PER_PUZZLE_SCORE_MAX}.`
    );
  }
  out.perPuzzleScore = raw.perPuzzleScore;
  if (typeof raw.replayPolicy !== "string" || !REPLAY_POLICIES.includes(raw.replayPolicy)) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      `replayPolicy must be one of ${REPLAY_POLICIES.join(", ")}.`
    );
  }
  out.replayPolicy = raw.replayPolicy;
  if (raw.startTime !== undefined && raw.startTime !== null && raw.startTime !== "") {
    if (typeof raw.startTime !== "string" || Number.isNaN(Date.parse(raw.startTime))) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "startTime must be ISO-8601.");
    }
    out.startTime = new Date(raw.startTime).toISOString();
  }
  if (raw.endTime !== undefined && raw.endTime !== null && raw.endTime !== "") {
    if (typeof raw.endTime !== "string" || Number.isNaN(Date.parse(raw.endTime))) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "endTime must be ISO-8601.");
    }
    out.endTime = new Date(raw.endTime).toISOString();
  }
  if (out.startTime && out.endTime && Date.parse(out.endTime) <= Date.parse(out.startTime)) {
    throw new ChallengeConfigStoreError(
      "INVALID_REQUEST",
      "endTime must be strictly after startTime."
    );
  }
  if (typeof raw.deleted === "boolean") out.deleted = raw.deleted;
  if (typeof raw.deletedAt === "string" && raw.deletedAt) out.deletedAt = raw.deletedAt;
  out.createdAt = typeof raw.createdAt === "string" && raw.createdAt
    ? raw.createdAt
    : now().toISOString();
  out.updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt
    ? raw.updatedAt
    : now().toISOString();
  return out;
}

function buildDefaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    challenges: []
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new ChallengeConfigStoreError("INVALID_STORE", "Store must be an object.");
  }
  if (raw.version !== STORE_VERSION) {
    throw new ChallengeConfigStoreError(
      "VERSION_UNSUPPORTED",
      `Challenge config store version ${raw.version} is not supported.`
    );
  }
  if (typeof raw.updatedAt !== "string") {
    throw new ChallengeConfigStoreError("INVALID_STORE", "updatedAt is required.");
  }
  if (!Array.isArray(raw.challenges)) {
    throw new ChallengeConfigStoreError("INVALID_STORE", "challenges must be an array.");
  }
  const seen = new Set();
  const challenges = [];
  for (const ch of raw.challenges) {
    const normalized = normalizeChallenge(ch);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    challenges.push(normalized);
  }
  challenges.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { version: STORE_VERSION, updatedAt: raw.updatedAt, challenges };
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) throw renameErr;
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    }
  } catch (err) {
    try { await fsp.rm(tempPath, { force: true }); } catch (_e) { /* best-effort */ }
    throw new ChallengeConfigStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist challenge config store to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class ChallengeConfigStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "filePath is required.");
    }
    this.filePath = options.filePath;
    this.logger = options.logger || defaultLogger;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.claimDirectDataWriteSlot = typeof options.claimDirectDataWriteSlot === "function"
      ? options.claimDirectDataWriteSlot
      : null;
    this.state = null;
    this.loadPromise = null;
    this.commitQueue = Promise.resolve();
  }

  async load() {
    if (this.state) return cloneState(this.state);
    if (!this.loadPromise) {
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
        // Bootstrap on first read: write the default directly.
        //
        // This intentionally does NOT claim claimDirectDataWriteSlot.
        // Two earlier attempts at this were both wrong:
        //   - Round 1 removed the write entirely. That broke the
        //     backup route, which calls warmInScopeStores() →
        //     load() before buildManifest() and requires the file
        //     to exist for hashing (INSCOPE_FILE_MISSING otherwise).
        //   - Round 2 added a claimDirectDataWriteSlot() call. That
        //     deadlocked: the backup/restore routes set
        //     dataMutationLockRef.value=true BEFORE warmInScopeStores(),
        //     and claimDirectDataWriteSlot() awaits that lock to
        //     release — but the lock can only release after the
        //     backup/restore finishes, which is waiting on this
        //     load(). Indefinite hang with the data lock held.
        //
        // Direct write is safe in practice because every code path
        // that reaches this load() in production is either:
        //   a) under the /api gate, which 503s during backup, or
        //   b) the backup/restore route itself calling
        //      warmInScopeStores while it already holds the data
        //      lock — that lock provides the same mutual exclusion
        //      the slot would have, without the deadlock.
        // This matches the bootstrap pattern used by every other
        // in-scope store (lib/schedule-store.js, lib/webhook-store.js,
        // lib/push-subscription-store.js, lib/challenge-results-store.js,
        // etc.).
        const fresh = buildDefaultStore();
        fresh.updatedAt = this.now().toISOString();
        await writeJsonAtomic(this.filePath, fresh);
        this.state = fresh;
        return;
      }
      throw new ChallengeConfigStoreError(
        "STORE_READ_FAILED",
        `Failed to read challenge config store from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ChallengeConfigStoreError(
        "STORE_PARSE_FAILED",
        `Challenge config store ${this.filePath} is not valid JSON: ${err.message}`,
        { cause: err }
      );
    }
    this.state = normalizeStore(parsed);
  }

  async getSnapshot() {
    return this.load();
  }

  // B7 follow-up / #205 — see lib/store-health-probe.js.
  async healthCheck() {
    return probeStoreFile(this.filePath, { expectExists: this.state !== null });
  }

  async reload() {
    await this.commitQueue.catch(() => {});
    if (this.loadPromise) await this.loadPromise.catch(() => {});
    this.state = null;
    this.loadPromise = null;
    return this.load();
  }

  async #commit(updater) {
    let releaseSlot = null;
    if (this.claimDirectDataWriteSlot) {
      releaseSlot = await this.claimDirectDataWriteSlot();
    }
    const run = async () => {
      try {
        const current = this.state ? cloneState(this.state) : await this.load();
        const next = updater(current);
        next.updatedAt = this.now().toISOString();
        const finalState = normalizeStore(next);
        await writeJsonAtomic(this.filePath, finalState);
        this.state = finalState;
        return cloneState(this.state);
      } finally {
        if (releaseSlot) releaseSlot();
      }
    };
    const next = this.commitQueue.then(run, run);
    this.commitQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async create(input) {
    const challenge = normalizeChallenge(input, { fillDefaults: true, now: this.now });
    let stored;
    await this.#commit((state) => {
      // Reject id collisions defensively (random ids make this near-zero
      // probability, but a hand-edited file could make it happen).
      if (state.challenges.some((c) => c.id === challenge.id)) {
        throw new ChallengeConfigStoreError("DUPLICATE_ID", `Challenge id collision: ${challenge.id}`);
      }
      state.challenges.push(challenge);
      stored = challenge;
      return state;
    });
    return cloneState(stored);
  }

  // Update a challenge config. Refuses to mutate an immutable challenge
  // (config is frozen once any session exists for it). Caller must
  // pass `hasResults` so the store doesn't have to know about the
  // results store directly.
  async update(id, patch, { hasResults = false } = {}) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "Invalid challenge id.");
    }
    if (!isPlainObject(patch)) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    let updated;
    await this.#commit((state) => {
      const idx = state.challenges.findIndex((c) => c.id === id);
      if (idx === -1) {
        throw new ChallengeConfigStoreError("CHALLENGE_NOT_FOUND", `No challenge with id ${id}.`);
      }
      if (hasResults) {
        // Once any result row exists, scoring/word-source params are
        // frozen — the leaderboard would otherwise be comparing apples
        // and oranges. The operator can soft-delete and create a new
        // challenge instead.
        throw new ChallengeConfigStoreError(
          "CONFIG_LOCKED",
          "Cannot edit a challenge that already has session results. Soft-delete and create a new challenge instead."
        );
      }
      const merged = { ...state.challenges[idx], ...patch, id, createdAt: state.challenges[idx].createdAt };
      const normalized = normalizeChallenge(merged, { now: this.now });
      normalized.updatedAt = this.now().toISOString();
      state.challenges.splice(idx, 1, normalized);
      updated = normalized;
      return state;
    });
    return cloneState(updated);
  }

  // Soft delete: marks `deleted: true` so historical leaderboards
  // remain queryable. Hard purge is a separate operator action.
  async softDelete(id) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new ChallengeConfigStoreError("INVALID_REQUEST", "Invalid challenge id.");
    }
    let removed = null;
    await this.#commit((state) => {
      const idx = state.challenges.findIndex((c) => c.id === id);
      if (idx === -1) {
        throw new ChallengeConfigStoreError("CHALLENGE_NOT_FOUND", `No challenge with id ${id}.`);
      }
      const merged = {
        ...state.challenges[idx],
        deleted: true,
        deletedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString()
      };
      state.challenges.splice(idx, 1, merged);
      removed = merged;
      return state;
    });
    return cloneState(removed);
  }

  async findById(id) {
    const snap = await this.load();
    return snap.challenges.find((c) => c.id === id) || null;
  }

  // List challenges visible to PLAYERS — excludes soft-deleted and
  // applies the start/end window. Pass `now` for tests; defaults to
  // wall-clock.
  async listActive(now = this.now()) {
    const snap = await this.load();
    const nowMs = now.getTime();
    return snap.challenges.filter((c) => {
      if (c.deleted) return false;
      if (c.startTime && Date.parse(c.startTime) > nowMs) return false;
      if (c.endTime && Date.parse(c.endTime) <= nowMs) return false;
      return true;
    });
  }

  // List ALL challenges including soft-deleted — admin view.
  async listAll() {
    const snap = await this.load();
    return snap.challenges.slice();
  }
}

function cloneState(state) {
  if (state === null || state === undefined) return state;
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  ChallengeConfigStore,
  ChallengeConfigStoreError,
  generateChallengeId,
  normalizeChallenge,
  normalizeStore,
  STORE_VERSION,
  ID_PATTERN,
  REPLAY_POLICIES
};
