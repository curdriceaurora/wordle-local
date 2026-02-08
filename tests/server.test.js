const fs = require("fs");
const path = require("path");
const request = require("supertest");

const DATA_PATH = path.join(__dirname, "..", "data", "word.json");
const DICT_PATH = path.join(__dirname, "..", "data", "dictionaries");
const ORIGINAL_WORD_DATA = fs.readFileSync(DATA_PATH, "utf8");

function loadApp(adminKey = "") {
  jest.resetModules();
  if (adminKey) {
    process.env.ADMIN_KEY = adminKey;
  } else {
    delete process.env.ADMIN_KEY;
  }
  return require("../server");
}

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
      .send({ code: "FOTN", lang: "es", guesses: 6 });
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
    await withTempDictionary("es.txt", "APPLE\n", async () => {
      const app = loadApp();
      const response = await request(app)
        .post("/api/random")
        .send({ lang: "es", length: 6 });
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
    await withMissingDictionary("fr.txt", async () => {
      const app = loadApp();
      const response = await request(app).get("/api/meta");
      expect(response.status).toBe(200);
      const ids = response.body.languages.map((lang) => lang.id);
      expect(ids).not.toContain("fr");
      expect(ids).toContain("none");
    });

    await withTempDictionary("de.txt", "", async () => {
      const app = loadApp();
      const response = await request(app).get("/api/meta");
      expect(response.status).toBe(200);
      const ids = response.body.languages.map((lang) => lang.id);
      expect(ids).not.toContain("de");
    });
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

  test("rejects languages that are configured but unavailable", async () => {
    await withMissingDictionary("fr.txt", async () => {
      const app = loadApp();
      const response = await request(app)
        .post("/api/encode")
        .send({ word: "CRANE", lang: "fr" });
      expect(response.status).toBe(400);
    });
  });

  test("enforces minimum length for non-English languages", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "TREE", lang: "es" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/5-12/);
  });
});

describe("Admin auth", () => {
  test("requires admin key when configured", async () => {
    const app = loadApp("secret");
    const response = await request(app).get("/api/word");
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/Admin key/i);
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
    writeWordData({ word: "TIGER", lang: "es", date, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(302);
    expect(response.headers.location).toMatch(/word=/);
    expect(response.headers.location).toMatch(/lang=es/);
  });

  test("redirects using default language when stored lang is unknown", async () => {
    writeWordData({ word: "CRANE", lang: "xx", date: null, updatedAt: new Date().toISOString() });
    const app = loadApp();
    const response = await request(app).get("/daily");
    expect(response.status).toBe(302);
    expect(response.headers.location.startsWith("/?word=")).toBe(true);
    expect(response.headers.location).not.toMatch(/lang=/);
  });
});
