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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    if (!Number.isInteger(cacheSize) || cacheSize < 1 || cacheSize > 4096) {
      errors.push("overrides.definitions.cacheSize must be an integer between 1 and 4096.");
    } else {
      next.cacheSize = cacheSize;
    }
  }

  if (raw.cacheTtlMs !== undefined) {
    const cacheTtlMs = toInteger(raw.cacheTtlMs);
    if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 1000 || cacheTtlMs > 24 * 60 * 60 * 1000) {
      errors.push("overrides.definitions.cacheTtlMs must be between 1000 and 86400000.");
    } else {
      next.cacheTtlMs = cacheTtlMs;
    }
  }

  if (raw.shardCacheSize !== undefined) {
    const shardCacheSize = toInteger(raw.shardCacheSize);
    if (!Number.isInteger(shardCacheSize) || shardCacheSize < 1 || shardCacheSize > 26) {
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
    if (!Number.isInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > 32 * 1024 * 1024) {
      errors.push(
        "overrides.limits.providerManualMaxFileBytes must be an integer between 1048576 and 33554432."
      );
    } else {
      next.providerManualMaxFileBytes = maxBytes;
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

  const knownKeys = new Set(["definitions", "limits", "diagnostics"]);
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

  return {
    state: {
      version: SCHEMA_VERSION,
      updatedAt,
      overrides
    },
    errors
  };
}

class AppConfigStore {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(__dirname, "..", "data", "app-config.json"));
    this.logger = options.logger || console;
    this.state = null;
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
      overrides
    };
    writeJsonAtomicSync(this.filePath, nextState);
    this.state = nextState;
    return clone(this.state);
  }
}

module.exports = {
  AppConfigStore,
  AppConfigStoreError,
  createDefaultState,
  normalizeOverrides
};
