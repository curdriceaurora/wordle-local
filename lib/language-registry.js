const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const REGISTRY_SCHEMA_VERSION = 1;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WINDOWS_RENAME_OVERWRITE_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

class LanguageRegistryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LanguageRegistryError";
    this.code = code;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function toPositiveInteger(value, fallback) {
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function compareLanguageIds(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function isValidLanguageId(value) {
  const id = String(value || "");
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(id);
}

function normalizeRelativeDictionaryPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\\/g, "/");
  if (!RELATIVE_PATH_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeLanguageEntry(entry, options) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const id = String(entry.id || "").trim();
  if (!isValidLanguageId(id)) {
    return null;
  }
  const label = String(entry.label || "").trim();
  if (!label) {
    return null;
  }
  const source = String(entry.source || "").trim();
  if (source !== "baked" && source !== "provider") {
    return null;
  }
  if (typeof entry.enabled !== "boolean" || typeof entry.hasDictionary !== "boolean") {
    return null;
  }
  const enabled = entry.enabled;
  const hasDictionary = entry.hasDictionary;
  const minLength = toPositiveInteger(
    Number(entry.minLength),
    options.getMinLengthForLang(id)
  );
  const dictionaryFile = entry.dictionaryFile === null
    ? null
    : normalizeRelativeDictionaryPath(entry.dictionaryFile);
  if (entry.dictionaryFile !== null && dictionaryFile === null) {
    return null;
  }
  if (hasDictionary && !dictionaryFile) {
    return null;
  }
  if (!hasDictionary && dictionaryFile !== null) {
    return null;
  }

  const normalized = {
    id,
    label,
    enabled,
    source,
    minLength,
    hasDictionary,
    dictionaryFile
  };
  if (entry.provider && typeof entry.provider === "object" && !Array.isArray(entry.provider)) {
    const providerId = String(entry.provider.providerId || "").trim();
    const variant = String(entry.provider.variant || "").trim();
    const commit = String(entry.provider.commit || "").trim();
    if (!providerId || !isValidLanguageId(variant) || !COMMIT_SHA_PATTERN.test(commit)) {
      return null;
    }
    if (source !== "provider" || variant !== id) {
      return null;
    }
    normalized.provider = {
      providerId,
      variant,
      commit
    };
  } else if (source === "provider") {
    return null;
  } else if (source === "baked" && options.bakedLanguages[id]) {
    // Keep baked entries canonical so runtime behavior does not drift from compiled defaults.
    normalized.enabled = true;
    normalized.hasDictionary = Boolean(options.bakedLanguages[id].file);
    normalized.dictionaryFile = options.bakedLanguages[id].file || null;
  }
  return normalized;
}

function buildDefaultRegistry(options) {
  const entries = Object.entries(options.bakedLanguages).map(([id, language]) => ({
    id,
    label: String(language.label),
    enabled: true,
    source: "baked",
    minLength: options.getMinLengthForLang(id),
    hasDictionary: Boolean(language.file),
    dictionaryFile: language.file || null
  }));

  entries.sort((a, b) => compareLanguageIds(a.id, b.id));
  return {
    version: REGISTRY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    languages: entries
  };
}

function normalizeRegistryPayload(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (payload.version !== REGISTRY_SCHEMA_VERSION) {
    return null;
  }
  if (!Array.isArray(payload.languages)) {
    return null;
  }

  const normalized = [];
  for (const entry of payload.languages) {
    const normalizedEntry = normalizeLanguageEntry(entry, options);
    if (!normalizedEntry) {
      return null;
    }
    normalized.push(normalizedEntry);
  }

  if (!normalized.length) {
    return null;
  }

  const ids = new Set();
  for (const entry of normalized) {
    if (ids.has(entry.id)) {
      return null;
    }
    ids.add(entry.id);
  }

  const bakedLanguageIds = Object.keys(options.bakedLanguages);
  for (const bakedLanguageId of bakedLanguageIds) {
    if (!ids.has(bakedLanguageId)) {
      return null;
    }
  }

  normalized.sort((a, b) => compareLanguageIds(a.id, b.id));
  return {
    version: REGISTRY_SCHEMA_VERSION,
    updatedAt: String(payload.updatedAt || new Date().toISOString()),
    languages: normalized
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
    } catch (cleanupErr) {
      // Ignore cleanup errors for failed temp files.
    }
    throw new LanguageRegistryError(
      "REGISTRY_WRITE_FAILED",
      `Failed to persist language registry at ${filePath}.`,
      { cause: err }
    );
  }
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

class LanguageRegistryStore {
  constructor(options) {
    this.filePath = path.resolve(options.filePath);
    this.bakedLanguages = options.bakedLanguages;
    this.getMinLengthForLang = options.getMinLengthForLang;
    this.logger = options.logger || console;
    this.cache = null;
  }

  #buildOptions() {
    return {
      bakedLanguages: this.bakedLanguages,
      getMinLengthForLang: this.getMinLengthForLang
    };
  }

  #recoverWithDefaults(reason) {
    const fallback = buildDefaultRegistry(this.#buildOptions());
    writeJsonAtomicSync(this.filePath, fallback);
    this.logger.warn(
      `Language registry was ${reason}. Recovered with baked defaults.`
    );
    return fallback;
  }

  loadSync() {
    if (this.cache) {
      return this.cache;
    }
    if (!fs.existsSync(this.filePath)) {
      this.cache = this.#recoverWithDefaults("missing");
      return this.cache;
    }

    let parsed;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      this.cache = this.#recoverWithDefaults("invalid");
      return this.cache;
    }

    const normalized = normalizeRegistryPayload(parsed, this.#buildOptions());
    if (!normalized) {
      this.cache = this.#recoverWithDefaults("invalid");
      return this.cache;
    }

    this.cache = normalized;
    return this.cache;
  }

  reloadSync() {
    this.cache = null;
    return this.loadSync();
  }

  getEnabledLanguagesSync() {
    const snapshot = this.loadSync();
    return snapshot.languages.filter((language) => language.enabled);
  }

  updateSync(mutator) {
    if (typeof mutator !== "function") {
      throw new LanguageRegistryError("INVALID_MUTATOR", "mutator must be a function.");
    }
    const snapshot = this.loadSync();
    const draft = cloneSnapshot(snapshot);
    mutator(draft);
    draft.updatedAt = new Date().toISOString();

    const normalized = normalizeRegistryPayload(draft, this.#buildOptions());
    if (!normalized) {
      throw new LanguageRegistryError(
        "INVALID_REGISTRY_UPDATE",
        "Updated language registry payload is invalid."
      );
    }

    writeJsonAtomicSync(this.filePath, normalized);
    this.cache = normalized;
    return normalized;
  }

  upsertProviderLanguageSync(options) {
    const variant = String(options?.variant || "").trim();
    const commit = String(options?.commit || "").trim();
    const providerId = String(options?.providerId || "").trim();
    const dictionaryFile = normalizeRelativeDictionaryPath(options?.dictionaryFile);
    const label = String(options?.label || "").trim();
    const minLength = Number(options?.minLength);
    const enabled = options?.enabled === undefined ? true : options?.enabled;

    if (!isValidLanguageId(variant)) {
      throw new LanguageRegistryError("INVALID_VARIANT", "Provider language variant is invalid.");
    }
    if (!COMMIT_SHA_PATTERN.test(commit)) {
      throw new LanguageRegistryError("INVALID_COMMIT", "Provider commit must be a 40-char lowercase SHA.");
    }
    if (!providerId) {
      throw new LanguageRegistryError("INVALID_PROVIDER", "Provider ID is required.");
    }
    if (!dictionaryFile) {
      throw new LanguageRegistryError(
        "INVALID_DICTIONARY_FILE",
        "Provider dictionary file must be a safe relative path."
      );
    }
    if (!label) {
      throw new LanguageRegistryError("INVALID_LABEL", "Provider language label is required.");
    }
    if (!Number.isInteger(minLength) || minLength <= 0) {
      throw new LanguageRegistryError("INVALID_MIN_LENGTH", "Provider minLength must be a positive integer.");
    }
    if (typeof enabled !== "boolean") {
      throw new LanguageRegistryError("INVALID_ENABLED", "enabled must be a boolean.");
    }

    return this.updateSync((draft) => {
      const entry = {
        id: variant,
        label,
        enabled,
        source: "provider",
        minLength,
        hasDictionary: true,
        dictionaryFile,
        provider: {
          providerId,
          variant,
          commit
        }
      };
      const index = draft.languages.findIndex((language) => language.id === variant);
      if (index >= 0) {
        draft.languages[index] = entry;
      } else {
        draft.languages.push(entry);
      }
    });
  }

  setLanguageEnabledSync(languageId, enabled) {
    const id = String(languageId || "").trim();
    if (!isValidLanguageId(id)) {
      throw new LanguageRegistryError("INVALID_LANGUAGE", "Language ID is invalid.");
    }
    if (typeof enabled !== "boolean") {
      throw new LanguageRegistryError("INVALID_ENABLED", "enabled must be a boolean.");
    }

    return this.updateSync((draft) => {
      const entry = draft.languages.find((language) => language.id === id);
      if (!entry) {
        throw new LanguageRegistryError("LANGUAGE_NOT_FOUND", `Language ${id} is not in the registry.`);
      }
      if (entry.source === "baked") {
        throw new LanguageRegistryError("BAKED_LANGUAGE_IMMUTABLE", "Baked languages cannot be disabled.");
      }
      entry.enabled = enabled;
    });
  }
}

module.exports = {
  LanguageRegistryError,
  LanguageRegistryStore,
  REGISTRY_SCHEMA_VERSION,
  buildDefaultRegistry,
  normalizeRegistryPayload
};
