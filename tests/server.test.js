const fs = require("fs");
const path = require("path");
const request = require("supertest");

const DATA_PATH = path.join(__dirname, "..", "data", "word.json");
const DICT_PATH = path.join(__dirname, "..", "data", "dictionaries");
const EN_DEFINITIONS_PATH = path.join(DICT_PATH, "en-definitions.json");
const EN_DEFINITIONS_INDEX_DIR = path.join(DICT_PATH, "en-definitions-index");
const ORIGINAL_WORD_DATA = fs.readFileSync(DATA_PATH, "utf8");
const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  Object.keys(process.env).forEach((key) => {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  });
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

function loadApp(options = {}) {
  const opts =
    typeof options === "string"
      ? { adminKey: options }
      : {
          adminKey: options.adminKey || "",
          nodeEnv: options.nodeEnv,
          requireAdminKey: options.requireAdminKey,
          trustProxy: options.trustProxy,
          rateLimitMax: options.rateLimitMax,
          rateLimitWindowMs: options.rateLimitWindowMs,
          lowMemoryDefinitions: options.lowMemoryDefinitions,
          definitionsMode: options.definitionsMode,
          perfLogging: options.perfLogging
        };

  jest.resetModules();
  resetEnv();

  if (opts.adminKey) {
    process.env.ADMIN_KEY = opts.adminKey;
  } else {
    delete process.env.ADMIN_KEY;
  }
  if (opts.nodeEnv) {
    process.env.NODE_ENV = opts.nodeEnv;
  }
  if (opts.requireAdminKey !== undefined) {
    process.env.REQUIRE_ADMIN_KEY = opts.requireAdminKey ? "true" : "false";
  }
  if (opts.trustProxy !== undefined) {
    process.env.TRUST_PROXY = opts.trustProxy ? "true" : "false";
  }
  if (opts.rateLimitMax !== undefined) {
    process.env.RATE_LIMIT_MAX = String(opts.rateLimitMax);
  }
  if (opts.rateLimitWindowMs !== undefined) {
    process.env.RATE_LIMIT_WINDOW_MS = String(opts.rateLimitWindowMs);
  }
  if (opts.lowMemoryDefinitions !== undefined) {
    process.env.LOW_MEMORY_DEFINITIONS = opts.lowMemoryDefinitions ? "true" : "false";
  }
  if (opts.definitionsMode !== undefined) {
    process.env.DEFINITIONS_MODE = opts.definitionsMode;
  }
  if (opts.perfLogging !== undefined) {
    process.env.PERF_LOGGING = opts.perfLogging ? "true" : "false";
  }

  return require("../server");
}

afterEach(() => {
  resetEnv();
});

function writeWordData(data) {
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function withTempDictionary(file, contents, fn) {
  const fullPath = path.join(DICT_PATH, file);
  const original = fs.readFileSync(fullPath, "utf8");
  fs.writeFileSync(fullPath, contents, "utf8");
  try {
    return await fn();
  } finally {
    fs.writeFileSync(fullPath, original, "utf8");
  }
}

async function withMissingDictionary(file, fn) {
  const fullPath = path.join(DICT_PATH, file);
  const backupPath = `${fullPath}.bak`;
  fs.renameSync(fullPath, backupPath);
  try {
    return await fn();
  } finally {
    fs.renameSync(backupPath, fullPath);
  }
}

async function withTempDefinitions(payload, fn) {
  const original = fs.readFileSync(EN_DEFINITIONS_PATH, "utf8");
  fs.writeFileSync(EN_DEFINITIONS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    return await fn();
  } finally {
    fs.writeFileSync(EN_DEFINITIONS_PATH, original, "utf8");
  }
}

async function withTempDefinitionsContent(content, fn) {
  const original = fs.readFileSync(EN_DEFINITIONS_PATH, "utf8");
  fs.writeFileSync(EN_DEFINITIONS_PATH, content, "utf8");
  try {
    return await fn();
  } finally {
    fs.writeFileSync(EN_DEFINITIONS_PATH, original, "utf8");
  }
}

function buildIndexPayload(definitions) {
  const shards = {};
  const entries = Object.entries(definitions).sort((a, b) => a[0].localeCompare(b[0]));
  entries.forEach(([word, definition]) => {
    const shardId = word[0];
    if (!shards[shardId]) {
      shards[shardId] = {};
    }
    shards[shardId][word] = definition;
  });
  return {
    manifest: {
      version: 1,
      generatedAt: "2026-02-20T00:00:00.000Z",
      source: "test-index",
      totalWords: entries.length,
      coveredWords: entries.length,
      coveragePercent: 100,
      shards: Object.fromEntries(
        Object.entries(shards).map(([shardId, values]) => [
          shardId,
          { file: `${shardId}.json`, count: Object.keys(values).length }
        ])
      )
    },
    shards
  };
}

async function withTempDefinitionIndex(definitions, fn) {
  const backupPath = `${EN_DEFINITIONS_INDEX_DIR}.bak-test`;
  const hadOriginal = fs.existsSync(EN_DEFINITIONS_INDEX_DIR);
  if (fs.existsSync(backupPath)) {
    fs.rmSync(backupPath, { recursive: true, force: true });
  }
  if (hadOriginal) {
    fs.renameSync(EN_DEFINITIONS_INDEX_DIR, backupPath);
  }

  fs.mkdirSync(EN_DEFINITIONS_INDEX_DIR, { recursive: true });
  const payload = buildIndexPayload(definitions);
  fs.writeFileSync(
    path.join(EN_DEFINITIONS_INDEX_DIR, "manifest.json"),
    `${JSON.stringify(payload.manifest, null, 2)}\n`,
    "utf8"
  );
  Object.entries(payload.shards).forEach(([shardId, values]) => {
    fs.writeFileSync(
      path.join(EN_DEFINITIONS_INDEX_DIR, `${shardId}.json`),
      `${JSON.stringify(values)}\n`,
      "utf8"
    );
  });

  try {
    return await fn();
  } finally {
    fs.rmSync(EN_DEFINITIONS_INDEX_DIR, { recursive: true, force: true });
    if (hadOriginal) {
      fs.renameSync(backupPath, EN_DEFINITIONS_INDEX_DIR);
    }
    if (fs.existsSync(backupPath)) {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
  }
}

describe("Wordle API", () => {
  test("encodes word using WORDLE cipher", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "JACKS", lang: "none" });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe("FOTND");
    expect(response.body.length).toBe(5);
  });

  test("health endpoint returns ok", async () => {
    const app = loadApp();
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test("rate limiting blocks excessive requests", async () => {
    const app = loadApp({ rateLimitMax: 2, rateLimitWindowMs: 60 * 1000 });
    const first = await request(app).get("/api/health");
    const second = await request(app).get("/api/health");
    const third = await request(app).get("/api/health");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  test("trust proxy can be enabled", async () => {
    const app = loadApp({ trustProxy: true });
    expect(app.get("trust proxy")).toBe(1);
  });

  test("rejects invalid word", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "AB12", lang: "none" });

    expect(response.status).toBe(400);
  });

  test("rejects dictionary word that is not in the list", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "QZXWQ", lang: "en" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/dictionary/i);
  });

  test("returns puzzle metadata", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/puzzle")
      .send({ code: "FOTND", lang: "none", guesses: 7 });

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(5);
    expect(response.body.maxGuesses).toBe(7);
  });

  test("rejects puzzle requests with invalid guesses or code", async () => {
    const app = loadApp();
    const invalidGuess = await request(app)
      .post("/api/puzzle")
      .send({ code: "FOTND", lang: "none", guesses: 2 });
    expect(invalidGuess.status).toBe(400);

    const invalidCode = await request(app)
      .post("/api/puzzle")
      .send({ code: "F0TND", lang: "none", guesses: 6 });
    expect(invalidCode.status).toBe(400);

    const invalidLen = await request(app)
      .post("/api/puzzle")
      .send({ code: "FO", lang: "en", guesses: 6 });
    expect(invalidLen.status).toBe(400);

    const invalidLang = await request(app)
      .post("/api/puzzle")
      .send({ code: "FOTND", lang: "xx", guesses: 6 });
    expect(invalidLang.status).toBe(400);
  });

  test("evaluates guess correctly", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "CRANE", lang: "none" });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.isCorrect).toBe(true);
    expect(guessResponse.body.result).toEqual([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct"
    ]);
  });

  test("evaluates present letters correctly", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "REACT", lang: "none" });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.result).toEqual([
      "present",
      "present",
      "correct",
      "present",
      "absent"
    ]);
  });

  test("returns answer when reveal is true and guess is incorrect", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "SLATE", lang: "none", reveal: true });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.isCorrect).toBe(false);
    expect(guessResponse.body.answer).toBe("CRANE");
    expect(guessResponse.body.answerMeaning).toBeUndefined();
  });

  test("returns local answer meaning when reveal is true for english puzzles", async () => {
    await withTempDefinitions(
      {
        generatedAt: "2026-02-17T00:00:00.000Z",
        source: "test",
        totalWords: 1,
        coveredWords: 1,
        coveragePercent: 100,
        definitions: {
          CRANE: "a large long-necked wading bird"
        }
      },
      async () => {
        const app = loadApp();
        const encodeResponse = await request(app)
          .post("/api/encode")
          .send({ word: "CRANE", lang: "en" });

        const code = encodeResponse.body.code;
        const guessResponse = await request(app)
          .post("/api/guess")
          .send({ code, guess: "SLATE", lang: "en", reveal: true });

        expect(guessResponse.status).toBe(200);
        expect(guessResponse.body.isCorrect).toBe(false);
        expect(guessResponse.body.answer).toBe("CRANE");
        expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
      }
    );
  });

  test("returns local answer meaning when english puzzle is solved", async () => {
    await withTempDefinitions(
      {
        generatedAt: "2026-02-17T00:00:00.000Z",
        source: "test",
        totalWords: 1,
        coveredWords: 1,
        coveragePercent: 100,
        definitions: {
          CRANE: "a large long-necked wading bird"
        }
      },
      async () => {
        const app = loadApp();
        const encodeResponse = await request(app)
          .post("/api/encode")
          .send({ word: "CRANE", lang: "en" });

        const code = encodeResponse.body.code;
        const guessResponse = await request(app)
          .post("/api/guess")
          .send({ code, guess: "CRANE", lang: "en", reveal: false });

        expect(guessResponse.status).toBe(200);
        expect(guessResponse.body.isCorrect).toBe(true);
        expect(guessResponse.body.answer).toBeUndefined();
        expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
      }
    );
  });

  test("returns local answer meaning in low-memory definitions mode", async () => {
    await withTempDefinitions(
      {
        generatedAt: "2026-02-17T00:00:00.000Z",
        source: "test",
        totalWords: 1,
        coveredWords: 1,
        coveragePercent: 100,
        definitions: {
          CRANE: "a large long-necked wading bird"
        }
      },
      async () => {
        const app = loadApp({ lowMemoryDefinitions: true });
        const encodeResponse = await request(app)
          .post("/api/encode")
          .send({ word: "CRANE", lang: "en" });

        const code = encodeResponse.body.code;
        const guessResponse = await request(app)
          .post("/api/guess")
          .send({ code, guess: "CRANE", lang: "en", reveal: false });

        expect(guessResponse.status).toBe(200);
        expect(guessResponse.body.isCorrect).toBe(true);
        expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
      }
    );
  });

  test("returns local answer meaning in lazy definitions mode", async () => {
    await withTempDefinitions(
      {
        generatedAt: "2026-02-17T00:00:00.000Z",
        source: "test",
        totalWords: 1,
        coveredWords: 1,
        coveragePercent: 100,
        definitions: {
          CRANE: "a large long-necked wading bird"
        }
      },
      async () => {
        const app = loadApp({ definitionsMode: "lazy" });
        const encodeResponse = await request(app)
          .post("/api/encode")
          .send({ word: "CRANE", lang: "en" });

        const code = encodeResponse.body.code;
        const guessResponse = await request(app)
          .post("/api/guess")
          .send({ code, guess: "CRANE", lang: "en", reveal: false });

        expect(guessResponse.status).toBe(200);
        expect(guessResponse.body.isCorrect).toBe(true);
        expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
      }
    );
  });

  test("returns local answer meaning in indexed definitions mode", async () => {
    await withTempDefinitionIndex(
      {
        CRANE: "a large long-necked wading bird"
      },
      async () => {
        await withTempDefinitionsContent("{\"definitions\":{}}\n", async () => {
          const app = loadApp({ definitionsMode: "indexed" });
          const encodeResponse = await request(app)
            .post("/api/encode")
            .send({ word: "CRANE", lang: "en" });

          const code = encodeResponse.body.code;
          const guessResponse = await request(app)
            .post("/api/guess")
            .send({ code, guess: "CRANE", lang: "en", reveal: false });

          expect(guessResponse.status).toBe(200);
          expect(guessResponse.body.isCorrect).toBe(true);
          expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
        });
      }
    );
  });

  test("falls back to lazy map loading when indexed artifacts are unavailable", async () => {
    await withTempDefinitions(
      {
        generatedAt: "2026-02-17T00:00:00.000Z",
        source: "test",
        totalWords: 1,
        coveredWords: 1,
        coveragePercent: 100,
        definitions: {
          CRANE: "a large long-necked wading bird"
        }
      },
      async () => {
        const app = loadApp({ definitionsMode: "indexed" });
        const encodeResponse = await request(app)
          .post("/api/encode")
          .send({ word: "CRANE", lang: "en" });

        const code = encodeResponse.body.code;
        const guessResponse = await request(app)
          .post("/api/guess")
          .send({ code, guess: "CRANE", lang: "en", reveal: false });

        expect(guessResponse.status).toBe(200);
        expect(guessResponse.body.isCorrect).toBe(true);
        expect(guessResponse.body.answerMeaning).toBe("a large long-necked wading bird");
      }
    );
  });

  test("rejects invalid guesses and dictionary misses", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "en" });

    const code = encodeResponse.body.code;
    const invalidCode = await request(app)
      .post("/api/guess")
      .send({ code: "F0TND", guess: "CRANE", lang: "en" });
    expect(invalidCode.status).toBe(400);

    const invalidLang = await request(app)
      .post("/api/guess")
      .send({ code, guess: "CRANE", lang: "xx" });
    expect(invalidLang.status).toBe(400);

    const invalidGuess = await request(app)
      .post("/api/guess")
      .send({ code, guess: "CR4NE", lang: "en" });
    expect(invalidGuess.status).toBe(400);

    const wrongLength = await request(app)
      .post("/api/guess")
      .send({ code, guess: "CRAN", lang: "en" });
    expect(wrongLength.status).toBe(400);

    const notInDict = await request(app)
      .post("/api/guess")
      .send({ code, guess: "QZXWQ", lang: "en" });
    expect(notInDict.status).toBe(400);
  });

  test("random returns a word for supported language", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/random")
      .send({ lang: "en", length: 5 });

    expect(response.status).toBe(200);
    expect(response.body.word.length).toBe(5);
    expect(response.body.code.length).toBe(5);
  });

  test("random rejects invalid length or language", async () => {
    const app = loadApp();
    const invalidLen = await request(app)
      .post("/api/random")
      .send({ lang: "en", length: 2 });
    expect(invalidLen.status).toBe(400);

    const unknownLang = await request(app)
      .post("/api/random")
      .send({ lang: "xx", length: 5 });
    expect(unknownLang.status).toBe(400);

    const noDict = await request(app)
      .post("/api/random")
      .send({ lang: "none", length: 5 });
    expect(noDict.status).toBe(400);
  });

  test("random handles no words available for requested length", async () => {
    await withTempDictionary("en.txt", "APPLE\n", async () => {
      const app = loadApp();
      const response = await request(app)
        .post("/api/random")
        .send({ lang: "en", length: 6 });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/No words available/);
    });
  });

  test("rejects unknown language", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "xx" });

    expect(response.status).toBe(400);
  });

  test("meta omits languages with missing or empty dictionaries", async () => {
    await withMissingDictionary("en.txt", async () => {
      const app = loadApp();
      const response = await request(app).get("/api/meta");
      expect(response.status).toBe(200);
      const ids = response.body.languages.map((lang) => lang.id);
      expect(ids).not.toContain("en");
      expect(ids).toContain("none");
    });

    await withTempDictionary("en.txt", "", async () => {
      const app = loadApp();
      const response = await request(app).get("/api/meta");
      expect(response.status).toBe(200);
      const ids = response.body.languages.map((lang) => lang.id);
      expect(ids).not.toContain("en");
    });
  });

  test("meta includes performance and definition mode fields", async () => {
    const app = loadApp({ perfLogging: true, definitionsMode: "lazy" });
    const response = await request(app).get("/api/meta");
    expect(response.status).toBe(200);
    expect(response.body.perfLogging).toBe(true);
    expect(response.body.definitionsMode).toBe("lazy");
  });

  test("legacy low-memory toggle maps to indexed definition mode", async () => {
    const app = loadApp({ lowMemoryDefinitions: true });
    const response = await request(app).get("/api/meta");
    expect(response.status).toBe(200);
    expect(response.body.definitionsMode).toBe("indexed");
  });

  test("returns null when default language is unavailable and no fallback exists", async () => {
    const app = loadApp();
    const original = new Map(app.locals.availableLanguages);
    app.locals.availableLanguages.clear();
    try {
      const response = await request(app)
        .post("/api/encode")
        .send({ word: "CRANE", lang: "en" });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Unknown language/i);
    } finally {
      app.locals.availableLanguages.clear();
      original.forEach((value, key) => app.locals.availableLanguages.set(key, value));
    }
  });

  test("falls back to no-dictionary language when default language is missing", async () => {
    await withMissingDictionary("en.txt", async () => {
      const app = loadApp();
      const response = await request(app)
        .post("/api/encode")
        .send({ word: "CRANE", lang: "en" });
      expect(response.status).toBe(200);
      expect(response.body.lang).toBe("none");
    });
  });

  test("enforces minimum length", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "TO", lang: "en" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/3-12/);
  });

  test("serves index with no-store cache headers", async () => {
    const app = loadApp();
    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
  });

  test("serves static assets with cache headers in production", async () => {
    const app = loadApp({ nodeEnv: "production" });
    const response = await request(app).get("/styles.css");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/max-age=3600/);
  });
});

describe("Admin auth", () => {
  test("requires admin key when configured", async () => {
    const app = loadApp("secret");
    const response = await request(app).get("/api/word");
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/Admin key/i);
  });

  test("requires admin key in production when missing", async () => {
    const app = loadApp({ nodeEnv: "production" });
    const response = await request(app).get("/api/word");
    expect(response.status).toBe(401);
  });

  test("allows admin update without key when not configured", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/word")
      .send({ word: "CRANE", lang: "en", date: null });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test("rejects admin update when key is missing", async () => {
    const app = loadApp("secret");
    const response = await request(app)
      .post("/api/word")
      .send({ word: "CRANE", lang: "en", date: null });
    expect(response.status).toBe(401);
  });

  test("rejects admin update with unknown language", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/word")
      .send({ word: "CRANE", lang: "xx", date: null });
    expect(response.status).toBe(400);
  });

  test("rejects admin update with invalid word", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/word")
      .send({ word: "CR4NE", lang: "en", date: null });
    expect(response.status).toBe(400);
  });

  test("returns current admin word data", async () => {
    writeWordData({ word: "CRANE", lang: "en", date: null, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/api/word");
    expect(response.status).toBe(200);
    expect(response.body.word).toBe("CRANE");
  });
});

describe("Daily word data recovery and daily route", () => {
  afterEach(() => {
    fs.writeFileSync(DATA_PATH, ORIGINAL_WORD_DATA, "utf8");
  });

  test("recovers invalid word.json on startup", async () => {
    fs.writeFileSync(DATA_PATH, "{not valid json", "utf8");
    loadApp();
    const repaired = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    expect(repaired).toHaveProperty("word");
    expect(repaired).toHaveProperty("lang");
  });

  test("returns friendly 404 when no daily word is configured", async () => {
    writeWordData({ word: "", lang: "en", date: null, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(404);
    expect(response.text).toMatch(/No daily puzzle/i);
  });

  test("returns friendly 404 when date does not match today", async () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const date = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(
      yesterday.getDate()
    ).padStart(2, "0")}`;
    writeWordData({ word: "CRANE", lang: "en", date, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(404);
    expect(response.text).toMatch(/Today's puzzle isn't set yet/i);
  });

  test("returns friendly 404 for invalid stored word", async () => {
    writeWordData({ word: "CR4NE", lang: "en", date: null, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(404);
    expect(response.text).toMatch(/No daily puzzle/i);
  });

  test("redirects when daily word is valid and date matches", async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
    writeWordData({ word: "TIGER", lang: "none", date, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(302);
    expect(response.headers.location).toMatch(/word=/);
    expect(response.headers.location).toMatch(/lang=none/);
    expect(response.headers.location).toMatch(/daily=1/);
    expect(response.headers.location).toMatch(/day=\d{4}-\d{2}-\d{2}/);
  });

  test("redirects using default language when stored lang is unknown", async () => {
    writeWordData({ word: "CRANE", lang: "xx", date: null, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(302);
    expect(response.headers.location.startsWith("/?word=")).toBe(true);
    expect(response.headers.location).not.toMatch(/lang=/);
    expect(response.headers.location).toMatch(/daily=1/);
  });
});

describe("Server startup", () => {
  test("logs admin warning when admin key is optional", () => {
    const app = loadApp({ requireAdminKey: false });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const listener = jest.fn((port, host, cb) => {
      cb();
      return { close: jest.fn() };
    });

    app.startServer(listener);

    expect(listener).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("local-hosted-wordle server running at http://localhost:")
    );
    expect(logSpy).toHaveBeenCalledWith(
      "Admin mode is open. Set ADMIN_KEY to protect /admin updates."
    );
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("warns when admin key is required but missing", () => {
    const app = loadApp({ requireAdminKey: true });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const listener = jest.fn((port, host, cb) => {
      cb();
      return { close: jest.fn() };
    });

    app.startServer(listener);

    expect(listener).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "ADMIN_KEY is required for admin endpoints in production."
    );

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
