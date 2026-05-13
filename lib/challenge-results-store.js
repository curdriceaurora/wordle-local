"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const nodeCrypto = require("node:crypto");
const { logger: defaultLogger } = require("./logger");
const { isValidProfileName } = require("./profile-name");

const STORE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = Object.freeze(["pending", "in-progress", "completed", "timed-out", "abandoned"]);
const TERMINAL_STATUSES = Object.freeze(new Set(["completed", "timed-out", "abandoned"]));
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class ChallengeResultsStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ChallengeResultsStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function generateSessionId() {
  return nodeCrypto.randomBytes(16).toString("base64url");
}

function normalizePuzzle(raw) {
  if (!isPlainObject(raw)) {
    throw new ChallengeResultsStoreError("INVALID_PUZZLE", "Puzzle entry must be an object.");
  }
  if (!Number.isInteger(raw.index) || raw.index < 0) {
    throw new ChallengeResultsStoreError("INVALID_PUZZLE", "puzzle.index must be a non-negative integer.");
  }
  if (typeof raw.word !== "string" || !/^[A-Z]{3,12}$/.test(raw.word)) {
    throw new ChallengeResultsStoreError("INVALID_PUZZLE", "puzzle.word must be 3–12 uppercase letters.");
  }
  if (!Array.isArray(raw.guesses) || raw.guesses.length > 12) {
    throw new ChallengeResultsStoreError("INVALID_PUZZLE", "puzzle.guesses must be an array of at most 12 entries.");
  }
  for (const g of raw.guesses) {
    if (typeof g !== "string" || !/^[A-Z]{3,12}$/.test(g)) {
      throw new ChallengeResultsStoreError("INVALID_PUZZLE", "puzzle.guesses entries must be 3–12 uppercase letters.");
    }
  }
  if (typeof raw.solved !== "boolean") {
    throw new ChallengeResultsStoreError("INVALID_PUZZLE", "puzzle.solved must be a boolean.");
  }
  const out = { index: raw.index, word: raw.word, guesses: raw.guesses.slice(), solved: raw.solved };
  if (Number.isInteger(raw.solvedAtMs) && raw.solvedAtMs >= 0) out.solvedAtMs = raw.solvedAtMs;
  return out;
}

function normalizeSession(raw) {
  if (!isPlainObject(raw)) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", "Session must be an object.");
  }
  if (!ID_PATTERN.test(raw.id || "")) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", `Invalid session id: ${raw.id}`);
  }
  if (!ID_PATTERN.test(raw.challengeId || "")) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", `Invalid challengeId: ${raw.challengeId}`);
  }
  if (typeof raw.profileId !== "string" || raw.profileId.length === 0 || raw.profileId.length > 64) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", "profileId must be a 1–64 char string.");
  }
  if (!STATUSES.includes(raw.status)) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", `Invalid status: ${raw.status}`);
  }
  if (typeof raw.startedAt !== "string" || !raw.startedAt) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", "startedAt is required.");
  }
  if (!Array.isArray(raw.puzzles)) {
    throw new ChallengeResultsStoreError("INVALID_SESSION", "puzzles must be an array.");
  }
  const out = {
    id: raw.id,
    challengeId: raw.challengeId,
    profileId: raw.profileId,
    status: raw.status,
    startedAt: raw.startedAt,
    puzzles: raw.puzzles.map(normalizePuzzle)
  };
  if (isValidProfileName(raw.profileName)) {
    out.profileName = raw.profileName;
  }
  if (typeof raw.finishedAt === "string" && raw.finishedAt) out.finishedAt = raw.finishedAt;
  if (Number.isInteger(raw.score) && raw.score >= 0) out.score = raw.score;
  if (Number.isInteger(raw.elapsedSeconds) && raw.elapsedSeconds >= 0) out.elapsedSeconds = raw.elapsedSeconds;
  return out;
}

function buildDefaultStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: []
  };
}

function normalizeStore(raw) {
  if (!isPlainObject(raw)) {
    throw new ChallengeResultsStoreError("INVALID_STORE", "Store must be an object.");
  }
  if (raw.version !== STORE_VERSION) {
    throw new ChallengeResultsStoreError(
      "VERSION_UNSUPPORTED",
      `Challenge results store version ${raw.version} is not supported.`
    );
  }
  if (typeof raw.updatedAt !== "string") {
    throw new ChallengeResultsStoreError("INVALID_STORE", "updatedAt is required.");
  }
  if (!Array.isArray(raw.sessions)) {
    throw new ChallengeResultsStoreError("INVALID_STORE", "sessions must be an array.");
  }
  const seen = new Set();
  const sessions = [];
  for (const s of raw.sessions) {
    const norm = normalizeSession(s);
    if (seen.has(norm.id)) continue;
    seen.add(norm.id);
    sessions.push(norm);
  }
  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return { version: STORE_VERSION, updatedAt: raw.updatedAt, sessions };
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
    throw new ChallengeResultsStoreError(
      "STORE_WRITE_FAILED",
      `Failed to persist challenge results store to ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
}

class ChallengeResultsStore {
  constructor(options = {}) {
    if (!options.filePath) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "filePath is required.");
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
        const fresh = buildDefaultStore();
        fresh.updatedAt = this.now().toISOString();
        await writeJsonAtomic(this.filePath, fresh);
        this.state = fresh;
        return;
      }
      throw new ChallengeResultsStoreError(
        "STORE_READ_FAILED",
        `Failed to read challenge results store from ${this.filePath}: ${err.message}`,
        { cause: err }
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ChallengeResultsStoreError(
        "STORE_PARSE_FAILED",
        `Challenge results store ${this.filePath} is not valid JSON: ${err.message}`,
        { cause: err }
      );
    }
    this.state = normalizeStore(parsed);
  }

  async getSnapshot() {
    return this.load();
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

  async createSession({ challengeId, profileId, profileName, startedAt, puzzles }) {
    if (!ID_PATTERN.test(String(challengeId || ""))) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "Invalid challengeId.");
    }
    if (typeof profileId !== "string" || !profileId) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "profileId is required.");
    }
    if (!Array.isArray(puzzles)) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "puzzles must be an array.");
    }
    const id = generateSessionId();
    const session = {
      id,
      challengeId,
      profileId,
      status: "in-progress",
      startedAt: typeof startedAt === "string" && startedAt ? startedAt : this.now().toISOString(),
      puzzles: puzzles.map(normalizePuzzle)
    };
    if (typeof profileName === "string" && profileName) session.profileName = profileName;
    let resolved = session;
    let resumed = false;
    await this.#commit((state) => {
      // Atomic re-check of the single-in-flight invariant. The route
      // already calls findInFlight() outside the commit and falls
      // through to here only if no in-flight session exists, but two
      // concurrent /start requests for the same (challengeId,
      // profileId) can both pass that check and arrive here. Without
      // this re-check, the second commit would push a SECOND in-flight
      // session and the user would see two parallel timers/scores. By
      // checking inside the updater we guarantee only one session
      // exists per (challengeId, profileId, in-progress|pending) — the
      // racing second caller gets the existing session back as a
      // resume, which is the same observable outcome as if findInFlight
      // had hit it.
      const existing = state.sessions.find((s) =>
        s.challengeId === challengeId
        && s.profileId === profileId
        && (s.status === "in-progress" || s.status === "pending")
      );
      if (existing) {
        resolved = existing;
        resumed = true;
        return state;
      }
      state.sessions.push(session);
      return state;
    });
    return { session: cloneState(resolved), resumed };
  }

  async update(id, patch) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "Invalid session id.");
    }
    if (!isPlainObject(patch)) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "patch must be an object.");
    }
    let updated;
    await this.#commit((state) => {
      const idx = state.sessions.findIndex((s) => s.id === id);
      if (idx === -1) {
        throw new ChallengeResultsStoreError("SESSION_NOT_FOUND", `No session with id ${id}.`);
      }
      const merged = { ...state.sessions[idx] };
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) {
          throw new ChallengeResultsStoreError("INVALID_REQUEST", `Invalid status: ${patch.status}`);
        }
        merged.status = patch.status;
      }
      if (patch.puzzles !== undefined) {
        if (!Array.isArray(patch.puzzles)) {
          throw new ChallengeResultsStoreError("INVALID_REQUEST", "puzzles must be an array.");
        }
        merged.puzzles = patch.puzzles.map(normalizePuzzle);
      }
      if (patch.finishedAt !== undefined) {
        if (patch.finishedAt === null) delete merged.finishedAt;
        else merged.finishedAt = patch.finishedAt;
      }
      if (patch.score !== undefined) {
        if (patch.score === null) delete merged.score;
        else if (!Number.isInteger(patch.score) || patch.score < 0) {
          throw new ChallengeResultsStoreError("INVALID_REQUEST", "score must be a non-negative integer.");
        } else merged.score = patch.score;
      }
      if (patch.elapsedSeconds !== undefined) {
        if (patch.elapsedSeconds === null) delete merged.elapsedSeconds;
        else if (!Number.isInteger(patch.elapsedSeconds) || patch.elapsedSeconds < 0) {
          throw new ChallengeResultsStoreError("INVALID_REQUEST", "elapsedSeconds must be a non-negative integer.");
        } else merged.elapsedSeconds = patch.elapsedSeconds;
      }
      if (patch.profileName !== undefined) {
        if (patch.profileName === null) {
          delete merged.profileName;
        } else if (isValidProfileName(patch.profileName)) {
          merged.profileName = patch.profileName;
        } else {
          // Previously this branch fell through silently — an invalid
          // profileName was just ignored. Every other patch field
          // throws INVALID_REQUEST in that case, so callers can't
          // distinguish "ignored" from "applied" without re-fetching.
          // Bring this in line so the contract is uniform: invalid →
          // throw. The shared validator (lib/profile-name.js, #174)
          // defines the rule.
          throw new ChallengeResultsStoreError(
            "INVALID_REQUEST",
            "profileName must be a 1-32 codepoint string of letters/spaces/apostrophes/hyphens starting with a letter, or null to clear."
          );
        }
      }
      state.sessions.splice(idx, 1, merged);
      updated = merged;
      return state;
    });
    return cloneState(updated);
  }

  // Atomic transactional update for the per-guess hot path. Two
  // concurrent /guess requests for the same session were producing a
  // last-write-wins race: both handlers read `session.puzzles`, both
  // computed `updatedPuzzles` from that stale snapshot, both called
  // update({puzzles: updatedPuzzles}), and the second commit overwrote
  // the first guess. By passing a mutator that runs INSIDE the same
  // #commit lock the store uses for every other write, we guarantee
  // the latest persisted session is the one being mutated.
  //
  // The mutator receives a deep clone of the current session and
  // either returns a new merged session (which is persisted) or
  // throws to abort. The store calls normalizePuzzle/etc. via the
  // outer normalizeStore so structural validation still applies.
  // Returns the post-commit cloned session.
  async transactionalUpdate(id, mutator) {
    if (!ID_PATTERN.test(String(id || ""))) {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "Invalid session id.");
    }
    if (typeof mutator !== "function") {
      throw new ChallengeResultsStoreError("INVALID_REQUEST", "mutator must be a function.");
    }
    await this.#commit((state) => {
      const idx = state.sessions.findIndex((s) => s.id === id);
      if (idx === -1) {
        throw new ChallengeResultsStoreError("SESSION_NOT_FOUND", `No session with id ${id}.`);
      }
      const current = JSON.parse(JSON.stringify(state.sessions[idx]));
      const next = mutator(current);
      if (!isPlainObject(next)) {
        throw new ChallengeResultsStoreError(
          "INVALID_REQUEST",
          "mutator must return a session object."
        );
      }
      // Identity invariants: id/challengeId/profileId are immutable.
      if (next.id !== current.id
        || next.challengeId !== current.challengeId
        || next.profileId !== current.profileId) {
        throw new ChallengeResultsStoreError(
          "INVALID_REQUEST",
          "mutator must not change id/challengeId/profileId."
        );
      }
      state.sessions.splice(idx, 1, next);
      return state;
    });
    // Return the POST-commit (post-normalize) session, not the
    // mutator's raw return value. #commit() runs the whole state
    // through normalizeStore — which strips unknown fields and
    // re-derives a few — so the persisted version can diverge from
    // what the mutator handed back. Reading from this.state ensures
    // callers see exactly what's on disk.
    const persisted = this.state.sessions.find((s) => s.id === id);
    return cloneState(persisted);
  }

  async findById(id) {
    const snap = await this.load();
    return snap.sessions.find((s) => s.id === id) || null;
  }

  // Returns an in-flight session for the given (challengeId, profileId)
  // pair, or null. Used to enforce the single-in-flight-session rule
  // — `start` should resume an existing session rather than create a
  // duplicate.
  async findInFlight(challengeId, profileId) {
    const snap = await this.load();
    return snap.sessions.find(
      (s) => s.challengeId === challengeId
        && s.profileId === profileId
        && (s.status === "pending" || s.status === "in-progress")
    ) || null;
  }

  // Returns ALL completed/timed-out sessions for a challenge, scoring
  // attempts so the caller can build the leaderboard. The scoring
  // formula is owned by the engine; this method just hands back rows.
  async findCompletedForChallenge(challengeId) {
    const snap = await this.load();
    return snap.sessions.filter(
      (s) => s.challengeId === challengeId && TERMINAL_STATUSES.has(s.status)
    );
  }

  // Returns all in-flight sessions across all challenges. Used at boot
  // to recover stuck sessions: any session whose budget already expired
  // during downtime gets marked `timed-out`; the rest remain active.
  async findInFlightAll() {
    const snap = await this.load();
    return snap.sessions.filter(
      (s) => s.status === "pending" || s.status === "in-progress"
    );
  }
}

function cloneState(state) {
  if (state === null || state === undefined) return state;
  return JSON.parse(JSON.stringify(state));
}

module.exports = {
  ChallengeResultsStore,
  ChallengeResultsStoreError,
  generateSessionId,
  normalizeSession,
  normalizeStore,
  STORE_VERSION,
  STATUSES,
  TERMINAL_STATUSES
};
