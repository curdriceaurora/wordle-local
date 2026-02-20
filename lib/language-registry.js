const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const REGISTRY_SCHEMA_VERSION = 1;

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

function isValidLanguageId(value) {
  const id = String(value || "");
  return id === "none" || /^[a-z]{2}(?:-[A-Z]{2})?$/.test(id);
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
  const enabled = entry.enabled !== false;
  const hasDictionary = entry.hasDictionary === true;
  const minLength = toPositiveInteger(
    Number(entry.minLength),
    options.getMinLengthForLang(id)
  );
  const dictionaryFile = entry.dictionaryFile === null
    ? null
    : entry.dictionaryFile
      ? String(entry.dictionaryFile)
      : null;

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
    normalized.provider = {
      providerId: String(entry.provider.providerId || "").trim(),
      variant: String(entry.provider.variant || "").trim()
    };
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

  entries.sort((a, b) => a.id.localeCompare(b.id));
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

  const normalized = payload.languages
    .map((entry) => normalizeLanguageEntry(entry, options))
    .filter(Boolean);

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

  normalized.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: REGISTRY_SCHEMA_VERSION,
    updatedAt: String(payload.updatedAt || new Date().toISOString()),
    languages: normalized
  };
}

function writeJsonAtomicSync(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
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
}

module.exports = {
  LanguageRegistryError,
  LanguageRegistryStore,
  REGISTRY_SCHEMA_VERSION,
  buildDefaultRegistry,
  normalizeRegistryPayload
};
