const request = require("supertest");
const app = require("../server");

describe("Wordle API", () => {
  test("encodes word using WORDLE cipher", async () => {
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "JACKS", lang: "none" });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe("FOTND");
    expect(response.body.length).toBe(5);
  });

  test("rejects invalid word", async () => {
    const response = await request(app)
      .post("/api/encode")
      .send({ word: "AB12", lang: "none" });

    expect(response.status).toBe(400);
  });

  test("returns puzzle metadata", async () => {
    const response = await request(app)
      .post("/api/puzzle")
      .send({ code: "FOTND", lang: "none", guesses: 7 });

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(5);
    expect(response.body.maxGuesses).toBe(7);
  });

  test("evaluates guess correctly", async () => {
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
    const response = await request(app)
      .post("/api/random")
      .send({ lang: "en", length: 5 });

    expect(response.status).toBe(200);
    expect(response.body.word.length).toBe(5);
    expect(response.body.code.length).toBe(5);
  });
});
