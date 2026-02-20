const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const DATA_PATH = path.join(__dirname, "..", "data", "word.json");
const LANGUAGE_REGISTRY_PATH = path.join(__dirname, "..", "data", "languages.json");
const DICT_PATH = path.join(__dirname, "..", "data", "dictionaries");
const EN_DEFINITIONS_PATH = path.join(DICT_PATH, "en-definitions.json");
const EN_DEFINITIONS_INDEX_DIR = path.join(DICT_PATH, "en-definitions-index");
const EN_DEFINITIONS_INDEX_MANIFEST_PATH = path.join(
  EN_DEFINITIONS_INDEX_DIR,
  "manifest.json"
);
const ORIGINAL_WORD_DATA = fs.readFileSync(DATA_PATH, "utf8");
const ORIGINAL_LANGUAGE_REGISTRY = fs.readFileSync(LANGUAGE_REGISTRY_PATH, "utf8");
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
          trustProxyHops: options.trustProxyHops,
          rateLimitMax: options.rateLimitMax,
          rateLimitWindowMs: options.rateLimitWindowMs,
          lowMemoryDefinitions: options.lowMemoryDefinitions,
          definitionsMode: options.definitionsMode,
          perfLogging: options.perfLogging,
          statsStorePath: options.statsStorePath
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
  if (opts.trustProxyHops !== undefined) {
    process.env.TRUST_PROXY_HOPS = String(opts.trustProxyHops);
  } else {
    delete process.env.TRUST_PROXY_HOPS;
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
  if (opts.statsStorePath !== undefined) {
    process.env.STATS_STORE_PATH = opts.statsStorePath;
  } else {
    delete process.env.STATS_STORE_PATH;
  }

  return require("../server");
}

afterEach(() => {
  resetEnv();
});

function writeWordData(data) {
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeLanguageRegistry(data) {
  fs.writeFileSync(LANGUAGE_REGISTRY_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function createTempStatsStore(initialState = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lhw-stats-"));
  const filePath = path.join(dir, "leaderboard.json");
  const payload = initialState || {
    version: 1,
    updatedAt: "1970-01-01T00:00:00.000Z",
    profiles: [],
    resultsByProfile: {}
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function formatUtcDate(offsetDays) {
  const base = Date.UTC(2024, 0, 1);
  const date = new Date(base + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function formatLocalDateFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalDateOffset(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return formatLocalDateFromDate(date);
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

async function withTempLanguageRegistryContent(content, fn) {
  const original = fs.readFileSync(LANGUAGE_REGISTRY_PATH, "utf8");
  fs.writeFileSync(LANGUAGE_REGISTRY_PATH, content, "utf8");
  try {
    return await fn();
  } finally {
    fs.writeFileSync(LANGUAGE_REGISTRY_PATH, original, "utf8");
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

async function withTempDefinitionIndexManifest(definitions, mutateManifest, fn) {
  return withTempDefinitionIndex(definitions, async () => {
    const manifest = JSON.parse(fs.readFileSync(EN_DEFINITIONS_INDEX_MANIFEST_PATH, "utf8"));
    mutateManifest(manifest);
    fs.writeFileSync(
      EN_DEFINITIONS_INDEX_MANIFEST_PATH,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    return fn();
  });
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

  test("trust proxy hop count can be configured", async () => {
    const app = loadApp({ trustProxy: true, trustProxyHops: 2 });
    expect(app.get("trust proxy")).toBe(2);
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

  test("handles duplicate letters when guess repeats more than answer", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "APPLE", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "PUPPY", lang: "none" });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.result).toEqual([
      "present",
      "absent",
      "correct",
      "absent",
      "absent"
    ]);
  });

  test("handles duplicate letters when answer repeats more than guess", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "BEEFY", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "ELATE", lang: "none" });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.result).toEqual([
      "present",
      "absent",
      "absent",
      "absent",
      "present"
    ]);
  });

  test("handles mixed duplicate outcomes with correct and present statuses", async () => {
    const app = loadApp();
    const encodeResponse = await request(app)
      .post("/api/encode")
      .send({ word: "LEVEL", lang: "none" });

    const code = encodeResponse.body.code;
    const guessResponse = await request(app)
      .post("/api/guess")
      .send({ code, guess: "LEECH", lang: "none" });

    expect(guessResponse.status).toBe(200);
    expect(guessResponse.body.result).toEqual([
      "correct",
      "correct",
      "present",
      "absent",
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

  test("falls back to lazy map loading when indexed shard metadata is null", async () => {
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
        await withTempDefinitionIndexManifest(
          {
            CRANE: "a large long-necked wading bird"
          },
          (manifest) => {
            manifest.shards.C = null;
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
      }
    );
  });

  test("falls back to lazy map loading when indexed shard file metadata is invalid", async () => {
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
        await withTempDefinitionIndexManifest(
          {
            CRANE: "a large long-necked wading bird"
          },
          (manifest) => {
            manifest.shards.C = { file: "" };
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
      }
    );
  });

  test("falls back to lazy map loading when indexed shard metadata is missing", async () => {
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
        await withTempDefinitionIndexManifest(
          {
            CRANE: "a large long-necked wading bird"
          },
          (manifest) => {
            delete manifest.shards.C;
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

  test("protects /api/admin provider scaffold when key is configured", async () => {
    const app = loadApp("secret");
    const unauthorized = await request(app).get("/api/admin/providers");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.error).toBe("Admin key required.");

    const authorized = await request(app)
      .get("/api/admin/providers")
      .set("x-admin-key", "secret");
    expect(authorized.status).toBe(501);
    expect(authorized.body.error).toBe("Provider admin endpoints are not implemented yet.");
  });

  test("keeps /api/admin provider scaffold open only when admin key is optional", async () => {
    const optionalAdmin = loadApp({ requireAdminKey: false });
    const optionalResponse = await request(optionalAdmin).get("/api/admin/providers");
    expect(optionalResponse.status).toBe(501);

    const requiredAdmin = loadApp({ nodeEnv: "production" });
    const requiredResponse = await request(requiredAdmin).get("/api/admin/providers");
    expect(requiredResponse.status).toBe(401);
    expect(requiredResponse.body.error).toBe("Admin key required.");
  });
});

describe("Stats API", () => {
  test("creates a new profile and reuses it for case-insensitive name matches", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });

      const first = await request(app).post("/api/stats/profile").send({ name: "Ava" });
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(first.body.reused).toBe(false);
      expect(typeof first.body.playerId).toBe("string");
      expect(first.body.profile.name).toBe("Ava");

      const second = await request(app).post("/api/stats/profile").send({ name: "  ava  " });
      expect(second.status).toBe(200);
      expect(second.body.ok).toBe(true);
      expect(second.body.reused).toBe(true);
      expect(second.body.playerId).toBe(first.body.playerId);
    } finally {
      tempStore.cleanup();
    }
  });

  test("upserts daily results and applies replay merge policy", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const profileResponse = await request(app).post("/api/stats/profile").send({ name: "Ben" });
      const profileId = profileResponse.body.playerId;
      const dailyKey = "2024-01-15|en|abcde";

      const first = await request(app).post("/api/stats/result").send({
        profileId,
        dailyKey,
        won: false,
        attempts: null,
        maxGuesses: 6
      });
      expect(first.status).toBe(200);
      expect(first.body.retained).toBe(true);
      expect(first.body.result.won).toBe(false);
      expect(first.body.result.attempts).toBeNull();
      expect(first.body.result.submissionCount).toBe(1);

      const second = await request(app).post("/api/stats/result").send({
        profileId,
        dailyKey,
        won: true,
        attempts: 4,
        maxGuesses: 6
      });
      expect(second.status).toBe(200);
      expect(second.body.retained).toBe(true);
      expect(second.body.result.won).toBe(true);
      expect(second.body.result.attempts).toBe(4);
      expect(second.body.result.submissionCount).toBe(2);

      const third = await request(app).post("/api/stats/result").send({
        profileId,
        dailyKey,
        won: true,
        attempts: 5,
        maxGuesses: 6
      });
      expect(third.status).toBe(200);
      expect(third.body.retained).toBe(true);
      expect(third.body.result.won).toBe(true);
      expect(third.body.result.attempts).toBe(4);
      expect(third.body.result.submissionCount).toBe(3);

      const profileSummary = await request(app).get(`/api/stats/profile/${profileId}`);
      expect(profileSummary.status).toBe(200);
      expect(profileSummary.body.summary.overall.played).toBe(1);
      expect(profileSummary.body.summary.overall.wins).toBe(1);
      expect(profileSummary.body.summary.totalSubmissions).toBe(3);

      const leaderboard = await request(app).get("/api/stats/leaderboard?range=overall");
      expect(leaderboard.status).toBe(200);
      expect(leaderboard.body.rows).toHaveLength(1);
      expect(leaderboard.body.rows[0].profileId).toBe(profileId);
      expect(leaderboard.body.rows[0].wins).toBe(1);
      expect(leaderboard.body.rows[0].played).toBe(1);
    } finally {
      tempStore.cleanup();
    }
  });

  test("computes leaderboard windows and streak from server-local dates", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const profileResponse = await request(app).post("/api/stats/profile").send({ name: "Casey" });
      const profileId = profileResponse.body.playerId;

      const today = formatLocalDateOffset(0);
      const yesterday = formatLocalDateOffset(-1);
      const twoDaysAgo = formatLocalDateOffset(-2);
      const oldDay = formatLocalDateOffset(-40);

      const entries = [
        { date: today, key: `${today}|none|aaaaa`, won: true, attempts: 3 },
        { date: yesterday, key: `${yesterday}|none|bbbbb`, won: true, attempts: 2 },
        { date: twoDaysAgo, key: `${twoDaysAgo}|none|ccccc`, won: false, attempts: null },
        { date: oldDay, key: `${oldDay}|none|ddddd`, won: true, attempts: 1 }
      ];

      for (const entry of entries) {
        const response = await request(app).post("/api/stats/result").send({
          profileId,
          dailyKey: entry.key,
          won: entry.won,
          attempts: entry.attempts,
          maxGuesses: 6
        });
        expect(response.status).toBe(200);
      }

      const currentMonthKey = today.slice(0, 7);
      const expectedMonthlyPlayed = entries.filter((entry) => entry.date.slice(0, 7) === currentMonthKey).length;
      const expectedMonthlyWins = entries.filter(
        (entry) => entry.date.slice(0, 7) === currentMonthKey && entry.won
      ).length;

      const profileSummary = await request(app).get(`/api/stats/profile/${profileId}`);
      expect(profileSummary.status).toBe(200);
      expect(profileSummary.body.summary.overall.played).toBe(4);
      expect(profileSummary.body.summary.overall.wins).toBe(3);
      expect(profileSummary.body.summary.overall.bestAttempts).toBe(1);
      expect(profileSummary.body.summary.weekly.played).toBe(3);
      expect(profileSummary.body.summary.weekly.wins).toBe(2);
      expect(profileSummary.body.summary.weekly.bestAttempts).toBe(2);
      expect(profileSummary.body.summary.monthly.played).toBe(expectedMonthlyPlayed);
      expect(profileSummary.body.summary.monthly.wins).toBe(expectedMonthlyWins);
      expect(profileSummary.body.summary.streak).toBe(2);

      const weekly = await request(app).get("/api/stats/leaderboard?range=weekly");
      expect(weekly.status).toBe(200);
      expect(weekly.body.rows).toHaveLength(1);
      expect(weekly.body.rows[0].played).toBe(3);
      expect(weekly.body.rows[0].wins).toBe(2);
      expect(weekly.body.rows[0].streak).toBe(2);

      const monthly = await request(app).get("/api/stats/leaderboard?range=monthly");
      expect(monthly.status).toBe(200);
      expect(monthly.body.rows).toHaveLength(1);
      expect(monthly.body.rows[0].played).toBe(expectedMonthlyPlayed);
      expect(monthly.body.rows[0].wins).toBe(expectedMonthlyWins);

      const overall = await request(app).get("/api/stats/leaderboard?range=overall");
      expect(overall.status).toBe(200);
      expect(overall.body.rows).toHaveLength(1);
      expect(overall.body.rows[0].played).toBe(4);
      expect(overall.body.rows[0].wins).toBe(3);
      expect(overall.body.rows[0].bestAttempts).toBe(1);
      expect(overall.body.rows[0].streak).toBe(2);
    } finally {
      tempStore.cleanup();
    }
  });

  test("sorts leaderboard rows with deterministic tie-breakers", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const today = formatLocalDateOffset(0);
      const oneDayAgo = formatLocalDateOffset(-1);
      const twoDaysAgo = formatLocalDateOffset(-2);
      const threeDaysAgo = formatLocalDateOffset(-3);

      async function createPlayer(name) {
        const response = await request(app).post("/api/stats/profile").send({ name });
        return response.body.playerId;
      }

      async function submit(profileId, date, code, won, attempts) {
        const response = await request(app).post("/api/stats/result").send({
          profileId,
          dailyKey: `${date}|none|${code}`,
          won,
          attempts,
          maxGuesses: 6
        });
        expect(response.status).toBe(200);
      }

      const playerAva = await createPlayer("Ava");
      const playerBen = await createPlayer("Ben");
      const playerCara = await createPlayer("Cara");
      const playerZoe = await createPlayer("Zoe");

      await submit(playerAva, today, "av001", true, 2);
      await submit(playerAva, oneDayAgo, "av002", true, 3);
      await submit(playerAva, twoDaysAgo, "av003", true, 4);

      await submit(playerBen, today, "be001", true, 3);
      await submit(playerBen, oneDayAgo, "be002", true, 4);
      await submit(playerBen, twoDaysAgo, "be003", true, 5);

      await submit(playerCara, today, "ca001", true, 1);
      await submit(playerCara, oneDayAgo, "ca002", true, 2);
      await submit(playerCara, twoDaysAgo, "ca003", true, 3);
      await submit(playerCara, threeDaysAgo, "ca004", false, null);

      await submit(playerZoe, today, "zo001", true, 1);
      await submit(playerZoe, oneDayAgo, "zo002", true, 2);

      const leaderboard = await request(app).get("/api/stats/leaderboard?range=overall");
      expect(leaderboard.status).toBe(200);
      expect(leaderboard.body.rows).toHaveLength(4);
      expect(leaderboard.body.rows.map((row) => row.name)).toEqual(["Ava", "Ben", "Cara", "Zoe"]);
      expect(leaderboard.body.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
    } finally {
      tempStore.cleanup();
    }
  });

  test("returns retained=false when result is pruned by per-profile retention cap", async () => {
    const profileId = "player-casey";
    const nowIso = new Date().toISOString();
    const existingResults = Object.create(null);
    for (let i = 0; i < 400; i += 1) {
      const date = formatUtcDate(i);
      const dailyKey = `${date}|en|seed${String(i).padStart(3, "0")}`;
      existingResults[dailyKey] = {
        date,
        won: i % 2 === 0,
        attempts: i % 2 === 0 ? 3 : null,
        maxGuesses: 6,
        submissionCount: 1,
        updatedAt: nowIso
      };
    }

    const tempStore = createTempStatsStore({
      version: 1,
      updatedAt: nowIso,
      profiles: [
        {
          id: profileId,
          name: "Casey",
          createdAt: nowIso,
          updatedAt: nowIso
        }
      ],
      resultsByProfile: {
        [profileId]: existingResults
      }
    });

    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const oldDailyKey = "2020-01-01|en|oldseed";
      const response = await request(app).post("/api/stats/result").send({
        profileId,
        dailyKey: oldDailyKey,
        won: true,
        attempts: 2,
        maxGuesses: 6
      });
      expect(response.status).toBe(200);
      expect(response.body.retained).toBe(false);
      expect(response.body.result).toBeNull();

      const profileSummary = await request(app).get(`/api/stats/profile/${profileId}`);
      expect(profileSummary.status).toBe(200);
      expect(profileSummary.body.summary.overall.played).toBe(400);
      expect(profileSummary.body.summary.totalSubmissions).toBe(400);
    } finally {
      tempStore.cleanup();
    }
  });

  test("validates stats payloads and reports friendly errors", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });

      const invalidRange = await request(app).get("/api/stats/leaderboard?range=alltime");
      expect(invalidRange.status).toBe(400);
      expect(invalidRange.body.error).toMatch(/range/i);

      const invalidProfile = await request(app).post("/api/stats/profile").send({ name: "1234" });
      expect(invalidProfile.status).toBe(400);
      expect(invalidProfile.body.error).toMatch(/player name/i);

      const invalidResult = await request(app).post("/api/stats/result").send({
        profileId: "missing",
        dailyKey: "bad-key",
        won: false,
        attempts: 2,
        maxGuesses: 6
      });
      expect(invalidResult.status).toBe(400);
      expect(invalidResult.body.error).toMatch(/dailyKey/i);
    } finally {
      tempStore.cleanup();
    }
  });

  test("protects admin rename endpoint and prevents duplicate names", async () => {
    const tempStore = createTempStatsStore();
    try {
      const app = loadApp({ adminKey: "secret", statsStorePath: tempStore.filePath });
      const first = await request(app).post("/api/stats/profile").send({ name: "Ava" });
      const second = await request(app).post("/api/stats/profile").send({ name: "Ben" });

      const unauthorized = await request(app)
        .patch(`/api/admin/stats/profile/${first.body.playerId}`)
        .send({ name: "Avery" });
      expect(unauthorized.status).toBe(401);

      const renamed = await request(app)
        .patch(`/api/admin/stats/profile/${first.body.playerId}`)
        .set("x-admin-key", "secret")
        .send({ name: "Avery" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.profile.name).toBe("Avery");

      const duplicate = await request(app)
        .patch(`/api/admin/stats/profile/${first.body.playerId}`)
        .set("x-admin-key", "secret")
        .send({ name: "Ben" });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toMatch(/already uses that name/i);

      const missing = await request(app)
        .patch("/api/admin/stats/profile/missing-id")
        .set("x-admin-key", "secret")
        .send({ name: "Avery" });
      expect(missing.status).toBe(404);

      const stillExists = await request(app).get(`/api/stats/profile/${second.body.playerId}`);
      expect(stillExists.status).toBe(200);
      expect(stillExists.body.profile.name).toBe("Ben");
    } finally {
      tempStore.cleanup();
    }
  });

  test("returns 503 when stats storage is unavailable", async () => {
    const tempStore = createTempStatsStore({
      version: 2,
      updatedAt: "2026-02-20T00:00:00.000Z",
      profiles: [],
      resultsByProfile: {}
    });
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const response = await request(app).get("/api/stats/leaderboard");
      expect(response.status).toBe(503);
      expect(response.body.error).toMatch(/unavailable/i);
    } finally {
      tempStore.cleanup();
    }
  });

  test("keeps puzzle gameplay endpoints available when stats storage is unavailable", async () => {
    const tempStore = createTempStatsStore({
      version: 2,
      updatedAt: "2026-02-20T00:00:00.000Z",
      profiles: [],
      resultsByProfile: {}
    });
    try {
      const app = loadApp({ statsStorePath: tempStore.filePath });
      const puzzle = await request(app).post("/api/puzzle").send({ code: "FOTND", lang: "none", guesses: 6 });
      expect(puzzle.status).toBe(200);

      const guess = await request(app).post("/api/guess").send({ code: "FOTND", guess: "JACKS", lang: "none" });
      expect(guess.status).toBe(200);
      expect(Array.isArray(guess.body.result)).toBe(true);
      expect(guess.body.result).toEqual(["correct", "correct", "correct", "correct", "correct"]);
    } finally {
      tempStore.cleanup();
    }
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

describe("Language registry recovery", () => {
  afterEach(() => {
    fs.writeFileSync(LANGUAGE_REGISTRY_PATH, ORIGINAL_LANGUAGE_REGISTRY, "utf8");
  });

  test("recovers invalid languages.json on startup", async () => {
    await withTempLanguageRegistryContent("{bad json", async () => {
      loadApp();
      const repaired = JSON.parse(fs.readFileSync(LANGUAGE_REGISTRY_PATH, "utf8"));
      expect(repaired.version).toBe(1);
      expect(Array.isArray(repaired.languages)).toBe(true);
      const ids = repaired.languages.map((language) => language.id);
      expect(ids).toContain("en");
      expect(ids).toContain("none");
    });
  });

  test("keeps /api/meta language payload stable with baked registry defaults", async () => {
    writeLanguageRegistry({
      version: 1,
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
        }
      ]
    });

    const app = loadApp();
    const response = await request(app).get("/api/meta");
    expect(response.status).toBe(200);
    const ids = response.body.languages.map((language) => language.id);
    expect(ids).toContain("en");
    expect(ids).toContain("none");
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

  test("warns when trust proxy is disabled in production", () => {
    const app = loadApp({ nodeEnv: "production", adminKey: "secret", trustProxy: false });
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const listener = jest.fn((port, host, cb) => {
      cb();
      return { close: jest.fn() };
    });

    app.startServer(listener);

    expect(listener).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "TRUST_PROXY is disabled. If deployed behind a reverse proxy, load balancer, or Tailscale, set TRUST_PROXY=true (and configure TRUST_PROXY_HOPS as needed)."
    );

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
