const createPanel = document.getElementById("createPanel");
const playPanel = document.getElementById("playPanel");

const createForm = document.getElementById("createForm");
const langSelect = document.getElementById("langSelect");
const wordInput = document.getElementById("wordInput");
const lengthInput = document.getElementById("lengthInput");
const guessInput = document.getElementById("guessInput");
const randomBtn = document.getElementById("randomBtn");
const createStatus = document.getElementById("createStatus");
const hintEl = document.querySelector(".hint");
const updatedEl = document.getElementById("updated");
const shareLinkInput = document.getElementById("shareLink");
const shareCopyBtn = document.getElementById("shareCopyBtn");
const contrastToggle = document.getElementById("contrastToggle");
const strictToggle = document.getElementById("strictToggle");
const shareInfoBtn = document.getElementById("shareInfoBtn");
const shareModal = document.getElementById("shareModal");
const shareModalClose = document.getElementById("shareModalClose");
const shareModalBackdrop = shareModal ? shareModal.querySelector("[data-modal-close]") : null;
const errorPanel = document.getElementById("errorPanel");
const errorMessageEl = document.getElementById("errorMessage");
const errorCountdownEl = document.getElementById("errorCountdown");

const boardEl = document.getElementById("board");
const keyboardEl = document.getElementById("keyboard");
const messageEl = document.getElementById("message");
const playMetaEl = document.getElementById("playMeta");
const srStatusEl = document.getElementById("srStatus");

let currentRow = 0;
let currentCol = 0;
let locked = false;
let cols = 5;
let maxGuesses = 6;
let guesses = [];
let keyStatus = {};
let puzzleCode = "";
let puzzleLang = "en";
let minLen = 3;
let maxLen = 12;
let busy = false;
let strictMode = false;
let baseMeta = "";
let fixedPositions = [];
let bannedPositions = [];
let minCounts = {};
let minGuesses = 4;
let maxGuessesAllowed = 10;
let defaultGuesses = 6;
let lastFocusedElement = null;
let languageMinLengths = {};
let defaultLang = "en";
let errorTimer = null;

function isShareModalOpen() {
  return Boolean(shareModal && shareModal.classList.contains("is-open"));
}

function openShareModal() {
  if (!shareModal) return;
  lastFocusedElement = document.activeElement;
  shareModal.classList.add("is-open");
  shareModal.setAttribute("aria-hidden", "false");
  if (shareModalClose) {
    shareModalClose.focus();
  }
}

function closeShareModal() {
  if (!shareModal) return;
  shareModal.classList.remove("is-open");
  shareModal.setAttribute("aria-hidden", "true");
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

function setCreateStatus(text) {
  createStatus.textContent = text;
}

function setMessage(text) {
  messageEl.textContent = text;
}

function setSrStatus(text) {
  if (!srStatusEl) return;
  srStatusEl.textContent = text;
}

function showCreate() {
  createPanel.classList.remove("hidden");
  playPanel.classList.add("hidden");
  if (errorPanel) {
    errorPanel.classList.add("hidden");
  }
}

function showPlay() {
  playPanel.classList.remove("hidden");
  createPanel.classList.add("hidden");
  if (errorPanel) {
    errorPanel.classList.add("hidden");
  }
}

function showErrorPanel(message) {
  if (!errorPanel) return;
  clearInterval(errorTimer);
  createPanel.classList.add("hidden");
  playPanel.classList.add("hidden");
  errorPanel.classList.remove("hidden");
  errorMessageEl.textContent = message || "That link doesn't work. Let's make a new puzzle.";

  let remaining = 10;
  errorCountdownEl.textContent = `Going back in ${remaining}s...`;
  errorTimer = setInterval(() => {
    remaining -= 1;
    errorCountdownEl.textContent = `Going back in ${remaining}s...`;
    if (remaining <= 0) {
      clearInterval(errorTimer);
      window.location.href = "/";
    }
  }, 1000);
}

function buildBoard() {
  boardEl.innerHTML = "";
  boardEl.style.setProperty("--rows", String(maxGuesses));
  boardEl.style.setProperty("--cols", String(cols));
  boardEl.setAttribute("role", "grid");
  boardEl.setAttribute("aria-rowcount", String(maxGuesses));
  boardEl.setAttribute("aria-colcount", String(cols));
  for (let r = 0; r < maxGuesses; r += 1) {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "row");
    for (let c = 0; c < cols; c += 1) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.setAttribute("role", "gridcell");
      tile.setAttribute("aria-label", "Empty");
      row.appendChild(tile);
    }
    boardEl.appendChild(row);
  }
}

function buildKeyboard() {
  const layout = [
    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
    ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
    ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACK"]
  ];

  keyboardEl.innerHTML = "";
  layout.forEach((rowKeys, rowIndex) => {
    const rowEl = document.createElement("div");
    rowEl.className = "key-row";
    if (rowIndex === 1) {
      rowEl.classList.add("offset");
    }
    rowKeys.forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "key";
      button.dataset.key = key;
      if (key === "ENTER" || key === "BACK") {
        button.classList.add("wide");
      }
      button.textContent = key === "BACK" ? "⌫" : key;
      button.setAttribute("aria-label", key === "BACK" ? "Backspace" : key);
      button.addEventListener("click", () => handleKey(key));
      rowEl.appendChild(button);
    });
    keyboardEl.appendChild(rowEl);
  });
}

function getTile(row, col) {
  return boardEl.querySelector(`.tile[data-row="${row}"][data-col="${col}"]`);
}

function updateTile(row, col, letter, filled = true) {
  const tile = getTile(row, col);
  if (!tile) return;
  tile.textContent = letter;
  tile.classList.toggle("filled", filled && letter !== "");
  if (!letter) {
    tile.setAttribute("aria-label", "Empty");
  } else {
    tile.setAttribute("aria-label", `Letter ${letter}`);
  }
}

function applyResult(row, result, guess) {
  for (let col = 0; col < cols; col += 1) {
    const tile = getTile(row, col);
    tile.classList.remove("absent", "present", "correct");
    tile.classList.add(result[col]);
    const letter = guess[col] || "";
    tile.setAttribute("aria-label", `Letter ${letter}, ${result[col]}`);
  }
}

function describeResult(guess, result) {
  const parts = [];
  for (let i = 0; i < cols; i += 1) {
    const letter = guess[i];
    const status = result[i];
    parts.push(`${letter} ${status}`);
  }
  return parts.join(", ");
}

function updateKeyboard(result, guess) {
  const priority = { absent: 1, present: 2, correct: 3 };
  for (let i = 0; i < guess.length; i += 1) {
    const letter = guess[i];
    const status = result[i];
    const current = keyStatus[letter];
    if (!current || priority[status] > priority[current]) {
      keyStatus[letter] = status;
    }
  }

  keyboardEl.querySelectorAll(".key").forEach((keyEl) => {
    const key = keyEl.dataset.key;
    if (!key || key.length !== 1) return;
    keyEl.classList.remove("absent", "present", "correct");
    const status = keyStatus[key];
    if (status) {
      keyEl.classList.add(status);
    }
  });
}

function resetConstraints() {
  fixedPositions = Array(cols).fill(null);
  bannedPositions = Array.from({ length: cols }, () => new Set());
  minCounts = {};
}

function updateConstraints(guess, result) {
  const letterCounts = {};
  for (let i = 0; i < cols; i += 1) {
    const letter = guess[i];
    const status = result[i];
    if (status === "correct") {
      fixedPositions[i] = letter;
    }
    if (status === "present") {
      bannedPositions[i].add(letter);
    }
    if (status === "present" || status === "correct") {
      letterCounts[letter] = (letterCounts[letter] || 0) + 1;
    }
  }

  Object.entries(letterCounts).forEach(([letter, count]) => {
    minCounts[letter] = Math.max(minCounts[letter] || 0, count);
  });
}

function validateStrictGuess(guess) {
  for (let i = 0; i < cols; i += 1) {
    const fixed = fixedPositions[i];
    if (fixed && guess[i] !== fixed) {
      return `Strict mode: position ${i + 1} must be ${fixed}.`;
    }
  }

  for (let i = 0; i < cols; i += 1) {
    if (bannedPositions[i].has(guess[i])) {
      return `Strict mode: ${guess[i]} cannot be in position ${i + 1}.`;
    }
  }

  const guessCounts = {};
  for (const letter of guess) {
    guessCounts[letter] = (guessCounts[letter] || 0) + 1;
  }

  const missing = [];
  Object.entries(minCounts).forEach(([letter, count]) => {
    const actual = guessCounts[letter] || 0;
    if (actual < count) {
      missing.push(`${letter}${count > 1 ? ` x${count}` : ""}`);
    }
  });

  if (missing.length) {
    return `Strict mode: include ${missing.join(", ")}.`;
  }

  return "";
}

function resetGame() {
  currentRow = 0;
  currentCol = 0;
  locked = false;
  guesses = Array.from({ length: maxGuesses }, () => Array(cols).fill(""));
  keyStatus = {};
  resetConstraints();
  setMessage("");
  setSrStatus("");
  buildBoard();
  buildKeyboard();
}

function guessComplete() {
  return currentCol === cols;
}

async function submitGuess() {
  if (!guessComplete()) {
    setMessage("Not enough letters.");
    return;
  }
  if (busy) return;

  const guess = guesses[currentRow].join("");
  if (strictMode) {
    const strictError = validateStrictGuess(guess);
    if (strictError) {
      setMessage(strictError);
      return;
    }
  }

  busy = true;
  const reveal = currentRow === maxGuesses - 1;

  try {
    const response = await fetch("/api/guess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: puzzleCode, guess, lang: puzzleLang, reveal })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(data.error || "Invalid guess.");
      return;
    }

    applyResult(currentRow, data.result, guess);
    updateKeyboard(data.result, guess);
    updateConstraints(guess, data.result);
    setSrStatus(`Guess ${currentRow + 1}: ${describeResult(guess, data.result)}`);

    if (data.isCorrect) {
      locked = true;
      setMessage(`Solved in ${currentRow + 1}/${maxGuesses}!`);
      return;
    }

    if (currentRow === maxGuesses - 1) {
      locked = true;
      if (data.answer) {
        const suffix =
          typeof data.answerMeaning === "string" && data.answerMeaning.trim()
            ? ` Meaning: ${data.answerMeaning.trim()}`
            : "";
        setMessage(`Out of tries. Word was ${data.answer}.${suffix}`);
      } else {
        setMessage("Out of tries.");
      }
      return;
    }

    currentRow += 1;
    currentCol = 0;
    setMessage("");
  } catch (err) {
    setMessage("Server error. Try again.");
  } finally {
    busy = false;
  }
}

function handleKey(rawKey) {
  if (locked || busy) return;

  const key = rawKey.toUpperCase();
  if (key === "ENTER") {
    submitGuess();
    return;
  }
  if (key === "BACK") {
    if (currentCol > 0) {
      currentCol -= 1;
      guesses[currentRow][currentCol] = "";
      updateTile(currentRow, currentCol, "", false);
    }
    return;
  }
  if (!/^[A-Z]$/.test(key)) return;
  if (currentCol >= cols) return;

  guesses[currentRow][currentCol] = key;
  updateTile(currentRow, currentCol, key, true);
  currentCol += 1;
}

function handlePhysicalKey(event) {
  if (isShareModalOpen()) {
    if (event.key === "Escape") {
      closeShareModal();
    }
    return;
  }
  if (event.key === "Enter") {
    handleKey("ENTER");
  } else if (event.key === "Backspace") {
    handleKey("BACK");
  } else if (/^[a-zA-Z]$/.test(event.key)) {
    handleKey(event.key);
  }
}

function buildShareLink(code, lang, guessesCount) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("word", String(code).toLowerCase());
  if (lang && lang !== "en") {
    url.searchParams.set("lang", lang);
  }
  if (guessesCount) {
    url.searchParams.set("g", String(guessesCount));
  }
  return url.toString();
}

async function loadMeta() {
  try {
    const response = await fetch("/api/meta");
    if (!response.ok) return;
    const data = await response.json();
    minLen = data.minLength || minLen;
    maxLen = data.maxLength || maxLen;
    minGuesses = data.minGuesses || minGuesses;
    maxGuessesAllowed = data.maxGuesses || maxGuessesAllowed;
    defaultGuesses = data.defaultGuesses || defaultGuesses;
    defaultLang = data.defaultLang || defaultLang;

    lengthInput.min = String(minLen);
    lengthInput.max = String(maxLen);
    if (Number(lengthInput.value) < minLen || Number(lengthInput.value) > maxLen) {
      lengthInput.value = String(Math.min(Math.max(Number(lengthInput.value) || 5, minLen), maxLen));
    }

    langSelect.innerHTML = "";
    languageMinLengths = {};
    data.languages.forEach((lang) => {
      const option = document.createElement("option");
      option.value = lang.id;
      option.textContent = lang.label + (lang.id !== "none" ? "" : "");
      langSelect.appendChild(option);
      languageMinLengths[lang.id] = lang.minLength || minLen;
    });

    if (!langSelect.value) {
      langSelect.value = languageMinLengths[defaultLang]
        ? defaultLang
        : data.languages[0]?.id || "none";
    }
    updateLanguageConstraints(langSelect.value);
    randomBtn.disabled = langSelect.value === "none";

    guessInput.min = String(minGuesses);
    guessInput.max = String(maxGuessesAllowed);
    if (Number(guessInput.value) < minGuesses || Number(guessInput.value) > maxGuessesAllowed) {
      guessInput.value = String(defaultGuesses);
    }
  } catch (err) {
    // Ignore meta failures
  }
}

function sanitizeGuessCount(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return defaultGuesses;
  if (parsed < minGuesses) return minGuesses;
  if (parsed > maxGuessesAllowed) return maxGuessesAllowed;
  return parsed;
}

function updateShareLink(link) {
  if (!shareLinkInput) return;
  shareLinkInput.value = link;
}

async function generateLinkFromWord(word, lang, guessesCount) {
  const response = await fetch("/api/encode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word, lang })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setCreateStatus(data.error || "Could not encode word.");
    return;
  }

  await startPuzzle(data.code, data.lang, guessesCount);
}

async function handleRandom() {
  const lang = langSelect.value;
  if (lang === "none") {
    setCreateStatus("Random word requires a dictionary language.");
    return;
  }

  const length = Number(lengthInput.value);
  const minLength = getMinLengthForLang(lang);
  if (!Number.isInteger(length) || length < minLength || length > maxLen) {
    setCreateStatus(`Length must be ${minLength}-${maxLen}.`);
    return;
  }

  const response = await fetch("/api/random", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang, length })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    setCreateStatus(data.error || "Could not pick a word.");
    return;
  }

  wordInput.value = data.word;
  lengthInput.value = String(data.length);
  const guessesCount = sanitizeGuessCount(guessInput.value);
  await startPuzzle(data.code, data.lang, guessesCount);
}

function sanitizeInputWord(value) {
  return value.toUpperCase().replace(/[^A-Z]/g, "");
}

function getMinLengthForLang(lang) {
  return languageMinLengths[lang] || minLen;
}

function updateLanguageConstraints(lang) {
  const minLength = getMinLengthForLang(lang);
  if (hintEl) {
    hintEl.textContent = `A-Z only · ${minLength}-${maxLen} letters`;
  }
  lengthInput.min = String(minLength);
  if (Number(lengthInput.value) < minLength) {
    lengthInput.value = String(minLength);
  }
}

function updatePlayMeta() {
  if (!baseMeta) return;
  const strictLabel = strictMode ? " · Strict mode" : "";
  playMetaEl.textContent = `${baseMeta}${strictLabel}`;
}

function applyHighContrast(enabled) {
  document.body.classList.toggle("high-contrast", enabled);
}

async function initPlay(code, lang, guessesCount) {
  showPlay();
  document.addEventListener("keydown", handlePhysicalKey);

  const response = await fetch("/api/puzzle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, lang, guesses: guessesCount })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, message: data.error || "That link doesn't work." };
  }

  cols = data.length;
  maxGuesses = data.maxGuesses || defaultGuesses;
  puzzleCode = code.toUpperCase();
  puzzleLang = data.lang || "en";

  resetGame();

  baseMeta = `Language: ${data.label} · Length: ${cols} · ${maxGuesses} tries`;
  updatePlayMeta();
  updatedEl.textContent = "Game ready";
  updateShareLink(buildShareLink(code, puzzleLang, maxGuesses));
  return { ok: true };
}

function initCreate() {
  showCreate();
  updatedEl.textContent = "Create mode";
}

async function startPuzzle(code, lang, guessesCount) {
  maxGuesses = guessesCount || defaultGuesses;
  const link = buildShareLink(code, lang, maxGuesses);
  updateShareLink(link);
  const result = await initPlay(code, lang, guessesCount);
  if (!result.ok) {
    showCreate();
    setCreateStatus(result.message || "Could not start puzzle.");
    return;
  }
  setCreateStatus("");
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const lang = langSelect.value;
  const word = sanitizeInputWord(wordInput.value.trim());
  const guessesCount = sanitizeGuessCount(guessInput.value);

  if (!word) {
    setCreateStatus("Enter a word to encode.");
    return;
  }

  wordInput.value = word;
  lengthInput.value = String(word.length);
  await generateLinkFromWord(word, lang, guessesCount);
});

randomBtn.addEventListener("click", handleRandom);

shareCopyBtn.addEventListener("click", async () => {
  if (!shareLinkInput.value) return;
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    setMessage("Share link copied.");
  } catch (err) {
    shareLinkInput.select();
    document.execCommand("copy");
    setMessage("Share link copied.");
  }
});

if (shareInfoBtn) {
  shareInfoBtn.addEventListener("click", () => {
    openShareModal();
  });
}

if (shareModalClose) {
  shareModalClose.addEventListener("click", () => {
    closeShareModal();
  });
}

if (shareModalBackdrop) {
  shareModalBackdrop.addEventListener("click", () => {
    closeShareModal();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (isShareModalOpen()) {
    closeShareModal();
  }
});

wordInput.addEventListener("input", () => {
  const cleaned = sanitizeInputWord(wordInput.value);
  if (cleaned !== wordInput.value) {
    wordInput.value = cleaned;
  }
  if (cleaned.length) {
    lengthInput.value = String(cleaned.length);
  }
});

lengthInput.addEventListener("change", () => {
  const value = Number(lengthInput.value);
  if (Number.isNaN(value)) return;
  const minLength = getMinLengthForLang(langSelect.value);
  if (value < minLength) lengthInput.value = String(minLength);
  if (value > maxLen) lengthInput.value = String(maxLen);
});

guessInput.addEventListener("change", () => {
  guessInput.value = String(sanitizeGuessCount(guessInput.value));
});

langSelect.addEventListener("change", () => {
  randomBtn.disabled = langSelect.value === "none";
  updateLanguageConstraints(langSelect.value);
});

contrastToggle.addEventListener("change", () => {
  const enabled = contrastToggle.checked;
  applyHighContrast(enabled);
  localStorage.setItem("highContrast", String(enabled));
});

strictToggle.addEventListener("change", () => {
  strictMode = strictToggle.checked;
  localStorage.setItem("strictMode", String(strictMode));
  updatePlayMeta();
  if (strictMode) {
    setMessage("Strict mode enabled.");
  }
});

async function init() {
  await loadMeta();

  const storedContrast = localStorage.getItem("highContrast") === "true";
  const storedStrict = localStorage.getItem("strictMode") === "true";
  contrastToggle.checked = storedContrast;
  strictToggle.checked = storedStrict;
  strictMode = storedStrict;
  applyHighContrast(storedContrast);

  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get("word");
  const langParam = params.get("lang");
  const guessesParam = params.get("g");

  if (codeParam) {
    const trimmedCode = String(codeParam).trim();
    const resolvedLang = langParam
      ? String(langParam).trim().toLowerCase()
      : defaultLang;
    const availableLang = languageMinLengths[resolvedLang]
      ? resolvedLang
      : null;

    if (!trimmedCode || !/^[a-zA-Z]+$/.test(trimmedCode)) {
      showErrorPanel("That link doesn't work. Let's make a new puzzle.");
      return;
    }
    if (!availableLang) {
      showErrorPanel("That link doesn't work. Let's make a new puzzle.");
      return;
    }

    const minLength = getMinLengthForLang(availableLang);
    if (trimmedCode.length < minLength || trimmedCode.length > maxLen) {
      showErrorPanel("That link doesn't work. Let's make a new puzzle.");
      return;
    }

    let guessesCount = defaultGuesses;
    if (guessesParam !== null) {
      const parsed = Number(guessesParam);
      if (!Number.isInteger(parsed) || parsed < minGuesses || parsed > maxGuessesAllowed) {
        showErrorPanel("That link doesn't work. Let's make a new puzzle.");
        return;
      }
      guessesCount = parsed;
    }

    const link = buildShareLink(trimmedCode, availableLang, guessesCount);
    updateShareLink(link);
    const result = await initPlay(trimmedCode, availableLang, guessesCount);
    if (!result.ok) {
      showErrorPanel(result.message || "That link doesn't work. Let's make a new puzzle.");
    }
  } else {
    initCreate();
  }
}

init();
