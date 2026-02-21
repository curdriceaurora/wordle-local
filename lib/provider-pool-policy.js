const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const fsp = fs.promises;

const DEFAULT_PROVIDER_ROOT = path.join(__dirname, "..", "data", "providers");
const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 12;
const WORD_PATTERN = /^[A-Z]+$/;
const SUPPORTED_VARIANTS = new Set(["en-GB", "en-US", "en-CA", "en-AU", "en-ZA"]);
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const DEFAULT_IRREGULAR_ALLOWLIST_FILE = "irregular-answer-allowlist.txt";

class ProviderPoolPolicyError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderPoolPolicyError";
    this.code = code;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function normalizeVariant(variant) {
  const value = String(variant || "").trim();
  if (!SUPPORTED_VARIANTS.has(value)) {
    throw new ProviderPoolPolicyError(
      "INVALID_VARIANT",
      "variant must be one of en-GB, en-US, en-CA, en-AU, en-ZA."
    );
  }
  return value;
}

function normalizeCommit(commit) {
  const value = String(commit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new ProviderPoolPolicyError(
      "INVALID_COMMIT",
      "commit must be a 40-character lowercase git SHA."
    );
  }
  return value;
}

function normalizePolicyVersion(policyVersion) {
  const value = String(policyVersion || "v1").trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    throw new ProviderPoolPolicyError(
      "INVALID_POLICY_VERSION",
      "policyVersion must be 1-32 chars using letters, numbers, dot, underscore, or hyphen."
    );
  }
  return value;
}

function normalizeRelativePath(relativePath, fieldName) {
  const value = String(relativePath || "").trim();
  if (!value) {
    throw new ProviderPoolPolicyError("INVALID_PATH", `${fieldName} must be a non-empty path.`);
  }
  if (path.isAbsolute(value) || !RELATIVE_PATH_PATTERN.test(value)) {
    throw new ProviderPoolPolicyError(
      "INVALID_PATH",
      `${fieldName} must be a safe relative path without traversal segments.`
    );
  }
  return value;
}

function parseWordsFromText(rawText) {
  const words = new Set();
  let filteredCount = 0;
  const lines = String(rawText || "").split(/\r?\n/);
  for (const line of lines) {
    const word = String(line || "").trim().toUpperCase();
    if (!word) {
      continue;
    }
    if (!WORD_PATTERN.test(word)) {
      filteredCount += 1;
      continue;
    }
    if (word.length < MIN_WORD_LENGTH || word.length > MAX_WORD_LENGTH) {
      filteredCount += 1;
      continue;
    }
    words.add(word);
  }
  return {
    words,
    filteredCount
  };
}

function parseBaseWordsFromDic(dicText) {
  const lines = String(dicText || "").split(/\r?\n/);
  const baseWords = new Set();
  let rawEntryCount = 0;
  let filteredCount = 0;

  lines.forEach((line, lineIndex) => {
    const value = String(line || "").trim();
    if (!value) {
      return;
    }
    if (lineIndex === 0 && /^\d+$/.test(value)) {
      return;
    }

    const token = value.split(/\s+/)[0];
    const stem = token.split("/")[0];
    const normalized = String(stem || "").trim().toUpperCase();
    rawEntryCount += 1;

    if (!WORD_PATTERN.test(normalized)) {
      filteredCount += 1;
      return;
    }
    if (normalized.length < MIN_WORD_LENGTH || normalized.length > MAX_WORD_LENGTH) {
      filteredCount += 1;
      return;
    }
    baseWords.add(normalized);
  });

  return {
    baseWords,
    rawEntryCount,
    filteredCount
  };
}

function parseAllowlistText(rawText) {
  const entries = new Set();
  let filteredCount = 0;
  const lines = String(rawText || "").split(/\r?\n/);
  for (const line of lines) {
    const value = String(line || "").trim();
    if (!value || value.startsWith("#")) {
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
    entries.add(normalized);
  }
  return {
    entries,
    filteredCount
  };
}

function readJson(filePath, kind) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ProviderPoolPolicyError(
      "SOURCE_MANIFEST_MISSING",
      `Could not read ${kind} at ${filePath}.`,
      { cause: err }
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      `Invalid JSON in ${kind} at ${filePath}.`,
      { cause: err }
    );
  }
}

function validateSourceManifest(manifest, variant, commit) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ProviderPoolPolicyError("INVALID_MANIFEST", "source-manifest payload must be an object.");
  }
  if (manifest.manifestType !== "provider-source-fetch") {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      "source-manifest manifestType must be provider-source-fetch."
    );
  }
  if (manifest.provider?.variant !== variant) {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      `source-manifest variant mismatch: expected ${variant}.`
    );
  }
  if (manifest.provider?.commit !== commit) {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      `source-manifest commit mismatch: expected ${commit}.`
    );
  }
  if (!manifest.sourceFiles?.dic?.localPath) {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      "source-manifest must include sourceFiles.dic.localPath."
    );
  }
  const generatedAt = String(manifest.retrievedAt || "");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new ProviderPoolPolicyError(
      "INVALID_MANIFEST",
      "source-manifest must include a valid retrievedAt timestamp."
    );
  }
}

function resolveWithinRoot(root, relativePath, fieldName) {
  const rel = normalizeRelativePath(relativePath, fieldName);
  const resolved = path.resolve(root, rel);
  const relativeResolved = path.relative(root, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new ProviderPoolPolicyError(
      "INVALID_PATH",
      `${fieldName} points outside provider root.`
    );
  }
  return {
    resolved,
    normalized: rel
  };
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, content, "utf8");
    try {
      await fsp.rename(tempPath, filePath);
    } catch (renameErr) {
      if (renameErr && ["EEXIST", "EPERM", "EACCES"].includes(renameErr.code)) {
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tempPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw new ProviderPoolPolicyError(
      "PERSISTENCE_WRITE_FAILED",
      `Failed to persist file at ${filePath}.`,
      { cause: err }
    );
  }
}

async function writeJsonAtomic(filePath, payload) {
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function toSortedArray(values) {
  // ASCII-only word list (A-Z) uses code-point sort for deterministic cross-locale ordering.
  return Array.from(values).sort();
}

async function readOptionalAllowlist(options, variant, commit, providerRoot) {
  if (Array.isArray(options?.irregularAllowlist)) {
    return {
      path: null,
      ...parseAllowlistText(options.irregularAllowlist.join("\n"))
    };
  }

  const relativePath = options?.irregularAllowlistPath
    ? normalizeRelativePath(options.irregularAllowlistPath, "irregularAllowlistPath")
    : path.posix.join(variant, commit, DEFAULT_IRREGULAR_ALLOWLIST_FILE);

  const resolved = path.resolve(providerRoot, relativePath);
  const relativeResolved = path.relative(providerRoot, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new ProviderPoolPolicyError(
      "INVALID_PATH",
      "irregularAllowlistPath points outside provider root."
    );
  }

  try {
    const raw = await fsp.readFile(resolved, "utf8");
    return {
      path: relativePath,
      ...parseAllowlistText(raw)
    };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        path: relativePath,
        entries: new Set(),
        filteredCount: 0
      };
    }
    throw new ProviderPoolPolicyError(
      "ALLOWLIST_READ_FAILED",
      `Failed to read irregular allowlist at ${resolved}.`,
      { cause: err }
    );
  }
}

async function buildProviderPoolsArtifacts(options) {
  const variant = normalizeVariant(options?.variant);
  const commit = normalizeCommit(options?.commit);
  const policyVersion = normalizePolicyVersion(options?.policyVersion);
  const providerRoot = options?.providerRoot
    ? path.resolve(options.providerRoot)
    : DEFAULT_PROVIDER_ROOT;
  const outputRoot = options?.outputRoot
    ? path.resolve(options.outputRoot)
    : providerRoot;
  const variantRoot = path.join(providerRoot, variant, commit);
  const outputVariantRoot = path.join(outputRoot, variant, commit);

  const sourceManifestPath = path.join(variantRoot, "source-manifest.json");
  const sourceManifest = readJson(sourceManifestPath, "source-manifest");
  validateSourceManifest(sourceManifest, variant, commit);

  const dic = resolveWithinRoot(
    providerRoot,
    sourceManifest.sourceFiles.dic.localPath,
    "sourceFiles.dic.localPath"
  );
  const expandedFormsPath = path.join(variantRoot, "expanded-forms.txt");

  let dicText;
  let expandedFormsText;
  try {
    [dicText, expandedFormsText] = await Promise.all([
      fsp.readFile(dic.resolved, "utf8"),
      fsp.readFile(expandedFormsPath, "utf8")
    ]);
  } catch (err) {
    throw new ProviderPoolPolicyError(
      "INPUT_ARTIFACT_MISSING",
      "Required source files for policy generation are missing.",
      { cause: err }
    );
  }

  const guessPool = parseWordsFromText(expandedFormsText);
  if (guessPool.words.size === 0) {
    throw new ProviderPoolPolicyError(
      "GUESS_POOL_EMPTY",
      "expanded-forms.txt produced an empty guess pool."
    );
  }

  const base = parseBaseWordsFromDic(dicText);
  const allowlist = await readOptionalAllowlist(options, variant, commit, providerRoot);

  const answerPool = new Set();
  let baseMissingFromGuessPool = 0;
  for (const word of base.baseWords) {
    if (guessPool.words.has(word)) {
      answerPool.add(word);
    } else {
      baseMissingFromGuessPool += 1;
    }
  }

  let irregularAccepted = 0;
  let irregularMissingFromGuessPool = 0;
  for (const irregularWord of allowlist.entries) {
    if (guessPool.words.has(irregularWord)) {
      if (!answerPool.has(irregularWord)) {
        answerPool.add(irregularWord);
        irregularAccepted += 1;
      }
    } else {
      irregularMissingFromGuessPool += 1;
    }
  }

  if (answerPool.size === 0) {
    throw new ProviderPoolPolicyError(
      "ANSWER_POOL_EMPTY",
      "Base+irregular policy produced an empty answer pool."
    );
  }

  await fsp.mkdir(outputVariantRoot, { recursive: true });
  const guessPoolPath = path.join(outputVariantRoot, "guess-pool.txt");
  const answerPoolPath = path.join(outputVariantRoot, "answer-pool.txt");
  await writeFileAtomic(guessPoolPath, `${toSortedArray(guessPool.words).join("\n")}\n`);
  await writeFileAtomic(answerPoolPath, `${toSortedArray(answerPool).join("\n")}\n`);

  const metadata = {
    schemaVersion: 1,
    variant,
    commit,
    policyVersion,
    guessPoolPolicy: "expanded-forms",
    answerPoolPolicy: "base-plus-irregular",
    sourceManifestPath: path.posix.join(variant, commit, "source-manifest.json"),
    expandedFormsPath: path.posix.join(variant, commit, "expanded-forms.txt"),
    irregularAllowlistPath: allowlist.path,
    counts: {
      rawBaseEntries: base.rawEntryCount,
      baseWords: base.baseWords.size,
      baseWordsFilteredOut: base.filteredCount,
      baseMissingFromGuessPool,
      irregularAllowlisted: allowlist.entries.size,
      irregularAllowlistFilteredOut: allowlist.filteredCount,
      irregularAccepted,
      irregularMissingFromGuessPool,
      expandedForms: guessPool.words.size,
      expandedFormsFilteredOut: guessPool.filteredCount,
      answerPool: answerPool.size
    },
    generatedAt: String(sourceManifest.retrievedAt)
  };

  const metadataPath = path.join(outputVariantRoot, "pool-policy.json");
  await writeJsonAtomic(metadataPath, metadata);

  return {
    variant,
    commit,
    policyVersion,
    guessPoolPath,
    answerPoolPath,
    metadataPath,
    counts: metadata.counts
  };
}

module.exports = {
  ProviderPoolPolicyError,
  buildProviderPoolsArtifacts
};
