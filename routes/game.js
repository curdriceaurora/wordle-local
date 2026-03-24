const express = require("express");

/**
 * Game routes factory
 * Provides core game mechanic endpoints: encode, random, puzzle, and guess
 * @param {Object} deps - Dependencies
 * @param {Function} deps.normalizeWord - Normalizes word to uppercase and trims
 * @param {Function} deps.resolveLang - Resolves and validates language code
 * @param {Function} deps.assertWord - Validates word format and length
 * @param {Function} deps.getMinLengthForLang - Gets minimum word length for language
 * @param {Function} deps.getAnswerDictionary - Gets answer dictionary for language
 * @param {Function} deps.getDictionary - Gets full dictionary for language
 * @param {Function} deps.dictionaryHasWord - Checks if word exists in dictionary
 * @param {Function} deps.dictionaryRandomWord - Gets random word from dictionary
 * @param {Function} deps.encodeWord - Encodes word to shareable code
 * @param {Function} deps.decodeWord - Decodes word from shareable code
 * @param {Function} deps.evaluateGuess - Evaluates guess against answer
 * @param {Function} deps.lookupAnswerMeaning - Looks up word definition
 * @param {Function} deps.getLanguageLabel - Gets language display label
 * @param {number} deps.DEFAULT_GUESSES - Default number of guesses
 * @param {number} deps.MIN_GUESSES - Minimum number of guesses
 * @param {number} deps.MAX_GUESSES - Maximum number of guesses
 * @param {number} deps.MAX_LEN - Maximum word length
 * @returns {express.Router} Express router
 */
function createGameRouter(deps) {
  const {
    normalizeWord,
    resolveLang,
    assertWord,
    getMinLengthForLang,
    getAnswerDictionary,
    getDictionary,
    dictionaryHasWord,
    dictionaryRandomWord,
    encodeWord,
    decodeWord,
    evaluateGuess,
    lookupAnswerMeaning,
    getLanguageLabel,
    DEFAULT_GUESSES,
    MIN_GUESSES,
    MAX_GUESSES,
    MAX_LEN
  } = deps;

  const router = express.Router();

  router.post("/api/encode", (req, res) => {
    const word = normalizeWord(req.body.word);
    const lang = resolveLang(req.body.lang);
    if (!lang) {
      return res.status(400).json({ error: "Unknown language." });
    }

    try {
      assertWord(word, getMinLengthForLang(lang));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const dict = getAnswerDictionary(lang);
    if (dict && !dictionaryHasWord(dict, word)) {
      return res.status(400).json({ error: "Word not found in dictionary for that language." });
    }

    const code = encodeWord(word);
    res.json({
      code,
      length: word.length,
      lang
    });
  });

  router.post("/api/random", (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({ error: "Invalid request body." });
    }

    const lang = resolveLang(payload.lang);
    if (!lang) {
      return res.status(400).json({ error: "Unknown language." });
    }
    const length = payload.length;
    if (Array.isArray(length) || (length !== undefined && typeof length !== "number")) {
      return res.status(400).json({ error: "Length must be a number." });
    }
    const minLength = getMinLengthForLang(lang);

    if (!Number.isInteger(length) || length < minLength || length > MAX_LEN) {
      return res
        .status(400)
        .json({ error: `Length must be ${minLength}-${MAX_LEN}.` });
    }

    const dict = getAnswerDictionary(lang);
    if (!dict) {
      return res.status(400).json({ error: "No dictionary available for that language." });
    }

    const word = dictionaryRandomWord(dict, length);
    if (!word) {
      return res.status(400).json({ error: "No words available for that length." });
    }

    res.json({
      word,
      code: encodeWord(word),
      length,
      lang
    });
  });

  router.post("/api/puzzle", (req, res) => {
    const code = normalizeWord(req.body.code);
    const lang = resolveLang(req.body.lang);
    if (!lang) {
      return res.status(400).json({ error: "Unknown language." });
    }
    let guesses = DEFAULT_GUESSES;
    const minLength = getMinLengthForLang(lang);

    if (req.body.guesses !== undefined) {
      const parsed = Number(req.body.guesses);
      if (!Number.isInteger(parsed) || parsed < MIN_GUESSES || parsed > MAX_GUESSES) {
        return res.status(400).json({ error: `Guesses must be ${MIN_GUESSES}-${MAX_GUESSES}.` });
      }
      guesses = parsed;
    }

    if (!/^[A-Z]+$/.test(code)) {
      return res.status(400).json({ error: "Invalid word code." });
    }
    if (code.length < minLength || code.length > MAX_LEN) {
      return res.status(400).json({ error: "Invalid word code length." });
    }

    res.json({
      length: code.length,
      lang,
      label: getLanguageLabel(lang),
      maxGuesses: guesses
    });
  });

  router.post("/api/guess", (req, res) => {
    const code = normalizeWord(req.body.code);
    const lang = resolveLang(req.body.lang);
    if (!lang) {
      return res.status(400).json({ error: "Unknown language." });
    }
    const minLength = getMinLengthForLang(lang);
    const revealRaw = req.body?.reveal;
    const reveal =
      revealRaw === true
      || (typeof revealRaw === "string" && revealRaw.trim().toLowerCase() === "true");

    if (!/^[A-Z]+$/.test(code)) {
      return res.status(400).json({ error: "Invalid word code." });
    }
    if (code.length < minLength || code.length > MAX_LEN) {
      return res.status(400).json({ error: "Invalid word code length." });
    }

    const answer = decodeWord(code);
    const guess = normalizeWord(req.body.guess);

    if (!/^[A-Z]+$/.test(guess)) {
      return res.status(400).json({ error: "Guess must use only letters A-Z." });
    }
    if (guess.length < minLength || guess.length > MAX_LEN) {
      return res.status(400).json({ error: `Guess length must be ${minLength}-${MAX_LEN}.` });
    }
    if (guess.length !== answer.length) {
      return res.status(400).json({ error: "Guess length does not match." });
    }

    const dict = getDictionary(lang);
    if (dict && !dictionaryHasWord(dict, guess)) {
      return res.status(400).json({ error: "Not in word list." });
    }

    const result = evaluateGuess(guess, answer);
    const isCorrect = guess === answer;

    const shouldIncludeMeaning = isCorrect || (reveal && !isCorrect);
    const answerMeaning = shouldIncludeMeaning
      ? lookupAnswerMeaning(lang, answer) || undefined
      : undefined;

    res.json({
      ok: true,
      result,
      isCorrect,
      answer: reveal && !isCorrect ? answer : undefined,
      answerMeaning
    });
  });

  return router;
}

module.exports = createGameRouter;
