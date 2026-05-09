const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const SCHEMA_VERSION = 1;
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class AppConfigStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "AppConfigStoreError";
    this.code = code;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// App config overrides are schema-limited to JSON-safe primitives and objects.
function clone(value) {
  return structuredClone(value);
}

function toInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeDefinitionsOverrides(raw, errors) {
  if (!isObject(raw)) {
    return undefined;
  }
  const next = {};

  if (raw.mode !== undefined) {
    const mode = String(raw.mode || "").trim().toLowerCase();
    if (mode !== "memory" && mode !== "lazy" && mode !== "indexed") {
      errors.push("overrides.definitions.mode must be memory, lazy, or indexed.");
    } else {
      next.mode = mode;
    }
  }

  if (raw.cacheSize !== undefined) {
    const cacheSize = toInteger(raw.cacheSize);
    if (cacheSize === null || cacheSize < 1 || cacheSize > 4096) {
      errors.push("overrides.definitions.cacheSize must be an integer between 1 and 4096.");
    } else {
      next.cacheSize = cacheSize;
    }
  }

  if (raw.cacheTtlMs !== undefined) {
    const cacheTtlMs = toInteger(raw.cacheTtlMs);
    if (cacheTtlMs === null || cacheTtlMs < 1000 || cacheTtlMs > 24 * 60 * 60 * 1000) {
      errors.push("overrides.definitions.cacheTtlMs must be between 1000 and 86400000.");
    } else {
      next.cacheTtlMs = cacheTtlMs;
    }
  }

  if (raw.shardCacheSize !== undefined) {
    const shardCacheSize = toInteger(raw.shardCacheSize);
    if (shardCacheSize === null || shardCacheSize < 1 || shardCacheSize > 26) {
      errors.push("overrides.definitions.shardCacheSize must be an integer between 1 and 26.");
    } else {
      next.shardCacheSize = shardCacheSize;
    }
  }

  return Object.keys(next).length ? next : undefined;
}

function normalizeLimitsOverrides(raw, errors) {
  if (!isObject(raw)) {
    return undefined;
  }
  const next = {};

  if (raw.providerManualMaxFileBytes !== undefined) {
    const maxBytes = toInteger(raw.providerManualMaxFileBytes);
    if (maxBytes === null || maxBytes < 1024 * 1024 || maxBytes > 32 * 1024 * 1024) {
      errors.push(
        "overrides.limits.providerManualMaxFileBytes must be an integer between 1048576 and 33554432."
      );
    } else {
      next.providerManualMaxFileBytes = maxBytes;
    }
  }

  if (raw.leaderboardMaxProfiles !== undefined) {
    const maxProfiles = toInteger(raw.leaderboardMaxProfiles);
    if (maxProfiles === null || maxProfiles < 1 || maxProfiles > 1000) {
      errors.push(
        "overrides.limits.leaderboardMaxProfiles must be an integer between 1 and 1000."
      );
    } else {
      next.leaderboardMaxProfiles = maxProfiles;
    }
  }

  if (raw.leaderboardMaxResultsPerProfile !== undefined) {
    const maxResults = toInteger(raw.leaderboardMaxResultsPerProfile);
    if (maxResults === null || maxResults < 1 || maxResults > 10000) {
      errors.push(
        "overrides.limits.leaderboardMaxResultsPerProfile must be an integer between 1 and 10000."
      );
    } else {
      next.leaderboardMaxResultsPerProfile = maxResults;
    }
  }

  return Object.keys(next).length ? next : undefined;
}

function normalizeDiagnosticsOverrides(raw, errors) {
  if (!isObject(raw)) {
    return undefined;
  }
  const next = {};

  if (raw.perfLogging !== undefined) {
    if (typeof raw.perfLogging !== "boolean") {
      errors.push("overrides.diagnostics.perfLogging must be true or false.");
    } else {
      next.perfLogging = raw.perfLogging;
    }
  }

  return Object.keys(next).length ? next : undefined;
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeNotificationsOverrides(raw, errors) {
  if (!isObject(raw)) {
    return undefined;
  }
  const next = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      errors.push("overrides.notifications.enabled must be true or false.");
    } else {
      next.enabled = raw.enabled;
    }
  }
  if (raw.localFireTime !== undefined) {
    if (typeof raw.localFireTime !== "string" || !HHMM_PATTERN.test(raw.localFireTime)) {
      errors.push("overrides.notifications.localFireTime must be a 24-hour HH:MM string.");
    } else {
      next.localFireTime = raw.localFireTime;
    }
  }
  if (raw.gracePeriodMinutes !== undefined) {
    const minutes = toInteger(raw.gracePeriodMinutes);
    if (minutes === null || minutes < 0 || minutes > 1440) {
      errors.push("overrides.notifications.gracePeriodMinutes must be an integer between 0 and 1440.");
    } else {
      next.gracePeriodMinutes = minutes;
    }
  }
  return Object.keys(next).length ? next : undefined;
}

const VAPID_SUBJECT_PATTERN = /^(mailto:|https:)/;

function normalizePushKeys(raw, errors) {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    errors.push("pushKeys must be an object when provided.");
    return undefined;
  }
  const out = {};
  if (typeof raw.publicKey !== "string" || raw.publicKey.length < 80 || raw.publicKey.length > 200) {
    errors.push("pushKeys.publicKey must be the URL-safe base64 string from generateVAPIDKeys().");
    return undefined;
  }
  out.publicKey = raw.publicKey;
  if (typeof raw.privateKey !== "string" || raw.privateKey.length < 40 || raw.privateKey.length > 100) {
    errors.push("pushKeys.privateKey must be the URL-safe base64 string from generateVAPIDKeys().");
    return undefined;
  }
  out.privateKey = raw.privateKey;
  if (typeof raw.subject !== "string" || !VAPID_SUBJECT_PATTERN.test(raw.subject) || raw.subject.length > 256) {
    errors.push("pushKeys.subject must be a mailto: or https: identifier (RFC 8292).");
    return undefined;
  }
  out.subject = raw.subject;
  return out;
}

function normalizeOverrides(rawOverrides, options = {}) {
  const errors = [];
  const allowUnknown = options.allowUnknown === true;
  const overrides = {};

  if (rawOverrides === undefined || rawOverrides === null) {
    return { overrides, errors };
  }
  if (!isObject(rawOverrides)) {
    return {
      overrides,
      errors: ["overrides must be an object when provided."]
    };
  }

  const knownKeys = new Set(["definitions", "limits", "diagnostics", "notifications"]);
  for (const key of Object.keys(rawOverrides)) {
    if (!knownKeys.has(key) && !allowUnknown) {
      errors.push(`overrides.${key} is not supported for runtime updates.`);
    }
  }

  const definitions = normalizeDefinitionsOverrides(rawOverrides.definitions, errors);
  if (definitions) {
    overrides.definitions = definitions;
  }

  const limits = normalizeLimitsOverrides(rawOverrides.limits, errors);
  if (limits) {
    overrides.limits = limits;
  }

  const diagnostics = normalizeDiagnosticsOverrides(rawOverrides.diagnostics, errors);
  if (diagnostics) {
    overrides.diagnostics = diagnostics;
  }

  const notifications = normalizeNotificationsOverrides(rawOverrides.notifications, errors);
  if (notifications) {
    overrides.notifications = notifications;
  }

  return { overrides, errors };
}

function createDefaultState() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    overrides: {}
  };
}

function writeJsonAtomicSync(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      if (!renameErr || !WINDOWS_RENAME_OVERWRITE_CODES.has(renameErr.code)) {
        throw renameErr;
      }
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_cleanupErr) {
      // Best effort cleanup.
    }
    throw new AppConfigStoreError(
      "CONFIG_WRITE_FAILED",
      `Failed to persist app config at ${filePath}.`,
      { cause: err }
    );
  }
}

function normalizeState(rawState, options = {}) {
  const errors = [];
  if (!isObject(rawState)) {
    errors.push("config file must contain an object.");
    return { state: createDefaultState(), errors };
  }

  const { overrides, errors: overrideErrors } = normalizeOverrides(rawState.overrides, options);
  errors.push(...overrideErrors);

  const updatedAt = typeof rawState.updatedAt === "string" && rawState.updatedAt.trim()
    ? rawState.updatedAt
    : new Date(0).toISOString();

  if (rawState.version !== SCHEMA_VERSION) {
    errors.push(`unsupported version ${String(rawState.version)}; expected ${SCHEMA_VERSION}.`);
  }

  const pushKeysErrors = [];
  const pushKeys = normalizePushKeys(rawState.pushKeys, pushKeysErrors);
  errors.push(...pushKeysErrors);

  const state = {
    version: SCHEMA_VERSION,
    updatedAt,
    overrides
  };
  if (pushKeys) state.pushKeys = pushKeys;
  return { state, errors };
}

class AppConfigStore {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(__dirname, "..", "data", "app-config.json"));
    this.logger = options.logger || console;
    this.state = null;
  }

  reloadSync() {
    // Drop the cached state so the next read pulls fresh content from disk.
    // Used by the backup-restore flow after data/app-config.json is
    // swapped — the in-memory cache must not outlive the on-disk swap.
    this.state = null;
    return this.loadSync();
  }

  loadSync() {
    if (this.state) {
      return clone(this.state);
    }

    if (!fs.existsSync(this.filePath)) {
      const fallback = createDefaultState();
      writeJsonAtomicSync(this.filePath, fallback);
      this.state = fallback;
      return clone(this.state);
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      this.logger.warn("App config file is invalid JSON. Resetting to defaults.");
      const fallback = createDefaultState();
      writeJsonAtomicSync(this.filePath, fallback);
      this.state = fallback;
      return clone(this.state);
    }

    const { state, errors } = normalizeState(parsed, { allowUnknown: false });
    if (errors.length > 0) {
      this.logger.warn(
        `App config contained unsupported values and was normalized: ${errors.join(" ")}`
      );
      state.updatedAt = new Date().toISOString();
      writeJsonAtomicSync(this.filePath, state);
    }

    this.state = state;
    return clone(this.state);
  }

  getSnapshotSync() {
    if (!this.state) {
      return this.loadSync();
    }
    return clone(this.state);
  }

  getOverridesSync() {
    const snapshot = this.getSnapshotSync();
    return clone(snapshot.overrides);
  }

  replaceOverridesSync(rawOverrides) {
    this.loadSync();
    const { overrides, errors } = normalizeOverrides(rawOverrides, { allowUnknown: false });
    if (errors.length > 0) {
      throw new AppConfigStoreError("INVALID_OVERRIDES", errors.join(" "));
    }

    const nextState = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      overrides,
      // Preserve pushKeys across overrides updates — the runtime-config
      // PUT path replaces only the overrides block.
      ...(this.state?.pushKeys ? { pushKeys: clone(this.state.pushKeys) } : {})
    };
    writeJsonAtomicSync(this.filePath, nextState);
    this.state = nextState;
    return clone(this.state);
  }

  // Returns the persisted VAPID keypair or null if none exists yet.
  // Includes the private key — server-only callers; never echo this
  // back to clients or include it in runtime-config responses.
  getPushKeysSync() {
    const snapshot = this.getSnapshotSync();
    return snapshot.pushKeys ? clone(snapshot.pushKeys) : null;
  }

  // Generate-on-missing: if no VAPID keypair exists, calls `generate`
  // (typically `web-push.generateVAPIDKeys`) and persists the result.
  // Idempotent: subsequent calls return the existing keys without
  // regenerating, so VAPID stays stable across restarts even though
  // we read on every boot. The subject defaults to the operator's
  // PUSH_VAPID_SUBJECT env var if provided, else mailto:admin@localhost.
  ensurePushKeysSync({ generate, subject } = {}) {
    if (typeof generate !== "function") {
      throw new AppConfigStoreError(
        "INVALID_REQUEST",
        "ensurePushKeysSync requires a generate function (e.g. web-push.generateVAPIDKeys)."
      );
    }
    this.loadSync();
    if (this.state?.pushKeys) return clone(this.state.pushKeys);
    const fresh = generate();
    const resolvedSubject = (typeof subject === "string" && VAPID_SUBJECT_PATTERN.test(subject))
      ? subject
      : "mailto:admin@localhost";
    const errors = [];
    const normalized = normalizePushKeys(
      { ...fresh, subject: resolvedSubject },
      errors
    );
    if (!normalized) {
      throw new AppConfigStoreError(
        "INVALID_PUSH_KEYS",
        `Generated VAPID keys did not validate: ${errors.join(" ")}`
      );
    }
    const nextState = {
      ...this.state,
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      pushKeys: normalized
    };
    writeJsonAtomicSync(this.filePath, nextState);
    this.state = nextState;
    return clone(normalized);
  }
}

module.exports = {
  AppConfigStore,
  AppConfigStoreError,
  createDefaultState,
  normalizeOverrides
};
