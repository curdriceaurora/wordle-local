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
let profileState = {
  profiles: [],
  activeProfileId: null,
  stats: {}
};

const PROFILE_STORAGE_KEY = "lhw_profiles_v1";
const MAX_PROFILES = 20;
const MAX_DAILY_RESULTS_PER_PROFILE = 400;
let leaderboardDataVersion = 0;
let leaderboardCache = {
  version: -1,
  range: "",
  rows: []
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

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
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

function dateToUtcStamp(dateString) {
  const date = parseDateString(dateString);
  if (!date) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function diffDays(laterDate, earlierDate) {
  const laterStamp = dateToUtcStamp(laterDate);
  const earlierStamp = dateToUtcStamp(earlierDate);
  if (laterStamp === null || earlierStamp === null) return null;
  return Math.floor((laterStamp - earlierStamp) / (24 * 60 * 60 * 1000));
}

function shiftDate(dateString, deltaDays) {
  const date = parseDateString(dateString);
  if (!date) return null;
  date.setDate(date.getDate() + deltaDays);
  return toLocalDateString(date);
}

function loadProfileState() {
  const empty = {
    profiles: [],
    activeProfileId: null,
    stats: {},
    wasPruned: false
  };
  let wasPruned = false;
  const raw = getStoredItem(PROFILE_STORAGE_KEY);
  if (!raw) return empty;
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") return empty;
  let profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles
      .map((profile) => {
        const id = String(profile?.id || "").trim();
        const name = normalizeProfileName(profile?.name);
        const createdAt = String(profile?.createdAt || "").trim() || new Date().toISOString();
        if (!id || !name) return null;
        return { id, name, createdAt };
      })
      .filter(Boolean)
    : [];
  if (profiles.length > MAX_PROFILES) {
    profiles = profiles
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_PROFILES);
    wasPruned = true;
  }

  const rawStats = parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {};
  const stats = {};
  const knownProfileIds = new Set(profiles.map((profile) => profile.id));
  for (const profile of profiles) {
    const rawDaily = rawStats?.[profile.id]?.dailyResults;
    if (!rawDaily || typeof rawDaily !== "object") continue;
    const normalizedDaily = {};
    for (const [puzzleKey, entry] of Object.entries(rawDaily)) {
      const date = String(entry?.date || "");
      if (!parseDateString(date)) {
        wasPruned = true;
        continue;
      }
      const attempts = Number(entry?.attempts);
      const maxGuesses = Number(entry?.maxGuesses);
      normalizedDaily[String(puzzleKey)] = {
        date,
        won: Boolean(entry?.won),
        attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : null,
        maxGuesses: Number.isFinite(maxGuesses) && maxGuesses > 0 ? maxGuesses : null,
        updatedAt: String(entry?.updatedAt || "") || new Date().toISOString()
      };
    }
    if (trimDailyResults(normalizedDaily)) {
      wasPruned = true;
    }
    if (Object.keys(normalizedDaily).length) {
      stats[profile.id] = { dailyResults: normalizedDaily };
    }
  }
  if (Object.keys(rawStats).some((profileId) => !knownProfileIds.has(profileId))) {
    wasPruned = true;
  }

  const activeProfileId = profiles.some((profile) => profile.id === parsed.activeProfileId)
    ? parsed.activeProfileId
    : null;
  if (parsed.activeProfileId && !activeProfileId) {
    wasPruned = true;
  }

  return {
    profiles,
    activeProfileId,
    stats,
    wasPruned
  };
}

function saveProfileState(options = {}) {
  if (options.bumpLeaderboardVersion) {
    leaderboardDataVersion += 1;
    leaderboardCache = {
      version: -1,
      range: "",
      rows: []
    };
  }
  setStoredItem(PROFILE_STORAGE_KEY, JSON.stringify(profileState));
}

function trimDailyResults(dailyResults) {
  const entries = Object.entries(dailyResults);
  if (entries.length <= MAX_DAILY_RESULTS_PER_PROFILE) {
    return false;
  }
  entries.sort((a, b) => {
    const aDate = String(a[1]?.date || "");
    const bDate = String(b[1]?.date || "");
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    const aUpdatedAt = String(a[1]?.updatedAt || "");
    const bUpdatedAt = String(b[1]?.updatedAt || "");
    return aUpdatedAt.localeCompare(bUpdatedAt);
  });

  const pruneCount = entries.length - MAX_DAILY_RESULTS_PER_PROFILE;
  for (let i = 0; i < pruneCount; i += 1) {
    delete dailyResults[entries[i][0]];
  }
  return true;
}

function enforceProfileLimits() {
  let changed = false;
  if (profileState.profiles.length > MAX_PROFILES) {
    const sortedProfiles = profileState.profiles
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keptProfiles = sortedProfiles.slice(-MAX_PROFILES);
    const keptIds = new Set(keptProfiles.map((profile) => profile.id));
    profileState.profiles = keptProfiles;
    if (profileState.activeProfileId && !keptIds.has(profileState.activeProfileId)) {
      profileState.activeProfileId = null;
    }
    Object.keys(profileState.stats).forEach((profileId) => {
      if (!keptIds.has(profileId)) {
        delete profileState.stats[profileId];
      }
    });
    changed = true;
  }

  for (const profile of profileState.profiles) {
    const dailyResults = ensureProfileBucket(profile.id);
    if (trimDailyResults(dailyResults)) {
      changed = true;
    }
  }

  return changed;
}

function normalizeProfileName(rawName) {
  const cleaned = String(rawName || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length > 24) return "";
  if (!/^[A-Za-z][A-Za-z '\-]*$/.test(cleaned)) return "";
  return cleaned;
}

function profileIdForName(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "player";
  let nextId = base;
  let i = 2;
  while (profileState.profiles.some((profile) => profile.id === nextId)) {
    nextId = `${base}-${i}`;
    i += 1;
  }
  return nextId;
}

function getActiveProfile() {
  if (!profileState.activeProfileId) return null;
  return profileState.profiles.find((profile) => profile.id === profileState.activeProfileId) || null;
}

function ensureProfileBucket(profileId) {
  if (!profileState.stats[profileId] || typeof profileState.stats[profileId] !== "object") {
    profileState.stats[profileId] = {};
  }
  if (
    !profileState.stats[profileId].dailyResults ||
    typeof profileState.stats[profileId].dailyResults !== "object"
  ) {
    profileState.stats[profileId].dailyResults = {};
  }
  return profileState.stats[profileId].dailyResults;
}

function listProfileEntries(profileId) {
  const results = ensureProfileBucket(profileId);
  return Object.values(results)
    .map((entry) => ({
      date: String(entry?.date || ""),
      won: Boolean(entry?.won),
      attempts: Number(entry?.attempts),
      maxGuesses: Number(entry?.maxGuesses)
    }))
    .filter((entry) => parseDateString(entry.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeEntries(entries) {
  const played = entries.length;
  const wins = entries.filter((entry) => entry.won).length;
  const winRate = played ? Math.round((wins / played) * 100) : 0;
  const bestAttempts = entries
    .filter((entry) => entry.won && Number.isFinite(entry.attempts) && entry.attempts > 0)
    .reduce((best, entry) => Math.min(best, entry.attempts), Number.POSITIVE_INFINITY);

  return {
    played,
    wins,
    winRate,
    bestAttempts: Number.isFinite(bestAttempts) ? bestAttempts : null
  };
}

function computeCurrentStreak(entries) {
  if (!entries.length) return 0;
  const byDate = new Map();
  for (const entry of entries) {
    byDate.set(entry.date, Boolean(byDate.get(entry.date)) || Boolean(entry.won));
  }
  const sortedDates = Array.from(byDate.keys()).sort();
  const latestDate = sortedDates[sortedDates.length - 1];
  if (!byDate.get(latestDate)) return 0;
  const today = toLocalDateString(new Date());
  const gap = diffDays(today, latestDate);
  if (gap === null || gap > 1) return 0;

  let streak = 1;
  let cursor = latestDate;
  while (true) {
    const previous = shiftDate(cursor, -1);
    if (!previous || !byDate.get(previous)) break;
    streak += 1;
    cursor = previous;
  }
  return streak;
}

function isEntryInRange(entry, range) {
  if (range === "overall") return true;
  const today = toLocalDateString(new Date());
  if (range === "weekly") {
    const age = diffDays(today, entry.date);
    return age !== null && age >= 0 && age <= 6;
  }
  if (range === "monthly") {
    return entry.date.slice(0, 7) === today.slice(0, 7);
  }
  return true;
}

function describeRange(range) {
  if (range === "weekly") {
    return "Last 7 days (including today)";
  }
  if (range === "monthly") {
    return "Current calendar month";
  }
  return "All recorded daily games";
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
    const isActive = profile.id === profileState.activeProfileId;
    button.textContent = isActive ? `${profile.name} (active)` : profile.name;
    button.addEventListener("click", () => {
      profileState.activeProfileId = profile.id;
      saveProfileState();
      renderDailyPlayerPanels();
      setProfileStatus("");
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
  const range = leaderboardRangeEl.value || "weekly";
  leaderboardMetaEl.textContent = describeRange(range);

  let rows = leaderboardCache.rows;
  if (leaderboardCache.version !== leaderboardDataVersion || leaderboardCache.range !== range) {
    rows = profileState.profiles
      .map((profile) => {
        const allEntries = listProfileEntries(profile.id);
        const filtered = allEntries.filter((entry) => isEntryInRange(entry, range));
        const summary = summarizeEntries(filtered);
        return {
          profile,
          ...summary,
          streak: computeCurrentStreak(allEntries)
        };
      })
      .filter((row) => row.played > 0)
      .sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        if (b.played !== a.played) return b.played - a.played;
        if ((a.bestAttempts || 99) !== (b.bestAttempts || 99)) {
          return (a.bestAttempts || 99) - (b.bestAttempts || 99);
        }
        return a.profile.name.localeCompare(b.profile.name);
      });
    leaderboardCache = {
      version: leaderboardDataVersion,
      range,
      rows
    };
  }

  leaderboardBodyEl.innerHTML = "";
  if (!rows.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td class="leaderboard-empty" colspan="7">No games in this period yet.</td>';
    leaderboardBodyEl.appendChild(row);
    return;
  }

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const safeBest = row.bestAttempts ? String(row.bestAttempts) : "-";
    const values = [
      String(index + 1),
      row.profile.name,
      String(row.wins),
      String(row.played),
      `${row.winRate}%`,
      safeBest,
      String(row.streak)
    ];
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.appendChild(cell);
    });
    leaderboardBodyEl.appendChild(tr);
  });
}

function renderActivePlayerStats() {
  if (!playerStatsEl) return;
  const activeProfile = getActiveProfile();
  if (!dailyMode || !activeProfile) {
    playerStatsEl.classList.add("hidden");
    return;
  }

  const entries = listProfileEntries(activeProfile.id);
  const summary = summarizeEntries(entries);
  playerStatsEl.classList.remove("hidden");
  statPlayedEl.textContent = String(summary.played);
  statWinRateEl.textContent = `${summary.winRate}%`;
  statStreakEl.textContent = String(computeCurrentStreak(entries));
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
  keyboardEl.classList.toggle("locked", !hasActive);

  if (hasActive) {
    activePlayerNameEl.textContent = activeProfile.name;
  } else if (profileNameInputEl) {
    profileNameInputEl.focus();
  }

  renderSavedPlayers();
  renderActivePlayerStats();
  renderLeaderboard();
}

function upsertDailyResult(won, attempts, guessLimit) {
  if (!dailyMode || !dailyPuzzleKey) return;
  const activeProfile = getActiveProfile();
  if (!activeProfile) return;

  const bucket = ensureProfileBucket(activeProfile.id);
  const existing = bucket[dailyPuzzleKey];
  const normalizedAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : null;
  const next = {
    date: dailyDate,
    won: Boolean(won),
    attempts: normalizedAttempts,
    maxGuesses: Number.isInteger(guessLimit) ? guessLimit : maxGuesses,
    updatedAt: new Date().toISOString()
  };

  if (!existing) {
    bucket[dailyPuzzleKey] = next;
  } else if (existing.won && !next.won) {
    // Keep an existing win if the same daily puzzle is replayed and lost later.
    bucket[dailyPuzzleKey] = existing;
  } else if (existing.won && next.won) {
    const best = Math.min(existing.attempts || Number.POSITIVE_INFINITY, next.attempts || Number.POSITIVE_INFINITY);
    bucket[dailyPuzzleKey] = {
      ...existing,
      attempts: Number.isFinite(best) ? best : existing.attempts
    };
  } else {
    bucket[dailyPuzzleKey] = next;
  }

  if (trimDailyResults(bucket)) {
    // Keep localStorage bounded for long-running family usage.
  }
  saveProfileState({ bumpLeaderboardVersion: true });
  renderDailyPlayerPanels();
}

function createOrSelectProfile(rawName) {
  const normalizedName = normalizeProfileName(rawName);
  if (!normalizedName) {
    return {
      ok: false,
      error: "Use letters, spaces, apostrophes, or hyphens (max 24 chars)."
    };
  }

  const existing = profileState.profiles.find(
    (profile) => profile.name.toLowerCase() === normalizedName.toLowerCase()
  );
  if (existing) {
    profileState.activeProfileId = existing.id;
    saveProfileState();
    return { ok: true, profile: existing, reused: true };
  }

  const profile = {
    id: profileIdForName(normalizedName),
    name: normalizedName,
    createdAt: new Date().toISOString()
  };
  profileState.profiles.push(profile);
  profileState.activeProfileId = profile.id;
  ensureProfileBucket(profile.id);
  enforceProfileLimits();
  saveProfileState();
  return { ok: true, profile, reused: false };
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
      upsertDailyResult(true, currentRow + 1, maxGuesses);
      const suffix =
        typeof data.answerMeaning === "string" && data.answerMeaning.trim()
          ? ` Meaning: ${data.answerMeaning.trim()}`
          : "";
      setMessage(`Solved in ${currentRow + 1}/${maxGuesses}!${suffix}`);
      return;
    }

    if (currentRow === maxGuesses - 1) {
      locked = true;
      upsertDailyResult(false, maxGuesses, maxGuesses);
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
  updatedEl.textContent = "Game ready";
  updateShareLink(
    buildShareLink(code, puzzleLang, maxGuesses, {
      dailyMode,
      dailyDate
    })
  );
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
  profileFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = createOrSelectProfile(profileNameInputEl ? profileNameInputEl.value : "");
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
    saveProfileState();
    setProfileStatus("Choose an existing player or enter a new name.");
    renderDailyPlayerPanels();
  });
}

if (leaderboardRangeEl) {
  leaderboardRangeEl.addEventListener("change", () => {
    renderLeaderboard();
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
  const loadedProfileState = loadProfileState();
  profileState = {
    profiles: loadedProfileState.profiles || [],
    activeProfileId: loadedProfileState.activeProfileId || null,
    stats: loadedProfileState.stats || {}
  };
  if (enforceProfileLimits() || loadedProfileState.wasPruned) {
    saveProfileState({ bumpLeaderboardVersion: true });
  }

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
