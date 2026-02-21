const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  SUPPORTED_VARIANT_IDS,
  WORD_PATTERN,
  normalizeCommit: normalizeSharedCommit,
  normalizeRelativePath: normalizeSharedRelativePath,
  normalizeVariant: normalizeSharedVariant,
  resolveWithinRoot: resolveWithinSharedRoot,
  writeFileAtomic: writeSharedFileAtomic,
  writeJsonAtomic: writeSharedJsonAtomic
} = require("./provider-artifact-shared");

const fsp = fs.promises;

const DEFAULT_PROVIDER_ROOT = path.join(__dirname, "..", "data", "providers");
const DEFAULT_DENYLIST_FILE = "family-denylist.txt";
const DEFAULT_ALLOWLIST_FILE = "family-allowlist.txt";
const SUPPORTED_VARIANTS = new Set(SUPPORTED_VARIANT_IDS);

const FILTER_MODES = Object.freeze({
  DENYLIST_ONLY: "denylist-only",
  ALLOWLIST_REQUIRED: "allowlist-required"
});

class ProviderAnswerFilterError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderAnswerFilterError";
    this.code = code;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function createError(code, message, options) {
  return new ProviderAnswerFilterError(code, message, options);
}

function normalizeVariant(variant) {
  return normalizeSharedVariant(variant, {
    supportedVariants: SUPPORTED_VARIANTS,
    errorFactory: createError
  });
}

function normalizeCommit(commit) {
  return normalizeSharedCommit(commit, {
    errorFactory: createError
  });
}

function normalizeRelativePath(relativePath, fieldName) {
  return normalizeSharedRelativePath(relativePath, {
    fieldName,
    errorCode: "INVALID_PATH",
    errorFactory: createError
  });
}

function resolveWithinRoot(root, relativePath, fieldName) {
  return resolveWithinSharedRoot(root, relativePath, {
    fieldName,
    errorCode: "INVALID_PATH",
    errorFactory: createError
  });
}

async function writeFileAtomic(filePath, content) {
  await writeSharedFileAtomic(filePath, content, {
    errorCode: "PERSISTENCE_WRITE_FAILED",
    errorFactory: createError
  });
}

async function writeJsonAtomic(filePath, payload) {
  await writeSharedJsonAtomic(filePath, payload, {
    errorCode: "PERSISTENCE_WRITE_FAILED",
    errorFactory: createError
  });
}

function normalizeFilterMode(filterMode) {
  const value = String(filterMode || FILTER_MODES.DENYLIST_ONLY).trim();
  if (!Object.values(FILTER_MODES).includes(value)) {
    throw new ProviderAnswerFilterError(
      "INVALID_FILTER_MODE",
      `filterMode must be one of ${Object.values(FILTER_MODES).join(", ")}.`
    );
  }
  return value;
}

function parseWords(rawText, options = {}) {
  const words = new Set();
  let filteredCount = 0;
  const allowComments = options.allowComments === true;
  const lines = String(rawText || "").split(/\r?\n/);

  for (const line of lines) {
    const value = String(line || "").trim();
    if (!value) {
      continue;
    }
    if (allowComments && value.startsWith("#")) {
      continue;
    }
    const normalized = value.toUpperCase();
    if (!WORD_PATTERN.test(normalized)) {
      filteredCount += 1;
      continue;
    }
    if (normalized.length < MIN_WORD_LENGTH || normalized.length > MAX_WORD_LENGTH) {
      filteredCount += 1;
      continue;
    }
    words.add(normalized);
  }

  return {
    words,
    filteredCount
  };
}

function readJson(filePath, kind) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ProviderAnswerFilterError(
      "SOURCE_MANIFEST_MISSING",
      `Could not read ${kind} at ${filePath}.`,
      { cause: err }
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProviderAnswerFilterError(
      "INVALID_MANIFEST",
      `Invalid JSON in ${kind} at ${filePath}.`,
      { cause: err }
    );
  }
}

function readGeneratedAt(variantRoot, variant, commit) {
  const sourceManifest = readJson(path.join(variantRoot, "source-manifest.json"), "source-manifest");
  if (!sourceManifest || typeof sourceManifest !== "object" || Array.isArray(sourceManifest)) {
    throw new ProviderAnswerFilterError("INVALID_MANIFEST", "source-manifest payload must be an object.");
  }
  if (sourceManifest.manifestType !== "provider-source-fetch") {
    throw new ProviderAnswerFilterError(
      "INVALID_MANIFEST",
      "source-manifest manifestType must be provider-source-fetch."
    );
  }
  if (sourceManifest.provider?.variant !== variant) {
    throw new ProviderAnswerFilterError(
      "INVALID_MANIFEST",
      `source-manifest variant mismatch: expected ${variant}.`
    );
  }
  if (sourceManifest.provider?.commit !== commit) {
    throw new ProviderAnswerFilterError(
      "INVALID_MANIFEST",
      `source-manifest commit mismatch: expected ${commit}.`
    );
  }

  const generatedAt = String(sourceManifest.retrievedAt || "");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new ProviderAnswerFilterError(
      "INVALID_MANIFEST",
      "source-manifest must include a valid retrievedAt timestamp."
    );
  }
  return generatedAt;
}

async function readRequiredWordSet(filePath, kind, options = {}) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    throw new ProviderAnswerFilterError(
      "INPUT_ARTIFACT_MISSING",
      `Could not read ${kind} at ${filePath}.`,
      { cause: err }
    );
  }
  return parseWords(raw, options);
}

async function readOptionalWordSet(filePath, options = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return parseWords(raw, options);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        words: new Set(),
        filteredCount: 0,
        missing: true
      };
    }
    throw new ProviderAnswerFilterError(
      "INPUT_ARTIFACT_MISSING",
      `Could not read list file at ${filePath}.`,
      { cause: err }
    );
  }
}

function toSortedArray(values) {
  // ASCII-only word list (A-Z) uses code-point sort for deterministic cross-locale ordering.
  return Array.from(values).sort();
}

async function buildFilteredAnswerPoolArtifacts(options) {
  const variant = normalizeVariant(options?.variant);
  const commit = normalizeCommit(options?.commit);
  const filterMode = normalizeFilterMode(options?.filterMode);
  const providerRoot = options?.providerRoot
    ? path.resolve(options.providerRoot)
    : DEFAULT_PROVIDER_ROOT;
  const outputRoot = options?.outputRoot
    ? path.resolve(options.outputRoot)
    : providerRoot;
  const variantRoot = path.join(providerRoot, variant, commit);
  const outputVariantRoot = path.join(outputRoot, variant, commit);

  const generatedAt = readGeneratedAt(variantRoot, variant, commit);

  const answerPoolPathRelative = options?.answerPoolPath
    ? normalizeRelativePath(options.answerPoolPath, "answerPoolPath")
    : path.posix.join(variant, commit, "answer-pool.txt");
  const answerPoolSource = resolveWithinRoot(providerRoot, answerPoolPathRelative, "answerPoolPath");
  const answerPool = await readRequiredWordSet(answerPoolSource.resolved, "answer-pool");
  if (answerPool.words.size === 0) {
    throw new ProviderAnswerFilterError(
      "ANSWER_POOL_EMPTY",
      "Input answer pool is empty after normalization."
    );
  }

  const denylistPathRelative = options?.denylistPath
    ? normalizeRelativePath(options.denylistPath, "denylistPath")
    : path.posix.join(variant, commit, DEFAULT_DENYLIST_FILE);
  const denylistSource = resolveWithinRoot(providerRoot, denylistPathRelative, "denylistPath");
  const denylist = await readOptionalWordSet(denylistSource.resolved, { allowComments: true });

  const allowlistPathRelative = options?.allowlistPath
    ? normalizeRelativePath(options.allowlistPath, "allowlistPath")
    : path.posix.join(variant, commit, DEFAULT_ALLOWLIST_FILE);
  const allowlistSource = resolveWithinRoot(providerRoot, allowlistPathRelative, "allowlistPath");
  const allowlist = await readOptionalWordSet(allowlistSource.resolved, { allowComments: true });
  if (filterMode === FILTER_MODES.ALLOWLIST_REQUIRED && allowlist.missing) {
    throw new ProviderAnswerFilterError(
      "ALLOWLIST_REQUIRED",
      `allowlistPath must exist when filterMode=${FILTER_MODES.ALLOWLIST_REQUIRED}.`
    );
  }

  const filteredAnswerPool = new Set();
  let denylistMatched = 0;
  let allowlistExcluded = 0;

  for (const word of answerPool.words) {
    if (denylist.words.has(word)) {
      denylistMatched += 1;
      continue;
    }
    if (filterMode === FILTER_MODES.ALLOWLIST_REQUIRED && !allowlist.words.has(word)) {
      allowlistExcluded += 1;
      continue;
    }
    filteredAnswerPool.add(word);
  }

  if (filteredAnswerPool.size === 0) {
    throw new ProviderAnswerFilterError(
      "FILTERED_POOL_EMPTY",
      "Family-safe filtering removed all candidate answers."
    );
  }

  await fsp.mkdir(outputVariantRoot, { recursive: true });
  const activeAnswerPoolPath = path.join(outputVariantRoot, "answer-pool-active.txt");
  await writeFileAtomic(activeAnswerPoolPath, `${toSortedArray(filteredAnswerPool).join("\n")}\n`);

  const metadata = {
    schemaVersion: 1,
    variant,
    commit,
    filterMode,
    sourceAnswerPoolPath: answerPoolSource.normalized,
    denylistPath: denylistSource.normalized,
    allowlistPath: allowlistSource.normalized,
    counts: {
      inputAnswers: answerPool.words.size,
      inputFilteredOut: answerPool.filteredCount,
      denylistEntries: denylist.words.size,
      denylistFilteredOut: denylist.filteredCount,
      denylistMatched,
      allowlistEntries: allowlist.words.size,
      allowlistFilteredOut: allowlist.filteredCount,
      allowlistExcluded,
      activatedAnswers: filteredAnswerPool.size
    },
    generatedAt
  };

  const filterMetadataPath = path.join(outputVariantRoot, "answer-filter.json");
  await writeJsonAtomic(filterMetadataPath, metadata);

  return {
    variant,
    commit,
    filterMode,
    activeAnswerPoolPath,
    filterMetadataPath,
    counts: metadata.counts
  };
}

module.exports = {
  FILTER_MODES,
  ProviderAnswerFilterError,
  buildFilteredAnswerPoolArtifacts
};
