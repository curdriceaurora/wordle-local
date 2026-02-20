const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const nspell = require("nspell");

const fsp = fs.promises;

const DEFAULT_PROVIDER_ROOT = path.join(__dirname, "..", "data", "providers");
const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 12;
const WORD_PATTERN = /^[A-Z]+$/;
const VARIANT_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;

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
  const value = String(variant || "").trim();
  if (!VARIANT_PATTERN.test(value)) {
    throw new ProviderHunspellError(
      "INVALID_VARIANT",
      "variant must match xx or xx-YY format."
    );
  }
  return value;
}

function normalizeCommit(commit) {
  const value = String(commit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new ProviderHunspellError(
      "INVALID_COMMIT",
      "commit must be a 40-character lowercase git SHA."
    );
  }
  return value;
}

function normalizePolicyVersion(policyVersion) {
  const value = String(policyVersion || "v1").trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    throw new ProviderHunspellError(
      "INVALID_POLICY_VERSION",
      "policyVersion must be 1-32 chars using letters, numbers, dot, underscore, or hyphen."
    );
  }
  return value;
}

function resolveWithinRoot(root, relativePath, fieldName) {
  const rel = String(relativePath || "").trim();
  if (!rel) {
    throw new ProviderHunspellError("INVALID_MANIFEST", `${fieldName} must be a non-empty path.`);
  }
  if (path.isAbsolute(rel)) {
    throw new ProviderHunspellError("INVALID_MANIFEST", `${fieldName} must be relative.`);
  }

  const resolved = path.resolve(root, rel);
  const relativeResolved = path.relative(root, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      `${fieldName} points outside provider root.`
    );
  }
  return resolved;
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
  if (manifest.manifestType !== "provider-source-fetch") {
    throw new ProviderHunspellError(
      "INVALID_MANIFEST",
      "source-manifest manifestType must be provider-source-fetch."
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
  const minLength = Number.isInteger(options.minLength) ? options.minLength : MIN_WORD_LENGTH;
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : MAX_WORD_LENGTH;
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
    throw new ProviderHunspellError(
      "PERSISTENCE_WRITE_FAILED",
      `Failed to persist file at ${filePath}.`,
      { cause: err }
    );
  }
}

async function writeJsonAtomic(filePath, payload) {
  await writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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
  const expanded = normalizeExpandedForms(dictionary, options);
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
    sourceManifestPath: path.relative(outputRoot, sourceManifestPath).split(path.sep).join(path.posix.sep),
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
