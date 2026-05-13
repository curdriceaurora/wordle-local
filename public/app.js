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
const themeSelect = document.getElementById("themeSelect");
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
let themePreference = "system";
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
// Deploy-capability flags from /api/meta. Default to enabled so a
// missing /api/meta (older server) doesn't accidentally hide working
// features; the Vercel deploy turns them off explicitly.
let deployCaps = {
  dailyWordEnabled: true,
  leaderboardEnabled: true,
  challengesEnabled: true,
  notificationsEnabled: true
};
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
const STATS_DEGRADED_MESSAGE =
  "Leaderboard and player stats are temporarily unavailable. You can still play this puzzle.";
const THEME_STORAGE_KEY = "themePreference";
const THEME_PREFERENCES = Object.freeze({
  SYSTEM: "system",
  DARK: "dark",
  LIGHT: "light"
});
const VALID_THEME_PREFERENCES = new Set(Object.values(THEME_PREFERENCES));
const colorSchemeMediaQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;
let leaderboardState = {
  range: LEADERBOARD_RANGE.weekly,
  description: "",
  rows: [],
  dayKey: "",
  loading: false
};
let statsServiceUnavailable = false;

// Use this instead of `statsServiceUnavailable = false` anywhere a
// gameplay path resets the runtime "stats backend is down" flag.
// On a deploy that doesn't ship /api/stats/* (`leaderboardEnabled:false`
// in /api/meta), the flag must stay locked-on; otherwise the next
// initPlay/initCreate would clear it and the daily share path would
// fire /api/stats/leaderboard → 404 STATIC_DEPLOY_ENDPOINT_MISSING.
function clearStatsServiceUnavailable() {
  if (deployCaps.leaderboardEnabled === false) return;
  statsServiceUnavailable = false;
}

// Feature-detect `inert` (Chrome/Edge 102+, Safari 15.5+, FF 112+).
// In the rare browser/AT combo that doesn't support inert, falling back
// to CSS `visibility:hidden` alone leaves the Close button reachable in
// some screen-reader walkers. We explicitly tabindex="-1" each focusable
// descendant as belt-and-braces (and stash the prior tabindex in a
// data-* attribute so reopening can restore it verbatim).
const SUPPORTS_INERT =
  typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;

function setShareModalInactive(inactive) {
  if (!shareModal) return;
  // Always toggle the `inert` attribute so DOM state mirrors the logical
  // active/inactive intent regardless of browser support. On
  // inert-supporting browsers this is the entire fix; on browsers where
  // `inert` is silently ignored, the attribute is still correct for any
  // future polyfill / feature-detect callsite that reads it (including
  // our own tests). Inert-supporting browsers (Chrome/Edge 102+, Safari
  // 15.5+, Firefox 112+) cover the modern fleet.
  if (inactive) shareModal.setAttribute("inert", "");
  else shareModal.removeAttribute("inert");

  if (SUPPORTS_INERT) return;

  // Belt-and-braces fallback for the long tail: explicitly tab-isolate
  // every focusable descendant so a Tab walker can't land on the Close
  // button. CSS visibility:hidden + opacity:0 already removes them
  // visually, but some AT × browser combos still announce focusables
  // across visibility:hidden if keyboard nav reaches them. Sentinel
  // "__none__" remembers prior absence so open() restores cleanly.
  const focusables = shareModal.querySelectorAll(
    'a[href], button, input, select, textarea, [tabindex]'
  );
  focusables.forEach((el) => {
    if (inactive) {
      const cur = el.getAttribute("tabindex");
      el.setAttribute("data-inert-tabindex", cur === null ? "__none__" : cur);
      el.setAttribute("tabindex", "-1");
    } else {
      const prev = el.getAttribute("data-inert-tabindex");
      if (prev !== null) {
        if (prev === "__none__") el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", prev);
        el.removeAttribute("data-inert-tabindex");
      }
    }
  });
}

function isShareModalOpen() {
  return Boolean(shareModal && shareModal.classList.contains("is-open"));
}

function openShareModal() {
  if (!shareModal) return;
  lastFocusedElement = document.activeElement;
  shareModal.classList.add("is-open");
  // Switch from `inert` (focus + AT blocked) to live. Using `inert`
  // instead of `aria-hidden=true` avoids the aria-hidden-focus
  // violation: an aria-hidden subtree mustn't contain focusable
  // descendants (the Close button is one), but `inert` properly
  // suspends them without the contradiction. Browsers without `inert`
  // get the tabindex-fallback inside setShareModalInactive.
  setShareModalInactive(false);
  if (shareModalClose) {
    shareModalClose.focus();
  }
}

function closeShareModal() {
  if (!shareModal) return;
  shareModal.classList.remove("is-open");
  setShareModalInactive(true);
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
    lastFocusedElement.focus();
  }
}

// Apply the fallback at module load. On inert-supporting browsers
// this is a no-op (`inert` is already on the element in HTML). On
// non-supporting browsers, it tab-isolates the modal's focusables so
// Tab doesn't land on the Close button before any user opens the modal.
if (!SUPPORTS_INERT) {
  setShareModalInactive(true);
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

function setHiddenState(element, hidden) {
  if (!element) return;
  element.classList.toggle("hidden", hidden);
  element.style.display = hidden ? "none" : "";
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
  // The link-failure message is owned by JS (it's never in markup),
  // so localize it here at render time. Callers pass `null` for the
  // generic case so this function can pick the localized default.
  // The only callers passing an explicit string forward a
  // server-supplied `data.error` from /api/puzzle (initPlay's
  // result.message). Today /api/puzzle still returns English error
  // strings — it isn't wired through translateForRequest yet, so the
  // forwarded text is English regardless of UI locale. That gap is
  // tracked separately; when that route is migrated, no change is
  // needed here because the forwarded string will already be
  // localized at the source.
  const fallbackMsg = "That link doesn't work. Let's make a new puzzle.";
  errorMessageEl.textContent = message
    || (window.i18n ? window.i18n.t("error.linkFailed") : fallbackMsg);

  let remaining = 10;
  const fmtCountdown = (n) => (window.i18n
    ? window.i18n.t("error.goingBack", { seconds: n })
    : `Going back in ${n}s...`);
  errorCountdownEl.textContent = fmtCountdown(remaining);
  errorTimer = setInterval(() => {
    remaining -= 1;
    errorCountdownEl.textContent = fmtCountdown(remaining);
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

function isStatsServiceUnavailableError(err) {
  const status = Number(err?.status || 0);
  if (status >= 500) {
    return true;
  }
  const message = String(err?.message || "").toLowerCase();
  return message.includes("stats unavailable") || message.includes("stats service unavailable");
}

function enableStatsDegradedMode() {
  if (!dailyMode || statsServiceUnavailable) {
    return;
  }
  statsServiceUnavailable = true;
  profileState.loading = false;
  leaderboardState.loading = false;
  setProfileStatus(STATS_DEGRADED_MESSAGE);
  setMessage(STATS_DEGRADED_MESSAGE);
  setSrStatus(STATS_DEGRADED_MESSAGE);
  renderDailyPlayerPanels();
}

// Mirror of the server-side validator in lib/profile-name.js
// (issue #174). Must stay in sync — the server rejects identically
// so a name accepted here will always be accepted on submit. Without
// this mirror, the client would block server-valid names (`José`,
// `李明`, 25-32 char) before the request leaves the page. Codex P2
// review on PR #180.
//
// Whitespace normalization collapses only LITERAL spaces (` +`, not
// `\s+`) so embedded tabs/newlines survive trim() and get rejected
// by NAME_PATTERN rather than silently flattening to a valid space.
// Length check uses Array.from(...).length to count Unicode
// codepoints — bare `.length` is UTF-16 units and would over-count
// any astral-plane letter (e.g. CJK Extension B) that the regex's
// `{0,31}` codepoint quantifier would accept. Same fix as the two
// server callers (server.js + lib/leaderboard-store.js).
const PROFILE_NAME_LENGTH_MAX = 32;
const PROFILE_NAME_PATTERN = /^\p{L}[\p{L}\p{M}' -]{0,31}$/u;
function normalizeProfileName(rawName) {
  const cleaned = String(rawName || "").trim().replace(/ +/g, " ");
  if (!cleaned) return "";
  if (Array.from(cleaned).length > PROFILE_NAME_LENGTH_MAX) return "";
  if (!PROFILE_NAME_PATTERN.test(cleaned)) return "";
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
  if (!profileId || statsServiceUnavailable) return;
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
  if (statsServiceUnavailable) {
    leaderboardState.loading = false;
    renderLeaderboard();
    return;
  }
  const selectedRange =
    range || (leaderboardRangeEl ? leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly : LEADERBOARD_RANGE.weekly);
  leaderboardState.loading = true;
  renderLeaderboard();

  try {
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
  } finally {
    leaderboardState.loading = false;
    renderLeaderboard();
  }
}

async function refreshStatsPanels(options = {}) {
  if (statsServiceUnavailable) {
    return;
  }
  const activeProfileId = String(options.activeProfileId || profileState.activeProfileId || "").trim();
  let profileError = "";
  let leaderboardError = "";
  let profileFailure = null;
  let leaderboardFailure = null;

  if (activeProfileId) {
    try {
      await refreshProfileSummary(activeProfileId);
    } catch (err) {
      profileFailure = err;
      profileError = err?.message || STATS_REQUEST_ERROR;
    }
  }

  try {
    await refreshLeaderboard(options.range);
  } catch (err) {
    leaderboardFailure = err;
    leaderboardError = err?.message || STATS_REQUEST_ERROR;
    leaderboardState.loading = false;
    leaderboardState.rows = [];
    leaderboardState.description = describeRange(
      options.range || leaderboardState.range || LEADERBOARD_RANGE.weekly
    );
  }

  if (isStatsServiceUnavailableError(profileFailure) || isStatsServiceUnavailableError(leaderboardFailure)) {
    enableStatsDegradedMode();
    return;
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
    setHiddenState(savedPlayersWrapEl, true);
    return;
  }
  setHiddenState(savedPlayersWrapEl, false);
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

// Shared leaderboard-table partial (issue #175). Both the play
// (daily) leaderboard and the challenge leaderboard render the same
// <tbody> shape (one <tr> per row, one <td> per column) with
// different column sets — 7 cols for play (rank/name/wins/played/
// win%/best/streak) and 5 cols for challenge (rank/name/score/
// solved/time). The shared helper builds rows from a `cols` config
// so the row-construction code lives in one place; each caller
// passes its own column accessors + empty-state copy. Caller is
// responsible for the surrounding <table><thead> chrome and for
// showing/hiding the panel around it.
function renderLeaderboardTable(tbodyEl, options) {
  const { rows, cols, emptyText, emptyClass } = options;
  tbodyEl.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    if (emptyClass) td.className = emptyClass;
    td.colSpan = cols.length;
    td.textContent = emptyText;
    tr.appendChild(td);
    tbodyEl.appendChild(tr);
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    cols.forEach((col) => {
      const cell = document.createElement("td");
      cell.textContent = String(col.value(row, index));
      tr.appendChild(cell);
    });
    fragment.appendChild(tr);
  });
  tbodyEl.appendChild(fragment);
}

function renderLeaderboard() {
  if (!leaderboardPanelEl || !leaderboardBodyEl || !leaderboardRangeEl || !leaderboardMetaEl) return;
  if (!dailyMode || statsServiceUnavailable) {
    setHiddenState(leaderboardPanelEl, true);
    return;
  }

  setHiddenState(leaderboardPanelEl, false);
  leaderboardRangeEl.disabled = profileState.loading || leaderboardState.loading;
  const range = leaderboardRangeEl.value || leaderboardState.range || LEADERBOARD_RANGE.weekly;
  leaderboardMetaEl.textContent = leaderboardState.loading
    ? "Loading leaderboard..."
    : leaderboardState.description || describeRange(range);
  const renderTimer = startPerfMeasure("ui.render.leaderboard");
  const rows = Array.isArray(leaderboardState.rows) ? leaderboardState.rows : [];

  renderLeaderboardTable(leaderboardBodyEl, {
    rows,
    emptyText: "No games in this period yet.",
    emptyClass: "leaderboard-empty",
    cols: [
      { value: (row, i) => String(row.rank || i + 1) },
      { value: (row) => String(row.name || "-") },
      { value: (row) => String(row.wins || 0) },
      { value: (row) => String(row.played || 0) },
      { value: (row) => `${Number.isFinite(row.winRate) ? row.winRate : 0}%` },
      { value: (row) => (row.bestAttempts ? String(row.bestAttempts) : "-") },
      { value: (row) => String(row.streak || 0) }
    ]
  });
  endPerfMeasure(renderTimer, `rows=${rows.length}`);
}

function renderActivePlayerStats() {
  if (!playerStatsEl) return;
  const activeProfile = getActiveProfile();
  if (!dailyMode || !activeProfile) {
    setHiddenState(playerStatsEl, true);
    return;
  }

  const profileSummary = getProfileSummary(activeProfile.id);
  const summary = profileSummary.overall || createEmptySummaryBucket().overall;
  setHiddenState(playerStatsEl, false);
  statPlayedEl.textContent = String(summary.played || 0);
  statWinRateEl.textContent = `${summary.winRate || 0}%`;
  statStreakEl.textContent = String(profileSummary.streak || 0);
  statBestEl.textContent = summary.bestAttempts ? String(summary.bestAttempts) : "-";
}

function renderDailyPlayerPanels() {
  if (!profilePanelEl || !profileFormEl || !activePlayerWrapEl || !activePlayerNameEl || !switchPlayerBtnEl) return;
  if (!dailyMode) {
    setHiddenState(profilePanelEl, true);
    setHiddenState(leaderboardPanelEl, true);
    keyboardEl.classList.remove("locked");
    return;
  }

  if (statsServiceUnavailable) {
    setHiddenState(profilePanelEl, true);
    setHiddenState(leaderboardPanelEl, true);
    keyboardEl.classList.remove("locked");
    return;
  }

  setHiddenState(profilePanelEl, false);
  const activeProfile = getActiveProfile();
  const hasActive = Boolean(activeProfile);
  setHiddenState(profileFormEl, hasActive);
  setHiddenState(activePlayerWrapEl, !hasActive);
  setHiddenState(switchPlayerBtnEl, !hasActive);
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
  }

  renderSavedPlayers();
  renderActivePlayerStats();
  renderLeaderboard();
}

async function upsertDailyResult(won, attempts, guessLimit) {
  if (!dailyMode || !dailyPuzzleKey || statsServiceUnavailable) return;
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
    if (isStatsServiceUnavailableError(err)) {
      enableStatsDegradedMode();
      return;
    }
    setProfileStatus(err?.message || STATS_REQUEST_ERROR);
  } finally {
    profileState.loading = false;
    renderDailyPlayerPanels();
  }
}

async function createOrSelectProfile(rawName) {
  if (statsServiceUnavailable) {
    return {
      ok: false,
      error: STATS_DEGRADED_MESSAGE
    };
  }
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
    if (isStatsServiceUnavailableError(err)) {
      enableStatsDegradedMode();
      return { ok: false, error: STATS_DEGRADED_MESSAGE };
    }
    return { ok: false, error: err?.message || STATS_REQUEST_ERROR };
  } finally {
    profileState.loading = false;
    renderDailyPlayerPanels();
  }
}

// Shared board-grid builder (issue #176). Both the play (daily/
// created) board and the challenge board render a (rows × cols) grid
// of tiles with the same ARIA grid semantics + class names; they
// just differ in state strategy:
//
//   - Play builds the grid empty at game-init and then mutates
//     individual tiles via updateTile() / paintRow() as the user
//     types and submits guesses. `captureRefs: true` makes the
//     helper return a tileGrid that the patch helpers index into.
//
//   - Challenge re-renders the whole grid on every key press from
//     `challengeState.session.puzzles[i]` (guess history + server-
//     supplied feedback). It passes `cellAt(r, c)` returning the
//     letter + feedback class for each cell.
//
// Both paths now produce identical DOM shape (role=grid + aria-
// rowcount/colcount, role=row, role=gridcell, .filled when a letter
// is present, .absent/.present/.correct when feedback is present,
// aria-label="Letter X" or "Letter X, present" or "Empty"). The
// pre-dedupe challenge render had no ARIA grid attrs and no
// per-tile aria-label — minor a11y improvement folded into the
// dedupe, not a regression.
function buildBoardGrid(rootEl, opts) {
  const { rows, cols, cellAt, captureRefs } = opts;
  rootEl.innerHTML = "";
  rootEl.style.setProperty("--rows", String(rows));
  rootEl.style.setProperty("--cols", String(cols));
  rootEl.setAttribute("role", "grid");
  rootEl.setAttribute("aria-rowcount", String(rows));
  rootEl.setAttribute("aria-colcount", String(cols));
  const refs = captureRefs
    ? Array.from({ length: rows }, () => Array(cols).fill(null))
    : null;
  for (let r = 0; r < rows; r += 1) {
    const rowEl = document.createElement("div");
    rowEl.className = "row";
    rowEl.setAttribute("role", "row");
    for (let c = 0; c < cols; c += 1) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.setAttribute("role", "gridcell");
      const cell = cellAt ? cellAt(r, c) : null;
      const letter = cell && cell.letter ? cell.letter : "";
      const feedback = cell && cell.feedback ? cell.feedback : null;
      if (letter) {
        tile.textContent = letter;
        tile.classList.add("filled");
        tile.setAttribute(
          "aria-label",
          feedback ? `Letter ${letter}, ${feedback}` : `Letter ${letter}`
        );
      } else {
        tile.setAttribute("aria-label", "Empty");
      }
      if (feedback) tile.classList.add(feedback);
      rowEl.appendChild(tile);
      if (refs) refs[r][c] = tile;
    }
    rootEl.appendChild(rowEl);
  }
  return refs;
}

function buildBoard() {
  tileGrid = buildBoardGrid(boardEl, {
    rows: maxGuesses,
    cols,
    captureRefs: true
    // cellAt omitted — initial board is all empty; updateTile() and
    // paintRow() patch tiles incrementally as the user plays.
  });
}

// Shared keyboard build helpers (issue #163, partial). Both the
// play (#keyboard) and the challenge (#challengeKeyboard) on-screen
// keyboards used to have parallel build code with copy-pasted
// BACK/ENTER accessibility logic and a duplicate row-iteration loop.
// `makeKeyButton` + `renderKeyboardInto` are the single source of
// truth so future a11y/layout fixes only need to be applied once.
function makeKeyButton(key, opts = {}) {
  const { onClick } = opts;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "key";
  button.dataset.key = key;
  if (key === "ENTER" || key === "BACK") {
    button.classList.add("wide");
  }
  if (key === "BACK") {
    // Wrap the ⌫ glyph in aria-hidden so the only accessible name is
    // the explicit aria-label. Some auditors flag a button whose
    // visible text is purely an unnamed Unicode glyph even when
    // aria-label is set (Chrome's Lighthouse button-name has been
    // strict about this in the past).
    const glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "⌫";
    button.appendChild(glyph);
    button.setAttribute("aria-label", "Backspace");
  } else if (key === "ENTER") {
    button.textContent = "ENTER";
    // "Submit guess" is more meaningful to assistive tech than the
    // raw "ENTER" label.
    button.setAttribute("aria-label", "Submit guess");
  } else {
    button.textContent = key;
    button.setAttribute("aria-label", key);
  }
  if (onClick) {
    button.addEventListener("click", () => onClick(key));
  }
  return button;
}

function renderKeyboardInto(rootEl, opts = {}) {
  const { onKey, captureRefMap } = opts;
  rootEl.innerHTML = "";
  if (captureRefMap) captureRefMap.clear();
  KEYBOARD_LAYOUT.forEach((rowKeys, rowIndex) => {
    const rowEl = document.createElement("div");
    rowEl.className = "key-row";
    if (rowIndex === 1) {
      rowEl.classList.add("offset");
    }
    rowKeys.forEach((key) => {
      const button = makeKeyButton(key, { onClick: onKey });
      rowEl.appendChild(button);
      if (captureRefMap && key.length === 1) {
        captureRefMap.set(key, button);
      }
    });
    rootEl.appendChild(rowEl);
  });
}

function buildKeyboard() {
  renderKeyboardInto(keyboardEl, {
    onKey: handleKey,
    captureRefMap: keyboardKeyEls
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
      const meaning =
        typeof data.answerMeaning === "string" && data.answerMeaning.trim()
          ? data.answerMeaning.trim()
          : "";
      const baseMessage = window.i18n
        ? window.i18n.t("play.solvedFormat", { tries: currentRow + 1, max: maxGuesses })
        : `Solved in ${currentRow + 1}/${maxGuesses}!`;
      const suffix = meaning
        ? ` ${window.i18n
          ? window.i18n.t("play.solvedMeaningPrefix", { meaning })
          : `Meaning: ${meaning}`}`
        : "";
      setMessage(`${baseMessage}${suffix}`);
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
  if (dailyMode && !statsServiceUnavailable && !getActiveProfile()) {
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
  const target = event.target;
  const isTextInputTarget =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      (target.tagName === "INPUT" &&
        !["checkbox", "radio", "button", "submit", "reset"].includes(
          String(target.getAttribute("type") || "text").toLowerCase()
        )));
  if (isTextInputTarget) {
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

// Cached single-flight for /api/meta. Both init() (gameplay path) and
// initChallengesUI() (challenge bootstrap) need the deploy-cap flags
// before they make their first network call; without sharing the
// promise the two bootstraps race and the loser fires /api/challenges
// before deployCaps.challengesEnabled has been set to false.
//
// On failure (network drop, non-2xx), the cached promise is cleared
// so the next caller can retry within the same page load instead of
// being stuck on a permanently-resolved-but-empty promise. Without
// this, a transient /api/meta failure on first call would leave
// deployCaps + languageMinLengths at defaults forever.
let metaReadyPromise = null;
function ensureMetaReady() {
  if (!metaReadyPromise) {
    metaReadyPromise = loadMeta().then((ok) => {
      if (!ok) metaReadyPromise = null;
    });
  }
  return metaReadyPromise;
}

async function loadMeta() {
  try {
    const response = await fetch("/api/meta");
    if (!response.ok) return false;
    const data = await response.json();
    minLen = data.minLength || minLen;
    maxLen = data.maxLength || maxLen;
    minGuesses = data.minGuesses || minGuesses;
    maxGuessesAllowed = data.maxGuesses || maxGuessesAllowed;
    defaultGuesses = data.defaultGuesses || defaultGuesses;
    defaultLang = canonicalizeLanguageId(data.defaultLang || defaultLang) || defaultLang;
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
      option.textContent = lang.label;
      langSelect.appendChild(option);
      languageMinLengths[lang.id] = lang.minLength || minLen;
    });

    if (!langSelect.value) {
      langSelect.value = languageMinLengths[defaultLang]
        ? defaultLang
        : data.languages[0]?.id || "en";
    }
    // Hide the dictionary picker row when only one language is on offer —
    // the user has no real choice to make. The select still carries the
    // selected value for downstream code that reads langSelect.value.
    const langRow = langSelect.closest("label");
    if (langRow) {
      langRow.classList.toggle("hidden", data.languages.length <= 1);
    }
    // Hide top-nav affordances pointing at backends the deploy didn't
    // wire up. /api/meta on the Vercel preview returns each flag as
    // false. We only HIDE on an explicit `false`; older servers that
    // don't ship the flag (undefined) keep the affordance visible so
    // we don't break them.
    if (data.dailyWordEnabled === false) {
      deployCaps.dailyWordEnabled = false;
      document
        .querySelectorAll('a.admin-link[href="/daily"]')
        .forEach((el) => el.classList.add("hidden"));
    }
    if (data.challengesEnabled === false) {
      deployCaps.challengesEnabled = false;
      // Use both `hidden` attribute and `.hidden` class — the attribute
      // is the semantic signal; the class is the historical sibling
      // selector. styles.css forces `[hidden] { display: none !important }`
      // so the attribute alone wins against `.admin-link { display: flex }`.
      const link = document.getElementById("challengesNavLink");
      if (link) {
        link.hidden = true;
        link.classList.add("hidden");
      }
    }
    if (data.notificationsEnabled === false) {
      deployCaps.notificationsEnabled = false;
      const toggle = document.getElementById("notificationToggle");
      if (toggle) {
        toggle.hidden = true;
        toggle.classList.add("hidden");
      }
    }
    if (data.leaderboardEnabled === false) {
      deployCaps.leaderboardEnabled = false;
      // Lock the stats service into "unavailable" so every code path
      // that already gates on `statsServiceUnavailable` (refreshStatsPanels,
      // requestStatsProfile, daily-result POST, leaderboard render, etc.)
      // skips the fetch on a deploy that doesn't ship /api/stats/*.
      // Without this, opening a daily share URL like `/?word=...&daily=1`
      // hits initPlay → resets statsServiceUnavailable=false → calls
      // refreshStatsPanels(), which 404s on STATIC_DEPLOY_ENDPOINT_MISSING.
      statsServiceUnavailable = true;
    }
    updateLanguageConstraints(langSelect.value);
    randomBtn.disabled = false;

    guessInput.min = String(minGuesses);
    guessInput.max = String(maxGuessesAllowed);
    if (Number(guessInput.value) < minGuesses || Number(guessInput.value) > maxGuessesAllowed) {
      guessInput.value = String(defaultGuesses);
    }
    return true;
  } catch (err) {
    // Ignore meta failures (callers tolerate empty defaults). Returning
    // false lets ensureMetaReady drop its cache so a later caller can
    // retry within the same page load.
    return false;
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

function canonicalizeLanguageId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const match = /^([a-zA-Z]{2})(?:-([a-zA-Z]{2}))?$/.exec(value);
  if (!match) {
    return value;
  }
  const language = match[1].toLowerCase();
  if (!match[2]) {
    return language;
  }
  return `${language}-${match[2].toUpperCase()}`;
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

function getSystemTheme() {
  if (!colorSchemeMediaQuery) {
    return THEME_PREFERENCES.DARK;
  }
  return colorSchemeMediaQuery.matches ? THEME_PREFERENCES.LIGHT : THEME_PREFERENCES.DARK;
}

function resolveThemePreference(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!VALID_THEME_PREFERENCES.has(normalized)) {
    return THEME_PREFERENCES.SYSTEM;
  }
  return normalized;
}

function applyTheme(preference, options = {}) {
  const persist = options.persist !== false;
  const updateControl = options.updateControl !== false;
  const normalizedPreference = resolveThemePreference(preference);
  const resolvedTheme =
    normalizedPreference === THEME_PREFERENCES.SYSTEM
      ? getSystemTheme()
      : normalizedPreference;

  document.documentElement.classList.remove("theme-light", "theme-dark");
  document.documentElement.classList.add(`theme-${resolvedTheme}`);
  themePreference = normalizedPreference;

  if (persist) {
    setStoredItem(THEME_STORAGE_KEY, normalizedPreference);
  }
  if (updateControl && themeSelect) {
    themeSelect.value = normalizedPreference;
  }
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
    // Return null (not an English literal) when the server didn't
    // supply an error string — showErrorPanel(null) then picks the
    // localized error.linkFailed default. /api/puzzle currently
    // returns English error strings; if we ever wire that endpoint
    // through translateForRequest (it's challenge-routes-only today),
    // those will already be localized when forwarded as-is here.
    return { ok: false, message: data.error || null };
  }

  cols = data.length;
  maxGuesses = data.maxGuesses || defaultGuesses;
  puzzleCode = code.toUpperCase();
  puzzleLang = data.lang || "en";
  dailyMode = Boolean(options.dailyMode);
  dailyDate = options.dailyDate || toLocalDateString(new Date());
  dailyPuzzleKey = dailyMode ? `${dailyDate}|${puzzleLang}|${puzzleCode}` : "";
  clearStatsServiceUnavailable();

  resetGame();

  const dailyPrefix = dailyMode ? `Daily (${dailyDate}) · ` : "";
  baseMeta = `${dailyPrefix}Language: ${data.label} · Length: ${cols} · ${maxGuesses} tries`;
  updatePlayMeta();
  renderDailyPlayerPanels();
  if (dailyMode) {
    await refreshStatsPanels({
      range: leaderboardRangeEl ? leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly : LEADERBOARD_RANGE.weekly
    });
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
  clearStatsServiceUnavailable();
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
    if (!dailyMode || statsServiceUnavailable) return;
    try {
      await refreshLeaderboard(leaderboardRangeEl.value || LEADERBOARD_RANGE.weekly);
      setProfileStatus("");
    } catch (err) {
      if (isStatsServiceUnavailableError(err)) {
        enableStatsDegradedMode();
        return;
      }
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
  randomBtn.disabled = false;
  updateLanguageConstraints(langSelect.value);
});

if (themeSelect) {
  themeSelect.addEventListener("change", () => {
    applyTheme(themeSelect.value, { persist: true, updateControl: false });
  });
}

if (colorSchemeMediaQuery && typeof colorSchemeMediaQuery.addEventListener === "function") {
  colorSchemeMediaQuery.addEventListener("change", () => {
    if (themePreference === THEME_PREFERENCES.SYSTEM) {
      applyTheme(THEME_PREFERENCES.SYSTEM, { persist: false });
    }
  });
} else if (colorSchemeMediaQuery && typeof colorSchemeMediaQuery.addListener === "function") {
  colorSchemeMediaQuery.addListener(() => {
    if (themePreference === THEME_PREFERENCES.SYSTEM) {
      applyTheme(THEME_PREFERENCES.SYSTEM, { persist: false });
    }
  });
}

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

/**
 * Initialize application state, apply persisted UI settings, load metadata, and route to Create or Play based on URL parameters.
 *
 * Loads server-side metadata, resets profile and leaderboard state, applies stored theme/contrast/strict preferences, and then either:
 * - validates URL query parameters and starts a Play session for a shared or daily puzzle, or
 * - enters Create mode when no puzzle code is present.
 *
 * If a URL-provided puzzle link fails validation, an error panel is shown with a generic link-failure message.
 */
async function init() {
  // Wait for i18n messages to land BEFORE we route. Without this, a
  // malformed shared/daily link would invoke showErrorPanel() with
  // hardcoded English copy because the locale fetch hadn't completed
  // yet. window.i18nReady is set up immediately above this call so
  // it's always defined by the time init() runs.
  if (window.i18nReady) {
    try { await window.i18nReady; } catch (_e) { /* fall back to English */ }
  }
  await ensureMetaReady();
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
  clearStatsServiceUnavailable();

  const storedContrast = getStoredItem("highContrast") === "true";
  const storedStrict = getStoredItem("strictMode") === "true";
  const storedThemePreference = resolveThemePreference(getStoredItem(THEME_STORAGE_KEY));
  applyTheme(storedThemePreference, { persist: false });
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
      ? canonicalizeLanguageId(langParam)
      : defaultLang;
    const hasLoadedLanguageMeta = Object.keys(languageMinLengths).length > 0;
    const isDailyFromLink = dailyParam === "1";
    const resolvedDailyDate = isDailyFromLink
      ? (dayParam ? String(dayParam).trim() : toLocalDateString(new Date()))
      : "";
    const availableLang = hasLoadedLanguageMeta
      ? (languageMinLengths[resolvedLang] ? resolvedLang : null)
      : resolvedLang;

    if (!trimmedCode || !/^[a-zA-Z]+$/.test(trimmedCode)) {
      showErrorPanel(null);
      return;
    }
    if (!resolvedLang) {
      showErrorPanel(null);
      return;
    }
    if (hasLoadedLanguageMeta && !availableLang) {
      showErrorPanel(null);
      return;
    }
    if (isDailyFromLink && !parseDateString(resolvedDailyDate)) {
      showErrorPanel(null);
      return;
    }

    const minLength = hasLoadedLanguageMeta ? getMinLengthForLang(availableLang) : minLen;
    if (trimmedCode.length < minLength || trimmedCode.length > maxLen) {
      showErrorPanel(null);
      return;
    }

    let guessesCount = defaultGuesses;
    if (guessesParam !== null) {
      const parsed = Number(guessesParam);
      if (!Number.isInteger(parsed) || parsed < minGuesses || parsed > maxGuessesAllowed) {
        showErrorPanel(null);
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
      showErrorPanel(result.message || null);
    }
  } else {
    initCreate();
  }
}

// ── i18n bootstrap + language switcher ────────────────────────────────
// `window.i18nReady` resolves once messages are loaded. Async/dynamic
// UI (e.g. challenge cards built with i18n.t() at construction time)
// must await it — otherwise t() returns the literal key before fetch
// completes and updateDOM() can't repair imperatively-built strings.
// Started BEFORE init() so init's awaited paths (showErrorPanel,
// profile rendering) can rely on translations being available.
window.i18nReady = (async function bootstrapI18n() {
  if (typeof window === "undefined" || !window.i18n) return;
  try {
    await window.i18n.init();
  } catch (_err) {
    // init swallows network errors and falls back to English; nothing
    // to do here beyond letting the page render with literal keys.
  }
})();

init();

(async function wireLanguageSwitcher() {
  if (typeof window === "undefined" || !window.i18n) return;
  await window.i18nReady;
  const langSelect = document.getElementById("uiLangSelect");
  if (!langSelect) return;
  langSelect.value = window.i18n.getCurrentLocale();
  langSelect.addEventListener("change", async () => {
    const next = String(langSelect.value || "en");
    try {
      // loadLocale() internally re-runs updateDOM(); no second call
      // needed here (was a redundant full DOM traversal).
      await window.i18n.loadLocale(next);
      // Re-render any challenge panel that's currently visible — its
      // text is built imperatively via i18n.t() into new DOM nodes,
      // so updateDOM() (which only retranslates data-i18n-bound nodes)
      // doesn't reach it. The list view is the most common case; the
      // play board's strings come from data-i18n bindings in markup,
      // so it doesn't need a manual re-render. Summary + leaderboard
      // panels are imperatively rendered, so we re-fire their loaders.
      if (typeof renderChallengeList === "function") renderChallengeList();
      const summaryVisible = challengeSummaryPanelEl && !challengeSummaryPanelEl.classList.contains('hidden');
      const leaderboardVisible = challengeLeaderboardPanelEl && !challengeLeaderboardPanelEl.classList.contains('hidden');
      if (summaryVisible && challengeState.session && typeof enterChallengeSummary === "function") {
        enterChallengeSummary();
      } else if (leaderboardVisible && challengeState.lastLeaderboardChallengeId && typeof showChallengeLeaderboard === "function") {
        showChallengeLeaderboard(challengeState.lastLeaderboardChallengeId);
      }
    } catch (_err) {
      // Roll the dropdown back to the active locale on failure so the
      // UI matches what's actually loaded.
      langSelect.value = window.i18n.getCurrentLocale();
    }
  });
})();

// ── Daily puzzle push notifications ──────────────────────────────────
// Self-contained block at the end so adding/removing the feature is a
// single contiguous edit. The opt-in toggle is hidden unless the
// browser supports Notification + Service Worker + PushManager AND the
// page is loaded over a secure context (HTTPS or localhost).
const NOTIFICATION_HASH_STORAGE_KEY = 'wordle.pushEndpointHash';
const notificationToggleEl = document.getElementById('notificationToggle');
const notificationToggleLabelEl = document.getElementById('notificationToggleLabel');
const notificationStatusEl = document.getElementById('notificationStatus');

function pushNotificationsSupported() {
  return Boolean(
    typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && (window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  );
}

function setNotificationStatus(text) {
  if (notificationStatusEl) notificationStatusEl.textContent = text || '';
}

function setNotificationLabel(text) {
  if (notificationToggleLabelEl) notificationToggleLabelEl.textContent = text;
}

function urlBase64ToUint8Array(base64String) {
  // The PushManager subscribe API needs the VAPID public key as raw
  // bytes, not the URL-safe base64 the server emits.
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getNotificationRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  // ready resolves once the active SW is installed AND activated, so a
  // first-load subscribe doesn't race a still-installing worker.
  return navigator.serviceWorker.ready;
}

async function refreshNotificationToggle() {
  if (!notificationToggleEl) return;
  // /api/meta said the deploy can't subscribe (no /api/notifications/*
  // backend) — keep the toggle hidden. Without this, the toggle shows
  // on the Vercel preview and clicking it 404s on the VAPID key fetch.
  if (deployCaps.notificationsEnabled === false) {
    notificationToggleEl.hidden = true;
    return;
  }
  if (!pushNotificationsSupported()) {
    notificationToggleEl.hidden = true;
    setNotificationStatus(
      window.isSecureContext
        ? ''
        : (window.i18n ? window.i18n.t("header.notificationsNeedHttps") : "Notifications need HTTPS or localhost.")
    );
    return;
  }
  notificationToggleEl.hidden = false;
  if (Notification.permission === 'denied') {
    notificationToggleEl.disabled = true;
    notificationToggleEl.setAttribute('aria-pressed', 'false');
    setNotificationLabel(window.i18n
      ? window.i18n.t("header.notificationsBlocked")
      : "Notifications blocked");
    setNotificationStatus(window.i18n
      ? window.i18n.t("header.notificationsBlockedHint")
      : "Open browser settings to allow notifications, then reload.");
    return;
  }
  notificationToggleEl.disabled = false;
  let subscribed = false;
  try {
    const reg = await getNotificationRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      subscribed = Boolean(sub);
    }
  } catch (_err) {
    // pushManager API not available — leave subscribed=false.
  }
  notificationToggleEl.setAttribute('aria-pressed', subscribed ? 'true' : 'false');
  setNotificationLabel(
    subscribed
      ? (window.i18n ? window.i18n.t("header.notificationsToggleOn") : "Notifications: on")
      : (window.i18n ? window.i18n.t("header.notificationsToggleOff") : "Get notified when daily puzzle is ready")
  );
  setNotificationStatus('');
}

async function fetchVapidPublicKey() {
  const res = await fetch('/api/notifications/vapid-public-key');
  if (!res.ok) {
    throw new Error(`Could not fetch VAPID public key (HTTP ${res.status}).`);
  }
  const json = await res.json();
  if (!json.publicKey) throw new Error('Server returned no public key.');
  return json.publicKey;
}

async function subscribeToPush() {
  const reg = await getNotificationRegistration();
  if (!reg) throw new Error('Service worker not available.');
  // Ask permission only on the user-gesture path. Auto-prompting is
  // explicitly out of scope; this respects the locked decision in #92.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Permission denied.' : 'Permission not granted.');
  }
  const publicKey = await fetchVapidPublicKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  const subJson = sub.toJSON();
  let res;
  try {
    res = await fetch('/api/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys
      })
    });
  } catch (err) {
    // Network error: roll back the browser-side subscription so the
    // next refreshNotificationToggle() doesn't read a phantom "on"
    // state with no matching server row. Without this, the user has
    // to toggle off and on again to recover, and the off path can't
    // even DELETE because we never persisted endpointHash.
    try { await sub.unsubscribe(); } catch (_e) { /* best-effort */ }
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    try { await sub.unsubscribe(); } catch (_e) { /* best-effort */ }
    throw new Error(body.error || `Subscribe failed (HTTP ${res.status}).`);
  }
  const json = await res.json();
  if (json.endpointHash) {
    try { localStorage.setItem(NOTIFICATION_HASH_STORAGE_KEY, json.endpointHash); } catch (_e) { /* ignore */ }
  }
}

async function unsubscribeFromPush() {
  const reg = await getNotificationRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  let endpointHash = null;
  try { endpointHash = localStorage.getItem(NOTIFICATION_HASH_STORAGE_KEY); } catch (_e) { /* ignore */ }
  if (sub) {
    try { await sub.unsubscribe(); } catch (_e) { /* best-effort */ }
  }
  if (endpointHash) {
    try {
      await fetch(`/api/notifications/subscribe/${encodeURIComponent(endpointHash)}`, {
        method: 'DELETE'
      });
    } catch (_e) { /* server cleanup is best-effort; the row will prune via failure streak */ }
    try { localStorage.removeItem(NOTIFICATION_HASH_STORAGE_KEY); } catch (_e) { /* ignore */ }
  }
}

if (notificationToggleEl) {
  notificationToggleEl.addEventListener('click', async () => {
    if (notificationToggleEl.disabled) return;
    notificationToggleEl.disabled = true;
    setNotificationStatus('Working…');
    try {
      const isSubscribed = notificationToggleEl.getAttribute('aria-pressed') === 'true';
      if (isSubscribed) {
        await unsubscribeFromPush();
        setNotificationStatus('Notifications turned off.');
      } else {
        await subscribeToPush();
        setNotificationStatus('You will be notified when the daily puzzle is ready.');
      }
    } catch (err) {
      setNotificationStatus(err.message || 'Something went wrong.');
    } finally {
      notificationToggleEl.disabled = false;
      refreshNotificationToggle().catch(() => {});
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => refreshNotificationToggle())
      .catch(() => {});
  });
}

// ── Timed challenges ──────────────────────────────────────────────────
// Entirely self-contained at the bottom of the file: the existing play
// panel is for daily/custom puzzles and would need invasive refactoring
// to support multi-puzzle sessions. The challenge UI duplicates a small
// amount of board/keyboard rendering rather than untangle that.

const CHALLENGE_PROFILE_ID_KEY = 'wordle.challenge.profileId';
const CHALLENGE_PROFILE_NAME_KEY = 'wordle.challenge.profileName';
const CHALLENGE_TIMER_TICK_MS = 1000;

const challengesNavLinkEl = document.getElementById('challengesNavLink');
const challengeListPanelEl = document.getElementById('challengeListPanel');
const challengeListBodyEl = document.getElementById('challengeListBody');
const challengeListEmptyEl = document.getElementById('challengeListEmpty');
const challengeProfileInputEl = document.getElementById('challengeProfileInput');
const challengePlayPanelEl = document.getElementById('challengePlayPanel');
const challengePlayHeadEl = document.getElementById('challengePlayHead');
const challengePlayMetaEl = document.getElementById('challengePlayMeta');
const challengeTimerEl = document.getElementById('challengeTimer');
const challengeScoreLineEl = document.getElementById('challengeScoreLine');
const challengeBoardEl = document.getElementById('challengeBoard');
const challengeKeyboardEl = document.getElementById('challengeKeyboard');
const challengePlayStatusEl = document.getElementById('challengePlayStatus');
const challengeQuitBtnEl = document.getElementById('challengeQuitBtn');
const challengeSummaryPanelEl = document.getElementById('challengeSummaryPanel');
const challengeSummaryBodyEl = document.getElementById('challengeSummaryBody');
const challengeBackToListBtnEl = document.getElementById('challengeBackToListBtn');
const challengeViewLeaderboardBtnEl = document.getElementById('challengeViewLeaderboardBtn');
const challengeLeaderboardPanelEl = document.getElementById('challengeLeaderboardPanel');
const challengeLeaderboardNameEl = document.getElementById('challengeLeaderboardName');
const challengeLeaderboardTbodyEl = challengeLeaderboardPanelEl
  ? challengeLeaderboardPanelEl.querySelector('tbody')
  : null;
const challengeBackToListFromBoardBtnEl = document.getElementById('challengeBackToListFromBoardBtn');

const challengeState = {
  challenges: [],
  activeChallenge: null,
  session: null,
  pendingGuess: '',
  timerHandle: null,
  remainingSeconds: 0,
  lastLeaderboardChallengeId: null
};

function showChallengePanelOnly(idOrNull) {
  // Hide all CHALLENGE panels, then show the one we want. Non-challenge
  // panels (createPanel/playPanel/etc.) are managed elsewhere — this
  // function intentionally only owns the challenge-mode UI subtree.
  const challengePanels = [
    challengeListPanelEl, challengePlayPanelEl,
    challengeSummaryPanelEl, challengeLeaderboardPanelEl
  ];
  for (const el of challengePanels) {
    if (el) el.classList.add('hidden');
  }
  if (idOrNull) {
    const target = document.getElementById(idOrNull);
    if (target) target.classList.remove('hidden');
  }
}

function getChallengeProfile() {
  let id = '';
  try { id = localStorage.getItem(CHALLENGE_PROFILE_ID_KEY) || ''; } catch (_e) { /* ignore */ }
  if (!id) {
    // Generate a random local id; stable across sessions on this device.
    id = 'p-' + Math.random().toString(36).slice(2, 12);
    try { localStorage.setItem(CHALLENGE_PROFILE_ID_KEY, id); } catch (_e) { /* ignore */ }
  }
  let name = '';
  try { name = localStorage.getItem(CHALLENGE_PROFILE_NAME_KEY) || ''; } catch (_e) { /* ignore */ }
  return { id, name };
}

function setChallengeProfileName(name) {
  try { localStorage.setItem(CHALLENGE_PROFILE_NAME_KEY, name); } catch (_e) { /* ignore */ }
}

// Adjective + Animal random name generator (issue #174). Both
// profile inputs prefill from this when the value + localStorage are
// both empty, giving the user a regex-clean starting point. Every
// `<Adjective> <Animal>` combination passes the shared NAME_PATTERN
// in lib/profile-name.js (ASCII letters + one internal space, well
// under the 32-codepoint cap). Curated lists; no profanity sweep
// needed at this size.
const RANDOM_NAME_ADJECTIVES = Object.freeze([
  "Brave", "Bold", "Calm", "Clever", "Curious", "Daring", "Eager",
  "Friendly", "Gentle", "Happy", "Jolly", "Keen", "Kind", "Lively",
  "Lucky", "Merry", "Nimble", "Plucky", "Proud", "Quiet", "Quick",
  "Sharp", "Silly", "Smart", "Steady", "Sunny", "Swift", "Witty"
]);
const RANDOM_NAME_ANIMALS = Object.freeze([
  "Badger", "Beaver", "Falcon", "Ferret", "Fox", "Hare", "Hawk",
  "Heron", "Jaguar", "Lynx", "Magpie", "Marten", "Mongoose", "Otter",
  "Owl", "Panda", "Penguin", "Raven", "Robin", "Seal", "Shark",
  "Sparrow", "Stoat", "Stork", "Tiger", "Toucan", "Vixen", "Walrus"
]);
function pickRandomName() {
  const adj = RANDOM_NAME_ADJECTIVES[Math.floor(Math.random() * RANDOM_NAME_ADJECTIVES.length)];
  const animal = RANDOM_NAME_ANIMALS[Math.floor(Math.random() * RANDOM_NAME_ANIMALS.length)];
  return `${adj} ${animal}`;
}

if (challengeProfileInputEl) {
  // Prefill: keep any stored localStorage name; otherwise drop in a
  // regex-clean random default so the input isn't blank on first
  // visit. User can edit or replace freely; once they type, normal
  // input listener takes over.
  const storedChallengeName = getChallengeProfile().name;
  challengeProfileInputEl.value = storedChallengeName || pickRandomName();
  if (!storedChallengeName) {
    // Persist the default so a refresh shows the same name rather
    // than re-rolling (avoids the surprise of "wait, I had a different
    // name a second ago"). User can still overwrite.
    setChallengeProfileName(challengeProfileInputEl.value);
  }
  challengeProfileInputEl.addEventListener('input', () => {
    setChallengeProfileName(String(challengeProfileInputEl.value || '').trim().slice(0, 32));
  });
}

if (profileNameInputEl) {
  // Same prefill for the play (daily) name input. The leaderboard
  // form uses multi-profile semantics so we don't persist the default
  // here — it's just a typing-into starting point. User can edit
  // before clicking "Use this name" to submit.
  if (!profileNameInputEl.value) {
    profileNameInputEl.value = pickRandomName();
  }
}

// Wrap fetch() so challenge endpoints — the only routes wired into
// `translateForRequest()` server-side — see the UI-selected locale
// even when the browser's own Accept-Language header points at a
// different language. This lets a user on a Spanish browser switch
// the UI switcher to English and have the server return English
// error JSON, and vice versa. Other endpoints don't translate
// responses today, so leaving their fetches untouched avoids extra
// network surface area for no behavioral gain.
function challengeFetch(input, init) {
  const opts = init ? { ...init } : {};
  const headers = new Headers(opts.headers || {});
  const locale = (window.i18n && typeof window.i18n.getCurrentLocale === "function")
    ? window.i18n.getCurrentLocale()
    : "";
  if (locale && !headers.has("Accept-Language")) {
    // Send `<locale>,<base>;q=0.5` so the server still has a valid
    // base fallback if it ever needs one. parseAcceptLanguage handles
    // q-factor ranking; the high-priority entry wins.
    headers.set("Accept-Language", `${locale},${locale.split("-")[0]};q=0.5`);
  }
  opts.headers = headers;
  return fetch(input, opts);
}

async function loadChallengeList() {
  // /api/meta said challenges aren't available in this deploy — skip
  // the fetch entirely so we don't paint a 404 into the network panel
  // or the console on every cold load.
  if (deployCaps.challengesEnabled === false) {
    if (challengesNavLinkEl) challengesNavLinkEl.hidden = true;
    return;
  }
  try {
    const res = await challengeFetch('/api/challenges');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // Either the legacy CHALLENGE_MODE_DISABLED code (full server
      // with feature flag off) or the deploy-time
      // STATIC_DEPLOY_ENDPOINT_MISSING (Vercel preview) means "no
      // challenges here; hide the nav link and bail."
      if (
        res.status === 404
        && (body.code === 'CHALLENGE_MODE_DISABLED'
          || body.code === 'STATIC_DEPLOY_ENDPOINT_MISSING')
      ) {
        if (challengesNavLinkEl) challengesNavLinkEl.hidden = true;
        return;
      }
      return;
    }
    const json = await res.json();
    challengeState.challenges = Array.isArray(json.challenges) ? json.challenges : [];
    if (challengesNavLinkEl) challengesNavLinkEl.hidden = challengeState.challenges.length === 0;
  } catch (_err) {
    if (challengesNavLinkEl) challengesNavLinkEl.hidden = true;
  }
}

function renderChallengeList() {
  if (!challengeListBodyEl) return;
  challengeListBodyEl.innerHTML = '';
  if (!challengeState.challenges.length) {
    if (challengeListEmptyEl) challengeListEmptyEl.classList.remove('hidden');
    return;
  }
  if (challengeListEmptyEl) challengeListEmptyEl.classList.add('hidden');
  for (const ch of challengeState.challenges) {
    const card = document.createElement('div');
    card.className = 'admin-status-card';
    const title = document.createElement('h3');
    title.textContent = ch.name;
    card.appendChild(title);
    const meta = document.createElement('p');
    meta.className = 'note';
    // Build the meta segments conditionally so wordLength=null
    // doesn't render as an empty "·  ·" segment.
    const i18n = window.i18n;
    const metaSegments = [
      i18n ? i18n.t("challenge.metaPuzzles", { count: ch.puzzleCount }) : `${ch.puzzleCount} puzzles`,
    ];
    if (ch.wordLength) {
      metaSegments.push(
        i18n ? i18n.t("challenge.metaWordLength", { length: ch.wordLength }) : `${ch.wordLength}-letter`
      );
    }
    metaSegments.push(
      i18n ? i18n.t("challenge.metaTimeBudget", { seconds: ch.timeBudgetSeconds }) : `${ch.timeBudgetSeconds}s budget`
    );
    metaSegments.push(
      i18n ? i18n.t("challenge.metaMaxGuesses", { count: ch.maxGuesses }) : `${ch.maxGuesses} guesses each`
    );
    metaSegments.push(
      i18n ? i18n.t("challenge.metaReplay", { policy: ch.replayPolicy }) : `replay: ${ch.replayPolicy}`
    );
    meta.textContent = metaSegments.join(' · ');
    card.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'form-row';
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.textContent = window.i18n ? window.i18n.t("challenge.startBtn") : "Start";
    startBtn.addEventListener('click', () => startChallenge(ch.id));
    actions.appendChild(startBtn);
    const lbBtn = document.createElement('button');
    lbBtn.type = 'button';
    lbBtn.className = 'ghost';
    lbBtn.textContent = window.i18n ? window.i18n.t("challenge.leaderboardBtn") : "Leaderboard";
    lbBtn.addEventListener('click', () => showChallengeLeaderboard(ch.id));
    actions.appendChild(lbBtn);
    card.appendChild(actions);
    challengeListBodyEl.appendChild(card);
  }
}

async function startChallenge(challengeId) {
  const profile = getChallengeProfile();
  if (!profile.name && challengeProfileInputEl?.value) {
    setChallengeProfileName(challengeProfileInputEl.value.trim());
  }
  const finalName = challengeProfileInputEl?.value?.trim() || profile.name || 'Player';
  try {
    const res = await challengeFetch(`/api/challenges/${encodeURIComponent(challengeId)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: profile.id, profileName: finalName })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fallback = window.i18n
        ? window.i18n.t("challenge.couldNotStart", { message: `HTTP ${res.status}` })
        : `Could not start challenge: HTTP ${res.status}`;
      alert(json.error || fallback);
      return;
    }
    challengeState.activeChallenge = challengeState.challenges.find((c) => c.id === challengeId);
    challengeState.session = json.session;
    enterChallengePlay();
  } catch (err) {
    alert(window.i18n
      ? window.i18n.t("challenge.couldNotStart", { message: err.message })
      : `Could not start challenge: ${err.message}`);
  }
}

function enterChallengePlay() {
  showChallengePanelOnly('challengePlayPanel');
  challengePlayHeadEl.textContent = challengeState.activeChallenge?.name || 'Challenge';
  challengeState.pendingGuess = '';
  startChallengeTimer();
  renderChallengeBoard();
  renderChallengeKeyboard();
  setChallengePlayStatus('');
}

function setChallengePlayStatus(text, tone = '') {
  if (!challengePlayStatusEl) return;
  challengePlayStatusEl.textContent = text || '';
  challengePlayStatusEl.classList.remove('admin-status-ok', 'admin-status-missing');
  if (tone) challengePlayStatusEl.classList.add(tone);
}

function startChallengeTimer() {
  stopChallengeTimer();
  // Use server-supplied remainingSeconds as ground truth; we tick the
  // client-visible countdown locally between requests but the server
  // re-issues the truth on every guess response.
  const initial = challengeState.session?.remainingSeconds ?? 0;
  challengeState.remainingSeconds = Math.max(0, Math.floor(initial));
  paintChallengeTimer();
  challengeState.timerHandle = setInterval(() => {
    if (challengeState.remainingSeconds <= 0) {
      stopChallengeTimer();
      handleChallengeTimedOutClient();
      return;
    }
    challengeState.remainingSeconds -= 1;
    paintChallengeTimer();
  }, CHALLENGE_TIMER_TICK_MS);
}

function stopChallengeTimer() {
  if (challengeState.timerHandle) {
    clearInterval(challengeState.timerHandle);
    challengeState.timerHandle = null;
  }
}

function paintChallengeTimer() {
  if (!challengeTimerEl) return;
  const total = challengeState.remainingSeconds;
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  challengeTimerEl.textContent = `${m}:${s}`;
  // High-pressure cue under 30s.
  challengeTimerEl.classList.toggle('admin-status-missing', total <= 30);
}

async function handleChallengeTimedOutClient() {
  // Client-side timer hit zero; ask the server for the authoritative
  // settlement (which will mark the session timed-out and return the
  // final score). Don't trust the client clock for the outcome.
  if (!challengeState.session) return;
  try {
    const res = await challengeFetch(
      `/api/challenges/${encodeURIComponent(challengeState.session.challengeId)}/sessions/${encodeURIComponent(challengeState.session.id)}`
    );
    if (res.ok) {
      const json = await res.json();
      challengeState.session = json.session;
      enterChallengeSummary();
    }
  } catch (_err) {
    // ignore — next user action will retry
  }
}

function activePuzzle() {
  if (!challengeState.session) return null;
  const idx = challengeState.session.activePuzzleIndex;
  if (idx === null || idx === undefined) return null;
  return challengeState.session.puzzles.find((p) => p.index === idx) || null;
}

function renderChallengeBoard() {
  if (!challengeBoardEl) return;
  const session = challengeState.session;
  const challenge = challengeState.activeChallenge;
  if (!session || !challenge) return;
  const active = activePuzzle();
  if (!active) return;
  // Surface puzzle-of-N progress and a running solved/score line so
  // the player knows where they are without scrolling.
  if (challengePlayMetaEl) {
    challengePlayMetaEl.textContent = window.i18n
      ? window.i18n.t("challenge.puzzleProgress", { current: active.index + 1, total: challenge.puzzleCount })
      : `Puzzle ${active.index + 1} of ${challenge.puzzleCount}`;
  }
  if (challengeScoreLineEl) {
    const solved = session.puzzles.filter((p) => p.solved).length;
    challengeScoreLineEl.textContent = window.i18n
      ? window.i18n.t("challenge.solvedRunning", { solved, total: challenge.puzzleCount })
      : `${solved}/${challenge.puzzleCount} solved`;
  }
  const length = active.length || (challenge.wordLength || 5);
  const maxGuesses = challenge.maxGuesses;
  // The server projection includes a `feedbacks` array (one row per
  // historical guess, each row is an array of "correct" / "present" /
  // "absent" strings). The active puzzle's word is hidden so the
  // client can't compute these locally — render them server-side.
  const feedbacks = Array.isArray(active.feedbacks) ? active.feedbacks : [];
  buildBoardGrid(challengeBoardEl, {
    rows: maxGuesses,
    cols: length,
    cellAt: (r, c) => {
      let guessForRow = active.guesses[r] || "";
      let rowFeedback = null;
      if (r < active.guesses.length) {
        rowFeedback = feedbacks[r] || null;
      } else if (r === active.guesses.length) {
        guessForRow = challengeState.pendingGuess;
      }
      return {
        letter: guessForRow[c] || "",
        feedback: rowFeedback ? rowFeedback[c] || null : null
      };
    }
  });
}

function renderChallengeKeyboard() {
  if (!challengeKeyboardEl) return;
  renderKeyboardInto(challengeKeyboardEl, { onKey: onChallengeKey });
}

function onChallengeKey(key) {
  if (!challengeState.session || challengeState.session.status !== 'in-progress') return;
  const active = activePuzzle();
  if (!active) return;
  const length = active.length || (challengeState.activeChallenge?.wordLength || 5);
  if (key === 'ENTER') {
    if (challengeState.pendingGuess.length !== length) {
      setChallengePlayStatus(
        window.i18n ? window.i18n.t("play.guessTooShort", { length }) : `Guess must be ${length} letters.`,
        'admin-status-missing'
      );
      return;
    }
    submitChallengeGuess();
    return;
  }
  if (key === 'BACK') {
    challengeState.pendingGuess = challengeState.pendingGuess.slice(0, -1);
    renderChallengeBoard();
    return;
  }
  if (/^[A-Z]$/.test(key) && challengeState.pendingGuess.length < length) {
    challengeState.pendingGuess += key;
    renderChallengeBoard();
  }
}

document.addEventListener('keydown', (event) => {
  if (challengePlayPanelEl?.classList.contains('hidden')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const k = event.key;
  if (k === 'Enter') {
    event.preventDefault();
    onChallengeKey('ENTER');
  } else if (k === 'Backspace') {
    event.preventDefault();
    onChallengeKey('BACK');
  } else if (/^[a-zA-Z]$/.test(k)) {
    event.preventDefault();
    onChallengeKey(k.toUpperCase());
  }
});

async function submitChallengeGuess() {
  const guess = challengeState.pendingGuess;
  challengeState.pendingGuess = '';
  setChallengePlayStatus(window.i18n ? window.i18n.t("challenge.submitting") : 'Submitting…');
  try {
    const res = await challengeFetch(
      `/api/challenges/${encodeURIComponent(challengeState.session.challengeId)}/sessions/${encodeURIComponent(challengeState.session.id)}/guess`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess })
      }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fallback = window.i18n
        ? window.i18n.t("challenge.guessRejected", { status: res.status })
        : `Guess rejected (HTTP ${res.status})`;
      setChallengePlayStatus(json.error || fallback, 'admin-status-missing');
      return;
    }
    challengeState.session = json.session;
    challengeState.remainingSeconds = json.session.remainingSeconds;
    paintChallengeTimer();
    renderChallengeBoard();
    if (challengeState.session.status !== 'in-progress' && challengeState.session.status !== 'pending') {
      stopChallengeTimer();
      enterChallengeSummary();
      return;
    }
    setChallengePlayStatus('');
  } catch (err) {
    setChallengePlayStatus(
      window.i18n
        ? window.i18n.t("challenge.guessSubmitFailed", { message: err.message })
        : `Could not submit guess: ${err.message}`,
      'admin-status-missing'
    );
  }
}

function enterChallengeSummary() {
  showChallengePanelOnly('challengeSummaryPanel');
  if (!challengeSummaryBodyEl) return;
  const s = challengeState.session;
  const c = challengeState.activeChallenge;
  if (!s || !c) {
    challengeSummaryBodyEl.textContent = 'No session data.';
    return;
  }
  const solved = s.puzzles.filter((p) => p.solved).length;
  let status;
  if (s.status === 'completed') status = window.i18n ? window.i18n.t("challenge.summaryStatusCompleted") : 'Completed!';
  else if (s.status === 'timed-out') status = window.i18n ? window.i18n.t("challenge.summaryStatusTimedOut") : 'Time up!';
  else if (s.status === 'abandoned') status = window.i18n ? window.i18n.t("challenge.summaryStatusAbandoned") : 'Quit';
  else status = window.i18n ? window.i18n.t("challenge.summaryStatusGeneric") : 'Done';
  challengeSummaryBodyEl.innerHTML = '';
  // Build the head as separate text + strong nodes (no innerHTML
  // interpolation — would otherwise be a small XSS surface for any
  // future call site that passes user-controlled data, and the
  // hardcoded English labels prevented locale switching from
  // affecting the line at all).
  const head = document.createElement('p');
  const scoreLabel = window.i18n ? window.i18n.t("challenge.summaryScoreLabel") : "Score";
  const solvedLabel = window.i18n ? window.i18n.t("challenge.summarySolvedLabel") : "Solved";
  const timeLabel = window.i18n ? window.i18n.t("challenge.summaryTimeLabel") : "Time";
  const solvedFrac = window.i18n
    ? window.i18n.t("challenge.summarySolvedFraction", { solved, total: c.puzzleCount })
    : `${solved}/${c.puzzleCount}`;
  const timeSec = window.i18n
    ? window.i18n.t("challenge.summaryTimeSeconds", { seconds: s.elapsedSeconds ?? 0 })
    : `${s.elapsedSeconds ?? 0}s`;
  const scoreFormatted = window.i18n && typeof window.i18n.formatNumber === 'function'
    ? window.i18n.formatNumber(s.score ?? 0)
    : String(s.score ?? 0);
  const statusStrong = document.createElement('strong');
  statusStrong.textContent = status;
  head.appendChild(statusStrong);
  head.appendChild(document.createTextNode(` · ${scoreLabel}: `));
  const scoreStrong = document.createElement('strong');
  scoreStrong.textContent = scoreFormatted;
  head.appendChild(scoreStrong);
  head.appendChild(document.createTextNode(` · ${solvedLabel} ${solvedFrac}`));
  head.appendChild(document.createTextNode(` · ${timeLabel}: ${timeSec}`));
  challengeSummaryBodyEl.appendChild(head);
  const list = document.createElement('ol');
  list.className = 'summary-list';
  for (const p of s.puzzles) {
    const li = document.createElement('li');
    const word = p.word || '???';
    const tries = p.guesses?.length || 0;
    const guessLabel = window.i18n
      ? window.i18n.t("challenge.summaryGuesses", { count: tries })
      : (tries === 1 ? `${tries} guess` : `${tries} guesses`);
    li.textContent = `${p.solved ? '✅' : '❌'} ${word} — ${guessLabel}`;
    list.appendChild(li);
  }
  challengeSummaryBodyEl.appendChild(list);
  challengeState.lastLeaderboardChallengeId = c.id;
}

if (challengeBackToListBtnEl) {
  challengeBackToListBtnEl.addEventListener('click', () => {
    challengeState.session = null;
    challengeState.activeChallenge = null;
    showChallengePanelOnly('challengeListPanel');
    loadChallengeList().then(renderChallengeList);
  });
}

if (challengeBackToListFromBoardBtnEl) {
  challengeBackToListFromBoardBtnEl.addEventListener('click', () => {
    showChallengePanelOnly('challengeListPanel');
  });
}

if (challengeViewLeaderboardBtnEl) {
  challengeViewLeaderboardBtnEl.addEventListener('click', () => {
    if (challengeState.lastLeaderboardChallengeId) {
      showChallengeLeaderboard(challengeState.lastLeaderboardChallengeId);
    }
  });
}

if (challengeQuitBtnEl) {
  challengeQuitBtnEl.addEventListener('click', async () => {
    if (!challengeState.session) return;
    if (!confirm(window.i18n ? window.i18n.t("challenge.quitConfirm") : 'Quit this challenge? Your progress so far will be saved as abandoned.')) return;
    try {
      const res = await challengeFetch(
        `/api/challenges/${encodeURIComponent(challengeState.session.challengeId)}/sessions/${encodeURIComponent(challengeState.session.id)}/finish`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      const json = await res.json().catch(() => ({}));
      if (json.session) {
        challengeState.session = json.session;
        stopChallengeTimer();
        enterChallengeSummary();
      }
    } catch (err) {
      setChallengePlayStatus(
        window.i18n
          ? window.i18n.t("challenge.quitFailed", { message: err.message })
          : `Quit failed: ${err.message}`,
        'admin-status-missing'
      );
    }
  });
}

async function showChallengeLeaderboard(challengeId) {
  showChallengePanelOnly('challengeLeaderboardPanel');
  if (!challengeLeaderboardTbodyEl) return;
  challengeLeaderboardTbodyEl.innerHTML = '';
  if (challengeLeaderboardNameEl) {
    challengeLeaderboardNameEl.textContent = window.i18n ? window.i18n.t("challenge.loading") : 'Loading…';
  }
  try {
    const res = await challengeFetch(`/api/challenges/${encodeURIComponent(challengeId)}/leaderboard`);
    if (!res.ok) {
      if (challengeLeaderboardNameEl) {
        challengeLeaderboardNameEl.textContent = window.i18n
          ? window.i18n.t("challenge.leaderboardUnavailable")
          : 'Leaderboard unavailable.';
      }
      return;
    }
    const json = await res.json();
    if (challengeLeaderboardNameEl) {
      const fallbackName = window.i18n
        ? window.i18n.t("challenge.leaderboardFallbackName")
        : "Challenge";
      const headerName = json.challenge?.name || fallbackName;
      const headerPolicy = json.challenge?.replayPolicy || "";
      challengeLeaderboardNameEl.textContent = window.i18n
        ? window.i18n.t("challenge.leaderboardHeader", { name: headerName, policy: headerPolicy })
        : `${headerName} · ${headerPolicy} replay`;
    }
    const rows = Array.isArray(json.rows) ? json.rows : [];
    renderLeaderboardTable(challengeLeaderboardTbodyEl, {
      rows,
      emptyText: window.i18n ? window.i18n.t("challenge.noCompleted") : 'No completed sessions yet.',
      // Defensive fallbacks match the play leaderboard's style — `||` for
      // strings (covers null/undefined/empty), `??` for numerics (covers
      // null/undefined but lets a legitimate 0 through). Without these,
      // malformed server payloads surface as literal "undefined" / "null" /
      // "NaN" in the leaderboard cells. Caught by CodeRabbit on PR #178.
      cols: [
        { value: (_, i) => `#${i + 1}` },
        { value: (row) => row.profileName || row.profileId || "-" },
        { value: (row) => String(row.score ?? 0) },
        { value: (row) => `${row.solvedCount ?? 0}/${row.totalPuzzles ?? 0}` },
        { value: (row) => `${row.elapsedSeconds ?? 0}s` }
      ]
    });
  } catch (err) {
    if (challengeLeaderboardNameEl) {
      challengeLeaderboardNameEl.textContent = window.i18n
        ? window.i18n.t("challenge.errorPrefix", { message: err.message })
        : `Error: ${err.message}`;
    }
  }
}

// Route the player to the challenge list when /challenges is in the URL,
// or surface the nav link otherwise. This intentionally keeps the
// existing hash-routing model and just hides/shows panels.
async function initChallengesUI() {
  // Wait for i18n messages to load before fetching/rendering — the
  // challenge cards' Start/Leaderboard buttons are built with
  // window.i18n.t() inline, so rendering before init() resolves
  // would leave literal `challenge.startBtn` strings on screen with
  // no data-i18n binding for updateDOM() to repair.
  if (window.i18nReady) {
    try { await window.i18nReady; } catch (_e) { /* fall through with English fallback */ }
  }
  // Also wait for /api/meta — without this, loadChallengeList races
  // init() and fires /api/challenges before deployCaps.challengesEnabled
  // has been set to false on a deploy that doesn't ship that backend.
  await ensureMetaReady();
  loadChallengeList().then(() => {
    renderChallengeList();
    if (location.pathname === '/challenges') {
      // Hide the rest of the UI panels and show the list.
      const otherPanels = document.querySelectorAll('main > section.panel');
      for (const el of otherPanels) {
        if (
          el.id !== 'challengeListPanel'
          && el.id !== 'challengePlayPanel'
          && el.id !== 'challengeSummaryPanel'
          && el.id !== 'challengeLeaderboardPanel'
        ) {
          el.classList.add('hidden');
        }
      }
      showChallengePanelOnly('challengeListPanel');
    }
  });
}

initChallengesUI();
