const express = require("express");
const { randomUUID } = require("node:crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { LeaderboardStore, parseDailyKey, PROFILE_NAME_PATTERN } = require("./lib/leaderboard-store");
const { requireAdmin } = require("./lib/admin-auth");
const { LanguageRegistryError, LanguageRegistryStore } = require("./lib/language-registry");
const { SUPPORTED_VARIANT_IDS } = require("./lib/provider-artifact-shared");
const { fetchAndPersistProviderSource } = require("./lib/provider-fetch");
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
const PERF_LOGGING = process.env.PERF_LOGGING === "true";
const LEGACY_LOW_MEMORY_DEFINITIONS = process.env.LOW_MEMORY_DEFINITIONS === "true";
const DEFINITIONS_MODE = resolveDefinitionsMode();
const DEFINITION_CACHE_SIZE = parsePositiveInteger(process.env.DEFINITION_CACHE_SIZE, 512);
const DEFINITION_CACHE_TTL_MS = parseNonNegativeInteger(
  process.env.DEFINITION_CACHE_TTL_MS,
  30 * 60 * 1000
);
const DEFINITION_SHARD_CACHE_SIZE = parsePositiveInteger(
  process.env.DEFINITION_SHARD_CACHE_SIZE,
  6
);

const DATA_PATH = path.join(__dirname, "data", "word.json");
const DATA_ROOT = path.join(__dirname, "data");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PUBLIC_DIST = path.join(PUBLIC_ROOT, "dist");
const PUBLIC_PATH = fs.existsSync(PUBLIC_DIST) ? PUBLIC_DIST : PUBLIC_ROOT;
const DICT_PATH = path.join(DATA_ROOT, "dictionaries");
const PROVIDERS_ROOT = path.join(DATA_ROOT, "providers");
const EN_DEFINITIONS_PATH = path.join(DICT_PATH, "en-definitions.json");
const EN_DEFINITIONS_INDEX_DIR = path.join(DICT_PATH, "en-definitions-index");
const EN_DEFINITIONS_INDEX_MANIFEST_PATH = path.join(EN_DEFINITIONS_INDEX_DIR, "manifest.json");
const LEADERBOARD_DATA_PATH = process.env.STATS_STORE_PATH
  ? path.resolve(process.env.STATS_STORE_PATH)
  : path.join(__dirname, "data", "leaderboard.json");
const LANGUAGE_REGISTRY_PATH = path.join(__dirname, "data", "languages.json");

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
const PROVIDER_MANUAL_MAX_FILE_BYTES = parsePositiveInteger(
  process.env.PROVIDER_MANUAL_MAX_FILE_BYTES,
  8 * 1024 * 1024
);
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
const leaderboardStore = new LeaderboardStore({ filePath: LEADERBOARD_DATA_PATH });

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

function createPerfTimer(label) {
  if (!PERF_LOGGING) return null;
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
  const expiresAt =
    DEFINITION_CACHE_TTL_MS > 0 ? Date.now() + DEFINITION_CACHE_TTL_MS : null;
  if (definitionCache.has(word)) {
    definitionCache.delete(word);
  }
  definitionCache.set(word, { value, expiresAt });
  if (definitionCache.size > DEFINITION_CACHE_SIZE) {
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
  if (definitionShardCache.size > DEFINITION_SHARD_CACHE_SIZE) {
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
  let source = DEFINITIONS_MODE;

  if (DEFINITIONS_MODE === "memory" || DEFINITIONS_MODE === "lazy") {
    value = getOrLoadFullDefinitionsMap().get(word) || null;
  } else if (DEFINITIONS_MODE === "indexed") {
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
let registeredLanguageCatalog = new Map();
let availableLanguages = new Map();
let providerImportInFlight = null;

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
      const paths = buildProviderArtifactPaths(variant, commit);
      const hasGuessPool = fs.existsSync(path.join(DATA_ROOT, paths.guessPool));
      const hasAnswerPool = fs.existsSync(path.join(DATA_ROOT, paths.answerPoolActive))
        || fs.existsSync(path.join(DATA_ROOT, paths.answerPoolFallback));
      const hasManifest = fs.existsSync(path.join(DATA_ROOT, paths.sourceManifest));
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

rebuildLanguageRuntimeCatalog();

if (DEFINITIONS_MODE === "memory") {
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
  let canonical;
  if (!existing) {
    canonical = incoming;
  } else if (!existing.won && incoming.won) {
    canonical = incoming;
  } else if (existing.won && incoming.won && incoming.attempts < existing.attempts) {
    canonical = incoming;
  } else {
    canonical = existing;
  }

  return {
    date: incoming.date,
    won: canonical.won,
    attempts: canonical.won ? canonical.attempts : null,
    maxGuesses: canonical.maxGuesses,
    submissionCount: (existing?.submissionCount || 0) + 1,
    updatedAt: nowIso
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

app.disable("x-powered-by");
if (TRUST_PROXY) {
  app.set("trust proxy", TRUST_PROXY_HOPS);
}
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
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

app.get("/admin", (req, res) => {
  // Keep admin entry HTML uncached so key-gated shell changes apply immediately.
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(ADMIN_SHELL.indexPath);
});

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

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/meta", (req, res) => {
  const languages = Array.from(availableLanguages.values());
  const defaultLang = isLanguageAvailable(DEFAULT_LANG)
    ? DEFAULT_LANG
    : languages[0]?.id || DEFAULT_LANG;

  res.json({
    minLength: MIN_LEN,
    maxLength: MAX_LEN,
    minGuesses: MIN_GUESSES,
    maxGuesses: MAX_GUESSES,
    defaultGuesses: DEFAULT_GUESSES,
    languages,
    defaultLang,
    perfLogging: PERF_LOGGING,
    definitionsMode: DEFINITIONS_MODE
  });
});

app.post("/api/stats/profile", async (req, res) => {
  let profileName;
  try {
    profileName = normalizeProfileNameInput(req.body?.name);
  } catch (err) {
    return statsServiceError(res, err);
  }

  try {
    let createdProfileId = "";
    let reused = false;

    const snapshot = await leaderboardStore.mutate((draft) => {
      const existing = draft.profiles.find(
        (profile) => profile.name.toLowerCase() === profileName.toLowerCase()
      );
      if (existing) {
        createdProfileId = existing.id;
        reused = true;
        return;
      }

      const nowIso = new Date().toISOString();
      const createdProfile = {
        id: randomUUID(),
        name: profileName,
        createdAt: nowIso,
        updatedAt: nowIso
      };
      draft.profiles.push(createdProfile);
      createdProfileId = createdProfile.id;
    });
    const responseProfile = snapshot.profiles.find((profile) => profile.id === createdProfileId);
    if (!responseProfile) {
      throw new Error("Failed to persist player profile.");
    }

    return res.json({
      ok: true,
      reused,
      playerId: responseProfile.id,
      profile: responseProfile
    });
  } catch (err) {
    return statsServiceError(res, mapRegistryErrorToStats(err));
  }
});

app.post("/api/stats/result", async (req, res) => {
  let payload;
  try {
    payload = parseDailyResultPayload(req.body || {});
  } catch (err) {
    return statsServiceError(res, err);
  }

  try {
    const snapshot = await leaderboardStore.mutate((draft) => {
      const profile = draft.profiles.find((item) => item.id === payload.profileId);
      if (!profile) {
        throw new StatsApiError(404, "Player profile not found.");
      }

      const rawEntries = draft.resultsByProfile[payload.profileId];
      const currentEntries = new Map(
        Object.entries(rawEntries && typeof rawEntries === "object" ? rawEntries : {})
      );
      const nowIso = new Date().toISOString();
      const existing = currentEntries.get(payload.dailyKey) || null;
      const merged = mergeDailyResult(existing, payload.entry, nowIso);
      currentEntries.set(payload.dailyKey, merged);
      draft.resultsByProfile[payload.profileId] = Object.fromEntries(currentEntries);
      profile.updatedAt = nowIso;
    });
    const persistedEntry = snapshot.resultsByProfile[payload.profileId]?.[payload.dailyKey] || null;

    return res.json({
      ok: true,
      profileId: payload.profileId,
      dailyKey: payload.dailyKey,
      retained: Boolean(persistedEntry),
      result: persistedEntry
    });
  } catch (err) {
    return statsServiceError(res, mapRegistryErrorToStats(err));
  }
});

app.get("/api/stats/leaderboard", async (req, res) => {
  let range;
  try {
    range = parseLeaderboardRange(req.query.range);
  } catch (err) {
    return statsServiceError(res, err);
  }

  try {
    const snapshot = await leaderboardStore.getSnapshot();
    const today = getLocalDateString(new Date());
    const rows = buildLeaderboardRows(snapshot, range, today);
    return res.json({
      ok: true,
      range,
      description: describeRange(range),
      dayKey: today,
      rowCount: rows.length,
      rows
    });
  } catch (err) {
    return statsServiceError(res, mapRegistryErrorToStats(err));
  }
});

app.get("/api/stats/profile/:id", async (req, res) => {
  const profileId = String(req.params.id || "").trim();
  if (!profileId) {
    return res.status(400).json({ error: "Profile ID is required." });
  }

  try {
    const snapshot = await leaderboardStore.getSnapshot();
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    if (!profile) {
      return res.status(404).json({ error: "Player profile not found." });
    }

    const today = getLocalDateString(new Date());
    const performance = buildProfilePerformance(snapshot.resultsByProfile[profileId], today);
    const totalSubmissions = Object.values(snapshot.resultsByProfile[profileId] || {}).reduce(
      (sum, entry) => sum + Number(entry?.submissionCount || 0),
      0
    );

    return res.json({
      ok: true,
      profile,
      summary: {
        streak: performance.streak,
        overall: performance.overall,
        weekly: performance.weekly,
        monthly: performance.monthly,
        totalSubmissions
      }
    });
  } catch (err) {
    return statsServiceError(res, mapRegistryErrorToStats(err));
  }
});

app.patch("/api/admin/stats/profile/:id", async (req, res) => {
  const profileId = String(req.params.id || "").trim();
  if (!profileId) {
    return res.status(400).json({ error: "Profile ID is required." });
  }

  let nextName;
  try {
    nextName = normalizeProfileNameInput(req.body?.name);
  } catch (err) {
    return statsServiceError(res, err);
  }

  try {
    const snapshot = await leaderboardStore.mutate((draft) => {
      const profile = draft.profiles.find((item) => item.id === profileId);
      if (!profile) {
        throw new StatsApiError(404, "Player profile not found.");
      }
      const duplicate = draft.profiles.find(
        (item) => item.id !== profileId && item.name.toLowerCase() === nextName.toLowerCase()
      );
      if (duplicate) {
        throw new StatsApiError(409, "Another player already uses that name.");
      }
      const nowIso = new Date().toISOString();
      profile.name = nextName;
      profile.updatedAt = nowIso;
    });
    const persistedProfile = snapshot.profiles.find((item) => item.id === profileId) || null;
    if (!persistedProfile) {
      throw new Error("Failed to persist player profile rename.");
    }

    return res.json({ ok: true, profile: persistedProfile });
  } catch (err) {
    return statsServiceError(res, mapRegistryErrorToStats(err));
  }
});

app.get("/api/admin/providers", (req, res) => {
  return res.json({
    ok: true,
    providers: buildProviderStatusRows()
  });
});

app.post("/api/admin/providers/import", async (req, res) => {
  let variant;
  try {
    variant = parseProviderVariant(req.body?.variant);
  } catch (err) {
    return providerAdminError(res, err);
  }

  let sourceType;
  try {
    sourceType = parseProviderImportSource(req.body?.sourceType);
  } catch (err) {
    return providerAdminError(res, err);
  }

  const commitInput = String(req.body?.commit || "").trim();
  if (sourceType === PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH && !PROVIDER_COMMIT_PATTERN.test(commitInput)) {
    return providerAdminError(
      res,
      new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA.")
    );
  }
  if (
    sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
    && commitInput
    && !PROVIDER_COMMIT_PATTERN.test(commitInput)
  ) {
    return providerAdminError(
      res,
      new StatsApiError(400, "commit must be a 40-character lowercase hexadecimal git SHA when provided.")
    );
  }

  const checksums = req.body?.expectedChecksums;
  const expectedChecksums = {
    dic: String(checksums?.dic || "").trim().toLowerCase(),
    aff: String(checksums?.aff || "").trim().toLowerCase()
  };

  let filterMode;
  try {
    filterMode = parseProviderFilterMode(req.body?.filterMode);
  } catch (err) {
    return providerAdminError(res, err);
  }

  if (providerImportInFlight) {
    return providerAdminError(
      res,
      new StatsApiError(
        409,
        `Another import is already running (${providerImportInFlight.variant} @ ${providerImportInFlight.commit}).`
      )
    );
  }

  const inFlightToken = {
    variant,
    commit: commitInput || "auto",
    startedAt: new Date().toISOString()
  };
  providerImportInFlight = inFlightToken;

  try {
    const sourceResult = sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
      ? await persistManualProviderSource({
        variant,
        commit: commitInput || null,
        expectedChecksums,
        manualFiles: req.body?.manualFiles,
        maxManualFileBytes: PROVIDER_MANUAL_MAX_FILE_BYTES,
        outputRoot: PROVIDERS_ROOT
      })
      : await fetchAndPersistProviderSource({
        variant,
        commit: commitInput,
        expectedChecksums,
        outputRoot: PROVIDERS_ROOT
      });
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

    return res.json({
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
      providers: buildProviderStatusRows()
    });
  } catch (err) {
    return providerAdminError(res, mapProviderPipelineError(err));
  } finally {
    if (providerImportInFlight === inFlightToken) {
      providerImportInFlight = null;
    }
  }
});

app.post("/api/admin/providers/:variant/check-update", async (req, res) => {
  let variant;
  try {
    variant = parseProviderVariant(req.params.variant);
  } catch (err) {
    return providerAdminError(res, err);
  }

  let currentCommit;
  try {
    currentCommit = resolveCurrentProviderCommitForUpdateCheck(variant, req.body?.commit);
  } catch (err) {
    return providerAdminError(res, err);
  }

  try {
    const result = await checkProviderUpdate({
      variant,
      currentCommit,
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
    });
    return res.json({
      ok: true,
      ...result,
      providers: buildProviderStatusRows()
    });
  } catch (err) {
    if (
      err instanceof ProviderUpdateCheckError &&
      (err.code === "UNSUPPORTED_VARIANT" || err.code === "INVALID_COMMIT")
    ) {
      return providerAdminError(res, new StatsApiError(400, err.message));
    }

    return res.json({
      ok: true,
      providerId: PROVIDER_ID,
      repository: PROVIDER_REPOSITORY,
      variant,
      checkedAt: new Date().toISOString(),
      status: "error",
      message: mapProviderUpdateCheckErrorToMessage(err),
      currentCommit,
      latestCommit: null,
      latestByPath: null,
      providers: buildProviderStatusRows()
    });
  }
});

app.post("/api/admin/providers/:variant/enable", (req, res) => {
  let variant;
  try {
    variant = parseProviderVariant(req.params.variant);
  } catch (err) {
    return providerAdminError(res, err);
  }

  let commit;
  try {
    commit = resolvePreferredProviderCommit(variant, req.body?.commit);
  } catch (err) {
    return providerAdminError(res, err);
  }

  try {
    const paths = buildProviderArtifactPaths(variant, commit);
    const minLength = PROVIDER_MIN_LENGTH;
    const guessDictionary = loadDictionary(paths.guessPool, minLength);
    const answerDictionary = loadDictionary(paths.answerPoolActive, minLength)
      || loadDictionary(paths.answerPoolFallback, minLength);
    if (!guessDictionary || !answerDictionary) {
      throw new StatsApiError(
        409,
        "Provider artifacts are incomplete. Expected guess and answer pools for that variant."
      );
    }

    const snapshot = languageRegistryStore.upsertProviderLanguageSync({
      variant,
      commit,
      providerId: PROVIDER_ID,
      dictionaryFile: paths.guessPool,
      label: getProviderVariantLabel(variant),
      minLength,
      enabled: true
    });
    rebuildLanguageRuntimeCatalog();

    const entry = snapshot.languages.find((language) => language.id === variant) || null;
    return res.json({
      ok: true,
      action: "enabled",
      variant,
      commit,
      language: entry,
      providers: buildProviderStatusRows()
    });
  } catch (err) {
    return providerAdminError(res, mapRegistryErrorToStats(err));
  }
});

app.post("/api/admin/providers/:variant/disable", (req, res) => {
  let variant;
  try {
    variant = parseProviderVariant(req.params.variant);
  } catch (err) {
    return providerAdminError(res, err);
  }

  try {
    const snapshot = languageRegistryStore.setLanguageEnabledSync(variant, false);
    rebuildLanguageRuntimeCatalog();

    const entry = snapshot.languages.find((language) => language.id === variant) || null;
    return res.json({
      ok: true,
      action: "disabled",
      variant,
      language: entry,
      providers: buildProviderStatusRows()
    });
  } catch (err) {
    return providerAdminError(res, mapRegistryErrorToStats(err));
  }
});

app.post("/api/encode", (req, res) => {
  const word = normalizeWord(req.body.word);
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }

  try {
    assertWord(word, getMinLengthForLang(lang));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const dict = getAnswerDictionary(lang);
  if (dict && !dictionaryHasWord(dict, word)) {
    return res.status(400).json({ error: "Word not found in dictionary for that language." });
  }

  const code = encodeWord(word);
  res.json({
    code,
    length: word.length,
    lang
  });
});

app.post("/api/random", (req, res) => {
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }
  const length = Number(req.body.length);
  const minLength = getMinLengthForLang(lang);

  if (!Number.isInteger(length) || length < minLength || length > MAX_LEN) {
    return res
      .status(400)
      .json({ error: `Length must be ${minLength}-${MAX_LEN}.` });
  }

  const dict = getAnswerDictionary(lang);
  if (!dict) {
    return res.status(400).json({ error: "No dictionary available for that language." });
  }

  const word = dictionaryRandomWord(dict, length);
  if (!word) {
    return res.status(400).json({ error: "No words available for that length." });
  }

  res.json({
    word,
    code: encodeWord(word),
    length,
    lang
  });
});

app.post("/api/puzzle", (req, res) => {
  const code = normalizeWord(req.body.code);
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }
  let guesses = DEFAULT_GUESSES;
  const minLength = getMinLengthForLang(lang);

  if (req.body.guesses !== undefined) {
    const parsed = Number(req.body.guesses);
    if (!Number.isInteger(parsed) || parsed < MIN_GUESSES || parsed > MAX_GUESSES) {
      return res.status(400).json({ error: `Guesses must be ${MIN_GUESSES}-${MAX_GUESSES}.` });
    }
    guesses = parsed;
  }

  if (!/^[A-Z]+$/.test(code)) {
    return res.status(400).json({ error: "Invalid word code." });
  }
  if (code.length < minLength || code.length > MAX_LEN) {
    return res.status(400).json({ error: "Invalid word code length." });
  }

  res.json({
    length: code.length,
    lang,
    label: getLanguageLabel(lang),
    maxGuesses: guesses
  });
});

app.post("/api/guess", (req, res) => {
  const code = normalizeWord(req.body.code);
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }
  const reveal = Boolean(req.body.reveal);

  if (!/^[A-Z]+$/.test(code)) {
    return res.status(400).json({ error: "Invalid word code." });
  }

  const answer = decodeWord(code);
  const guess = normalizeWord(req.body.guess);

  if (!/^[A-Z]+$/.test(guess)) {
    return res.status(400).json({ error: "Guess must use only letters A-Z." });
  }
  if (guess.length !== answer.length) {
    return res.status(400).json({ error: "Guess length does not match." });
  }

  const dict = getDictionary(lang);
  if (dict && !dictionaryHasWord(dict, guess)) {
    return res.status(400).json({ error: "Not in word list." });
  }

  const result = evaluateGuess(guess, answer);
  const isCorrect = guess === answer;

  const shouldIncludeMeaning = isCorrect || (reveal && !isCorrect);
  const answerMeaning = shouldIncludeMeaning
    ? lookupAnswerMeaning(lang, answer) || undefined
    : undefined;

  res.json({
    ok: true,
    result,
    isCorrect,
    answer: reveal && !isCorrect ? answer : undefined,
    answerMeaning
  });
});

app.get("/api/word", requireAdminAccess, (req, res) => {
  res.json(wordDataCache || buildDefaultWordData());
});

app.post("/api/word", requireAdminAccess, async (req, res) => {
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
});

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
  return listener(PORT, HOST, () => {
    console.log(`local-hosted-wordle server running at http://localhost:${PORT}`);
    console.log(`Definitions mode: ${DEFINITIONS_MODE}`);
    if (PERF_LOGGING) {
      console.log(
        `Perf logging enabled (definition cache size=${DEFINITION_CACHE_SIZE}, ttlMs=${DEFINITION_CACHE_TTL_MS})`
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
