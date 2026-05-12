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
const fs = require("node:fs");
const path = require("node:path");
const createGameRouter = require("../routes/game");

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

const app = express();
app.use(express.json({ limit: "32kb" }));

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
