const express = require("express");
const fs = require("fs");
const path = require("path");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const REQUIRE_ADMIN_KEY = process.env.REQUIRE_ADMIN_KEY === "true" || NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY
  ? process.env.TRUST_PROXY === "true"
  : NODE_ENV === "production";
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;

const DATA_PATH = path.join(__dirname, "data", "word.json");
const PUBLIC_ROOT = path.join(__dirname, "public");
const PUBLIC_DIST = path.join(PUBLIC_ROOT, "dist");
const PUBLIC_PATH = fs.existsSync(PUBLIC_DIST) ? PUBLIC_DIST : PUBLIC_ROOT;
const DICT_PATH = path.join(__dirname, "data", "dictionaries");
const EN_DEFINITIONS_PATH = path.join(DICT_PATH, "en-definitions.json");

const MIN_LEN = 3;
const MAX_LEN = 12;
const MIN_GUESSES = 4;
const MAX_GUESSES = 10;
const DEFAULT_GUESSES = 6;
const KEY = "WORDLE";
const DEFAULT_LANG = "en";
const LANGUAGES = {
  en: { label: "English", file: "en.txt" },
  none: { label: "No dictionary", file: null }
};

function buildDefaultWordData() {
  return {
    word: "",
    lang: DEFAULT_LANG,
    date: null,
    updatedAt: new Date().toISOString()
  };
}

function isValidWordData(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.word !== "string") return false;
  if (typeof data.lang !== "string") return false;
  if (!(data.date === null || typeof data.date === "string")) return false;
  return true;
}

function normalizeWordData(data) {
  const fallback = buildDefaultWordData();
  const normalized = { ...fallback, ...data };
  normalized.word = normalizeWord(normalized.word || "");
  normalized.lang = normalizeLang(normalized.lang) || fallback.lang;
  normalized.date = normalized.date ? String(normalized.date) : null;
  normalized.updatedAt = normalized.updatedAt
    ? String(normalized.updatedAt)
    : new Date().toISOString();
  return normalized;
}

function readWordData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    if (isValidWordData(data)) {
      return normalizeWordData(data);
    }
  } catch (err) {
    // Ignore and fall back to default.
  }
  return null;
}

function saveWordData(data) {
  fs.writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function ensureWordData() {
  const data = readWordData();
  if (data) return data;
  const fallback = buildDefaultWordData();
  saveWordData(fallback);
  console.warn("Daily word data was invalid and has been reset.");
  return fallback;
}

function isAuthorized(req) {
  if (!ADMIN_KEY) return !REQUIRE_ADMIN_KEY;
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function normalizeLang(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (LANGUAGES[key]) return key;
  if (!key) return DEFAULT_LANG;
  return null;
}

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

function loadDictionary(file, minLength) {
  const fullPath = path.join(DICT_PATH, file);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const raw = fs.readFileSync(fullPath, "utf8");
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

  if (totalCount === 0) {
    return null;
  }

  return {
    byLength,
    listByLength,
    totalCount,
    minLength
  };
}

function loadWordDefinitions(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const source = parsed && typeof parsed === "object" && parsed.definitions
      ? parsed.definitions
      : parsed;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      console.warn("Definition file is invalid. Continuing without answer meanings.");
      return new Map();
    }

    const map = new Map();
    for (const [word, definition] of Object.entries(source)) {
      const normalizedWord = normalizeWord(word);
      if (!/^[A-Z]+$/.test(normalizedWord)) continue;
      const normalizedDefinition = String(definition || "").trim().replace(/\s+/g, " ");
      if (!normalizedDefinition) continue;
      map.set(normalizedWord, normalizedDefinition);
    }
    return map;
  } catch (err) {
    console.warn("Failed to load local definitions. Continuing without answer meanings.");
    return new Map();
  }
}

const dictionaries = {};
const availableLanguages = new Map();
for (const [key, info] of Object.entries(LANGUAGES)) {
  if (!info.file) {
    dictionaries[key] = null;
    availableLanguages.set(key, {
      id: key,
      label: info.label,
      minLength: getMinLengthForLang(key),
      hasDictionary: false
    });
    continue;
  }
  const minLength = getMinLengthForLang(key);
  const dict = loadDictionary(info.file, minLength);
  dictionaries[key] = dict;
  if (dict) {
    availableLanguages.set(key, {
      id: key,
      label: info.label,
      minLength,
      hasDictionary: true
    });
  }
}

app.locals.availableLanguages = availableLanguages;

function getDictionary(lang) {
  if (lang === "none") return null;
  return dictionaries[lang] || null;
}

function isLanguageAvailable(lang) {
  return availableLanguages.has(lang);
}

function resolveLang(raw) {
  const normalized = normalizeLang(raw);
  if (!normalized) return null;
  if (isLanguageAvailable(normalized)) return normalized;
  if (normalized === DEFAULT_LANG && isLanguageAvailable("none")) return "none";
  return null;
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

const englishDefinitions = loadWordDefinitions(EN_DEFINITIONS_PATH);

function lookupAnswerMeaning(lang, word) {
  if (lang !== "en") return null;
  const dict = getDictionary(lang);
  if (!dict || !dictionaryHasWord(dict, word)) return null;
  return englishDefinitions.get(word) || null;
}

function evaluateGuess(guess, answer) {
  const len = answer.length;
  const result = Array(len).fill("absent");
  const answerChars = answer.split("");
  const used = Array(len).fill(false);

  for (let i = 0; i < len; i += 1) {
    if (guess[i] === answerChars[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }

  for (let i = 0; i < len; i += 1) {
    if (result[i] === "correct") continue;
    for (let j = 0; j < len; j += 1) {
      if (!used[j] && guess[i] === answerChars[j]) {
        result[i] = "present";
        used[j] = true;
        break;
      }
    }
  }

  return result;
}

app.disable("x-powered-by");
if (TRUST_PROXY) {
  app.set("trust proxy", 1);
}
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Try again later." }
  })
);
app.use(compression());
app.use(express.json());
const STATIC_MAX_AGE = NODE_ENV === "production" ? 60 * 60 * 1000 : 0;
app.use(
  express.static(PUBLIC_PATH, {
    etag: true,
    maxAge: STATIC_MAX_AGE,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
        return;
      }
      if (NODE_ENV === "production") {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    }
  })
);

ensureWordData();

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/meta", (req, res) => {
  const languages = Array.from(availableLanguages.values());
  const defaultLang = isLanguageAvailable(DEFAULT_LANG)
    ? DEFAULT_LANG
    : languages[0]?.id || "none";

  res.json({
    minLength: MIN_LEN,
    maxLength: MAX_LEN,
    minGuesses: MIN_GUESSES,
    maxGuesses: MAX_GUESSES,
    defaultGuesses: DEFAULT_GUESSES,
    languages,
    defaultLang
  });
});

app.post("/api/encode", (req, res) => {
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

  const dict = getDictionary(lang);
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

app.post("/api/random", (req, res) => {
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }
  const length = Number(req.body.length);
  const minLength = getMinLengthForLang(lang);

  if (!Number.isInteger(length) || length < minLength || length > MAX_LEN) {
    return res
      .status(400)
      .json({ error: `Length must be ${minLength}-${MAX_LEN}.` });
  }

  const dict = getDictionary(lang);
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

app.post("/api/puzzle", (req, res) => {
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
    label: LANGUAGES[lang]?.label || "English",
    maxGuesses: guesses
  });
});

app.post("/api/guess", (req, res) => {
  const code = normalizeWord(req.body.code);
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }
  const reveal = Boolean(req.body.reveal);

  if (!/^[A-Z]+$/.test(code)) {
    return res.status(400).json({ error: "Invalid word code." });
  }

  const answer = decodeWord(code);
  const guess = normalizeWord(req.body.guess);

  if (!/^[A-Z]+$/.test(guess)) {
    return res.status(400).json({ error: "Guess must use only letters A-Z." });
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

app.get("/api/word", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Admin key required." });
  }
  res.json(readWordData() || buildDefaultWordData());
});

app.post("/api/word", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Admin key required." });
  }

  const word = normalizeWord(req.body.word);
  const date = req.body.date ? String(req.body.date) : null;
  const lang = resolveLang(req.body.lang);
  if (!lang) {
    return res.status(400).json({ error: "Unknown language." });
  }

  try {
    assertWord(word, getMinLengthForLang(lang));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const data = {
    word,
    lang,
    date: date || null,
    updatedAt: new Date().toISOString()
  };

  saveWordData(data);
  res.json({ ok: true, data });
});

app.get("/daily", (req, res) => {
  const data = readWordData();
  if (!data || !data.word) {
    return res.status(404).send(renderDailyMissing("No daily puzzle yet."));
  }

  const word = normalizeWord(data.word);
  if (!word || !/^[A-Z]+$/.test(word)) {
    return res.status(404).send(renderDailyMissing("No daily puzzle yet."));
  }

  if (data.date) {
    const today = getLocalDateString(new Date());
    if (data.date !== today) {
      return res
        .status(404)
        .send(renderDailyMissing("Today's puzzle isn't set yet."));
    }
  }

  const code = encodeWord(word).toLowerCase();
  const lang = resolveLang(data.lang) || DEFAULT_LANG;
  const dailyDate = getLocalDateString(new Date());
  let target = `/?word=${code}`;
  if (lang !== "en") {
    target += `&lang=${lang}`;
  }
  target += "&daily=1";
  target += `&day=${dailyDate}`;
  res.redirect(target);
});

function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderDailyMissing(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily Word</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="layout">
      <section class="panel">
        <h2>Daily Word</h2>
        <p class="note">${message}</p>
        <a class="admin-link" href="/">Make a new puzzle</a>
      </section>
    </main>
  </body>
</html>`;
}

function startServer(listener = app.listen.bind(app)) {
  return listener(PORT, HOST, () => {
    console.log(`local-hosted-wordle server running at http://localhost:${PORT}`);
    if (!ADMIN_KEY && !REQUIRE_ADMIN_KEY) {
      console.log("Admin mode is open. Set ADMIN_KEY to protect /admin updates.");
    }
    if (!ADMIN_KEY && REQUIRE_ADMIN_KEY) {
      console.warn("ADMIN_KEY is required for admin endpoints in production.");
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
module.exports.startServer = startServer;
