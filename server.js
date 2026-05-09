const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const nodeCrypto = require("node:crypto");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const {
  LeaderboardStore,
  LeaderboardStoreError,
  parseDailyKey,
  PROFILE_NAME_PATTERN
} = require("./lib/leaderboard-store");
const { AdminJobsStore } = require("./lib/admin-jobs-store");
const { ClassesStore, ClassesStoreError } = require("./lib/classes-store");
const { buildCsv, parseBulkNames, UTF8_BOM } = require("./lib/csv-format");
const { requireAdmin } = require("./lib/admin-auth");
const { AppConfigStore, AppConfigStoreError } = require("./lib/app-config-store");
const { aggregate: aggregateAnalytics } = require("./lib/analytics-aggregator");
const { ScheduleStore } = require("./lib/schedule-store");
const { reconcileDailyWord } = require("./lib/scheduler-tick");
const { LanguageRegistryError, LanguageRegistryStore } = require("./lib/language-registry");
const { SUPPORTED_VARIANT_IDS } = require("./lib/provider-artifact-shared");
const { fetchAndPersistProviderSource, computeSha256 } = require("./lib/provider-fetch");
const { persistManualProviderSource } = require("./lib/provider-manual-upload");
const { checkProviderUpdate, ProviderUpdateCheckError } = require("./lib/provider-update-check");
const { buildExpandedFormsArtifacts } = require("./lib/provider-hunspell");
const { buildProviderPoolsArtifacts } = require("./lib/provider-pool-policy");
const {
  buildFilteredAnswerPoolArtifacts,
  FILTER_MODES: PROVIDER_FILTER_MODES
} = require("./lib/provider-answer-filter");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const REQUIRE_ADMIN_KEY = process.env.REQUIRE_ADMIN_KEY === "true" || NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY
  ? process.env.TRUST_PROXY === "true"
  : NODE_ENV === "production";
const TRUST_PROXY_HOPS = parsePositiveInteger(process.env.TRUST_PROXY_HOPS, 1);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;
const ADMIN_RATE_LIMIT_WINDOW_MS = parsePositiveInteger(
  process.env.ADMIN_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_WINDOW_MS
);
const ADMIN_RATE_LIMIT_MAX = parsePositiveInteger(process.env.ADMIN_RATE_LIMIT_MAX, 90);
const ADMIN_WRITE_RATE_LIMIT_WINDOW_MS = parsePositiveInteger(
  process.env.ADMIN_WRITE_RATE_LIMIT_WINDOW_MS,
  ADMIN_RATE_LIMIT_WINDOW_MS
);
const ADMIN_WRITE_RATE_LIMIT_MAX = parsePositiveInteger(
  process.env.ADMIN_WRITE_RATE_LIMIT_MAX,
  30
);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "12mb";
const LEGACY_LOW_MEMORY_DEFINITIONS = process.env.LOW_MEMORY_DEFINITIONS === "true";
const ENV_DEFINITIONS_MODE = resolveDefinitionsMode();
const ENV_DEFINITION_CACHE_SIZE = parsePositiveInteger(process.env.DEFINITION_CACHE_SIZE, 512);
const ENV_DEFINITION_CACHE_TTL_MS = parseNonNegativeInteger(
  process.env.DEFINITION_CACHE_TTL_MS,
  30 * 60 * 1000
);
const ENV_DEFINITION_SHARD_CACHE_SIZE = parsePositiveInteger(
  process.env.DEFINITION_SHARD_CACHE_SIZE,
  6
);
const ENV_PROVIDER_MANUAL_MAX_FILE_BYTES = parsePositiveInteger(
  process.env.PROVIDER_MANUAL_MAX_FILE_BYTES,
  8 * 1024 * 1024
);
const LEADERBOARD_MAX_PROFILES_MIN = 1;
const LEADERBOARD_MAX_PROFILES_MAX = 1000;
const LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN = 1;
const LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX = 10000;

function clampEnvBounded(rawValue, defaultValue, min, max, envName) {
  if (rawValue === undefined) {
    return defaultValue;
  }
  const numeric = Number(rawValue);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    console.warn(
      `${envName}=${String(rawValue)} is not a positive integer; using default ${defaultValue}.`
    );
    return defaultValue;
  }
  if (numeric < min || numeric > max) {
    console.warn(
      `${envName}=${String(rawValue)} is outside the documented range (${min}-${max}); using default ${defaultValue}.`
    );
    return defaultValue;
  }
  return numeric;
}

const ENV_LEADERBOARD_MAX_PROFILES = clampEnvBounded(
  process.env.LEADERBOARD_MAX_PROFILES,
  50,
  LEADERBOARD_MAX_PROFILES_MIN,
  LEADERBOARD_MAX_PROFILES_MAX,
  "LEADERBOARD_MAX_PROFILES"
);
const ENV_LEADERBOARD_MAX_RESULTS_PER_PROFILE = clampEnvBounded(
  process.env.LEADERBOARD_MAX_RESULTS_PER_PROFILE,
  400,
  LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN,
  LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX,
  "LEADERBOARD_MAX_RESULTS_PER_PROFILE"
);
const ENV_PERF_LOGGING = process.env.PERF_LOGGING === "true";

const DATA_PATH = path.join(__dirname, "data", "word.json");
const DATA_ROOT = path.join(__dirname, "data");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PUBLIC_DIST = path.join(PUBLIC_ROOT, "dist");
// Only flip to dist-mode if the build pipeline has produced an index.html
// there. Otherwise vendor-only subdirectories (e.g. public/dist/vendor/)
// would silently hijack the public root and 404 manifest.json / icons /
// sw.js — which the express.static mount on PUBLIC_ROOT already serves
// correctly, including their nested /dist/ subpath.
const PUBLIC_PATH = fs.existsSync(path.join(PUBLIC_DIST, "index.html"))
  ? PUBLIC_DIST
  : PUBLIC_ROOT;
const DICT_PATH = path.join(DATA_ROOT, "dictionaries");
const PROVIDERS_ROOT = process.env.PROVIDERS_ROOT
  ? path.resolve(process.env.PROVIDERS_ROOT)
  : path.join(DATA_ROOT, "providers");
const EN_DEFINITIONS_PATH = path.join(DICT_PATH, "en-definitions.json");
const EN_DEFINITIONS_INDEX_DIR = path.join(DICT_PATH, "en-definitions-index");
const EN_DEFINITIONS_INDEX_MANIFEST_PATH = path.join(EN_DEFINITIONS_INDEX_DIR, "manifest.json");
const LEADERBOARD_DATA_PATH = process.env.STATS_STORE_PATH
  ? path.resolve(process.env.STATS_STORE_PATH)
  : path.join(__dirname, "data", "leaderboard.json");
const LANGUAGE_REGISTRY_PATH = path.join(__dirname, "data", "languages.json");
const ADMIN_JOBS_DATA_PATH = process.env.ADMIN_JOBS_STORE_PATH
  ? path.resolve(process.env.ADMIN_JOBS_STORE_PATH)
  : path.join(__dirname, "data", "admin-jobs.json");
const ADMIN_JOBS_ROOT = path.dirname(ADMIN_JOBS_DATA_PATH);
const ADMIN_JOBS_STAGING_ROOT = path.join(ADMIN_JOBS_ROOT, "staging");
const APP_CONFIG_PATH = process.env.APP_CONFIG_PATH
  ? path.resolve(process.env.APP_CONFIG_PATH)
  : path.join(__dirname, "data", "app-config.json");
const CLASSES_DATA_PATH = process.env.CLASSES_STORE_PATH
  ? path.resolve(process.env.CLASSES_STORE_PATH)
  : path.join(__dirname, "data", "classes.json");
const SCHEDULE_DATA_PATH = process.env.SCHEDULE_STORE_PATH
  ? path.resolve(process.env.SCHEDULE_STORE_PATH)
  : path.join(__dirname, "data", "schedule.json");
const PROVIDERS_DATA_ROOT = process.env.PROVIDERS_ROOT
  ? path.resolve(process.env.PROVIDERS_ROOT)
  : path.join(__dirname, "data", "providers");
const ENV_CLASSES_MAX_MEMBERS_PER_CLASS = clampEnvBounded(
  process.env.CLASSES_MAX_MEMBERS_PER_CLASS,
  1000,
  1,
  // Match data/classes.schema.json's memberProfileIds.maxItems so the
  // env cap can never produce a persisted classes.json that violates
  // the on-disk contract.
  1000,
  "CLASSES_MAX_MEMBERS_PER_CLASS"
);
const ENV_BACKUP_MAX_BYTES = clampEnvBounded(
  process.env.BACKUP_MAX_BYTES,
  256 * 1024 * 1024,
  1024 * 1024,
  // Hard upper bound — operators wanting larger archives should split.
  4 * 1024 * 1024 * 1024,
  "BACKUP_MAX_BYTES"
);
const ENV_BACKUP_INCLUDE_PROVIDERS_DEFAULT =
  String(process.env.BACKUP_INCLUDE_PROVIDERS_DEFAULT || "").toLowerCase() === "true";
const ENV_BACKUP_RATE_LIMIT_WINDOW_MS = clampEnvBounded(
  process.env.BACKUP_RATE_LIMIT_WINDOW_MS,
  30 * 1000,
  1000,
  60 * 60 * 1000,
  "BACKUP_RATE_LIMIT_WINDOW_MS"
);
const ENV_BACKUP_RATE_LIMIT_MAX = clampEnvBounded(
  process.env.BACKUP_RATE_LIMIT_MAX,
  1,
  1,
  100,
  "BACKUP_RATE_LIMIT_MAX"
);
// Lower bound is 1ms so tests/operators can effectively disable the
// analytics cache by passing a very small TTL — sequential requests
// cross more than 1ms wall-time, so any entry is already expired by
// the next call. Operators wanting normal caching set this to the
// default 60_000 and never see a difference.
const ENV_ANALYTICS_CACHE_TTL_MS = clampEnvBounded(
  process.env.ANALYTICS_CACHE_TTL_MS,
  60 * 1000,
  1,
  60 * 60 * 1000,
  "ANALYTICS_CACHE_TTL_MS"
);
// Operator's IANA timezone for analytics date/hour bucketing. Defaults to
// the server's local zone (process.env.TZ → host) when unset. Validated
// lazily by the aggregator: an unrecognised zone falls back to UTC and the
// boot warning below makes the misconfiguration loud.
const ENV_ANALYTICS_TIMEZONE = (() => {
  const raw = String(process.env.ANALYTICS_TIMEZONE || "").trim();
  if (!raw) return process.env.TZ || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch (_err) {
    console.warn(
      `ANALYTICS_TIMEZONE=${raw} is not a recognised IANA zone; falling back to UTC.`
    );
    return "UTC";
  }
})();
// Scheduler env vars — all optional, sensible defaults. The schedule's
// timezone is stored ON the schedule itself (so operators can change it
// at runtime via the admin UI); SCHEDULE_TIMEZONE_DEFAULT only seeds a
// freshly-created data/schedule.json on first boot.
const ENV_SCHEDULE_TIMEZONE_DEFAULT = (() => {
  const raw = String(process.env.SCHEDULE_TIMEZONE_DEFAULT || "").trim();
  const candidate = raw || process.env.TZ || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch (_err) {
    console.warn(
      `SCHEDULE_TIMEZONE_DEFAULT=${candidate} is not a recognised IANA zone; falling back to UTC.`
    );
    return "UTC";
  }
})();
const ENV_SCHEDULER_CHECK_INTERVAL_MS = clampEnvBounded(
  process.env.SCHEDULER_CHECK_INTERVAL_MS,
  60 * 1000,
  1000,
  60 * 60 * 1000,
  "SCHEDULER_CHECK_INTERVAL_MS"
);
const ENV_SCHEDULE_RETENTION_DAYS = clampEnvBounded(
  process.env.SCHEDULE_RETENTION_DAYS,
  90,
  0,
  36500,
  "SCHEDULE_RETENTION_DAYS"
);

const MIN_LEN = 3;
const MAX_LEN = 12;
const MIN_GUESSES = 4;
const MAX_GUESSES = 10;
const DEFAULT_GUESSES = 6;
const KEY = "WORDLE";
const DEFAULT_LANG = "en";
const LEADERBOARD_RANGE = Object.freeze({
  weekly: "weekly",
  monthly: "monthly",
  overall: "overall"
});
const STATS_UNAVAILABLE_ERROR = "Stats service unavailable right now. Try again soon.";
const PROVIDER_ADMIN_UNAVAILABLE_ERROR =
  "Provider admin request failed right now. Try again soon.";
const PROVIDER_ID = "libreoffice-dictionaries";
const PROVIDER_REPOSITORY = "https://github.com/LibreOffice/dictionaries";
const PROVIDER_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PROVIDER_MIN_LENGTH = 3;
const PROVIDER_POLICY_VERSION = "v1";
const PROVIDER_IMPORT_SOURCE_TYPES = Object.freeze({
  REMOTE_FETCH: "remote-fetch",
  MANUAL_UPLOAD: "manual-upload"
});
const SUPPORTED_PROVIDER_IMPORT_SOURCE_TYPES = new Set(Object.values(PROVIDER_IMPORT_SOURCE_TYPES));
const PROVIDER_CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_UPLOAD_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PROVIDER_MANUAL_MAX_FILE_BYTES_MIN = 1024 * 1024;
const PROVIDER_MANUAL_MAX_FILE_BYTES_MAX = 32 * 1024 * 1024;
const JSON_BODY_LIMIT_OVERHEAD_BYTES = 64 * 1024;
const PROVIDER_VARIANT_LABELS = Object.freeze({
  "en-GB": "English (UK)",
  "en-US": "English (US)",
  "en-CA": "English (Canada)",
  "en-AU": "English (Australia)",
  "en-ZA": "English (South Africa)"
});
const SUPPORTED_PROVIDER_VARIANTS = new Set(SUPPORTED_VARIANT_IDS);
const SUPPORTED_PROVIDER_FILTER_MODES = new Set(Object.values(PROVIDER_FILTER_MODES));
const BAKED_LANGUAGES = Object.freeze({
  en: Object.freeze({ label: "English", file: "en.txt" })
});
let wordDataCache = null;
const definitionCache = new Map();
const definitionShardCache = new Map();
const DEFINITION_CACHE_MISS = Symbol("definition-cache-miss");
const INDEX_LOOKUP_UNAVAILABLE = Symbol("index-lookup-unavailable");
let fullEnglishDefinitions = null;
let englishDefinitionIndexManifest = null;
let hasWarnedAboutDefinitionIndex = false;

// Data-mutation lock used by backup export and restore. Acts as both a
// boolean flag (the /api gate reads `.value` to 503 mutating requests)
// AND a Promise barrier (stores call `.waitForRelease()` at the start
// of every mutate so any in-flight handler that already passed the
// gate is paused until the lock clears). Without the barrier, a
// handler that passed the gate, hit an `await` (e.g. getSnapshot),
// then resumed during a restore could call mutate() and overwrite the
// just-restored file with cached pre-restore state.
const dataMutationLockRef = {
  _value: false,
  _releaseResolve: null,
  _releasePromise: Promise.resolve(),
  get value() {
    return this._value;
  },
  set value(next) {
    if (next && !this._value) {
      this._value = true;
      this._releasePromise = new Promise((resolve) => {
        this._releaseResolve = resolve;
      });
    } else if (!next && this._value) {
      this._value = false;
      const resolve = this._releaseResolve;
      this._releaseResolve = null;
      if (resolve) resolve();
    }
  },
  async waitForRelease() {
    if (!this._value) return;
    await this._releasePromise;
  }
};
// Stores call this at the top of every mutation. Waits until BOTH
// dataMutationLockRef AND restoreInProgressRef are clear. The latter
// is held across a restore's full multipart upload, before the data
// lock is taken — so a mutation that arrives during the upload would
// otherwise pass straight through, load pre-restore state, and then
// (after the lock is taken and released) persist that stale state
// over the just-restored file. Looping covers the case where a new
// restore claims a flag between two `await waitForRelease()` calls.
async function waitForDataMutationLock() {
  while (dataMutationLockRef.value || restoreInProgressRef.value) {
    if (dataMutationLockRef.value) {
      await dataMutationLockRef.waitForRelease();
      continue;
    }
    if (restoreInProgressRef.value) {
      await restoreInProgressRef.waitForRelease();
      continue;
    }
  }
}

// Atomic claim helper for direct data writers. Loops: wait for
// whichever barrier is holding things up, then synchronously verify
// no restore/lock is in flight and bump the counter. Returns a
// release fn to call in finally. Without this, a writer that simply
// awaits waitForDataMutationLock() can race a new restore that claims
// the lock during the next event-loop tick.
//
// Critically, restoreInProgressRef is held across the restore's
// multipart upload (which can take many seconds) WITHOUT
// dataMutationLockRef being held. Awaiting only the data-lock barrier
// would resolve immediately and the loop would spin until the upload
// finished — busy-looping on already-resolved awaits hangs the event
// loop and stalls the upload itself. We pick the right barrier per
// iteration so the wait is real every time.
async function claimDirectDataWriteSlot() {
  while (true) {
    if (dataMutationLockRef.value) {
      await dataMutationLockRef.waitForRelease();
      continue;
    }
    if (restoreInProgressRef.value) {
      await restoreInProgressRef.waitForRelease();
      continue;
    }
    // Neither flag is held — claim the slot in the same synchronous
    // tick (no awaits between the check and the increment, so JS's
    // single-threaded model guarantees no other handler interposes).
    directDataWriteActiveRef.value += 1;
    return () => {
      directDataWriteActiveRef.value -= 1;
    };
  }
}

const leaderboardStore = new LeaderboardStore({
  filePath: LEADERBOARD_DATA_PATH,
  maxProfiles: ENV_LEADERBOARD_MAX_PROFILES,
  maxResultsPerProfile: ENV_LEADERBOARD_MAX_RESULTS_PER_PROFILE,
  waitForDataMutationLock
});

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseByteSizeLiteral(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  const match = normalized.match(/^([0-9]+)(kb|mb|gb)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  const multiplier = match[2] === "kb"
    ? 1024
    : match[2] === "mb"
      ? 1024 * 1024
      : 1024 * 1024 * 1024;
  const totalBytes = value * multiplier;
  return Number.isSafeInteger(totalBytes) ? totalBytes : null;
}

function normalizeDefinitionsMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "memory" || value === "lazy" || value === "indexed") {
    return value;
  }
  return null;
}

function resolveDefinitionsMode() {
  const explicitMode = normalizeDefinitionsMode(process.env.DEFINITIONS_MODE);
  if (explicitMode) {
    return explicitMode;
  }
  if (process.env.DEFINITIONS_MODE) {
    console.warn(
      `Unknown DEFINITIONS_MODE="${process.env.DEFINITIONS_MODE}". Falling back to "memory".`
    );
  }
  if (LEGACY_LOW_MEMORY_DEFINITIONS) {
    return "indexed";
  }
  return "memory";
}

function hasValidPositiveIntegerEnv(name) {
  if (process.env[name] === undefined) {
    return false;
  }
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0;
}

function hasValidNonNegativeIntegerEnv(name) {
  if (process.env[name] === undefined) {
    return false;
  }
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0;
}

function hasValidBoundedPositiveIntegerEnv(name, min, max) {
  if (process.env[name] === undefined) {
    return false;
  }
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

const ENV_CONFIG = Object.freeze({
  definitions: Object.freeze({
    mode: ENV_DEFINITIONS_MODE,
    cacheSize: ENV_DEFINITION_CACHE_SIZE,
    cacheTtlMs: ENV_DEFINITION_CACHE_TTL_MS,
    shardCacheSize: ENV_DEFINITION_SHARD_CACHE_SIZE
  }),
  limits: Object.freeze({
    providerManualMaxFileBytes: ENV_PROVIDER_MANUAL_MAX_FILE_BYTES,
    leaderboardMaxProfiles: ENV_LEADERBOARD_MAX_PROFILES,
    leaderboardMaxResultsPerProfile: ENV_LEADERBOARD_MAX_RESULTS_PER_PROFILE
  }),
  diagnostics: Object.freeze({
    perfLogging: ENV_PERF_LOGGING
  })
});

const ENV_CONFIG_LOCKS = Object.freeze({
  definitions: Object.freeze({
    mode: Boolean(normalizeDefinitionsMode(process.env.DEFINITIONS_MODE) || LEGACY_LOW_MEMORY_DEFINITIONS),
    cacheSize: hasValidPositiveIntegerEnv("DEFINITION_CACHE_SIZE"),
    cacheTtlMs: hasValidNonNegativeIntegerEnv("DEFINITION_CACHE_TTL_MS"),
    shardCacheSize: hasValidPositiveIntegerEnv("DEFINITION_SHARD_CACHE_SIZE")
  }),
  limits: Object.freeze({
    providerManualMaxFileBytes: hasValidPositiveIntegerEnv("PROVIDER_MANUAL_MAX_FILE_BYTES"),
    leaderboardMaxProfiles: hasValidBoundedPositiveIntegerEnv(
      "LEADERBOARD_MAX_PROFILES",
      LEADERBOARD_MAX_PROFILES_MIN,
      LEADERBOARD_MAX_PROFILES_MAX
    ),
    leaderboardMaxResultsPerProfile: hasValidBoundedPositiveIntegerEnv(
      "LEADERBOARD_MAX_RESULTS_PER_PROFILE",
      LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN,
      LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX
    )
  }),
  diagnostics: Object.freeze({
    perfLogging: process.env.PERF_LOGGING !== undefined
  })
});

const runtimeConfigState = {
  overrides: {},
  effective: cloneRuntimeConfigObject(ENV_CONFIG),
  sources: {
    definitions: {
      mode: ENV_CONFIG_LOCKS.definitions.mode ? "env" : "default",
      cacheSize: ENV_CONFIG_LOCKS.definitions.cacheSize ? "env" : "default",
      cacheTtlMs: ENV_CONFIG_LOCKS.definitions.cacheTtlMs ? "env" : "default",
      shardCacheSize: ENV_CONFIG_LOCKS.definitions.shardCacheSize ? "env" : "default"
    },
    limits: {
      providerManualMaxFileBytes: ENV_CONFIG_LOCKS.limits.providerManualMaxFileBytes
        ? "env"
        : "default",
      leaderboardMaxProfiles: ENV_CONFIG_LOCKS.limits.leaderboardMaxProfiles
        ? "env"
        : "default",
      leaderboardMaxResultsPerProfile: ENV_CONFIG_LOCKS.limits.leaderboardMaxResultsPerProfile
        ? "env"
        : "default"
    },
    diagnostics: {
      perfLogging: ENV_CONFIG_LOCKS.diagnostics.perfLogging ? "env" : "default"
    }
  }
};

function cloneRuntimeConfigObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveRuntimeConfigFromOverrides(rawOverrides) {
  const overrides = rawOverrides && typeof rawOverrides === "object"
    ? cloneRuntimeConfigObject(rawOverrides)
    : {};

  const effective = cloneRuntimeConfigObject(ENV_CONFIG);
  const sources = {
    definitions: {
      mode: ENV_CONFIG_LOCKS.definitions.mode ? "env" : "default",
      cacheSize: ENV_CONFIG_LOCKS.definitions.cacheSize ? "env" : "default",
      cacheTtlMs: ENV_CONFIG_LOCKS.definitions.cacheTtlMs ? "env" : "default",
      shardCacheSize: ENV_CONFIG_LOCKS.definitions.shardCacheSize ? "env" : "default"
    },
    limits: {
      providerManualMaxFileBytes: ENV_CONFIG_LOCKS.limits.providerManualMaxFileBytes
        ? "env"
        : "default",
      leaderboardMaxProfiles: ENV_CONFIG_LOCKS.limits.leaderboardMaxProfiles
        ? "env"
        : "default",
      leaderboardMaxResultsPerProfile: ENV_CONFIG_LOCKS.limits.leaderboardMaxResultsPerProfile
        ? "env"
        : "default"
    },
    diagnostics: {
      perfLogging: ENV_CONFIG_LOCKS.diagnostics.perfLogging ? "env" : "default"
    }
  };

  if (!ENV_CONFIG_LOCKS.definitions.mode && overrides.definitions?.mode) {
    effective.definitions.mode = overrides.definitions.mode;
    sources.definitions.mode = "override";
  }
  if (!ENV_CONFIG_LOCKS.definitions.cacheSize && overrides.definitions?.cacheSize !== undefined) {
    effective.definitions.cacheSize = Number(overrides.definitions.cacheSize);
    sources.definitions.cacheSize = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.definitions.cacheTtlMs
    && overrides.definitions?.cacheTtlMs !== undefined
  ) {
    effective.definitions.cacheTtlMs = Number(overrides.definitions.cacheTtlMs);
    sources.definitions.cacheTtlMs = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.definitions.shardCacheSize
    && overrides.definitions?.shardCacheSize !== undefined
  ) {
    effective.definitions.shardCacheSize = Number(overrides.definitions.shardCacheSize);
    sources.definitions.shardCacheSize = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.limits.providerManualMaxFileBytes
    && overrides.limits?.providerManualMaxFileBytes !== undefined
  ) {
    effective.limits.providerManualMaxFileBytes = Number(overrides.limits.providerManualMaxFileBytes);
    sources.limits.providerManualMaxFileBytes = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.limits.leaderboardMaxProfiles
    && overrides.limits?.leaderboardMaxProfiles !== undefined
  ) {
    effective.limits.leaderboardMaxProfiles = Number(overrides.limits.leaderboardMaxProfiles);
    sources.limits.leaderboardMaxProfiles = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.limits.leaderboardMaxResultsPerProfile
    && overrides.limits?.leaderboardMaxResultsPerProfile !== undefined
  ) {
    effective.limits.leaderboardMaxResultsPerProfile = Number(
      overrides.limits.leaderboardMaxResultsPerProfile
    );
    sources.limits.leaderboardMaxResultsPerProfile = "override";
  }
  if (
    !ENV_CONFIG_LOCKS.diagnostics.perfLogging
    && overrides.diagnostics?.perfLogging !== undefined
  ) {
    effective.diagnostics.perfLogging = Boolean(overrides.diagnostics.perfLogging);
    sources.diagnostics.perfLogging = "override";
  }

  return { overrides, effective, sources };
}

function applyRuntimeConfig(overrides) {
  const previousMode = runtimeConfigState.effective.definitions.mode;
  const previousShardCacheSize = runtimeConfigState.effective.definitions.shardCacheSize;
  const previousMaxResultsPerProfile =
    runtimeConfigState.effective.limits.leaderboardMaxResultsPerProfile;
  const next = resolveRuntimeConfigFromOverrides(overrides);

  // Apply leaderboard limits to the store first; if it fails (e.g. a hand-edited
  // app-config sets a cap below the current profile count), keep the previously
  // effective limits in the runtime snapshot so /api/admin/runtime-config does
  // not advertise a value the store is not actually enforcing.
  let limitsApplied = true;
  try {
    leaderboardStore.setLimits({
      maxProfiles: next.effective.limits.leaderboardMaxProfiles,
      maxResultsPerProfile: next.effective.limits.leaderboardMaxResultsPerProfile
    });
  } catch (err) {
    limitsApplied = false;
    console.warn(
      `[runtime-config] Could not apply leaderboard limits: ${err?.message || String(err)}`
    );
    next.effective.limits = {
      ...next.effective.limits,
      leaderboardMaxProfiles: runtimeConfigState.effective.limits.leaderboardMaxProfiles,
      leaderboardMaxResultsPerProfile:
        runtimeConfigState.effective.limits.leaderboardMaxResultsPerProfile
    };
    next.sources.limits = {
      ...next.sources.limits,
      leaderboardMaxProfiles: runtimeConfigState.sources.limits.leaderboardMaxProfiles,
      leaderboardMaxResultsPerProfile:
        runtimeConfigState.sources.limits.leaderboardMaxResultsPerProfile
    };
  }

  runtimeConfigState.overrides = next.overrides;
  runtimeConfigState.effective = next.effective;
  runtimeConfigState.sources = next.sources;

  if (runtimeConfigState.effective.definitions.mode !== previousMode) {
    definitionCache.clear();
    definitionShardCache.clear();
    hasWarnedAboutDefinitionIndex = false;
    if (runtimeConfigState.effective.definitions.mode === "memory") {
      getOrLoadFullDefinitionsMap();
    }
  }

  if (runtimeConfigState.effective.definitions.shardCacheSize < previousShardCacheSize) {
    while (
      definitionShardCache.size > runtimeConfigState.effective.definitions.shardCacheSize
    ) {
      const oldestKey = definitionShardCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      definitionShardCache.delete(oldestKey);
    }
  }

  // If the per-profile result cap was lowered, force a noop mutate so existing
  // in-memory results past the new cap are pruned-and-persisted right away.
  // Return the unhandled promise so callers can decide: admin PUT awaits it
  // and lets a rejection surface as 503; boot wraps its own .catch so a
  // pruning failure logs but doesn't crash the process.
  if (
    limitsApplied
    && runtimeConfigState.effective.limits.leaderboardMaxResultsPerProfile
      < previousMaxResultsPerProfile
  ) {
    return leaderboardStore.mutate(() => {});
  }

  return undefined;
}

function getRuntimeConfigSnapshot() {
  return {
    effective: cloneRuntimeConfigObject(runtimeConfigState.effective),
    overrides: cloneRuntimeConfigObject(runtimeConfigState.overrides),
    sources: cloneRuntimeConfigObject(runtimeConfigState.sources),
    locks: cloneRuntimeConfigObject(ENV_CONFIG_LOCKS)
  };
}

function getDefinitionsMode() {
  return runtimeConfigState.effective.definitions.mode;
}

function getDefinitionCacheSize() {
  return runtimeConfigState.effective.definitions.cacheSize;
}

function getDefinitionCacheTtlMs() {
  return runtimeConfigState.effective.definitions.cacheTtlMs;
}

function getDefinitionShardCacheSize() {
  return runtimeConfigState.effective.definitions.shardCacheSize;
}

function getProviderManualMaxFileBytes() {
  return runtimeConfigState.effective.limits.providerManualMaxFileBytes;
}

function isPerfLoggingEnabled() {
  return runtimeConfigState.effective.diagnostics.perfLogging;
}

function createPerfTimer(label) {
  if (!isPerfLoggingEnabled()) return null;
  return {
    label,
    start: process.hrtime.bigint()
  };
}

function endPerfTimer(timer, details = "") {
  if (!timer) return;
  const elapsedMs = Number(process.hrtime.bigint() - timer.start) / 1e6;
  const suffix = details ? ` ${details}` : "";
  console.log(`[perf] ${timer.label} ${elapsedMs.toFixed(2)}ms${suffix}`);
}

function buildDefaultWordData() {
  return {
    word: "",
    lang: DEFAULT_LANG,
    date: null,
    updatedAt: new Date().toISOString()
  };
}

function isValidWordData(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.word !== "string") return false;
  if (typeof data.lang !== "string") return false;
  if (!(data.date === null || typeof data.date === "string")) return false;
  // lastScheduledFor is optional. When present it must be a YYYY-MM-DD
  // string — the reconciler reads it to decide whether the most recent
  // write was scheduler or manual-override. Reject other shapes so we
  // don't silently pass garbage into the reconcile decision.
  if (data.lastScheduledFor !== undefined && data.lastScheduledFor !== null) {
    if (typeof data.lastScheduledFor !== "string") return false;
  }
  return true;
}

function normalizeWordData(data) {
  const fallback = buildDefaultWordData();
  const normalized = { ...fallback, ...data };
  normalized.word = normalizeWord(normalized.word || "");
  normalized.lang = normalizeLang(normalized.lang) || fallback.lang;
  normalized.date = normalized.date ? String(normalized.date) : null;
  normalized.updatedAt = normalized.updatedAt
    ? String(normalized.updatedAt)
    : new Date().toISOString();
  // Pass-through if present-and-valid; drop otherwise so legacy files
  // and malformed values both end up with the field absent.
  if (typeof data?.lastScheduledFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.lastScheduledFor)) {
    normalized.lastScheduledFor = data.lastScheduledFor;
  } else {
    delete normalized.lastScheduledFor;
  }
  return normalized;
}

function readWordData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    if (isValidWordData(data)) {
      return normalizeWordData(data);
    }
  } catch (err) {
    // Ignore and fall back to default.
  }
  return null;
}

function saveWordData(data) {
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function saveWordDataAtomic(data) {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${DATA_PATH}.tmp`;
  await fsp.writeFile(tempPath, payload, "utf8");
  try {
    await fsp.rename(tempPath, DATA_PATH);
  } catch (err) {
    if (err && (err.code === "EEXIST" || err.code === "EPERM")) {
      await fsp.rm(DATA_PATH, { force: true });
      await fsp.rename(tempPath, DATA_PATH);
      return;
    }
    await fsp.rm(tempPath, { force: true });
    throw err;
  }
}

function ensureWordData() {
  const data = readWordData();
  if (data) {
    wordDataCache = data;
    return data;
  }
  const fallback = buildDefaultWordData();
  saveWordData(fallback);
  wordDataCache = fallback;
  console.warn("Daily word data was invalid and has been reset.");
  return fallback;
}

function canonicalizeLanguageId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const match = /^([a-zA-Z]{2})(?:-([a-zA-Z]{2}))?$/.exec(value);
  if (!match) {
    return value;
  }
  const language = match[1].toLowerCase();
  if (!match[2]) {
    return language;
  }
  return `${language}-${match[2].toUpperCase()}`;
}
function normalizeLang(raw) {
  const key = canonicalizeLanguageId(raw);
  if (registeredLanguageCatalog.has(key)) return key;
  if (!key) return DEFAULT_LANG;
  return null;
}

function normalizeWord(raw) {
  return String(raw || "").trim().toUpperCase();
}

function getMinLengthForLang() {
  return MIN_LEN;
}

function assertWord(word, minLength = MIN_LEN) {
  if (!/^[A-Z]+$/.test(word)) {
    throw new Error("Word must use only letters A-Z.");
  }
  if (word.length < minLength || word.length > MAX_LEN) {
    throw new Error(`Word length must be ${minLength}-${MAX_LEN} letters.`);
  }
}

function encodeWord(word) {
  const upper = normalizeWord(word);
  let output = "";
  for (let i = 0; i < upper.length; i += 1) {
    const p = upper.charCodeAt(i) - 65;
    const k = KEY.charCodeAt(i % KEY.length) - 65;
    output += String.fromCharCode(((p + k) % 26) + 65);
  }
  return output;
}

function decodeWord(code) {
  const upper = normalizeWord(code);
  let output = "";
  for (let i = 0; i < upper.length; i += 1) {
    const c = upper.charCodeAt(i) - 65;
    const k = KEY.charCodeAt(i % KEY.length) - 65;
    output += String.fromCharCode(((c - k + 26) % 26) + 65);
  }
  return output;
}

function resolveDictionaryPath(file) {
  const normalized = String(file || "").trim().replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }
  const candidates = [
    path.join(DICT_PATH, normalized),
    path.join(DATA_ROOT, normalized)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function loadDictionary(file, minLength) {
  const timer = createPerfTimer(`dictionary.load.${file}`);
  const fullPath = resolveDictionaryPath(file);
  if (!fs.existsSync(fullPath)) {
    endPerfTimer(timer, "missing");
    return null;
  }

  const raw = fs.readFileSync(fullPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const byLength = new Map();
  const listByLength = new Map();
  let totalCount = 0;

  for (const line of lines) {
    const word = line.trim().toUpperCase();
    if (!word) continue;
    if (!/^[A-Z]+$/.test(word)) continue;
    if (word.length < minLength || word.length > MAX_LEN) continue;

    let set = byLength.get(word.length);
    if (!set) {
      set = new Set();
      byLength.set(word.length, set);
    }
    if (set.has(word)) continue;
    set.add(word);
    totalCount += 1;

    let list = listByLength.get(word.length);
    if (!list) {
      list = [];
      listByLength.set(word.length, list);
    }
    list.push(word);
  }

  if (totalCount === 0) {
    endPerfTimer(timer, "empty");
    return null;
  }
  const dictionary = {
    byLength,
    listByLength,
    totalCount,
    minLength
  };
  endPerfTimer(timer, `words=${totalCount}`);
  return dictionary;
}

function loadWordDefinitions(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const source = parsed && typeof parsed === "object" && parsed.definitions
      ? parsed.definitions
      : parsed;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      console.warn("Definition file is invalid. Continuing without answer meanings.");
      return new Map();
    }

    const map = new Map();
    for (const [word, definition] of Object.entries(source)) {
      const normalizedWord = normalizeWord(word);
      if (!/^[A-Z]+$/.test(normalizedWord)) continue;
      const normalizedDefinition = String(definition || "").trim().replace(/\s+/g, " ");
      if (!normalizedDefinition) continue;
      map.set(normalizedWord, normalizedDefinition);
    }
    return map;
  } catch (err) {
    console.warn("Failed to load local definitions. Continuing without answer meanings.");
    return new Map();
  }
}

function loadWordDefinitionsFromObject(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const map = new Map();
  for (const [word, definition] of Object.entries(source)) {
    const normalizedWord = normalizeWord(word);
    if (!/^[A-Z]+$/.test(normalizedWord)) continue;
    const normalizedDefinition = String(definition || "").trim().replace(/\s+/g, " ");
    if (!normalizedDefinition) continue;
    map.set(normalizedWord, normalizedDefinition);
  }
  return map;
}

function loadDefinitionIndexManifest() {
  if (englishDefinitionIndexManifest) {
    return englishDefinitionIndexManifest;
  }
  if (!fs.existsSync(EN_DEFINITIONS_INDEX_MANIFEST_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(EN_DEFINITIONS_INDEX_MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const shards = parsed && typeof parsed === "object" ? parsed.shards : null;
    if (!shards || typeof shards !== "object" || Array.isArray(shards)) {
      return null;
    }
    englishDefinitionIndexManifest = {
      generatedAt: parsed.generatedAt || "",
      shards
    };
    return englishDefinitionIndexManifest;
  } catch (err) {
    return null;
  }
}

function getOrLoadFullDefinitionsMap() {
  if (fullEnglishDefinitions) {
    return fullEnglishDefinitions;
  }
  const timer = createPerfTimer("definitions.load.full");
  fullEnglishDefinitions = loadWordDefinitions(EN_DEFINITIONS_PATH);
  endPerfTimer(timer, `entries=${fullEnglishDefinitions.size}`);
  return fullEnglishDefinitions;
}

function cacheDefinition(word, value) {
  const ttlMs = getDefinitionCacheTtlMs();
  const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;
  if (definitionCache.has(word)) {
    definitionCache.delete(word);
  }
  definitionCache.set(word, { value, expiresAt });
  if (definitionCache.size > getDefinitionCacheSize()) {
    const oldest = definitionCache.keys().next().value;
    if (oldest) {
      definitionCache.delete(oldest);
    }
  }
}

function readDefinitionCache(word) {
  if (!definitionCache.has(word)) {
    return DEFINITION_CACHE_MISS;
  }
  const entry = definitionCache.get(word);
  if (!entry) {
    return DEFINITION_CACHE_MISS;
  }
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    definitionCache.delete(word);
    return DEFINITION_CACHE_MISS;
  }
  definitionCache.delete(word);
  definitionCache.set(word, entry);
  return entry.value;
}

function cacheDefinitionShard(shardId, definitionsMap) {
  if (definitionShardCache.has(shardId)) {
    definitionShardCache.delete(shardId);
  }
  definitionShardCache.set(shardId, definitionsMap);
  if (definitionShardCache.size > getDefinitionShardCacheSize()) {
    const oldest = definitionShardCache.keys().next().value;
    if (oldest) {
      definitionShardCache.delete(oldest);
    }
  }
}

function loadDefinitionShard(shardId) {
  if (definitionShardCache.has(shardId)) {
    const cached = definitionShardCache.get(shardId);
    definitionShardCache.delete(shardId);
    definitionShardCache.set(shardId, cached);
    return cached;
  }

  const manifest = loadDefinitionIndexManifest();
  if (!manifest || !manifest.shards) {
    return INDEX_LOOKUP_UNAVAILABLE;
  }
  const shardEntry = manifest.shards[shardId];
  if (
    !shardEntry ||
    typeof shardEntry !== "object" ||
    Array.isArray(shardEntry) ||
    typeof shardEntry.file !== "string" ||
    shardEntry.file.length === 0
  ) {
    return INDEX_LOOKUP_UNAVAILABLE;
  }
  const fileName = shardEntry.file;
  const shardPath = path.join(EN_DEFINITIONS_INDEX_DIR, fileName);
  if (!fs.existsSync(shardPath)) {
    return INDEX_LOOKUP_UNAVAILABLE;
  }

  try {
    const raw = fs.readFileSync(shardPath, "utf8");
    const parsed = JSON.parse(raw);
    const map = loadWordDefinitionsFromObject(parsed);
    if (!map) {
      return INDEX_LOOKUP_UNAVAILABLE;
    }
    cacheDefinitionShard(shardId, map);
    return map;
  } catch (err) {
    return INDEX_LOOKUP_UNAVAILABLE;
  }
}

function lookupDefinitionByIndexedShard(word) {
  if (!/^[A-Z]+$/.test(word)) {
    return null;
  }
  const shardId = word[0];
  const shard = loadDefinitionShard(shardId);
  if (shard === INDEX_LOOKUP_UNAVAILABLE) {
    return INDEX_LOOKUP_UNAVAILABLE;
  }
  return shard.get(word) || null;
}

function warnDefinitionIndexFallback() {
  if (hasWarnedAboutDefinitionIndex) {
    return;
  }
  hasWarnedAboutDefinitionIndex = true;
  console.warn(
    "Definition index is missing or invalid. Falling back to lazy full-map lookups."
  );
}

function lookupEnglishDefinition(word) {
  const cached = readDefinitionCache(word);
  if (cached !== DEFINITION_CACHE_MISS) {
    return cached;
  }

  const timer = createPerfTimer("definitions.lookup");
  let value = null;
  const definitionsMode = getDefinitionsMode();
  let source = definitionsMode;

  if (definitionsMode === "memory" || definitionsMode === "lazy") {
    value = getOrLoadFullDefinitionsMap().get(word) || null;
  } else if (definitionsMode === "indexed") {
    const indexedValue = lookupDefinitionByIndexedShard(word);
    if (indexedValue === INDEX_LOOKUP_UNAVAILABLE) {
      source = "lazy-fallback";
      warnDefinitionIndexFallback();
      value = getOrLoadFullDefinitionsMap().get(word) || null;
    } else {
      value = indexedValue;
    }
  } else {
    value = getOrLoadFullDefinitionsMap().get(word) || null;
  }

  cacheDefinition(word, value);
  endPerfTimer(timer, `mode=${source} found=${Boolean(value)}`);
  return value;
}

const dictionaries = Object.create(null);
const answerDictionaries = Object.create(null);
const languageRegistryStore = new LanguageRegistryStore({
  filePath: LANGUAGE_REGISTRY_PATH,
  bakedLanguages: BAKED_LANGUAGES,
  getMinLengthForLang,
  logger: console
});
const appConfigStore = new AppConfigStore({
  filePath: APP_CONFIG_PATH,
  logger: console
});
const adminJobsStore = new AdminJobsStore({
  filePath: ADMIN_JOBS_DATA_PATH,
  logger: console,
  waitForDataMutationLock
});
const classesStore = new ClassesStore({
  filePath: CLASSES_DATA_PATH,
  maxMembersPerClass: ENV_CLASSES_MAX_MEMBERS_PER_CLASS,
  logger: console,
  waitForDataMutationLock
});
const scheduleStore = new ScheduleStore({
  filePath: SCHEDULE_DATA_PATH,
  defaultTimezone: ENV_SCHEDULE_TIMEZONE_DEFAULT,
  defaultRetentionDays: ENV_SCHEDULE_RETENTION_DAYS,
  logger: console
});
let schedulerIntervalRef = null;

// Run a single reconcile pass: re-load schedule, fetch current word.json,
// route through reconcileDailyWord, persist via saveWordDataAtomic, update
// the in-memory wordDataCache. All errors are logged and swallowed because
// the caller (boot path / setInterval) cannot meaningfully react.
async function runSchedulerReconcile(reason = "tick") {
  let schedule;
  try {
    schedule = await scheduleStore.load();
  } catch (err) {
    console.error(`[scheduler] reconcile aborted (${reason}): could not load schedule:`, err.message);
    return null;
  }
  const currentWord = wordDataCache || readWordData() || buildDefaultWordData();
  try {
    const result = await reconcileDailyWord({
      schedule,
      currentWordData: currentWord,
      now: new Date(),
      defaultLang: DEFAULT_LANG,
      providersRoot: PROVIDERS_DATA_ROOT,
      languagesPath: LANGUAGE_REGISTRY_PATH,
      saveWordData: async (data) => {
        await saveWordDataAtomic(data);
        wordDataCache = normalizeWordData(data);
      },
      recordReconcile: async ({ date, at }) => {
        try {
          await scheduleStore.recordReconcile({ date, at });
        } catch (err) {
          console.warn(`[scheduler] could not record reconcile timestamp: ${err.message}`);
        }
      },
      logger: console
    });
    return result;
  } catch (err) {
    console.error(`[scheduler] reconcile failed (${reason}):`, err.message);
    return null;
  }
}

function startSchedulerInterval() {
  if (schedulerIntervalRef) return;
  schedulerIntervalRef = setInterval(() => {
    runSchedulerReconcile("interval").catch((err) => {
      console.error("[scheduler] unhandled interval error:", err);
    });
  }, ENV_SCHEDULER_CHECK_INTERVAL_MS);
  // unref so the timer doesn't keep the process alive past test teardown.
  if (typeof schedulerIntervalRef.unref === "function") {
    schedulerIntervalRef.unref();
  }
}

function stopSchedulerInterval() {
  if (schedulerIntervalRef) {
    clearInterval(schedulerIntervalRef);
    schedulerIntervalRef = null;
  }
}
let registeredLanguageCatalog = new Map();
let availableLanguages = new Map();
const providerImportQueueActiveRef = { value: false };
const providerImportSyncActiveRef = { value: false };
// Set by the async provider-import endpoint while it's staging the
// upload and enqueuing the job into data/admin-jobs.json. Without
// this, a restore could squeeze between the import's busy check and
// its enqueue, write the archive over admin-jobs.json, and leave the
// staged upload + queued job orphaned. The restore busy check
// observes this ref and 409s the restore in that window.
const providerImportEnqueueActiveRef = { value: false };
// Promise-barrier for restoreInProgressRef so direct writers can
// `await` for the restore to release without busy-spinning on a
// resolved data-lock barrier (the data lock isn't held during the
// restore's upload phase). Mirrors the dataMutationLockRef shape.
const restoreInProgressRef = (() => {
  const ref = {
    _value: false,
    _resolveRelease: null,
    _releasePromise: Promise.resolve(),
    get value() {
      return this._value;
    },
    set value(next) {
      if (next && !this._value) {
        this._value = true;
        this._releasePromise = new Promise((resolve) => {
          this._resolveRelease = resolve;
        });
      } else if (!next && this._value) {
        this._value = false;
        const resolve = this._resolveRelease;
        this._resolveRelease = null;
        if (resolve) resolve();
      }
    },
    async waitForRelease() {
      if (!this._value) return;
      await this._releasePromise;
    }
  };
  return ref;
})();
// Counter incremented by direct (non-store-mutate) data writers —
// PUT /api/admin/runtime-config and POST /api/word — for the duration
// of their validation+persist sequence. The restore busy check
// observes this counter so a new restore can't slip in between a
// direct writer's lock-wait return and its actual write, which would
// validate against pre-restore state and persist over the swap.
// The writer claims the slot atomically: loop awaiting
// waitForDataMutationLock() then synchronously check restore flags
// and increment the counter (no awaits between the check and
// increment).
const directDataWriteActiveRef = { value: 0 };
// dataMutationLockRef, waitForDataMutationLock, restoreInProgressRef,
// providerImportEnqueueActiveRef, directDataWriteActiveRef, and
// claimDirectDataWriteSlot are all defined earlier alongside
// leaderboardStore so the store constructor can wire the barrier and
// admin/backup routes can share the helpers.

function initializeRuntimeConfig() {
  let normalizePromise;
  try {
    const snapshot = appConfigStore.loadSync();
    normalizePromise = applyRuntimeConfig(snapshot.overrides || {});
  } catch (err) {
    console.error("Failed to load app config overrides. Falling back to environment defaults.", err);
    normalizePromise = applyRuntimeConfig({});
  }
  if (normalizePromise && typeof normalizePromise.catch === "function") {
    normalizePromise.catch((err) => {
      console.warn(
        `[runtime-config] Could not normalize leaderboard at boot: ${err?.message || String(err)}`
      );
    });
  }
}

function clearObjectValues(target) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
}

function getProviderVariantLabel(variant) {
  return PROVIDER_VARIANT_LABELS[variant] || `English (${variant})`;
}

function buildProviderRelativePath(variant, commit, fileName) {
  return path.posix.join("providers", variant, commit, fileName);
}

function buildProviderArtifactPaths(variant, commit) {
  return {
    guessPool: buildProviderRelativePath(variant, commit, "guess-pool.txt"),
    answerPoolActive: buildProviderRelativePath(variant, commit, "answer-pool-active.txt"),
    answerPoolFallback: buildProviderRelativePath(variant, commit, "answer-pool.txt"),
    sourceManifest: buildProviderRelativePath(variant, commit, "source-manifest.json")
  };
}

function listImportableProviderCommits(variant) {
  if (!SUPPORTED_PROVIDER_VARIANTS.has(variant)) {
    return [];
  }
  const variantRoot = path.join(PROVIDERS_ROOT, variant);
  if (!fs.existsSync(variantRoot)) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(variantRoot, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const commits = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((commit) => PROVIDER_COMMIT_PATTERN.test(commit))
    .filter((commit) => {
      const base = (p) => path.join(PROVIDERS_ROOT, variant, commit, p);
      const hasGuessPool = fs.existsSync(base("guess-pool.txt"));
      const hasAnswerPool = fs.existsSync(base("answer-pool-active.txt"))
        || fs.existsSync(base("answer-pool.txt"));
      const hasManifest = fs.existsSync(base("source-manifest.json"));
      return hasGuessPool && hasAnswerPool && hasManifest;
    })
    // Commits are lowercase hex strings; code-point sort keeps ordering deterministic across locales.
    .sort((left, right) => {
      if (left === right) return 0;
      return left > right ? -1 : 1;
    });
  return commits;
}

function listProviderCommitDirectories(variant) {
  if (!SUPPORTED_PROVIDER_VARIANTS.has(variant)) {
    return [];
  }
  const variantRoot = path.join(PROVIDERS_ROOT, variant);
  if (!fs.existsSync(variantRoot)) {
    return [];
  }
  try {
    return fs
      .readdirSync(variantRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((commit) => PROVIDER_COMMIT_PATTERN.test(commit))
      // Commits are lowercase hex strings; code-point sort keeps ordering deterministic across locales/filesystems.
      .sort((left, right) => {
        if (left === right) return 0;
        return left > right ? -1 : 1;
      });
  } catch (err) {
    return [];
  }
}

function resolvePreferredProviderCommit(variant, requestedCommit) {
  if (requestedCommit) {
    const normalized = String(requestedCommit || "").trim();
    if (!PROVIDER_COMMIT_PATTERN.test(normalized)) {
      throw new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.");
    }
    const available = listImportableProviderCommits(variant);
    if (!available.includes(normalized)) {
      throw new StatsApiError(
        404,
        "Imported provider artifacts were not found for that variant and commit."
      );
    }
    return normalized;
  }
  const available = listImportableProviderCommits(variant);
  if (!available.length) {
    throw new StatsApiError(404, "No imported provider artifacts found for that variant.");
  }
  return available[0];
}

function parseProviderFilterMode(value) {
  const normalized = String(value || PROVIDER_FILTER_MODES.DENYLIST_ONLY).trim();
  if (!SUPPORTED_PROVIDER_FILTER_MODES.has(normalized)) {
    throw new StatsApiError(
      400,
      `filterMode must be one of ${Array.from(SUPPORTED_PROVIDER_FILTER_MODES).join(", ")}.`
    );
  }
  return normalized;
}

function parseProviderImportSource(value) {
  const normalized = String(value || PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH).trim();
  if (!SUPPORTED_PROVIDER_IMPORT_SOURCE_TYPES.has(normalized)) {
    throw new StatsApiError(
      400,
      `sourceType must be one of ${Array.from(SUPPORTED_PROVIDER_IMPORT_SOURCE_TYPES).join(", ")}.`
    );
  }
  return normalized;
}

function parseImportAsyncFlag(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return false;
  }
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new StatsApiError(400, "async must be true or false when provided.");
}

function decodeBase64Payload(value, fieldName, maxBytes) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new StatsApiError(400, `${fieldName} is required for manual uploads.`);
  }
  const normalized = raw.replace(/\s+/g, "");
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new StatsApiError(400, `${fieldName} must be valid base64 data.`);
  }
  let buffer;
  try {
    buffer = Buffer.from(normalized, "base64");
  } catch (err) {
    throw new StatsApiError(400, `${fieldName} must be valid base64 data.`);
  }
  if (!buffer.length) {
    throw new StatsApiError(400, `${fieldName} resolved to an empty file.`);
  }
  if (buffer.length > maxBytes) {
    throw new StatsApiError(413, `${fieldName} exceeds the ${maxBytes} byte limit.`);
  }
  return buffer;
}

function normalizeManualUploadFileName(rawValue, expectedExt, fieldName) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    throw new StatsApiError(400, `${fieldName} is required for manual uploads.`);
  }
  const normalized = path.basename(raw);
  if (
    !SAFE_UPLOAD_FILE_NAME_PATTERN.test(normalized)
    || normalized.startsWith(".")
    || normalized !== raw
    || !normalized.toLowerCase().endsWith(expectedExt)
  ) {
    throw new StatsApiError(
      400,
      `${fieldName} must be a safe filename ending with ${expectedExt}.`
    );
  }
  return normalized;
}

function normalizeExpectedChecksums(rawChecksums) {
  const checksums = {
    dic: String(rawChecksums?.dic || "").trim().toLowerCase(),
    aff: String(rawChecksums?.aff || "").trim().toLowerCase()
  };
  if (!PROVIDER_CHECKSUM_PATTERN.test(checksums.dic)) {
    throw new StatsApiError(
      400,
      "expectedChecksums.dic must be a lowercase 64-character SHA-256 checksum."
    );
  }
  if (!PROVIDER_CHECKSUM_PATTERN.test(checksums.aff)) {
    throw new StatsApiError(
      400,
      "expectedChecksums.aff must be a lowercase 64-character SHA-256 checksum."
    );
  }
  return checksums;
}

function buildManualStagingPaths(jobId, dicFileName, affFileName) {
  const stagedRoot = path.join(ADMIN_JOBS_STAGING_ROOT, jobId);
  const stagedDicPath = path.join(stagedRoot, dicFileName);
  const stagedAffPath = path.join(stagedRoot, affFileName);
  return { stagedRoot, stagedDicPath, stagedAffPath };
}

function toRelativeAdminJobPath(absolutePath) {
  const relative = path.relative(ADMIN_JOBS_ROOT, absolutePath);
  const normalized = path.posix.normalize(relative.split(path.sep).join(path.posix.sep));
  if (!normalized || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new StatsApiError(500, "Failed to normalize staged upload path.");
  }
  return normalized;
}

function resolveAdminJobStagingPath(relativePathValue) {
  const relativePath = path.posix.normalize(
    String(relativePathValue || "").trim().split(path.sep).join(path.posix.sep)
  );
  if (!relativePath || relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) {
    throw new StatsApiError(400, "Staged file paths are outside the expected staging directory.");
  }
  const resolvedPath = path.resolve(ADMIN_JOBS_ROOT, relativePath);
  if (
    resolvedPath !== ADMIN_JOBS_STAGING_ROOT
    && !resolvedPath.startsWith(`${ADMIN_JOBS_STAGING_ROOT}${path.sep}`)
  ) {
    throw new StatsApiError(400, "Staged file paths are outside the expected staging directory.");
  }
  return resolvedPath;
}

async function persistManualUploadStaging(jobId, manualFiles, maxBytes) {
  const dicFileName = normalizeManualUploadFileName(
    manualFiles?.dicFileName || "manual-upload.dic",
    ".dic",
    "manualFiles.dicFileName"
  );
  const affFileName = normalizeManualUploadFileName(
    manualFiles?.affFileName || "manual-upload.aff",
    ".aff",
    "manualFiles.affFileName"
  );
  const dicBuffer = decodeBase64Payload(
    manualFiles?.dicBase64,
    "manualFiles.dicBase64",
    maxBytes
  );
  const affBuffer = decodeBase64Payload(
    manualFiles?.affBase64,
    "manualFiles.affBase64",
    maxBytes
  );

  const paths = buildManualStagingPaths(jobId, dicFileName, affFileName);
  await fsp.mkdir(paths.stagedRoot, { recursive: true });
  await Promise.all([
    fsp.writeFile(paths.stagedDicPath, dicBuffer),
    fsp.writeFile(paths.stagedAffPath, affBuffer)
  ]);

  return {
    dicFileName,
    affFileName,
    stagedDicPath: toRelativeAdminJobPath(paths.stagedDicPath),
    stagedAffPath: toRelativeAdminJobPath(paths.stagedAffPath),
    contentChecksums: {
      dic: computeSha256(dicBuffer),
      aff: computeSha256(affBuffer)
    }
  };
}

async function loadManualUploadFromStaging(jobRequest) {
  const manualUpload = jobRequest?.manualUpload;
  if (!manualUpload || typeof manualUpload !== "object") {
    throw new StatsApiError(400, "manualUpload metadata is missing for queued manual import.");
  }
  const stagedDicPath = resolveAdminJobStagingPath(manualUpload.stagedDicPath);
  const stagedAffPath = resolveAdminJobStagingPath(manualUpload.stagedAffPath);

  const [dicBuffer, affBuffer] = await Promise.all([
    fsp.readFile(stagedDicPath),
    fsp.readFile(stagedAffPath)
  ]);

  return {
    dicBase64: dicBuffer.toString("base64"),
    affBase64: affBuffer.toString("base64"),
    dicFileName: manualUpload.dicFileName,
    affFileName: manualUpload.affFileName
  };
}

async function cleanupManualUploadStaging(manualUpload) {
  if (!manualUpload || typeof manualUpload !== "object") {
    return;
  }
  const stagedDicPath = String(manualUpload.stagedDicPath || "").trim();
  const stagedAffPath = String(manualUpload.stagedAffPath || "").trim();
  if (!stagedDicPath && !stagedAffPath) {
    return;
  }
  const dirCandidates = [];
  if (stagedDicPath) {
    dirCandidates.push(path.dirname(resolveAdminJobStagingPath(stagedDicPath)));
  }
  if (stagedAffPath) {
    dirCandidates.push(path.dirname(resolveAdminJobStagingPath(stagedAffPath)));
  }
  await Promise.all(
    Array.from(new Set(dirCandidates)).map(async (dirPath) => {
      if (!dirPath.startsWith(ADMIN_JOBS_STAGING_ROOT)) {
        return;
      }
      await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    })
  );
}

function mapProviderPipelineError(err) {
  if (err instanceof StatsApiError) {
    return err;
  }

  const code = String(err?.code || "").toUpperCase();
  if (
    code === "INVALID_VARIANT"
    || code === "UNSUPPORTED_VARIANT"
    || code === "INVALID_COMMIT"
    || code === "INVALID_CHECKSUM"
    || code === "CHECKSUM_REQUIRED"
    || code === "INVALID_FILTER_MODE"
    || code === "INVALID_POLICY_VERSION"
    || code === "INVALID_POLICY_BOUNDS"
    || code === "INVALID_PATH"
    || code === "INVALID_MANIFEST"
    || code === "ALLOWLIST_REQUIRED"
    || code === "INVALID_MANUAL_SOURCE"
    || code === "MANUAL_FILES_REQUIRED"
    || code === "INVALID_UPLOAD_FILENAME"
  ) {
    return new StatsApiError(400, err.message);
  }
  if (code === "MANUAL_FILE_TOO_LARGE") {
    return new StatsApiError(413, err.message);
  }
  if (code === "SOURCE_NOT_FOUND" || code === "SOURCE_MANIFEST_MISSING") {
    return new StatsApiError(404, err.message);
  }
  if (
    code === "CHECKSUM_MISMATCH"
    || code === "GUESS_POOL_EMPTY"
    || code === "ANSWER_POOL_EMPTY"
    || code === "FILTERED_POOL_EMPTY"
    || code === "HUNSPELL_PARSE_FAILED"
  ) {
    return new StatsApiError(409, err.message);
  }
  if (
    code === "UPSTREAM_RATE_LIMITED"
    || code === "UPSTREAM_SERVER_ERROR"
    || code === "UPSTREAM_REQUEST_FAILED"
    || code === "FETCH_TIMEOUT"
    || code === "FETCH_NETWORK_ERROR"
    || code === "FETCH_UNAVAILABLE"
    || code === "PERSISTENCE_WRITE_FAILED"
    || code === "INPUT_ARTIFACT_MISSING"
    || code === "ALLOWLIST_READ_FAILED"
  ) {
    return new StatsApiError(503, PROVIDER_ADMIN_UNAVAILABLE_ERROR);
  }
  return err;
}

function resolveCurrentProviderCommitForUpdateCheck(variant, requestedCommit) {
  const normalizedRequested = String(requestedCommit || "").trim();
  if (normalizedRequested) {
    if (!PROVIDER_COMMIT_PATTERN.test(normalizedRequested)) {
      throw new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.");
    }
    return normalizedRequested;
  }

  const activeCommit = String(registeredLanguageCatalog.get(variant)?.provider?.commit || "").trim();
  if (PROVIDER_COMMIT_PATTERN.test(activeCommit)) {
    return activeCommit;
  }

  // Without an explicit or active commit selection, keep update checks in "unknown" mode.
  // Imported artifacts alone do not imply which commit is currently intended for comparison.
  return null;
}

function mapProviderUpdateCheckErrorToMessage(err) {
  if (!(err instanceof ProviderUpdateCheckError)) {
    return "Could not check upstream updates right now.";
  }
  const code = String(err.code || "").toUpperCase();
  if (code === "UPSTREAM_RATE_LIMITED") {
    return "Upstream update checks are rate-limited right now. Try again later.";
  }
  if (code === "FETCH_TIMEOUT" || code === "FETCH_NETWORK_ERROR") {
    return "Upstream update check failed due to connectivity problems. Try again later.";
  }
  if (code === "UPSTREAM_SERVER_ERROR" || code === "UPSTREAM_REQUEST_FAILED") {
    return "Upstream update check failed with a remote server error.";
  }
  if (code === "UPSTREAM_RESPONSE_INVALID") {
    return "Upstream update check returned invalid metadata.";
  }
  return "Could not check upstream updates right now.";
}

function rebuildLanguageRuntimeCatalog() {
  clearObjectValues(dictionaries);
  clearObjectValues(answerDictionaries);
  availableLanguages = new Map();

  const snapshot = languageRegistryStore.reloadSync();
  registeredLanguageCatalog = new Map(
    snapshot.languages.map((language) => [language.id, language])
  );

  for (const language of snapshot.languages) {
    if (!language.enabled) {
      continue;
    }
    if (!language.hasDictionary || !language.dictionaryFile) {
      continue;
    }
    const key = language.id;
    const minLength = Number.isInteger(language.minLength) && language.minLength > 0
      ? language.minLength
      : getMinLengthForLang(key);
    const guessDictionary = loadDictionary(language.dictionaryFile, minLength);
    if (!guessDictionary) {
      continue;
    }

    let answerDictionary = guessDictionary;
    if (language.source === "provider" && language.provider) {
      const paths = buildProviderArtifactPaths(language.provider.variant, language.provider.commit);
      answerDictionary = loadDictionary(paths.answerPoolActive, minLength)
        || loadDictionary(paths.answerPoolFallback, minLength);
      if (!answerDictionary) {
        continue;
      }
    }

    dictionaries[key] = guessDictionary;
    answerDictionaries[key] = answerDictionary;
    availableLanguages.set(key, {
      id: key,
      label: language.label,
      minLength,
      hasDictionary: true
    });
  }

  app.locals.availableLanguages = availableLanguages;
  app.locals.languageRegistryStore = languageRegistryStore;
}

initializeRuntimeConfig();
rebuildLanguageRuntimeCatalog();

// Boot-time orphan check: a previous restore that crashed mid-apply leaves
// .restore-staging-* / .restore-rollback-* dirs in data/. Log them loudly
// rather than auto-deleting — operators may need to inspect or rewind.
// Honor BACKUP_PROJECT_ROOT so the scan path matches the restore handler's.
(async () => {
  try {
    const { findOrphanedRestoreDirs } = require("./lib/backup-store.js");
    const backupRoot = process.env.BACKUP_PROJECT_ROOT
      ? path.resolve(process.env.BACKUP_PROJECT_ROOT)
      : __dirname;
    const orphans = await findOrphanedRestoreDirs(path.join(backupRoot, "data"));
    if (orphans.length > 0) {
      const list = orphans.map((entry) => entry.name).join(", ");
      console.warn(
        `[backup-store] Found ${orphans.length} orphaned restore directory(ies) under data/: ${list}. ` +
          "These are left over from a restore that did not complete. " +
          "Inspect their contents before deleting; see docs/backup-restore.md."
      );
    }
  } catch (err) {
    console.warn(`[backup-store] Orphan-dir check failed: ${err?.message || String(err)}`);
  }
})();

if (getDefinitionsMode() === "memory") {
  getOrLoadFullDefinitionsMap();
}

function getDictionary(lang) {
  return dictionaries[lang] || null;
}

function getAnswerDictionary(lang) {
  return answerDictionaries[lang] || null;
}

function isLanguageAvailable(lang) {
  return availableLanguages.has(lang);
}

function resolveLang(raw) {
  const normalized = normalizeLang(raw);
  if (!normalized) return null;
  if (isLanguageAvailable(normalized)) return normalized;
  return null;
}

function dictionaryHasWord(dict, word) {
  if (!dict) return true;
  const set = dict.byLength.get(word.length);
  if (!set) return false;
  return set.has(word);
}

function dictionaryRandomWord(dict, length) {
  if (!dict) return null;
  const list = dict.listByLength.get(length);
  if (!list || list.length === 0) return null;
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

function lookupAnswerMeaning(lang, word) {
  if (lang !== "en") return null;
  const dict = getAnswerDictionary(lang);
  if (!dict || !dictionaryHasWord(dict, word)) return null;
  return lookupEnglishDefinition(word);
}

function getLanguageLabel(lang) {
  return registeredLanguageCatalog.get(lang)?.label || "English";
}

function evaluateGuess(guess, answer) {
  const len = answer.length;
  const result = new Array(len);
  const remaining = new Uint8Array(26);

  for (let i = 0; i < len; i += 1) {
    const guessCode = guess.charCodeAt(i) - 65;
    const answerCode = answer.charCodeAt(i) - 65;
    if (guessCode === answerCode) {
      result[i] = "correct";
      continue;
    }
    result[i] = "absent";
    remaining[answerCode] += 1;
  }

  for (let i = 0; i < len; i += 1) {
    if (result[i] === "correct") {
      continue;
    }
    const guessCode = guess.charCodeAt(i) - 65;
    if (remaining[guessCode] > 0) {
      result[i] = "present";
      remaining[guessCode] -= 1;
    }
  }

  return result;
}

class StatsApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeProfileNameInput(rawName) {
  const cleaned = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!cleaned) {
    throw new StatsApiError(400, "Player name is required.");
  }
  if (cleaned.length > 24) {
    throw new StatsApiError(400, "Player name must be 24 characters or fewer.");
  }
  if (!PROFILE_NAME_PATTERN.test(cleaned)) {
    throw new StatsApiError(
      400,
      "Player name must start with a letter and use only letters, spaces, apostrophes, or hyphens."
    );
  }
  return cleaned;
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StatsApiError(400, `${fieldName} must be a positive integer.`);
  }
}

function parseLeaderboardRange(rawRange) {
  const value = String(rawRange || LEADERBOARD_RANGE.weekly).trim().toLowerCase();
  if (value === LEADERBOARD_RANGE.weekly) return LEADERBOARD_RANGE.weekly;
  if (value === LEADERBOARD_RANGE.monthly) return LEADERBOARD_RANGE.monthly;
  if (value === LEADERBOARD_RANGE.overall) return LEADERBOARD_RANGE.overall;
  throw new StatsApiError(400, "Leaderboard range must be weekly, monthly, or overall.");
}

function parseDateString(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
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
  return date;
}

function dateToUtcStamp(dateString) {
  const date = parseDateString(dateString);
  if (!date) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function diffDays(laterDate, earlierDate) {
  const laterStamp = dateToUtcStamp(laterDate);
  const earlierStamp = dateToUtcStamp(earlierDate);
  if (laterStamp === null || earlierStamp === null) return null;
  return Math.floor((laterStamp - earlierStamp) / (24 * 60 * 60 * 1000));
}

function shiftDate(dateString, deltaDays) {
  const date = parseDateString(dateString);
  if (!date) return null;
  date.setDate(date.getDate() + deltaDays);
  return getLocalDateString(date);
}

function createSummaryAccumulator() {
  return {
    played: 0,
    wins: 0,
    bestAttempts: Number.POSITIVE_INFINITY
  };
}

function addSummaryEntry(accumulator, won, attempts) {
  accumulator.played += 1;
  if (won) {
    accumulator.wins += 1;
    if (Number.isInteger(attempts) && attempts > 0) {
      accumulator.bestAttempts = Math.min(accumulator.bestAttempts, attempts);
    }
  }
}

function finalizeSummaryAccumulator(accumulator) {
  const winRate = accumulator.played
    ? Math.round((accumulator.wins / accumulator.played) * 100)
    : 0;
  return {
    played: accumulator.played,
    wins: accumulator.wins,
    winRate,
    bestAttempts: Number.isFinite(accumulator.bestAttempts)
      ? accumulator.bestAttempts
      : null
  };
}

function computeCurrentStreakFromMap(winsByDate, latestDate, today) {
  if (!latestDate || !winsByDate.get(latestDate)) {
    return 0;
  }
  const gap = diffDays(today, latestDate);
  if (gap === null || gap > 1) {
    return 0;
  }

  let streak = 1;
  let cursor = latestDate;
  while (true) {
    const previous = shiftDate(cursor, -1);
    if (!previous || !winsByDate.get(previous)) {
      break;
    }
    streak += 1;
    cursor = previous;
  }
  return streak;
}

function buildProfilePerformance(dailyResults, today) {
  const winsByDate = new Map();
  const overall = createSummaryAccumulator();
  const weekly = createSummaryAccumulator();
  const monthly = createSummaryAccumulator();
  const monthKey = today.slice(0, 7);
  let latestDate = "";

  Object.values(dailyResults || {}).forEach((entry) => {
    const date = String(entry?.date || "");
    if (!parseDateString(date)) {
      return;
    }
    if (!latestDate || date > latestDate) {
      latestDate = date;
    }
    const won = Boolean(entry?.won);
    const attempts = Number(entry?.attempts);
    winsByDate.set(date, Boolean(winsByDate.get(date)) || won);
    addSummaryEntry(overall, won, attempts);

    const age = diffDays(today, date);
    if (age !== null && age >= 0 && age <= 6) {
      addSummaryEntry(weekly, won, attempts);
    }
    if (date.slice(0, 7) === monthKey) {
      addSummaryEntry(monthly, won, attempts);
    }
  });

  return {
    overall: finalizeSummaryAccumulator(overall),
    weekly: finalizeSummaryAccumulator(weekly),
    monthly: finalizeSummaryAccumulator(monthly),
    streak: computeCurrentStreakFromMap(winsByDate, latestDate, today)
  };
}

function getSummaryForRange(performance, range) {
  if (range === LEADERBOARD_RANGE.weekly) return performance.weekly;
  if (range === LEADERBOARD_RANGE.monthly) return performance.monthly;
  return performance.overall;
}

function describeRange(range) {
  if (range === LEADERBOARD_RANGE.weekly) {
    return "Last 7 days (including today)";
  }
  if (range === LEADERBOARD_RANGE.monthly) {
    return "Current calendar month";
  }
  return "All recorded daily games";
}

function buildLeaderboardRows(state, range, today) {
  const rows = state.profiles
    .map((profile) => {
      const performance = buildProfilePerformance(state.resultsByProfile[profile.id], today);
      const summary = getSummaryForRange(performance, range);
      return {
        profileId: profile.id,
        name: profile.name,
        wins: summary.wins,
        played: summary.played,
        winRate: summary.winRate,
        bestAttempts: summary.bestAttempts,
        streak: performance.streak
      };
    })
    .filter((row) => row.played > 0)
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.played !== a.played) return b.played - a.played;
      if ((a.bestAttempts || 99) !== (b.bestAttempts || 99)) {
        return (a.bestAttempts || 99) - (b.bestAttempts || 99);
      }
      return a.name.localeCompare(b.name);
    });

  return rows.map((row, index) => ({
    rank: index + 1,
    ...row
  }));
}

function mergeDailyResult(existing, incoming, nowIso) {
  const retained = !existing
    || (!existing.won && incoming.won)
    || (existing.won && incoming.won && incoming.attempts < existing.attempts);
  const canonical = retained ? incoming : existing;

  return {
    retained,
    entry: {
      date: incoming.date,
      won: canonical.won,
      attempts: canonical.won ? canonical.attempts : null,
      maxGuesses: canonical.maxGuesses,
      submissionCount: (existing?.submissionCount || 0) + 1,
      updatedAt: nowIso
    }
  };
}

function parseDailyResultPayload(body) {
  const profileId = String(body.profileId || "").trim();
  if (!profileId) {
    throw new StatsApiError(400, "profileId is required.");
  }
  const dailyKey = String(body.dailyKey || "").trim();
  const parsedDailyKey = parseDailyKey(dailyKey);
  if (!parsedDailyKey) {
    throw new StatsApiError(400, "dailyKey must use format YYYY-MM-DD|<lang>|<code>.");
  }

  const won = body.won;
  if (typeof won !== "boolean") {
    throw new StatsApiError(400, "won must be true or false.");
  }

  const attempts = body.attempts;
  if (won) {
    assertPositiveInteger(attempts, "attempts");
  } else if (!(attempts === null || attempts === undefined)) {
    throw new StatsApiError(400, "attempts must be null when won is false.");
  }

  const maxGuesses = Number(body.maxGuesses);
  assertPositiveInteger(maxGuesses, "maxGuesses");

  return {
    profileId,
    dailyKey,
    entry: {
      date: parsedDailyKey.date,
      won,
      attempts: won ? attempts : null,
      maxGuesses
    }
  };
}

function statsServiceError(res, err) {
  if (err instanceof StatsApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("Stats service request failed.", err);
  return res.status(503).json({ error: STATS_UNAVAILABLE_ERROR });
}

function providerAdminError(res, err) {
  if (err instanceof StatsApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("Provider admin request failed.", err);
  return res.status(503).json({ error: PROVIDER_ADMIN_UNAVAILABLE_ERROR });
}

function mapRegistryErrorToStats(err) {
  if (!(err instanceof LanguageRegistryError)) {
    return err;
  }
  if (
    err.code === "INVALID_VARIANT" ||
    err.code === "INVALID_COMMIT" ||
    err.code === "INVALID_PROVIDER" ||
    err.code === "INVALID_DICTIONARY_FILE" ||
    err.code === "INVALID_LABEL" ||
    err.code === "INVALID_MIN_LENGTH" ||
    err.code === "INVALID_ENABLED" ||
    err.code === "INVALID_LANGUAGE" ||
    err.code === "INVALID_MUTATOR"
  ) {
    return new StatsApiError(400, err.message);
  }
  if (err.code === "LANGUAGE_NOT_FOUND") {
    return new StatsApiError(404, err.message);
  }
  if (err.code === "BAKED_LANGUAGE_IMMUTABLE") {
    return new StatsApiError(409, err.message);
  }
  if (err.code === "INVALID_REGISTRY_UPDATE") {
    return new StatsApiError(409, err.message);
  }
  return err;
}

function parseProviderVariant(value) {
  const variant = canonicalizeLanguageId(value);
  if (!SUPPORTED_PROVIDER_VARIANTS.has(variant)) {
    throw new StatsApiError(
      400,
      `variant must be one of ${Array.from(SUPPORTED_PROVIDER_VARIANTS).join(", ")}.`
    );
  }
  return variant;
}

function buildProviderStatusRows() {
  const rows = [];
  for (const variant of SUPPORTED_VARIANT_IDS) {
    const discoveredCommits = listProviderCommitDirectories(variant);
    const importedCommits = listImportableProviderCommits(variant);
    const incompleteCommits = discoveredCommits.filter((commit) => !importedCommits.includes(commit));
    const entry = registeredLanguageCatalog.get(variant) || null;
    const enabled = Boolean(entry?.enabled);
    const incompleteDetails = incompleteCommits.length
      ? `Incomplete artifacts found for commits: ${incompleteCommits.join(", ")}.`
      : null;
    let status = "not-imported";
    if (enabled) {
      status = "enabled";
    } else if (importedCommits.length > 0) {
      status = "imported";
    } else if (incompleteCommits.length > 0) {
      status = "error";
    }
    rows.push({
      variant,
      label: getProviderVariantLabel(variant),
      imported: importedCommits.length > 0,
      enabled,
      status,
      activeCommit: entry?.provider?.commit || null,
      importedCommits,
      incompleteCommits,
      warning:
        status === "enabled" || status === "imported"
          ? incompleteDetails
          : null,
      error: status === "error" ? incompleteDetails : null
    });
  }
  return rows;
}

function formatProviderJobError(err) {
  const mapped = mapProviderPipelineError(err);
  if (mapped instanceof StatsApiError) {
    return {
      code: `HTTP_${mapped.status}`,
      message: mapped.message
    };
  }
  return {
    code: String(err?.code || "IMPORT_FAILED").trim() || "IMPORT_FAILED",
    message: String(err?.message || PROVIDER_ADMIN_UNAVAILABLE_ERROR).trim()
      || PROVIDER_ADMIN_UNAVAILABLE_ERROR
  };
}

async function runProviderImportPipeline(request) {
  const variant = parseProviderVariant(request?.variant);
  const sourceType = parseProviderImportSource(request?.sourceType);
  const filterMode = parseProviderFilterMode(request?.filterMode);
  const expectedChecksums = normalizeExpectedChecksums(request?.expectedChecksums);

  let sourceResult;
  if (sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD) {
    let manualFiles = request?.manualFiles || null;
    if (!manualFiles) {
      if (request?.manualUpload) {
        manualFiles = await loadManualUploadFromStaging(request);
      } else {
        throw new StatsApiError(400, "manualFiles payload is required for manual-upload imports.");
      }
    }
    sourceResult = await persistManualProviderSource({
      variant,
      commit: request?.commit || null,
      expectedChecksums,
      manualFiles,
      maxManualFileBytes: getProviderManualMaxFileBytes(),
      outputRoot: PROVIDERS_ROOT
    });
  } else {
    const commit = String(request?.commit || "").trim();
    if (!PROVIDER_COMMIT_PATTERN.test(commit)) {
      throw new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.");
    }
    sourceResult = await fetchAndPersistProviderSource({
      variant,
      commit,
      expectedChecksums,
      outputRoot: PROVIDERS_ROOT
    });
  }

  const commit = sourceResult.descriptor.commit;
  const expandedResult = await buildExpandedFormsArtifacts({
    variant,
    commit,
    providerRoot: PROVIDERS_ROOT,
    outputRoot: PROVIDERS_ROOT,
    policyVersion: PROVIDER_POLICY_VERSION
  });
  const poolsResult = await buildProviderPoolsArtifacts({
    variant,
    commit,
    providerRoot: PROVIDERS_ROOT,
    outputRoot: PROVIDERS_ROOT,
    policyVersion: PROVIDER_POLICY_VERSION
  });
  const filteredResult = await buildFilteredAnswerPoolArtifacts({
    variant,
    commit,
    providerRoot: PROVIDERS_ROOT,
    outputRoot: PROVIDERS_ROOT,
    filterMode
  });
  const paths = buildProviderArtifactPaths(variant, commit);

  return {
    ok: true,
    action: "imported",
    variant,
    commit,
    sourceType,
    filterMode,
    counts: {
      sourceFiles: {
        dicBytes: sourceResult.sourceFiles.dic.byteSize,
        affBytes: sourceResult.sourceFiles.aff.byteSize
      },
      expandedForms: expandedResult.counts.expandedForms,
      guessPool: poolsResult.counts.expandedForms,
      answerPool: poolsResult.counts.answerPool,
      filteredAnswers: filteredResult.counts.activatedAnswers
    },
    artifacts: {
      commit,
      sourceManifestPath: paths.sourceManifest,
      expandedFormsPath: buildProviderRelativePath(variant, commit, "expanded-forms.txt"),
      guessPoolPath: paths.guessPool,
      answerPoolPath: buildProviderRelativePath(variant, commit, "answer-pool-active.txt")
    }
  };
}

function toAdminJobResponse(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    request: {
      variant: job.request?.variant || null,
      sourceType: job.request?.sourceType || null,
      filterMode: job.request?.filterMode || null,
      commit: job.request?.commit || null
    },
    artifacts: job.artifacts || null,
    error: job.error || null
  };
}

async function startProviderImportQueueIfNeeded() {
  // Bidirectional mutex with the restore router: don't start dequeueing
  // jobs while a restore is in flight. The restore now claims
  // restoreInProgressRef synchronously (before the upload completes),
  // and dataMutationLockRef later (right before the swap). Both must
  // be checked here — checking only dataMutationLockRef would let an
  // import start during the upload window and race the swap.
  if (
    providerImportQueueActiveRef.value
    || providerImportSyncActiveRef.value
    || providerImportEnqueueActiveRef.value
    || dataMutationLockRef.value
    || restoreInProgressRef.value
  ) {
    return;
  }
  providerImportQueueActiveRef.value = true;

  try {
    while (true) {
      const job = await adminJobsStore.claimNextQueuedJob();
      if (!job) {
        break;
      }

      try {
        const result = await runProviderImportPipeline(job.request);
        await adminJobsStore.markSucceeded(job.id, {
          artifacts: result.artifacts
        });
      } catch (err) {
        const failure = formatProviderJobError(err);
        await adminJobsStore.markFailed(job.id, failure);
      } finally {
        await cleanupManualUploadStaging(job.request?.manualUpload).catch(() => {});
      }
    }
  } finally {
    providerImportQueueActiveRef.value = false;
  }
}

function buildImportQueueSummary(snapshot) {
  const totals = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0
  };
  snapshot.jobs.forEach((job) => {
    if (totals[job.status] !== undefined) {
      totals[job.status] += 1;
    }
  });
  return {
    active: providerImportQueueActiveRef.value,
    ...totals
  };
}

function getEditableProviderManualMaxFileBytes() {
  const jsonBodyLimitBytes = parseByteSizeLiteral(JSON_BODY_LIMIT);
  if (!jsonBodyLimitBytes) {
    return PROVIDER_MANUAL_MAX_FILE_BYTES_MAX;
  }
  const usablePayloadBytes = Math.max(jsonBodyLimitBytes - JSON_BODY_LIMIT_OVERHEAD_BYTES, 0);
  const maxManualUploadBytes = Math.floor((usablePayloadBytes * 3) / 4);
  return Math.max(
    PROVIDER_MANUAL_MAX_FILE_BYTES_MIN,
    Math.min(PROVIDER_MANUAL_MAX_FILE_BYTES_MAX, maxManualUploadBytes)
  );
}

function buildRuntimeConfigResponse() {
  const editableProviderManualMaxFileBytes = getEditableProviderManualMaxFileBytes();
  const snapshot = getRuntimeConfigSnapshot();
  return {
    ok: true,
    effective: {
      definitions: snapshot.effective.definitions,
      limits: snapshot.effective.limits,
      diagnostics: snapshot.effective.diagnostics,
      security: {
        trustProxy: TRUST_PROXY,
        trustProxyHops: TRUST_PROXY_HOPS,
        requireAdminKey: REQUIRE_ADMIN_KEY
      },
      server: {
        jsonBodyLimit: JSON_BODY_LIMIT,
        rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
        rateLimitMax: RATE_LIMIT_MAX,
        adminRateLimitWindowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
        adminRateLimitMax: ADMIN_RATE_LIMIT_MAX,
        adminWriteRateLimitWindowMs: ADMIN_WRITE_RATE_LIMIT_WINDOW_MS,
        adminWriteRateLimitMax: ADMIN_WRITE_RATE_LIMIT_MAX
      }
    },
    overrides: snapshot.overrides,
    sources: snapshot.sources,
    locks: snapshot.locks,
    editable: {
      definitions: {
        modeOptions: ["memory", "lazy", "indexed"],
        cacheSize: { min: 1, max: 4096 },
        cacheTtlMs: { min: 1000, max: 86400000 },
        shardCacheSize: { min: 1, max: 26 }
      },
      limits: {
        providerManualMaxFileBytes: {
          min: PROVIDER_MANUAL_MAX_FILE_BYTES_MIN,
          max: editableProviderManualMaxFileBytes
        },
        leaderboardMaxProfiles: {
          min: LEADERBOARD_MAX_PROFILES_MIN,
          max: LEADERBOARD_MAX_PROFILES_MAX
        },
        leaderboardMaxResultsPerProfile: {
          min: LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN,
          max: LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX
        }
      },
      diagnostics: {
        perfLogging: true
      }
    }
  };
}

app.disable("x-powered-by");
if (TRUST_PROXY) {
  app.set("trust proxy", TRUST_PROXY_HOPS);
}
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https:", "'unsafe-inline'"]
    }
  }
}));
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Try again later." }
  })
);
app.use(compression());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((err, req, res, next) => {
  if (!err) {
    return next();
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request payload is too large." });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  return next(err);
});
const requireAdminAccess = requireAdmin({
  adminKey: ADMIN_KEY,
  requireAdminKey: REQUIRE_ADMIN_KEY
});
const adminRateLimiter = rateLimit({
  windowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
  max: ADMIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Try again later." }
});
const adminWriteRateLimiter = rateLimit({
  windowMs: ADMIN_WRITE_RATE_LIMIT_WINDOW_MS,
  max: ADMIN_WRITE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin write requests. Try again later." }
});
function limitAdminWrites(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  adminWriteRateLimiter(req, res, next);
}

// Data-mutation lock: while a backup export or a restore apply is in
// flight, refuse mutating requests to any /api/** endpoint that touches
// data/. Without this gate, a player /api/stats/result POST or an admin
// /api/word POST mid-restore could persist stale cached state over the
// just-restored files, and a write between hash-time and archive-time
// during export would tear the archive. The window is short (seconds)
// and admin-initiated. The backup endpoints themselves are exempt
// because they are the operations holding the lock.
// Paths that should NOT be 503'd while the data lock is held. Two
// categories:
//   1. The backup/restore endpoints themselves (they own the lock).
//   2. Stateless gameplay POSTs that compute responses without
//      writing to data/. Without these exemptions, players see
//      failed guesses during long provider-inclusive exports — even
//      though the gameplay calls don't touch the files restore is
//      swapping. /api/stats/result IS NOT exempt: it persists the
//      day's result via leaderboardStore.mutate which honors the
//      mutate barrier already.
const DATA_LOCK_EXEMPT_PATHS = [
  "/api/admin/backup",
  "/api/admin/restore",
  "/api/encode",
  "/api/random",
  "/api/puzzle",
  "/api/guess"
];
function isDataLockExemptPath(reqUrl) {
  if (typeof reqUrl !== "string") return false;
  // Strip query string if present.
  const queryIdx = reqUrl.indexOf("?");
  const pathname = queryIdx === -1 ? reqUrl : reqUrl.slice(0, queryIdx);
  return DATA_LOCK_EXEMPT_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
function gateDataMutationsDuringDataLock(req, res, next) {
  const isMutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (!isMutating) {
    next();
    return;
  }
  if (!dataMutationLockRef.value) {
    next();
    return;
  }
  // Use originalUrl so the exempt-prefix match works regardless of how
  // the middleware is mounted (req.path is relative to the mount).
  if (isDataLockExemptPath(req.originalUrl)) {
    next();
    return;
  }
  res.set("Retry-After", "5");
  res.status(503).json({
    error: "A backup/restore operation is in progress; data mutations are temporarily blocked.",
    code: "DATA_LOCK_HELD"
  });
}
app.use("/api", gateDataMutationsDuringDataLock);
app.use("/api/admin", adminRateLimiter, requireAdminAccess, limitAdminWrites);

function resolveAdminShellAssets() {
  const requiredFiles = ["index.html", "app.js", "admin.css"];
  const candidates = [path.join(PUBLIC_PATH, "admin"), path.join(PUBLIC_ROOT, "admin")];
  for (const candidateRoot of candidates) {
    const hasAllFiles = requiredFiles.every((fileName) =>
      fs.existsSync(path.join(candidateRoot, fileName))
    );
    if (hasAllFiles) {
      return {
        root: candidateRoot,
        indexPath: path.join(candidateRoot, "index.html")
      };
    }
  }

  return {
    root: candidates[0],
    indexPath: path.join(candidates[0], "index.html")
  };
}

const ADMIN_SHELL = resolveAdminShellAssets();
if (!fs.existsSync(ADMIN_SHELL.indexPath)) {
  console.warn("Admin shell assets are missing. Build assets before serving /admin.");
}

// Mount admin router first so GET /admin route takes precedence over static serving
const { ipKeyGenerator: rateLimitIpKeyGenerator } = require("express-rate-limit");
const backupRateLimiter = rateLimit({
  windowMs: ENV_BACKUP_RATE_LIMIT_WINDOW_MS,
  max: ENV_BACKUP_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Throttle per admin key (when present) so two operators on the same IP
  // don't share a single bucket. The admin key itself is never used as the
  // bucket id directly — we hash it first so the secret can't leak into
  // rate-limit store dumps, logs, or metrics. Falls back to
  // express-rate-limit's IPv6-aware ipKeyGenerator when no admin key is
  // set.
  keyGenerator: (req) => {
    const key = req.headers["x-admin-key"];
    if (typeof key === "string" && key.length > 0) {
      const digest = nodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
      return `admin:${digest}`;
    }
    // ipKeyGenerator expects an IP string, not the request object. Pass
    // req.ip and let the helper apply IPv6 subnet masking.
    return rateLimitIpKeyGenerator(req.ip);
  },
  message: { error: "Too many backup or restore requests. Try again later." }
});
const createBackupRouter = require("./routes/backup.js");
const BACKUP_PROJECT_ROOT = process.env.BACKUP_PROJECT_ROOT
  ? path.resolve(process.env.BACKUP_PROJECT_ROOT)
  : __dirname;
app.use(
  createBackupRouter({
    projectRoot: BACKUP_PROJECT_ROOT,
    leaderboardStore,
    languageRegistryStore,
    adminJobsStore,
    appConfigStore,
    classesStore,
    rebuildLanguageRuntimeCatalog,
    reloadWordData: () => {
      // Re-read data/word.json from disk and refresh the in-memory cache
      // backing /api/word and /daily. ensureWordData() falls back to the
      // baked default if the file is missing or invalid.
      const data = readWordData();
      if (data) {
        wordDataCache = data;
      } else {
        ensureWordData();
      }
    },
    providerImportQueueActiveRef,
    providerImportSyncActiveRef,
    providerImportEnqueueActiveRef,
    dataMutationLockRef,
    restoreInProgressRef,
    directDataWriteActiveRef,
    backupMaxBytes: ENV_BACKUP_MAX_BYTES,
    backupIncludeProvidersDefault: ENV_BACKUP_INCLUDE_PROVIDERS_DEFAULT,
    backupRateLimiter
  })
);

const createAdminRouter = require("./routes/admin.js");
app.use(
  createAdminRouter({
    ADMIN_SHELL,
    buildProviderStatusRows,
    parseProviderVariant,
    parseProviderImportSource,
    parseProviderFilterMode,
    providerAdminError,
    statsServiceError,
    mapRegistryErrorToStats,
    mapProviderPipelineError,
    mapProviderUpdateCheckErrorToMessage,
    resolveCurrentProviderCommitForUpdateCheck,
    resolvePreferredProviderCommit,
    normalizeProfileNameInput,
    checkProviderUpdate,
    buildProviderArtifactPaths,
    getProviderVariantLabel,
    loadDictionary,
    rebuildLanguageRuntimeCatalog,
    leaderboardStore,
    languageRegistryStore,
    adminJobsStore,
    classesStore,
    appConfigStore,
    buildRuntimeConfigResponse,
    applyRuntimeConfig,
    buildImportQueueSummary,
    toAdminJobResponse,
    parseImportAsyncFlag,
    parsePositiveInteger,
    normalizeExpectedChecksums,
    runProviderImportPipeline,
    startProviderImportQueueIfNeeded,
    formatProviderJobError,
    persistManualUploadStaging,
    cleanupManualUploadStaging,
    getProviderManualMaxFileBytes,
    providerImportQueueActiveRef,
    providerImportSyncActiveRef,
    providerImportEnqueueActiveRef,
    dataMutationLockRef,
    restoreInProgressRef,
    claimDirectDataWriteSlot,
    getEditableProviderManualMaxFileBytes,
    PROVIDER_MANUAL_MAX_FILE_BYTES_MIN,
    PROVIDER_COMMIT_PATTERN,
    PROVIDER_IMPORT_SOURCE_TYPES,
    PROVIDER_MIN_LENGTH,
    PROVIDER_ID,
    PROVIDER_REPOSITORY,
    LEADERBOARD_MAX_PROFILES_MIN,
    LEADERBOARD_MAX_PROFILES_MAX,
    LEADERBOARD_MAX_RESULTS_PER_PROFILE_MIN,
    LEADERBOARD_MAX_RESULTS_PER_PROFILE_MAX,
    isLeaderboardMaxProfilesEnvLocked: () => ENV_CONFIG_LOCKS.limits.leaderboardMaxProfiles,
    isLeaderboardMaxResultsPerProfileEnvLocked: () =>
      ENV_CONFIG_LOCKS.limits.leaderboardMaxResultsPerProfile,
    LeaderboardStoreError,
    ClassesStoreError,
    StatsApiError,
    ProviderUpdateCheckError,
    AppConfigStoreError,
    buildCsv,
    parseBulkNames,
    UTF8_BOM,
    normalizeLang,
    getLocalDateString,
    aggregateAnalytics,
    analyticsCacheTtlMs: ENV_ANALYTICS_CACHE_TTL_MS,
    analyticsTimezone: ENV_ANALYTICS_TIMEZONE,
    scheduleStore,
    runSchedulerReconcile,
    ScheduleStoreError: require("./lib/schedule-store").ScheduleStoreError
  })
);

const STATIC_MAX_AGE = NODE_ENV === "production" ? 60 * 60 * 1000 : 0;
app.use(
  "/admin",
  express.static(ADMIN_SHELL.root, {
    etag: true,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store");
    }
  })
);
app.use("/manifest.json", (req, res, next) => {
  res.setHeader("Content-Type", "application/manifest+json");
  next();
});
// Mount the vendored bundles directly so /dist/vendor/... resolves the same
// way regardless of whether PUBLIC_PATH points at public/ (dev) or
// public/dist/ (post-build). Without this, dist-mode would resolve the URL
// to public/dist/dist/vendor/... and 404 the admin shell's chart.umd.min.js.
app.use(
  "/dist/vendor",
  express.static(path.join(PUBLIC_ROOT, "dist", "vendor"), {
    etag: true,
    maxAge: STATIC_MAX_AGE
  })
);
app.use(
  express.static(PUBLIC_PATH, {
    etag: true,
    maxAge: STATIC_MAX_AGE,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
        return;
      }
      if (NODE_ENV === "production") {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    }
  })
);

ensureWordData();
adminJobsStore
  .recoverRunningJobs()
  .then((hadRecoveredJobs) => {
    if (hadRecoveredJobs) {
      console.warn("Recovered in-flight provider import jobs to queued state after restart.");
    }
    return startProviderImportQueueIfNeeded();
  })
  .catch((err) => {
    console.error("Failed to initialize provider import queue.", err);
  });

// ============================================================================
// ROUTE MOUNTING
// ============================================================================

// Mount meta routes (health check and application metadata)
const createMetaRouter = require("./routes/meta.js");
app.use(
  createMetaRouter({
    getAvailableLanguages: () => availableLanguages,
    isLanguageAvailable,
    MIN_LEN,
    MAX_LEN,
    MIN_GUESSES,
    MAX_GUESSES,
    DEFAULT_GUESSES,
    DEFAULT_LANG,
    isPerfLoggingEnabled,
    getDefinitionsMode
  })
);

const createGameRouter = require("./routes/game.js");
app.use(
  createGameRouter({
    normalizeWord,
    resolveLang,
    assertWord,
    getMinLengthForLang,
    getAnswerDictionary,
    getDictionary,
    dictionaryHasWord,
    dictionaryRandomWord,
    encodeWord,
    decodeWord,
    evaluateGuess,
    lookupAnswerMeaning,
    getLanguageLabel,
    DEFAULT_GUESSES,
    MIN_GUESSES,
    MAX_GUESSES,
    MAX_LEN
  })
);

const createStatsRouter = require("./routes/stats.js");
app.use(
  createStatsRouter({
    leaderboardStore,
    classesStore,
    normalizeProfileNameInput,
    parseDailyResultPayload,
    parseLeaderboardRange,
    getLocalDateString,
    buildLeaderboardRows,
    buildProfilePerformance,
    statsServiceError,
    mapRegistryErrorToStats,
    mergeDailyResult,
    describeRange,
    StatsApiError
  })
);

// ============================================================================
// DICTIONARY ROUTES - To be extracted to routes/dictionary.js
// Endpoints: GET /api/word, POST /api/word
// Middleware: requireAdminAccess (applied to both routes)
// Dependencies: wordDataCache, buildDefaultWordData, normalizeWord, resolveLang,
//               assertWord, getMinLengthForLang, saveWordDataAtomic
// ============================================================================

app.get("/api/word", requireAdminAccess, (req, res) => {
  res.json(wordDataCache || buildDefaultWordData());
});

app.post("/api/word", requireAdminAccess, async (req, res) => {
  // Claim the direct-write slot BEFORE validating. resolveLang() reads
  // the live language registry, which a concurrent restore can swap
  // out from under us. If we validated first and waited second, an
  // archive that drops support for the requested lang would still let
  // this request 200 — and persist a now-unsupported word over the
  // freshly-restored data/word.json. Claiming first guarantees the
  // restore (if any) has fully landed before we resolve lang/word.
  const releaseSlot = await claimDirectDataWriteSlot();
  try {
    const word = normalizeWord(req.body.word);
    const date = req.body.date ? String(req.body.date) : null;
    const lang = resolveLang(req.body.lang);
    if (!lang) {
      return res.status(400).json({ error: "Unknown language." });
    }

    try {
      assertWord(word, getMinLengthForLang(lang));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const data = {
      word,
      lang,
      date: date || null,
      updatedAt: new Date().toISOString()
    };

    try {
      await saveWordDataAtomic(data);
    } catch (err) {
      console.error("Failed to persist daily word data.", err);
      return res.status(500).json({ error: "Could not save daily word right now." });
    }
    wordDataCache = data;
    res.json({ ok: true, data });
  } finally {
    releaseSlot();
  }
});

// ============================================================================
// DAILY ROUTE - To be extracted to routes/daily.js
// Endpoint: GET /daily
// Dependencies: wordDataCache, normalizeWord, getLocalDateString, renderDailyPage,
//               renderDailyMissing
// ============================================================================

app.get("/daily", (req, res) => {
  const data = wordDataCache;
  if (!data || !data.word) {
    return res.status(404).send(renderDailyMissing("No daily puzzle yet."));
  }

  const word = normalizeWord(data.word);
  if (!word || !/^[A-Z]+$/.test(word)) {
    return res.status(404).send(renderDailyMissing("No daily puzzle yet."));
  }

  if (data.date) {
    const today = getLocalDateString(new Date());
    if (data.date !== today) {
      return res
        .status(404)
        .send(renderDailyMissing("Today's puzzle isn't set yet."));
    }
  }

  const code = encodeWord(word).toLowerCase();
  const lang = resolveLang(data.lang) || DEFAULT_LANG;
  const dailyDate = getLocalDateString(new Date());
  let target = `/?word=${code}`;
  if (lang !== "en") {
    target += `&lang=${lang}`;
  }
  target += "&daily=1";
  target += `&day=${dailyDate}`;
  res.redirect(target);
});

function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderDailyMissing(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily Word</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="layout">
      <section class="panel">
        <h2>Daily Word</h2>
        <p class="note">${message}</p>
        <a class="admin-link" href="/">Make a new puzzle</a>
      </section>
    </main>
  </body>
</html>`;
}

function startServer(listener = app.listen.bind(app)) {
  // Run a single boot reconcile BEFORE the listener accepts traffic so the
  // first GET /api/word and /daily see the scheduler's pick (or the
  // operator's manual override, if newer). Failures are logged inside
  // runSchedulerReconcile and don't block boot — the schedule is meant to
  // be a soft layer over manual word.json writes, not a hard dependency.
  runSchedulerReconcile("boot")
    .catch((err) => console.error("[scheduler] boot reconcile error:", err))
    .finally(() => startSchedulerInterval());
  return listener(PORT, HOST, () => {
    console.log(`local-hosted-wordle server running at http://localhost:${PORT}`);
    console.log(`Definitions mode: ${getDefinitionsMode()}`);
    if (isPerfLoggingEnabled()) {
      console.log(
        `Perf logging enabled (definition cache size=${getDefinitionCacheSize()}, ttlMs=${getDefinitionCacheTtlMs()})`
      );
    }
    if (!ADMIN_KEY && !REQUIRE_ADMIN_KEY) {
      console.log("Admin mode is open. Set ADMIN_KEY to protect /admin updates.");
    }
    if (!ADMIN_KEY && REQUIRE_ADMIN_KEY) {
      console.warn("ADMIN_KEY is required for admin endpoints in production.");
    }
    if (!TRUST_PROXY && NODE_ENV === "production") {
      console.warn(
        "TRUST_PROXY is disabled. If deployed behind a reverse proxy, load balancer, or Tailscale, set TRUST_PROXY=true (and configure TRUST_PROXY_HOPS as needed)."
      );
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
// Exposed for tests so they can run a deterministic reconcile and stop the
// interval timer cleanly during teardown.
module.exports.runSchedulerReconcile = runSchedulerReconcile;
module.exports.stopSchedulerInterval = stopSchedulerInterval;
module.exports.scheduleStore = scheduleStore;
