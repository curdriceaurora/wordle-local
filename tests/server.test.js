const fs = require("fs");
const path = require("path");
const request = require("supertest");

const DATA_PATH = path.join(__dirname, "..", "data", "word.json");
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

  test("rejects invalid word", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "AB12", lang: "none" });

    expect(response.status).toBe(400);
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

  test("random returns a word for supported language", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/random")
      .send({ lang: "en", length: 5 });

    expect(response.status).toBe(200);
    expect(response.body.word.length).toBe(5);
    expect(response.body.code.length).toBe(5);
  });

  test("rejects unknown language", async () => {
    const app = loadApp();
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "CRANE", lang: "xx" });

    expect(response.status).toBe(400);
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
});
