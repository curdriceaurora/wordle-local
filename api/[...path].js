// Vercel serverless catch-all for /api/*.
//
// Mounts the existing routes/game.js router (which is dep-injected by
// design) with inline copies of the gameplay helpers from server.js.
// This deploy is intentionally separated from the Express main process:
// only the stateless gameplay endpoints are exposed here, no admin /
// stats / challenges / notifications routes (those need persistent
// disk state that Vercel serverless functions cannot provide).
//
// Helpers inlined rather than imported from server.js to avoid pulling
// in the full Express app's initialization (stores, schedulers, etc.)
// — those crash on a stateless runtime. routes/game.js itself is reused
// directly since it's already a factory taking pure-function deps.

const express = require("express");
const rateLimit = require("express-rate-limit");
const fs = require("node:fs");
const path = require("node:path");
const createGameRouter = require("../routes/game");
const createMetaRouter = require("../routes/meta");

const KEY = "WORDLE";
const MIN_LEN = 3;
const MAX_LEN = 12;
const MIN_GUESSES = 4;
const MAX_GUESSES = 10;
const DEFAULT_GUESSES = 6;

function normalizeWord(raw) {
  return String(raw || "").trim().toUpperCase();
}

function getMinLengthForLang() {
  return MIN_LEN;
}

function assertWord(word, minLength = MIN_LEN) {
  if (!/^[A-Z]+$/.test(word)) {
    throw new Error("Word must use only letters A-Z.");
  }
  if (word.length < minLength || word.length > MAX_LEN) {
    throw new Error(`Word length must be ${minLength}-${MAX_LEN} letters.`);
  }
}

function encodeWord(word) {
  const upper = normalizeWord(word);
  let output = "";
  for (let i = 0; i < upper.length; i += 1) {
    const p = upper.charCodeAt(i) - 65;
    const k = KEY.charCodeAt(i % KEY.length) - 65;
    output += String.fromCharCode(((p + k) % 26) + 65);
  }
  return output;
}

function decodeWord(code) {
  const upper = normalizeWord(code);
  let output = "";
  for (let i = 0; i < upper.length; i += 1) {
    const c = upper.charCodeAt(i) - 65;
    const k = KEY.charCodeAt(i % KEY.length) - 65;
    output += String.fromCharCode(((c - k + 26) % 26) + 65);
  }
  return output;
}

function evaluateGuess(guess, answer) {
  const len = answer.length;
  const result = new Array(len);
  const remaining = new Uint8Array(26);

  for (let i = 0; i < len; i += 1) {
    const guessCode = guess.charCodeAt(i) - 65;
    const answerCode = answer.charCodeAt(i) - 65;
    if (guessCode === answerCode) {
      result[i] = "correct";
      continue;
    }
    result[i] = "absent";
    remaining[answerCode] += 1;
  }

  for (let i = 0; i < len; i += 1) {
    if (result[i] === "correct") continue;
    const guessCode = guess.charCodeAt(i) - 65;
    if (remaining[guessCode] > 0) {
      result[i] = "present";
      remaining[guessCode] -= 1;
    }
  }

  return result;
}

function dictionaryHasWord(dict, word) {
  if (!dict) return true;
  const set = dict.byLength.get(word.length);
  if (!set) return false;
  return set.has(word);
}

function dictionaryRandomWord(dict, length) {
  if (!dict) return null;
  const list = dict.listByLength.get(length);
  if (!list || list.length === 0) return null;
  const index = Math.floor(Math.random() * list.length);
  return list[index];
}

function loadDictionary(filePath, minLength) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const byLength = new Map();
  const listByLength = new Map();
  let totalCount = 0;

  for (const line of lines) {
    const word = line.trim().toUpperCase();
    if (!word) continue;
    if (!/^[A-Z]+$/.test(word)) continue;
    if (word.length < minLength || word.length > MAX_LEN) continue;

    let set = byLength.get(word.length);
    if (!set) {
      set = new Set();
      byLength.set(word.length, set);
    }
    if (set.has(word)) continue;
    set.add(word);
    totalCount += 1;

    let list = listByLength.get(word.length);
    if (!list) {
      list = [];
      listByLength.set(word.length, list);
    }
    list.push(word);
  }

  if (totalCount === 0) return null;
  return { byLength, listByLength, totalCount, minLength };
}

// Cold-start dictionary load. The file lives in the deployment bundle
// thanks to functions.includeFiles in vercel.json.
const DICT_FILE = path.join(__dirname, "..", "data", "dictionaries", "en.txt");
const enDict = loadDictionary(DICT_FILE, MIN_LEN);

function resolveLang(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "en" || value.startsWith("en-")) return "en";
  // Only English shipped in this deploy. Reject other languages cleanly
  // rather than 404; the front-end displays the returned error text.
  return null;
}

function getLanguageLabel() {
  return "English";
}

// Definitions disabled in this deploy: en-definitions.json is 5.1 MB
// and only used to render the answer's meaning on win/reveal. Returning
// null is graceful — the front-end omits the meaning line when absent.
function lookupAnswerMeaning() {
  return null;
}

// Single-entry language registry. Front-end's loadMeta() uses this list
// to populate the dictionary dropdown; with one entry it hides the
// dropdown row.
const AVAILABLE_LANGUAGES = new Map([
  ["en", { id: "en", label: "English", minLength: MIN_LEN }]
]);

const app = express();

// Don't advertise the underlying framework on a public preview. Matches
// server.js which disables this for the same reason.
app.disable("x-powered-by");

// Vercel terminates TLS / load balances before the function runs, so the
// originating IP is in x-forwarded-for. Trust one hop so express-rate-limit
// keys by the real client address instead of the proxy.
app.set("trust proxy", 1);

// Match server.js's default global limiter (300 req per 15 min per IP).
// Public deploy → /api/guess and /api/random would otherwise be free to
// hammer.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down." }
});
app.use(limiter);

app.use(express.json({ limit: "32kb" }));

// Send JSON, not Express's default HTML, when body parsing fails
// (entity.too.large, malformed JSON). Front-end always expects JSON.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  if (err instanceof SyntaxError && "body" in err) {
    // Match server.js's wording so client error copy is consistent
    // between the local/Docker hosting paths and the Vercel preview.
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  return next(err);
});

// Deploy-capability flags layered onto /api/meta. The front-end reads
// these and hides UI affordances for backends that aren't wired up
// here — e.g. the header's "Daily Word" link would otherwise navigate
// to /daily and 404 because that route needs persistent state.
const DEPLOY_FLAGS = {
  dailyWordEnabled: false,
  leaderboardEnabled: false,
  challengesEnabled: false,
  notificationsEnabled: false
};

// Mount the base meta router, then intercept /api/meta with a wrapper
// that adds the flags. Done with a wrapping response so the upstream
// router can evolve and we just pass through the rest of the payload.
app.get("/api/meta", (req, res, next) => {
  const original = res.json.bind(res);
  res.json = (body) => original({ ...body, ...DEPLOY_FLAGS });
  next();
});

app.use(
  createMetaRouter({
    getAvailableLanguages: () => AVAILABLE_LANGUAGES,
    isLanguageAvailable: (lang) => AVAILABLE_LANGUAGES.has(lang),
    MIN_LEN,
    MAX_LEN,
    MIN_GUESSES,
    MAX_GUESSES,
    DEFAULT_GUESSES,
    DEFAULT_LANG: "en",
    isPerfLoggingEnabled: () => false,
    getDefinitionsMode: () => "off"
  })
);

app.use(
  createGameRouter({
    normalizeWord,
    resolveLang,
    assertWord,
    getMinLengthForLang,
    getAnswerDictionary: () => enDict,
    getDictionary: () => enDict,
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
  })
);

// Anything that doesn't match a game route (e.g. /api/stats/*) gets a
// clear 404 with a code the front-end can branch on.
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not available in this deployment.",
    code: "STATIC_DEPLOY_ENDPOINT_MISSING"
  });
});

module.exports = app;
