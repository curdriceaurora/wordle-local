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
const profilePanelEl = document.getElementById("profilePanel");
const profileFormEl = document.getElementById("profileForm");
const profileNameInputEl = document.getElementById("profileNameInput");
const profileStatusEl = document.getElementById("profileStatus");
const savedPlayersWrapEl = document.getElementById("savedPlayersWrap");
const savedPlayersEl = document.getElementById("savedPlayers");
const activePlayerWrapEl = document.getElementById("activePlayerWrap");
const activePlayerNameEl = document.getElementById("activePlayerName");
const switchPlayerBtnEl = document.getElementById("switchPlayerBtn");
const playerStatsEl = document.getElementById("playerStats");
const statPlayedEl = document.getElementById("statPlayed");
const statWinRateEl = document.getElementById("statWinRate");
const statStreakEl = document.getElementById("statStreak");
const statBestEl = document.getElementById("statBest");
const leaderboardPanelEl = document.getElementById("leaderboardPanel");
const leaderboardRangeEl = document.getElementById("leaderboardRange");
const leaderboardMetaEl = document.getElementById("leaderboardMeta");
const leaderboardBodyEl = document.getElementById("leaderboardBody");

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
let dailyMode = false;
let dailyDate = "";
let dailyPuzzleKey = "";
let physicalKeyboardBound = false;
let perfLogging = false;
let tileGrid = [];
let keyboardKeyEls = new Map();
let profileState = {
  profiles: [],
  activeProfileId: null,
  summaries: Object.create(null),
  loading: false
};

const KEYBOARD_LAYOUT = Object.freeze([
  Object.freeze(["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"]),
  Object.freeze(["A", "S", "D", "F", "G", "H", "J", "K", "L"]),
  Object.freeze(["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACK"])
]);
const KEY_STATUS_PRIORITY = Object.freeze({ absent: 1, present: 2, correct: 3 });
const LEADERBOARD_RANGE = Object.freeze({
  weekly: "weekly",
  monthly: "monthly",
  overall: "overall"
});
const STATS_REQUEST_ERROR = "Stats unavailable right now. Try again soon.";
let leaderboardState = {
  range: LEADERBOARD_RANGE.weekly,
  description: "",
  rows: [],
  dayKey: "",
  loading: false
};

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

function startPerfMeasure(label) {
  if (!perfLogging || typeof performance === "undefined") return null;
  return { label, start: performance.now() };
}

function endPerfMeasure(measure, details = "") {
  if (!measure) return;
  const elapsed = performance.now() - measure.start;
  const suffix = details ? ` ${details}` : "";
  console.debug(`[perf] ${measure.label} ${elapsed.toFixed(2)}ms${suffix}`);
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

function getStoredItem(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function setStoredItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    return false;
  }
}

function toLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateString(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (response.ok) {
    return payload;
  }
  const err = new Error(
    typeof payload?.error === "string" && payload.error.trim() ? payload.error : STATS_REQUEST_ERROR
  );
  err.status = response.status;
  throw err;
}

function normalizeProfileName(rawName) {
  const cleaned = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length > 24) return "";
  if (!/^[A-Za-z][A-Za-z '-]*$/.test(cleaned)) return "";
  return cleaned;
}

function getActiveProfile() {
  if (!profileState.activeProfileId) return null;
  return profileState.profiles.find((profile) => profile.id === profileState.activeProfileId) || null;
}

function createEmptySummaryBucket() {
  return {
    streak: 0,
    overall: { played: 0, wins: 0, winRate: 0, bestAttempts: null },
    weekly: { played: 0, wins: 0, winRate: 0, bestAttempts: null },
    monthly: { played: 0, wins: 0, winRate: 0, bestAttempts: null },
    totalSubmissions: 0
  };
}

function getProfileSummary(profileId) {
  const summary = profileState.summaries[profileId];
  return summary && typeof summary === "object" ? summary : createEmptySummaryBucket();
}

function upsertKnownProfile(profile) {
  const id = String(profile?.id || "").trim();
  const name = normalizeProfileName(profile?.name);
  if (!id || !name) return null;

  const existing = profileState.profiles.find((item) => item.id === id);
  if (existing) {
    existing.name = name;
    return existing;
  }

  const normalized = {
    id,
    name,
    createdAt: String(profile?.createdAt || "").trim() || new Date().toISOString()
  };
  profileState.profiles.push(normalized);
  return normalized;
}

function describeRange(range) {
  if (range === LEADERBOARD_RANGE.weekly) {
    return "Last 7 days (including today)";
  }
  if (range === LEADERBOARD_RANGE.monthly) {
    return "Current calendar month";
  }
  return "All recorded daily games";
}

async function refreshProfileSummary(profileId) {
  if (!profileId) return;
  const payload = await requestJson(`/api/stats/profile/${encodeURIComponent(profileId)}`);
  if (payload?.profile) {
    upsertKnownProfile(payload.profile);
  }
  profileState.summaries[profileId] =
    payload?.summary && typeof payload.summary === "object"
      ? payload.summary
      : createEmptySummaryBucket();
}

async function refreshLeaderboard(range) {
  const selectedRange =
    range || (leaderboardRangeEl ? leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly : LEADERBOARD_RANGE.weekly);
  leaderboardState.loading = true;
  renderLeaderboard();

  const payload = await requestJson(`/api/stats/leaderboard?range=${encodeURIComponent(selectedRange)}`);
  leaderboardState = {
    range: payload?.range || selectedRange,
    description: payload?.description || describeRange(selectedRange),
    rows: Array.isArray(payload?.rows) ? payload.rows : [],
    dayKey: String(payload?.dayKey || ""),
    loading: false
  };

  leaderboardState.rows.forEach((row) => {
    upsertKnownProfile({ id: row?.profileId, name: row?.name });
  });
}

async function refreshStatsPanels(options = {}) {
  const activeProfileId = String(options.activeProfileId || profileState.activeProfileId || "").trim();
  let profileError = "";
  let leaderboardError = "";

  if (activeProfileId) {
    try {
      await refreshProfileSummary(activeProfileId);
    } catch (err) {
      profileError = err?.message || STATS_REQUEST_ERROR;
    }
  }

  try {
    await refreshLeaderboard(options.range);
  } catch (err) {
    leaderboardError = err?.message || STATS_REQUEST_ERROR;
    leaderboardState.loading = false;
    leaderboardState.rows = [];
    leaderboardState.description = describeRange(
      options.range || leaderboardState.range || LEADERBOARD_RANGE.weekly
    );
  }

  if (profileError && leaderboardError) {
    setProfileStatus(`${profileError} ${leaderboardError}`);
    return;
  }
  if (profileError || leaderboardError) {
    setProfileStatus(profileError || leaderboardError);
    return;
  }
  setProfileStatus("");
}

async function selectActiveProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id) return;
  profileState.activeProfileId = id;
  profileState.loading = true;
  renderDailyPlayerPanels();
  await refreshStatsPanels({ activeProfileId: id });
  profileState.loading = false;
  renderDailyPlayerPanels();
}

function renderSavedPlayers() {
  if (!savedPlayersWrapEl || !savedPlayersEl) return;
  savedPlayersEl.innerHTML = "";
  if (!profileState.profiles.length) {
    savedPlayersWrapEl.classList.add("hidden");
    return;
  }
  savedPlayersWrapEl.classList.remove("hidden");
  profileState.profiles.forEach((profile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-chip";
    button.disabled = profileState.loading;
    const isActive = profile.id === profileState.activeProfileId;
    button.textContent = isActive ? `${profile.name} (active)` : profile.name;
    button.addEventListener("click", () => {
      selectActiveProfile(profile.id);
    });
    savedPlayersEl.appendChild(button);
  });
}

function setProfileStatus(text) {
  if (!profileStatusEl) return;
  profileStatusEl.textContent = text;
}

function renderLeaderboard() {
  if (!leaderboardPanelEl || !leaderboardBodyEl || !leaderboardRangeEl || !leaderboardMetaEl) return;
  if (!dailyMode) {
    leaderboardPanelEl.classList.add("hidden");
    return;
  }

  leaderboardPanelEl.classList.remove("hidden");
  leaderboardRangeEl.disabled = profileState.loading || leaderboardState.loading;
  const range = leaderboardRangeEl.value || leaderboardState.range || LEADERBOARD_RANGE.weekly;
  leaderboardMetaEl.textContent = leaderboardState.loading
    ? "Loading leaderboard..."
    : leaderboardState.description || describeRange(range);
  const renderTimer = startPerfMeasure("ui.render.leaderboard");
  const rows = Array.isArray(leaderboardState.rows) ? leaderboardState.rows : [];

  leaderboardBodyEl.innerHTML = "";
  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td class="leaderboard-empty" colspan="7">No games in this period yet.</td>';
    leaderboardBodyEl.appendChild(row);
    endPerfMeasure(renderTimer, "rows=0");
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const safeBest = row.bestAttempts ? String(row.bestAttempts) : "-";
    const values = [
      String(row.rank || index + 1),
      String(row.name || "-"),
      String(row.wins || 0),
      String(row.played || 0),
      `${Number.isFinite(row.winRate) ? row.winRate : 0}%`,
      safeBest,
      String(row.streak || 0)
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.appendChild(cell);
    });
    fragment.appendChild(tr);
  });
  leaderboardBodyEl.appendChild(fragment);
  endPerfMeasure(renderTimer, `rows=${rows.length}`);
}

function renderActivePlayerStats() {
  if (!playerStatsEl) return;
  const activeProfile = getActiveProfile();
  if (!dailyMode || !activeProfile) {
    playerStatsEl.classList.add("hidden");
    return;
  }

  const profileSummary = getProfileSummary(activeProfile.id);
  const summary = profileSummary.overall || createEmptySummaryBucket().overall;
  playerStatsEl.classList.remove("hidden");
  statPlayedEl.textContent = String(summary.played || 0);
  statWinRateEl.textContent = `${summary.winRate || 0}%`;
  statStreakEl.textContent = String(profileSummary.streak || 0);
  statBestEl.textContent = summary.bestAttempts ? String(summary.bestAttempts) : "-";
}

function renderDailyPlayerPanels() {
  if (!profilePanelEl || !profileFormEl || !activePlayerWrapEl || !activePlayerNameEl || !switchPlayerBtnEl) return;
  if (!dailyMode) {
    profilePanelEl.classList.add("hidden");
    leaderboardPanelEl.classList.add("hidden");
    keyboardEl.classList.remove("locked");
    return;
  }

  profilePanelEl.classList.remove("hidden");
  const activeProfile = getActiveProfile();
  const hasActive = Boolean(activeProfile);
  profileFormEl.classList.toggle("hidden", hasActive);
  activePlayerWrapEl.classList.toggle("hidden", !hasActive);
  switchPlayerBtnEl.classList.toggle("hidden", !hasActive);
  switchPlayerBtnEl.disabled = profileState.loading;
  if (profileNameInputEl) {
    profileNameInputEl.disabled = profileState.loading;
  }
  const submitButton = profileFormEl.querySelector("button[type=submit]");
  if (submitButton) {
    submitButton.disabled = profileState.loading;
  }
  keyboardEl.classList.toggle("locked", !hasActive || profileState.loading);

  if (hasActive) {
    activePlayerNameEl.textContent = activeProfile.name;
  } else if (profileNameInputEl) {
    profileNameInputEl.focus();
  }

  renderSavedPlayers();
  renderActivePlayerStats();
  renderLeaderboard();
}

async function upsertDailyResult(won, attempts, guessLimit) {
  if (!dailyMode || !dailyPuzzleKey) return;
  const activeProfile = getActiveProfile();
  if (!activeProfile) return;

  profileState.loading = true;
  renderDailyPlayerPanels();

  try {
    const payload = await requestJson("/api/stats/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: activeProfile.id,
        dailyKey: dailyPuzzleKey,
        won: Boolean(won),
        attempts: won ? attempts : null,
        maxGuesses: Number.isInteger(guessLimit) ? guessLimit : maxGuesses
      })
    });
    if (payload?.retained === false) {
      setProfileStatus("Result saved, but older history may have been pruned.");
    }
    await refreshStatsPanels({ activeProfileId: activeProfile.id });
  } catch (err) {
    setProfileStatus(err?.message || STATS_REQUEST_ERROR);
  } finally {
    profileState.loading = false;
    renderDailyPlayerPanels();
  }
}

async function createOrSelectProfile(rawName) {
  const normalizedName = normalizeProfileName(rawName);
  if (!normalizedName) {
    return {
      ok: false,
      error: "Use letters, spaces, apostrophes, or hyphens (max 24 chars)."
    };
  }

  profileState.loading = true;
  renderDailyPlayerPanels();

  try {
    const payload = await requestJson("/api/stats/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: normalizedName })
    });
    const profile = upsertKnownProfile(payload?.profile);
    const activeId = String(payload?.playerId || profile?.id || "").trim();
    if (!profile || !activeId) {
      return { ok: false, error: STATS_REQUEST_ERROR };
    }

    profileState.activeProfileId = activeId;
    await refreshStatsPanels({ activeProfileId: activeId });
    return {
      ok: true,
      profile: getActiveProfile() || profile,
      reused: Boolean(payload?.reused)
    };
  } catch (err) {
    return { ok: false, error: err?.message || STATS_REQUEST_ERROR };
  } finally {
    profileState.loading = false;
    renderDailyPlayerPanels();
  }
}

function buildBoard() {
  boardEl.innerHTML = "";
  tileGrid = Array.from({ length: maxGuesses }, () => Array(cols).fill(null));
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
      tileGrid[r][c] = tile;
    }
    boardEl.appendChild(row);
  }
}

function buildKeyboard() {
  keyboardEl.innerHTML = "";
  keyboardKeyEls = new Map();
  KEYBOARD_LAYOUT.forEach((rowKeys, rowIndex) => {
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
      if (key.length === 1) {
        keyboardKeyEls.set(key, button);
      }
    });
    keyboardEl.appendChild(rowEl);
  });
}

function getTile(row, col) {
  if (row < 0 || row >= tileGrid.length) return null;
  if (col < 0 || col >= cols) return null;
  return tileGrid[row][col];
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
    if (!tile) continue;
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
  const changedLetters = new Set();
  for (let i = 0; i < guess.length; i += 1) {
    const letter = guess[i];
    const status = result[i];
    const current = keyStatus[letter];
    if (!current || KEY_STATUS_PRIORITY[status] > KEY_STATUS_PRIORITY[current]) {
      keyStatus[letter] = status;
      changedLetters.add(letter);
    }
  }
  changedLetters.forEach((key) => {
    const keyEl = keyboardKeyEls.get(key);
    if (!keyEl) return;
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
  const submitTimer = startPerfMeasure("ui.submitGuess");

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
      await upsertDailyResult(true, currentRow + 1, maxGuesses);
      const suffix =
        typeof data.answerMeaning === "string" && data.answerMeaning.trim()
          ? ` Meaning: ${data.answerMeaning.trim()}`
          : "";
      setMessage(`Solved in ${currentRow + 1}/${maxGuesses}!${suffix}`);
      return;
    }

    if (currentRow === maxGuesses - 1) {
      locked = true;
      await upsertDailyResult(false, maxGuesses, maxGuesses);
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
    endPerfMeasure(submitTimer, `row=${currentRow + 1}`);
  }
}

function handleKey(rawKey) {
  if (locked || busy || profileState.loading) return;
  if (dailyMode && !getActiveProfile()) {
    setMessage("Pick a player name to start this daily game.");
    return;
  }

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

function buildShareLink(code, lang, guessesCount, options = {}) {
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
  const includeDaily = options.dailyMode !== undefined ? options.dailyMode : dailyMode;
  const shareDay = options.dailyDate !== undefined ? options.dailyDate : dailyDate;
  if (includeDaily) {
    url.searchParams.set("daily", "1");
    if (shareDay) {
      url.searchParams.set("day", shareDay);
    }
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
    perfLogging = Boolean(data.perfLogging);

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

async function initPlay(code, lang, guessesCount, options = {}) {
  const initTimer = startPerfMeasure("ui.initPlay");
  showPlay();
  if (!physicalKeyboardBound) {
    document.addEventListener("keydown", handlePhysicalKey);
    physicalKeyboardBound = true;
  }

  const response = await fetch("/api/puzzle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, lang, guesses: guessesCount })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    endPerfMeasure(initTimer, "failed");
    return { ok: false, message: data.error || "That link doesn't work." };
  }

  cols = data.length;
  maxGuesses = data.maxGuesses || defaultGuesses;
  puzzleCode = code.toUpperCase();
  puzzleLang = data.lang || "en";
  dailyMode = Boolean(options.dailyMode);
  dailyDate = options.dailyDate || toLocalDateString(new Date());
  dailyPuzzleKey = dailyMode ? `${dailyDate}|${puzzleLang}|${puzzleCode}` : "";

  resetGame();

  const dailyPrefix = dailyMode ? `Daily (${dailyDate}) · ` : "";
  baseMeta = `${dailyPrefix}Language: ${data.label} · Length: ${cols} · ${maxGuesses} tries`;
  updatePlayMeta();
  renderDailyPlayerPanels();
  if (dailyMode) {
    try {
      await refreshStatsPanels({
        range: leaderboardRangeEl ? leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly : LEADERBOARD_RANGE.weekly
      });
    } catch (err) {
      console.error("Failed to refresh stats panels for daily puzzle:", err);
      window.alert("Couldn't load leaderboard and profile stats for the daily puzzle. You can still play the game.");
    }
    renderDailyPlayerPanels();
  }
  updatedEl.textContent = "Game ready";
  updateShareLink(
    buildShareLink(code, puzzleLang, maxGuesses, {
      dailyMode,
      dailyDate
    })
  );
  endPerfMeasure(initTimer, `cols=${cols} guesses=${maxGuesses}`);
  return { ok: true };
}

function initCreate() {
  dailyMode = false;
  dailyDate = "";
  dailyPuzzleKey = "";
  renderDailyPlayerPanels();
  showCreate();
  updatedEl.textContent = "Create mode";
}

async function startPuzzle(code, lang, guessesCount) {
  maxGuesses = guessesCount || defaultGuesses;
  const link = buildShareLink(code, lang, maxGuesses, {
    dailyMode: false,
    dailyDate: ""
  });
  updateShareLink(link);
  const result = await initPlay(code, lang, guessesCount, {
    dailyMode: false,
    dailyDate: ""
  });
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

if (profileFormEl) {
  profileFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await createOrSelectProfile(profileNameInputEl ? profileNameInputEl.value : "");
    if (!result.ok) {
      setProfileStatus(result.error);
      return;
    }
    if (profileNameInputEl) {
      profileNameInputEl.value = "";
    }
    setProfileStatus(result.reused ? `Welcome back, ${result.profile.name}.` : `Player ${result.profile.name} added.`);
    renderDailyPlayerPanels();
  });
}

if (switchPlayerBtnEl) {
  switchPlayerBtnEl.addEventListener("click", () => {
    profileState.activeProfileId = null;
    setProfileStatus("Choose an existing player or enter a new name.");
    renderDailyPlayerPanels();
  });
}

if (leaderboardRangeEl) {
  leaderboardRangeEl.addEventListener("change", async () => {
    if (!dailyMode) return;
    try {
      await refreshLeaderboard(leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly);
      setProfileStatus("");
    } catch (err) {
      setProfileStatus(err?.message || STATS_REQUEST_ERROR);
      leaderboardState.loading = false;
      leaderboardState.rows = [];
      leaderboardState.description = describeRange(
        leaderboardRangeEl.value || leaderboardState.range || LEADERBOARD_RANGE.weekly
      );
    }
    renderDailyPlayerPanels();
  });
}

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
  setStoredItem("highContrast", String(enabled));
});

strictToggle.addEventListener("change", () => {
  strictMode = strictToggle.checked;
  setStoredItem("strictMode", String(strictMode));
  updatePlayMeta();
  if (strictMode) {
    setMessage("Strict mode enabled.");
  }
});

async function init() {
  await loadMeta();
  profileState = {
    profiles: [],
    activeProfileId: null,
    summaries: Object.create(null),
    loading: false
  }
  leaderboardState = {
    range: leaderboardRangeEl ? leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly : LEADERBOARD_RANGE.weekly,
    description: "",
    rows: [],
    dayKey: "",
    loading: false
  };

  const storedContrast = getStoredItem("highContrast") === "true";
  const storedStrict = getStoredItem("strictMode") === "true";
  contrastToggle.checked = storedContrast;
  strictToggle.checked = storedStrict;
  strictMode = storedStrict;
  applyHighContrast(storedContrast);

  const params = new URLSearchParams(window.location.search);
  const codeParam = params.get("word");
  const langParam = params.get("lang");
  const guessesParam = params.get("g");
  const dailyParam = params.get("daily");
  const dayParam = params.get("day");

  if (codeParam) {
    const trimmedCode = String(codeParam).trim();
    const resolvedLang = langParam
      ? String(langParam).trim().toLowerCase()
      : defaultLang;
    const isDailyFromLink = dailyParam === "1";
    const resolvedDailyDate = isDailyFromLink
      ? (dayParam ? String(dayParam).trim() : toLocalDateString(new Date()))
      : "";
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
    if (isDailyFromLink && !parseDateString(resolvedDailyDate)) {
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

    const link = buildShareLink(trimmedCode, availableLang, guessesCount, {
      dailyMode: isDailyFromLink,
      dailyDate: resolvedDailyDate
    });
    updateShareLink(link);
    const result = await initPlay(trimmedCode, availableLang, guessesCount, {
      dailyMode: isDailyFromLink,
      dailyDate: resolvedDailyDate
    });
    if (!result.ok) {
      showErrorPanel(result.message || "That link doesn't work. Let's make a new puzzle.");
    }
  } else {
    initCreate();
  }
}

init();
