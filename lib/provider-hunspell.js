const fs = require("node:fs");
const path = require("node:path");

const nspell = require("nspell");
const {
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  SOURCE_MANIFEST_TYPES,
  SUPPORTED_VARIANT_IDS,
  WORD_PATTERN,
  normalizeCommit: normalizeSharedCommit,
  normalizePolicyVersion: normalizeSharedPolicyVersion,
  normalizeVariant: normalizeSharedVariant,
  resolveWithinRoot: resolveWithinSharedRoot,
  writeFileAtomic: writeSharedFileAtomic,
  writeJsonAtomic: writeSharedJsonAtomic
} = require("./provider-artifact-shared");

const fsp = fs.promises;

const DEFAULT_PROVIDER_ROOT = path.join(__dirname, "..", "data", "providers");
const SUPPORTED_VARIANTS = new Set(SUPPORTED_VARIANT_IDS);
const SUPPORTED_SOURCE_MANIFEST_TYPES = new Set(Object.values(SOURCE_MANIFEST_TYPES));

class ProviderHunspellError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderHunspellError";
    this.code = code;
    this.retriable = options.retriable === true;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function normalizeVariant(variant) {
  return normalizeSharedVariant(variant, {
    supportedVariants: SUPPORTED_VARIANTS,
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  });
}

function normalizeCommit(commit) {
  return normalizeSharedCommit(commit, {
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  });
}

function normalizePolicyVersion(policyVersion) {
  return normalizeSharedPolicyVersion(policyVersion, {
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  });
}

function resolveWithinRoot(root, relativePath, fieldName) {
  return resolveWithinSharedRoot(root, relativePath, {
    fieldName,
    errorCode: "INVALID_MANIFEST",
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  }).resolved;
}

function readJson(filePath, kind) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ProviderHunspellError(
      "SOURCE_MANIFEST_MISSING",
      `Could not read ${kind} at ${filePath}.`,
      { cause: err }
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      `Invalid JSON in ${kind} at ${filePath}.`,
      { cause: err }
    );
  }
}

function validateSourceManifest(manifest, variant, commit) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ProviderHunspellError("INVALID_MANIFEST", "source-manifest payload must be an object.");
  }
  if (!SUPPORTED_SOURCE_MANIFEST_TYPES.has(String(manifest.manifestType || ""))) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      `source-manifest manifestType must be one of: ${Array.from(SUPPORTED_SOURCE_MANIFEST_TYPES).join(", ")}.`
    );
  }
  if (manifest.provider?.variant !== variant) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      `source-manifest variant mismatch: expected ${variant}.`
    );
  }
  if (manifest.provider?.commit !== commit) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      `source-manifest commit mismatch: expected ${commit}.`
    );
  }
  if (!manifest.sourceFiles?.dic?.localPath || !manifest.sourceFiles?.aff?.localPath) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      "source-manifest must include sourceFiles.dic.localPath and sourceFiles.aff.localPath."
    );
  }
}

function createSpellDictionary(affText, dicText) {
  try {
    return nspell(affText, dicText);
  } catch (err) {
    throw new ProviderHunspellError(
      "HUNSPELL_PARSE_FAILED",
      "Failed to parse Hunspell aff/dic source files.",
      { cause: err }
    );
  }
}

function countDictionaryEntries(dicText) {
  const lines = String(dicText || "").split(/\r?\n/);
  let count = 0;
  lines.forEach((line, index) => {
    const value = String(line || "").trim();
    if (!value) return;
    if (index === 0 && /^\d+$/.test(value)) return;
    count += 1;
  });
  return count;
}

function normalizeExpandedForms(spell, options = {}) {
  const minLength = options.minLength;
  const maxLength = options.maxLength;
  const words = Object.keys(spell.data || {});
  const normalized = new Set();
  let filteredCount = 0;

  words.forEach((entry) => {
    const upper = String(entry || "").trim().toUpperCase();
    if (!WORD_PATTERN.test(upper)) {
      filteredCount += 1;
      return;
    }
    if (upper.length < minLength || upper.length > maxLength) {
      filteredCount += 1;
      return;
    }
    normalized.add(upper);
  });

  // ASCII-only word list (A-Z) uses code-point sort for deterministic cross-locale ordering.
  const values = Array.from(normalized).sort();
  return {
    values,
    filteredCount
  };
}

function resolveLengthBounds(options = {}) {
  const minLength = Number.isInteger(options.minLength) ? options.minLength : MIN_WORD_LENGTH;
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : MAX_WORD_LENGTH;
  if (minLength !== MIN_WORD_LENGTH || maxLength !== MAX_WORD_LENGTH) {
    throw new ProviderHunspellError(
      "INVALID_POLICY_BOUNDS",
      `Length policy is fixed at ${MIN_WORD_LENGTH}-${MAX_WORD_LENGTH} for this pipeline.`
    );
  }
  return {
    minLength,
    maxLength
  };
}

async function writeFileAtomic(filePath, content) {
  await writeSharedFileAtomic(filePath, content, {
    errorCode: "PERSISTENCE_WRITE_FAILED",
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  });
}

async function writeJsonAtomic(filePath, payload) {
  await writeSharedJsonAtomic(filePath, payload, {
    errorCode: "PERSISTENCE_WRITE_FAILED",
    errorFactory: (code, message, options) => new ProviderHunspellError(code, message, options)
  });
}

async function buildExpandedFormsArtifacts(options) {
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
  const bounds = resolveLengthBounds(options);

  const dicPath = resolveWithinRoot(
    providerRoot,
    sourceManifest.sourceFiles.dic.localPath,
    "sourceFiles.dic.localPath"
  );
  const affPath = resolveWithinRoot(
    providerRoot,
    sourceManifest.sourceFiles.aff.localPath,
    "sourceFiles.aff.localPath"
  );

  let dicText;
  let affText;
  try {
    [dicText, affText] = await Promise.all([
      fsp.readFile(dicPath, "utf8"),
      fsp.readFile(affPath, "utf8")
    ]);
  } catch (err) {
    throw new ProviderHunspellError(
      "SOURCE_FILES_MISSING",
      "Could not read required dic/aff source files from provider artifacts.",
      { cause: err }
    );
  }

  const dictionary = createSpellDictionary(affText, dicText);
  const expanded = normalizeExpandedForms(dictionary, bounds);
  const rawEntries = countDictionaryEntries(dicText);
  const generatedAt = String(sourceManifest.retrievedAt || "");
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      "source-manifest must include a valid retrievedAt timestamp."
    );
  }

  await fsp.mkdir(outputVariantRoot, { recursive: true });

  const expandedFormsPath = path.join(outputVariantRoot, "expanded-forms.txt");
  await writeFileAtomic(expandedFormsPath, `${expanded.values.join("\n")}\n`);

  const processedPayload = {
    schemaVersion: 1,
    variant,
    commit,
    // Keep source path anchored to provider artifact layout to avoid "../" drift when outputRoot differs.
    sourceManifestPath: path.posix.join(variant, commit, "source-manifest.json"),
    policyVersion,
    counts: {
      rawEntries,
      expandedForms: expanded.values.length,
      filteredOut: expanded.filteredCount
    },
    generatedAt
  };
  const processedPath = path.join(outputVariantRoot, "processed.json");
  await writeJsonAtomic(processedPath, processedPayload);

  return {
    variant,
    commit,
    generatedAt,
    sourceManifestPath,
    expandedFormsPath,
    processedPath,
    counts: processedPayload.counts
  };
}

module.exports = {
  ProviderHunspellError,
  buildExpandedFormsArtifacts
};
