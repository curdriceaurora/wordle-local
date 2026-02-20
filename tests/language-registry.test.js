const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LanguageRegistryStore,
  REGISTRY_SCHEMA_VERSION,
  buildDefaultRegistry,
  normalizeRegistryPayload
} = require("../lib/language-registry");

const BAKED_LANGUAGES = Object.freeze({
  en: Object.freeze({ label: "English", file: "en.txt" }),
  none: Object.freeze({ label: "No dictionary", file: null })
});

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

describe("language-registry", () => {
  test("buildDefaultRegistry returns deterministic baked defaults", () => {
    const registry = buildDefaultRegistry({
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });

    expect(registry.version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(registry.languages.map((language) => language.id)).toEqual(["en", "none"]);
    expect(registry.languages[0].dictionaryFile).toBe("en.txt");
    expect(registry.languages[1].dictionaryFile).toBeNull();
  });

  test("normalizeRegistryPayload rejects duplicate or malformed IDs", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        {
          id: "en",
          label: "English",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: true,
          dictionaryFile: "en.txt"
        },
        {
          id: "en",
          label: "Duplicate",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: true,
          dictionaryFile: "en.txt"
        }
      ]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("loadSync recovers missing registry file with baked defaults", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    const store = createRegistryStore(filePath);

    try {
      const snapshot = store.loadSync();
      expect(snapshot.version).toBe(REGISTRY_SCHEMA_VERSION);
      expect(snapshot.languages.map((language) => language.id)).toEqual(["en", "none"]);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadSync recovers invalid registry content", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    fs.writeFileSync(filePath, "{ not-json", "utf8");
    const store = createRegistryStore(filePath);

    try {
      const snapshot = store.loadSync();
      expect(snapshot.languages.map((language) => language.id)).toEqual(["en", "none"]);
      const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(persisted.version).toBe(REGISTRY_SCHEMA_VERSION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
