const express = require("express");

/**
 * Meta routes factory
 * Provides health check and application metadata endpoints
 * @param {Object} deps - Dependencies
 * @param {Function} deps.getAvailableLanguages - Returns latest map of available language configurations
 * @param {Function} deps.isLanguageAvailable - Function to check if a language is available
 * @param {number} deps.MIN_LEN - Minimum word length
 * @param {number} deps.MAX_LEN - Maximum word length
 * @param {number} deps.MIN_GUESSES - Minimum number of guesses
 * @param {number} deps.MAX_GUESSES - Maximum number of guesses
 * @param {number} deps.DEFAULT_GUESSES - Default number of guesses
 * @param {string} deps.DEFAULT_LANG - Default language code
 * @param {Function} deps.isPerfLoggingEnabled - Returns whether performance logging is enabled
 * @param {Function} deps.getDefinitionsMode - Returns current definitions mode configuration
 * @returns {express.Router} Express router
 */
function createMetaRouter(deps) {
  const {
    getAvailableLanguages,
    isLanguageAvailable,
    MIN_LEN,
    MAX_LEN,
    MIN_GUESSES,
    MAX_GUESSES,
    DEFAULT_GUESSES,
    DEFAULT_LANG,
    isPerfLoggingEnabled,
    getDefinitionsMode
  } = deps;

  const router = express.Router();

  router.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  router.get("/api/meta", (req, res) => {
    const availableLanguages = getAvailableLanguages();
    const languages = Array.from(availableLanguages.values());
    const defaultLang = isLanguageAvailable(DEFAULT_LANG)
      ? DEFAULT_LANG
      : languages[0]?.id || DEFAULT_LANG;

    res.json({
      minLength: MIN_LEN,
      maxLength: MAX_LEN,
      minGuesses: MIN_GUESSES,
      maxGuesses: MAX_GUESSES,
      defaultGuesses: DEFAULT_GUESSES,
      languages,
      defaultLang,
      perfLogging: isPerfLoggingEnabled(),
      definitionsMode: getDefinitionsMode()
    });
  });

  return router;
}

module.exports = createMetaRouter;
