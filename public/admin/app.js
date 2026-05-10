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

const classesBodyEl = document.getElementById("classesBody");
const classesStatusEl = document.getElementById("classesStatus");
const classesIncludeArchivedEl = document.getElementById("classesIncludeArchived");
const refreshClassesBtnEl = document.getElementById("refreshClassesBtn");
const classCreateFormEl = document.getElementById("classCreateForm");
const classCreateNameEl = document.getElementById("classCreateName");
const classDetailPanelEl = document.getElementById("classDetailPanel");
const classDetailHeadingEl = document.getElementById("classDetailHeading");
const classDetailStatusEl = document.getElementById("classDetailStatus");
const closeClassDetailBtnEl = document.getElementById("closeClassDetailBtn");
const classBulkAddFormEl = document.getElementById("classBulkAddForm");
const classBulkAddNamesEl = document.getElementById("classBulkAddNames");
const classMembersBodyEl = document.getElementById("classMembersBody");
const classReportFormEl = document.getElementById("classReportForm");
const classReportFromEl = document.getElementById("classReportFrom");
const classReportToEl = document.getElementById("classReportTo");
const classReportLangEl = document.getElementById("classReportLang");
const classReportCsvBtnEl = document.getElementById("classReportCsvBtn");
const classReportBomEl = document.getElementById("classReportBom");
const classReportPrintBtnEl = document.getElementById("classReportPrintBtn");
const classReportStatusEl = document.getElementById("classReportStatus");
const classReportRenderedEl = document.getElementById("classReportRendered");

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

const backupExportFormEl = document.getElementById("backupExportForm");
const backupIncludeProvidersEl = document.getElementById("backupIncludeProviders");
const backupIncludeDictionariesEl = document.getElementById("backupIncludeDictionaries");
const backupExportBtnEl = document.getElementById("backupExportBtn");
const backupExportStatusEl = document.getElementById("backupExportStatus");
const backupRestoreFormEl = document.getElementById("backupRestoreForm");
const backupRestoreFileEl = document.getElementById("backupRestoreFile");
const backupRestorePreviewBtnEl = document.getElementById("backupRestorePreviewBtn");
const backupRestoreStatusEl = document.getElementById("backupRestoreStatus");
const backupRestoreDialogEl = document.getElementById("backupRestoreDialog");
const backupRestoreDialogFormEl = document.getElementById("backupRestoreDialogForm");
if (backupRestoreDialogFormEl) {
  // Helmet's CSP (script-src-attr 'none') blocks inline event handlers,
  // so we wire the submit preventDefault here. Pressing Enter in the
  // confirmation field would otherwise close the dialog and bypass the
  // typed-confirmation gate.
  backupRestoreDialogFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
  });
}
const backupRestorePreviewSummaryEl = document.getElementById("backupRestorePreviewSummary");
const backupRestoreConfirmInputEl = document.getElementById("backupRestoreConfirmInput");
const backupRestoreCancelBtnEl = document.getElementById("backupRestoreCancelBtn");
const backupRestoreApplyBtnEl = document.getElementById("backupRestoreApplyBtn");

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
  classes: [],
  classesLoading: false,
  classesIncludeArchived: false,
  activeClassId: null,
  activeClassDetail: null,
  classMembersLoading: false,
  activeTab: "providers",
  analyticsWindow: "7d",
  analyticsLoading: false,
  // Monotonic request id incremented on every loadAnalytics call. Each
  // fetch captures its own id and only renders if it still matches at
  // response time — covers the 7d→all→7d race where window equality
  // alone would let an old 7d response overwrite a newer 7d.
  analyticsRequestId: 0,
  analyticsCharts: {
    activity: null,
    attempts: null,
    language: null,
    hour: null
  },
  schedule: null,
  scheduleLoading: false,
  scheduleRequestId: 0,
  // Tracks the (date, lang) of an entry being edited so the submit
  // handler can route to PUT /entries/:date/:lang instead of
  // POST /entries (which would leave the original row behind if the
  // operator changed the date or lang of the entry they were editing).
  scheduleEditingKey: null,
  webhooksEnabled: true,
  webhooksLoading: false,
  webhooksRequestId: 0,
  webhookSubscriptions: [],
  webhookDefaultMaxAttempts: 5,
  webhookDeliveriesLoading: false,
  webhookDeliveriesSubscriptionId: null,
  // Bumped on every loadWebhookDeliveries() call so a slow response from
  // an older subscription can't overwrite a fresh table when the
  // operator switches the dropdown rapidly.
  webhookDeliveriesRequestId: 0,
  webhookDeliveries: [],
  notificationsLoading: false,
  notificationsRequestId: 0,
  notificationsSummary: null
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
  if (tabId === "classes" && state.unlocked && !state.classesLoading) {
    loadClasses({ announce: true }).catch(() => {});
  }
  if (tabId === "analytics" && state.unlocked && !state.analyticsLoading) {
    loadAnalytics({ announce: true }).catch(() => {});
  }
  if (tabId === "schedule" && state.unlocked && !state.scheduleLoading) {
    loadSchedule({ announce: true }).catch(() => {});
  }
  if (tabId === "webhooks" && state.unlocked && !state.webhooksLoading) {
    loadWebhooks({ announce: true }).catch(() => {});
  }
  if (tabId === "notifications" && state.unlocked && !state.notificationsLoading) {
    loadNotifications({ announce: true }).catch(() => {});
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
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "admin-action-stack";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "ghost";
    renameBtn.dataset.action = "rename-profile";
    renameBtn.dataset.profileId = profile.id;
    renameBtn.textContent = "Rename";
    renameBtn.setAttribute("aria-label", `Rename profile ${profile.name}`);
    actionsWrap.appendChild(renameBtn);

    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "ghost";
    mergeBtn.dataset.action = "merge-profile";
    mergeBtn.dataset.profileId = profile.id;
    mergeBtn.textContent = "Merge into…";
    mergeBtn.disabled = state.profiles.length < 2;
    mergeBtn.setAttribute("aria-label", `Merge profile ${profile.name} into another`);
    actionsWrap.appendChild(mergeBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "ghost admin-action-destructive";
    deleteBtn.dataset.action = "delete-profile";
    deleteBtn.dataset.profileId = profile.id;
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete profile ${profile.name} permanently`);
    actionsWrap.appendChild(deleteBtn);

    actionsCell.appendChild(actionsWrap);
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
  } catch (err) {
    setStatus(profilesStatusEl, `Rename failed: ${err.message}`, "admin-status-missing");
    return;
  }
  // The mutation committed; if the refresh fails, surface that as a softer
  // warning so the admin doesn't think the rename itself failed.
  setStatus(profilesStatusEl, `Renamed to "${trimmed}".`, "admin-status-ok");
  try {
    await loadProfiles({ announce: false });
  } catch (refreshErr) {
    setStatus(
      profilesStatusEl,
      `Renamed to "${trimmed}". Could not refresh list: ${refreshErr.message}`,
      "admin-status-off"
    );
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
      body: JSON.stringify({ confirmName: profile.name, confirmed: true })
    });
  } catch (err) {
    setStatus(profilesStatusEl, `Delete failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(profilesStatusEl, `Deleted "${profile.name}".`, "admin-status-ok");
  try {
    await loadProfiles({ announce: false });
  } catch (refreshErr) {
    setStatus(
      profilesStatusEl,
      `Deleted "${profile.name}". Could not refresh list: ${refreshErr.message}`,
      "admin-status-off"
    );
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
  } catch (err) {
    setStatus(profilesStatusEl, `Merge failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(
    profilesStatusEl,
    `Merged "${source.name}" into "${target.name}".`,
    "admin-status-ok"
  );
  try {
    await loadProfiles({ announce: false });
  } catch (refreshErr) {
    setStatus(
      profilesStatusEl,
      `Merged "${source.name}" into "${target.name}". Could not refresh list: ${refreshErr.message}`,
      "admin-status-off"
    );
  }
}

function parseOptionalCapValue(element, label) {
  const raw = String(element?.value ?? "").trim();
  if (!raw) return { mode: "clear" };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return {
      mode: "invalid",
      message: `${label} must be a positive integer (or empty to clear the override).`
    };
  }
  return { mode: "set", value: parsed };
}

async function saveProfilesLimits() {
  const overrides = state.runtimeConfig?.overrides || {};
  const sources = state.runtimeConfig?.sources?.limits || {};
  const nextLimits = { ...(overrides.limits || {}) };

  // When an env var locks the cap, drop any existing override for that field
  // entirely. Preserving a dormant override would silently re-activate as
  // soon as the env var was unset; admins can re-set the value explicitly
  // once the env lock is removed.
  if (sources.leaderboardMaxProfiles === "env") {
    delete nextLimits.leaderboardMaxProfiles;
  } else {
    const maxProfilesParse = parseOptionalCapValue(profilesMaxProfilesEl, "Max profiles");
    if (maxProfilesParse.mode === "invalid") {
      setStatus(profilesLimitsStatusEl, maxProfilesParse.message, "admin-status-missing");
      return;
    }
    if (maxProfilesParse.mode === "set") {
      nextLimits.leaderboardMaxProfiles = maxProfilesParse.value;
    } else {
      delete nextLimits.leaderboardMaxProfiles;
    }
  }

  if (sources.leaderboardMaxResultsPerProfile === "env") {
    delete nextLimits.leaderboardMaxResultsPerProfile;
  } else {
    const maxResultsParse = parseOptionalCapValue(profilesMaxResultsEl, "Max results per profile");
    if (maxResultsParse.mode === "invalid") {
      setStatus(profilesLimitsStatusEl, maxResultsParse.message, "admin-status-missing");
      return;
    }
    if (maxResultsParse.mode === "set") {
      nextLimits.leaderboardMaxResultsPerProfile = maxResultsParse.value;
    } else {
      delete nextLimits.leaderboardMaxResultsPerProfile;
    }
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

function findClassById(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  return state.classes.find((entry) => entry.id === key) || null;
}

async function loadClasses(options = {}) {
  if (!state.unlocked || !classesBodyEl) return;
  state.classesLoading = true;
  if (options.announce !== false) {
    setStatus(classesStatusEl, "Loading classes…", "");
  }
  try {
    const includeArchived = state.classesIncludeArchived ? "?includeArchived=true" : "";
    const payload = await requestAdminJson(`/api/admin/classes${includeArchived}`);
    state.classes = Array.isArray(payload?.classes) ? payload.classes : [];
    renderClasses();
    if (options.announce !== false) {
      setStatus(
        classesStatusEl,
        `Loaded ${state.classes.length} class${state.classes.length === 1 ? "" : "es"}.`,
        "admin-status-ok"
      );
    }
    return payload;
  } catch (err) {
    if (options.announce !== false) {
      setStatus(classesStatusEl, `Class list failed: ${err.message}`, "admin-status-missing");
    }
    throw err;
  } finally {
    state.classesLoading = false;
  }
}

function renderClasses() {
  if (!classesBodyEl) return;
  classesBodyEl.innerHTML = "";
  if (!state.classes.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = state.classesIncludeArchived
      ? "No classes yet."
      : "No active classes. Toggle \"Show archived\" to see archived ones.";
    row.appendChild(cell);
    classesBodyEl.appendChild(row);
    return;
  }
  const fragment = document.createDocumentFragment();
  state.classes.forEach((classRecord) => {
    const row = document.createElement("tr");
    row.dataset.classId = classRecord.id;

    const nameCell = document.createElement("td");
    nameCell.textContent = classRecord.name;
    row.appendChild(nameCell);

    const memberCell = document.createElement("td");
    memberCell.textContent = String(classRecord.memberCount ?? 0);
    row.appendChild(memberCell);

    const statusCell = document.createElement("td");
    statusCell.textContent = classRecord.archivedAt ? "archived" : "active";
    if (classRecord.archivedAt) {
      statusCell.classList.add("admin-status-off");
    } else {
      statusCell.classList.add("admin-status-ok");
    }
    row.appendChild(statusCell);

    const createdCell = document.createElement("td");
    createdCell.textContent = formatTimestamp(classRecord.createdAt);
    row.appendChild(createdCell);

    const actionsCell = document.createElement("td");
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "admin-action-stack";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "ghost";
    openBtn.dataset.action = "open-class";
    openBtn.dataset.classId = classRecord.id;
    openBtn.textContent = "Open";
    openBtn.setAttribute("aria-label", `Open class ${classRecord.name}`);
    actionsWrap.appendChild(openBtn);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "ghost";
    renameBtn.dataset.action = "rename-class";
    renameBtn.dataset.classId = classRecord.id;
    renameBtn.textContent = "Rename";
    renameBtn.setAttribute("aria-label", `Rename class ${classRecord.name}`);
    actionsWrap.appendChild(renameBtn);

    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "ghost";
    archiveBtn.dataset.action = classRecord.archivedAt ? "unarchive-class" : "archive-class";
    archiveBtn.dataset.classId = classRecord.id;
    archiveBtn.textContent = classRecord.archivedAt ? "Unarchive" : "Archive";
    archiveBtn.setAttribute(
      "aria-label",
      `${classRecord.archivedAt ? "Unarchive" : "Archive"} class ${classRecord.name}`
    );
    actionsWrap.appendChild(archiveBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "ghost admin-action-destructive";
    deleteBtn.dataset.action = "delete-class";
    deleteBtn.dataset.classId = classRecord.id;
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete class ${classRecord.name}`);
    actionsWrap.appendChild(deleteBtn);

    actionsCell.appendChild(actionsWrap);
    row.appendChild(actionsCell);
    fragment.appendChild(row);
  });
  classesBodyEl.appendChild(fragment);
}

async function createClass(name) {
  try {
    await requestAdminJson("/api/admin/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
  } catch (err) {
    setStatus(classesStatusEl, `Create failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(classesStatusEl, `Created "${name.trim()}".`, "admin-status-ok");
  classCreateNameEl.value = "";
  await loadClasses({ announce: false }).catch((refreshErr) => {
    setStatus(
      classesStatusEl,
      `Created "${name.trim()}". Could not refresh list: ${refreshErr.message}`,
      "admin-status-off"
    );
  });
}

async function renameClass(classId) {
  const target = findClassById(classId);
  if (!target) return;
  const next = window.prompt(`Rename class "${target.name}" to:`, target.name);
  if (next === null) return;
  const trimmed = String(next).trim();
  if (!trimmed) {
    setStatus(classesStatusEl, "Rename cancelled — name is empty.", "admin-status-off");
    return;
  }
  if (trimmed === target.name) return;
  try {
    await requestAdminJson(`/api/admin/classes/${encodeURIComponent(classId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed })
    });
  } catch (err) {
    setStatus(classesStatusEl, `Rename failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(classesStatusEl, `Renamed to "${trimmed}".`, "admin-status-ok");
  await loadClasses({ announce: false }).catch(() => {});
  if (state.activeClassId === classId) {
    await loadClassDetail(classId).catch(() => {});
  }
}

async function setClassArchived(classId, archived) {
  try {
    await requestAdminJson(`/api/admin/classes/${encodeURIComponent(classId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived })
    });
  } catch (err) {
    setStatus(classesStatusEl, `Update failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(
    classesStatusEl,
    archived ? "Class archived." : "Class unarchived.",
    "admin-status-ok"
  );
  await loadClasses({ announce: false }).catch(() => {});
  if (state.activeClassId === classId) {
    await loadClassDetail(classId).catch(() => {});
  }
}

async function deleteClassFlow(classId) {
  const target = findClassById(classId);
  if (!target) return;
  const typed = window.prompt(
    `Type the class name "${target.name}" to confirm deletion. This cannot be undone.`
  );
  if (typed === null) return;
  if (typed.trim() !== target.name) {
    setStatus(classesStatusEl, "Delete cancelled — name did not match.", "admin-status-off");
    return;
  }
  const cleanProfiles = window.confirm(
    "Also delete profiles that are members of this class only? Members shared with other active classes will be preserved."
  );
  try {
    const result = await requestAdminJson(
      `/api/admin/classes/${encodeURIComponent(classId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, deleteProfiles: cleanProfiles })
      }
    );
    const carved = Array.isArray(result.deletedProfileIds) ? result.deletedProfileIds.length : 0;
    if (result.partialFailure) {
      const pending = Array.isArray(result.pendingProfileIds) ? result.pendingProfileIds.length : 0;
      setStatus(
        classesStatusEl,
        `Deleted "${target.name}", but profile cleanup did not complete: ${pending} profile${pending === 1 ? "" : "s"} pending. ${result.message || ""}`.trim(),
        "admin-status-missing"
      );
    } else {
      setStatus(
        classesStatusEl,
        cleanProfiles
          ? `Deleted "${target.name}". Removed ${carved} profile${carved === 1 ? "" : "s"}.`
          : `Deleted "${target.name}". Profiles preserved.`,
        "admin-status-ok"
      );
    }
  } catch (err) {
    setStatus(classesStatusEl, `Delete failed: ${err.message}`, "admin-status-missing");
    return;
  }
  if (state.activeClassId === classId) closeClassDetail();
  await loadClasses({ announce: false }).catch(() => {});
}

function closeClassDetail() {
  // Bump the request token so any in-flight loadClassDetail() response
  // resolves into a stale check and is silently discarded — without this,
  // a slow Open click could still repopulate the panel after we cleared it.
  state.classDetailRequestToken = (state.classDetailRequestToken || 0) + 1;
  state.pendingClassDetailId = null;
  state.activeClassId = null;
  state.activeClassDetail = null;
  if (classDetailPanelEl) {
    classDetailPanelEl.classList.add("hidden");
    classDetailPanelEl.hidden = true;
  }
  if (classMembersBodyEl) classMembersBodyEl.innerHTML = "";
  if (classReportRenderedEl) classReportRenderedEl.innerHTML = "";
  setStatus(classDetailStatusEl, "");
  setStatus(classReportStatusEl, "");
}

async function loadClassDetail(classId) {
  if (!classDetailPanelEl) return;
  state.classMembersLoading = true;
  // Stamp this request so out-of-order responses can be discarded. Two
  // quick "Open" clicks could otherwise resolve in reverse order and
  // leave the panel pinned to the wrong class.
  const requestToken = (state.classDetailRequestToken || 0) + 1;
  state.classDetailRequestToken = requestToken;
  state.pendingClassDetailId = classId;
  setStatus(classDetailStatusEl, "Loading class…", "");
  try {
    const payload = await requestAdminJson(`/api/admin/classes/${encodeURIComponent(classId)}`);
    if (state.classDetailRequestToken !== requestToken) {
      // A newer request started before this one resolved — discard.
      return;
    }
    state.activeClassId = classId;
    state.activeClassDetail = payload;
    if (classDetailHeadingEl) {
      classDetailHeadingEl.textContent = `Class: ${payload.class.name}${payload.class.archivedAt ? " (archived)" : ""}`;
    }
    classDetailPanelEl.classList.remove("hidden");
    classDetailPanelEl.hidden = false;
    renderClassMembers();
    setStatus(
      classDetailStatusEl,
      `${payload.members.length} member${payload.members.length === 1 ? "" : "s"}.`,
      "admin-status-ok"
    );
  } catch (err) {
    if (state.classDetailRequestToken !== requestToken) return;
    setStatus(classDetailStatusEl, `Load failed: ${err.message}`, "admin-status-missing");
    throw err;
  } finally {
    if (state.classDetailRequestToken === requestToken) {
      state.classMembersLoading = false;
      state.pendingClassDetailId = null;
    }
  }
}

function renderClassMembers() {
  if (!classMembersBodyEl) return;
  classMembersBodyEl.innerHTML = "";
  const members = state.activeClassDetail?.members || [];
  if (!members.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = "No members yet. Add some via the form above.";
    row.appendChild(cell);
    classMembersBodyEl.appendChild(row);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const member of members) {
    const row = document.createElement("tr");
    row.dataset.profileId = member.profileId;

    const nameCell = document.createElement("td");
    nameCell.textContent = member.missing ? "(missing profile)" : member.name;
    if (member.missing) nameCell.classList.add("admin-status-missing");
    row.appendChild(nameCell);

    const idCell = document.createElement("td");
    idCell.textContent = member.profileId;
    row.appendChild(idCell);

    const actionsCell = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "ghost";
    removeBtn.dataset.action = "remove-member";
    removeBtn.dataset.profileId = member.profileId;
    removeBtn.textContent = "Remove from class";
    removeBtn.setAttribute(
      "aria-label",
      `Remove ${member.name || member.profileId} from class`
    );
    actionsCell.appendChild(removeBtn);
    row.appendChild(actionsCell);

    fragment.appendChild(row);
  }
  classMembersBodyEl.appendChild(fragment);
}

async function bulkAddMembers(rawText) {
  const classId = state.activeClassId;
  if (!classId) return;
  const text = String(rawText || "").trim();
  if (!text) {
    setStatus(classDetailStatusEl, "Add at least one name.", "admin-status-off");
    return;
  }
  try {
    const result = await requestAdminJson(
      `/api/admin/classes/${encodeURIComponent(classId)}/members/bulk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text })
      }
    );
    const added = Array.isArray(result.addedToClass) ? result.addedToClass.length : 0;
    const created = Array.isArray(result.createdProfileIds) ? result.createdProfileIds.length : 0;
    const reused = Array.isArray(result.reusedProfileIds) ? result.reusedProfileIds.length : 0;
    classBulkAddNamesEl.value = "";
    await loadClassDetail(classId).catch(() => {});
    await loadClasses({ announce: false }).catch(() => {});
    // Set the success message last so it's not overwritten by the refresh's
    // own status updates.
    setStatus(
      classDetailStatusEl,
      `Added ${added} new member${added === 1 ? "" : "s"} (${created} new profile${created === 1 ? "" : "s"}, ${reused} reused).`,
      "admin-status-ok"
    );
  } catch (err) {
    setStatus(classDetailStatusEl, `Bulk add failed: ${err.message}`, "admin-status-missing");
  }
}

async function removeClassMember(profileId) {
  const classId = state.activeClassId;
  if (!classId) return;
  if (!window.confirm("Remove this member from the class? The profile remains on the host.")) {
    return;
  }
  try {
    await requestAdminJson(
      `/api/admin/classes/${encodeURIComponent(classId)}/members/${encodeURIComponent(profileId)}`,
      { method: "DELETE" }
    );
    setStatus(classDetailStatusEl, "Member removed from class.", "admin-status-ok");
    await loadClassDetail(classId).catch(() => {});
    await loadClasses({ announce: false }).catch(() => {});
  } catch (err) {
    setStatus(classDetailStatusEl, `Remove failed: ${err.message}`, "admin-status-missing");
  }
}

function buildReportQuery({ format } = {}) {
  const classId = state.activeClassId;
  if (!classId) return null;
  const params = new URLSearchParams();
  params.set("lang", String(classReportLangEl?.value || "en").trim() || "en");
  if (classReportFromEl?.value) params.set("from", classReportFromEl.value);
  if (classReportToEl?.value) params.set("to", classReportToEl.value);
  if (format) params.set("format", format);
  if (format === "csv" && classReportBomEl?.checked) {
    params.set("bom", "true");
  }
  return { classId, query: params.toString() };
}

function renderReportRows(payload) {
  if (!classReportRenderedEl) return;
  classReportRenderedEl.innerHTML = "";
  if (!payload || !Array.isArray(payload.rows)) return;
  const table = document.createElement("table");
  table.className = "leaderboard-table";
  table.setAttribute("aria-label", "Class participation report");
  const caption = document.createElement("caption");
  caption.className = "admin-table-caption";
  caption.textContent = `${payload.class.name} · ${payload.from} → ${payload.to} · ${payload.lang}`;
  table.appendChild(caption);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Name", "Status overview", "Wins", "Played", "Win rate", "Last played"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of payload.rows) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = row.missing ? "(missing profile)" : row.name;
    if (row.missing) nameTd.classList.add("admin-status-missing");
    tr.appendChild(nameTd);

    const statusTd = document.createElement("td");
    statusTd.textContent = row.days
      .map((day) => `${day.date}: ${day.status}${day.attempts ? ` (${day.attempts})` : ""}`)
      .join("  •  ");
    tr.appendChild(statusTd);

    tr.appendChild(createCell(row.missing ? "" : String(row.wins ?? 0)));
    tr.appendChild(createCell(row.missing ? "" : String(row.playedCount ?? 0)));
    tr.appendChild(
      createCell(
        row.missing
          ? ""
          : (row.winRate !== null && row.winRate !== undefined
            ? `${(row.winRate * 100).toFixed(1)}%`
            : "")
      )
    );
    tr.appendChild(createCell(row.lastPlayedAt ? formatTimestamp(row.lastPlayedAt) : "-"));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  classReportRenderedEl.appendChild(table);
}

function createCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

async function fetchReport() {
  const target = buildReportQuery();
  if (!target) return;
  setStatus(classReportStatusEl, "Loading report…", "");
  try {
    const payload = await requestAdminJson(
      `/api/admin/classes/${encodeURIComponent(target.classId)}/report?${target.query}`
    );
    renderReportRows(payload);
    setStatus(
      classReportStatusEl,
      `Report ${payload.from} → ${payload.to} (${payload.dates.length} day${payload.dates.length === 1 ? "" : "s"}).`,
      "admin-status-ok"
    );
  } catch (err) {
    setStatus(classReportStatusEl, `Report failed: ${err.message}`, "admin-status-missing");
  }
}

function parseFilenameFromContentDisposition(headerValue) {
  if (typeof headerValue !== "string") return null;
  // Prefer the RFC 5987 filename* form when present.
  const starMatch = headerValue.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ""));
    } catch (_err) {
      // fall through to plain filename match
    }
  }
  const plainMatch = headerValue.match(/filename\s*=\s*("([^"]+)"|([^;]+))/i);
  if (plainMatch) {
    return (plainMatch[2] || plainMatch[3] || "").trim();
  }
  return null;
}

async function downloadReportCsv() {
  const target = buildReportQuery({ format: "csv" });
  if (!target) return;
  setStatus(classReportStatusEl, "Downloading CSV…", "");
  try {
    const headers = new Headers({ "x-admin-key": state.adminKey });
    const response = await fetch(
      `/api/admin/classes/${encodeURIComponent(target.classId)}/report?${target.query}`,
      { headers }
    );
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `Request failed with status ${response.status}`);
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    // Honor the server's filename (which encodes the requested date range)
    // before falling back to a UI-generated name.
    const headerFilename = parseFilenameFromContentDisposition(
      response.headers.get("Content-Disposition")
    );
    if (headerFilename) {
      link.download = headerFilename;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      link.download = `class-${target.classId}-report-${today}.csv`;
    }
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setStatus(classReportStatusEl, "CSV download started.", "admin-status-ok");
  } catch (err) {
    setStatus(classReportStatusEl, `CSV failed: ${err.message}`, "admin-status-missing");
  }
}

function openPrintReport() {
  const target = buildReportQuery();
  if (!target) return;
  const url = `/admin/classroom-report.html?classId=${encodeURIComponent(target.classId)}&${target.query}`;
  window.open(url, "_blank", "noopener");
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

  // Preserve overrides owned by the Profiles tab so saving Runtime Settings
  // doesn't wipe leaderboard caps. Skip keys whose source is "env" — those
  // overrides are dormant by definition and copying them forward would
  // re-activate them as soon as the env lock was removed.
  const persistedLimits = state.runtimeConfig?.overrides?.limits || {};
  const limitSources = state.runtimeConfig?.sources?.limits || {};
  if (
    limitSources.leaderboardMaxProfiles !== "env"
    && Number.isInteger(persistedLimits.leaderboardMaxProfiles)
  ) {
    limits.leaderboardMaxProfiles = persistedLimits.leaderboardMaxProfiles;
  }
  if (
    limitSources.leaderboardMaxResultsPerProfile !== "env"
    && Number.isInteger(persistedLimits.leaderboardMaxResultsPerProfile)
  ) {
    limits.leaderboardMaxResultsPerProfile = persistedLimits.leaderboardMaxResultsPerProfile;
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
    // If the operator was on the Analytics tab when they locked, the
    // panel was wiped. Activating providers via renderWorkspace doesn't
    // re-enter activateTab(), so loadAnalytics() never re-fires for the
    // preserved active tab. Trigger it here so re-unlock leaves the
    // Analytics panel populated instead of blank-until-tab-switch.
    if (state.unlocked && state.activeTab === "analytics") {
      loadAnalytics({ announce: true }).catch(() => {});
    }
    if (state.unlocked && state.activeTab === "schedule") {
      loadSchedule({ announce: true }).catch(() => {});
    }
    if (state.unlocked && state.activeTab === "webhooks") {
      loadWebhooks({ announce: true }).catch(() => {});
    }
    if (state.unlocked && state.activeTab === "notifications") {
      loadNotifications({ announce: true }).catch(() => {});
    }
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

const RESTORE_CONFIRM_PHRASE = "RESTORE";
const RESTORE_CONFIRM_HEADER = "x-admin-confirm";
const RESTORE_CONFIRM_VALUE = "I-UNDERSTAND";
let pendingRestoreFile = null;

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseAttachmentFilename(disposition) {
  if (typeof disposition !== "string") return null;
  // Per RFC 6266, when both `filename` and `filename*` are present
  // recipients SHOULD prefer `filename*` and ignore `filename`. The
  // earlier regex matched whichever came first textually — which
  // could pick a US-ASCII filename and ignore the UTF-8 form. Try
  // filename* first; fall through to filename if it isn't there.
  const starMatch = disposition.match(/filename\*=(?:UTF-8'')?"?([^";]+)"?/i);
  const plainMatch = disposition.match(/filename=(?:UTF-8''|")?([^";]+)"?/i);
  const captured = starMatch ? starMatch[1] : (plainMatch ? plainMatch[1] : null);
  if (!captured) return null;
  // Headers from older servers may contain a literal % that isn't valid
  // percent-encoding. decodeURIComponent throws on those; fall back to
  // the raw matched value rather than breaking the whole download flow.
  try {
    return decodeURIComponent(captured);
  } catch (_err) {
    return captured;
  }
}

async function fetchAdminBlob(path, init = {}) {
  const headers = Object.assign({}, init.headers || {});
  if (state.adminKey) headers["x-admin-key"] = state.adminKey;
  const response = await fetch(path, Object.assign({}, init, { headers }));
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        if (payload && typeof payload.error === "string" && payload.error.trim()) {
          message = payload.error.trim();
        }
      } else {
        const text = await response.text();
        if (text) message = text;
      }
    } catch {
      // Body unreadable or not the shape we expected — fall back to status line.
    }
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return response;
}

if (backupExportFormEl) {
  backupExportFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.unlocked) {
      setStatus(backupExportStatusEl, "Unlock the admin session first.", "admin-status-off");
      return;
    }
    backupExportBtnEl.disabled = true;
    setStatus(backupExportStatusEl, "Building backup archive…", "");
    try {
      // Send the explicit checkbox state every time. The UI is the
      // operator's intent at the moment of export — they should be
      // able to uncheck a box and see providers excluded even when the
      // env sets BACKUP_INCLUDE_PROVIDERS_DEFAULT=true. Non-UI
      // callers (curl/scripts) that omit the query param still get
      // the env default.
      const params = new URLSearchParams({
        includeProviders: backupIncludeProvidersEl?.checked ? "true" : "false",
        includeDictionaries: backupIncludeDictionariesEl?.checked ? "true" : "false"
      });
      const url = `/api/admin/backup?${params.toString()}`;
      const response = await fetchAdminBlob(url);
      const blob = await response.blob();
      const filename =
        parseAttachmentFilename(response.headers.get("content-disposition"))
        || `wordle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setStatus(
        backupExportStatusEl,
        `Downloaded ${filename} (${formatBytes(blob.size)}).`,
        "admin-status-ok"
      );
    } catch (err) {
      setStatus(backupExportStatusEl, `Export failed: ${err.message}`, "admin-status-missing");
    } finally {
      backupExportBtnEl.disabled = false;
    }
  });
}

function renderBackupPreviewSummary(payload) {
  if (!backupRestorePreviewSummaryEl) return;
  const fileCount = Array.isArray(payload.files) ? payload.files.length : 0;
  const total = formatBytes(payload.totalBytes);
  const rows = [
    ["Manifest version", payload.manifestVersion],
    ["App version", payload.appVersion],
    ["Created", payload.createdAt],
    ["Node id", payload.nodeId],
    ["Files", `${fileCount} (${total} total)`]
  ];
  // Render as a definition list so the entries lay out one-per-row
  // without depending on whitespace CSS for the line breaks. Plain
  // textContent collapses newlines because the .message class
  // doesn't set white-space: pre-wrap.
  backupRestorePreviewSummaryEl.innerHTML = "";
  const list = document.createElement("dl");
  list.className = "backup-preview-summary";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    list.appendChild(dt);
    list.appendChild(dd);
  }
  backupRestorePreviewSummaryEl.appendChild(list);
}

function resetRestoreDialog() {
  if (backupRestoreConfirmInputEl) backupRestoreConfirmInputEl.value = "";
  if (backupRestoreApplyBtnEl) backupRestoreApplyBtnEl.disabled = true;
  if (backupRestorePreviewSummaryEl) backupRestorePreviewSummaryEl.innerHTML = "";
  pendingRestoreFile = null;
}

if (backupRestoreFormEl) {
  backupRestoreFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.unlocked) {
      setStatus(backupRestoreStatusEl, "Unlock the admin session first.", "admin-status-off");
      return;
    }
    const file = backupRestoreFileEl?.files?.[0];
    if (!file) {
      setStatus(backupRestoreStatusEl, "Select an archive file first.", "admin-status-missing");
      return;
    }
    backupRestorePreviewBtnEl.disabled = true;
    setStatus(backupRestoreStatusEl, "Validating archive…", "");
    try {
      const formData = new FormData();
      formData.append("archive", file, file.name);
      const response = await fetchAdminBlob("/api/admin/backup/preview", {
        method: "POST",
        body: formData
      });
      const payload = await response.json();
      renderBackupPreviewSummary(payload);
      pendingRestoreFile = file;
      if (backupRestoreApplyBtnEl) backupRestoreApplyBtnEl.disabled = true;
      if (backupRestoreConfirmInputEl) {
        backupRestoreConfirmInputEl.value = "";
        setTimeout(() => backupRestoreConfirmInputEl.focus(), 0);
      }
      if (backupRestoreDialogEl?.showModal) {
        backupRestoreDialogEl.showModal();
      } else if (backupRestoreDialogEl) {
        backupRestoreDialogEl.setAttribute("open", "");
      }
      setStatus(backupRestoreStatusEl, "Preview ready.", "admin-status-ok");
    } catch (err) {
      setStatus(backupRestoreStatusEl, `Preview failed: ${err.message}`, "admin-status-missing");
    } finally {
      backupRestorePreviewBtnEl.disabled = false;
    }
  });
}

if (backupRestoreConfirmInputEl) {
  backupRestoreConfirmInputEl.addEventListener("input", () => {
    if (!backupRestoreApplyBtnEl) return;
    backupRestoreApplyBtnEl.disabled =
      backupRestoreConfirmInputEl.value.trim() !== RESTORE_CONFIRM_PHRASE;
  });
}

if (backupRestoreCancelBtnEl) {
  backupRestoreCancelBtnEl.addEventListener("click", () => {
    resetRestoreDialog();
    if (backupRestoreDialogEl?.close) backupRestoreDialogEl.close();
    else backupRestoreDialogEl?.removeAttribute("open");
  });
}

if (backupRestoreApplyBtnEl) {
  backupRestoreApplyBtnEl.addEventListener("click", async () => {
    if (backupRestoreConfirmInputEl?.value.trim() !== RESTORE_CONFIRM_PHRASE) return;
    if (!pendingRestoreFile) return;
    backupRestoreApplyBtnEl.disabled = true;
    setStatus(backupRestoreStatusEl, "Applying restore…", "");
    try {
      const formData = new FormData();
      formData.append("archive", pendingRestoreFile, pendingRestoreFile.name);
      const response = await fetchAdminBlob("/api/admin/restore", {
        method: "POST",
        headers: { [RESTORE_CONFIRM_HEADER]: RESTORE_CONFIRM_VALUE },
        body: formData
      });
      const payload = await response.json();
      const failedReloads = (payload.reloads || []).filter((entry) => !entry.ok);
      const filesRestored = payload.filesRestored ?? payload.restored?.length ?? 0;
      let message = `Restore complete — ${filesRestored} file(s) restored.`;
      let tone = "admin-status-ok";
      if (failedReloads.length > 0) {
        message += ` Caches partially reloaded; ${failedReloads.length} store(s) failed.`;
        tone = "admin-status-missing";
      }
      setStatus(backupRestoreStatusEl, message, tone);

      // Refresh every loaded admin section so the in-memory client view
      // matches the just-restored state. Run in parallel; failures here
      // are logged via setStatus on the relevant section but don't block
      // the restore success message.
      await Promise.allSettled([
        typeof loadProviders === "function" ? loadProviders({ announce: false }) : null,
        typeof loadJobs === "function" ? loadJobs({ announce: false }) : null,
        typeof loadRuntimeConfig === "function" ? loadRuntimeConfig({ announce: false }) : null,
        typeof loadProfiles === "function" ? loadProfiles({ announce: false }) : null,
        typeof loadClasses === "function" ? loadClasses({ announce: false }) : null
      ].filter(Boolean));
    } catch (err) {
      setStatus(backupRestoreStatusEl, `Restore failed: ${err.message}`, "admin-status-missing");
    } finally {
      resetRestoreDialog();
      if (backupRestoreDialogEl?.close) backupRestoreDialogEl.close();
      else backupRestoreDialogEl?.removeAttribute("open");
    }
  });
}

lockSessionBtnEl.addEventListener("click", () => {
  if (jobsRefreshTimer) {
    clearTimeout(jobsRefreshTimer);
    jobsRefreshTimer = null;
  }
  // Invalidate any pending class-detail request so a slow response can't
  // repopulate the panel after the session is locked.
  state.classDetailRequestToken = (state.classDetailRequestToken || 0) + 1;
  state.pendingClassDetailId = null;
  state.adminKey = "";
  state.unlocked = false;
  state.providers = [];
  state.jobs = [];
  state.queue = createEmptyQueueState();
  state.runtimeConfig = null;
  state.providerUpdates = Object.create(null);
  state.profiles = [];
  state.profilesLoading = false;
  state.classes = [];
  state.classesLoading = false;
  state.activeClassId = null;
  state.activeClassDetail = null;
  state.classMembersLoading = false;
  if (profilesBodyEl) profilesBodyEl.innerHTML = "";
  if (classesBodyEl) classesBodyEl.innerHTML = "";
  if (classDetailPanelEl) {
    classDetailPanelEl.classList.add("hidden");
    classDetailPanelEl.hidden = true;
  }
  if (classMembersBodyEl) classMembersBodyEl.innerHTML = "";
  if (classReportRenderedEl) classReportRenderedEl.innerHTML = "";
  // Clear roster/class inputs so locking the session doesn't leave PII
  // (names, dates) sitting in the DOM on a shared machine.
  if (classCreateNameEl) classCreateNameEl.value = "";
  if (classBulkAddNamesEl) classBulkAddNamesEl.value = "";
  if (classReportFromEl) classReportFromEl.value = "";
  if (classReportToEl) classReportToEl.value = "";
  if (classReportLangEl) classReportLangEl.value = "";
  if (classReportBomEl) classReportBomEl.checked = false;
  if (backupRestoreFileEl) backupRestoreFileEl.value = "";
  if (backupIncludeProvidersEl) backupIncludeProvidersEl.checked = false;
  if (backupIncludeDictionariesEl) backupIncludeDictionariesEl.checked = false;
  // Invalidate any in-flight analytics fetch so a late response can't
  // write admin-only metrics into the (now hidden) DOM after lock,
  // which would surface as a stale panel on the next unlock without a
  // fresh authorized fetch. Bumping the token also ensures the next
  // unlock's first loadAnalytics() doesn't see a matching id from a
  // pre-lock request.
  state.analyticsRequestId += 1;
  state.analyticsLoading = false;
  state.scheduleRequestId += 1;
  state.scheduleLoading = false;
  state.schedule = null;
  state.webhooksRequestId += 1;
  state.webhooksLoading = false;
  state.webhookSubscriptions = [];
  state.webhookDeliveries = [];
  state.webhookDeliveriesSubscriptionId = null;
  state.notificationsRequestId += 1;
  state.notificationsLoading = false;
  state.notificationsSummary = null;
  // Clear any one-time secret that's still on screen — without this,
  // locking on the Webhooks tab and unlocking again would leave the
  // previously revealed secret visible until loadWebhooks() finishes.
  if (typeof webhookCreatedSecretBoxEl !== "undefined" && webhookCreatedSecretBoxEl) {
    webhookCreatedSecretBoxEl.hidden = true;
  }
  if (typeof webhookCreatedSecretValueEl !== "undefined" && webhookCreatedSecretValueEl) {
    webhookCreatedSecretValueEl.textContent = "";
  }
  if (typeof webhooksTableBody !== "undefined" && webhooksTableBody) {
    webhooksTableBody.innerHTML = "";
  }
  if (typeof webhookDeliveriesTableBody !== "undefined" && webhookDeliveriesTableBody) {
    webhookDeliveriesTableBody.innerHTML = "";
  }
  if (typeof webhookDeliveriesSubscriptionEl !== "undefined" && webhookDeliveriesSubscriptionEl) {
    webhookDeliveriesSubscriptionEl.innerHTML = "";
  }
  destroyAllAnalyticsCharts();
  if (analyticsCardsEl) {
    analyticsCardsEl.querySelectorAll('[data-metric]').forEach((el) => {
      el.textContent = "—";
    });
  }
  if (analyticsActivityTableBody) clearTbody(analyticsActivityTableBody);
  if (analyticsAttemptsTableBody) clearTbody(analyticsAttemptsTableBody);
  if (analyticsLanguageTableBody) clearTbody(analyticsLanguageTableBody);
  if (analyticsHourTableBody) clearTbody(analyticsHourTableBody);
  if (analyticsAsOfEl) analyticsAsOfEl.textContent = "";
  setStatus(analyticsStatusEl, "");
  resetRestoreDialog();
  if (backupRestoreDialogEl?.close && backupRestoreDialogEl.open) backupRestoreDialogEl.close();
  setStatus(profilesStatusEl, "");
  setStatus(profilesLimitsStatusEl, "");
  setStatus(classesStatusEl, "");
  setStatus(classDetailStatusEl, "");
  setStatus(classReportStatusEl, "");
  setStatus(backupExportStatusEl, "");
  setStatus(backupRestoreStatusEl, "");
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

if (refreshClassesBtnEl) {
  refreshClassesBtnEl.addEventListener("click", async () => {
    if (!state.unlocked) return;
    await loadClasses({ announce: true }).catch(() => {});
  });
}

if (classesIncludeArchivedEl) {
  classesIncludeArchivedEl.addEventListener("change", async () => {
    state.classesIncludeArchived = Boolean(classesIncludeArchivedEl.checked);
    if (state.unlocked) {
      await loadClasses({ announce: false }).catch(() => {});
    }
  });
}

if (classCreateFormEl) {
  classCreateFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = String(classCreateNameEl?.value || "").trim();
    if (!raw) {
      setStatus(classesStatusEl, "Class name is required.", "admin-status-missing");
      return;
    }
    await createClass(raw);
  });
}

if (classesBodyEl) {
  classesBodyEl.addEventListener("click", async (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-action]")
      : null;
    if (!target) return;
    const action = String(target.dataset.action || "").trim();
    const classId = String(target.dataset.classId || "").trim();
    if (!action || !classId) return;

    if (action === "open-class") {
      await loadClassDetail(classId).catch(() => {});
    } else if (action === "rename-class") {
      await renameClass(classId);
    } else if (action === "archive-class") {
      await setClassArchived(classId, true);
    } else if (action === "unarchive-class") {
      await setClassArchived(classId, false);
    } else if (action === "delete-class") {
      await deleteClassFlow(classId);
    }
  });
}

if (closeClassDetailBtnEl) {
  closeClassDetailBtnEl.addEventListener("click", () => {
    closeClassDetail();
  });
}

if (classBulkAddFormEl) {
  classBulkAddFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await bulkAddMembers(classBulkAddNamesEl?.value || "");
  });
}

if (classMembersBodyEl) {
  classMembersBodyEl.addEventListener("click", async (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("button[data-action='remove-member']")
      : null;
    if (!target) return;
    const profileId = String(target.dataset.profileId || "").trim();
    if (!profileId) return;
    await removeClassMember(profileId);
  });
}

if (classReportFormEl) {
  classReportFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await fetchReport();
  });
}

if (classReportCsvBtnEl) {
  classReportCsvBtnEl.addEventListener("click", async () => {
    await downloadReportCsv();
  });
}

if (classReportPrintBtnEl) {
  classReportPrintBtnEl.addEventListener("click", () => {
    openPrintReport();
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

const analyticsWindowControlEl = document.getElementById("analyticsWindowControl");
const analyticsCardsEl = document.getElementById("analyticsCards");
const analyticsAsOfEl = document.getElementById("analyticsAsOf");
const analyticsStatusEl = document.getElementById("analyticsStatus");
const analyticsActivityCanvas = document.getElementById("analyticsActivityChart");
const analyticsAttemptsCanvas = document.getElementById("analyticsAttemptsChart");
const analyticsLanguageCanvas = document.getElementById("analyticsLanguageChart");
const analyticsHourCanvas = document.getElementById("analyticsHourChart");
const analyticsActivityTableBody = document.querySelector("#analyticsActivityTable tbody");
const analyticsAttemptsTableBody = document.querySelector("#analyticsAttemptsTable tbody");
const analyticsLanguageTableBody = document.querySelector("#analyticsLanguageTable tbody");
const analyticsHourTableBody = document.querySelector("#analyticsHourTable tbody");

function formatAnalyticsNumber(value) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function setAnalyticsCard(metric, text) {
  const el = analyticsCardsEl?.querySelector(`[data-metric="${metric}"]`);
  if (el) el.textContent = text;
}

function clearTbody(tbody) {
  if (!tbody) return;
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
}

function fillTbody(tbody, rows) {
  clearTbody(tbody);
  if (!tbody) return;
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function destroyAnalyticsChart(slot) {
  const existing = state.analyticsCharts[slot];
  if (existing && typeof existing.destroy === "function") {
    existing.destroy();
  }
  state.analyticsCharts[slot] = null;
}

function destroyAllAnalyticsCharts() {
  for (const slot of Object.keys(state.analyticsCharts)) {
    destroyAnalyticsChart(slot);
  }
}

function renderActivityChart(series) {
  const labels = series.dailyActive.map((entry) => entry.date);
  const dau = series.dailyActive.map((entry) => entry.value);
  const games = series.dailyGames.map((entry) => entry.value);
  if (typeof window.Chart === "function" && analyticsActivityCanvas) {
    destroyAnalyticsChart("activity");
    state.analyticsCharts.activity = new window.Chart(analyticsActivityCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "DAU",
            data: dau,
            borderColor: "#38bdf8",
            backgroundColor: "rgba(56, 189, 248, 0.2)",
            tension: 0.25,
            yAxisID: "y"
          },
          {
            label: "Games",
            data: games,
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167, 139, 250, 0.2)",
            tension: 0.25,
            yAxisID: "y1"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { beginAtZero: true, position: "left", title: { display: true, text: "DAU" } },
          y1: {
            beginAtZero: true,
            position: "right",
            title: { display: true, text: "Games" },
            grid: { drawOnChartArea: false }
          }
        },
        plugins: { legend: { position: "bottom" } }
      }
    });
  }
  fillTbody(
    analyticsActivityTableBody,
    labels.map((date, i) => [date, dau[i], games[i]])
  );
  if (analyticsActivityCanvas) {
    const latest = labels.length ? `${labels[labels.length - 1]}: DAU ${dau[dau.length - 1]}, Games ${games[games.length - 1]}` : "no data";
    analyticsActivityCanvas.setAttribute("aria-label", `Activity over time. ${latest}.`);
  }
}

function renderAttemptsChart(distribution) {
  const labels = distribution.map((entry) => entry.bucket === "dnf" ? "DNF" : entry.bucket);
  const values = distribution.map((entry) => entry.value);
  if (typeof window.Chart === "function" && analyticsAttemptsCanvas) {
    destroyAnalyticsChart("attempts");
    state.analyticsCharts.attempts = new window.Chart(analyticsAttemptsCanvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Games",
          data: values,
          backgroundColor: "#38bdf8"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
        plugins: { legend: { display: false } }
      }
    });
  }
  fillTbody(
    analyticsAttemptsTableBody,
    distribution.map((entry) => [entry.bucket === "dnf" ? "DNF" : entry.bucket, entry.value])
  );
  if (analyticsAttemptsCanvas) {
    const total = values.reduce((sum, n) => sum + n, 0);
    analyticsAttemptsCanvas.setAttribute("aria-label", `Attempts distribution, ${total} games total.`);
  }
}

function renderLanguageChart(distribution) {
  const labels = distribution.map((entry) => entry.lang);
  const values = distribution.map((entry) => entry.value);
  if (typeof window.Chart === "function" && analyticsLanguageCanvas) {
    destroyAnalyticsChart("language");
    if (labels.length) {
      state.analyticsCharts.language = new window.Chart(analyticsLanguageCanvas, {
        type: "bar",
        data: {
          labels,
          datasets: [{
            label: "Games",
            data: values,
            backgroundColor: "#a78bfa"
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y",
          scales: { x: { beginAtZero: true } },
          plugins: { legend: { display: false } }
        }
      });
    }
  }
  fillTbody(
    analyticsLanguageTableBody,
    labels.length ? labels.map((lang, i) => [lang, values[i]]) : [["—", 0]]
  );
  if (analyticsLanguageCanvas) {
    analyticsLanguageCanvas.setAttribute(
      "aria-label",
      labels.length
        ? `Language mix across ${labels.length} languages, top: ${labels[0]} (${values[0]} games).`
        : "Language mix: no data in window."
    );
  }
}

function renderHourChart(distribution) {
  const labels = distribution.map((entry) => String(entry.hour).padStart(2, "0"));
  const values = distribution.map((entry) => entry.value);
  if (typeof window.Chart === "function" && analyticsHourCanvas) {
    destroyAnalyticsChart("hour");
    state.analyticsCharts.hour = new window.Chart(analyticsHourCanvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Games",
          data: values,
          backgroundColor: "#38bdf8"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } },
        plugins: { legend: { display: false } }
      }
    });
  }
  fillTbody(
    analyticsHourTableBody,
    distribution.map((entry) => [`${String(entry.hour).padStart(2, "0")}:00`, entry.value])
  );
  if (analyticsHourCanvas) {
    const peak = distribution.reduce(
      (best, entry) => (entry.value > best.value ? entry : best),
      { hour: 0, value: 0 }
    );
    analyticsHourCanvas.setAttribute(
      "aria-label",
      peak.value === 0
        ? "Time-of-day histogram: no data in window."
        : `Time-of-day histogram, peak hour ${String(peak.hour).padStart(2, "0")}:00 with ${peak.value} games.`
    );
  }
}

function renderAnalyticsPayload(payload) {
  if (!payload || !payload.summary) return;
  const summary = payload.summary;
  setAnalyticsCard("dau", formatAnalyticsNumber(summary.dau));
  setAnalyticsCard("wau", formatAnalyticsNumber(summary.wau));
  setAnalyticsCard("gamesInWindow", formatAnalyticsNumber(summary.gamesInWindow));
  setAnalyticsCard("winRate", formatPercent(summary.winRate));
  // formatAverage() renders "—" for non-positive values, matching the
  // Profiles table's averageWinningAttempts. The aggregator emits 0 as
  // a sentinel meaning "no wins this window" — a wins-only mean of 0
  // is impossible — so "0" would be misleading.
  setAnalyticsCard("avgAttempts", formatAverage(summary.avgAttempts));
  setAnalyticsCard("replayRate", formatPercent(summary.replayRate));
  setAnalyticsCard("profileCount", formatAnalyticsNumber(summary.profileCount));
  if (analyticsAsOfEl) {
    const asOf = payload.generatedAt
      ? new Date(payload.generatedAt).toLocaleString()
      : "now";
    analyticsAsOfEl.textContent = `Window: ${payload.window || "—"} · As of ${asOf}`;
  }
  renderActivityChart(payload.series || { dailyActive: [], dailyGames: [], profileGrowth: [] });
  renderAttemptsChart(payload.distributions?.attempts || []);
  renderLanguageChart(payload.distributions?.languageMix || []);
  renderHourChart(payload.distributions?.hourOfDay || []);
}

async function loadAnalytics(options = {}) {
  if (!state.unlocked || !analyticsCardsEl) return;
  // Increment the request id and capture our token. Comparing only the
  // captured window let a 7d → all → 7d sequence's first 7d response
  // overwrite the second 7d response if the first lagged enough. The id
  // pins each fetch to its own slot so only the most recent one ever
  // renders, regardless of how the windows were toggled.
  state.analyticsRequestId += 1;
  const requestId = state.analyticsRequestId;
  const requestedWindow = state.analyticsWindow;
  state.analyticsLoading = true;
  if (options.announce !== false) {
    setStatus(analyticsStatusEl, "Loading analytics…", "");
  }
  try {
    const payload = await requestAdminJson(
      `/api/admin/analytics?window=${encodeURIComponent(requestedWindow)}`
    );
    if (requestId !== state.analyticsRequestId) {
      // A newer request superseded us — drop the result silently.
      return payload;
    }
    renderAnalyticsPayload(payload);
    if (options.announce !== false) {
      const total = payload?.summary?.gamesInWindow ?? 0;
      setStatus(
        analyticsStatusEl,
        total === 0
          ? "No games recorded in the selected window yet."
          : `Loaded analytics: ${total} games in window.`,
        total === 0 ? "admin-status-off" : "admin-status-ok"
      );
    }
    return payload;
  } catch (err) {
    if (options.announce !== false && requestId === state.analyticsRequestId) {
      setStatus(analyticsStatusEl, `Analytics failed: ${err.message}`, "admin-status-missing");
    }
    throw err;
  } finally {
    // Only the most-recent fetch should clear the loading flag; otherwise
    // an earlier overlapping call's finally would set "not loading" while
    // a newer call is still in flight, and the activateTab gate (which
    // checks !analyticsLoading) could fire a third redundant load.
    if (requestId === state.analyticsRequestId) {
      state.analyticsLoading = false;
    }
  }
}

function setAnalyticsWindow(nextWindow) {
  if (!["7d", "30d", "all"].includes(nextWindow)) return;
  if (state.analyticsWindow === nextWindow) return;
  state.analyticsWindow = nextWindow;
  if (analyticsWindowControlEl) {
    const buttons = analyticsWindowControlEl.querySelectorAll(".analytics-window-btn");
    buttons.forEach((btn) => {
      const isActive = btn.dataset.window === nextWindow;
      btn.setAttribute("aria-checked", isActive ? "true" : "false");
      btn.tabIndex = isActive ? 0 : -1;
    });
  }
  if (state.unlocked) {
    loadAnalytics({ announce: true }).catch(() => {});
  }
}

if (analyticsWindowControlEl) {
  const buttons = Array.from(analyticsWindowControlEl.querySelectorAll(".analytics-window-btn"));
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => setAnalyticsWindow(btn.dataset.window || "7d"));
    btn.addEventListener("keydown", (event) => {
      const idx = buttons.indexOf(btn);
      if (idx < 0) return;
      let nextIdx = idx;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIdx = (idx + 1) % buttons.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIdx = (idx - 1 + buttons.length) % buttons.length;
      } else if (event.key === "Home") {
        nextIdx = 0;
      } else if (event.key === "End") {
        nextIdx = buttons.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const next = buttons[nextIdx];
      next.focus();
      setAnalyticsWindow(next.dataset.window || "7d");
    });
  });
}

window.addEventListener("beforeunload", destroyAllAnalyticsCharts);

// ============================================================================
// SCHEDULE TAB
// ============================================================================

const scheduleStatusStripEl = document.getElementById("scheduleStatusStrip");
const scheduleStatusEl = document.getElementById("scheduleStatus");
const scheduleConfigFormEl = document.getElementById("scheduleConfigForm");
const scheduleTimezoneInputEl = document.getElementById("scheduleTimezoneInput");
const scheduleTimezoneListEl = document.getElementById("scheduleTimezoneList");
const scheduleAutoRotateEl = document.getElementById("scheduleAutoRotate");
const scheduleRetentionDaysEl = document.getElementById("scheduleRetentionDays");
const schedulePruneBtnEl = document.getElementById("schedulePruneBtn");
const scheduleReconcileBtnEl = document.getElementById("scheduleReconcileBtn");
const scheduleEntryFormEl = document.getElementById("scheduleEntryForm");
const scheduleEntryDateEl = document.getElementById("scheduleEntryDate");
const scheduleEntryWordEl = document.getElementById("scheduleEntryWord");
const scheduleEntryLangEl = document.getElementById("scheduleEntryLang");
const scheduleEntryNotesEl = document.getElementById("scheduleEntryNotes");
const scheduleEntryOverwriteEl = document.getElementById("scheduleEntryOverwrite");
const scheduleEntriesTableBody = document.querySelector("#scheduleEntriesTable tbody");

function setStripField(name, text) {
  if (!scheduleStatusStripEl) return;
  const el = scheduleStatusStripEl.querySelector(`[data-schedule-field="${name}"]`);
  if (el) el.textContent = text;
}

function populateTimezoneList() {
  if (!scheduleTimezoneListEl) return;
  // Intl.supportedValuesOf is a recent API but covered everywhere we
  // care about; if it's missing the input still works as a free-text
  // field (validated server-side).
  if (typeof Intl.supportedValuesOf !== "function") return;
  if (scheduleTimezoneListEl.children.length > 0) return;
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch (_err) {
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const zone of zones) {
    const opt = document.createElement("option");
    opt.value = zone;
    fragment.appendChild(opt);
  }
  scheduleTimezoneListEl.appendChild(fragment);
}

function renderScheduleStrip(snapshot) {
  if (!snapshot) {
    setStripField("timezone", "—");
    setStripField("todayResolved", "—");
    setStripField("lastReconciledAt", "—");
    return;
  }
  setStripField("timezone", snapshot.timezone || "—");
  let todayLocal = "—";
  try {
    // Build YYYY-MM-DD from formatToParts so we don't depend on .format()
    // emitting a stable layout (it doesn't, per ECMAScript spec).
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: snapshot.timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const parts = dtf.formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) todayLocal = `${y}-${m}-${d}`;
  } catch (_err) {
    // best-effort; bad zone surfaces in the existing form
  }
  const todayEntry = (snapshot.scheduled_words || []).find(
    (row) => row.date === todayLocal
  );
  setStripField(
    "todayResolved",
    todayEntry
      ? `${todayLocal} → ${todayEntry.word} (${todayEntry.lang})`
      : `${todayLocal} (no entry)`
  );
  setStripField(
    "lastReconciledAt",
    snapshot.last_reconciled_at
      ? `${snapshot.last_reconciled_for || "?"} at ${new Date(snapshot.last_reconciled_at).toLocaleString()}`
      : "never"
  );
}

function renderScheduleEntries(snapshot) {
  if (!scheduleEntriesTableBody) return;
  while (scheduleEntriesTableBody.firstChild) {
    scheduleEntriesTableBody.removeChild(scheduleEntriesTableBody.firstChild);
  }
  const entries = snapshot && Array.isArray(snapshot.scheduled_words)
    ? snapshot.scheduled_words
    : [];
  if (entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = "No scheduled entries yet.";
    tr.appendChild(td);
    scheduleEntriesTableBody.appendChild(tr);
    return;
  }
  for (const entry of entries) {
    const tr = document.createElement("tr");
    const dateTd = document.createElement("td");
    dateTd.textContent = entry.date;
    const langTd = document.createElement("td");
    langTd.textContent = entry.lang;
    const wordTd = document.createElement("td");
    wordTd.textContent = entry.word;
    const notesTd = document.createElement("td");
    notesTd.textContent = entry.notes || "";
    const actionsTd = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => loadEntryIntoForm(entry));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    // Plain styled button rather than .admin-action-destructive: that
    // class's amber-on-light combination fails WCAG AA on the light
    // theme (color-contrast 2.77:1). The Delete label + a confirm
    // dialog are sufficient affordances here.
    delBtn.className = "schedule-delete-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteScheduleEntry(entry.date, entry.lang));
    actionsTd.append(editBtn, document.createTextNode(" "), delBtn);
    tr.append(dateTd, langTd, wordTd, notesTd, actionsTd);
    scheduleEntriesTableBody.appendChild(tr);
  }
}

function loadEntryIntoForm(entry) {
  if (!scheduleEntryDateEl || !scheduleEntryWordEl || !scheduleEntryLangEl) return;
  scheduleEntryDateEl.value = entry.date;
  scheduleEntryWordEl.value = entry.word;
  scheduleEntryLangEl.value = entry.lang;
  scheduleEntryNotesEl.value = entry.notes || "";
  scheduleEntryOverwriteEl.checked = true;
  // Lock the (date, lang) inputs so the original key is preserved —
  // otherwise the operator could change the key fields and the submit
  // would orphan the original row instead of updating it. To re-key
  // an entry, delete the old one and add a new one.
  scheduleEntryDateEl.readOnly = true;
  scheduleEntryLangEl.readOnly = true;
  state.scheduleEditingKey = { date: entry.date, lang: entry.lang };
  scheduleEntryWordEl.focus();
}

function clearEditingMode() {
  if (scheduleEntryDateEl) scheduleEntryDateEl.readOnly = false;
  if (scheduleEntryLangEl) scheduleEntryLangEl.readOnly = false;
  state.scheduleEditingKey = null;
}

function applyScheduleSnapshot(snapshot) {
  state.schedule = snapshot;
  if (scheduleTimezoneInputEl) scheduleTimezoneInputEl.value = snapshot?.timezone || "";
  if (scheduleAutoRotateEl) scheduleAutoRotateEl.checked = Boolean(snapshot?.auto_rotate);
  if (scheduleRetentionDaysEl) {
    scheduleRetentionDaysEl.value = Number.isInteger(snapshot?.retention_days)
      ? String(snapshot.retention_days)
      : "";
  }
  renderScheduleStrip(snapshot);
  renderScheduleEntries(snapshot);
}

async function loadSchedule(options = {}) {
  if (!state.unlocked) return;
  state.scheduleRequestId += 1;
  const requestId = state.scheduleRequestId;
  state.scheduleLoading = true;
  if (options.announce !== false) {
    setStatus(scheduleStatusEl, "Loading schedule…", "");
  }
  try {
    const payload = await requestAdminJson("/api/admin/schedule");
    if (requestId !== state.scheduleRequestId) return payload;
    populateTimezoneList();
    applyScheduleSnapshot(payload);
    if (options.announce !== false) {
      const count = (payload?.scheduled_words || []).length;
      setStatus(
        scheduleStatusEl,
        count === 0 ? "No scheduled entries yet." : `Loaded ${count} entr${count === 1 ? "y" : "ies"}.`,
        count === 0 ? "admin-status-off" : "admin-status-ok"
      );
    }
    return payload;
  } catch (err) {
    if (options.announce !== false && requestId === state.scheduleRequestId) {
      setStatus(scheduleStatusEl, `Schedule load failed: ${err.message}`, "admin-status-missing");
    }
    throw err;
  } finally {
    if (requestId === state.scheduleRequestId) state.scheduleLoading = false;
  }
}

if (scheduleConfigFormEl) {
  scheduleConfigFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.unlocked) return;
    const body = {
      timezone: scheduleTimezoneInputEl?.value?.trim(),
      auto_rotate: Boolean(scheduleAutoRotateEl?.checked)
    };
    // Only send retention_days if the operator actually entered a
    // value. An empty input would otherwise coerce to 0 and the next
    // prune would wipe almost all history — likely not the intent.
    const retentionRaw = scheduleRetentionDaysEl?.value?.trim();
    if (retentionRaw !== "" && retentionRaw !== undefined) {
      const retention = Number(retentionRaw);
      if (Number.isInteger(retention) && retention >= 0) {
        body.retention_days = retention;
      }
    }
    try {
      const payload = await requestAdminJson("/api/admin/schedule/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      applyScheduleSnapshot(payload.schedule || payload);
      setStatus(scheduleStatusEl, "Configuration saved.", "admin-status-ok");
    } catch (err) {
      setStatus(scheduleStatusEl, `Save failed: ${err.message}`, "admin-status-missing");
    }
  });
}

if (scheduleEntryFormEl) {
  scheduleEntryFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.unlocked) return;
    const date = scheduleEntryDateEl?.value;
    const word = scheduleEntryWordEl?.value?.toUpperCase();
    const lang = scheduleEntryLangEl?.value?.trim();
    const notes = scheduleEntryNotesEl?.value || undefined;
    const editingKey = state.scheduleEditingKey;
    try {
      let payload;
      if (editingKey && editingKey.date === date && editingKey.lang === lang) {
        // Edit mode with unchanged key → PUT (idempotent partial edit).
        payload = await requestAdminJson(
          `/api/admin/schedule/entries/${encodeURIComponent(date)}/${encodeURIComponent(lang)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ word, notes })
          }
        );
      } else {
        // Fresh add or re-key — POST. Overwrite flag follows the
        // checkbox; UI locks the key fields during edit so the only
        // way to land here in edit mode is if the operator cleared
        // and re-typed manually after the readOnly was disabled.
        const overwrite = scheduleEntryOverwriteEl?.checked ? "?overwrite=true" : "";
        payload = await requestAdminJson(`/api/admin/schedule/entries${overwrite}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, word, lang, notes })
        });
      }
      applyScheduleSnapshot(payload.schedule || payload);
      setStatus(
        scheduleStatusEl,
        payload.replaced || editingKey ? "Entry saved." : "Entry added.",
        "admin-status-ok"
      );
      scheduleEntryFormEl.reset();
      if (scheduleEntryLangEl) scheduleEntryLangEl.value = "en";
      clearEditingMode();
    } catch (err) {
      setStatus(scheduleStatusEl, `Save failed: ${err.message}`, "admin-status-missing");
    }
  });
}

// Each of these handlers performs the destructive/mutating action
// FIRST, then calls loadSchedule() to refresh the cached UI snapshot.
// We deliberately split the catch so a refresh failure can't make a
// successful delete/prune/reconcile look like an error in the status
// strip — that misleading copy would invite the operator to retry a
// destructive action that already landed.
async function deleteScheduleEntry(date, lang) {
  if (!state.unlocked) return;
  if (!window.confirm(`Delete the schedule entry for ${date} (${lang})?`)) return;
  try {
    await requestAdminJson(
      `/api/admin/schedule/entries/${encodeURIComponent(date)}/${encodeURIComponent(lang)}`,
      { method: "DELETE" }
    );
  } catch (err) {
    setStatus(scheduleStatusEl, `Delete failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(scheduleStatusEl, `Deleted entry for ${date} (${lang}).`, "admin-status-ok");
  loadSchedule({ announce: false }).catch(() => {
    // Refresh failure shouldn't override the success message above.
  });
}

if (schedulePruneBtnEl) {
  schedulePruneBtnEl.addEventListener("click", async () => {
    if (!state.unlocked) return;
    let payload;
    try {
      payload = await requestAdminJson("/api/admin/schedule/prune", { method: "POST" });
    } catch (err) {
      setStatus(scheduleStatusEl, `Prune failed: ${err.message}`, "admin-status-missing");
      return;
    }
    setStatus(
      scheduleStatusEl,
      `Pruned ${payload.pruned} entr${payload.pruned === 1 ? "y" : "ies"} before ${payload.cutoff}.`,
      "admin-status-ok"
    );
    loadSchedule({ announce: false }).catch(() => {});
  });
}

if (scheduleReconcileBtnEl) {
  scheduleReconcileBtnEl.addEventListener("click", async () => {
    if (!state.unlocked) return;
    let payload;
    try {
      payload = await requestAdminJson("/api/admin/schedule/reconcile", { method: "POST" });
    } catch (err) {
      setStatus(scheduleStatusEl, `Reconcile failed: ${err.message}`, "admin-status-missing");
      return;
    }
    const r = payload.result;
    const detail = r?.action ? `(${r.action}, ${r.todayLocal || "unknown date"})` : "";
    setStatus(scheduleStatusEl, `Reconcile complete ${detail}`, "admin-status-ok");
    loadSchedule({ announce: false }).catch(() => {});
  });
}

// ── Webhooks tab ───────────────────────────────────────────────────────
const webhooksDisabledBannerEl = document.getElementById("webhooksDisabledBanner");
const webhooksStatusEl = document.getElementById("webhooksStatus");
const webhookCreateFormEl = document.getElementById("webhookCreateForm");
const webhookUrlInputEl = document.getElementById("webhookUrlInput");
const webhookEventsInputEl = document.getElementById("webhookEventsInput");
const webhookLabelInputEl = document.getElementById("webhookLabelInput");
const webhookMaxAttemptsInputEl = document.getElementById("webhookMaxAttemptsInput");
const webhookEnabledInputEl = document.getElementById("webhookEnabledInput");
const webhookCreatedSecretBoxEl = document.getElementById("webhookCreatedSecretBox");
const webhookCreatedSecretValueEl = document.getElementById("webhookCreatedSecretValue");
const webhooksTableBody = document.querySelector("#webhooksTable tbody");
const webhookDeliveriesSubscriptionEl = document.getElementById("webhookDeliveriesSubscription");
const webhookDeliveriesRefreshBtnEl = document.getElementById("webhookDeliveriesRefreshBtn");
const webhookDeliveriesTableBody = document.querySelector("#webhookDeliveriesTable tbody");

function parseEventsCsv(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function loadWebhooks(options = {}) {
  if (!state.unlocked) return;
  if (state.webhooksLoading) return;
  state.webhooksLoading = true;
  const requestId = ++state.webhooksRequestId;
  if (options.announce !== false) setStatus(webhooksStatusEl, "Loading webhooks…");
  try {
    const payload = await requestAdminJson("/api/admin/webhooks");
    if (requestId !== state.webhooksRequestId) return;
    state.webhooksEnabled = payload.enabled !== false;
    state.webhookSubscriptions = Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
    state.webhookDefaultMaxAttempts = Number.isInteger(payload.defaultMaxAttempts)
      ? payload.defaultMaxAttempts
      : 5;
    if (webhookMaxAttemptsInputEl && !webhookMaxAttemptsInputEl.value) {
      webhookMaxAttemptsInputEl.placeholder = String(state.webhookDefaultMaxAttempts);
    }
    if (webhooksDisabledBannerEl) {
      webhooksDisabledBannerEl.hidden = state.webhooksEnabled;
    }
    renderWebhooks();
    if (options.announce !== false) setStatus(webhooksStatusEl, "Webhooks loaded.", "admin-status-ok");
  } catch (err) {
    if (requestId !== state.webhooksRequestId) return;
    setStatus(webhooksStatusEl, `Load failed: ${err.message}`, "admin-status-missing");
  } finally {
    if (requestId === state.webhooksRequestId) {
      state.webhooksLoading = false;
    }
  }
}

function renderWebhooks() {
  if (!webhooksTableBody) return;
  webhooksTableBody.innerHTML = "";
  if (!state.webhookSubscriptions.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No webhook subscriptions configured yet.";
    row.appendChild(cell);
    webhooksTableBody.appendChild(row);
  } else {
    const fragment = document.createDocumentFragment();
    for (const sub of state.webhookSubscriptions) {
      const row = document.createElement("tr");
      row.appendChild(buildCell(sub.label || "—"));
      row.appendChild(buildCell(sub.url));
      row.appendChild(buildCell((sub.events || []).join(", ")));
      row.appendChild(buildCell(sub.enabled ? "yes" : "no"));
      row.appendChild(buildCell(String(sub.maxAttempts ?? "—")));
      row.appendChild(buildCell(formatTimestamp(sub.createdAt)));
      const actions = document.createElement("td");
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "ghost";
      toggleBtn.textContent = sub.enabled ? "Disable" : "Enable";
      toggleBtn.addEventListener("click", () => toggleWebhook(sub.id, !sub.enabled));
      actions.appendChild(toggleBtn);
      const testBtn = document.createElement("button");
      testBtn.type = "button";
      testBtn.className = "ghost";
      testBtn.textContent = "Test";
      testBtn.addEventListener("click", () => sendWebhookTest(sub.id));
      actions.appendChild(testBtn);
      const rotateBtn = document.createElement("button");
      rotateBtn.type = "button";
      rotateBtn.className = "ghost";
      rotateBtn.textContent = "Rotate secret";
      rotateBtn.addEventListener("click", () => rotateWebhookSecret(sub.id));
      actions.appendChild(rotateBtn);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ghost";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteWebhook(sub.id, sub.label || sub.url));
      actions.appendChild(delBtn);
      row.appendChild(actions);
      fragment.appendChild(row);
    }
    webhooksTableBody.appendChild(fragment);
  }
  // Re-populate the deliveries subscription <select>.
  if (webhookDeliveriesSubscriptionEl) {
    const previousValue = state.webhookDeliveriesSubscriptionId
      || webhookDeliveriesSubscriptionEl.value;
    webhookDeliveriesSubscriptionEl.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— select subscription —";
    webhookDeliveriesSubscriptionEl.appendChild(placeholder);
    for (const sub of state.webhookSubscriptions) {
      const opt = document.createElement("option");
      opt.value = sub.id;
      opt.textContent = sub.label ? `${sub.label} (${sub.url})` : sub.url;
      webhookDeliveriesSubscriptionEl.appendChild(opt);
    }
    if (previousValue && state.webhookSubscriptions.some((s) => s.id === previousValue)) {
      webhookDeliveriesSubscriptionEl.value = previousValue;
    }
  }
}

function buildCell(text) {
  const td = document.createElement("td");
  td.textContent = text === null || text === undefined ? "" : String(text);
  return td;
}

async function toggleWebhook(id, nextEnabled) {
  if (!state.unlocked) return;
  try {
    await requestAdminJson(`/api/admin/webhooks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled })
    });
  } catch (err) {
    setStatus(webhooksStatusEl, `Toggle failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(
    webhooksStatusEl,
    `Subscription ${nextEnabled ? "enabled" : "disabled"}.`,
    "admin-status-ok"
  );
  loadWebhooks({ announce: false }).catch(() => {});
}

async function sendWebhookTest(id) {
  if (!state.unlocked) return;
  try {
    const payload = await requestAdminJson(`/api/admin/webhooks/${encodeURIComponent(id)}/test`, {
      method: "POST"
    });
    setStatus(
      webhooksStatusEl,
      `Test event queued (delivery ${payload.deliveryId}).`,
      "admin-status-ok"
    );
  } catch (err) {
    setStatus(webhooksStatusEl, `Test failed: ${err.message}`, "admin-status-missing");
  }
}

async function rotateWebhookSecret(id) {
  if (!state.unlocked) return;
  if (!window.confirm("Rotate this subscription's secret? The old secret will stop being valid immediately.")) return;
  try {
    const payload = await requestAdminJson(`/api/admin/webhooks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotateSecret: true })
    });
    if (webhookCreatedSecretBoxEl && webhookCreatedSecretValueEl && payload?.subscription?.secret) {
      webhookCreatedSecretValueEl.textContent = payload.subscription.secret;
      webhookCreatedSecretBoxEl.hidden = false;
    }
    setStatus(webhooksStatusEl, "Secret rotated. Copy it now.", "admin-status-ok");
    loadWebhooks({ announce: false }).catch(() => {});
  } catch (err) {
    setStatus(webhooksStatusEl, `Rotate failed: ${err.message}`, "admin-status-missing");
  }
}

async function deleteWebhook(id, label) {
  if (!state.unlocked) return;
  if (!window.confirm(`Delete subscription "${label}"? Delivery history will also be removed.`)) return;
  try {
    await requestAdminJson(`/api/admin/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    setStatus(webhooksStatusEl, `Delete failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(webhooksStatusEl, "Subscription deleted.", "admin-status-ok");
  loadWebhooks({ announce: false }).catch(() => {});
}

if (webhookCreateFormEl) {
  webhookCreateFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.unlocked) return;
    const url = String(webhookUrlInputEl?.value || "").trim();
    const events = parseEventsCsv(webhookEventsInputEl?.value);
    const label = String(webhookLabelInputEl?.value || "").trim() || undefined;
    const maxAttemptsRaw = String(webhookMaxAttemptsInputEl?.value || "").trim();
    const maxAttempts = maxAttemptsRaw ? Number(maxAttemptsRaw) : undefined;
    const enabled = Boolean(webhookEnabledInputEl?.checked);
    if (!url) {
      setStatus(webhooksStatusEl, "URL is required.", "admin-status-missing");
      return;
    }
    if (events.length === 0) {
      setStatus(webhooksStatusEl, "At least one event is required.", "admin-status-missing");
      return;
    }
    let payload;
    try {
      payload = await requestAdminJson("/api/admin/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events, label, maxAttempts, enabled })
      });
    } catch (err) {
      setStatus(webhooksStatusEl, `Create failed: ${err.message}`, "admin-status-missing");
      return;
    }
    if (webhookCreatedSecretBoxEl && webhookCreatedSecretValueEl && payload?.subscription?.secret) {
      webhookCreatedSecretValueEl.textContent = payload.subscription.secret;
      webhookCreatedSecretBoxEl.hidden = false;
    }
    setStatus(webhooksStatusEl, "Subscription created. Copy the secret now.", "admin-status-ok");
    webhookCreateFormEl.reset();
    if (webhookEnabledInputEl) webhookEnabledInputEl.checked = true;
    loadWebhooks({ announce: false }).catch(() => {});
  });
}

async function loadWebhookDeliveries(subscriptionId) {
  if (!state.unlocked || !subscriptionId) {
    if (webhookDeliveriesTableBody) webhookDeliveriesTableBody.innerHTML = "";
    state.webhookDeliveries = [];
    return;
  }
  const requestId = ++state.webhookDeliveriesRequestId;
  try {
    const payload = await requestAdminJson(
      `/api/admin/webhooks/${encodeURIComponent(subscriptionId)}/deliveries?limit=50`
    );
    // Drop late responses — the operator may have switched
    // subscriptions or locked the workspace before this fetch
    // resolved, and the rendered table+retry buttons must reflect
    // the most recent request.
    if (requestId !== state.webhookDeliveriesRequestId) return;
    state.webhookDeliveries = Array.isArray(payload.deliveries) ? payload.deliveries : [];
    state.webhookDeliveriesSubscriptionId = subscriptionId;
    renderWebhookDeliveries();
  } catch (err) {
    if (requestId !== state.webhookDeliveriesRequestId) return;
    setStatus(webhooksStatusEl, `Deliveries fetch failed: ${err.message}`, "admin-status-missing");
  }
}

function renderWebhookDeliveries() {
  if (!webhookDeliveriesTableBody) return;
  webhookDeliveriesTableBody.innerHTML = "";
  if (!state.webhookDeliveries.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No deliveries yet.";
    row.appendChild(cell);
    webhookDeliveriesTableBody.appendChild(row);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const d of state.webhookDeliveries) {
    const row = document.createElement("tr");
    row.appendChild(buildCell(formatTimestamp(d.createdAt)));
    row.appendChild(buildCell(d.event));
    row.appendChild(buildCell(d.status));
    row.appendChild(buildCell(String(d.attempts ?? 0)));
    row.appendChild(buildCell(d.responseStatus !== null && d.responseStatus !== undefined ? String(d.responseStatus) : "—"));
    row.appendChild(buildCell(d.lastError || ""));
    const actions = document.createElement("td");
    if (d.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "ghost";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => retryWebhookDelivery(d.subscriptionId, d.id));
      actions.appendChild(retryBtn);
    }
    row.appendChild(actions);
    fragment.appendChild(row);
  }
  webhookDeliveriesTableBody.appendChild(fragment);
}

async function retryWebhookDelivery(subscriptionId, deliveryId) {
  if (!state.unlocked) return;
  try {
    await requestAdminJson(
      `/api/admin/webhooks/${encodeURIComponent(subscriptionId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      { method: "POST" }
    );
  } catch (err) {
    setStatus(webhooksStatusEl, `Retry failed: ${err.message}`, "admin-status-missing");
    return;
  }
  setStatus(webhooksStatusEl, "Delivery requeued.", "admin-status-ok");
  loadWebhookDeliveries(subscriptionId).catch(() => {});
}

if (webhookDeliveriesSubscriptionEl) {
  webhookDeliveriesSubscriptionEl.addEventListener("change", () => {
    const id = webhookDeliveriesSubscriptionEl.value || null;
    state.webhookDeliveriesSubscriptionId = id;
    if (id) {
      loadWebhookDeliveries(id).catch(() => {});
    } else {
      state.webhookDeliveries = [];
      renderWebhookDeliveries();
    }
  });
}

if (webhookDeliveriesRefreshBtnEl) {
  webhookDeliveriesRefreshBtnEl.addEventListener("click", () => {
    const id = state.webhookDeliveriesSubscriptionId
      || (webhookDeliveriesSubscriptionEl && webhookDeliveriesSubscriptionEl.value);
    if (id) loadWebhookDeliveries(id).catch(() => {});
  });
}

// ── Notifications tab ──────────────────────────────────────────────────
const notificationsStatusEl = document.getElementById("notificationsStatus");
const notifSubscriptionCountEl = document.getElementById("notifSubscriptionCount");
const notifLastBroadcastEl = document.getElementById("notifLastBroadcast");
const notifLastDailyFireEl = document.getElementById("notifLastDailyFire");
const notifRefreshBtnEl = document.getElementById("notifRefreshBtn");
const notifBroadcastFormEl = document.getElementById("notifBroadcastForm");
const notifBroadcastTitleEl = document.getElementById("notifBroadcastTitle");
const notifBroadcastBodyEl = document.getElementById("notifBroadcastBody");
const notifBroadcastUrlEl = document.getElementById("notifBroadcastUrl");
const notifBroadcastPreviewBtnEl = document.getElementById("notifBroadcastPreviewBtn");
const notifBroadcastPreviewEl = document.getElementById("notifBroadcastPreview");
const notifBroadcastPreviewTextEl = document.getElementById("notifBroadcastPreviewText");

async function loadNotifications(options = {}) {
  if (!state.unlocked) return;
  if (state.notificationsLoading) return;
  state.notificationsLoading = true;
  const requestId = ++state.notificationsRequestId;
  if (options.announce !== false) setStatus(notificationsStatusEl, "Loading…");
  try {
    const payload = await requestAdminJson("/api/admin/notifications/subscriptions");
    if (requestId !== state.notificationsRequestId) return;
    state.notificationsSummary = payload;
    renderNotificationsSummary();
    if (options.announce !== false) setStatus(notificationsStatusEl, "Loaded.", "admin-status-ok");
  } catch (err) {
    if (requestId !== state.notificationsRequestId) return;
    setStatus(notificationsStatusEl, `Load failed: ${err.message}`, "admin-status-missing");
  } finally {
    if (requestId === state.notificationsRequestId) {
      state.notificationsLoading = false;
    }
  }
}

function renderNotificationsSummary() {
  const summary = state.notificationsSummary;
  if (!summary) return;
  if (notifSubscriptionCountEl) {
    notifSubscriptionCountEl.textContent = String(summary.count ?? 0);
  }
  if (notifLastBroadcastEl) {
    notifLastBroadcastEl.textContent = summary.lastBroadcastAt ? formatTimestamp(summary.lastBroadcastAt) : "Never";
  }
  if (notifLastDailyFireEl) {
    notifLastDailyFireEl.textContent = summary.lastDailyFireAt ? formatTimestamp(summary.lastDailyFireAt) : "Never";
  }
}

if (notifRefreshBtnEl) {
  notifRefreshBtnEl.addEventListener("click", () => {
    loadNotifications({ announce: true }).catch(() => {});
  });
}

async function submitBroadcast({ dryRun }) {
  if (!state.unlocked) return;
  const title = String(notifBroadcastTitleEl?.value || "").trim();
  const body = String(notifBroadcastBodyEl?.value || "").trim();
  const url = String(notifBroadcastUrlEl?.value || "").trim() || "/";
  if (!title || !body) {
    setStatus(notificationsStatusEl, "Title and body are required.", "admin-status-missing");
    return;
  }
  if (!dryRun) {
    if (!window.confirm(`Send "${title}" to all subscribers?`)) return;
  }
  let payload;
  try {
    payload = await requestAdminJson("/api/admin/notifications/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, url, dryRun: dryRun === true })
    });
  } catch (err) {
    setStatus(notificationsStatusEl, `Broadcast failed: ${err.message}`, "admin-status-missing");
    return;
  }
  if (dryRun) {
    if (notifBroadcastPreviewEl && notifBroadcastPreviewTextEl) {
      const p = payload.result?.preview || { title, body, url };
      notifBroadcastPreviewTextEl.textContent = `${p.title} · ${p.body} · ${p.url} (${payload.result?.recipients ?? 0} recipient(s))`;
      notifBroadcastPreviewEl.hidden = false;
    }
    setStatus(notificationsStatusEl, "Preview rendered.", "admin-status-ok");
  } else {
    setStatus(
      notificationsStatusEl,
      `Sent: ${payload.result?.sent ?? 0}, failed: ${payload.result?.failed ?? 0}, gone: ${payload.result?.gone ?? 0}.`,
      "admin-status-ok"
    );
    if (notifBroadcastPreviewEl) notifBroadcastPreviewEl.hidden = true;
    notifBroadcastFormEl?.reset();
    loadNotifications({ announce: false }).catch(() => {});
  }
}

if (notifBroadcastPreviewBtnEl) {
  notifBroadcastPreviewBtnEl.addEventListener("click", () => {
    submitBroadcast({ dryRun: true }).catch(() => {});
  });
}

if (notifBroadcastFormEl) {
  notifBroadcastFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    submitBroadcast({ dryRun: false }).catch(() => {});
  });
}

// ── Admin Challenges tab ───────────────────────────────────────────────
const challengesAdminStatusEl = document.getElementById("challengesAdminStatus");
const challengeAdminFormEl = document.getElementById("challengeAdminForm");
const challengeAdminIdEl = document.getElementById("challengeAdminId");
const challengeAdminNameEl = document.getElementById("challengeAdminName");
const challengeAdminLangEl = document.getElementById("challengeAdminLang");
const challengeAdminWordLengthEl = document.getElementById("challengeAdminWordLength");
const challengeAdminPuzzleCountEl = document.getElementById("challengeAdminPuzzleCount");
const challengeAdminTimeBudgetEl = document.getElementById("challengeAdminTimeBudget");
const challengeAdminMaxGuessesEl = document.getElementById("challengeAdminMaxGuesses");
const challengeAdminPerPuzzleScoreEl = document.getElementById("challengeAdminPerPuzzleScore");
const challengeAdminSpeedBonusEl = document.getElementById("challengeAdminSpeedBonus");
const challengeAdminReplayPolicyEl = document.getElementById("challengeAdminReplayPolicy");
const challengeAdminStartTimeEl = document.getElementById("challengeAdminStartTime");
const challengeAdminEndTimeEl = document.getElementById("challengeAdminEndTime");
const challengeAdminClearBtnEl = document.getElementById("challengeAdminClearBtn");
const challengesAdminTbodyEl = document.querySelector("#challengesAdminTable tbody");
const challengeAdminLeaderboardSectionEl = document.getElementById("challengeAdminLeaderboardSection");
const challengeAdminLeaderboardNameEl = document.getElementById("challengeAdminLeaderboardName");
const challengesAdminLbTbodyEl = document.querySelector("#challengesAdminLbTable tbody");
const challengeAdminLbCloseBtnEl = document.getElementById("challengeAdminLbCloseBtn");

if (typeof state !== "undefined") {
  state.challengesAdminLoading = false;
  state.challengesAdmin = [];
}

function setChallengeAdminStatus(text, tone = "") {
  if (!challengesAdminStatusEl) return;
  challengesAdminStatusEl.textContent = text || "";
  challengesAdminStatusEl.classList.remove("admin-status-ok", "admin-status-missing");
  if (tone) challengesAdminStatusEl.classList.add(tone);
}

async function loadChallengesAdmin() {
  if (!state?.unlocked) return;
  state.challengesAdminLoading = true;
  setChallengeAdminStatus("Loading…");
  try {
    const payload = await requestAdminJson("/api/admin/challenges");
    state.challengesAdmin = Array.isArray(payload.challenges) ? payload.challenges : [];
    renderChallengesAdmin();
    setChallengeAdminStatus("Loaded.", "admin-status-ok");
  } catch (err) {
    setChallengeAdminStatus(`Load failed: ${err.message}`, "admin-status-missing");
  } finally {
    state.challengesAdminLoading = false;
  }
}

function renderChallengesAdmin() {
  if (!challengesAdminTbodyEl) return;
  challengesAdminTbodyEl.innerHTML = "";
  if (!state.challengesAdmin.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No challenges configured.";
    row.appendChild(cell);
    challengesAdminTbodyEl.appendChild(row);
    return;
  }
  for (const ch of state.challengesAdmin) {
    const row = document.createElement("tr");
    row.appendChild(buildCell(ch.name));
    row.appendChild(buildCell(ch.lang));
    row.appendChild(buildCell(`${ch.puzzleCount} × ${ch.timeBudgetSeconds}s`));
    row.appendChild(buildCell(ch.replayPolicy));
    row.appendChild(buildCell(String(ch.sessionCount ?? 0)));
    row.appendChild(buildCell(ch.deleted ? "deleted" : "active"));
    const actions = document.createElement("td");
    if (!ch.deleted) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "ghost";
      editBtn.textContent = ch.sessionCount > 0 ? "View (locked)" : "Edit";
      editBtn.addEventListener("click", () => populateChallengeForm(ch));
      actions.appendChild(editBtn);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ghost";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteChallenge(ch.id, ch.name));
      actions.appendChild(delBtn);
    }
    const lbBtn = document.createElement("button");
    lbBtn.type = "button";
    lbBtn.className = "ghost";
    lbBtn.textContent = "Leaderboard";
    lbBtn.addEventListener("click", () => loadChallengeAdminLeaderboard(ch.id, ch.name));
    actions.appendChild(lbBtn);
    row.appendChild(actions);
    challengesAdminTbodyEl.appendChild(row);
  }
}

function populateChallengeForm(ch) {
  if (challengeAdminIdEl) challengeAdminIdEl.value = ch.id;
  if (challengeAdminNameEl) challengeAdminNameEl.value = ch.name;
  if (challengeAdminLangEl) challengeAdminLangEl.value = ch.lang;
  if (challengeAdminWordLengthEl) challengeAdminWordLengthEl.value = ch.wordLength || "";
  if (challengeAdminPuzzleCountEl) challengeAdminPuzzleCountEl.value = ch.puzzleCount;
  if (challengeAdminTimeBudgetEl) challengeAdminTimeBudgetEl.value = ch.timeBudgetSeconds;
  if (challengeAdminMaxGuessesEl) challengeAdminMaxGuessesEl.value = ch.maxGuesses;
  if (challengeAdminPerPuzzleScoreEl) challengeAdminPerPuzzleScoreEl.value = ch.perPuzzleScore;
  if (challengeAdminSpeedBonusEl) challengeAdminSpeedBonusEl.value = ch.speedBonusFactor;
  if (challengeAdminReplayPolicyEl) challengeAdminReplayPolicyEl.value = ch.replayPolicy;
  if (challengeAdminStartTimeEl) challengeAdminStartTimeEl.value = ch.startTime ? toLocalDateTime(ch.startTime) : "";
  if (challengeAdminEndTimeEl) challengeAdminEndTimeEl.value = ch.endTime ? toLocalDateTime(ch.endTime) : "";
  setChallengeAdminStatus(`Editing "${ch.name}".`);
}

function clearChallengeForm() {
  if (challengeAdminFormEl) challengeAdminFormEl.reset();
  if (challengeAdminIdEl) challengeAdminIdEl.value = "";
  if (challengeAdminLangEl) challengeAdminLangEl.value = "en";
  if (challengeAdminWordLengthEl) challengeAdminWordLengthEl.value = "5";
  if (challengeAdminPuzzleCountEl) challengeAdminPuzzleCountEl.value = "5";
  if (challengeAdminTimeBudgetEl) challengeAdminTimeBudgetEl.value = "300";
  if (challengeAdminMaxGuessesEl) challengeAdminMaxGuessesEl.value = "6";
  if (challengeAdminPerPuzzleScoreEl) challengeAdminPerPuzzleScoreEl.value = "1000";
  if (challengeAdminSpeedBonusEl) challengeAdminSpeedBonusEl.value = "0.5";
  if (challengeAdminReplayPolicyEl) challengeAdminReplayPolicyEl.value = "best";
  setChallengeAdminStatus("");
}

function toLocalDateTime(iso) {
  // Convert ISO to the value format expected by <input type="datetime-local">.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

if (challengeAdminClearBtnEl) challengeAdminClearBtnEl.addEventListener("click", clearChallengeForm);

if (challengeAdminFormEl) {
  challengeAdminFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state?.unlocked) return;
    const id = challengeAdminIdEl?.value || null;
    const body = {
      name: challengeAdminNameEl?.value?.trim() || "",
      lang: challengeAdminLangEl?.value?.trim() || "en",
      puzzleCount: Number(challengeAdminPuzzleCountEl?.value || 0),
      timeBudgetSeconds: Number(challengeAdminTimeBudgetEl?.value || 0),
      maxGuesses: Number(challengeAdminMaxGuessesEl?.value || 0),
      perPuzzleScore: Number(challengeAdminPerPuzzleScoreEl?.value || 0),
      speedBonusFactor: Number(challengeAdminSpeedBonusEl?.value || 0),
      replayPolicy: challengeAdminReplayPolicyEl?.value || "best"
    };
    const wlen = Number(challengeAdminWordLengthEl?.value || 0);
    if (Number.isInteger(wlen) && wlen > 0) body.wordLength = wlen;
    if (challengeAdminStartTimeEl?.value) {
      body.startTime = new Date(challengeAdminStartTimeEl.value).toISOString();
    }
    if (challengeAdminEndTimeEl?.value) {
      body.endTime = new Date(challengeAdminEndTimeEl.value).toISOString();
    }
    try {
      if (id) {
        await requestAdminJson(`/api/admin/challenges/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        setChallengeAdminStatus("Saved.", "admin-status-ok");
      } else {
        await requestAdminJson("/api/admin/challenges", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        setChallengeAdminStatus("Created.", "admin-status-ok");
      }
      clearChallengeForm();
      loadChallengesAdmin().catch(() => {});
    } catch (err) {
      setChallengeAdminStatus(`Save failed: ${err.message}`, "admin-status-missing");
    }
  });
}

async function deleteChallenge(id, name) {
  if (!state?.unlocked) return;
  if (!window.confirm(`Soft-delete "${name}"? Historical leaderboard rows are preserved.`)) return;
  try {
    await requestAdminJson(`/api/admin/challenges/${encodeURIComponent(id)}`, { method: "DELETE" });
    setChallengeAdminStatus("Deleted.", "admin-status-ok");
    loadChallengesAdmin().catch(() => {});
  } catch (err) {
    setChallengeAdminStatus(`Delete failed: ${err.message}`, "admin-status-missing");
  }
}

async function loadChallengeAdminLeaderboard(id, name) {
  if (!state?.unlocked || !challengeAdminLeaderboardSectionEl || !challengesAdminLbTbodyEl) return;
  challengeAdminLeaderboardSectionEl.hidden = false;
  if (challengeAdminLeaderboardNameEl) challengeAdminLeaderboardNameEl.textContent = name;
  challengesAdminLbTbodyEl.innerHTML = "";
  try {
    const payload = await requestAdminJson(`/api/admin/challenges/${encodeURIComponent(id)}/leaderboard`);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "No completed sessions yet.";
      tr.appendChild(td);
      challengesAdminLbTbodyEl.appendChild(tr);
      return;
    }
    let rank = 1;
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.appendChild(buildCell(`#${rank}`));
      tr.appendChild(buildCell(r.profileName || r.profileId));
      tr.appendChild(buildCell(String(r.score)));
      tr.appendChild(buildCell(`${r.solvedCount}/${r.totalPuzzles}`));
      tr.appendChild(buildCell(`${r.elapsedSeconds}s`));
      tr.appendChild(buildCell(r.finishedAt ? formatTimestamp(r.finishedAt) : "—"));
      challengesAdminLbTbodyEl.appendChild(tr);
      rank += 1;
    }
  } catch (err) {
    setChallengeAdminStatus(`Leaderboard load failed: ${err.message}`, "admin-status-missing");
  }
}

if (challengeAdminLbCloseBtnEl) {
  challengeAdminLbCloseBtnEl.addEventListener("click", () => {
    if (challengeAdminLeaderboardSectionEl) challengeAdminLeaderboardSectionEl.hidden = true;
  });
}

// Auto-load the Challenges tab when the operator clicks its nav button.
// The existing tab-switch dispatcher in this file uses a click-based
// model, so we hook in here without patching it.
const challengesAdminNavBtn = document.getElementById("admin-tab-challenges");
if (challengesAdminNavBtn) {
  challengesAdminNavBtn.addEventListener("click", () => {
    if (state?.unlocked && !state?.challengesAdminLoading) {
      loadChallengesAdmin().catch(() => {});
    }
  });
}

// ── Admin i18n bootstrap + language switcher ──────────────────────────
// Same shape as the player shell. `window.i18nReady` is exposed for
// any future admin code that needs to await the first message load
// before rendering runtime-generated copy.
window.i18nReady = (async function bootstrapAdminI18n() {
  if (typeof window === "undefined" || !window.i18n) return;
  try {
    await window.i18n.init();
  } catch (_err) { /* fail open */ }
})();

(async function wireAdminLanguageSwitcher() {
  if (typeof window === "undefined" || !window.i18n) return;
  await window.i18nReady;
  const langSelect = document.getElementById("adminUiLangSelect");
  if (!langSelect) return;
  langSelect.value = window.i18n.getCurrentLocale();
  langSelect.addEventListener("change", async () => {
    const next = String(langSelect.value || "en");
    try {
      await window.i18n.loadLocale(next);
      // updateDOM() runs inside loadLocale() now; static markup with
      // data-i18n is already retranslated. Dynamic admin tables
      // (provider rows, profile lists, etc.) build their cells with
      // hardcoded English textContent that doesn't carry data-i18n,
      // so we re-fire the active tab's loader to redraw those cells.
      // Each loader is idempotent — calling it after a locale switch
      // just rebuilds the table from the cached snapshot. Soft-allow
      // any loader the active tab doesn't have (e.g. before unlock).
      const reloaders = [
        ["providers", typeof loadProviders === "function" ? loadProviders : null],
        ["profiles", typeof loadProfiles === "function" ? loadProfiles : null],
        ["classes", typeof loadClasses === "function" ? loadClasses : null],
        ["analytics", typeof loadAnalytics === "function" ? loadAnalytics : null],
        ["schedule", typeof loadSchedule === "function" ? loadSchedule : null],
        ["webhooks", typeof loadWebhooks === "function" ? loadWebhooks : null],
        ["notifications", typeof loadNotifications === "function" ? loadNotifications : null],
        ["challenges", typeof loadChallengesAdmin === "function" ? loadChallengesAdmin : null]
      ];
      for (const [tab, fn] of reloaders) {
        if (state?.unlocked && state?.activeTab === tab && fn) {
          fn({ announce: false }).catch(() => {});
        }
      }
    } catch (_err) {
      langSelect.value = window.i18n.getCurrentLocale();
    }
  });
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
