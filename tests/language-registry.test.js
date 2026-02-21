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

  test("normalizeRegistryPayload rejects unsafe dictionary paths", () => {
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
          dictionaryFile: "../escape.txt"
        },
        {
          id: "none",
          label: "No dictionary",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: false,
          dictionaryFile: null
        }
      ]
    };

    const normalized = normalizeRegistryPayload(payload, {
      bakedLanguages: BAKED_LANGUAGES,
      getMinLengthForLang: () => 3
    });
    expect(normalized).toBeNull();
  });

  test("normalizeRegistryPayload rejects provider languages without valid provider metadata", () => {
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
          id: "none",
          label: "No dictionary",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: false,
          dictionaryFile: null
        },
        {
          id: "en-US",
          label: "English (US)",
          enabled: true,
          source: "provider",
          minLength: 3,
          hasDictionary: true,
          dictionaryFile: "providers/en-US/expanded-forms.txt",
          provider: {
            providerId: "",
            variant: "en-us"
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

  test("normalizeRegistryPayload requires all baked defaults to remain present", () => {
    const payload = {
      version: REGISTRY_SCHEMA_VERSION,
      updatedAt: "2026-02-20T00:00:00.000Z",
      languages: [
        {
          id: "none",
          label: "No dictionary",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: false,
          dictionaryFile: null
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
          id: "en",
          label: "English",
          enabled: "true",
          source: "baked",
          minLength: 3,
          hasDictionary: 1,
          dictionaryFile: "en.txt"
        },
        {
          id: "none",
          label: "No dictionary",
          enabled: true,
          source: "baked",
          minLength: 3,
          hasDictionary: false,
          dictionaryFile: null
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

  test("loadSync recovery creates missing parent directories", () => {
    const dir = createTempDir();
    const nestedPath = path.join(dir, "nested", "registry", "languages.json");
    const store = createRegistryStore(nestedPath);

    try {
      const snapshot = store.loadSync();
      expect(snapshot.version).toBe(REGISTRY_SCHEMA_VERSION);
      expect(fs.existsSync(nestedPath)).toBe(true);
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

  test("loadSync recovery handles rename-overwrite filesystem errors", () => {
    const dir = createTempDir();
    const filePath = path.join(dir, "languages.json");
    fs.writeFileSync(filePath, "{ bad-json", "utf8");
    const store = createRegistryStore(filePath);
    const originalRenameSync = fs.renameSync;
    let renameSpy = null;

    try {
      let shouldFailOnce = true;
      renameSpy = jest.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        if (shouldFailOnce && newPath === filePath) {
          shouldFailOnce = false;
          const err = new Error("rename blocked");
          err.code = "EPERM";
          throw err;
        }
        return originalRenameSync(oldPath, newPath);
      });

      const snapshot = store.loadSync();
      expect(snapshot.languages.map((language) => language.id)).toEqual(["en", "none"]);
      expect(renameSpy).toHaveBeenCalled();
    } finally {
      if (renameSpy) {
        renameSpy.mockRestore();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
