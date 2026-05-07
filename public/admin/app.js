const unlockPanelEl = document.getElementById("unlockPanel");
const shellPanelEl = document.getElementById("shellPanel");
const unlockFormEl = document.getElementById("unlockForm");
const adminKeyInputEl = document.getElementById("adminKeyInput");
const unlockStatusEl = document.getElementById("unlockStatus");
const workspaceStatusEl = document.getElementById("workspaceStatus");
const providersBodyEl = document.getElementById("providersBody");
const refreshProvidersBtnEl = document.getElementById("refreshProvidersBtn");
const lockSessionBtnEl = document.getElementById("lockSessionBtn");
const updatedEl = document.getElementById("adminUpdated");

const importFormEl = document.getElementById("importForm");
const importSourceTypeEl = document.getElementById("importSourceType");
const importVariantEl = document.getElementById("importVariant");
const importCommitEl = document.getElementById("importCommit");
const importRemoteFieldsEl = document.getElementById("importRemoteFields");
const importManualFieldsEl = document.getElementById("importManualFields");
const importChecksumDicEl = document.getElementById("importChecksumDic");
const importChecksumAffEl = document.getElementById("importChecksumAff");
const importDicFileEl = document.getElementById("importDicFile");
const importAffFileEl = document.getElementById("importAffFile");
const importFilterModeEl = document.getElementById("importFilterMode");
const importAsyncModeEl = document.getElementById("importAsyncMode");
const importSubmitBtnEl = document.getElementById("importSubmitBtn");
const importStatusEl = document.getElementById("importStatus");
const refreshJobsBtnEl = document.getElementById("refreshJobsBtn");
const jobsStatusEl = document.getElementById("jobsStatus");
const jobsBodyEl = document.getElementById("jobsBody");

const profilesBodyEl = document.getElementById("profilesBody");
const refreshProfilesBtnEl = document.getElementById("refreshProfilesBtn");
const profilesStatusEl = document.getElementById("profilesStatus");
const profilesLimitsFormEl = document.getElementById("profilesLimitsForm");
const profilesMaxProfilesEl = document.getElementById("profilesMaxProfiles");
const profilesMaxResultsEl = document.getElementById("profilesMaxResults");
const profilesLimitsStatusEl = document.getElementById("profilesLimitsStatus");

const runtimeFormEl = document.getElementById("runtimeForm");
const runtimeDefinitionsModeEl = document.getElementById("runtimeDefinitionsMode");
const runtimeDefinitionCacheSizeEl = document.getElementById("runtimeDefinitionCacheSize");
const runtimeDefinitionCacheTtlMsEl = document.getElementById("runtimeDefinitionCacheTtlMs");
const runtimeDefinitionShardCacheSizeEl = document.getElementById("runtimeDefinitionShardCacheSize");
const runtimeManualMaxBytesEl = document.getElementById("runtimeManualMaxBytes");
const runtimePerfLoggingEl = document.getElementById("runtimePerfLogging");
const resetRuntimeBtnEl = document.getElementById("resetRuntimeBtn");
const runtimeStatusEl = document.getElementById("runtimeStatus");
const runtimeSourcesBodyEl = document.getElementById("runtimeSourcesBody");
const runtimeLockedBodyEl = document.getElementById("runtimeLockedBody");

const tabButtons = Array.from(document.querySelectorAll(".admin-tab"));
const tabPanels = Array.from(document.querySelectorAll(".admin-slot"));

const PROVIDER_IMPORT_SOURCE_TYPES = Object.freeze({
  REMOTE_FETCH: "remote-fetch",
  MANUAL_UPLOAD: "manual-upload"
});
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MANUAL_FILE_BYTES = 8 * 1024 * 1024;
const JOB_REFRESH_INTERVAL_MS = 2500;

function createEmptyQueueState() {
  return {
    active: false,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0
  };
}

const state = {
  adminKey: "",
  unlocked: false,
  loading: false,
  importing: false,
  jobsLoading: false,
  runtimeLoading: false,
  providers: [],
  providerUpdates: Object.create(null),
  jobs: [],
  queue: createEmptyQueueState(),
  runtimeConfig: null,
  profiles: [],
  profilesLoading: false,
  activeTab: "providers"
};

let jobsRefreshTimer = null;

function setStatus(element, message, tone = "") {
  if (!element) return;
  element.textContent = message;
  element.classList.remove("admin-status-ok", "admin-status-off", "admin-status-missing");
  if (tone) {
    element.classList.add(tone);
  }
}

function setHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle("hidden", hidden);
}

function formatCommitShort(commit) {
  const value = String(commit || "").trim();
  if (!value) return "none";
  return value.slice(0, 10);
}

function summarizeProviderUpdateStatus(update) {
  if (!update || typeof update !== "object") {
    return "";
  }
  const status = String(update.status || "").trim();
  if (status === "up-to-date") {
    return `Upstream check: up-to-date (${formatCommitShort(update.currentCommit)}).`;
  }
  if (status === "update-available") {
    return `Upstream check: update available (${formatCommitShort(update.currentCommit)} -> ${formatCommitShort(update.latestCommit)}).`;
  }
  if (status === "unknown") {
    const latest = String(update.latestCommit || "").trim();
    if (latest) {
      return `Upstream check: latest available is ${formatCommitShort(latest)} (no installed commit selected).`;
    }
    return `Upstream check: ${String(update.message || "Unknown state.")}`;
  }
  return `Upstream check failed: ${String(update.message || "Try again later.")}`;
}

function toProviderUpdateInfo(payload) {
  return {
    status: String(payload?.status || "").trim(),
    currentCommit: payload?.currentCommit || null,
    latestCommit: payload?.latestCommit || null,
    message: String(payload?.message || "").trim(),
    checkedAt: payload?.checkedAt || null
  };
}

function applyProvidersPayload(payload) {
  state.providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const visibleVariants = new Set(state.providers.map((provider) => String(provider.variant || "").trim()));
  Object.keys(state.providerUpdates).forEach((variant) => {
    if (!visibleVariants.has(variant)) {
      delete state.providerUpdates[variant];
    }
  });
}

function applyJobsPayload(payload) {
  state.jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  state.queue = payload?.queue && typeof payload.queue === "object"
    ? {
        active: Boolean(payload.queue.active),
        queued: Number(payload.queue.queued || 0),
        running: Number(payload.queue.running || 0),
        succeeded: Number(payload.queue.succeeded || 0),
        failed: Number(payload.queue.failed || 0),
        canceled: Number(payload.queue.canceled || 0)
      }
    : createEmptyQueueState();
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "-");
  row.appendChild(cell);
}

function readFileAsArrayBuffer(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("Selected file is not readable.");
  }
  return file.arrayBuffer();
}

function bytesToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser does not support SHA-256 hashing for manual uploads.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(digest);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function getImportSourceType() {
  return String(importSourceTypeEl?.value || PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH).trim();
}

function updateImportModeUi() {
  const sourceType = getImportSourceType();
  const isManual = sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD;
  setHidden(importRemoteFieldsEl, isManual);
  setHidden(importManualFieldsEl, !isManual);
}

function renderTabs() {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === state.activeTab;
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.tabIndex = isActive ? 0 : -1;
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.dataset.panel === state.activeTab;
    panel.hidden = !isActive;
    panel.classList.toggle("hidden", !isActive);
  });
}

function focusActiveTab() {
  const active = tabButtons.find((button) => button.dataset.tab === state.activeTab);
  if (active) {
    active.focus();
  }
}

function activateTab(nextTab, focus = false) {
  const tabId = String(nextTab || "").trim();
  if (!tabId) return;
  const exists = tabButtons.some((button) => button.dataset.tab === tabId);
  if (!exists) return;
  state.activeTab = tabId;
  renderTabs();
  if (focus) {
    focusActiveTab();
  }
  if (tabId === "profiles" && state.unlocked && !state.profilesLoading) {
    loadProfiles({ announce: true }).catch(() => {});
  }
}

function formatTimestamp(isoValue) {
  const value = String(isoValue || "").trim();
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function renderProviders() {
  providersBodyEl.innerHTML = "";
  if (!state.providers.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No provider variants are registered yet.";
    row.appendChild(cell);
    providersBodyEl.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.providers.forEach((provider) => {
    const row = document.createElement("tr");

    const variantCell = document.createElement("td");
    variantCell.textContent = provider.variant;
    row.appendChild(variantCell);

    const labelCell = document.createElement("td");
    labelCell.textContent = provider.label;
    row.appendChild(labelCell);

    const statusCell = document.createElement("td");
    statusCell.classList.add("admin-provider-status");
    const status = String(provider.status || "").trim()
      || (provider.enabled ? "enabled" : provider.imported ? "imported" : "not-imported");
    const statusLabel = document.createElement("span");
    statusLabel.textContent = status.replace(/-/g, " ");
    statusCell.appendChild(statusLabel);
    if (status === "enabled" || status === "imported") {
      statusCell.className = "admin-status-ok";
    } else if (status === "error") {
      statusCell.className = "admin-status-missing";
    } else {
      statusCell.className = "admin-status-off";
    }
    statusCell.classList.add("admin-provider-status");

    const detailText = status === "error"
      ? String(provider.error || "").trim()
      : String(provider.warning || "").trim();
    if (detailText) {
      const details = document.createElement("small");
      details.className = "admin-provider-status-detail";
      details.textContent = detailText;
      statusCell.appendChild(details);
      statusCell.title = detailText;
    }

    const updateSummary = summarizeProviderUpdateStatus(state.providerUpdates[provider.variant]);
    if (updateSummary) {
      const updateDetails = document.createElement("small");
      updateDetails.className = "admin-provider-update-detail";
      updateDetails.textContent = updateSummary;
      statusCell.appendChild(updateDetails);
    }
    row.appendChild(statusCell);

    const commitCell = document.createElement("td");
    commitCell.textContent = provider.activeCommit || "-";
    row.appendChild(commitCell);

    const actionsCell = document.createElement("td");
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "admin-action-stack";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "ghost";
    toggleButton.dataset.variant = provider.variant;
    toggleButton.dataset.action = provider.enabled ? "disable" : "enable";
    toggleButton.textContent = provider.enabled ? "Disable" : "Enable";
    toggleButton.disabled = state.loading
      || state.importing
      || state.jobsLoading
      || (!provider.enabled && !Array.isArray(provider.importedCommits))
      || (!provider.enabled && provider.importedCommits.length === 0);
    actionsWrap.appendChild(toggleButton);

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.className = "ghost";
    importButton.dataset.variant = provider.variant;
    importButton.dataset.action = "prefill-import";
    importButton.textContent = provider.imported ? "Re-import" : "Import";
    importButton.disabled = state.loading || state.importing || state.jobsLoading;
    actionsWrap.appendChild(importButton);

    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.className = "ghost";
    updateButton.dataset.variant = provider.variant;
    updateButton.dataset.action = "check-update";
    updateButton.textContent = "Check update";
    updateButton.disabled = state.loading || state.importing || state.jobsLoading;
    actionsWrap.appendChild(updateButton);

    actionsCell.appendChild(actionsWrap);
    row.appendChild(actionsCell);

    fragment.appendChild(row);
  });

  providersBodyEl.appendChild(fragment);
}

function renderJobs() {
  if (!jobsBodyEl) {
    return;
  }
  jobsBodyEl.innerHTML = "";
  if (!state.jobs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No import jobs yet.";
    row.appendChild(cell);
    jobsBodyEl.appendChild(row);
  } else {
    const fragment = document.createDocumentFragment();
    state.jobs.forEach((job) => {
      const row = document.createElement("tr");
      appendCell(row, job.id);
      appendCell(row, job.status || "-");
      appendCell(row, job.request?.variant || "-");
      appendCell(row, job.request?.sourceType || "-");
      appendCell(row, job.artifacts?.commit || job.request?.commit || "-");
      appendCell(row, formatTimestamp(job.updatedAt));
      appendCell(row, job.error?.message || "-");
      fragment.appendChild(row);
    });
    jobsBodyEl.appendChild(fragment);
  }

  const queue = state.queue;
  const statusText = `Queue ${queue.active ? "active" : "idle"} · queued ${queue.queued} · running ${queue.running} · failed ${queue.failed}`;
  const tone = queue.failed > 0
    ? "admin-status-missing"
    : queue.active || queue.queued > 0 || queue.running > 0
      ? "admin-status-off"
      : "admin-status-ok";
  setStatus(jobsStatusEl, statusText, tone);
}

function setRuntimeFormEnabled(enabled) {
  if (!runtimeFormEl) {
    return;
  }
  const controls = runtimeFormEl.querySelectorAll("input,select,button");
  controls.forEach((element) => {
    element.disabled = !enabled;
  });
}

function renderRuntimeSources() {
  if (!runtimeSourcesBodyEl) {
    return;
  }
  runtimeSourcesBodyEl.innerHTML = "";

  const runtime = state.runtimeConfig;
  if (!runtime || typeof runtime !== "object") {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "Runtime config is not loaded yet.";
    row.appendChild(cell);
    runtimeSourcesBodyEl.appendChild(row);
    return;
  }

  const rows = [
    {
      key: "definitions.mode",
      value: runtime.effective?.definitions?.mode,
      source: runtime.sources?.definitions?.mode
    },
    {
      key: "definitions.cacheSize",
      value: runtime.effective?.definitions?.cacheSize,
      source: runtime.sources?.definitions?.cacheSize
    },
    {
      key: "definitions.cacheTtlMs",
      value: runtime.effective?.definitions?.cacheTtlMs,
      source: runtime.sources?.definitions?.cacheTtlMs
    },
    {
      key: "definitions.shardCacheSize",
      value: runtime.effective?.definitions?.shardCacheSize,
      source: runtime.sources?.definitions?.shardCacheSize
    },
    {
      key: "limits.providerManualMaxFileBytes",
      value: runtime.effective?.limits?.providerManualMaxFileBytes,
      source: runtime.sources?.limits?.providerManualMaxFileBytes
    },
    {
      key: "diagnostics.perfLogging",
      value: runtime.effective?.diagnostics?.perfLogging,
      source: runtime.sources?.diagnostics?.perfLogging
    }
  ];

  const fragment = document.createDocumentFragment();
  rows.forEach((entry) => {
    const row = document.createElement("tr");
    appendCell(row, entry.key);
    appendCell(row, entry.value);
    appendCell(row, entry.source || "default");
    fragment.appendChild(row);
  });

  runtimeSourcesBodyEl.appendChild(fragment);
}

function renderLockedSettings() {
  if (!runtimeLockedBodyEl) {
    return;
  }
  runtimeLockedBodyEl.innerHTML = "";

  const runtime = state.runtimeConfig;
  if (!runtime || typeof runtime !== "object") {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = "Runtime config is not loaded yet.";
    row.appendChild(cell);
    runtimeLockedBodyEl.appendChild(row);
    return;
  }

  const sec = runtime.effective?.security || {};
  const srv = runtime.effective?.server || {};
  const rows = [
    { key: "security.trustProxy", value: sec.trustProxy },
    { key: "security.trustProxyHops", value: sec.trustProxyHops },
    { key: "security.requireAdminKey", value: sec.requireAdminKey },
    { key: "server.jsonBodyLimit", value: srv.jsonBodyLimit },
    { key: "server.rateLimitWindowMs", value: srv.rateLimitWindowMs },
    { key: "server.rateLimitMax", value: srv.rateLimitMax },
    { key: "server.adminRateLimitWindowMs", value: srv.adminRateLimitWindowMs },
    { key: "server.adminRateLimitMax", value: srv.adminRateLimitMax },
    { key: "server.adminWriteRateLimitWindowMs", value: srv.adminWriteRateLimitWindowMs },
    { key: "server.adminWriteRateLimitMax", value: srv.adminWriteRateLimitMax }
  ];

  const fragment = document.createDocumentFragment();
  rows.forEach((entry) => {
    const row = document.createElement("tr");
    appendCell(row, entry.key);
    appendCell(row, entry.value ?? "-");
    fragment.appendChild(row);
  });
  runtimeLockedBodyEl.appendChild(fragment);
}

function populateRuntimeFormFromState() {
  const runtime = state.runtimeConfig;
  if (!runtime) {
    return;
  }
  const manualUploadEditableLimits = runtime.editable?.limits?.providerManualMaxFileBytes || {};
  runtimeManualMaxBytesEl.min = String(manualUploadEditableLimits.min ?? 1048576);
  runtimeManualMaxBytesEl.max = String(manualUploadEditableLimits.max ?? MAX_MANUAL_FILE_BYTES);
  runtimeDefinitionsModeEl.value = String(runtime.overrides?.definitions?.mode || runtime.effective?.definitions?.mode || "memory");
  runtimeDefinitionCacheSizeEl.value = String(
    runtime.overrides?.definitions?.cacheSize ?? runtime.effective?.definitions?.cacheSize ?? ""
  );
  runtimeDefinitionCacheTtlMsEl.value = String(
    runtime.overrides?.definitions?.cacheTtlMs ?? runtime.effective?.definitions?.cacheTtlMs ?? ""
  );
  runtimeDefinitionShardCacheSizeEl.value = String(
    runtime.overrides?.definitions?.shardCacheSize ?? runtime.effective?.definitions?.shardCacheSize ?? ""
  );
  runtimeManualMaxBytesEl.value = String(
    runtime.overrides?.limits?.providerManualMaxFileBytes
    ?? runtime.effective?.limits?.providerManualMaxFileBytes
    ?? ""
  );
  runtimePerfLoggingEl.checked = Boolean(
    runtime.overrides?.diagnostics?.perfLogging
    ?? runtime.effective?.diagnostics?.perfLogging
  );
}

function renderWorkspace() {
  setHidden(unlockPanelEl, state.unlocked);
  setHidden(shellPanelEl, !state.unlocked);

  const controlsDisabled = !state.unlocked || state.loading || state.importing || state.jobsLoading || state.runtimeLoading;
  refreshProvidersBtnEl.disabled = controlsDisabled;
  lockSessionBtnEl.disabled = !state.unlocked || state.loading || state.importing;

  [
    importSourceTypeEl,
    importVariantEl,
    importCommitEl,
    importChecksumDicEl,
    importChecksumAffEl,
    importDicFileEl,
    importAffFileEl,
    importFilterModeEl,
    importAsyncModeEl,
    importSubmitBtnEl,
    refreshJobsBtnEl
  ].forEach((element) => {
    if (element) {
      element.disabled = controlsDisabled;
    }
  });

  setRuntimeFormEnabled(state.unlocked && !state.loading && !state.runtimeLoading);
  updatedEl.textContent = state.unlocked ? "Session unlocked" : "Session locked";
  renderTabs();
  renderProviders();
  renderJobs();
  renderRuntimeSources();
  renderLockedSettings();
}

function scheduleQueueRefresh() {
  if (jobsRefreshTimer) {
    clearTimeout(jobsRefreshTimer);
    jobsRefreshTimer = null;
  }
  const queue = state.queue;
  if (!state.unlocked) {
    return;
  }
  if (!(queue.active || queue.queued > 0 || queue.running > 0)) {
    return;
  }

  jobsRefreshTimer = setTimeout(async () => {
    try {
      await loadJobs({ announce: false });
      await loadProviders({ announce: false });
    } catch (_err) {
      // Best effort refresh while queue is active.
    }
    scheduleQueueRefresh();
  }, JOB_REFRESH_INTERVAL_MS);
}

async function requestAdminJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.adminKey) {
    headers.set("x-admin-key", state.adminKey);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (response.ok) {
    return payload;
  }

  const message =
    typeof payload.error === "string" && payload.error.trim()
      ? payload.error
      : `Request failed with status ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  throw error;
}

async function loadProviders(options = {}) {
  if (options.announce !== false) {
    state.loading = true;
    renderWorkspace();
  }
  try {
    const payload = await requestAdminJson("/api/admin/providers");
    applyProvidersPayload(payload);
    state.unlocked = true;
    if (options.announce !== false) {
      setStatus(workspaceStatusEl, "Provider status loaded.", "admin-status-ok");
      setStatus(unlockStatusEl, "");
    }
  } catch (err) {
    const unauthorized = Number(err.status || 0) === 401;
    state.unlocked = false;
    state.providers = [];
    if (options.announce !== false) {
      setStatus(
        unlockStatusEl,
        unauthorized ? "Admin key rejected. Check the key and try again." : `Could not unlock admin shell: ${err.message}`,
        "admin-status-missing"
      );
      setStatus(workspaceStatusEl, "");
    }
    throw err;
  } finally {
    if (options.announce !== false) {
      state.loading = false;
      renderWorkspace();
    }
  }
}

async function loadJobs(options = {}) {
  state.jobsLoading = true;
  if (options.announce !== false) {
    renderWorkspace();
  }
  try {
    const payload = await requestAdminJson("/api/admin/jobs?limit=30");
    applyJobsPayload(payload);
    if (options.announce !== false) {
      setStatus(jobsStatusEl, "Import queue loaded.", "admin-status-ok");
    }
    return payload;
  } finally {
    state.jobsLoading = false;
    renderWorkspace();
    scheduleQueueRefresh();
  }
}

async function loadRuntimeConfig(options = {}) {
  state.runtimeLoading = true;
  renderWorkspace();
  try {
    const payload = await requestAdminJson("/api/admin/runtime-config");
    state.runtimeConfig = payload;
    populateRuntimeFormFromState();
    populateProfilesLimitsForm();
    if (options.announce !== false) {
      setStatus(runtimeStatusEl, "Runtime config loaded.", "admin-status-ok");
    }
    return payload;
  } finally {
    state.runtimeLoading = false;
    renderWorkspace();
  }
}

function findProviderByVariant(variant) {
  const key = String(variant || "").trim().toLowerCase();
  return state.providers.find((provider) => String(provider.variant || "").toLowerCase() === key) || null;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatAverage(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return value.toFixed(2);
}

function findProfileById(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  return state.profiles.find((profile) => profile.id === key) || null;
}

async function loadProfiles(options = {}) {
  if (!state.unlocked || !profilesBodyEl) {
    return;
  }
  state.profilesLoading = true;
  if (options.announce !== false) {
    setStatus(profilesStatusEl, "Loading profiles…", "");
  }
  try {
    const payload = await requestAdminJson("/api/admin/stats/profiles");
    state.profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    renderProfiles();
    if (options.announce !== false) {
      setStatus(
        profilesStatusEl,
        `Loaded ${state.profiles.length} profile${state.profiles.length === 1 ? "" : "s"}.`,
        "admin-status-ok"
      );
    }
    return payload;
  } catch (err) {
    if (options.announce !== false) {
      setStatus(profilesStatusEl, `Profile list failed: ${err.message}`, "admin-status-missing");
    }
    throw err;
  } finally {
    state.profilesLoading = false;
  }
}

function renderProfiles() {
  if (!profilesBodyEl) return;
  profilesBodyEl.innerHTML = "";

  if (!state.profiles.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "No player profiles yet.";
    row.appendChild(cell);
    profilesBodyEl.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.profiles.forEach((profile) => {
    const stats = profile.stats || {};
    const row = document.createElement("tr");
    row.dataset.profileId = profile.id;

    const nameCell = document.createElement("td");
    nameCell.textContent = profile.name;
    row.appendChild(nameCell);

    const gamesCell = document.createElement("td");
    gamesCell.textContent = String(stats.totalGames ?? 0);
    row.appendChild(gamesCell);

    const winsCell = document.createElement("td");
    winsCell.textContent = String(stats.wins ?? 0);
    row.appendChild(winsCell);

    const winRateCell = document.createElement("td");
    winRateCell.textContent = formatPercent(stats.winRate);
    row.appendChild(winRateCell);

    const avgCell = document.createElement("td");
    avgCell.textContent = formatAverage(stats.averageWinningAttempts);
    row.appendChild(avgCell);

    const lastPlayedCell = document.createElement("td");
    lastPlayedCell.textContent = formatTimestamp(stats.lastPlayedAt);
    row.appendChild(lastPlayedCell);

    const createdCell = document.createElement("td");
    createdCell.textContent = formatTimestamp(profile.createdAt);
    row.appendChild(createdCell);

    const actionsCell = document.createElement("td");
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "ghost";
    renameBtn.dataset.action = "rename-profile";
    renameBtn.dataset.profileId = profile.id;
    renameBtn.textContent = "Rename";
    actionsCell.appendChild(renameBtn);

    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "ghost";
    mergeBtn.dataset.action = "merge-profile";
    mergeBtn.dataset.profileId = profile.id;
    mergeBtn.textContent = "Merge into…";
    mergeBtn.disabled = state.profiles.length < 2;
    actionsCell.appendChild(mergeBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "ghost";
    deleteBtn.dataset.action = "delete-profile";
    deleteBtn.dataset.profileId = profile.id;
    deleteBtn.textContent = "Delete";
    actionsCell.appendChild(deleteBtn);

    row.appendChild(actionsCell);
    fragment.appendChild(row);
  });

  profilesBodyEl.appendChild(fragment);
}

function populateProfilesLimitsForm() {
  if (!profilesMaxProfilesEl || !profilesMaxResultsEl) return;
  const limits = state.runtimeConfig?.effective?.limits || {};
  if (Number.isInteger(limits.leaderboardMaxProfiles)) {
    profilesMaxProfilesEl.value = String(limits.leaderboardMaxProfiles);
  }
  if (Number.isInteger(limits.leaderboardMaxResultsPerProfile)) {
    profilesMaxResultsEl.value = String(limits.leaderboardMaxResultsPerProfile);
  }

  const sources = state.runtimeConfig?.sources?.limits || {};
  profilesMaxProfilesEl.disabled = sources.leaderboardMaxProfiles === "env";
  profilesMaxResultsEl.disabled = sources.leaderboardMaxResultsPerProfile === "env";
}

async function renameProfile(profileId) {
  const profile = findProfileById(profileId);
  if (!profile) return;
  const next = window.prompt(`Rename profile "${profile.name}" to:`, profile.name);
  if (next === null) return;
  const trimmed = String(next).trim();
  if (!trimmed) {
    setStatus(profilesStatusEl, "Rename cancelled — name is empty.", "admin-status-off");
    return;
  }
  if (trimmed === profile.name) {
    return;
  }
  try {
    await requestAdminJson(`/api/admin/stats/profile/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed })
    });
    setStatus(profilesStatusEl, `Renamed to "${trimmed}".`, "admin-status-ok");
    await loadProfiles({ announce: false });
  } catch (err) {
    setStatus(profilesStatusEl, `Rename failed: ${err.message}`, "admin-status-missing");
  }
}

async function deleteProfile(profileId) {
  const profile = findProfileById(profileId);
  if (!profile) return;
  const typed = window.prompt(
    `Type the profile name "${profile.name}" exactly to permanently delete it and all of its results.`
  );
  if (typed === null) return;
  if (typed.trim() !== profile.name) {
    setStatus(profilesStatusEl, "Delete cancelled — name did not match.", "admin-status-off");
    return;
  }
  try {
    await requestAdminJson(`/api/admin/stats/profile/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: profile.name })
    });
    setStatus(profilesStatusEl, `Deleted "${profile.name}".`, "admin-status-ok");
    await loadProfiles({ announce: false });
  } catch (err) {
    setStatus(profilesStatusEl, `Delete failed: ${err.message}`, "admin-status-missing");
  }
}

async function mergeProfileFlow(sourceId) {
  const source = findProfileById(sourceId);
  if (!source) return;
  const others = state.profiles.filter((profile) => profile.id !== sourceId);
  if (others.length === 0) {
    setStatus(profilesStatusEl, "No other profiles available to merge into.", "admin-status-off");
    return;
  }

  const promptLines = [
    `Merge "${source.name}" into another profile.`,
    "Type the target profile name exactly:",
    "",
    "Available profiles:"
  ];
  others.forEach((profile) => {
    promptLines.push(` • ${profile.name}`);
  });
  const targetName = window.prompt(promptLines.join("\n"));
  if (targetName === null) return;
  const target = others.find((profile) => profile.name === targetName.trim());
  if (!target) {
    setStatus(profilesStatusEl, "Merge cancelled — target name did not match.", "admin-status-off");
    return;
  }
  if (
    !window.confirm(
      `Merge "${source.name}" into "${target.name}"?\n\nResults are merged using the conflict-resolution policy. The source profile will be deleted. This cannot be undone.`
    )
  ) {
    return;
  }
  try {
    await requestAdminJson(`/api/admin/stats/profile/${encodeURIComponent(sourceId)}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProfileId: target.id, confirmed: true })
    });
    setStatus(
      profilesStatusEl,
      `Merged "${source.name}" into "${target.name}".`,
      "admin-status-ok"
    );
    await loadProfiles({ announce: false });
  } catch (err) {
    setStatus(profilesStatusEl, `Merge failed: ${err.message}`, "admin-status-missing");
  }
}

async function saveProfilesLimits() {
  const overrides = state.runtimeConfig?.overrides || {};
  const nextLimits = { ...(overrides.limits || {}) };

  const maxProfilesValue = Number(profilesMaxProfilesEl?.value);
  if (Number.isInteger(maxProfilesValue) && maxProfilesValue > 0) {
    nextLimits.leaderboardMaxProfiles = maxProfilesValue;
  } else {
    delete nextLimits.leaderboardMaxProfiles;
  }

  const maxResultsValue = Number(profilesMaxResultsEl?.value);
  if (Number.isInteger(maxResultsValue) && maxResultsValue > 0) {
    nextLimits.leaderboardMaxResultsPerProfile = maxResultsValue;
  } else {
    delete nextLimits.leaderboardMaxResultsPerProfile;
  }

  const nextOverrides = {
    ...overrides,
    limits: Object.keys(nextLimits).length ? nextLimits : undefined
  };
  if (!nextOverrides.limits) {
    delete nextOverrides.limits;
  }

  try {
    await saveRuntimeOverrides(nextOverrides);
    setStatus(profilesLimitsStatusEl, "Leaderboard limits saved.", "admin-status-ok");
  } catch (err) {
    setStatus(profilesLimitsStatusEl, `Save failed: ${err.message}`, "admin-status-missing");
  }
}

async function checkProviderUpdateStatus(variant) {
  const provider = findProviderByVariant(variant);
  if (!provider) {
    throw new Error("Provider variant could not be found in current status list.");
  }

  const fallbackCommit = provider.activeCommit || provider.importedCommits?.[0] || "";
  state.loading = true;
  renderWorkspace();
  try {
    const response = await requestAdminJson(
      `/api/admin/providers/${encodeURIComponent(provider.variant)}/check-update`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: fallbackCommit ? JSON.stringify({ commit: fallbackCommit }) : JSON.stringify({})
      }
    );
    const updateInfo = toProviderUpdateInfo(response);
    state.providerUpdates[provider.variant] = updateInfo;
    applyProvidersPayload(response);
    const summary = summarizeProviderUpdateStatus(updateInfo);
    const tone = updateInfo.status === "error"
      ? "admin-status-missing"
      : updateInfo.status === "update-available"
        ? "admin-status-off"
        : "admin-status-ok";
    setStatus(workspaceStatusEl, summary || "Upstream update check complete.", tone);
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

async function parseImportPayloadFromForm() {
  const sourceType = getImportSourceType();
  const variant = String(importVariantEl?.value || "").trim();
  const commit = String(importCommitEl?.value || "").trim();
  const filterMode = String(importFilterModeEl?.value || "denylist-only").trim();
  const runAsync = importAsyncModeEl?.checked !== false;

  if (!variant) {
    throw new Error("Select a variant before importing.");
  }
  if (filterMode !== "denylist-only" && filterMode !== "allowlist-required") {
    throw new Error("Filter mode must be denylist-only or allowlist-required.");
  }

  if (sourceType === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD) {
    const dicFile = importDicFileEl?.files?.[0];
    const affFile = importAffFileEl?.files?.[0];
    const maxManualFileBytes = Number(
      state.runtimeConfig?.effective?.limits?.providerManualMaxFileBytes || MAX_MANUAL_FILE_BYTES
    );
    if (!dicFile || !affFile) {
      throw new Error("Select both .dic and .aff files for manual upload.");
    }
    if (dicFile.size > maxManualFileBytes || affFile.size > maxManualFileBytes) {
      throw new Error(`Manual upload files must each be <= ${maxManualFileBytes} bytes.`);
    }
    if (commit && !COMMIT_PATTERN.test(commit)) {
      throw new Error("Commit must be a 40-character lowercase hexadecimal SHA when provided.");
    }

    const [dicBuffer, affBuffer] = await Promise.all([
      readFileAsArrayBuffer(dicFile),
      readFileAsArrayBuffer(affFile)
    ]);
    const [dicChecksum, affChecksum] = await Promise.all([
      sha256Hex(dicBuffer),
      sha256Hex(affBuffer)
    ]);

    return {
      async: runAsync,
      sourceType,
      variant,
      commit,
      filterMode,
      expectedChecksums: {
        dic: dicChecksum,
        aff: affChecksum
      },
      manualFiles: {
        dicBase64: arrayBufferToBase64(dicBuffer),
        affBase64: arrayBufferToBase64(affBuffer),
        dicFileName: dicFile.name,
        affFileName: affFile.name
      }
    };
  }

  const checksumDic = String(importChecksumDicEl?.value || "").trim().toLowerCase();
  const checksumAff = String(importChecksumAffEl?.value || "").trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Commit must be a 40-character lowercase hexadecimal SHA.");
  }
  if (!CHECKSUM_PATTERN.test(checksumDic) || !CHECKSUM_PATTERN.test(checksumAff)) {
    throw new Error("Checksums must be 64-character lowercase SHA-256 values.");
  }

  return {
    async: runAsync,
    sourceType,
    variant,
    commit,
    filterMode,
    expectedChecksums: {
      dic: checksumDic,
      aff: checksumAff
    }
  };
}

async function importProvider() {
  const payload = await parseImportPayloadFromForm();
  state.importing = true;
  renderWorkspace();
  setStatus(importStatusEl, "Import submitted. Waiting for queue update...", "admin-status-off");
  try {
    const response = await requestAdminJson("/api/admin/providers/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.action === "queued") {
      const queueText = response.job?.id
        ? `Import queued (${response.job.id}).`
        : "Import queued.";
      setStatus(importStatusEl, queueText, "admin-status-off");
      await loadJobs({ announce: false });
      await loadProviders({ announce: false });
      setStatus(workspaceStatusEl, `Provider import queued for ${payload.variant}.`, "admin-status-off");
      return;
    }

    const activated = Number(response?.counts?.filteredAnswers || 0);
    const shortCommit = String(response?.commit || payload.commit || "").slice(0, 10) || "auto";
    setStatus(
      importStatusEl,
      `Import complete for ${payload.variant} @ ${shortCommit}... (${activated} family-safe answers).`,
      "admin-status-ok"
    );
    await loadProviders({ announce: false });
    await loadJobs({ announce: false });
    setStatus(workspaceStatusEl, `Provider import succeeded for ${payload.variant}.`, "admin-status-ok");
  } finally {
    state.importing = false;
    renderWorkspace();
  }
}

async function toggleProviderState(variant, action) {
  const provider = findProviderByVariant(variant);
  if (!provider) {
    throw new Error("Provider variant could not be found in current status list.");
  }

  const wantsEnable = action === "enable";
  const endpoint = wantsEnable
    ? `/api/admin/providers/${encodeURIComponent(provider.variant)}/enable`
    : `/api/admin/providers/${encodeURIComponent(provider.variant)}/disable`;
  const commit = provider.activeCommit || provider.importedCommits?.[0] || null;

  if (wantsEnable) {
    if (!commit) {
      throw new Error("No imported commit is available to enable.");
    }
    const shouldContinue = window.confirm(
      `Enable ${provider.variant} using commit ${commit}? This will expose the language in Create/Play.`
    );
    if (!shouldContinue) {
      return;
    }
  }

  state.loading = true;
  renderWorkspace();
  try {
    const requestPayload = wantsEnable ? { commit } : {};
    await requestAdminJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload)
    });
    setStatus(
      workspaceStatusEl,
      wantsEnable ? `${provider.variant} enabled.` : `${provider.variant} disabled.`,
      "admin-status-ok"
    );
    await loadProviders({ announce: false });
    await loadJobs({ announce: false });
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

function buildRuntimeOverridePayload() {
  const parseOptionalInteger = (element, fieldName) => {
    const raw = String(element?.value || "").trim();
    if (!raw) {
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${fieldName} must be an integer.`);
    }
    return parsed;
  };

  const definitionsMode = String(runtimeDefinitionsModeEl.value || "memory").trim();
  const cacheSize = parseOptionalInteger(runtimeDefinitionCacheSizeEl, "Definition cache size");
  const cacheTtlMs = parseOptionalInteger(runtimeDefinitionCacheTtlMsEl, "Definition cache TTL");
  const shardCacheSize = parseOptionalInteger(runtimeDefinitionShardCacheSizeEl, "Definition shard cache size");
  const providerManualMaxFileBytes = parseOptionalInteger(runtimeManualMaxBytesEl, "Manual upload max bytes");

  const definitions = { mode: definitionsMode };
  if (cacheSize !== undefined) {
    definitions.cacheSize = cacheSize;
  }
  if (cacheTtlMs !== undefined) {
    definitions.cacheTtlMs = cacheTtlMs;
  }
  if (shardCacheSize !== undefined) {
    definitions.shardCacheSize = shardCacheSize;
  }

  const limits = {};
  if (providerManualMaxFileBytes !== undefined) {
    limits.providerManualMaxFileBytes = providerManualMaxFileBytes;
  }

  return {
    definitions,
    limits,
    diagnostics: {
      perfLogging: Boolean(runtimePerfLoggingEl.checked)
    }
  };
}

async function saveRuntimeOverrides(overrides) {
  state.runtimeLoading = true;
  renderWorkspace();
  try {
    const payload = await requestAdminJson("/api/admin/runtime-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides })
    });
    state.runtimeConfig = payload;
    populateRuntimeFormFromState();
    populateProfilesLimitsForm();
    setStatus(runtimeStatusEl, "Runtime overrides saved.", "admin-status-ok");
    setStatus(workspaceStatusEl, "Runtime settings updated.", "admin-status-ok");
  } finally {
    state.runtimeLoading = false;
    renderWorkspace();
  }
}

async function unlockWorkspace() {
  state.loading = true;
  renderWorkspace();
  try {
    await loadProviders({ announce: true });
    await Promise.all([
      loadJobs({ announce: false }).catch((err) => {
        setStatus(jobsStatusEl, `Could not load queue: ${err.message}`, "admin-status-missing");
      }),
      loadRuntimeConfig({ announce: false }).catch((err) => {
        setStatus(runtimeStatusEl, `Could not load runtime config: ${err.message}`, "admin-status-missing");
      })
    ]);
  } finally {
    state.loading = false;
    renderWorkspace();
  }
}

unlockFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.adminKey = String(adminKeyInputEl.value || "").trim();
  await unlockWorkspace().catch(() => {});
  adminKeyInputEl.value = "";
});

refreshProvidersBtnEl.addEventListener("click", async () => {
  if (!state.unlocked) return;
  await Promise.all([
    loadProviders({ announce: true }),
    loadJobs({ announce: false }),
    loadRuntimeConfig({ announce: false })
  ]).catch(() => {});
});

if (refreshJobsBtnEl) {
  refreshJobsBtnEl.addEventListener("click", async () => {
    if (!state.unlocked) return;
    await loadJobs({ announce: true }).catch((err) => {
      setStatus(jobsStatusEl, `Queue refresh failed: ${err.message}`, "admin-status-missing");
    });
  });
}

lockSessionBtnEl.addEventListener("click", () => {
  if (jobsRefreshTimer) {
    clearTimeout(jobsRefreshTimer);
    jobsRefreshTimer = null;
  }
  state.adminKey = "";
  state.unlocked = false;
  state.providers = [];
  state.jobs = [];
  state.queue = createEmptyQueueState();
  state.runtimeConfig = null;
  state.providerUpdates = Object.create(null);
  state.profiles = [];
  state.profilesLoading = false;
  if (profilesBodyEl) profilesBodyEl.innerHTML = "";
  setStatus(profilesStatusEl, "");
  setStatus(profilesLimitsStatusEl, "");
  setStatus(workspaceStatusEl, "Session locked. Re-enter admin key to continue.", "admin-status-off");
  setStatus(unlockStatusEl, "");
  setStatus(jobsStatusEl, "", "");
  setStatus(runtimeStatusEl, "", "");
  renderWorkspace();
  adminKeyInputEl.focus();
});

if (importFormEl) {
  importFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await importProvider();
    } catch (err) {
      setStatus(importStatusEl, `Import failed: ${err.message}`, "admin-status-missing");
    }
  });
}

if (runtimeFormEl) {
  runtimeFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveRuntimeOverrides(buildRuntimeOverridePayload());
    } catch (err) {
      setStatus(runtimeStatusEl, `Runtime update failed: ${err.message}`, "admin-status-missing");
    }
  });
}

if (resetRuntimeBtnEl) {
  resetRuntimeBtnEl.addEventListener("click", async () => {
    try {
      await saveRuntimeOverrides({});
      setStatus(runtimeStatusEl, "Runtime overrides reset to defaults/env.", "admin-status-ok");
    } catch (err) {
      setStatus(runtimeStatusEl, `Reset failed: ${err.message}`, "admin-status-missing");
    }
  });
}

if (refreshProfilesBtnEl) {
  refreshProfilesBtnEl.addEventListener("click", async () => {
    if (!state.unlocked) return;
    await loadProfiles({ announce: true }).catch(() => {});
  });
}

if (profilesBodyEl) {
  profilesBodyEl.addEventListener("click", async (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-action]")
      : null;
    if (!target) return;
    const action = String(target.dataset.action || "").trim();
    const profileId = String(target.dataset.profileId || "").trim();
    if (!action || !profileId) return;

    if (action === "rename-profile") {
      await renameProfile(profileId);
    } else if (action === "delete-profile") {
      await deleteProfile(profileId);
    } else if (action === "merge-profile") {
      await mergeProfileFlow(profileId);
    }
  });
}

if (profilesLimitsFormEl) {
  profilesLimitsFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveProfilesLimits();
  });
}

providersBodyEl.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!target) {
    return;
  }
  const action = String(target.dataset.action || "").trim();
  const variant = String(target.dataset.variant || "").trim();
  if (!action || !variant) {
    return;
  }

  if (action === "prefill-import") {
    const provider = findProviderByVariant(variant);
    if (!provider) return;
    if (importSourceTypeEl) {
      importSourceTypeEl.value = PROVIDER_IMPORT_SOURCE_TYPES.REMOTE_FETCH;
      updateImportModeUi();
    }
    if (importVariantEl) importVariantEl.value = provider.variant;
    if (importCommitEl) {
      importCommitEl.value = provider.activeCommit || provider.importedCommits?.[0] || "";
      importCommitEl.focus();
    }
    setStatus(
      importStatusEl,
      `Import form prefilled for ${provider.variant}. Enter checksums and submit.`,
      "admin-status-off"
    );
    activateTab("imports", true);
    return;
  }

  if (action === "check-update") {
    try {
      await checkProviderUpdateStatus(variant);
    } catch (err) {
      setStatus(workspaceStatusEl, `Update check failed: ${err.message}`, "admin-status-missing");
    }
    return;
  }

  try {
    await toggleProviderState(variant, action);
  } catch (err) {
    setStatus(workspaceStatusEl, `Provider update failed: ${err.message}`, "admin-status-missing");
  }
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab || "providers");
  });

  button.addEventListener("keydown", (event) => {
    if (!tabButtons.length) return;
    const currentIndex = tabButtons.findIndex((entry) => entry === button);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % tabButtons.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabButtons.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = tabButtons[nextIndex].dataset.tab || "providers";
    activateTab(nextTab, true);
  });
});

if (importSourceTypeEl) {
  importSourceTypeEl.addEventListener("change", () => {
    updateImportModeUi();
    setStatus(
      importStatusEl,
      getImportSourceType() === PROVIDER_IMPORT_SOURCE_TYPES.MANUAL_UPLOAD
        ? "Manual upload mode selected. Choose .dic and .aff files to continue."
        : "Remote fetch mode selected. Enter commit and checksums to continue.",
      "admin-status-off"
    );
  });
}

updateImportModeUi();
renderWorkspace();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
