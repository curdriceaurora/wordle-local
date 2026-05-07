const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

const DEFAULT_FILE_PATH = path.join(__dirname, "..", "data", "leaderboard.json");
const DEFAULT_MAX_PROFILES = 20;
const DEFAULT_MAX_RESULTS_PER_PROFILE = 400;
const DEFAULT_SCHEMA_VERSION = 1;
const EPOCH_ISO = new Date(0).toISOString();

class LeaderboardStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LeaderboardStoreError";
    this.code = code;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

const PROFILE_NAME_PATTERN = /^[A-Za-z][A-Za-z '-]*$/;
const DAILY_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})\|([^|]+)\|([^|]+)$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const PROFILE_ALLOWED_KEYS = new Set(["id", "name", "createdAt", "updatedAt"]);
const RESULT_ALLOWED_KEYS = new Set([
  "date",
  "won",
  "attempts",
  "maxGuesses",
  "submissionCount",
  "updatedAt"
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnknownKeys(value, allowedKeys) {
  return Object.keys(value).some((key) => !allowedKeys.has(key));
}

function isUnsafeObjectKey(value) {
  return UNSAFE_OBJECT_KEYS.has(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!ISO_DATE_TIME_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function parseDateString(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return value;
}

function parseDailyKey(dailyKey) {
  if (typeof dailyKey !== "string") return null;
  const match = dailyKey.match(DAILY_KEY_PATTERN);
  if (!match) return null;
  const date = parseDateString(match[1]);
  if (!date) return null;
  return {
    date,
    lang: match[2],
    code: match[3]
  };
}

function createEmptyLeaderboardState() {
  return {
    version: DEFAULT_SCHEMA_VERSION,
    updatedAt: EPOCH_ISO,
    profiles: [],
    resultsByProfile: Object.create(null)
  };
}

function normalizeProfile(rawProfile) {
  if (!isObject(rawProfile)) return null;

  const rawId = typeof rawProfile.id === "string" ? rawProfile.id : "";
  const id = rawId.trim();
  if (!id || id.length > 64 || rawId !== id || isUnsafeObjectKey(id)) {
    return null;
  }

  const rawName = typeof rawProfile.name === "string" ? rawProfile.name : "";
  const name = rawName.trim();
  if (!name || name.length > 24 || rawName !== name || !PROFILE_NAME_PATTERN.test(name)) {
    return null;
  }

  const createdAt = isIsoTimestamp(rawProfile.createdAt)
    ? String(rawProfile.createdAt)
    : null;
  const updatedAt = isIsoTimestamp(rawProfile.updatedAt)
    ? String(rawProfile.updatedAt)
    : null;

  if (!createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    name,
    createdAt,
    updatedAt
  };
}

function normalizeResultEntry(rawEntry, dailyKeyDate) {
  if (!isObject(rawEntry)) return null;

  const date = parseDateString(rawEntry.date);
  if (!date || date !== dailyKeyDate) {
    return null;
  }

  if (typeof rawEntry.won !== "boolean") {
    return null;
  }

  const won = rawEntry.won;
  const attempts = rawEntry.attempts;
  if (won && !isPositiveInteger(attempts)) {
    return null;
  }
  if (!won && attempts !== null) {
    return null;
  }

  const maxGuesses = rawEntry.maxGuesses;
  const submissionCount = rawEntry.submissionCount;
  if (!isPositiveInteger(maxGuesses) || !isPositiveInteger(submissionCount)) {
    return null;
  }

  const updatedAt = isIsoTimestamp(rawEntry.updatedAt)
    ? String(rawEntry.updatedAt)
    : null;
  if (!updatedAt) {
    return null;
  }

  return {
    date,
    won,
    attempts,
    maxGuesses,
    submissionCount,
    updatedAt
  };
}

function resolveMergeConflict(left, right) {
  if (!isObject(left) || !isObject(right)) {
    return isObject(right) ? right : left;
  }

  if (left.submissionCount !== right.submissionCount) {
    return left.submissionCount > right.submissionCount ? left : right;
  }

  if (left.won !== right.won) {
    return left.won ? left : right;
  }

  if (left.won && right.won && left.attempts !== right.attempts) {
    return left.attempts < right.attempts ? left : right;
  }

  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? left : right;
  }

  return left;
}

function pruneProfileResults(entriesMap, maxResultsPerProfile) {
  const entries = Object.entries(entriesMap);
  if (entries.length <= maxResultsPerProfile) {
    return { entriesMap, wasPruned: false };
  }

  entries.sort((a, b) => {
    const aDate = a[1].date;
    const bDate = b[1].date;
    if (aDate !== bDate) {
      return aDate.localeCompare(bDate);
    }
    if (a[1].updatedAt !== b[1].updatedAt) {
      return a[1].updatedAt.localeCompare(b[1].updatedAt);
    }
    return a[0].localeCompare(b[0]);
  });

  const keep = entries.slice(entries.length - maxResultsPerProfile);
  const normalized = Object.create(null);
  keep.forEach(([dailyKey, entry]) => {
    normalized[dailyKey] = entry;
  });
  return {
    entriesMap: normalized,
    wasPruned: true
  };
}

function normalizeLeaderboardState(rawState, options = {}) {
  const maxProfiles = Number.isInteger(options.maxProfiles) && options.maxProfiles >= 1
    ? options.maxProfiles
    : DEFAULT_MAX_PROFILES;
  const maxResultsPerProfile =
    Number.isInteger(options.maxResultsPerProfile) && options.maxResultsPerProfile >= 1
    ? options.maxResultsPerProfile
    : DEFAULT_MAX_RESULTS_PER_PROFILE;

  let hadInvalidContent = false;
  let wasPruned = false;

  if (!isObject(rawState)) {
    return {
      state: createEmptyLeaderboardState(),
      hadInvalidContent: true,
      wasPruned: false
    };
  }

  const version = DEFAULT_SCHEMA_VERSION;
  if (rawState.version !== DEFAULT_SCHEMA_VERSION) {
    hadInvalidContent = true;
  }

  const updatedAt = isIsoTimestamp(rawState.updatedAt)
    ? String(rawState.updatedAt)
    : EPOCH_ISO;
  if (updatedAt !== rawState.updatedAt) {
    hadInvalidContent = true;
  }

  const rawProfiles = Array.isArray(rawState.profiles) ? rawState.profiles : [];
  if (!Array.isArray(rawState.profiles)) {
    hadInvalidContent = true;
  }

  const profiles = [];
  const seenProfileIds = new Set();
  rawProfiles.forEach((rawProfile) => {
    const profile = normalizeProfile(rawProfile);
    if (!profile) {
      hadInvalidContent = true;
      return;
    }
    if (hasUnknownKeys(rawProfile, PROFILE_ALLOWED_KEYS)) {
      hadInvalidContent = true;
    }
    if (seenProfileIds.has(profile.id)) {
      hadInvalidContent = true;
      return;
    }
    seenProfileIds.add(profile.id);
    profiles.push(profile);
  });

  profiles.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });

  let prunedProfiles = profiles;
  const prunedProfileIds = new Set();
  if (profiles.length > maxProfiles) {
    prunedProfiles = profiles.slice(profiles.length - maxProfiles);
    const keptIds = new Set(prunedProfiles.map((profile) => profile.id));
    for (const profile of profiles) {
      if (!keptIds.has(profile.id)) {
        prunedProfileIds.add(profile.id);
      }
    }
    wasPruned = true;
  }

  const rawResultsByProfile = isObject(rawState.resultsByProfile)
    ? rawState.resultsByProfile
    : {};
  if (!isObject(rawState.resultsByProfile)) {
    hadInvalidContent = true;
  }

  const resultsByProfile = Object.create(null);
  const keptProfileIds = new Set(prunedProfiles.map((profile) => profile.id));

  Object.entries(rawResultsByProfile).forEach(([profileId, rawEntries]) => {
    if (!keptProfileIds.has(profileId)) {
      if (!prunedProfileIds.has(profileId)) {
        hadInvalidContent = true;
      }
      return;
    }
    if (!isObject(rawEntries)) {
      hadInvalidContent = true;
      return;
    }

    const normalizedEntries = Object.create(null);
    Object.entries(rawEntries).forEach(([dailyKey, rawEntry]) => {
      const parsedKey = parseDailyKey(dailyKey);
      if (!parsedKey) {
        hadInvalidContent = true;
        return;
      }

      const entry = normalizeResultEntry(rawEntry, parsedKey.date);
      if (!entry) {
        hadInvalidContent = true;
        return;
      }
      if (hasUnknownKeys(rawEntry, RESULT_ALLOWED_KEYS)) {
        hadInvalidContent = true;
      }

      normalizedEntries[dailyKey] = entry;
    });

    const { entriesMap: prunedEntries, wasPruned: profileWasPruned } = pruneProfileResults(
      normalizedEntries,
      maxResultsPerProfile
    );
    if (profileWasPruned) {
      wasPruned = true;
    }

    if (Object.keys(prunedEntries).length > 0) {
      resultsByProfile[profileId] = prunedEntries;
    }
  });

  const state = {
    version,
    updatedAt,
    profiles: prunedProfiles,
    resultsByProfile
  };

  return {
    state,
    hadInvalidContent,
    wasPruned
  };
}

class LeaderboardStore {
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_FILE_PATH;
    this.maxProfiles = Number.isInteger(options.maxProfiles) && options.maxProfiles >= 1
      ? options.maxProfiles
      : DEFAULT_MAX_PROFILES;
    this.maxResultsPerProfile =
      Number.isInteger(options.maxResultsPerProfile) && options.maxResultsPerProfile >= 1
      ? options.maxResultsPerProfile
      : DEFAULT_MAX_RESULTS_PER_PROFILE;
    this.logger = options.logger || console;
    this.now = typeof options.now === "function" ? options.now : () => new Date();

    this.state = null;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.state) {
      return clone(this.state);
    }
    if (!this.loadPromise) {
      this.loadPromise = this.#loadInternal();
    }
    await this.loadPromise;
    return clone(this.state);
  }

  async getSnapshot() {
    await this.load();
    return clone(this.state);
  }

  async replace(nextState) {
    return this.#enqueueWrite(async () => {
      const { state } = normalizeLeaderboardState(nextState, {
        maxProfiles: this.maxProfiles,
        maxResultsPerProfile: this.maxResultsPerProfile
      });
      state.updatedAt = this.now().toISOString();
      await this.#persist(state);
      this.state = state;
      return clone(this.state);
    });
  }

  async mutate(mutator) {
    if (typeof mutator !== "function") {
      throw new Error("mutator must be a function.");
    }

    return this.#enqueueWrite(async () => {
      const draft = clone(this.state);
      await mutator(draft);

      const { state } = normalizeLeaderboardState(draft, {
        maxProfiles: this.maxProfiles,
        maxResultsPerProfile: this.maxResultsPerProfile
      });
      state.updatedAt = this.now().toISOString();

      await this.#persist(state);
      this.state = state;
      return clone(this.state);
    });
  }

  async deleteProfile(profileId) {
    const id = String(profileId || "").trim();
    if (!id) {
      throw new LeaderboardStoreError("INVALID_REQUEST", "profileId is required.");
    }

    return this.mutate((draft) => {
      const index = draft.profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        throw new LeaderboardStoreError("PROFILE_NOT_FOUND", "Player profile not found.");
      }
      draft.profiles.splice(index, 1);
      if (draft.resultsByProfile && Object.prototype.hasOwnProperty.call(draft.resultsByProfile, id)) {
        delete draft.resultsByProfile[id];
      }
    });
  }

  async mergeProfiles(sourceId, targetId) {
    const source = String(sourceId || "").trim();
    const target = String(targetId || "").trim();

    if (!source || !target) {
      throw new LeaderboardStoreError(
        "INVALID_REQUEST",
        "Both sourceId and targetId are required."
      );
    }
    if (source === target) {
      throw new LeaderboardStoreError(
        "INVALID_REQUEST",
        "Cannot merge a profile into itself."
      );
    }

    const nowIso = this.now().toISOString();

    return this.mutate((draft) => {
      const sourceProfile = draft.profiles.find((profile) => profile.id === source);
      if (!sourceProfile) {
        throw new LeaderboardStoreError("PROFILE_NOT_FOUND", "Source profile not found.");
      }
      const targetProfile = draft.profiles.find((profile) => profile.id === target);
      if (!targetProfile) {
        throw new LeaderboardStoreError("PROFILE_NOT_FOUND", "Target profile not found.");
      }

      const sourceResults = draft.resultsByProfile?.[source] || {};
      const targetResults = draft.resultsByProfile?.[target] || {};
      const merged = Object.create(null);

      for (const [dailyKey, entry] of Object.entries(targetResults)) {
        merged[dailyKey] = entry;
      }
      for (const [dailyKey, entry] of Object.entries(sourceResults)) {
        const existing = merged[dailyKey];
        merged[dailyKey] = existing ? resolveMergeConflict(existing, entry) : entry;
      }

      if (!isObject(draft.resultsByProfile)) {
        draft.resultsByProfile = {};
      }
      if (Object.keys(merged).length > 0) {
        draft.resultsByProfile[target] = merged;
      } else {
        delete draft.resultsByProfile[target];
      }
      delete draft.resultsByProfile[source];

      targetProfile.updatedAt = nowIso;

      const sourceIndex = draft.profiles.findIndex((profile) => profile.id === source);
      if (sourceIndex !== -1) {
        draft.profiles.splice(sourceIndex, 1);
      }
    });
  }

  setLimits(options = {}) {
    if (!isObject(options)) {
      throw new LeaderboardStoreError("INVALID_REQUEST", "options must be an object.");
    }
    const profileCount = this.state ? this.state.profiles.length : 0;

    if (options.maxProfiles !== undefined) {
      const next = Number(options.maxProfiles);
      if (!Number.isInteger(next) || next < 1) {
        throw new LeaderboardStoreError(
          "INVALID_REQUEST",
          "maxProfiles must be a positive integer."
        );
      }
      if (next < profileCount) {
        throw new LeaderboardStoreError(
          "MAX_PROFILES_TOO_LOW",
          `Cannot lower maxProfiles to ${next}; ${profileCount} profiles are currently registered.`
        );
      }
      this.maxProfiles = next;
    }

    if (options.maxResultsPerProfile !== undefined) {
      const next = Number(options.maxResultsPerProfile);
      if (!Number.isInteger(next) || next < 1) {
        throw new LeaderboardStoreError(
          "INVALID_REQUEST",
          "maxResultsPerProfile must be a positive integer."
        );
      }
      this.maxResultsPerProfile = next;
    }

    return {
      maxProfiles: this.maxProfiles,
      maxResultsPerProfile: this.maxResultsPerProfile
    };
  }

  async #enqueueWrite(operation) {
    await this.load();

    const run = async () => operation();
    const next = this.writeQueue.then(run, run);

    // Keep the internal queue alive even when an operation fails.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined
    );

    return next;
  }

  async #loadInternal() {
    const emptyState = createEmptyLeaderboardState();
    let rawState = null;
    let needsPersist = false;

    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      rawState = JSON.parse(raw);
      if (
        isObject(rawState) &&
        Number.isInteger(rawState.version) &&
        rawState.version !== DEFAULT_SCHEMA_VERSION
      ) {
        throw new Error(`Unsupported leaderboard schema version: ${rawState.version}`);
      }
    } catch (err) {
      if (err && err.code === "ENOENT") {
        rawState = emptyState;
        needsPersist = true;
      } else if (err instanceof SyntaxError) {
        this.logger.warn("Leaderboard store file is invalid JSON. Resetting to empty state.");
        rawState = emptyState;
        needsPersist = true;
      } else {
        throw err;
      }
    }

    const { state, hadInvalidContent, wasPruned } = normalizeLeaderboardState(rawState, {
      maxProfiles: this.maxProfiles,
      maxResultsPerProfile: this.maxResultsPerProfile
    });

    if (hadInvalidContent || wasPruned) {
      needsPersist = true;
      this.logger.warn("Leaderboard store contained invalid or excess entries and was normalized.");
    }

    this.state = state;
    if (needsPersist) {
      await this.#persist(this.state);
    }
  }

  async #persist(state) {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp`;

    await fsp.writeFile(tempPath, payload, "utf8");
    try {
      await fsp.rename(tempPath, this.filePath);
    } catch (err) {
      if (err && (err.code === "EEXIST" || err.code === "EPERM")) {
        await fsp.rm(this.filePath, { force: true });
        await fsp.rename(tempPath, this.filePath);
        return;
      }
      await fsp.rm(tempPath, { force: true });
      throw err;
    }
  }
}

module.exports = {
  LeaderboardStore,
  LeaderboardStoreError,
  createEmptyLeaderboardState,
  normalizeLeaderboardState,
  parseDailyKey,
  resolveMergeConflict,
  PROFILE_NAME_PATTERN,
  DEFAULT_FILE_PATH,
  DEFAULT_MAX_PROFILES,
  DEFAULT_MAX_RESULTS_PER_PROFILE
};
