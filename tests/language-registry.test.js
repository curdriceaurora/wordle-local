const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LanguageRegistryError,
  LanguageRegistryStore,
  REGISTRY_SCHEMA_VERSION,
  buildDefaultRegistry,
  normalizeRegistryPayload
} = require("../lib/language-registry");

const BAKED_LANGUAGES = Object.freeze({
  en: Object.freeze({ label: "English", file: "en.txt" })
});

const SAMPLE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lhw-lang-registry-"));
}

function createRegistryStore(filePath) {
  return new LanguageRegistryStore({
    filePath,
    bakedLanguages: BAKED_LANGUAGES,
    getMinLengthForLang: () => 3,
    logger: {
      warn: jest.fn()
    }
  });
}

function baseEnglishEntry() {
  return {
    id: "en",
    label: "English",
    enabled: true,
    source: "baked",
    minLength: 3,
    hasDictionary: true,
    dictionaryFile: "en.txt"
  };
}

describe("language-registry", () => {
  test("buildDefaultRegistry returns deterministic baked defaults", () => {
    const registry = buildDefaultRegistry({
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });

    expect(registry.version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(registry.languages.map((language) => language.id)).toEqual(["en"]);
    expect(registry.languages[0].dictionaryFile).toBe("en.txt");
  });

  test("normalizeRegistryPayload rejects duplicate IDs", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [baseEnglishEntry(), { ...baseEnglishEntry(), label: "Duplicate English" }]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload rejects unsafe dictionary paths", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [{ ...baseEnglishEntry(), dictionaryFile: "../escape.txt" }]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload rejects provider entries without valid metadata", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        baseEnglishEntry(),
        {
          id: "en-US",
          label: "English (US)",
          enabled: true,
          source: "provider",
          minLength: 3,
          hasDictionary: true,
          dictionaryFile: "providers/en-US/some-commit/guess-pool.txt",
          provider: {
            providerId: "libreoffice-dictionaries",
            variant: "en-US",
            commit: "invalid"
          }
        }
      ]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload requires baked defaults to remain present", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        {
          id: "en-US",
          label: "English (US)",
          enabled: true,
          source: "provider",
          minLength: 3,
          hasDictionary: true,
          dictionaryFile: "providers/en-US/some-commit/guess-pool.txt",
          provider: {
            providerId: "libreoffice-dictionaries",
            variant: "en-US",
            commit: SAMPLE_COMMIT
          }
        }
      ]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload rejects non-boolean enabled and hasDictionary values", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        {
          ...baseEnglishEntry(),
          enabled: "true",
          hasDictionary: 1
        }
      ]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload enforces hasDictionary and dictionaryFile coupling", () => {
    const badWithNull = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [{ ...baseEnglishEntry(), dictionaryFile: null }]
    };
    const badWithString = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        baseEnglishEntry(),
        {
          id: "es",
          label: "Spanish",
          enabled: false,
          source: "baked",
          minLength: 3,
          hasDictionary: false,
          dictionaryFile: "should-not-exist.txt"
        }
      ]
    };

    expect(
      normalizeRegistryPayload(badWithNull, {
        bakedLanguages: BAKED_LANGUAGES,
        getMinLengthForLang: () => 3
      })
    ).toBeNull();
    expect(
      normalizeRegistryPayload(badWithString, {
        bakedLanguages: BAKED_LANGUAGES,
        getMinLengthForLang: () => 3
      })
    ).toBeNull();
  });

  test("loadSync recovers missing or invalid registry file with baked defaults", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    const store = createRegistryStore(filePath);

    try {
      const first = store.loadSync();
      expect(first.languages.map((language) => language.id)).toEqual(["en"]);
      fs.writeFileSync(filePath, "{ invalid-json", "utf8");
      const reloaded = store.reloadSync();
      expect(reloaded.languages.map((language) => language.id)).toEqual(["en"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upsertProviderLanguageSync persists provider entry and enable/disable lifecycle", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    const store = createRegistryStore(filePath);

    try {
      store.loadSync();
      store.upsertProviderLanguageSync({
        variant: "en-US",
        commit: SAMPLE_COMMIT,
        providerId: "libreoffice-dictionaries",
        dictionaryFile: "providers/en-US/0123456789abcdef0123456789abcdef01234567/guess-pool.txt",
        label: "English (US)",
        minLength: 3,
        enabled: true
      });
      let snapshot = store.reloadSync();
      const providerEntry = snapshot.languages.find((language) => language.id === "en-US");
      expect(providerEntry).toBeTruthy();
      expect(providerEntry.enabled).toBe(true);
      expect(providerEntry.provider.commit).toBe(SAMPLE_COMMIT);

      store.setLanguageEnabledSync("en-US", false);
      snapshot = store.reloadSync();
      expect(snapshot.languages.find((language) => language.id === "en-US")?.enabled).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upsertProviderLanguageSync rejects non-boolean enabled values", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    const store = createRegistryStore(filePath);

    try {
      store.loadSync();
      expect(() =>
        store.upsertProviderLanguageSync({
          variant: "en-US",
          commit: SAMPLE_COMMIT,
          providerId: "libreoffice-dictionaries",
          dictionaryFile: "providers/en-US/0123456789abcdef0123456789abcdef01234567/guess-pool.txt",
          label: "English (US)",
          minLength: 3,
          enabled: "true"
        })
      ).toThrow(LanguageRegistryError);
      expect(() =>
        store.upsertProviderLanguageSync({
          variant: "en-US",
          commit: SAMPLE_COMMIT,
          providerId: "libreoffice-dictionaries",
          dictionaryFile: "providers/en-US/0123456789abcdef0123456789abcdef01234567/guess-pool.txt",
          label: "English (US)",
          minLength: 3,
          enabled: "true"
        })
      ).toThrow("enabled must be a boolean");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setLanguageEnabledSync rejects disabling baked English", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    const store = createRegistryStore(filePath);

    try {
      store.loadSync();
      expect(() => store.setLanguageEnabledSync("en", false)).toThrow(LanguageRegistryError);
      expect(() => store.setLanguageEnabledSync("en", false)).toThrow("Baked languages cannot be disabled.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
